import type { JsonValue } from '../domain/execution-contract.ts';
import type {
  Condition,
  EngineView,
  EventTrace,
  ProtocolMessage,
  RuleEvent,
  ValueExpression,
} from '../domain/protocol-model.ts';
import { snapshotCompatibility } from '../domain/workspace-validation.ts';
import {
  type EvaluationContext,
  equalJson,
  evaluateCondition,
  evaluateValue,
} from '../engine/expressions.ts';
import type { DiagramLinks } from './diagram-links.ts';
import { previewJson } from './preview-json.ts';
import { sequenceProtocol, traceObject } from './sequence-diagram.ts';

export const EXPLANATION_POLICY = {
  operations: 1024,
  valueNodes: 4096,
  valueCharacters: 32768,
  depth: 32,
  pageSize: 20,
} as const;
export type ConditionReason = {
  readonly path: string;
  readonly result: 'true' | 'false' | 'skipped';
  readonly detail: string;
};
export type RuleReason = {
  readonly id: string;
  readonly selected: boolean;
  readonly result: boolean;
  readonly conditions: readonly ConditionReason[];
};
export type AssignmentReason = {
  readonly actionIndex: number;
  readonly variableId: string;
  readonly before: string;
  readonly expression: string;
  readonly value: string;
};
export type VariableReason = {
  readonly id: string;
  readonly before: string;
  readonly after: string;
  readonly assignments: readonly number[];
};
export type ExecutionExplanation = {
  readonly status: 'verified' | 'limited' | 'inconsistent' | 'unavailable';
  readonly message: string;
  readonly transitionId: string;
  readonly triggerId: string | undefined;
  readonly triggerLabel: string;
  readonly participant: 'A' | 'B';
  readonly ruleId: string;
  readonly beforeState: string;
  readonly afterState: string;
  readonly ignored: boolean;
  readonly candidates: readonly RuleReason[];
  readonly assignments: readonly AssignmentReason[];
  readonly changes: readonly VariableReason[];
  readonly actionCount: number;
};
class ExplanationLimit extends Error {}
function short(value: string) {
  return value.length > 360 ? `${value.slice(0, 360)}…` : value;
}
function show(value: JsonValue) {
  const preview = previewJson(value);
  const text = preview.text.replaceAll('\n', ' ');
  return preview.truncated || text.length > 360 ? `${text.slice(0, 340)} … (값 요약)` : text;
}
function reference(expression: ValueExpression, depth = 0): string {
  if (depth > 3) return '…';
  if (expression.kind === 'literal') return '상수';
  if (expression.kind === 'variable') return `변수 ${short(expression.variableId)}`;
  if (expression.kind === 'field') return `필드 ${short(expression.fieldId)}`;
  return short(
    `(${reference(expression.left, depth + 1)} ${expression.kind === 'add' ? '+' : '−'} ${reference(expression.right, depth + 1)})`,
  );
}
function skippedCondition(condition: Condition): string {
  if (condition.kind !== 'compare') return condition.kind.toUpperCase();
  return short(`${reference(condition.left)} ${condition.operator} ${reference(condition.right)}`);
}
function ruleEvent(trigger: EventTrace): RuleEvent | undefined {
  const data = traceObject(trigger.data);
  if (trigger.kind === 'input' || trigger.kind === 'parsed') {
    const message = traceObject(data.message);
    if (typeof message.messageId === 'string')
      return { kind: trigger.kind === 'input' ? 'input' : 'receive', messageId: message.messageId };
  }
  if (trigger.kind === 'timer' && data.operation === 'expire' && typeof data.timerId === 'string')
    return { kind: 'timer', timerId: data.timerId };
  if (trigger.kind === 'connection' && (data.state === 'closed' || data.state === 'failed'))
    return { kind: 'connection', state: data.state };
  return undefined;
}

/** Reconstruct bounded guard/assignment calculations from an observed commit and verify its recorded state. */
export function explainExecution(
  run: EngineView,
  links: DiagramLinks,
  transitionId: string,
): ExecutionExplanation {
  const transition = links.events.get(transitionId);
  const data = traceObject(transition?.data);
  const before = traceObject(data.before);
  const after = traceObject(data.after);
  const explanation = {
    transitionId,
    triggerId: transition?.causeEventId,
    triggerLabel: '',
    participant: transition?.participant ?? 'A',
    ruleId: transition?.ruleId ?? '',
    beforeState: String(before.stateId ?? ''),
    afterState: String(after.stateId ?? ''),
    ignored: data.ignored === true,
    candidates: [] as RuleReason[],
    assignments: [] as AssignmentReason[],
    changes: [] as VariableReason[],
    actionCount: 0,
  };
  const result = (
    status: ExecutionExplanation['status'],
    message: string,
  ): ExecutionExplanation => ({ ...explanation, status, message });
  if (transition?.kind !== 'transition')
    return result('unavailable', '현재 관찰 위치에 상태 전이 기록이 없습니다.');
  const unsupported = snapshotCompatibility(run.snapshot);
  if (unsupported) return result('unavailable', unsupported);
  const protocol = sequenceProtocol(run, transition.participant);
  const selected = protocol?.rules.find((rule) => rule.id === transition.ruleId);
  const trigger = links.events.get(transition.causeEventId ?? '');
  const event = trigger && ruleEvent(trigger);
  if (
    !protocol ||
    !selected ||
    !trigger ||
    trigger.participant !== transition.participant ||
    !event ||
    trigger.sequence >= transition.sequence
  )
    return result(
      'unavailable',
      '실행 당시 규칙과 같은 참여자의 직접 발생 이벤트를 확인할 수 없습니다.',
    );
  explanation.actionCount = selected.actions.length;
  explanation.triggerLabel =
    event.kind === 'input'
      ? `입력 ${short(event.messageId)}`
      : event.kind === 'receive'
        ? `메시지 수신 ${short(event.messageId)}`
        : event.kind === 'timer'
          ? `타이머 ${short(event.timerId)} 만료`
          : event.kind === 'connection'
            ? `연결 ${event.state}`
            : '';
  if (selected.fromStateId !== before.stateId || !equalJson(selected.event, event))
    return result('inconsistent', '기록의 출발 상태·이벤트와 snapshot 규칙이 다릅니다.');
  const beforeVariables = traceObject(before.variables);
  const afterVariables = traceObject(after.variables);
  let operations: number = EXPLANATION_POLICY.operations;
  let nodes: number = EXPLANATION_POLICY.valueNodes;
  let characters: number = EXPLANATION_POLICY.valueCharacters;
  function tick(depth = 0) {
    if (--operations < 0 || depth > EXPLANATION_POLICY.depth) throw new ExplanationLimit();
  }
  function inspect(value: JsonValue, depth = 0) {
    if (--nodes < 0 || depth > EXPLANATION_POLICY.depth) throw new ExplanationLimit();
    if (typeof value === 'string') characters -= value.length;
    if (characters < 0) throw new ExplanationLimit();
    if (Array.isArray(value)) {
      for (const item of value) inspect(item, depth + 1);
    } else if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) {
        characters -= key.length;
        inspect(item, depth + 1);
      }
  }
  function value(
    expression: ValueExpression,
    context: EvaluationContext,
    depth = 0,
  ): { value: JsonValue; text: string } {
    tick(depth);
    if (expression.kind === 'add' || expression.kind === 'subtract') {
      const left = value(expression.left, context, depth + 1);
      const right = value(expression.right, context, depth + 1);
      const evaluated = evaluateValue(
        {
          kind: expression.kind,
          left: { kind: 'literal', value: left.value },
          right: { kind: 'literal', value: right.value },
        },
        context,
      );
      return {
        value: evaluated,
        text: short(
          `(${left.text} ${expression.kind === 'add' ? '+' : '−'} ${right.text}) = ${show(evaluated)}`,
        ),
      };
    }
    if (
      expression.kind !== 'literal' &&
      expression.kind !== 'variable' &&
      expression.kind !== 'field'
    )
      throw new Error('Unsupported value expression');
    const raw =
      expression.kind === 'literal'
        ? expression.value
        : expression.kind === 'variable'
          ? context.variables[expression.variableId]
          : context.message?.values[expression.fieldId];
    if (raw !== undefined) inspect(raw, depth);
    const evaluated = evaluateValue(expression, context);
    return {
      value: evaluated,
      text: short(
        expression.kind === 'literal'
          ? `상수 ${show(evaluated)}`
          : `${expression.kind === 'variable' ? `변수 ${expression.variableId}` : `필드 ${expression.fieldId}`}(${show(evaluated)})`,
      ),
    };
  }
  function guard(
    condition: Condition,
    context: EvaluationContext,
    rows: ConditionReason[],
    path = '조건',
    depth = 0,
  ): boolean {
    tick(depth);
    const position = rows.length;
    rows.push({ path, result: 'false', detail: '' });
    let passed: boolean;
    let detail: string;
    if (condition.kind === 'not') {
      passed = !guard(condition.condition, context, rows, `${path}.1`, depth + 1);
      detail = 'NOT · 자식 결과를 반전';
    } else if (condition.kind === 'all' || condition.kind === 'any') {
      passed = condition.kind === 'all';
      let done = false;
      for (let index = 0; index < condition.conditions.length; index++) {
        const child = condition.conditions[index];
        if (!child) continue;
        if (done) {
          tick(depth + 1);
          rows.push({
            path: `${path}.${index + 1}`,
            result: 'skipped',
            detail: `${skippedCondition(child)} · ${condition.kind === 'all' ? '앞 조건이 거짓' : '앞 조건이 참'}이므로 이 분기는 평가하지 않음`,
          });
        } else {
          passed = guard(child, context, rows, `${path}.${index + 1}`, depth + 1);
          done = condition.kind === 'all' ? !passed : passed;
        }
      }
      detail =
        condition.kind === 'all'
          ? 'AND · 모든 조건이 참이어야 함'
          : 'OR · 하나 이상의 조건이 참이어야 함';
    } else if (condition.kind === 'compare') {
      const left = value(condition.left, context, depth + 1);
      const right = value(condition.right, context, depth + 1);
      passed = evaluateCondition(
        {
          ...condition,
          left: { kind: 'literal', value: left.value },
          right: { kind: 'literal', value: right.value },
        },
        context,
      );
      const operator = { eq: '=', ne: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥' }[
        condition.operator
      ];
      detail = short(`${left.text} ${operator} ${right.text}`);
    } else throw new Error('Unsupported condition');
    rows[position] = { path, result: passed ? 'true' : 'false', detail };
    return passed;
  }
  try {
    const message =
      trigger.kind === 'input' || trigger.kind === 'parsed'
        ? (traceObject(trigger.data).message as ProtocolMessage)
        : undefined;
    const context: EvaluationContext = {
      variables: beforeVariables,
      ...(message ? { message } : {}),
    };
    for (const rule of protocol.rules) {
      tick();
      if (rule.fromStateId !== before.stateId || !equalJson(rule.event, event)) continue;
      const rows: ConditionReason[] = [];
      const passed = rule.condition ? guard(rule.condition, context, rows) : true;
      if (!rule.condition)
        rows.push({
          path: '조건',
          result: 'true',
          detail: '조건 없음 · 상태와 발생 이벤트가 일치',
        });
      explanation.candidates.push({
        id: rule.id,
        selected: rule.id === selected.id,
        result: passed,
        conditions: rows,
      });
    }
    const matches = explanation.candidates.filter((candidate) => candidate.result);
    if (matches.length !== 1 || matches[0]?.id !== selected.id)
      return result('inconsistent', '조건 계산의 유일한 일치 규칙과 기록된 선택 규칙이 다릅니다.');
    const variables: Record<string, JsonValue> = { ...beforeVariables };
    const stagedContext = { ...context, variables };
    for (let index = 0; index < selected.actions.length; index++) {
      tick();
      const action = selected.actions[index];
      if (action?.kind !== 'assign') continue;
      const previous = variables[action.variableId];
      if (previous === undefined)
        return result('inconsistent', '대입 대상 변수가 실행 전 기록에 없습니다.');
      inspect(previous);
      const evaluated = value(action.value, stagedContext);
      explanation.assignments.push({
        actionIndex: index,
        variableId: action.variableId,
        before: show(previous),
        expression: evaluated.text,
        value: show(evaluated.value),
      });
      variables[action.variableId] = evaluated.value;
    }
    inspect(variables);
    inspect(afterVariables);
    const stateMatches =
      after.stateId === selected.nextStateId && data.ignored === (selected.ignore === true);
    const variablesMatch = equalJson(variables, afterVariables);
    for (const id of new Set([...Object.keys(beforeVariables), ...Object.keys(afterVariables)])) {
      tick();
      const old = beforeVariables[id];
      const next = afterVariables[id];
      if (old === undefined || next === undefined)
        return result('inconsistent', '기록 전후 변수 목록이 다릅니다.');
      if (equalJson(old, next)) continue;
      explanation.changes.push({
        id,
        before: show(old),
        after: show(next),
        assignments: explanation.assignments
          .filter((assignment) => assignment.variableId === id)
          .map((assignment) => assignment.actionIndex),
      });
    }
    return stateMatches && variablesMatch
      ? result('verified', '조건·순차 대입 계산이 기록된 선택 규칙과 전후 상태·변수에 일치합니다.')
      : result(
          'inconsistent',
          '계산한 최종 상태·변수가 실제 전이 기록과 다릅니다. 아래 계산을 적용 완료로 해석하지 마세요.',
        );
  } catch (error) {
    return error instanceof ExplanationLimit
      ? result(
          'limited',
          '값 크기·연산 상한으로 설명 계산을 중단했습니다. 일부 계산만 표시하며 적용 완료는 전이 원본에서 확인하세요.',
        )
      : result(
          'inconsistent',
          `설명 재구성 중 평가 오류: ${short(error instanceof Error ? error.message : String(error))}`,
        );
  }
}
