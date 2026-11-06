import { type StackEndpoint, type StackTrace, stackProtocolBody } from '../domain/stack-model.ts';
import {
  stackObject,
  stackProtocolAt,
  stackRangeBytes,
  stackTarget,
} from '../domain/stack-record.ts';
import type { SavedStackRun } from '../domain/workspace-v2-model.ts';
import { inspectMessageByteLayout, structureBytePage } from './message-structure.ts';
import { previewJson } from './preview-json.ts';
import { projectStackRecord } from './stack-replay.ts';
import { buildStateDiagram } from './state-diagram.ts';

export const STACK_OBSERVATION_POLICY = {
  pageSize: 20,
  sequenceRows: 30,
  causalEvents: 256,
  byteWindow: 256,
  analysisBytes: 65_536,
} as const;
function missingTarget(message: string) {
  return {
    success: false as const,
    diagnostics: [{ path: '/endpoint', code: 'stack-target', message }],
  };
}

/** Build an endpoint-specific state graph from its frozen definition and observed prefix. */
export function buildStackStateDiagram(
  record: SavedStackRun,
  endpoint: StackEndpoint,
  cursor: number,
  options: { statePage?: number; rulePage?: number } = {},
) {
  const projected = projectStackRecord(record, cursor);
  if (!projected.success) return projected;
  const view = projected.value;
  try {
    const protocol = stackProtocolAt(view.snapshot, endpoint);
    const instance = view.instances[stackTarget(endpoint)];
    const diagram = buildStateDiagram(stackProtocolBody(protocol), {
      ...options,
      currentStateIds: instance ? [instance.stateId] : [],
    });
    return { success: true as const, value: { endpoint, protocol, instance, diagram } };
  } catch (error) {
    return {
      success: false as const,
      diagnostics: [{ path: '/endpoint', code: 'stack-target', message: String(error) }],
    };
  }
}

/** Page actual service/wire/codec/commit events, keeping acceptance separate from delivery and app completion. */
export function buildStackSequence(
  record: SavedStackRun,
  cursor: number,
  options: { endpoint?: StackEndpoint; layer?: 'application' | 'transport'; page?: number } = {},
) {
  const projected = projectStackRecord(record, cursor);
  if (!projected.success) return projected;
  const view = projected.value;
  if (options.endpoint) {
    try {
      stackProtocolAt(view.snapshot, options.endpoint);
    } catch {
      return missingTarget('snapshot에 없는 인스턴스입니다.');
    }
  }
  const indexes = new Map(view.events.map((e, i) => [e.eventId, i + 1]));
  const events = view.events.filter(
    (event) =>
      (!options.endpoint || stackTarget(event.endpoint) === stackTarget(options.endpoint)) &&
      (!options.layer ||
        stackProtocolBody(stackProtocolAt(view.snapshot, event.endpoint)).layer === options.layer),
  );
  const pages = Math.max(1, Math.ceil(events.length / STACK_OBSERVATION_POLICY.sequenceRows));
  const page = Number.isSafeInteger(options.page)
    ? Math.max(0, Math.min(options.page ?? 0, pages - 1))
    : 0;
  return {
    success: true as const,
    value: {
      total: events.length,
      pages,
      page,
      rows: events.slice(page * 30, (page + 1) * 30).map((event) => ({
        event,
        cursor: indexes.get(event.eventId) ?? 0,
        endpoint: stackTarget(event.endpoint),
        kind: event.kind,
        title: `${stackTarget(event.endpoint)} · ${event.kind} · ${String(stackObject(event.data).operation ?? stackObject(stackObject(event.data).message).messageId ?? stackObject(event.data).ruleId ?? '')}`,
        causes: event.sourceEventIds
          .slice(0, 20)
          .map((id) => ({ id, cursor: indexes.get(id) ?? 0 })),
        totalCauses: event.sourceEventIds.length,
        limited: event.sourceEventIds.length > 20,
      })),
    },
  };
}

/** Link only observed direct causes and committed descendants, never equal rule IDs across instances. */
export function stackEventLinks(record: SavedStackRun, eventId: string, cursor: number) {
  const projected = projectStackRecord(record, cursor);
  if (!projected.success) return projected;
  const view = projected.value;
  const events = new Map(
    view.events.map((e, index) => [e.eventId, { event: e, cursor: index + 1 }]),
  );
  const selected = events.get(eventId);
  if (!selected)
    return {
      success: false as const,
      diagnostics: [
        { path: '/eventId', code: 'stack-prefix', message: '기록 위치에 없는 관찰입니다.' },
      ],
    };
  const children = new Map<string, StackTrace[]>();
  for (const event of view.events)
    for (const source of event.sourceEventIds) {
      const list = children.get(source) ?? [];
      list.push(event);
      children.set(source, list);
    }
  const queue = [eventId];
  const seen = new Set<string>();
  const commits: { event: StackTrace; cursor: number }[] = [];
  let truncated = false;
  while (queue.length && seen.size < STACK_OBSERVATION_POLICY.causalEvents) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    for (const child of children.get(id) ?? []) {
      if (child.kind === 'transition' && child.sourceEventIds[0] === id) {
        const linked = events.get(child.eventId);
        if (linked) commits.push(linked);
      }
      if (queue.length < STACK_OBSERVATION_POLICY.causalEvents) queue.push(child.eventId);
      else truncated = true;
    }
  }
  return {
    success: true as const,
    value: {
      selected,
      directCauses: selected.event.sourceEventIds
        .slice(0, 20)
        .flatMap((id) => events.get(id) ?? []),
      totalDirectCauses: selected.event.sourceEventIds.length,
      totalDirectChildren: children.get(eventId)?.length ?? 0,
      directChildren: (children.get(eventId) ?? [])
        .slice(0, 20)
        .flatMap((e) => events.get(e.eventId) ?? []),
      commits: commits.slice(0, 20),
      limited:
        truncated ||
        queue.length > 0 ||
        commits.length > 20 ||
        selected.event.sourceEventIds.length > 20 ||
        (children.get(eventId)?.length ?? 0) > 20,
    },
  };
}

/** Page exact rule occurrences for one endpoint, retaining each occurrence's actual cursor and direct trigger. */
export function stackRuleOccurrences(
  record: SavedStackRun,
  endpoint: StackEndpoint,
  ruleId: string,
  cursor: number,
  page = 0,
) {
  const projected = projectStackRecord(record, cursor);
  if (!projected.success) return projected;
  try {
    const protocol = stackProtocolAt(projected.value.snapshot, endpoint);
    if (!stackProtocolBody(protocol).rules.some((r) => r.id === ruleId))
      return missingTarget('snapshot에 없는 규칙입니다.');
  } catch {
    return missingTarget('snapshot에 없는 인스턴스입니다.');
  }
  const rows = projected.value.events.flatMap((event, index) =>
    event.kind === 'transition' &&
    stackTarget(event.endpoint) === stackTarget(endpoint) &&
    stackObject(event.data).ruleId === ruleId
      ? [{ event, cursor: index + 1, triggerId: event.sourceEventIds[0] }]
      : [],
  );
  const pages = Math.max(1, Math.ceil(rows.length / 20));
  const selected = Number.isSafeInteger(page) ? Math.max(0, Math.min(page, pages - 1)) : 0;
  return {
    success: true as const,
    value: {
      total: rows.length,
      pages,
      page: selected,
      rows: rows.slice(selected * 20, selected * 20 + 20),
    },
  };
}

/** Inspect an event's own logical fields and selected actual byte range; never synthesize missing wire bytes. */
export function buildStackMessageStructure(
  record: SavedStackRun,
  eventId: string,
  cursor: number,
  rangeIndex = 0,
  page = 0,
) {
  const projected = projectStackRecord(record, cursor);
  if (!projected.success) return projected;
  const view = projected.value;
  const event = view.events.find((e) => e.eventId === eventId);
  if (!event)
    return {
      success: false as const,
      diagnostics: [
        { path: '/eventId', code: 'stack-prefix', message: '현재 기록 위치에 없는 이벤트입니다.' },
      ],
    };
  const protocol = stackProtocolAt(view.snapshot, event.endpoint);
  const body = stackProtocolBody(protocol);
  const data = stackObject(event.data);
  const message = stackObject(data.message);
  const definition = body.messages.find((m) => m.id === message.messageId);
  const values = stackObject(message.values);
  const selected = Number.isSafeInteger(rangeIndex)
    ? event.payloads[Math.max(0, rangeIndex)]
    : undefined;
  const bytes = selected ? stackRangeBytes(view.artifacts, selected, event.payloads) : undefined;
  const bytePage = bytes ? structureBytePage(Array.from(bytes), page) : undefined;
  const fields = (definition?.fields ?? []).slice(0, 20).map((field) => ({
    id: field.id,
    name: field.name,
    type: field.type,
    value: previewJson(values[field.id] ?? null),
    placement: field.placement,
    range: field.type === 'bytes' ? stackObject(values[field.id]) : undefined,
  }));
  const wire = stackObject(data.wire);
  const wireRange = stackObject(wire.range);
  const canAnalyze =
    protocol.mode === 'legacy-application' &&
    event.kind === 'send' &&
    wire.kind === 'bytes' &&
    selected &&
    wireRange.payloadId === selected.payloadId &&
    wireRange.offset === selected.offset &&
    wireRange.length === selected.length &&
    definition;
  const legacyDefinition =
    protocol.mode === 'legacy-application'
      ? protocol.source.messages.find((m) => m.id === message.messageId)
      : undefined;
  const layout =
    canAnalyze &&
    legacyDefinition &&
    bytes &&
    bytes.length <= STACK_OBSERVATION_POLICY.analysisBytes
      ? inspectMessageByteLayout(
          body.codec,
          legacyDefinition,
          values as import('../domain/protocol-model.ts').ProtocolMessage['values'],
          Array.from(bytes),
        )
      : undefined;
  return {
    success: true as const,
    value: {
      event,
      codec: body.codec,
      fields,
      totalFields: definition?.fields.length ?? 0,
      ranges: event.payloads,
      selected,
      bytePage,
      layout: layout ? { ...layout, ranges: Object.fromEntries(layout.ranges) } : undefined,
      status:
        layout?.status ??
        (event.kind === 'receive' || event.kind === 'service-received'
          ? 'chunk'
          : wire.kind === 'packet'
            ? 'logical'
            : bytes
              ? 'raw'
              : 'logical'),
      limited:
        (definition?.fields.length ?? 0) > 20 ||
        (bytes?.length ?? 0) > STACK_OBSERVATION_POLICY.analysisBytes,
      note:
        wire.kind === 'packet'
          ? '논리 패킷과 payload bytes입니다. TCP/IP 바이너리 header offset을 의미하지 않습니다.'
          : event.kind === 'parsed'
            ? '관찰된 해석 값과 해당 프레임의 실제 source 범위입니다.'
            : '선택한 실제 byte 범위만 표시합니다. 수신 청크는 앱 메시지 경계와 다를 수 있습니다.',
    },
  };
}
