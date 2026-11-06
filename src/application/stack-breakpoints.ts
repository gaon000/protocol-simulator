import type { JsonValue } from '../domain/execution-contract.ts';
import { freezeOwned } from '../domain/immutable-data.ts';
import { parseJsonData } from '../domain/model-validation.ts';
import type { ValidationResult } from '../domain/protocol-model.ts';
import { parseBytesValue } from '../domain/stack-bytes.ts';
import {
  type RunArtifacts,
  type StackEndpoint,
  type StackSnapshot,
  type StackTrace,
  stackProtocolBody,
} from '../domain/stack-model.ts';
import {
  stackObject,
  stackProtocolAt,
  stackRecordCompatibility,
  stackRecordedBytes,
  stackTarget,
} from '../domain/stack-record.ts';
import { canonicalStackJson } from '../domain/stack-series-model.ts';
import type { StackScheduler } from '../engine/stack-scheduler.ts';
import type { Breakpoint } from './breakpoints.ts';

export type StackBreakpoint = Omit<Breakpoint, 'participant'> & {
  readonly endpoint: StackEndpoint;
};
export type StackBreakpointPlan = {
  readonly snapshot: StackSnapshot;
  readonly points: readonly { readonly point: StackBreakpoint; readonly literal?: JsonValue }[];
};
export type StackBreakpointStop = {
  readonly kind: 'match' | 'evaluation-error';
  readonly event: StackTrace;
  readonly hits: readonly {
    readonly id: string;
    readonly label: string;
    readonly detail: string;
  }[];
  readonly trailingEvents: number;
};
function bounded(value: JsonValue): void {
  let nodes = 1024;
  let characters = 8192;
  function visit(value: JsonValue, depth: number) {
    if (--nodes < 0 || depth > 16) throw new Error('중단점 값의 계산 한도입니다.');
    if (typeof value === 'string') characters -= value.length;
    if (characters < 0) throw new Error('중단점 값의 크기 한도입니다.');
    if (value && typeof value === 'object')
      for (const [key, child] of Object.entries(value)) {
        characters -= key.length;
        visit(child as JsonValue, depth + 1);
      }
  }
  visit(value, 0);
}
/** Compile tab-local debugger settings against exact endpoint/revision and the frozen executable source. */
export function compileStackBreakpoints(
  snapshot: StackSnapshot,
  settings: { readonly enabled: boolean; readonly points: readonly StackBreakpoint[] },
): ValidationResult<StackBreakpointPlan> {
  const diagnostics: { path: string; code: string; message: string }[] = [];
  const issue = (id: string, message: string) => {
    diagnostics.push({ path: `/breakpoints/${id}`, code: 'stack-breakpoint', message });
  };
  if (settings.points.length > 20) issue('', '중단점은 최대 20개입니다.');
  const active = settings.enabled ? settings.points.filter((p) => p.enabled) : [];
  if (active.length && stackRecordCompatibility(snapshot))
    issue('version', '지원하지 않는 엔진 버전의 중단점은 평가하지 않습니다.');
  const ids = new Set<string>();
  const points: { point: StackBreakpoint; literal?: JsonValue }[] = [];
  for (const point of active.slice(0, 20)) {
    try {
      if (!point.id || ids.has(point.id) || !point.label.trim() || point.label.length > 80)
        throw new Error('중단점 ID/이름을 확인하세요.');
      ids.add(point.id);
      const protocol = stackProtocolAt(snapshot, point.endpoint);
      const body = stackProtocolBody(protocol);
      if (point.protocolId !== protocol.id || point.protocolRevision !== protocol.revision)
        throw new Error('snapshot의 endpoint/정의 revision과 다릅니다.');
      let literal: JsonValue | undefined;
      if (point.kind === 'state' && !body.states.some((s) => s.id === point.targetId))
        throw new Error('없는 상태입니다.');
      if (point.kind === 'message' && !body.messages.some((m) => m.id === point.targetId))
        throw new Error('없는 메시지입니다.');
      if (point.kind === 'variable') {
        const variable = body.variables.find((v) => v.id === point.targetId);
        if (!variable) throw new Error('없는 변수입니다.');
        if (!['eq', 'ne', 'lt', 'lte', 'gt', 'gte'].includes(point.operator))
          throw new Error('비교 연산자를 확인하세요.');
        if (point.literal.length > 8192) throw new Error('비교 값은 최대 8192자입니다.');
        literal = JSON.parse(point.literal) as JsonValue;
        bounded(literal);
        if (!parseJsonData(literal).success) throw new Error('유효하지 않은 JSON입니다.');
        if (variable.type === 'bytes') {
          if (!parseBytesValue(literal).success) throw new Error('유효한 bytes 값이 필요합니다.');
        } else if (
          variable.type !== 'json' &&
          (variable.type === 'integer'
            ? !Number.isSafeInteger(literal)
            : typeof literal !== variable.type)
        )
          throw new Error('변수와 비교 값의 타입이 다릅니다.');
        if (
          !['integer', 'string'].includes(variable.type) &&
          !['eq', 'ne'].includes(point.operator)
        )
          throw new Error('이 변수는 같음/다름으로 비교하세요.');
      }
      if (!['state', 'message', 'variable'].includes(point.kind))
        throw new Error('알 수 없는 중단점 종류입니다.');
      points.push({ point, ...(literal === undefined ? {} : { literal }) });
    } catch (error) {
      issue(point.id, String(error));
    }
  }
  return diagnostics.length
    ? { success: false, diagnostics }
    : { success: true, value: freezeOwned(structuredClone({ snapshot, points })) };
}

/** Match only supplied newly committed events; errors stop the debugger without failing the simulation. */
export function matchStackBreakpoints(
  plan: StackBreakpointPlan,
  events: readonly StackTrace[],
  artifacts: RunArtifacts,
): StackBreakpointStop | undefined {
  for (const [index, event] of events.entries()) {
    const hits: { id: string; label: string; detail: string }[] = [];
    for (const compiled of plan.points) {
      const { point, literal } = compiled;
      if (stackTarget(point.endpoint) !== stackTarget(event.endpoint)) continue;
      try {
        const data = stackObject(event.data);
        const before = stackObject(data.before);
        const after = stackObject(data.after);
        let hit = false;
        if (point.kind === 'state')
          hit =
            event.kind === 'transition' &&
            after.stateId === point.targetId &&
            before.stateId !== after.stateId;
        if (point.kind === 'message')
          hit = event.kind === 'parsed' && stackObject(data.message).messageId === point.targetId;
        if (point.kind === 'variable' && event.kind === 'transition') {
          let value = stackObject(after.variables)[point.targetId];
          if (value === undefined) throw new Error('관찰된 after 변수가 없습니다.');
          const variable = stackProtocolBody(
            stackProtocolAt(plan.snapshot, point.endpoint),
          ).variables.find((v) => v.id === point.targetId);
          if (variable?.type === 'bytes')
            value = stackRecordedBytes(value, artifacts, event.payloads);
          bounded(value);
          if (point.operator === 'eq')
            hit = canonicalStackJson(value) === canonicalStackJson(literal);
          else if (point.operator === 'ne')
            hit = canonicalStackJson(value) !== canonicalStackJson(literal);
          else {
            if (
              !(
                (typeof value === 'number' && typeof literal === 'number') ||
                (typeof value === 'string' && typeof literal === 'string')
              )
            )
              throw new Error('관찰된 값의 비교 타입이 다릅니다.');
            switch (point.operator) {
              case 'lt':
                hit = value < literal;
                break;
              case 'lte':
                hit = value <= literal;
                break;
              case 'gt':
                hit = value > literal;
                break;
              case 'gte':
                hit = value >= literal;
                break;
            }
          }
        }
        if (hit)
          hits.push({
            id: point.id,
            label: point.label,
            detail: `${stackTarget(event.endpoint)} · ${point.kind} · ${point.targetId}`,
          });
      } catch (error) {
        return {
          kind: 'evaluation-error',
          event,
          hits: [{ id: point.id, label: point.label, detail: String(error) }],
          trailingEvents: events.length - index - 1,
        };
      }
    }
    if (hits.length)
      return { kind: 'match', event, hits, trailingEvents: events.length - index - 1 };
  }
  return undefined;
}
/** Preserve queue-operation atomicity while returning the first observed stop and its trailing committed events. */
export function runStackWithBreakpoints(
  engine: StackScheduler,
  plan: StackBreakpointPlan,
  budget = 64,
) {
  if (canonicalStackJson(engine.snapshot) !== canonicalStackJson(plan.snapshot))
    throw new Error('중단점 계획이 현재 실행 snapshot과 다릅니다.');
  if (!plan.points.length) return { view: engine.runBatch(budget), stop: undefined };
  let stop: StackBreakpointStop | undefined;
  const view = engine.runBatch(budget, (events) => {
    stop = matchStackBreakpoints(plan, events, engine.readArtifacts());
    return stop !== undefined;
  });
  return { view, stop };
}
