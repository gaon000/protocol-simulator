import type { JsonValue } from '../domain/execution-contract.ts';
import { serializeBytes } from '../domain/stack-bytes.ts';
import { evaluateStackExpression } from '../domain/stack-expressions.ts';
import {
  type StackCondition,
  type StackExpression,
  type StackMessage,
  type StackProtocol,
  stackProtocolBody,
} from '../domain/stack-model.ts';
import {
  stackObject,
  stackProtocolAt,
  stackRangeBytes,
  stackRecordedBytes,
  stackTarget,
} from '../domain/stack-record.ts';
import { canonicalStackJson } from '../domain/stack-series-model.ts';
import type { SavedStackRun } from '../domain/workspace-v2-model.ts';
import { evaluateValue } from '../engine/expressions.ts';
import { ProtocolRuntime, type RuntimeTrigger } from '../engine/protocol-runtime.ts';
import { previewJson } from './preview-json.ts';
import { projectStackRecord } from './stack-replay.ts';

export const STACK_EXPLANATION_POLICY = {
  operations: 1024,
  characters: 32768,
  depth: 32,
  rows: 20,
} as const;
class Limit extends Error {}

/** Explain native/legacy conditions and sequential assignments using one observed direct trigger and before values. */
export function explainStackExecution(
  record: SavedStackRun,
  eventId: string,
  cursor: number,
  page = 0,
) {
  const projected = projectStackRecord(record, cursor);
  const event = projected.success
    ? projected.value.events.find((e) => e.eventId === eventId && e.kind === 'transition')
    : undefined;
  const unavailable = (message: string) => ({
    status: 'unavailable' as const,
    message,
    candidates: [],
    assignments: [],
    changes: [],
  });
  if (!projected.success)
    return unavailable(projected.diagnostics[0]?.message ?? '읽을 수 없는 기록입니다.');
  if (!event) return unavailable('현재 기록 위치에서 관찰된 전이를 선택하세요.');
  const view = projected.value;
  const protocol = stackProtocolAt(view.snapshot, event.endpoint);
  const body = stackProtocolBody(protocol);
  const data = stackObject(event.data);
  const before = stackObject(data.before);
  const after = stackObject(data.after);
  const trigger = view.events.find((e) => e.eventId === event.sourceEventIds[0]);
  const changes = Object.keys(stackObject(after.variables))
    .filter(
      (id) =>
        canonicalStackJson(stackObject(before.variables)[id]) !==
        canonicalStackJson(stackObject(after.variables)[id]),
    )
    .map((id) => ({
      id,
      before: previewJson(stackObject(before.variables)[id] ?? null),
      after: previewJson(stackObject(after.variables)[id] ?? null),
    }));
  const base = {
    endpoint: event.endpoint,
    eventId,
    ruleId: String(data.ruleId),
    triggerId: trigger?.eventId,
    beforeState: String(before.stateId),
    afterState: String(after.stateId),
    ignored: data.ignored === true,
    changes: changes.slice(0, 20),
    totalChanges: changes.length,
  };
  if (!trigger || stackTarget(trigger.endpoint) !== stackTarget(event.endpoint))
    return {
      ...base,
      status: 'inconsistent' as const,
      message: '직접 trigger가 없거나 다른 인스턴스입니다.',
      candidates: [],
      assignments: [],
    };
  let operations = STACK_EXPLANATION_POLICY.operations as number;
  let characters = STACK_EXPLANATION_POLICY.characters as number;
  function bound(value: JsonValue, depth = 0): void {
    if (--operations < 0 || depth > 32) throw new Limit('설명 계산 한도입니다.');
    if (typeof value === 'string') characters -= value.length;
    if (characters < 0) throw new Limit('설명 값의 크기 한도입니다.');
    if (value && typeof value === 'object')
      for (const [key, part] of Object.entries(value)) {
        characters -= key.length;
        bound(part as JsonValue, depth + 1);
      }
  }
  const candidates: {
    id: string;
    selected: boolean;
    result: boolean;
    conditions: {
      path: string;
      result: 'true' | 'false' | 'skipped';
      left?: ReturnType<typeof previewJson>;
      right?: ReturnType<typeof previewJson>;
    }[];
  }[] = [];
  const assignments: {
    actionIndex: number;
    variableId: string;
    before: ReturnType<typeof previewJson>;
    after: ReturnType<typeof previewJson>;
    expression: ReturnType<typeof previewJson>;
  }[] = [];
  try {
    const hydrate = (values: Record<string, JsonValue>, which: StackProtocol) =>
      Object.fromEntries(
        stackProtocolBody(which).variables.map((v) => [
          v.id,
          v.type === 'bytes'
            ? stackRecordedBytes(values[v.id] as JsonValue, view.artifacts, event.payloads)
            : (values[v.id] as JsonValue),
        ]),
      );
    const variables = hydrate(stackObject(before.variables), protocol);
    bound(variables);
    const td = stackObject(trigger.data);
    const tm = stackObject(td.message);
    const fields = { ...stackObject(tm.values) };
    const schema = body.messages.find((m) => m.id === tm.messageId);
    for (const field of schema?.fields ?? [])
      if (field.type === 'bytes' && fields[field.id] !== undefined)
        fields[field.id] = stackRecordedBytes(
          fields[field.id] as JsonValue,
          view.artifacts,
          trigger.payloads,
        );
    const rawPayload = stackObject(td.payload);
    let payload: JsonValue | undefined;
    if (rawPayload.kind === 'bytes')
      payload = serializeBytes(
        stackRangeBytes(
          view.artifacts,
          stackObject(
            rawPayload.range,
          ) as unknown as import('../domain/stack-model.ts').PayloadRange,
          trigger.payloads,
        ),
      );
    if (rawPayload.kind === 'packet') {
      const packet = stackObject(rawPayload.packet);
      const values = { ...stackObject(packet.fields) };
      for (const [id, value] of Object.entries(values))
        if (stackObject(value).kind === 'payload-range')
          values[id] = stackRecordedBytes(value, view.artifacts, trigger.payloads);
      payload = { messageId: packet.messageId ?? '', fields: values };
    }
    bound(fields);
    if (payload !== undefined) bound(payload);
    const recordedTrigger = data.trigger as unknown as RuntimeTrigger['event'];
    const validTrigger =
      recordedTrigger.kind === 'input'
        ? trigger.kind === 'input' && tm.messageId === recordedTrigger.messageId
        : recordedTrigger.kind === 'receive'
          ? trigger.kind === 'parsed' && tm.messageId === recordedTrigger.messageId
          : recordedTrigger.kind === 'timer'
            ? trigger.kind === 'timer' &&
              td.operation === 'expire' &&
              td.timerId === recordedTrigger.timerId
            : recordedTrigger.kind === 'connection'
              ? trigger.kind === 'connection' && td.state === recordedTrigger.state
              : 'operation' in recordedTrigger &&
                trigger.portId === recordedTrigger.portId &&
                ((trigger.kind === 'service-received' &&
                  td.operation === recordedTrigger.operation) ||
                  (recordedTrigger.kind === 'service-indication' &&
                    trigger.kind === 'connection' &&
                    td.state === recordedTrigger.operation));
    if (!validTrigger) throw new Error('기록한 trigger와 실제 직접 관찰이 다릅니다.');
    const runtimeTrigger: RuntimeTrigger = {
      event: recordedTrigger,
      ...(typeof tm.messageId === 'string'
        ? { message: { messageId: tm.messageId, values: fields } as StackMessage }
        : {}),
      ...(payload === undefined ? {} : { payload }),
    };
    const value = (expression: StackExpression, current: Readonly<Record<string, JsonValue>>) => {
      if (--operations < 0) throw new Limit('설명 연산 한도입니다.');
      if (protocol.mode === 'legacy-application')
        return evaluateValue(expression as import('../domain/protocol-model.ts').ValueExpression, {
          variables: current,
          ...(runtimeTrigger.message
            ? {
                message:
                  runtimeTrigger.message as import('../domain/protocol-model.ts').ProtocolMessage,
              }
            : {}),
        });
      const result = evaluateStackExpression(
        expression,
        {
          variables: current,
          fields,
          ...(payload === undefined ? {} : { servicePayload: payload }),
        },
        view.snapshot.configuration.limits.maxMessageBytes,
      );
      if (!result.success) throw new Error(result.diagnostics[0]?.message);
      return result.value;
    };
    for (const rule of body.rules) {
      if (
        rule.fromStateId !== before.stateId ||
        canonicalStackJson(rule.event) !== canonicalStackJson(recordedTrigger)
      )
        continue;
      const conditions: (typeof candidates)[number]['conditions'] = [];
      const inspect = (condition: StackCondition, path: string, skip = false): boolean => {
        if (--operations < 0) throw new Limit('설명 분기 한도입니다.');
        if (skip) {
          conditions.push({ path, result: 'skipped' });
          if (condition.kind === 'all' || condition.kind === 'any')
            condition.conditions.forEach((c, i) => {
              inspect(c, `${path}/${i}`, true);
            });
          else if (condition.kind === 'not') inspect(condition.condition, `${path}/not`, true);
          return false;
        }
        if (condition.kind === 'compare') {
          const left = value(condition.left, variables);
          const right = value(condition.right, variables);
          const compare = () => {
            if (condition.operator === 'eq')
              return canonicalStackJson(left) === canonicalStackJson(right);
            if (condition.operator === 'ne')
              return canonicalStackJson(left) !== canonicalStackJson(right);
            if (
              !(
                (typeof left === 'number' && typeof right === 'number') ||
                (typeof left === 'string' && typeof right === 'string')
              )
            )
              throw new Error('비교 타입이 다릅니다.');
            switch (condition.operator) {
              case 'lt':
                return left < right;
              case 'lte':
                return left <= right;
              case 'gt':
                return left > right;
              case 'gte':
                return left >= right;
            }
          };
          const result = compare();
          conditions.push({
            path,
            result: result ? 'true' : 'false',
            left: previewJson(left),
            right: previewJson(right),
          });
          return result;
        }
        if (condition.kind === 'not') {
          const result = !inspect(condition.condition, `${path}/not`);
          conditions.push({ path, result: result ? 'true' : 'false' });
          return result;
        }
        let result = condition.kind === 'all';
        for (const [index, child] of condition.conditions.entries()) {
          const skipped = condition.kind === 'all' ? !result : result;
          const next = inspect(child, `${path}/${index}`, skipped);
          if (!skipped) result = next;
        }
        conditions.push({ path, result: result ? 'true' : 'false' });
        return result;
      };
      candidates.push({
        id: rule.id,
        selected: rule.id === data.ruleId,
        result: rule.condition ? inspect(rule.condition, rule.id) : true,
        conditions,
      });
    }
    const rule = body.rules.find((r) => r.id === data.ruleId);
    if (
      !rule ||
      candidates.filter((c) => c.result).length !== 1 ||
      !candidates.some((c) => c.selected && c.result)
    )
      throw new Error('선택 규칙/조건이 관찰 결과와 다릅니다.');
    const current = { ...variables };
    for (const [index, action] of rule.actions.entries())
      if (action.kind === 'assign') {
        const result = value(action.value, current);
        bound(result);
        assignments.push({
          actionIndex: index,
          variableId: action.variableId,
          before: previewJson(current[action.variableId] ?? null),
          after: previewJson(result),
          expression: previewJson(action.value as JsonValue),
        });
        current[action.variableId] = result;
      }
    const previous = projectStackRecord(record, view.events.indexOf(trigger));
    if (!previous.success) throw new Error('전이 이전 인스턴스를 복원하지 못했습니다.');
    const observed = previous.value.instances[stackTarget(event.endpoint)];
    if (!observed) throw new Error('인스턴스가 없습니다.');
    const runtime = new ProtocolRuntime(
      protocol,
      event.endpoint,
      view.snapshot.configuration.limits,
    );
    runtime.stateId = String(before.stateId);
    runtime.variables = variables;
    runtime.outcome = observed.outcome;
    runtime.finishedAt = observed.finishedAt;
    runtime.requires = observed.ports.requires;
    runtime.provides = observed.ports.provides;
    runtime.timers = new Map(
      observed.timers.map(({ timerId, ...timer }) => [
        timerId,
        {
          ...timer,
          active:
            recordedTrigger.kind === 'timer' && timerId === recordedTrigger.timerId
              ? false
              : timer.active,
        },
      ]),
    );
    const prepared = runtime.prepare(runtimeTrigger, event.timeMs);
    const afterVariables = hydrate(stackObject(after.variables), protocol);
    if (
      prepared.ruleId !== data.ruleId ||
      prepared.stateId !== after.stateId ||
      prepared.outcome !== data.outcome ||
      canonicalStackJson(prepared.variables) !== canonicalStackJson(afterVariables) ||
      canonicalStackJson(current) !== canonicalStackJson(afterVariables)
    )
      throw new Error('재구성한 계산과 관찰된 commit이 다릅니다.');
    const selectedPage = Number.isSafeInteger(page) ? Math.max(0, page) : 0;
    return {
      ...base,
      status: 'verified' as const,
      message: '직접 trigger·당시 before 값의 계산을 실제 commit과 대조했습니다.',
      candidates: candidates.slice(selectedPage * 20, selectedPage * 20 + 20),
      totalCandidates: candidates.length,
      assignments: assignments.slice(selectedPage * 20, selectedPage * 20 + 20),
      totalAssignments: assignments.length,
    };
  } catch (error) {
    return {
      ...base,
      status: error instanceof Limit ? ('limited' as const) : ('inconsistent' as const),
      message: String(error),
      candidates: candidates.slice(0, 20),
      assignments: assignments.slice(0, 20),
    };
  }
}
