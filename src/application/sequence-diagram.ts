import type { JsonObject, JsonValue } from '../domain/execution-contract.ts';
import type { EngineView, EventTrace, ProtocolMessage } from '../domain/protocol-model.ts';

export const SEQUENCE_PAGE_SIZE = 30;
export type SequenceRow = {
  readonly event: EventTrace;
  readonly label: string;
  readonly note: string;
  readonly shape: 'send' | 'receive' | 'blocked' | 'local';
  readonly communication: boolean;
  readonly sources: readonly string[];
};
export type SequenceModel = {
  readonly rows: readonly SequenceRow[];
  readonly byId: ReadonlyMap<string, SequenceRow>;
  readonly effects: ReadonlyMap<string, readonly string[]>;
};
const labels: Record<EventTrace['kind'], string> = {
  input: '입력',
  send: '송신',
  receive: '하위 수신',
  parsed: '메시지 해석',
  deliver: '상위 전달',
  timer: '타이머',
  connection: '연결',
  transition: '상태 전이',
  environment: '통신 환경',
  diagnostic: '진단',
};

/** Read trace objects without copying potentially large wire arrays. */
export function traceObject(value: JsonValue | undefined): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

/** Read an engine-validated message; values stay shared with the immutable trace. */
export function traceMessage(event: EventTrace): ProtocolMessage | undefined {
  const message = traceObject(traceObject(event.data).message);
  if (typeof message.messageId !== 'string' || !message.values) return undefined;
  return message as unknown as ProtocolMessage;
}

function short(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value.slice(0, 100) : String(value ?? '');
}
function sameMessage(left: ProtocolMessage, right: ProtocolMessage): boolean {
  const keys = Object.keys(left.values);
  return (
    left.messageId === right.messageId &&
    keys.length === Object.keys(right.values).length &&
    keys.every((key) => left.values[key] === right.values[key])
  );
}

/** Project only observed events, distinguishing scheduling, byte receipt, decoding and delivery. */
export function buildSequenceModel(
  run: Pick<EngineView, 'events'>,
  eventCount = run.events.length,
): SequenceModel {
  const events = run.events.slice(
    0,
    Math.max(0, Math.min(run.events.length, Math.floor(eventCount))),
  );
  const ids = new Set(events.map((event) => event.eventId));
  const effects = new Map<string, string[]>();
  const received = new Set<string>();
  const failedTimers = new Set<string>();
  const sourcesById = new Map<string, string[]>();
  for (const event of events) {
    const data = traceObject(event.data);
    const sources = new Set<string>();
    if (event.causeEventId && ids.has(event.causeEventId)) sources.add(event.causeEventId);
    if (Array.isArray(data.sourceEventIds))
      for (const id of data.sourceEventIds)
        if (typeof id === 'string' && ids.has(id)) sources.add(id);
    const list = [...sources];
    sourcesById.set(event.eventId, list);
    for (const id of list) {
      const children = effects.get(id) ?? [];
      children.push(event.eventId);
      effects.set(id, children);
      if (event.kind === 'receive') received.add(id);
    }
    if (event.kind === 'transition' && data.outcome === 'failure' && event.causeEventId)
      failedTimers.add(event.causeEventId);
  }
  const byEvent = new Map(events.map((event) => [event.eventId, event]));
  const lastSends = new Map<string, ProtocolMessage>();
  const rows: SequenceRow[] = events.map((event) => {
    const data = traceObject(event.data);
    const message = traceMessage(event);
    let label: string = labels[event.kind];
    let note = '';
    let shape: SequenceRow['shape'] = 'local';
    let communication = event.kind !== 'transition';
    if (message) label += ` ${short(message.messageId)}`;
    if (event.kind === 'send') {
      shape = 'send';
      note = received.has(event.eventId) ? '하위 수신 관찰됨' : '수신 미관찰';
      if (message) {
        const key = `${event.participant}:${message.messageId}`;
        const previous = lastSends.get(key);
        if (previous && sameMessage(previous, message)) {
          const cause = byEvent.get(event.causeEventId ?? '');
          const expiry = cause?.kind === 'timer' && traceObject(cause.data).operation === 'expire';
          note += expiry ? ' · 재전송 후보' : ' · 동일 값 반복 송신';
        }
        lastSends.set(key, message);
      }
    } else if (event.kind === 'receive') {
      shape = 'receive';
      const wire = traceObject(data.wire);
      label = wire.kind === 'bytes' ? '바이트 청크 수신' : '패킷 수신';
      if (Array.isArray(wire.bytes)) label += ` · ${wire.bytes.length} bytes`;
      else label += ` ${short(traceObject(wire.packet).messageId)}`;
      note =
        data.copy === 'duplicate'
          ? '중복 복사본 도착'
          : data.copy === 'original'
            ? '원본 도착'
            : '하위 서비스 수신';
    } else if (event.kind === 'timer') {
      label = `${data.operation === 'expire' ? (failedTimers.has(event.eventId) ? '타임아웃 실패' : '타이머 만료') : data.operation === 'cancel' ? '타이머 취소' : '타이머 시작'} · ${short(data.timerId)}`;
    } else if (event.kind === 'environment') {
      if (data.operation === 'stream-cutoff') {
        label = data.state === 'failed' ? '스트림 연결 실패로 차단' : '스트림 연결 종료로 차단';
        shape = 'blocked';
      } else if (data.outcome === 'drop-targeted' || data.outcome === 'drop-random') {
        label = data.outcome === 'drop-targeted' ? '데이터그램 지정 손실' : '데이터그램 확률 손실';
        shape = 'blocked';
      } else if (data.outcome === 'duplicate') {
        label = '데이터그램 중복 예정';
        note = '실제 도착은 수신 행에 표시';
      } else {
        label = '데이터그램 전달 예정';
        communication = false;
      }
      note ||= `전송 #${short(data.transmission)} · ${short(data.direction)}`;
    } else if (event.kind === 'connection') label += ` · ${short(data.state)}`;
    else if (event.kind === 'diagnostic') label += ` · ${short(data.code)}`;
    else if (event.kind === 'transition') label += ` · ${short(traceObject(data.after).stateId)}`;
    return {
      event,
      label,
      note,
      shape,
      communication,
      sources: sourcesById.get(event.eventId) ?? [],
    };
  });
  return { rows, byId: new Map(rows.map((row) => [row.event.eventId, row])), effects };
}

/** Resolve frozen actor definitions for labels and stable-field to wire-name mapping. */
export function sequenceProtocol(run: EngineView, participant: 'A' | 'B') {
  const ref = run.snapshot.configuration.protocols[participant];
  return run.snapshot.configuration.definitions.find(
    (item) => item.id === ref.id && item.revision === ref.revision,
  );
}
