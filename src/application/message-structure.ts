import { httpHeaderFields } from '../domain/http-schema.ts';
import type {
  EngineView,
  EventTrace,
  FieldDefinition,
  MessageDefinition,
  Scalar,
} from '../domain/protocol-model.ts';
import { snapshotCompatibility } from '../domain/workspace-validation.ts';
import { sequenceProtocol, traceMessage, traceObject } from './sequence-diagram.ts';

export const STRUCTURE_POLICY = {
  inspectedBytes: 32768,
  fields: 128,
  regions: 128,
  pageSize: 20,
  bytePageSize: 256,
} as const;
export type ByteRange = { readonly start: number; readonly end: number };
export type StructureField = {
  readonly definition: FieldDefinition;
  readonly value: Scalar | undefined;
  readonly location: string;
  readonly range: ByteRange | undefined;
};
export type StructureRegion = {
  readonly id: string;
  readonly label: string;
  readonly range: ByteRange;
};
export type MessageStructure = {
  readonly status: 'mapped' | 'logical' | 'chunk' | 'limited' | 'raw' | 'unavailable';
  readonly note: string;
  readonly codec: string;
  readonly event: EventTrace | undefined;
  readonly messageId: string;
  readonly bytes: readonly number[] | undefined;
  readonly fields: readonly StructureField[];
  readonly totalFields: number;
  readonly regions: readonly StructureRegion[];
  readonly declaredLength: number | undefined;
  readonly bodyBytes: number | undefined;
};
function range(start: number, end: number): ByteRange {
  return { start, end };
}
function region(id: string, label: string, start: number, end: number): StructureRegion {
  return { id, label, range: range(start, end) };
}
function location(message: MessageDefinition, field: FieldDefinition): string {
  const mapping = message.http;
  if (!mapping) return `${field.placement} (논리 배치)`;
  if (mapping.kind === 'raw') return '원시 HTTP';
  if (mapping.bodyFieldId === field.id) return '본문';
  return httpHeaderFields(message).some((item) => item.id === field.id) ? 'HTTP 헤더' : '시작 줄';
}

type Layout = Pick<
  MessageStructure,
  'status' | 'note' | 'regions' | 'declaredLength' | 'bodyBytes'
> & {
  readonly ranges: ReadonlyMap<string, ByteRange>;
};
function rawLayout(
  bytes: readonly number[],
  note: string,
  status: Layout['status'] = 'raw',
): Layout {
  return {
    status,
    note,
    regions: [region('raw', '원시 전송 데이터', 0, bytes.length)],
    ranges: new Map(),
    declaredLength: undefined,
    bodyBytes: undefined,
  };
}
function httpLayout(bytes: readonly number[], message: MessageDefinition): Layout {
  const maximum = Math.min(bytes.length, STRUCTURE_POLICY.inspectedBytes);
  let boundary = -1;
  for (let index = 0; index + 3 < maximum; index++)
    if (
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    ) {
      boundary = index + 4;
      break;
    }
  if (boundary < 0)
    return rawLayout(
      bytes,
      '분석 구간에 HTTP 헤더 종료가 없습니다. 미완성/큰 헤더의 구획을 추정하지 않습니다.',
      'limited',
    );
  const prefix = bytes.slice(0, boundary);
  if (prefix.some((byte) => byte > 127))
    return rawLayout(bytes, 'ASCII 헤더 경계를 확인할 수 없어 원시 바이트만 표시합니다.');
  const text = new TextDecoder().decode(Uint8Array.from(prefix));
  const lines = text.slice(0, -4).split('\r\n');
  const start = lines[0] ?? '';
  const mapping = message.http;
  const ranges = new Map<string, ByteRange>();
  const regions = [region('start', '시작 줄', 0, start.length + 2)];
  const firstSpace = start.indexOf(' ');
  const secondSpace = start.indexOf(' ', firstSpace + 1);
  if (mapping?.kind === 'request' && /^\S+ \S+ HTTP\/\S+$/.test(start)) {
    ranges.set(mapping.methodFieldId, range(0, firstSpace));
    ranges.set(mapping.targetFieldId, range(firstSpace + 1, secondSpace));
  } else if (mapping?.kind === 'response' && /^HTTP\/\S+ \d{3} [\x20-\x7e]*$/.test(start)) {
    ranges.set(mapping.statusFieldId, range(firstSpace + 1, secondSpace));
    ranges.set(mapping.reasonFieldId, range(secondSpace + 1, start.length));
  }
  const headers = new Map(
    httpHeaderFields(message).map((field) => [field.name.toLowerCase(), field.id]),
  );
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  let declaredLength: number | undefined;
  let cursor = start.length + 2;
  let limited = false;
  for (const [index, line] of lines.slice(1).entries()) {
    if (regions.length >= STRUCTURE_POLICY.regions - 2) {
      limited = true;
      break;
    }
    const colon = line.indexOf(':');
    const name = line.slice(0, colon).toLowerCase();
    regions.push(
      region(
        `header-${index}`,
        `헤더 · ${line.slice(0, Math.max(0, colon)).slice(0, 100) || '(형식 확인 불가)'}`,
        cursor,
        cursor + line.length + 2,
      ),
    );
    if (colon > 0) {
      if (seen.has(name)) duplicates.add(name);
      seen.add(name);
      const content = line.slice(colon + 1);
      const value = content.trim();
      if (name === 'content-length' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)))
        declaredLength = Number(value);
      const fieldId = headers.get(name);
      if (fieldId) {
        const leading = content.length - content.trimStart().length;
        ranges.set(
          fieldId,
          range(cursor + colon + 1 + leading, cursor + colon + 1 + leading + value.length),
        );
      }
    }
    cursor += line.length + 2;
  }
  for (const name of duplicates) {
    const id = headers.get(name);
    if (id) ranges.delete(id);
  }
  if (duplicates.has('content-length')) declaredLength = undefined;
  regions.push(
    region('separator', '헤더 종료 CRLF', boundary - 2, boundary),
    region('body', '본문', boundary, bytes.length),
  );
  if (mapping && mapping.kind !== 'raw')
    ranges.set(mapping.bodyFieldId, range(boundary, bytes.length));
  if (mapping?.kind === 'raw') ranges.set(mapping.wireFieldId, range(0, bytes.length));
  const bodyBytes = bytes.length - boundary;
  return {
    status: limited ? 'limited' : mapping?.kind === 'raw' ? 'raw' : 'mapped',
    note: `${limited ? '헤더 영역 수 상한에 도달했습니다. ' : ''}${mapping?.kind === 'raw' ? '원시 HTTP의 구획이며 코덱 유효성 판정이 아닙니다. ' : '관찰한 HTTP 송신 구획입니다. '}${duplicates.size ? '중복 헤더는 필드 범위를 하나로 선택하지 않습니다. ' : ''}${declaredLength !== undefined && declaredLength !== bodyBytes ? 'Content-Length와 전송한 본문 바이트 수가 다릅니다. ' : ''}본문은 현재 송신 끝까지의 범위이며 수신/해석 성공을 뜻하지 않습니다.`,
    regions,
    ranges,
    declaredLength,
    bodyBytes,
  };
}

type Token = { start: number; end: number; properties: Map<string, Token> | undefined };
function jsonLayout(
  bytes: readonly number[],
  message: MessageDefinition,
  values: Readonly<Record<string, Scalar>>,
  newline: boolean,
): Layout {
  if (bytes.length > STRUCTURE_POLICY.inspectedBytes)
    return rawLayout(
      bytes,
      '큰 JSON 메시지의 token 분석을 생략했습니다. 필드 값과 실제 바이트 페이지를 별도로 표시합니다.',
      'limited',
    );
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Uint8Array.from(bytes),
    );
    const wire = JSON.parse(text) as { messageId?: unknown; fields?: Record<string, unknown> };
    if (
      !wire ||
      wire.messageId !== message.id ||
      !wire.fields ||
      typeof wire.fields !== 'object' ||
      Array.isArray(wire.fields)
    )
      throw new Error('envelope');
    let cursor = 0;
    let operations = 0;
    function space() {
      while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++;
    }
    function string() {
      const start = cursor++;
      while (cursor < text.length) {
        if (text[cursor] === '\\') cursor += 2;
        else if (text[cursor++] === '"') return text.slice(start, cursor);
      }
      throw new Error('string');
    }
    function token(depth = 0): Token {
      if (++operations > 1024 || depth > 8) throw new Error('limit');
      space();
      const start = cursor;
      let properties: Map<string, Token> | undefined;
      if (text[cursor] === '{') {
        properties = new Map();
        cursor++;
        space();
        while (text[cursor] !== '}') {
          space();
          const key = JSON.parse(string()) as string;
          space();
          if (text[cursor++] !== ':' || properties.has(key)) throw new Error('duplicate');
          properties.set(key, token(depth + 1));
          space();
          if (text[cursor] !== ',') break;
          cursor++;
        }
        if (text[cursor++] !== '}') throw new Error('object');
      } else if (text[cursor] === '"') string();
      else {
        const scalar = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
          text.slice(cursor),
        )?.[0];
        if (!scalar) throw new Error('scalar');
        cursor += scalar.length;
      }
      return { start, end: cursor, properties };
    }
    const root = token();
    space();
    if (
      cursor !== text.length ||
      (newline && (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1))
    )
      throw new Error('frame');
    const fields = root.properties?.get('fields')?.properties;
    if (!fields) throw new Error('fields');
    const offsets: number[] = [];
    let offset = 0;
    for (let index = 0; index < text.length; ) {
      const code = text.codePointAt(index) ?? 0;
      offsets[index] = offset;
      if (code > 0xffff) offsets[index + 1] = offset;
      offset += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      index += code > 0xffff ? 2 : 1;
      offsets[index] = offset;
    }
    function actual(node: Token) {
      return range(offsets[node.start] ?? 0, offsets[node.end] ?? bytes.length);
    }
    const ranges = new Map<string, ByteRange>();
    const regions = [region('envelope', 'JSON envelope', 0, bytes.length - (newline ? 1 : 0))];
    const messageId = root.properties?.get('messageId');
    if (messageId) regions.push({ id: 'message-id', label: '메시지 ID', range: actual(messageId) });
    const byName = new Map(message.fields.map((field) => [field.name, field.id]));
    let mismatch = message.fields.some(
      (field) => values[field.id] !== undefined && !Object.hasOwn(wire.fields ?? {}, field.name),
    );
    for (const [name, node] of fields) {
      if (regions.length >= STRUCTURE_POLICY.regions - 1) break;
      const id = byName.get(name);
      if (id) {
        ranges.set(id, actual(node));
        mismatch ||= wire.fields[name] !== values[id];
      } else mismatch = true;
      regions.push({
        id: `json-${regions.length}`,
        label: `JSON 필드 · ${name.slice(0, 100)}`,
        range: actual(node),
      });
    }
    if (newline)
      regions.push(region('delimiter', '메시지 구분자 LF', bytes.length - 1, bytes.length));
    const limited = fields.size + 3 > STRUCTURE_POLICY.regions;
    return {
      status: limited ? 'limited' : mismatch ? 'raw' : 'mapped',
      note: `${mismatch ? '필드 기록과 전송 값이 다릅니다. ' : ''}${limited ? '처음 일부 token만 표시합니다. ' : ''}범위는 실제 JSON token(문자열 따옴표/escape 포함)입니다. header/body/payload는 논리 분류이며 wire는 fields object입니다.`,
      regions,
      ranges,
      declaredLength: undefined,
      bodyBytes: undefined,
    };
  } catch {
    return rawLayout(
      bytes,
      '완전한 단일 JSON frame의 범위를 확인할 수 없습니다. 원시 바이트를 보존합니다.',
    );
  }
}

/** Project a selected observed message without encoding a replacement or reading past the cursor. */
export function buildMessageStructure(
  run: EngineView,
  eventId: string | undefined,
  eventCount = run.events.length,
): MessageStructure {
  const count = Math.max(0, Math.min(run.events.length, Math.floor(eventCount)));
  const event = run.events.slice(0, count).find((item) => item.eventId === eventId);
  let result: MessageStructure = {
    status: 'unavailable',
    note: '메시지 송신·수신·해석·상위 전달 또는 입력 기록을 선택하세요.',
    codec: '',
    event,
    messageId: '',
    bytes: undefined,
    fields: [],
    totalFields: 0,
    regions: [],
    declaredLength: undefined,
    bodyBytes: undefined,
  };
  if (!event) return result;
  const wire = traceObject(traceObject(event.data).wire);
  const bytes =
    wire.kind === 'bytes' && Array.isArray(wire.bytes)
      ? (wire.bytes as readonly number[])
      : undefined;
  result = { ...result, bytes };
  if (snapshotCompatibility(run.snapshot))
    return { ...result, note: '지원하지 않는 실행 버전입니다. 저장한 원시 바이트만 표시합니다.' };
  const protocol = sequenceProtocol(run, event.participant);
  if (!protocol) return result;
  const packet = wire.kind === 'packet' ? traceObject(wire.packet) : undefined;
  const message = traceMessage(event);
  if (!message && !packet && !bytes) return result;
  const messageId =
    typeof packet?.messageId === 'string' ? packet.messageId : (message?.messageId ?? '');
  const definition = protocol.messages.find((item) => item.id === messageId);
  result = { ...result, codec: protocol.codec, messageId };
  if (bytes && event.kind === 'receive')
    return {
      ...result,
      status: 'chunk',
      regions: [region('chunk', '현재 수신 청크', 0, bytes.length)],
      note: '수신 청크는 완전한 메시지 경계가 아닙니다. 다른 청크나 원인 송신을 합쳐 필드 범위를 추정하지 않습니다. 해석된 필드는 parsed 기록에서 확인하세요.',
    };
  if (!definition)
    return {
      ...result,
      note: '실행 당시 정의에서 메시지를 찾을 수 없습니다. 원시 데이터만 표시합니다.',
    };
  const packetFields = packet ? traceObject(packet.fields) : undefined;
  const values = message?.values ?? {};
  const fields: StructureField[] = definition.fields
    .slice(0, STRUCTURE_POLICY.fields)
    .map((field) => {
      const value = packetFields ? packetFields[field.name] : values[field.id];
      return {
        definition: field,
        value:
          typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
            ? value
            : undefined,
        location: location(definition, field),
        range: undefined,
      };
    });
  result = {
    ...result,
    fields,
    totalFields: definition.fields.length,
    status: definition.fields.length > STRUCTURE_POLICY.fields ? 'limited' : 'logical',
    note: packet
      ? '관찰된 논리 패킷 필드입니다. 바이너리 TCP/IP encoding과 byte offset은 정의하지 않습니다. 수신 해석 성공을 뜻하지 않습니다.'
      : '이 이벤트는 메시지 값만 기록했습니다. 전송 바이트를 재생성하거나 다른 이벤트에서 가져오지 않습니다.',
  };
  if (!bytes) return result;
  if (event.kind !== 'send')
    return { ...result, status: 'raw', note: '이 이벤트의 원시 바이트만 표시합니다.' };
  const layout = inspectMessageByteLayout(protocol.codec, definition, values, bytes);
  const { ranges, ...presentation } = layout;
  return {
    ...result,
    ...presentation,
    status: definition.fields.length > STRUCTURE_POLICY.fields ? 'limited' : layout.status,
    note: `${layout.note}${definition.fields.length > STRUCTURE_POLICY.fields ? ' 최대 128개 필드만 표시합니다.' : ''}`,
    fields: fields.map((field) => ({ ...field, range: ranges.get(field.definition.id) })),
  };
}

/** Analyze only supplied actual message bytes, sharing the same bounded HTTP/JSON layout in both modes. */
export function inspectMessageByteLayout(
  codec: string,
  definition: import('../domain/protocol-model.ts').MessageDefinition,
  values: import('../domain/protocol-model.ts').ProtocolMessage['values'],
  bytes: readonly number[],
) {
  return codec === 'http-1.1'
    ? httpLayout(bytes, definition)
    : codec === 'json-lines' || codec === 'json-datagram'
      ? jsonLayout(bytes, definition, values, codec === 'json-lines')
      : rawLayout(bytes, '이 코덱의 byte 구획은 정의되어 있지 않습니다.');
}

/** Read one bounded hex/ASCII window by reference, retaining offsets in the actual event. */
export function structureBytePage(bytes: readonly number[], page: number) {
  const count = Math.max(1, Math.ceil(bytes.length / STRUCTURE_POLICY.bytePageSize));
  const current = Math.max(0, Math.min(count - 1, Number.isFinite(page) ? Math.floor(page) : 0));
  const start = current * STRUCTURE_POLICY.bytePageSize;
  return {
    page: current,
    pages: count,
    start,
    values: bytes.slice(start, start + STRUCTURE_POLICY.bytePageSize),
  };
}
