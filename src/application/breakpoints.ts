import type { JsonValue, ParticipantId } from '../domain/execution-contract.ts';
import { freezeOwned } from '../domain/immutable-data.ts';
import { parseJsonData } from '../domain/model-validation.ts';
import type {
  Condition,
  EventTrace,
  ExperimentDefinition,
  ExperimentSnapshot,
  ModelDiagnostic,
  ValidationResult,
} from '../domain/protocol-model.ts';
import { snapshotCompatibility } from '../domain/workspace-validation.ts';
import { evaluateCondition } from '../engine/expressions.ts';
import { previewJson } from './preview-json.ts';
import { traceMessage, traceObject } from './sequence-diagram.ts';

export const BREAKPOINT_POLICY = { points: 20, nodes: 1024, characters: 8192, depth: 16 } as const;
export const BREAKPOINT_OPERATORS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] as const;
export type Breakpoint = {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly participant: ParticipantId;
  readonly protocolId: string;
  readonly protocolRevision: number;
  readonly kind: 'state' | 'message' | 'variable';
  readonly targetId: string;
  readonly operator: (typeof BREAKPOINT_OPERATORS)[number];
  readonly literal: string;
};
export type BreakpointSettings = {
  readonly enabled: boolean;
  readonly points: readonly Breakpoint[];
};
export const EMPTY_BREAKPOINTS: BreakpointSettings = { enabled: true, points: [] };
type CompiledPoint = { readonly point: Breakpoint; readonly condition: Condition | undefined };
export type BreakpointPlan = { readonly points: readonly CompiledPoint[] };
export type BreakpointStop = {
  readonly kind: 'match' | 'evaluation-error';
  readonly event: EventTrace;
  readonly hits: readonly {
    readonly id: string;
    readonly label: string;
    readonly detail: string;
  }[];
  readonly trailingEvents: number;
};
function bounded(value: JsonValue) {
  let nodes = BREAKPOINT_POLICY.nodes as number;
  let characters = BREAKPOINT_POLICY.characters as number;
  function visit(node: JsonValue, depth: number) {
    if (--nodes < 0 || depth > BREAKPOINT_POLICY.depth)
      throw new Error('조건 값의 크기/깊이 상한을 넘었습니다.');
    if (typeof node === 'string') characters -= node.length;
    if (characters < 0) throw new Error('조건 값의 문자열 상한을 넘었습니다.');
    if (node && typeof node === 'object') {
      const keys = Object.keys(node);
      if (keys.length > nodes) throw new Error('조건 값의 항목 수 상한을 넘었습니다.');
      for (const key of keys) {
        characters -= key.length;
        visit((node as Record<string, JsonValue>)[key] ?? null, depth + 1);
      }
    }
  }
  visit(value, 0);
}
function show(value: JsonValue) {
  const preview = previewJson(value);
  const text = preview.text.replaceAll('\n', ' ');
  return text.length > 220 || preview.truncated ? `${text.slice(0, 200)} … (요약)` : text;
}

/** Validate debugger-only references and literals against the source actually being executed or replayed. */
export function compileBreakpoints(
  configuration: ExperimentDefinition,
  settings: BreakpointSettings,
  snapshot?: ExperimentSnapshot,
): ValidationResult<BreakpointPlan> {
  const diagnostics: ModelDiagnostic[] = [];
  const issue = (id: string, message: string) =>
    diagnostics.push({ path: `/breakpoints/${id}`, code: 'breakpoint', message });
  if (settings.points.length > BREAKPOINT_POLICY.points) {
    issue('', '중단점은 최대 20개입니다.');
    return { success: false, diagnostics };
  }
  const active = settings.enabled ? settings.points.filter((item) => item.enabled) : [];
  if (active.length && snapshot && snapshotCompatibility(snapshot))
    issue('version', '지원하지 않는 실행 버전의 중단점은 평가하지 않습니다.');
  const points: CompiledPoint[] = [];
  const ids = new Set<string>();
  for (const point of active) {
    const before = diagnostics.length;
    if (!point.id || ids.has(point.id)) issue(point.id, '중단점 ID가 비어 있거나 중복됩니다.');
    ids.add(point.id);
    if (!point.label.trim() || point.label.length > 80)
      issue(point.id, '중단점 이름을 1~80자로 입력하세요.');
    const reference = configuration.protocols[point.participant];
    const protocol = configuration.definitions.find(
      (item) => item.id === reference.id && item.revision === reference.revision,
    );
    if (!protocol || point.protocolId !== protocol.id) {
      issue(
        point.id,
        `${point.label}: 이 실행의 참여자 프로토콜과 다릅니다. 대상을 다시 고르거나 비활성화하세요.`,
      );
      continue;
    }
    let condition: Condition | undefined;
    if (point.kind === 'state' && !protocol.states.some((item) => item.id === point.targetId))
      issue(point.id, '진입할 상태를 선택하세요.');
    if (point.kind === 'message' && !protocol.messages.some((item) => item.id === point.targetId))
      issue(point.id, '수신할 메시지를 선택하세요.');
    if (point.kind === 'variable') {
      const variable = protocol.variables.find((item) => item.id === point.targetId);
      if (!variable) issue(point.id, '조건 변수를 선택하세요.');
      if (!BREAKPOINT_OPERATORS.includes(point.operator))
        issue(point.id, '비교 연산자를 선택하세요.');
      try {
        if (point.literal.length > BREAKPOINT_POLICY.characters)
          throw new Error('비교 JSON은 최대 8192자입니다.');
        const value = JSON.parse(point.literal) as JsonValue;
        bounded(value);
        const parsed = parseJsonData(value);
        if (!parsed.success) throw new Error('비교 값은 유효한 JSON이어야 합니다.');
        if (
          variable &&
          variable.type !== 'json' &&
          (variable.type === 'integer'
            ? typeof value !== 'number' || !Number.isSafeInteger(value)
            : typeof value !== variable.type)
        )
          throw new Error('비교 값의 타입이 변수와 다릅니다.');
        if (
          variable &&
          !['integer', 'string'].includes(variable.type) &&
          !['eq', 'ne'].includes(point.operator)
        )
          throw new Error('이 변수는 같음/다름 비교를 사용하세요.');
        condition = {
          kind: 'compare',
          operator: point.operator,
          left: { kind: 'variable', variableId: point.targetId },
          right: { kind: 'literal', value },
        };
      } catch (error) {
        issue(point.id, error instanceof Error ? error.message : '비교 JSON을 확인하세요.');
      }
    }
    if (diagnostics.length === before)
      points.push({ point: { ...point, protocolRevision: protocol.revision }, condition });
  }
  return diagnostics.length
    ? { success: false, diagnostics }
    : { success: true, value: freezeOwned({ points }) };
}

/** Match the earliest new observed event; no predicate reads current actor state or future trace. */
export function matchBreakpoints(
  plan: BreakpointPlan,
  events: readonly EventTrace[],
): BreakpointStop | undefined {
  if (!plan.points.length) return;
  for (const [index, event] of events.entries()) {
    if (event.kind !== 'transition' && event.kind !== 'parsed') continue;
    const hits: { id: string; label: string; detail: string }[] = [];
    const data = traceObject(event.data);
    for (const { point, condition } of plan.points) {
      if (point.participant !== event.participant) continue;
      let detail: string | undefined;
      if (
        event.kind === 'parsed' &&
        point.kind === 'message' &&
        traceMessage(event)?.messageId === point.targetId
      )
        detail = `메시지 ${point.targetId.slice(0, 120)} 수신 해석 완료`;
      if (event.kind === 'transition') {
        const before = traceObject(data.before);
        const after = traceObject(data.after);
        if (
          point.kind === 'state' &&
          before.stateId !== after.stateId &&
          after.stateId === point.targetId
        )
          detail = `상태 ${String(before.stateId).slice(0, 100)} → ${point.targetId.slice(0, 100)} 진입`;
        if (point.kind === 'variable' && condition) {
          try {
            const variables = traceObject(after.variables);
            const value = variables[point.targetId];
            if (!Object.hasOwn(variables, point.targetId) || value === undefined)
              throw new Error('이 전이에 조건 변수 값이 없습니다.');
            bounded(value);
            if (evaluateCondition(condition, { variables })) {
              const expected =
                condition.kind === 'compare' && condition.right.kind === 'literal'
                  ? condition.right.value
                  : null;
              detail = `전이 후 ${point.targetId.slice(0, 100)} = ${show(value)} · ${point.operator} ${show(expected)}`;
            }
          } catch (error) {
            return {
              kind: 'evaluation-error',
              event,
              hits: [
                {
                  id: point.id,
                  label: point.label,
                  detail: error instanceof Error ? error.message : '중단점 조건 평가 오류',
                },
              ],
              trailingEvents: events.length - index - 1,
            };
          }
        }
      }
      if (detail) hits.push({ id: point.id, label: point.label, detail });
    }
    if (hits.length)
      return { kind: 'match', event, hits, trailingEvents: events.length - index - 1 };
  }
}
