import { stackProtocolBody } from '../domain/stack-model.ts';
import { validateStackMessage } from '../domain/stack-protocol-validation.ts';
import {
  stackObject,
  stackProtocolAt,
  stackRecordedBytes,
  stackTarget,
} from '../domain/stack-record.ts';
import { canonicalStackJson } from '../domain/stack-series-model.ts';
import type { SavedStackRun } from '../domain/workspace-v2-model.ts';
import { previewJson } from './preview-json.ts';
import { projectStackRecord, stackCursor } from './stack-replay.ts';

/** Diagnose against saved expectations and actual prefix observations, separating direct evidence from context. */
export function diagnoseStackExpectation(
  record: SavedStackRun,
  expectationId: string,
  cursor: number,
) {
  const projected = projectStackRecord(record, cursor);
  if (!projected.success) return projected;
  const view = projected.value;
  const expected = view.snapshot.configuration.scenario.expectations.find(
    (e) => e.id === expectationId,
  );
  if (!expected)
    return {
      success: false as const,
      diagnostics: [
        {
          path: '/expectationId',
          code: 'stack-expectation',
          message: '당시 snapshot에 없는 기대 조건입니다.',
        },
      ],
    };
  const target = stackTarget(expected.target);
  const actor = view.instances[target];
  const indexed = view.events.map((event, index) => ({ event, cursor: index + 1 }));
  const local = indexed.filter(({ event }) => stackTarget(event.endpoint) === target);
  const deliveries = local.filter(({ event }) => event.kind === 'deliver');
  let evidence = local.filter(({ event }) => event.kind === 'transition').slice(-1);
  let observed: unknown = actor?.stateId;
  let satisfied = expected.kind === 'state' && actor?.stateId === expected.stateId;
  if (expected.kind === 'delivery-count') {
    evidence = deliveries.filter(
      ({ event }) => stackObject(stackObject(event.data).message).messageId === expected.messageId,
    );
    observed = evidence.length;
    satisfied = observed === expected.count;
  } else if (expected.kind === 'delivered-values') {
    const protocol = stackProtocolAt(view.snapshot, expected.target);
    const normalized = validateStackMessage(stackProtocolBody(protocol), expected.message);
    evidence = deliveries.filter(({ event }) => {
      const message = stackObject(stackObject(event.data).message);
      const values = { ...stackObject(message.values) };
      for (const field of stackProtocolBody(protocol).messages.find(
        (m) => m.id === message.messageId,
      )?.fields ?? [])
        if (field.type === 'bytes') {
          const value = values[field.id];
          if (value !== undefined)
            values[field.id] = stackRecordedBytes(value, view.artifacts, event.payloads);
        }
      return (
        normalized.success &&
        canonicalStackJson({ messageId: message.messageId, values }) ===
          canonicalStackJson(normalized.value)
      );
    });
    observed = evidence.length ? expected.message : null;
    satisfied = evidence.length > 0;
  } else if (expected.kind === 'completion-before') {
    evidence = local
      .filter(
        ({ event }) => event.kind === 'transition' && stackObject(event.data).outcome !== 'active',
      )
      .slice(0, 1);
    observed = actor?.finishedAt ?? null;
    satisfied =
      actor?.outcome === 'success' &&
      actor.finishedAt !== null &&
      actor.finishedAt <= expected.timeMs;
  }
  const verdict = view.expectations.find((v) => v.expectationId === expectationId);
  const final = stackCursor(record, cursor) === record.view.events.length + 1;
  const consistent =
    !final || verdict?.status === 'undetermined' || (verdict?.status === 'pass') === satisfied;
  const wanted = new Set(evidence.map(({ event }) => event.eventId));
  let budget = 256;
  for (let index = view.events.length - 1; index >= 0 && budget > 0; index--) {
    const event = view.events[index];
    if (!event || !wanted.has(event.eventId)) continue;
    budget--;
    for (const source of event.sourceEventIds) wanted.add(source);
  }
  const ancestors = indexed.filter(({ event }) => wanted.has(event.eventId));
  const references = indexed.filter(
    ({ event }) =>
      !wanted.has(event.eventId) &&
      (event.kind === 'environment' ||
        event.kind === 'timer' ||
        event.kind === 'connection' ||
        event.kind === 'diagnostic') &&
      event.endpoint.participant === expected.target.participant,
  );
  return {
    success: true as const,
    value: {
      expected,
      observed: previewJson(observed as import('../domain/execution-contract.ts').JsonValue),
      status: consistent ? (verdict?.status ?? 'undetermined') : 'inconsistent',
      satisfiedSoFar: satisfied,
      note: final
        ? verdict?.status === 'undetermined'
          ? '부분 실행·오류 영향은 저장된 미판정을 유지합니다.'
          : '저장 당시 판정과 당시 기대/관찰을 대조했습니다.'
        : '현재 접두부의 관찰입니다. 최종 실패/성공을 추정하지 않습니다.',
      evidence: evidence.slice(0, 20),
      ancestors: ancestors.slice(-20),
      references: references.slice(-20),
      limited:
        budget === 0 || evidence.length > 20 || ancestors.length > 20 || references.length > 20,
    },
  };
}
