import type { JsonValue } from '../domain/execution-contract.ts';
import { freezeOwned, isOwnedImmutable } from '../domain/immutable-data.ts';
import type { ValidationResult } from '../domain/protocol-model.ts';
import { type StackEndpoint, stackProtocolBody } from '../domain/stack-model.ts';
import {
  parseStackView,
  stackObject,
  stackProtocolAt,
  stackRecordCompatibility,
  stackRecordedBytes,
  stackTarget,
} from '../domain/stack-record.ts';
import type { StackInstanceView, StackView } from '../domain/stack-runtime-model.ts';
import { canonicalStackJson } from '../domain/stack-series-model.ts';
import type { SavedStackRun } from '../domain/workspace-v2-model.ts';
import { parseSavedStackRun } from '../domain/workspace-v2-validation.ts';

import { StackSemanticLimit, semanticStackEvent } from './stack-semantic-event.ts';

const prepared = new WeakMap<object, SavedStackRun>();
const projections = new WeakMap<SavedStackRun, Map<number, StackView>>();
/** Prime a private UI-worker cache only after workspace staging or a native engine capture validated the source. */
export function primeOwnedStackRecord(record: SavedStackRun): void {
  if (!isOwnedImmutable(record)) throw new Error('UI record ownership is required');
  prepared.set(record, record);
}
/** Validate once for owned immutable records; mutable external objects are rechecked on every boundary. */
export function readStackRecord(value: unknown): ValidationResult<SavedStackRun> {
  if (value && typeof value === 'object' && isOwnedImmutable(value)) {
    const old = prepared.get(value);
    if (old) return { success: true, value: old };
  }
  const parsed = parseSavedStackRun(value);
  if (!parsed.success) return parsed;
  const record = freezeOwned(structuredClone(parsed.value));
  prepared.set(record, record);
  if (value && typeof value === 'object' && isOwnedImmutable(value)) prepared.set(value, record);
  return { success: true, value: record };
}
/** Derive the exact bounded event cursor; n + 1 denotes the saved final state/verdict. */
export function stackCursor(record: SavedStackRun, position: number): number {
  return Number.isSafeInteger(position)
    ? Math.max(0, Math.min(position, record.view.events.length + 1))
    : 0;
}
/** Reconstruct only observed state, timers and service lifecycle; never resume a live runtime. */
export function projectStackRecord(
  value: SavedStackRun,
  position: number,
): ValidationResult<StackView> {
  const parsed = readStackRecord(value);
  if (!parsed.success) return parsed;
  const record = parsed.value;
  const view = record.view;
  const incompatible = stackRecordCompatibility(view.snapshot);
  if (incompatible)
    return {
      success: false,
      diagnostics: [{ path: '/snapshot', code: 'stack-version', message: incompatible }],
    };
  const cursor = stackCursor(record, position);
  if (cursor === view.events.length + 1) return { success: true, value: view };
  const cached = projections.get(record)?.get(cursor);
  if (cached) return { success: true, value: cached };
  type Actor = { -readonly [Key in keyof StackInstanceView]: StackInstanceView[Key] };
  const instances: Record<string, Actor> = {};
  for (const participant of ['A', 'B'] as const)
    for (const instance of view.snapshot.configuration.nodes[participant].instances) {
      const endpoint: StackEndpoint = { participant, instanceId: instance.id };
      const protocol = stackProtocolAt(view.snapshot, endpoint);
      const body = stackProtocolBody(protocol);
      const terminal = body.states.some((s) => s.id === body.initialStateId && s.terminal);
      instances[stackTarget(endpoint)] = {
        endpoint,
        stateId: body.initialStateId,
        variables: Object.fromEntries(
          body.variables.map((v) => [v.id, structuredClone(v.initial)]),
        ),
        outcome: terminal ? 'success' : 'active',
        finishedAt: terminal ? 0 : null,
        tainted: false,
        timers: body.timers.map((t) => ({ timerId: t.id, generation: 0, active: false, due: 0 })),
        ports: {
          requires: 'ready',
          ...(protocol.mode === 'stack-protocol' && protocol.provides
            ? { provides: 'ready' as const }
            : {}),
        },
      };
    }
  const events = view.events.slice(0, cursor);
  const usedPayloads = new Set<string>();
  for (const event of events) {
    for (const range of event.payloads) usedPayloads.add(range.payloadId);
    const actor = instances[stackTarget(event.endpoint)];
    if (!actor) continue;
    const data = stackObject(event.data);
    if (event.kind === 'transition') {
      const after = stackObject(data.after);
      actor.stateId = String(after.stateId);
      actor.variables = stackObject(after.variables);
      actor.outcome = data.outcome as StackInstanceView['outcome'];
      actor.timers = structuredClone(data.timers) as unknown as StackInstanceView['timers'];
      actor.ports = structuredClone(data.ports) as StackInstanceView['ports'];
      if (actor.outcome !== 'active') actor.finishedAt ??= event.timeMs;
    } else if (event.kind === 'timer') {
      actor.timers = actor.timers.map((timer) =>
        timer.timerId === data.timerId
          ? {
              ...timer,
              generation: Number(data.generation),
              active: data.operation === 'start',
              due: typeof data.due === 'number' ? data.due : timer.due,
            }
          : timer,
      );
    } else if (event.kind === 'connection')
      actor.ports = { ...actor.ports, requires: data.state as 'failed' | 'closed' };
    else if (
      event.kind === 'service-indication' &&
      (data.operation === 'failed' || data.operation === 'closed')
    )
      actor.ports = { ...actor.ports, provides: data.operation };
    else if (event.kind === 'diagnostic') {
      actor.outcome = 'error';
      actor.finishedAt ??= event.timeMs;
      actor.tainted = true;
      actor.timers = actor.timers.map((timer) => ({
        ...timer,
        active: false,
        generation: timer.generation + 1,
      }));
    }
  }
  for (const actor of Object.values(instances)) {
    const values = { ...actor.variables };
    for (const variable of stackProtocolBody(stackProtocolAt(view.snapshot, actor.endpoint))
      .variables)
      if (variable.type === 'bytes' && stackObject(values[variable.id]).kind === 'payload-range')
        values[variable.id] = stackRecordedBytes(values[variable.id] as JsonValue, view.artifacts);
    actor.variables = values;
  }
  const artifacts = {
    ...view.artifacts,
    payloads: view.artifacts.payloads.filter((p) => usedPayloads.has(p.payloadId)),
  };
  const projected: StackView = freezeOwned({
    ...view,
    status: 'paused',
    timeMs: events.at(-1)?.timeMs ?? 0,
    processedOperations: 0,
    pendingOperations: 0,
    instances,
    events,
    artifacts,
    usage: {
      uniqueBytes: artifacts.payloads.reduce((n, p) => n + p.bytes.byteLength, 0),
      liveBytes: 0,
      traceEvents: events.length,
      artifactBytes: new TextEncoder().encode(JSON.stringify({ trace: events, artifacts })).length,
    },
    diagnostics: events
      .filter((e) => e.kind === 'diagnostic')
      .map((e) => stackObject(e.data) as unknown as StackView['diagnostics'][number]),
    expectations: view.expectations.map((e) => ({
      ...e,
      status: 'undetermined',
      detail: '기록 재생 중: 저장 시점에서 당시 판정을 표시합니다.',
    })),
  });
  const cache = projections.get(record) ?? new Map<number, StackView>();
  if (cache.size >= 4) cache.delete(cache.keys().next().value ?? 0);
  cache.set(cursor, projected);
  projections.set(record, cache);
  return { success: true, value: projected };
}
/** Compare actual trace/artifact contents independently of run and payload IDs, retaining partial-prefix semantics. */
export function compareStackReplay(
  record: SavedStackRun,
  replayed: StackView,
): 'same' | 'different' | 'unavailable' | 'limited' {
  if (!readStackRecord(record).success || !parseStackView(replayed).success) return 'unavailable';
  if (
    stackRecordCompatibility(record.view.snapshot) ||
    canonicalStackJson(record.view.snapshot) !== canonicalStackJson(replayed.snapshot)
  )
    return 'unavailable';
  const partial = ['idle', 'running', 'paused', 'cancelled'].includes(record.view.status);
  const events = partial ? replayed.events.slice(0, record.view.events.length) : replayed.events;
  const budget = { bytes: 33_554_432, events: 20_000 };
  const normalize = (view: StackView, items: StackView['events']) => {
    const ids = new Map(view.events.map((e, i) => [e.eventId, i]));
    return items.map((event) => semanticStackEvent(view, event, ids, budget));
  };
  let same: boolean;
  try {
    same =
      canonicalStackJson(normalize(record.view, record.view.events)) ===
      canonicalStackJson(normalize(replayed, events));
  } catch (error) {
    if (error instanceof StackSemanticLimit) return 'limited';
    throw error;
  }
  const instances = (items: StackView['instances']) =>
    Object.fromEntries(
      Object.entries(items).map(([key, value]) => {
        const { buffers: _buffers, ...withoutBuffers } = value;
        return [key, record.view.instances[key]?.buffers === undefined ? withoutBuffers : value];
      }),
    );
  return same &&
    (partial ||
      (record.view.status === replayed.status &&
        canonicalStackJson(instances(record.view.instances)) ===
          canonicalStackJson(instances(replayed.instances)) &&
        canonicalStackJson(record.view.expectations) ===
          canonicalStackJson(replayed.expectations) &&
        canonicalStackJson(record.view.diagnostics) === canonicalStackJson(replayed.diagnostics)))
    ? 'same'
    : 'different';
}
