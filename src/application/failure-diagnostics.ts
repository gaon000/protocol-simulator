import type { JsonValue } from '../domain/execution-contract.ts';
import { validateProtocolMessage } from '../domain/model-validation.ts';
import type { EngineView, EventTrace } from '../domain/protocol-model.ts';
import { snapshotCompatibility } from '../domain/workspace-validation.ts';
import { equalJson } from '../engine/expressions.ts';
import { previewJson } from './preview-json.ts';
import { sequenceProtocol, traceObject } from './sequence-diagram.ts';

export const DIAGNOSIS_POLICY = {
  events: 10_000,
  valueNodes: 4096,
  valueCharacters: 32768,
  trailSize: 64,
  pageSize: 20,
} as const;
export type ExpectationDiagnosis = {
  readonly status: 'verified' | 'incomplete' | 'limited' | 'inconsistent' | 'unavailable';
  readonly recorded: 'pass' | 'fail' | 'undetermined';
  readonly expected: string;
  readonly actual: string;
  readonly message: string;
  readonly evidence: readonly EventTrace[];
  readonly context: readonly EventTrace[];
};
class DiagnosisLimit extends Error {}
function show(value: JsonValue) {
  const preview = previewJson(value);
  const text = preview.text.replaceAll('\n', ' ');
  return text.length > 500 || preview.truncated ? `${text.slice(0, 480)} … (값 요약)` : text;
}
function messageOf(event: EventTrace) {
  return traceObject(traceObject(event.data).message);
}

/** Compare one frozen expectation with observed values; never read outside the supplied prefix. */
export function diagnoseExpectation(
  source: EngineView,
  id: string,
  eventCount = source.events.length,
): ExpectationDiagnosis {
  const run = {
    ...source,
    events: source.events.slice(
      0,
      Math.max(0, Math.min(source.events.length, Math.floor(eventCount))),
    ),
  };
  const expectation = run.snapshot.configuration.scenario.expectations.find(
    (item) => item.id === id,
  );
  const recorded = run.expectations.find((item) => item.expectationId === id)?.status;
  const prefixTruncated = run.events.length < source.events.length;
  let result: ExpectationDiagnosis = {
    status: 'unavailable',
    recorded: prefixTruncated ? 'undetermined' : (recorded ?? 'undetermined'),
    expected: '',
    actual: '',
    message: '현재 관찰에 기대 조건이나 저장 판정이 없습니다.',
    evidence: [],
    context: [],
  };
  if (!expectation || !recorded) return result;
  const unsupported = snapshotCompatibility(run.snapshot);
  if (unsupported)
    return { ...result, message: '지원하지 않는 실행 버전이므로 진단을 재구성하지 않습니다.' };
  if (run.events.length > DIAGNOSIS_POLICY.events)
    return { ...result, status: 'limited', message: '진단 이벤트 상한을 넘었습니다.' };
  const protocol = sequenceProtocol(run, expectation.participant);
  if (!protocol) return result;
  let actor = run.participants[expectation.participant];
  const own = run.events.filter((event) => event.participant === expectation.participant);
  if (prefixTruncated) {
    const terminal = protocol.states.find((item) => item.id === protocol.initialStateId)?.terminal;
    actor = {
      ...actor,
      stateId: protocol.initialStateId,
      outcome: terminal ? 'success' : 'active',
      finishedAt: terminal ? 0 : null,
    };
    for (const event of own) {
      const data = traceObject(event.data);
      if (event.kind === 'transition') {
        actor = {
          ...actor,
          stateId: String(traceObject(data.after).stateId),
          outcome: data.outcome as typeof actor.outcome,
        };
        if (actor.outcome !== 'active')
          actor = { ...actor, finishedAt: actor.finishedAt ?? event.timeMs };
      } else if (event.kind === 'diagnostic')
        actor = { ...actor, outcome: 'error', finishedAt: actor.finishedAt ?? event.timeMs };
    }
  }
  const transitions = own.filter((event) => event.kind === 'transition');
  const deliveries = own.filter((event) => event.kind === 'deliver');
  const context = run.events.filter(
    (event) =>
      event.kind === 'environment' ||
      (event.participant === expectation.participant &&
        (event.kind === 'diagnostic' ||
          event.kind === 'connection' ||
          (event.kind === 'timer' && traceObject(event.data).operation === 'expire'))),
  );
  const last = transitions.at(-1);
  if (last) context.push(last);
  result = { ...result, context };
  let nodes = DIAGNOSIS_POLICY.valueNodes as number;
  let characters = DIAGNOSIS_POLICY.valueCharacters as number;
  function spend(value: JsonValue, depth = 0): void {
    if (--nodes < 0 || depth > 32) throw new DiagnosisLimit();
    if (typeof value === 'string') characters -= value.length;
    if (characters < 0) throw new DiagnosisLimit();
    if (value && typeof value === 'object')
      for (const [key, child] of Object.entries(value)) {
        characters -= key.length;
        spend(child, depth + 1);
      }
  }
  let passed = false;
  try {
    switch (expectation.kind) {
      case 'state':
        result = {
          ...result,
          expected: `상태 ${expectation.stateId.slice(0, 160)}`,
          actual: `현재 상태 ${actor.stateId.slice(0, 160)}`,
          evidence: last ? [last] : [],
        };
        passed = actor.stateId === expectation.stateId;
        break;
      case 'delivery-count': {
        const matching = deliveries.filter(
          (event) => messageOf(event).messageId === expectation.messageId,
        );
        result = {
          ...result,
          expected: `${expectation.messageId.slice(0, 160)} 상위 전달 ${expectation.count}회`,
          actual: `관찰한 상위 전달 ${matching.length}회`,
          evidence: matching,
        };
        passed = matching.length === expectation.count;
        break;
      }
      case 'delivered-values': {
        result = {
          ...result,
          expected: show(expectation.message),
          actual: '전달 값 비교를 완료하지 못했습니다.',
        };
        const matching = deliveries.filter(
          (event) => messageOf(event).messageId === expectation.message.messageId,
        );
        result = { ...result, evidence: matching };
        spend(expectation.message);
        const definition = protocol.messages.find(
          (item) => item.id === expectation.message.messageId,
        );
        for (const field of definition?.fields ?? []) {
          spend(field.id);
          if (field.defaultValue !== undefined) spend(field.defaultValue);
        }
        const checked = validateProtocolMessage(protocol, expectation.message);
        if (!checked.success)
          return { ...result, message: '실행 당시 정의로 기대 메시지를 확인할 수 없습니다.' };
        result = { ...result, expected: show(checked.value) };
        let matchingCount = 0;
        for (const event of matching) {
          const message = messageOf(event);
          spend(message);
          if (equalJson(message, checked.value)) matchingCount++;
        }
        result = {
          ...result,
          actual: `같은 메시지 ${matching.length}회 중 기대 값과 일치 ${matchingCount}회. ${matching[0] ? `첫 관찰: ${show(messageOf(matching[0]))}` : '해당 메시지의 상위 전달이 관찰되지 않았습니다.'}`,
        };
        passed = matchingCount > 0;
        break;
      }
      case 'completion-before':
        result = {
          ...result,
          expected: `${expectation.timeMs} ms 이내 성공 완료`,
          actual: `결과 ${actor.outcome} · 최초 종료 ${actor.finishedAt === null ? '없음' : `${actor.finishedAt} ms`}`,
          evidence: transitions.filter((event) => traceObject(event.data).outcome !== 'active'),
        };
        passed =
          actor.outcome === 'success' &&
          actor.finishedAt !== null &&
          actor.finishedAt <= expectation.timeMs;
        break;
    }
  } catch (error) {
    return {
      ...result,
      status: error instanceof DiagnosisLimit ? 'limited' : 'unavailable',
      message:
        error instanceof DiagnosisLimit
          ? '값 비교 상한에 도달했습니다. 요약과 관련 기록만 표시합니다.'
          : '관찰 값으로 진단을 재구성하지 못했습니다.',
    };
  }
  if (prefixTruncated || run.status !== 'completed' || actor.outcome === 'error')
    return {
      ...result,
      status: 'incomplete',
      message: `관찰 미완료 또는 참여자 오류입니다 (${run.status} / ${actor.outcome}). 현재까지의 값이며 실패 원인을 확정하지 않습니다.`,
    };
  const after = traceObject(traceObject(last?.data).after);
  const expectedState = last ? after.stateId : protocol.initialStateId;
  const outcome = last
    ? traceObject(last.data).outcome
    : protocol.states.find((item) => item.id === protocol.initialStateId)?.terminal
      ? 'success'
      : 'active';
  const finishedAt = protocol.states.find((item) => item.id === protocol.initialStateId)?.terminal
    ? 0
    : (transitions.find((item) => traceObject(item.data).outcome !== 'active')?.timeMs ?? null);
  if (
    run.timeMs !== run.snapshot.configuration.scenario.observationMs ||
    run.events.some((event, index) => event.sequence !== index) ||
    expectedState !== actor.stateId ||
    outcome !== actor.outcome ||
    finishedAt !== actor.finishedAt ||
    recorded !== (passed ? 'pass' : 'fail')
  )
    return {
      ...result,
      status: 'inconsistent',
      message:
        '재구성한 관찰과 저장 판정/상태가 다릅니다. 이 진단을 확정된 원인으로 사용하지 마세요.',
    };
  return {
    ...result,
    status: 'verified',
    message: passed
      ? '관찰 값이 기대 조건을 충족하며 저장 판정과 일치합니다.'
      : '관찰 값이 기대 조건을 충족하지 않으며 저장 판정과 일치합니다. 관련 기록은 관찰 근거이며 유일한 근본 원인을 증명하지 않습니다.',
  };
}

export type DiagnosisTrail = {
  readonly items: readonly { readonly event: EventTrace; readonly relation: string }[];
  readonly limited: boolean;
  readonly missing: boolean;
};
/** Follow explicit causes, merged-read sources and recorded timer identity within this prefix only. */
export function diagnosisTrail(
  source: EngineView,
  eventId: string,
  eventCount = source.events.length,
): DiagnosisTrail {
  const run = {
    ...source,
    events: source.events.slice(
      0,
      Math.max(0, Math.min(source.events.length, Math.floor(eventCount))),
    ),
  };
  if (run.events.length > DIAGNOSIS_POLICY.events)
    return { items: [], limited: true, missing: false };
  const events = new Map(run.events.map((event, index) => [event.eventId, { event, index }]));
  const pending = [{ id: eventId, relation: '선택 근거', before: run.events.length }];
  const visited = new Set<string>();
  const items: { event: EventTrace; relation: string }[] = [];
  let missing = false;
  let truncated = false;
  while (pending.length && items.length < DIAGNOSIS_POLICY.trailSize) {
    const next = pending.shift();
    if (!next) continue;
    const entry = events.get(next.id);
    if (!entry || entry.index >= next.before) {
      missing = true;
      continue;
    }
    if (visited.has(next.id)) continue;
    visited.add(next.id);
    const { event, index } = entry;
    items.push({ event, relation: next.relation });
    if (event.causeEventId)
      pending.push({
        id: event.causeEventId,
        relation: `${event.eventId}의 직접 원인`,
        before: index,
      });
    const data = traceObject(event.data);
    if (event.kind === 'receive' && Array.isArray(data.sourceEventIds)) {
      truncated ||= data.sourceEventIds.length > DIAGNOSIS_POLICY.trailSize;
      for (const id of data.sourceEventIds.slice(0, DIAGNOSIS_POLICY.trailSize))
        if (typeof id === 'string')
          pending.push({ id, relation: `${event.eventId}에 합쳐진 송신`, before: index });
    }
    if (event.kind === 'timer' && data.operation === 'expire') {
      const start = run.events
        .slice(0, index)
        .findLast(
          (item) =>
            item.kind === 'timer' &&
            item.participant === event.participant &&
            traceObject(item.data).operation === 'start' &&
            traceObject(item.data).timerId === data.timerId &&
            traceObject(item.data).generation === data.generation,
        );
      if (start)
        pending.push({
          id: start.eventId,
          relation: `${event.eventId}와 같은 타이머 세대의 시작`,
          before: index,
        });
      else missing = true;
    }
  }
  return { items, limited: truncated || pending.length > 0, missing };
}

/** Summarize event metadata without decoding or copying payload bytes. */
export function diagnosisEventLabel(event: EventTrace): string {
  const data = traceObject(event.data);
  const detail =
    event.kind === 'transition'
      ? `${traceObject(data.before).stateId} → ${traceObject(data.after).stateId}`
      : event.kind === 'timer'
        ? `${data.timerId} ${data.operation}`
        : event.kind === 'diagnostic'
          ? String(data.code)
          : event.kind === 'environment'
            ? String(data.outcome ?? data.kind ?? '')
            : String(messageOf(event).messageId ?? data.state ?? '');
  return `${event.eventId} · ${event.timeMs} ms · ${event.participant} · ${event.kind} ${detail.slice(0, 160)}`;
}
