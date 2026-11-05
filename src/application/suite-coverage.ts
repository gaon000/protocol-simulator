import type { JsonObject, JsonValue, ParticipantId } from '../domain/execution-contract.ts';
import type { EventTrace, ProtocolDefinition, RuleDefinition } from '../domain/protocol-model.ts';
import type { SavedRun } from '../domain/workspace-model.ts';
import { snapshotCompatibility } from '../domain/workspace-validation.ts';
import { sequenceProtocol, traceMessage, traceObject } from './sequence-diagram.ts';

export const COVERAGE_POLICY = {
  cases: 20,
  eventsPerCase: 10_000,
  sourceNodes: 1_000_000,
  pageSize: 20,
} as const;
export type CoverageEvidence = {
  readonly record: SavedRun;
  readonly caseIndex: number;
  readonly label: string;
  readonly count: number;
  readonly position: number;
};
export type CoverageItem = {
  readonly id: string;
  readonly index: number;
  readonly count: number;
  readonly cases: readonly CoverageEvidence[];
};
export type CoverageActor = {
  readonly participant: ParticipantId;
  readonly protocol: ProtocolDefinition;
  readonly states: readonly CoverageItem[];
  readonly rules: readonly CoverageItem[];
};
export type CoverageCase = {
  readonly id: string;
  readonly label: string;
  readonly record: SavedRun | undefined;
  readonly status: 'included' | 'missing' | 'excluded';
  readonly reason: string;
  readonly partial: boolean;
};
export type SuiteCoverage = {
  readonly status: 'ready' | 'unavailable';
  readonly message: string;
  readonly basis: SavedRun | undefined;
  readonly actors: readonly CoverageActor[];
  readonly cases: readonly CoverageCase[];
};

function sameJson(left: JsonValue, right: JsonValue, budget: { remaining: number }): boolean {
  const pending: [JsonValue, JsonValue][] = [[left, right]];
  while (pending.length) {
    if (--budget.remaining < 0) throw new Error('공통 정의의 동일성 비교 상한에 도달했습니다.');
    const pair = pending.pop();
    if (!pair) break;
    const [a, b] = pair;
    if (a === b) continue;
    if (
      !a ||
      !b ||
      typeof a !== 'object' ||
      typeof b !== 'object' ||
      Array.isArray(a) !== Array.isArray(b)
    )
      return false;
    const keys = Object.keys(a);
    if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return false;
    if (keys.length !== Object.keys(b).length) return false;
    if (keys.length > budget.remaining)
      throw new Error('공통 정의의 동일성 비교 상한에 도달했습니다.');
    for (const key of keys) {
      if (!Object.hasOwn(b, key)) return false;
      pending.push([(a as JsonObject)[key] ?? null, (b as JsonObject)[key] ?? null]);
    }
  }
  return true;
}
function header(record: SavedRun): JsonValue {
  const {
    scenario: _scenario,
    environment: _environment,
    seed: _seed,
    ...source
  } = record.view.snapshot.configuration;
  const { caseIndex: _caseIndex, ...group } = record.regression ?? {};
  return {
    experimentId: record.experimentId,
    version: record.draftVersion,
    group,
    source,
    engine: record.view.snapshot.engineVersion,
    random: record.view.snapshot.randomAlgorithm,
    limits: record.view.snapshot.limits,
  } as unknown as JsonValue;
}
type MutableItem = { id: string; index: number; count: number; cases: CoverageEvidence[] };
type Context = {
  participant: ParticipantId;
  protocol: ProtocolDefinition;
  states: MutableItem[];
  rules: MutableItem[];
  stateIndices: ReadonlyMap<string, number>;
  ruleIndices: ReadonlyMap<string, number>;
};
type Count = { count: number; position: number };
type Counts = Record<
  ParticipantId,
  { states: Map<string, Count>; rules: Map<string, Count>; state: string }
>;
function matchesTrigger(
  rule: RuleDefinition,
  event: EventTrace | undefined,
  participant: ParticipantId,
) {
  if (!event || event.participant !== participant) return false;
  const trigger = rule.event;
  if (trigger.kind === 'input' || trigger.kind === 'receive')
    return (
      event.kind === (trigger.kind === 'input' ? 'input' : 'parsed') &&
      traceMessage(event)?.messageId === trigger.messageId
    );
  const data = traceObject(event.data);
  return trigger.kind === 'timer'
    ? event.kind === 'timer' && data.operation === 'expire' && data.timerId === trigger.timerId
    : trigger.kind === 'connection' && event.kind === 'connection' && data.state === trigger.state;
}
function inspectCase(record: SavedRun, contexts: readonly Context[]): Counts | string {
  if (
    record.view.events.length > COVERAGE_POLICY.eventsPerCase ||
    record.view.events.length > record.view.snapshot.limits.maxEvents
  )
    return '기록 이벤트 수 상한 초과';
  const initial = (participant: ParticipantId) => {
    const state =
      contexts.find((item) => item.participant === participant)?.protocol.initialStateId ?? '';
    return {
      states: new Map([[state, { count: 1, position: 0 }]]),
      rules: new Map<string, Count>(),
      state,
    };
  };
  const counts: Counts = { A: initial('A'), B: initial('B') };
  const byId = new Map<string, EventTrace>();
  let time = 0;
  function add(map: Map<string, Count>, id: string, position: number) {
    const old = map.get(id);
    map.set(id, { count: (old?.count ?? 0) + 1, position: old?.position ?? position });
  }
  for (const [index, event] of record.view.events.entries()) {
    if (
      event.sequence !== index ||
      event.runId !== record.view.runId ||
      byId.has(event.eventId) ||
      event.timeMs < time ||
      event.timeMs > record.view.timeMs
    )
      return '이벤트 순서/실행 ID가 모순인 기록';
    time = event.timeMs;
    if (event.kind === 'transition') {
      const context = contexts.find((item) => item.participant === event.participant);
      const ruleIndex = context?.ruleIndices.get(event.ruleId ?? '');
      const rule = ruleIndex === undefined ? undefined : context?.protocol.rules[ruleIndex];
      const data = traceObject(event.data);
      const before = traceObject(data.before).stateId;
      const after = traceObject(data.after).stateId;
      const actor = counts[event.participant];
      if (
        !context ||
        !rule ||
        typeof before !== 'string' ||
        typeof after !== 'string' ||
        before !== actor.state ||
        before !== rule.fromStateId ||
        after !== rule.nextStateId ||
        !context.stateIndices.has(after) ||
        !matchesTrigger(rule, byId.get(event.causeEventId ?? ''), event.participant)
      )
        return '정의/직접 발생 이벤트와 맞지 않는 전이 기록';
      add(actor.states, after, index + 1);
      add(actor.rules, rule.id, index + 1);
      actor.state = after;
    }
    byId.set(event.eventId, event);
  }
  if (
    record.view.status === 'completed' &&
    contexts.some(
      (item) =>
        counts[item.participant].state !== record.view.participants[item.participant].stateId,
    )
  )
    return '완료 상태와 마지막 관찰 전이가 다른 기록';
  return counts;
}

/** Aggregate one frozen regression manifest, counting only observed initial states and committed transitions. */
export function buildSuiteCoverage(records: readonly SavedRun[], groupId: string): SuiteCoverage {
  const group = records.filter((item) => item.regression?.id === groupId);
  const basis = group[0];
  const unavailable = (message: string, cases: readonly CoverageCase[] = []): SuiteCoverage => ({
    status: 'unavailable',
    message,
    basis,
    actors: [],
    cases,
  });
  if (!basis?.regression) return unavailable('선택한 검증 실행의 저장 기록이 없습니다.');
  const manifest = basis.regression.cases;
  if (
    !manifest.length ||
    manifest.length > COVERAGE_POLICY.cases ||
    group.length > COVERAGE_POLICY.cases ||
    new Set(manifest.map((item) => item.id)).size !== manifest.length
  )
    return unavailable('사례 manifest가 없거나 중복/상한을 확인할 수 없습니다.');
  const slots = new Map<number, SavedRun>();
  const recordIds = new Set<string>();
  const baseHeader = header(basis);
  const budget = { remaining: COVERAGE_POLICY.sourceNodes as number };
  try {
    for (const record of group) {
      const index = record.regression?.caseIndex;
      if (snapshotCompatibility(record.view.snapshot))
        return unavailable('지원하지 않는 엔진/난수 버전이 포함되어 집계하지 않습니다.');
      if (
        index === undefined ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= manifest.length ||
        slots.has(index) ||
        recordIds.has(record.id)
      )
        return unavailable('중복되거나 manifest에 없는 사례 slot이 포함되어 있습니다.');
      if (!sameJson(baseHeader, header(record), budget))
        return unavailable('공통 프로토콜·검증 버전·엔진 계약이 다른 기록을 합칠 수 없습니다.');
      slots.set(index, record);
      recordIds.add(record.id);
    }
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : '공통 기준을 확인할 수 없습니다.');
  }
  const contexts: Context[] = [];
  for (const participant of ['A', 'B'] as const) {
    const protocol = sequenceProtocol(basis.view, participant);
    if (
      !protocol?.states.some((item) => item.id === protocol.initialStateId) ||
      new Set(protocol.states.map((item) => item.id)).size !== protocol.states.length ||
      new Set(protocol.rules.map((item) => item.id)).size !== protocol.rules.length
    )
      return unavailable('당시 참여자 프로토콜의 상태/규칙 기준을 확인할 수 없습니다.');
    const make = (items: readonly { id: string }[]) =>
      items.map((item, index) => ({
        id: item.id,
        index,
        count: 0,
        cases: [] as CoverageEvidence[],
      }));
    contexts.push({
      participant,
      protocol,
      states: make(protocol.states),
      rules: make(protocol.rules),
      stateIndices: new Map(protocol.states.map((item, index) => [item.id, index])),
      ruleIndices: new Map(protocol.rules.map((item, index) => [item.id, index])),
    });
  }
  const cases: CoverageCase[] = manifest.map((item, caseIndex) => {
    const record = slots.get(caseIndex);
    if (!record)
      return {
        ...item,
        record: undefined,
        status: 'missing',
        reason: '미실행·삭제',
        partial: false,
      };
    const counts = inspectCase(record, contexts);
    if (typeof counts === 'string')
      return { ...item, record, status: 'excluded', reason: counts, partial: false };
    for (const context of contexts) {
      for (const kind of ['states', 'rules'] as const) {
        const indices = kind === 'states' ? context.stateIndices : context.ruleIndices;
        for (const [id, count] of counts[context.participant][kind]) {
          const index = indices.get(id);
          const target = index === undefined ? undefined : context[kind][index];
          if (target) {
            target.count += count.count;
            target.cases.push({ record, caseIndex, label: item.label, ...count });
          }
        }
      }
    }
    return {
      ...item,
      record,
      status: 'included',
      reason: `${record.view.status === 'completed' ? '관찰 완료' : `부분 관찰 · ${record.view.status}`}${Object.values(record.view.participants).some((actor) => actor.outcome === 'error') ? ' · 참여자 오류' : ''}`,
      partial: record.view.status !== 'completed',
    };
  });
  if (!cases.some((item) => item.status === 'included'))
    return unavailable('집계할 수 있는 관찰 기록이 없습니다.', cases);
  return {
    status: 'ready',
    message:
      '기록된 관찰만 집계합니다. 미관찰은 오류나 도달 불가능 판정이 아닙니다. 통과율·조건 분기·전체 경로 검증과 구분하세요.',
    basis,
    actors: contexts.map(({ participant, protocol, states, rules }) => ({
      participant,
      protocol,
      states,
      rules,
    })),
    cases,
  };
}
