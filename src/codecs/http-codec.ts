import { EXECUTION_POLICY } from '../domain/execution-contract.ts';
import { httpHeaderFields, isHttpToken } from '../domain/http-schema.ts';
import { parseProtocolDefinition, validateProtocolMessage } from '../domain/model-validation.ts';
import type {
  MessageDefinition,
  ModelDiagnostic,
  ProtocolDefinition,
  ProtocolMessage,
  Scalar,
  ValidationResult,
} from '../domain/protocol-model.ts';
import type { CodecLimits, DecodeBatch, JsonLinesCodec } from './message-codecs.ts';

const encoder = new TextEncoder();
const forbidden = new Set(['content-encoding', 'connection', 'upgrade', 'trailer', 'te', 'expect']);
function failure<T>(code: string, message: string): ValidationResult<T> {
  return { success: false, diagnostics: [{ path: '/', code, message }] };
}
function printable(value: string): boolean {
  return /^[\x20-\x7e\t]*$/.test(value);
}
function originTarget(value: string): boolean {
  return (
    /^\/[\x21-\x7e]*$/.test(value) && !value.includes('#') && !/%(?![0-9A-Fa-f]{2})/.test(value)
  );
}
function validHost(value: string): boolean {
  if (!value || /[\s/?#@\\]/.test(value)) return false;
  try {
    const url = new URL(`http://${value}`);
    return (
      !!url.hostname &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
function statusAllowed(status: number, length: number): boolean {
  return (
    Number.isInteger(status) &&
    status >= 200 &&
    status <= 599 &&
    ![204, 304].includes(status) &&
    (status !== 205 || length === 0)
  );
}

function utf8(value: string, maximum: number): ValidationResult<Uint8Array> {
  if (value.length > maximum) return failure('message-limit', 'HTTP text exceeds its byte limit');
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        return failure('http-body-utf8', 'Unpaired UTF-16 surrogates cannot be preserved as UTF-8');
    } else if (unit >= 0xdc00 && unit <= 0xdfff)
      return failure('http-body-utf8', 'Unpaired UTF-16 surrogates cannot be preserved as UTF-8');
  }
  const bytes = encoder.encode(value);
  return bytes.length <= maximum
    ? { success: true, value: bytes }
    : failure('message-limit', 'HTTP text exceeds its byte limit');
}

type Header = {
  message: MessageDefinition;
  values: Readonly<Record<string, Scalar>>;
  bodyLength: number;
  headerBytes: number;
};
function readHeaders(protocol: ProtocolDefinition, bytes: Uint8Array): ValidationResult<Header> {
  if (bytes.some((byte) => byte > 126 || (byte < 32 && ![9, 10, 13].includes(byte))))
    return failure('http-header-ascii', 'This codec supports ASCII start lines and headers');
  const lines = new TextDecoder().decode(bytes).slice(0, -4).split('\r\n');
  const start = lines.shift() ?? '';
  const response = start.startsWith('HTTP/');
  const message = protocol.messages.find(
    (item) => item.http?.kind === (response ? 'response' : 'request'),
  );
  if (!message?.http || message.http.kind === 'raw')
    return failure('http-schema', 'Missing HTTP message mapping');
  const values: [string, Scalar][] = [];
  let status = 0;
  if (message.http.kind === 'request') {
    const match = /^([A-Z]+) ([^ ]+) HTTP\/(\d\.\d)$/.exec(start);
    if (!match) return failure('http-start-line', 'Expected METHOD origin-form HTTP/1.1');
    if (match[3] !== '1.1') return failure('http-version', 'Only HTTP/1.1 is supported');
    if (!['GET', 'POST'].includes(match[1] ?? ''))
      return failure('http-method', 'Only GET and POST are supported');
    if (!originTarget(match[2] ?? ''))
      return failure(
        'http-target',
        'Only ASCII origin-form targets without fragments are supported',
      );
    values.push(
      [message.http.methodFieldId, match[1] ?? ''],
      [message.http.targetFieldId, match[2] ?? ''],
    );
  } else {
    const match = /^HTTP\/(\d\.\d) ([0-9]{3}) ([\x20-\x7e]*)$/.exec(start);
    if (!match) return failure('http-start-line', 'Expected HTTP/1.1 status reason');
    if (match[1] !== '1.1') return failure('http-version', 'Only HTTP/1.1 is supported');
    status = Number(match[2]);
    values.push([message.http.statusFieldId, status], [message.http.reasonFieldId, match[3] ?? '']);
  }
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(':');
    const name = line.slice(0, colon);
    const raw = line.slice(colon + 1);
    if (colon < 1 || !isHttpToken(name) || !printable(raw))
      return failure(
        'http-header',
        'Invalid field-name, whitespace before colon, folding or control character',
      );
    const key = name.toLowerCase();
    if (headers.has(key))
      return failure(
        'http-duplicate-header',
        'Duplicate headers, including repeated Content-Length, are unsupported',
      );
    headers.set(key, raw.replace(/^[ \t]+|[ \t]+$/g, ''));
  }
  if (headers.has('transfer-encoding'))
    return failure(
      headers.has('content-length') ? 'http-length-conflict' : 'http-transfer-encoding',
      'Transfer-Encoding is not supported; never combine it with Content-Length',
    );
  const length = headers.get('content-length');
  if (length === undefined || !/^[0-9]+$/.test(length) || !Number.isSafeInteger(Number(length)))
    return failure(
      'http-content-length',
      'An explicit nonnegative safe decimal Content-Length is required',
    );
  const bodyLength = Number(length);
  if (response && !statusAllowed(status, bodyLength))
    return failure(
      'http-status',
      'Unsupported response status or forbidden response body in this subset',
    );
  if (!response && !validHost(headers.get('host') ?? ''))
    return failure('http-host', 'A single valid Host authority is required');
  const declared = new Map(
    httpHeaderFields(message).map((field) => [field.name.toLowerCase(), field]),
  );
  for (const [name, value] of headers) {
    if (name === 'content-length') continue;
    if (forbidden.has(name))
      return failure('http-unsupported-header', `Unsupported HTTP mechanism: ${name}`);
    const field = declared.get(name);
    if (!field)
      return failure('http-unsupported-header', `Declare header ${name} before receiving it`);
    let scalar: Scalar = value;
    if (field.type === 'integer') {
      if (!/^-?[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)))
        return failure('http-header-value', `Invalid integer header ${name}`);
      scalar = Number(value);
    } else if (field.type === 'boolean') {
      if (!['true', 'false'].includes(value))
        return failure('http-header-value', `Invalid boolean header ${name}`);
      scalar = value === 'true';
    }
    values.push([field.id, scalar]);
  }
  return {
    success: true,
    value: { message, values: Object.fromEntries(values), bodyLength, headerBytes: bytes.length },
  };
}

function encodeMessage(
  protocol: ProtocolDefinition,
  input: unknown,
  maximum: number,
): ValidationResult<Uint8Array> {
  const parsed = validateProtocolMessage(protocol, input);
  if (!parsed.success) return parsed;
  const message = protocol.messages.find((item) => item.id === parsed.value.messageId);
  const mapping = message?.http;
  if (!message || !mapping) return failure('http-schema', 'Missing HTTP mapping');
  const values = parsed.value.values;
  let bytes: Uint8Array;
  if (mapping.kind === 'raw') {
    const raw = utf8(String(values[mapping.wireFieldId] ?? ''), maximum);
    if (!raw.success) return raw;
    bytes = raw.value;
  } else {
    const encodedBody = utf8(String(values[mapping.bodyFieldId] ?? ''), maximum);
    if (!encodedBody.success) return encodedBody;
    const body = encodedBody.value;
    let start: string;
    if (mapping.kind === 'request') {
      const method = String(values[mapping.methodFieldId]);
      const target = String(values[mapping.targetFieldId]);
      if (!['GET', 'POST'].includes(method) || !originTarget(target) || !printable(target))
        return failure(
          'http-start-line',
          'Only GET/POST with ASCII origin-form targets are supported',
        );
      start = `${method} ${target} HTTP/1.1`;
    } else {
      const status = Number(values[mapping.statusFieldId]);
      const reason = String(values[mapping.reasonFieldId]);
      if (!statusAllowed(status, body.length) || !/^[\x20-\x7e]*$/.test(reason))
        return failure('http-status', 'Unsupported response status, reason or body');
      start = `HTTP/1.1 ${status} ${reason}`;
    }
    const lines = [start];
    let headerCharacters = start.length + 2;
    if (headerCharacters > 65_536)
      return failure('http-header-limit', 'Headers exceed the 64 KiB codec limit');
    for (const field of httpHeaderFields(message)) {
      const value = values[field.id];
      if (value === undefined) continue;
      const text = String(value);
      headerCharacters += field.name.length + text.length + 4;
      if (headerCharacters > 65_536)
        return failure('http-header-limit', 'Headers exceed the 64 KiB codec limit');
      if (!printable(text))
        return failure(
          'http-header',
          `Header ${field.name} contains an unsupported control or non-ASCII character`,
        );
      if (field.name.toLowerCase() === 'host' && !validHost(text))
        return failure('http-host', 'Invalid Host authority');
      lines.push(`${field.name}: ${text}`);
    }
    lines.push(`Content-Length: ${body.length}`, '', '');
    const header = encoder.encode(lines.join('\r\n'));
    if (header.length > 65_536)
      return failure('http-header-limit', 'Headers exceed the 64 KiB codec limit');
    bytes = new Uint8Array(header.length + body.length);
    bytes.set(header);
    bytes.set(body, header.length);
  }
  return bytes.length <= maximum
    ? { success: true, value: bytes }
    : failure('message-limit', 'Encoded HTTP message exceeds its byte limit');
}

/** Create a bounded HTTP/1.1 GET/POST codec with declared headers and byte-counted UTF-8 bodies. */
export function createHttpCodec(
  input: unknown,
  limits: CodecLimits = {},
): ValidationResult<JsonLinesCodec> {
  const checked = parseProtocolDefinition(input);
  if (!checked.success) return checked;
  if (checked.value.codec !== 'http-1.1')
    return failure('codec-mismatch', 'Expected http-1.1 protocol');
  const protocol = structuredClone(checked.value);
  const maximum = limits.maxMessageBytes ?? EXECUTION_POLICY.maxMessageBytes;
  const bufferMaximum = limits.maxBufferBytes ?? EXECUTION_POLICY.maxBufferBytes;
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > EXECUTION_POLICY.maxMessageBytes ||
    !Number.isSafeInteger(bufferMaximum) ||
    bufferMaximum < 1 ||
    bufferMaximum > EXECUTION_POLICY.maxBufferBytes
  )
    return failure('codec-limits', 'Invalid HTTP byte limits');
  let pending = new Uint8Array(Math.min(1024, maximum, bufferMaximum));
  let buffered = 0;
  let header: Header | undefined;
  let ended = false;
  let frame = 0;
  let diagnostics: readonly ModelDiagnostic[] = [];
  function stop(errors: readonly ModelDiagnostic[]) {
    diagnostics = errors;
    ended = true;
    pending = new Uint8Array(0);
    buffered = 0;
    header = undefined;
  }
  function error(code: string, message: string) {
    stop([{ path: `/frames/${frame}`, code, message }]);
  }
  function ensure(size: number): boolean {
    if (size > maximum) {
      error('message-limit', 'HTTP message exceeds its byte limit');
      return false;
    }
    if (size > bufferMaximum) {
      error('buffer-limit', 'HTTP frame exceeds the receive buffer limit');
      return false;
    }
    if (size > pending.length) {
      const grown = new Uint8Array(
        Math.min(maximum, bufferMaximum, Math.max(size, pending.length * 2)),
      );
      grown.set(pending.subarray(0, buffered));
      pending = grown;
    }
    return true;
  }
  function complete(messages: ProtocolMessage[]) {
    if (!header || header.message.http?.kind === 'raw' || !header.message.http) return;
    let body: string;
    try {
      body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        pending.subarray(header.headerBytes, buffered),
      );
    } catch {
      error('http-body-utf8', 'The declared body is not complete valid UTF-8');
      return;
    }
    const values = Object.fromEntries([
      ...Object.entries(header.values),
      [header.message.http.bodyFieldId, body],
    ]);
    const parsed = validateProtocolMessage(protocol, { messageId: header.message.id, values });
    if (!parsed.success) {
      stop(parsed.diagnostics);
      return;
    }
    messages.push(parsed.value);
    buffered = 0;
    header = undefined;
    frame++;
  }
  function push(chunk: Uint8Array): DecodeBatch {
    if (ended)
      return {
        messages: [],
        diagnostics: [{ path: '/', code: 'codec-closed', message: 'Decoder is already closed' }],
        closed: true,
      };
    const messages: ProtocolMessage[] = [];
    let offset = 0;
    while (offset < chunk.length && !ended) {
      if (header) {
        const total = header.headerBytes + header.bodyLength;
        const count = Math.min(total - buffered, chunk.length - offset);
        if (!ensure(buffered + count)) break;
        pending.set(chunk.subarray(offset, offset + count), buffered);
        buffered += count;
        offset += count;
        if (buffered === total) complete(messages);
      } else {
        if (!ensure(buffered + 1)) break;
        pending[buffered++] = chunk[offset++] ?? 0;
        if (buffered > 65_536) {
          error('http-header-limit', 'Headers exceed the 64 KiB codec limit');
          break;
        }
        if (
          buffered >= 4 &&
          pending[buffered - 4] === 13 &&
          pending[buffered - 3] === 10 &&
          pending[buffered - 2] === 13 &&
          pending[buffered - 1] === 10
        ) {
          const parsed = readHeaders(protocol, pending.subarray(0, buffered));
          if (!parsed.success) {
            stop(parsed.diagnostics.map((item) => ({ ...item, path: `/frames/${frame}` })));
            break;
          }
          header = parsed.value;
          if (!ensure(header.headerBytes + header.bodyLength)) break;
          if (header.bodyLength === 0) complete(messages);
        }
      }
    }
    return { messages, diagnostics, closed: ended };
  }
  function finish(): DecodeBatch {
    if (!ended && buffered)
      error(
        header ? 'http-incomplete-body' : 'http-incomplete-headers',
        header
          ? `EOF after ${buffered - header.headerBytes} of ${header.bodyLength} body bytes`
          : 'EOF before CRLF header termination',
      );
    ended = true;
    pending = new Uint8Array(0);
    header = undefined;
    return { messages: [], diagnostics, closed: true };
  }
  return {
    success: true,
    value: {
      encode: (message) => encodeMessage(protocol, message, maximum),
      push,
      finish,
      abort: () => stop([]),
    },
  };
}
