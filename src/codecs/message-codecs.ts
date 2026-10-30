import { EXECUTION_POLICY } from '../domain/execution-contract.ts';
import {
  parseJsonData,
  parseProtocolDefinition,
  validateProtocolMessage,
} from '../domain/model-validation.ts';
import type {
  ModelDiagnostic,
  ProtocolDefinition,
  ProtocolMessage,
  Scalar,
  ValidationResult,
} from '../domain/protocol-model.ts';

export type LogicalPacket = {
  readonly messageId: string;
  readonly fields: Readonly<Record<string, Scalar>>;
};
export type DecodeBatch = {
  readonly messages: readonly ProtocolMessage[];
  readonly diagnostics: readonly ModelDiagnostic[];
  readonly closed: boolean;
};
export type CodecLimits = { readonly maxMessageBytes?: number; readonly maxBufferBytes?: number };
export type JsonLinesCodec = {
  readonly encode: (message: unknown) => ValidationResult<Uint8Array>;
  readonly push: (chunk: Uint8Array) => DecodeBatch;
  readonly finish: () => DecodeBatch;
  readonly abort: () => void;
};
export type DatagramCodec = {
  readonly encode: (message: unknown) => ValidationResult<Uint8Array>;
  readonly decode: (bytes: Uint8Array) => ValidationResult<ProtocolMessage>;
};
export type LogicalPacketCodec = {
  readonly encode: (message: unknown) => ValidationResult<LogicalPacket>;
  readonly decode: (packet: unknown) => ValidationResult<ProtocolMessage>;
};
const encoder = new TextEncoder();

function failure<Value>(code: string, message: string, path = '/'): ValidationResult<Value> {
  return { success: false, diagnostics: [{ path, code, message }] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function wireMessage(
  protocol: ProtocolDefinition,
  value: unknown,
): ValidationResult<LogicalPacket> {
  const parsed = validateProtocolMessage(protocol, value);
  if (!parsed.success) return parsed;
  const definition = protocol.messages.find((message) => message.id === parsed.value.messageId);
  if (!definition) return failure('message-reference', 'Unknown message ID', '/messageId');
  const fields = Object.fromEntries(
    definition.fields.flatMap((field) => {
      const value = parsed.value.values[field.id];
      return value === undefined ? [] : [[field.name, value]];
    }),
  );
  return {
    success: true,
    value: Object.freeze({ messageId: definition.id, fields: Object.freeze(fields) }),
  };
}

function readWireMessage(
  protocol: ProtocolDefinition,
  value: unknown,
): ValidationResult<ProtocolMessage> {
  const json = parseJsonData(value);
  if (!json.success) return json;
  if (!isObject(value)) return failure('wire-object', 'Expected a message envelope');
  const unexpected = Object.keys(value).find((key) => key !== 'messageId' && key !== 'fields');
  if (unexpected)
    return failure('unknown-property', 'Unsupported envelope property', `/${unexpected}`);
  if (typeof value.messageId !== 'string')
    return failure('message-reference', 'Expected a message ID', '/messageId');
  const definition = protocol.messages.find((message) => message.id === value.messageId);
  if (!definition) return failure('message-reference', 'Unknown message ID', '/messageId');
  if (!isObject(value.fields)) return failure('wire-fields', 'Expected wire fields', '/fields');
  const values: [string, unknown][] = [];
  for (const [name, fieldValue] of Object.entries(value.fields)) {
    const field = definition.fields.find((field) => field.name === name);
    if (!field)
      return failure(
        'unknown-field',
        'Unknown wire field',
        `/fields/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`,
      );
    values.push([field.id, fieldValue]);
  }
  return validateProtocolMessage(protocol, {
    messageId: definition.id,
    values: Object.fromEntries(values),
  });
}

function parseBytes(
  protocol: ProtocolDefinition,
  bytes: Uint8Array,
): ValidationResult<ProtocolMessage> {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return failure('invalid-utf8', 'Message contains invalid UTF-8');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return failure('invalid-json', 'Message is not valid JSON');
  }
  return readWireMessage(protocol, value);
}

function configuration(
  value: unknown,
  codec: ProtocolDefinition['codec'],
  limits: CodecLimits,
): ValidationResult<{
  readonly protocol: ProtocolDefinition;
  readonly messageBytes: number;
  readonly bufferBytes: number;
}> {
  const parsed = parseProtocolDefinition(value);
  if (!parsed.success) return parsed;
  if (parsed.value.codec !== codec)
    return failure('codec-mismatch', `Expected ${codec} protocol`, '/codec');
  const messageBytes = limits.maxMessageBytes ?? EXECUTION_POLICY.maxMessageBytes;
  const bufferBytes = limits.maxBufferBytes ?? EXECUTION_POLICY.maxBufferBytes;
  if (
    !Number.isSafeInteger(messageBytes) ||
    messageBytes < 1 ||
    messageBytes > EXECUTION_POLICY.maxMessageBytes ||
    !Number.isSafeInteger(bufferBytes) ||
    bufferBytes < 1 ||
    bufferBytes > EXECUTION_POLICY.maxBufferBytes
  ) {
    return failure(
      'codec-limits',
      'Codec byte limits must be positive integers within execution limits',
    );
  }
  // Capture schema as well as data so later editor changes cannot alter an active codec.
  return {
    success: true,
    value: { protocol: structuredClone(parsed.value), messageBytes, bufferBytes },
  };
}

function encodeBytes(
  protocol: ProtocolDefinition,
  value: unknown,
  limit: number,
  newline: boolean,
): ValidationResult<Uint8Array> {
  const wire = wireMessage(protocol, value);
  if (!wire.success) return wire;
  const bytes = encoder.encode(JSON.stringify(wire.value) + (newline ? '\n' : ''));
  return bytes.byteLength <= limit
    ? { success: true, value: bytes }
    : failure('message-limit', 'Encoded message exceeds its byte limit');
}

/** Create a bounded JSON Lines codec; each push can yield zero, one or many messages. */
export function createJsonLinesCodec(
  value: unknown,
  limits: CodecLimits = {},
): ValidationResult<JsonLinesCodec> {
  const checked = configuration(value, 'json-lines', limits);
  if (!checked.success) return checked;
  const { protocol, messageBytes, bufferBytes } = checked.value;
  let pending = new Uint8Array(Math.min(1024, messageBytes, bufferBytes));
  let buffered = 0;
  let frame = 0;
  let ended = false;
  let terminalDiagnostics: readonly ModelDiagnostic[] = [];
  function stop(diagnostics: readonly ModelDiagnostic[]): void {
    terminalDiagnostics = diagnostics;
    ended = true;
    pending = new Uint8Array(0);
    buffered = 0;
  }
  function push(chunk: Uint8Array): DecodeBatch {
    if (ended)
      return {
        messages: [],
        diagnostics: [{ path: '/', code: 'codec-closed', message: 'Decoder is already closed' }],
        closed: true,
      };
    const messages: ProtocolMessage[] = [];
    let start = 0;
    for (let end = 0; end < chunk.length; end++) {
      const size = buffered + end - start + 1;
      if (size > messageBytes || size > bufferBytes) {
        stop([
          {
            path: `/frames/${frame}`,
            code: size > messageBytes ? 'message-limit' : 'buffer-limit',
            message: 'Incomplete or complete frame exceeds byte limit',
          },
        ]);
        break;
      }
      if (chunk[end] !== 10 && end !== chunk.length - 1) continue;
      if (size > pending.length) {
        const grown = new Uint8Array(
          Math.min(Math.max(size, pending.length * 2), messageBytes, bufferBytes),
        );
        grown.set(pending.subarray(0, buffered));
        pending = grown;
      }
      pending.set(chunk.subarray(start, end + 1), buffered);
      buffered = size;
      start = end + 1;
      if (chunk[end] !== 10) continue;
      const parsed = parseBytes(protocol, pending.subarray(0, buffered - 1));
      if (!parsed.success) {
        stop(
          parsed.diagnostics.map((item) => ({
            ...item,
            path: `/frames/${frame}${item.path === '/' ? '' : item.path}`,
          })),
        );
        break;
      }
      messages.push(parsed.value);
      buffered = 0;
      frame++;
    }
    return { messages, diagnostics: terminalDiagnostics, closed: ended };
  }
  function finish(): DecodeBatch {
    if (!ended && buffered)
      stop([
        {
          path: `/frames/${frame}`,
          code: 'incomplete-frame',
          message: 'EOF before the required LF delimiter',
        },
      ]);
    ended = true;
    pending = new Uint8Array(0);
    return { messages: [], diagnostics: terminalDiagnostics, closed: true };
  }
  return {
    success: true,
    value: {
      encode: (message) => encodeBytes(protocol, message, messageBytes, true),
      push,
      finish,
      abort: () => stop([]),
    },
  };
}

/** Encode or decode exactly one complete JSON message per datagram; never join packets. */
export function createJsonDatagramCodec(
  value: unknown,
  limits: CodecLimits = {},
): ValidationResult<DatagramCodec> {
  const checked = configuration(value, 'json-datagram', limits);
  if (!checked.success) return checked;
  const { protocol, messageBytes } = checked.value;
  return {
    success: true,
    value: {
      encode: (message) => encodeBytes(protocol, message, messageBytes, false),
      decode: (bytes) =>
        bytes.byteLength > messageBytes
          ? failure('message-limit', 'Datagram exceeds byte limit')
          : parseBytes(protocol, bytes),
    },
  };
}

/** Validate and clone a logical packet without claiming it is a binary TCP/IP encoding. */
export function createLogicalPacketCodec(
  value: unknown,
  limits: CodecLimits = {},
): ValidationResult<LogicalPacketCodec> {
  const checked = configuration(value, 'logical-packet', limits);
  if (!checked.success) return checked;
  const { protocol, messageBytes } = checked.value;
  return {
    success: true,
    value: {
      encode: (message) => {
        const wire = wireMessage(protocol, message);
        if (!wire.success) return wire;
        return encoder.encode(JSON.stringify(wire.value)).length > messageBytes
          ? failure('message-limit', 'Logical JSON packet exceeds byte limit')
          : wire;
      },
      decode: (packet) => {
        try {
          const message = readWireMessage(protocol, packet);
          if (!message.success) return message;
          return encoder.encode(JSON.stringify(packet)).length > messageBytes
            ? failure('message-limit', 'Logical JSON packet exceeds byte limit')
            : message;
        } catch {
          return failure('wire-object', 'Packet must contain plain JSON data');
        }
      },
    },
  };
}
