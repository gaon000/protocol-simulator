import type { JsonObject, JsonValue, ParticipantId } from '../domain/execution-contract.ts';
import type { EventTrace } from '../domain/protocol-model.ts';
import type { SavedRun } from '../domain/workspace-model.ts';
import { snapshotCompatibility } from '../domain/workspace-validation.ts';
import { batchRunMetrics } from './batch-experiments.ts';
import { sequenceProtocol, traceMessage, traceObject } from './sequence-diagram.ts';

export const COMPARISON_POLICY = {
  events: 10_000,
  lookahead: 32,
  pageSize: 20,
  valueNodes: 4096,
  valueCharacters: 65536,
  totalNodes: 1_000_000,
  totalCharacters: 2_097_152,
  depth: 32,
  targetCharacters: 1024,
} as const;
export type ComparisonRelation = 'same' | 'different' | 'limited' | 'left-only' | 'right-only';
export type ValueDifference = {
  readonly id: string;
  readonly label: string;
  readonly section: 'configuration' | 'result' | 'A' | 'B' | 'expectation';
  readonly left: JsonValue | undefined;
  readonly right: JsonValue | undefined;
  readonly relation: ComparisonRelation;
};
export type EventDifference = {
  readonly index: number;
  readonly left: EventTrace | undefined;
  readonly right: EventTrace | undefined;
  readonly relation: ComparisonRelation;
  readonly content: 'same' | 'different' | 'limited' | undefined;
  readonly deltaMs: number | undefined;
};
export type RunComparison = {
  readonly values: readonly ValueDifference[];
  readonly events: readonly EventDifference[];
  readonly traceStatus: 'ready' | 'unavailable';
  readonly message: string;
  readonly firstDifference: number | undefined;
  readonly limitedBeforeFirst: boolean;
};
type Budget = { nodes: number; characters: number };
function compareValue(
  left: JsonValue,
  right: JsonValue,
  budget: Budget,
): 'same' | 'different' | 'limited' {
  let nodes = COMPARISON_POLICY.valueNodes as number;
  let characters = COMPARISON_POLICY.valueCharacters as number;
  function visit(a: JsonValue, b: JsonValue, depth: number): 'same' | 'different' | 'limited' {
    if (--nodes < 0 || --budget.nodes < 0 || depth > COMPARISON_POLICY.depth) return 'limited';
    if (typeof a === 'string' && typeof b === 'string') {
      const size = a.length + b.length;
      if (size > characters || size > budget.characters) return 'limited';
      characters -= size;
      budget.characters -= size;
    }
    if (a === b) return 'same';
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return 'different';
    if (Array.isArray(a) !== Array.isArray(b)) return 'different';
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return 'different';
      if (a.length > nodes || a.length > budget.nodes) return 'limited';
    }
    const keys = Object.keys(a);
    const other = Object.keys(b);
    if (keys.length !== other.length) return 'different';
    if (keys.length > nodes || keys.length > budget.nodes) return 'limited';
    let limited = false;
    for (const key of keys) {
      if (!Object.hasOwn(b, key)) return 'different';
      const result = visit(
        (a as JsonObject)[key] ?? null,
        (b as JsonObject)[key] ?? null,
        depth + 1,
      );
      if (result === 'different') return result;
      if (result === 'limited') limited = true;
      if (nodes < 0 || budget.nodes < 0 || budget.characters < 0) return 'limited';
    }
    return limited ? 'limited' : 'same';
  }
  return visit(left, right, 0);
}
function target(event: EventTrace): string | readonly string[] | undefined {
  const data = traceObject(event.data);
  const text = (value: JsonValue | undefined) =>
    value === undefined ? '' : typeof value === 'string' ? value : undefined;
  switch (event.kind) {
    case 'transition':
      return event.ruleId ?? '';
    case 'input':
    case 'send':
    case 'parsed':
    case 'deliver':
      return traceMessage(event)?.messageId ?? '';
    case 'timer':
      return typeof data.timerId === 'string' && typeof data.operation === 'string'
        ? [data.timerId, data.operation]
        : undefined;
    case 'connection':
      return text(data.state);
    case 'diagnostic':
      return text(data.code);
    case 'receive':
      return typeof data.from === 'string' && typeof traceObject(data.wire).kind === 'string'
        ? [data.from, String(traceObject(data.wire).kind)]
        : undefined;
    case 'environment': {
      const operation = text(data.operation);
      const direction = text(data.direction);
      return operation === undefined || direction === undefined
        ? undefined
        : [operation, direction];
    }
  }
}
function eventKey(event: EventTrace): string {
  return JSON.stringify([event.participant, event.kind, target(event)]);
}
function semanticData(event: EventTrace): JsonValue {
  const data = traceObject(event.data);
  // Stream contributors are local trace identifiers, not content shared by two executions.
  if (!Object.hasOwn(data, 'sourceEventIds')) return event.data;
  const { sourceEventIds: _sources, ...content } = data;
  return content;
}
function traceProblem(record: SavedRun): string | undefined {
  const unsupported = snapshotCompatibility(record.view.snapshot);
  if (unsupported) return '지원하지 않는 엔진/난수 버전';
  if (
    record.view.events.length > COMPARISON_POLICY.events ||
    record.view.events.length > record.view.snapshot.limits.maxEvents
  )
    return '이벤트 수 한도 초과';
  const protocols = {
    A: sequenceProtocol(record.view, 'A'),
    B: sequenceProtocol(record.view, 'B'),
  };
  const states = { A: protocols.A?.initialStateId, B: protocols.B?.initialStateId };
  if (!protocols.A || !protocols.B) return '당시 프로토콜 정의 없음';
  const rules = {
    A: new Map(protocols.A.rules.map((item) => [item.id, item])),
    B: new Map(protocols.B.rules.map((item) => [item.id, item])),
  };
  const ids = new Set<string>();
  let time = 0;
  for (const [index, event] of record.view.events.entries()) {
    const name = target(event);
    if (
      name === undefined ||
      (typeof name === 'string' ? name.length : name.reduce((sum, part) => sum + part.length, 0)) >
        COMPARISON_POLICY.targetCharacters
    )
      return '관찰 대상 ID의 형식/길이 한도 초과';
    if (
      event.sequence !== index ||
      event.runId !== record.view.runId ||
      ids.has(event.eventId) ||
      event.timeMs < time ||
      event.timeMs > record.view.timeMs ||
      (event.causeEventId && !ids.has(event.causeEventId))
    )
      return '순서/발생 이벤트가 모순인 기록';
    if (event.kind === 'transition') {
      const rule = rules[event.participant].get(event.ruleId ?? '');
      const data = traceObject(event.data);
      if (
        !rule ||
        traceObject(data.before).stateId !== states[event.participant] ||
        rule.fromStateId !== states[event.participant] ||
        rule.nextStateId !== traceObject(data.after).stateId
      )
        return '정의/전후 상태가 모순인 기록';
      states[event.participant] = rule.nextStateId;
    }
    time = event.timeMs;
    ids.add(event.eventId);
  }
  if (
    record.view.status === 'completed' &&
    (['A', 'B'] as const).some((id) => states[id] !== record.view.participants[id].stateId)
  )
    return '완료 상태와 관찰 전이가 다른 기록';
  return undefined;
}

/** Label an original event without serializing payloads or treating IDs across runs as shared causes. */
export function comparisonEventTitle(event: EventTrace): string {
  const value = target(event);
  const name = Array.isArray(value) ? value.join(' · ') : String(value);
  return `${event.participant} · ${event.kind} · ${name.slice(0, 100)}`;
}

/** Compare two saved observations with bounded values and monotone, nearby target-based event alignment. */
export function compareRuns(left: SavedRun, right: SavedRun): RunComparison {
  const values: ValueDifference[] = [];
  const budget: Budget = {
    nodes: COMPARISON_POLICY.totalNodes,
    characters: COMPARISON_POLICY.totalCharacters,
  };
  function add(
    section: ValueDifference['section'],
    id: string,
    label: string,
    a: JsonValue | undefined,
    b: JsonValue | undefined,
  ) {
    values.push({
      section,
      id,
      label,
      left: a,
      right: b,
      relation:
        a === undefined
          ? b === undefined
            ? 'same'
            : 'right-only'
          : b === undefined
            ? 'left-only'
            : compareValue(a, b, budget),
    });
  }
  const a = left.view.snapshot;
  const b = right.view.snapshot;
  add(
    'configuration',
    'source',
    '실험과 초안 버전',
    { experimentId: left.experimentId, draftVersion: left.draftVersion },
    { experimentId: right.experimentId, draftVersion: right.draftVersion },
  );
  add(
    'configuration',
    'protocols',
    '프로토콜 참조와 정의',
    {
      protocols: a.configuration.protocols,
      definitions: a.configuration.definitions,
    } as unknown as JsonValue,
    {
      protocols: b.configuration.protocols,
      definitions: b.configuration.definitions,
    } as unknown as JsonValue,
  );
  for (const [id, label] of [
    ['environment', '통신 환경'],
    ['scenario', '입력과 기대 조건'],
    ['seed', 'seed'],
  ] as const)
    add(
      'configuration',
      id,
      label,
      a.configuration[id] as unknown as JsonValue,
      b.configuration[id] as unknown as JsonValue,
    );
  add(
    'configuration',
    'engine',
    '엔진과 난수 버전',
    { engine: a.engineVersion, random: a.randomAlgorithm },
    { engine: b.engineVersion, random: b.randomAlgorithm },
  );
  add('configuration', 'limits', '실행 한도', a.limits, b.limits);
  add('result', 'status', '저장된 실행 상태', left.view.status, right.view.status);
  add('result', 'time', '관찰 시각 ms', left.view.timeMs, right.view.timeMs);
  add(
    'result',
    'metrics',
    '판정·송신·만료·완료 시간',
    batchRunMetrics(left.view) as unknown as JsonValue,
    batchRunMetrics(right.view) as unknown as JsonValue,
  );
  add(
    'result',
    'diagnostics',
    '저장된 진단',
    left.view.diagnostics as unknown as JsonValue,
    right.view.diagnostics as unknown as JsonValue,
  );
  for (const id of ['A', 'B'] as const) {
    const x = left.view.participants[id];
    const y = right.view.participants[id];
    add(
      id,
      `${id}:state`,
      '저장 상태·종료 결과',
      { state: x.stateId, outcome: x.outcome, finishedAt: x.finishedAt },
      { state: y.stateId, outcome: y.outcome, finishedAt: y.finishedAt },
    );
    add(
      id,
      `${id}:timers`,
      '저장된 타이머',
      x.timers as unknown as JsonValue,
      y.timers as unknown as JsonValue,
    );
    if (a.configuration.protocols[id].id === b.configuration.protocols[id].id) {
      for (const variable of new Set([...Object.keys(x.variables), ...Object.keys(y.variables)]))
        add(
          id,
          `${id}:variable:${variable}`,
          `변수 ${variable}`,
          x.variables[variable],
          y.variables[variable],
        );
    } else add(id, `${id}:variables`, '서로 다른 프로토콜의 변수', x.variables, y.variables);
  }
  const expected = (record: SavedRun, id: string): JsonValue | undefined => {
    const definition = record.view.snapshot.configuration.scenario.expectations.find(
      (item) => item.id === id,
    );
    const recorded = record.view.expectations.find((item) => item.expectationId === id);
    return definition || recorded
      ? {
          definition: (definition as unknown as JsonValue) ?? null,
          recorded: (recorded as unknown as JsonValue) ?? null,
        }
      : undefined;
  };
  for (const id of new Set([
    ...a.configuration.scenario.expectations.map((item) => item.id),
    ...b.configuration.scenario.expectations.map((item) => item.id),
  ]))
    add('expectation', id, `기대 조건 ${id}`, expected(left, id), expected(right, id));
  const fail = (message: string): RunComparison => ({
    values,
    events: [],
    traceStatus: 'unavailable',
    message,
    firstDifference: undefined,
    limitedBeforeFirst: false,
  });
  for (const [side, record] of [
    ['왼쪽', left],
    ['오른쪽', right],
  ] as const) {
    const problem = traceProblem(record);
    if (problem)
      return fail(`${side}: ${problem}. 저장 결과만 표시하며 기록을 대응시키지 않습니다.`);
  }
  if (
    (['A', 'B'] as const).some(
      (id: ParticipantId) => a.configuration.protocols[id].id !== b.configuration.protocols[id].id,
    )
  )
    return fail(
      '서로 다른 프로토콜 ID입니다. 저장 결과를 독립적으로 표시하며 기록을 대응시키지 않습니다.',
    );
  const events: EventDifference[] = [];
  const xs = left.view.events;
  const ys = right.view.events;
  const xKeys = xs.map(eventKey);
  const yKeys = ys.map(eventKey);
  function append(x: EventTrace | undefined, y: EventTrace | undefined) {
    const content = x && y ? compareValue(semanticData(x), semanticData(y), budget) : undefined;
    const deltaMs = x && y ? y.timeMs - x.timeMs : undefined;
    events.push({
      index: events.length,
      left: x,
      right: y,
      content,
      deltaMs,
      relation: !x
        ? 'right-only'
        : !y
          ? 'left-only'
          : content === 'limited'
            ? 'limited'
            : content === 'different' || deltaMs !== 0
              ? 'different'
              : 'same',
    });
  }
  let i = 0;
  let j = 0;
  while (i < xs.length || j < ys.length) {
    if (i >= xs.length) {
      append(undefined, ys[j++]);
      continue;
    }
    if (j >= ys.length) {
      append(xs[i++], undefined);
      continue;
    }
    if (xKeys[i] === yKeys[j]) {
      append(xs[i++], ys[j++]);
      continue;
    }
    let nextX = -1;
    let nextY = -1;
    for (let step = 1; step <= COMPARISON_POLICY.lookahead; step++) {
      if (nextX < 0 && i + step < xs.length && xKeys[i + step] === yKeys[j]) nextX = step;
      if (nextY < 0 && j + step < ys.length && yKeys[j + step] === xKeys[i]) nextY = step;
      if (nextX >= 0 || nextY >= 0) break;
    }
    if (nextX >= 0 && (nextY < 0 || nextX <= nextY))
      for (let step = 0; step < nextX; step++) append(xs[i++], undefined);
    else if (nextY >= 0) for (let step = 0; step < nextY; step++) append(undefined, ys[j++]);
    else {
      append(xs[i++], undefined);
      append(undefined, ys[j++]);
    }
  }
  const first = events.find(
    (item) => item.relation !== 'same' && item.relation !== 'limited',
  )?.index;
  return {
    values,
    events,
    traceStatus: 'ready',
    message:
      '참여자·종류·대상 ID가 가까운 관찰을 순서대로 나란히 배치합니다. 반복 관찰의 대응은 동일한 원인이나 회차를 보장하지 않습니다. 한쪽 관찰만으로 손실/실패를 판정하지 않습니다.',
    firstDifference: first,
    limitedBeforeFirst: events
      .slice(0, first ?? events.length)
      .some((item) => item.relation === 'limited'),
  };
}
