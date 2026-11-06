import type { PayloadRange, StackTrace } from '../domain/stack-model.ts';
import { stackProtocolBody } from '../domain/stack-model.ts';
import { stackObject, stackProtocolAt, stackTarget } from '../domain/stack-record.ts';
import type { SavedStackRun } from '../domain/workspace-v2-model.ts';
import { inspectMessageByteLayout } from './message-structure.ts';
import { projectStackRecord } from './stack-replay.ts';

export const JOURNEY_POLICY = {
  slots: 4096,
  spans: 32768,
  work: 200000,
  comparedBytes: 4194304,
  pageSize: 20,
  byteWindow: 256,
} as const;
export type StackJourneyQuery = {
  readonly rootId?: string;
  readonly rootPage?: number;
  readonly page?: number;
  readonly offset?: number;
  readonly length?: number;
  readonly bytePage?: number;
  readonly fieldPage?: number;
};
type Span = { start: number; local: number; length: number };
type Chunk = { range: PayloadRange; local: number };
type Slot = {
  name: string;
  copyName: string;
  length: number;
  chunks: Chunk[];
  spans: Span[];
  known: boolean;
};
type EventSlots = { event: StackTrace; cursor: number; slots: Slot[] };
type Origin = PayloadRange & { sourceEventId: string; valueOffset?: number };
class JourneyLimit extends Error {}
const pageAt = (page: number | undefined, pages: number) =>
  Number.isSafeInteger(page) ? Math.max(0, Math.min(page ?? 0, pages - 1)) : 0;
const rangeOf = (value: unknown): PayloadRange | undefined => {
  const row = stackObject(value);
  return typeof row.payloadId === 'string' &&
    Number.isSafeInteger(row.offset) &&
    Number.isSafeInteger(row.length) &&
    Number(row.offset) >= 0 &&
    Number(row.length) >= 0
    ? (row as unknown as PayloadRange)
    : undefined;
};
const within = (a: PayloadRange, b: PayloadRange) =>
  a.payloadId === b.payloadId && a.offset >= b.offset && a.offset + a.length <= b.offset + b.length;
const title = (event: StackTrace) => {
  const data = stackObject(event.data);
  const message = stackObject(data.message);
  const packet = stackObject(stackObject(data.payload ?? data.wire).packet);
  const kind: Partial<Record<StackTrace['kind'], string>> = {
    send: '송신',
    receive: '실제 수신',
    parsed: '프레임 해석',
    deliver: '응용 전달',
    'service-request': '서비스 요청',
    'service-accepted': '로컬 수락',
    'service-received': '포트 수신',
    'service-indication': '상위 통지',
    environment: '환경 결정',
    transition: '규칙 반영',
    timer: '타이머',
  };
  return `${kind[event.kind] ?? event.kind} ${String(message.messageId ?? packet.messageId ?? data.operation ?? '')} ${String(data.outcome ?? '')}`
    .trim()
    .slice(0, 140);
};
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const sextets = new Int16Array(128);
for (let i = 0; i < alphabet.length; i++) sextets[alphabet.charCodeAt(i)] = i;
function byteAt(data: string, index: number) {
  const group = Math.floor(index / 3) * 4;
  const part = index % 3;
  const a = sextets[data.charCodeAt(group + part)] ?? 0;
  const b = sextets[data.charCodeAt(group + part + 1)] ?? 0;
  return part === 0
    ? ((a << 2) | (b >> 4)) & 255
    : part === 1
      ? ((a << 4) | (b >> 2)) & 255
      : ((a << 6) | b) & 255;
}
function merged(spans: Span[]) {
  const result: Span[] = [];
  for (const span of spans.sort((a, b) => a.local - b.local || a.start - b.start)) {
    const last = result.at(-1);
    if (
      last &&
      last.start - last.local === span.start - span.local &&
      span.local <= last.local + last.length
    )
      last.length = Math.max(last.length, span.local + span.length - last.local);
    else result.push({ ...span });
  }
  return result;
}
function covered(spans: readonly Span[]) {
  const ranges = spans
    .map((s) => [s.start, s.start + s.length] as const)
    .sort((a, b) => a[0] - b[0]);
  let end = -1;
  let count = 0;
  for (const [start, next] of ranges) {
    count += Math.max(0, next - Math.max(start, end));
    end = Math.max(end, next);
  }
  return count;
}

/** Follow recorded typed byte origins inside one frozen prefix; content identity alone never creates an edge. */
export function buildStackMessageJourney(
  record: SavedStackRun,
  cursor: number,
  query: StackJourneyQuery = {},
  selectedId?: string,
) {
  const projected = projectStackRecord(record, cursor);
  if (!projected.success)
    return {
      status: 'unavailable' as const,
      note: projected.diagnostics[0]?.message ?? '기록을 읽을 수 없습니다.',
    };
  const view = projected.value;
  const protocols = new Map(
    (['A', 'B'] as const).flatMap((participant) =>
      view.snapshot.configuration.nodes[participant].instances.map((instance) => {
        const endpoint = { participant, instanceId: instance.id };
        return [stackTarget(endpoint), stackProtocolAt(view.snapshot, endpoint)] as const;
      }),
    ),
  );
  const application = (event: StackTrace) =>
    stackProtocolBody(
      protocols.get(stackTarget(event.endpoint)) ?? stackProtocolAt(view.snapshot, event.endpoint),
    ).layer === 'application';
  const candidates = view.events.flatMap((event, index) =>
    event.kind === 'send' && application(event)
      ? [
          {
            id: event.eventId,
            cursor: index + 1,
            target: stackTarget(event.endpoint),
            label: title(event),
          },
        ]
      : [],
  );
  const rootPages = Math.max(1, Math.ceil(candidates.length / 20));
  const rootPage = pageAt(query.rootPage, rootPages);
  const rootId =
    query.rootId ?? candidates.find((r) => r.id === selectedId)?.id ?? candidates[0]?.id;
  const root = view.events.find((e) => e.eventId === rootId && e.kind === 'send' && application(e));
  const roots = {
    rows: candidates.slice(rootPage * 20, rootPage * 20 + 20),
    page: rootPage,
    pages: rootPages,
    total: candidates.length,
  };
  const wire = stackObject(stackObject(root?.data).wire);
  const rootRange = wire.kind === 'bytes' ? rangeOf(wire.range) : undefined;
  if (!root || !rootRange)
    return {
      status: 'unavailable' as const,
      roots,
      note: root
        ? '이 응용 송신에 실제 byte 프레임이 없습니다. 논리 패킷을 byte로 재생성하지 않습니다.'
        : '현재 기록 위치에 있는 응용 송신을 선택하세요.',
    };
  const rootCursor = view.events.indexOf(root) + 1;
  const frameRange: PayloadRange = rootRange;
  const offset = query.offset ?? 0;
  const length = query.length ?? rootRange.length - offset;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > rootRange.length
  )
    return {
      status: 'unavailable' as const,
      roots,
      note: '원본 프레임 안의 정수 byte 범위를 선택하세요.',
    };
  const artifacts = new Map(view.artifacts.payloads.map((p) => [p.payloadId, p.bytes]));
  const notes = new Set<string>();
  let work = JOURNEY_POLICY.work as number;
  let remainingSlots = JOURNEY_POLICY.slots as number;
  let remainingSpans = JOURNEY_POLICY.spans as number;
  let remainingBytes = JOURNEY_POLICY.comparedBytes as number;
  const slots = new Map<string, EventSlots>();
  const events = new Map(view.events.map((e) => [e.eventId, e]));
  const equalRanges = new Set<string>();
  function spend(count = 1) {
    work -= count;
    if (work < 0) throw new JourneyLimit('출처 대응 작업 한도');
  }
  function allowed(event: StackTrace, range: PayloadRange) {
    spend(event.payloads.length);
    return event.payloads.some((r) => within(range, r));
  }
  function slot(event: StackTrace, name: string, chunks: Chunk[], size?: number): Slot | undefined {
    if (--remainingSlots < 0) throw new JourneyLimit('byte slot 한도');
    if (chunks.some((c) => !allowed(event, c.range))) {
      notes.add('관찰 범위 밖의 byte 대응을 제외했습니다.');
      return;
    }
    return {
      name,
      copyName: name,
      chunks,
      length: size ?? chunks.reduce((n, c) => Math.max(n, c.local + c.range.length), 0),
      spans: [],
      known: false,
    };
  }
  function verify(node: Slot, span: Span) {
    for (const chunk of node.chunks) {
      spend();
      const lo = Math.max(span.local, chunk.local);
      const hi = Math.min(span.local + span.length, chunk.local + chunk.range.length);
      if (lo >= hi) continue;
      const rootOffset = frameRange.offset + span.start + lo - span.local;
      const targetOffset = chunk.range.offset + lo - chunk.local;
      if (frameRange.payloadId === chunk.range.payloadId && rootOffset === targetOffset) continue;
      const key = JSON.stringify([rootOffset, chunk.range.payloadId, targetOffset, hi - lo]);
      if (equalRanges.has(key)) continue;
      remainingBytes -= hi - lo;
      if (remainingBytes < 0) throw new JourneyLimit('실제 byte 대조 한도');
      const source = artifacts.get(frameRange.payloadId);
      const target = artifacts.get(chunk.range.payloadId);
      if (
        !source ||
        !target ||
        rootOffset + hi - lo > source.byteLength ||
        targetOffset + hi - lo > target.byteLength
      )
        return false;
      for (let i = 0; i < hi - lo; i++)
        if (byteAt(source.data, rootOffset + i) !== byteAt(target.data, targetOffset + i))
          return false;
      equalRanges.add(key);
    }
    return true;
  }
  function connect(
    event: StackTrace,
    node: Slot,
    origin: Origin,
    destination: number,
    preferred?: string,
  ) {
    spend();
    if (
      !Number.isSafeInteger(destination) ||
      destination < 0 ||
      destination + origin.length > node.length
    ) {
      notes.add('출처의 목적지 byte 위치가 맞지 않아 제외했습니다.');
      return;
    }
    const previous = slots.get(origin.sourceEventId);
    if (!previous) return;
    if (
      !event.sourceEventIds.includes(origin.sourceEventId) ||
      previous.event.sequence >= event.sequence
    ) {
      notes.add('직접 출처가 아닌 byte 대응을 제외했습니다.');
      return;
    }
    const choices: Span[][] = [];
    for (const source of previous.slots) {
      if (preferred && source.copyName !== preferred) continue;
      for (const chunk of source.chunks) {
        spend();
        if (!within(origin, chunk.range)) continue;
        const local = chunk.local + origin.offset - chunk.range.offset;
        choices.push(
          source.spans.flatMap((s) => {
            spend();
            const lo = Math.max(local, s.local);
            const hi = Math.min(local + origin.length, s.local + s.length);
            return hi > lo
              ? [
                  {
                    start: s.start + lo - s.local,
                    local: destination + lo - local,
                    length: hi - lo,
                  },
                ]
              : [];
          }),
        );
      }
    }
    if (!choices.length) return;
    const canonical = choices.map((rows) => JSON.stringify(merged(rows)));
    if (new Set(canonical).size > 1) {
      notes.add('같은 출처 범위에 여러 위치가 있어 모호한 대응을 제외했습니다.');
      return;
    }
    node.known = true;
    for (const span of choices[0] ?? []) {
      if (--remainingSpans < 0) throw new JourneyLimit('byte span 한도');
      if (!verify(node, span)) {
        notes.add('기록된 출처와 실제 byte가 달라 대응을 제외했습니다.');
        continue;
      }
      node.spans.push(span);
    }
  }
  function origins(event: StackTrace, node: Slot, rows: unknown) {
    if (!Array.isArray(rows)) return;
    for (const value of rows) {
      spend();
      const range = rangeOf(value);
      const item = stackObject(value);
      if (range && typeof item.sourceEventId === 'string')
        connect(
          event,
          node,
          { ...range, sourceEventId: item.sourceEventId },
          Number(item.valueOffset ?? 0),
        );
    }
  }
  function copySource(event: StackTrace, sourceId: string): boolean {
    const source = events.get(sourceId);
    if (!source) return false;
    const same = stackTarget(source.endpoint) === stackTarget(event.endpoint);
    if (event.kind === 'service-request') return source.kind === 'send' && same;
    if (event.kind === 'service-accepted') return source.kind === 'service-request' && same;
    if (event.kind === 'parsed') return source.kind === 'receive' && same;
    if (event.kind === 'receive')
      return (
        (source.kind === 'send' &&
          ((stackTarget(source.endpoint) === stackTarget(view.snapshot.configuration.link.A) &&
            stackTarget(event.endpoint) === stackTarget(view.snapshot.configuration.link.B)) ||
            (stackTarget(source.endpoint) === stackTarget(view.snapshot.configuration.link.B) &&
              stackTarget(event.endpoint) === stackTarget(view.snapshot.configuration.link.A)))) ||
        (source.kind === 'service-received' && same)
      );
    if (event.kind === 'service-received') {
      const target = stackObject(stackObject(source.data).target);
      return (
        (source.kind === 'service-accepted' || source.kind === 'service-indication') &&
        target.participant === event.endpoint.participant &&
        target.instanceId === event.endpoint.instanceId
      );
    }
    return false;
  }
  function typedFields(event: StackTrace, values: unknown) {
    const result: Slot[] = [];
    const protocol = protocols.get(stackTarget(event.endpoint));
    const data = stackObject(event.data);
    const payload = stackObject(data.wire ?? data.payload);
    const messageId = stackObject(data.message).messageId ?? stackObject(payload.packet).messageId;
    const bytesFields = new Map(
      (protocol
        ? (stackProtocolBody(protocol).messages.find((m) => m.id === messageId)?.fields ?? [])
        : []
      )
        .filter((f) => f.type === 'bytes')
        .map((f) => [f.id, f]),
    );
    for (const [name, value] of Object.entries(stackObject(values))) {
      spend();
      if (!bytesFields.has(name) || stackObject(value).kind !== 'payload-range') continue;
      const range = rangeOf(value);
      const node = range && slot(event, `field:${name}`, [{ range, local: 0 }]);
      if (node) {
        node.copyName = `packet:${bytesFields.get(name)?.name ?? name}`;
        result.push(node);
      }
    }
    return result;
  }
  function wireSlots(event: StackTrace, value: unknown) {
    const payload = stackObject(value);
    const range = payload.kind === 'bytes' ? rangeOf(payload.range) : undefined;
    if (range) {
      const node = slot(event, 'bytes', [{ range, local: 0 }]);
      return node ? [node] : [];
    }
    if (payload.kind !== 'packet') return [];
    const packet = stackObject(payload.packet);
    const protocol = protocols.get(stackTarget(event.endpoint));
    const definition =
      protocol && stackProtocolBody(protocol).messages.find((m) => m.id === packet.messageId);
    // Packet names are wire names; parsed/send message values use stable field IDs.
    return typedFields(
      event,
      Object.fromEntries(
        Object.entries(stackObject(packet.fields)).map(([name, value]) => [
          definition?.fields.find((f) => f.name === name)?.id ?? name,
          value,
        ]),
      ),
    );
  }
  try {
    for (let index = rootCursor - 1; index < view.events.length; index++) {
      spend();
      const event = view.events[index];
      if (!event) continue;
      const data = stackObject(event.data);
      let nodes: Slot[] = [];
      if (event.kind === 'transition') {
        const variables = stackObject(stackObject(data.after).variables);
        const protocol = protocols.get(stackTarget(event.endpoint));
        for (const variable of protocol ? stackProtocolBody(protocol).variables : []) {
          spend();
          if (variable.type !== 'bytes') continue;
          const range = rangeOf(variables[variable.id]);
          const node = range && slot(event, `variable:${variable.id}`, [{ range, local: 0 }]);
          if (node) {
            origins(event, node, stackObject(data.byteSources)[variable.id]);
            nodes.push(node);
          }
        }
      } else if (event.kind === 'parsed') {
        nodes = typedFields(event, stackObject(data.message).values);
        const rows = Array.isArray(data.sourceRanges) ? data.sourceRanges : [];
        if (rows.length) {
          let local = 0;
          const chunks: Chunk[] = [];
          for (const row of rows) {
            spend();
            const range = rangeOf(row);
            if (range) {
              chunks.push({ range, local });
              local += range.length;
            }
          }
          const frame = slot(event, 'frame', chunks);
          if (frame) {
            for (const [i, row] of rows.entries()) {
              const range = rangeOf(row);
              const sourceEventId = stackObject(row).sourceEventId;
              if (range && typeof sourceEventId === 'string')
                connect(event, frame, { ...range, sourceEventId }, chunks[i]?.local ?? 0, 'bytes');
            }
            nodes.push(frame);
          }
        } else {
          const source = event.sourceEventIds[0];
          if (source && copySource(event, source))
            for (const node of nodes)
              for (const chunk of node.chunks)
                connect(
                  event,
                  node,
                  { ...chunk.range, sourceEventId: source },
                  chunk.local,
                  node.copyName,
                );
        }
      } else if (event.kind === 'service-accepted') {
        const previous = slots.get(event.sourceEventIds[0] ?? '');
        for (const before of previous && copySource(event, previous.event.eventId)
          ? previous.slots
          : []) {
          const node = slot(
            event,
            before.name,
            before.chunks.map((c) => ({ ...c })),
            before.length,
          );
          if (node && previous) {
            node.copyName = before.copyName;
            for (const chunk of node.chunks)
              connect(
                event,
                node,
                { ...chunk.range, sourceEventId: previous.event.eventId },
                chunk.local,
                node.copyName,
              );
            nodes.push(node);
          }
        }
      } else {
        nodes = wireSlots(event, data.wire ?? data.payload);
        if (event.kind === 'send' && event !== root) {
          // A newly encoded application response starts its own journey.
          if (!application(event))
            for (const node of nodes)
              origins(event, node, stackObject(data.fieldSources)[node.name.slice(6)]);
        } else if (event.kind === 'service-indication') {
          for (const node of nodes) origins(event, node, data.sourceRanges);
        } else if (['service-request', 'service-received', 'receive'].includes(event.kind)) {
          for (const sourceId of event.sourceEventIds)
            if (copySource(event, sourceId))
              for (const node of nodes)
                for (const chunk of node.chunks)
                  connect(
                    event,
                    node,
                    { ...chunk.range, sourceEventId: sourceId },
                    chunk.local,
                    node.copyName,
                  );
        }
      }
      if (event === root) {
        const node = nodes.find((n) => n.name === 'bytes');
        if (node) {
          node.known = true;
          if (length) node.spans = [{ start: offset, local: offset, length }];
        }
      }
      for (const node of nodes) node.spans = merged(node.spans);
      if (
        ['send', 'service-indication', 'receive', 'service-received', 'parsed'].includes(
          event.kind,
        ) &&
        !(event.kind === 'send' && application(event)) &&
        nodes.some((n) => n.length > 0 && !n.known) &&
        !nodes.some((n) => n.spans.length) &&
        event.sourceEventIds.some((id) => slots.get(id)?.slots.some((n) => n.spans.length))
      )
        notes.add('직접 원인이 있어도 byte 출처 대응이 없는 출력은 연결하지 않았습니다.');
      slots.set(event.eventId, { event, cursor: index + 1, slots: nodes });
    }
  } catch (error) {
    if (!(error instanceof JourneyLimit)) throw error;
    notes.add(`${error.message}에 도달했습니다. 뒤의 대응은 계산하지 않았습니다.`);
  }
  const related = new Map<string, 'bytes' | 'control' | 'message'>();
  related.set(root.eventId, 'bytes');
  for (const item of slots.values())
    if (item.slots.some((n) => n.spans.length)) related.set(item.event.eventId, 'bytes');
  // Control-only branches begin at a related transport parse; stop at the feedback parse.
  const control = new Set<string>();
  for (const event of view.events) {
    const source = events.get(event.sourceEventIds[0] ?? '');
    if (!source) continue;
    if (event.kind === 'environment' && related.has(source.eventId))
      related.set(event.eventId, 'control');
    if (source.kind === 'parsed' && related.get(source.eventId) === 'bytes') {
      if (event.kind === 'deliver' && application(event)) related.set(event.eventId, 'message');
      else if (
        event.kind === 'send' &&
        !application(event) &&
        !slots.get(event.eventId)?.slots.length
      ) {
        related.set(event.eventId, 'control');
        control.add(event.eventId);
      }
    }
    if (
      control.has(source.eventId) &&
      ['service-request', 'service-accepted', 'environment', 'receive', 'parsed'].includes(
        event.kind,
      ) &&
      !slots.get(event.eventId)?.slots.length
    ) {
      related.set(event.eventId, 'control');
      if (event.kind !== 'parsed') control.add(event.eventId);
    }
  }
  const reads = new Map<string, number>();
  for (const event of view.events)
    if (
      event.kind === 'service-indication' &&
      stackObject(event.data).operation === 'read' &&
      related.has(event.eventId)
    ) {
      const id = event.sourceEventIds[0] ?? '';
      reads.set(id, (reads.get(id) ?? 0) + 1);
    }
  const priorSends = new Set<string>();
  const allRows = view.events.flatMap((event, index) => {
    const relation = related.get(event.eventId);
    if (!relation || event.kind === 'transition') return [];
    const nodes = slots.get(event.eventId)?.slots ?? [];
    const spans = nodes.flatMap((n) => n.spans.map((s) => ({ ...s, slot: n.name })));
    const rootPositions = merged(spans.map((s) => ({ ...s, local: s.start })));
    const signature = JSON.stringify([stackTarget(event.endpoint), rootPositions]);
    const source = events.get(event.sourceEventIds[0] ?? '');
    const repeated =
      event.kind === 'send' &&
      spans.length > 0 &&
      source?.kind === 'timer' &&
      stackObject(source.data).operation === 'expire' &&
      priorSends.has(signature);
    if (event.kind === 'send' && spans.length) priorSends.add(signature);
    return [
      {
        id: event.eventId,
        cursor: index + 1,
        target: stackTarget(event.endpoint),
        kind: event.kind,
        timeMs: event.timeMs,
        title: title(event),
        relation,
        flags: [
          ...(repeated ? ['선택 바이트 재송신 · 타이머'] : []),
          ...(stackObject(stackObject(event.data).context).copy === 'duplicate'
            ? ['환경 복제본 실제 수신']
            : []),
          ...(event.kind === 'parsed' && !application(event) && spans.length
            ? [`직접 상위 read 관찰 ${reads.get(event.eventId) ?? 0}회`]
            : []),
        ],
        mappedBytes: covered(spans),
        spans: spans.slice(0, 4).map((s) => ({ ...s, slot: s.slot.slice(0, 80) })),
        totalSpans: spans.length,
      },
    ];
  });
  const pages = Math.max(1, Math.ceil(allRows.length / 20));
  const page = pageAt(query.page, pages);
  const protocol = protocols.get(stackTarget(root.endpoint));
  const message = stackObject(stackObject(root.data).message);
  const rootBytes = artifacts.get(rootRange.payloadId);
  const fields: { id: string; name: string; start: number; end: number }[] = [];
  let layoutNote = '필드 위치 분석이 없는 프레임입니다. 실제 byte 범위를 선택하세요.';
  if (protocol?.mode === 'legacy-application' && rootRange.length <= 65536 && rootBytes) {
    const definition = protocol.source.messages.find((m) => m.id === message.messageId);
    if (definition) {
      const bytes = Array.from({ length: rootRange.length }, (_, i) =>
        byteAt(rootBytes.data, rootRange.offset + i),
      );
      const layout = inspectMessageByteLayout(
        protocol.source.codec,
        definition,
        stackObject(
          message.values,
        ) as import('../domain/protocol-model.ts').ProtocolMessage['values'],
        bytes,
      );
      layoutNote = `실제 송신 layout: ${layout.status}`;
      for (const field of definition.fields) {
        const range = layout.ranges.get(field.id);
        if (range)
          fields.push({
            id: field.id,
            name: field.name.slice(0, 80),
            start: range.start,
            end: range.end,
          });
      }
    }
  } else if (rootRange.length > 65536)
    layoutNote = '64 KiB 필드 분석 한도입니다. 원본 bytes의 구간 선택은 가능합니다.';
  const bytePages = Math.max(1, Math.ceil(rootRange.length / 256));
  const fieldPages = Math.max(1, Math.ceil(fields.length / 20));
  const fieldPage = pageAt(query.fieldPage, fieldPages);
  const bytePage = pageAt(query.bytePage, bytePages);
  const byteStart = bytePage * 256;
  const cells = Array.from({ length: Math.min(256, rootRange.length - byteStart) }, (_, i) => {
    const at = byteStart + i;
    const byte = rootBytes ? byteAt(rootBytes.data, rootRange.offset + at) : 0;
    return {
      offset: at,
      hex: byte.toString(16).padStart(2, '0'),
      ascii: byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.',
    };
  });
  const sender = root.endpoint.participant;
  const receiver = sender === 'A' ? 'B' : 'A';
  const configuration = view.snapshot.configuration;
  const binding = configuration.bindings.find(
    (b) => stackTarget(b.consumer) === stackTarget(root.endpoint),
  );
  const peer = sender === 'A' ? configuration.link.B : configuration.link.A;
  const upper = configuration.bindings.find((b) => stackTarget(b.provider) === stackTarget(peer));
  const targets = [
    stackTarget(root.endpoint),
    binding ? stackTarget(binding.provider) : '',
    stackTarget(peer),
    upper ? stackTarget(upper.consumer) : `${receiver}/?`,
  ];
  const stageNames = ['응용 송신', '송신 전송', '수신 전송', '상대 응용'];
  const stages = targets.map((target, index) => ({
    target,
    label: stageNames[index] ?? '',
    bytes: covered(
      [...slots.values()]
        .filter((r) => stackTarget(r.event.endpoint) === target && r.event.kind !== 'transition')
        .flatMap((r) => r.slots.flatMap((n) => n.spans)),
    ),
  }));
  const result = {
    status: notes.size ? ('limited' as const) : ('available' as const),
    note: '기록된 출처와 대조한 byte 대응입니다. 제어 후속은 별도 표시하며 상위 read 미관찰은 중복 제거 성공의 증명이 아닙니다.',
    roots,
    root: {
      id: root.eventId,
      cursor: rootCursor,
      target: stackTarget(root.endpoint),
      title: title(root),
      byteLength: rootRange.length,
    },
    selection: { offset, length },
    fields: fields.slice(fieldPage * 20, fieldPage * 20 + 20),
    fieldPage,
    fieldPages,
    totalFields: fields.length,
    layoutNote,
    stages,
    page,
    pages,
    total: allRows.length,
    rows: allRows.slice(page * 20, page * 20 + 20),
    bytePage,
    bytePages,
    cells,
    notes: [...notes].slice(0, 8),
    prefix: cursor <= record.view.events.length,
    partial: view.status !== 'completed',
    frames: allRows.filter((r) => r.kind === 'parsed' && r.target === targets[3]).length,
    deliveries: allRows.filter((r) => r.kind === 'deliver').length,
  };
  if (JSON.stringify(result).length >= 32768)
    return {
      status: 'unavailable' as const,
      note: '이동 경로 표시 자료가 32768자 한도입니다. 원본 기록과 bytes는 보존했습니다.',
    };
  return result;
}
export type StackMessageJourney = ReturnType<typeof buildStackMessageJourney>;
