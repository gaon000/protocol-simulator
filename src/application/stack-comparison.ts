import type { JsonValue } from '../domain/execution-contract.ts';
import type { StackTrace } from '../domain/stack-model.ts';
import { stackObject, stackRecordCompatibility, stackTarget } from '../domain/stack-record.ts';
import { canonicalStackJson } from '../domain/stack-series-model.ts';
import type { SavedStackRun } from '../domain/workspace-v2-model.ts';
import { previewJson } from './preview-json.ts';
import { readStackRecord } from './stack-replay.ts';
import { StackSemanticLimit, semanticStackEvent } from './stack-semantic-event.ts';

export const STACK_COMPARISON_POLICY = {
  configurationCharacters: 262144,
  rows: 2000,
  lookahead: 16,
  bytes: 524288,
  events: 10000,
  valueCharacters: 32768,
} as const;
export type StackEventDifference = {
  readonly relation: 'same' | 'different' | 'limited' | 'left-only' | 'right-only';
  readonly leftCursor?: number;
  readonly rightCursor?: number;
  readonly endpoint: string;
  readonly kind: string;
  readonly left?: StackTrace;
  readonly right?: StackTrace;
};
function eventKey(event: StackTrace): string {
  const data = stackObject(event.data);
  return canonicalStackJson([
    stackTarget(event.endpoint),
    event.portId ?? '',
    event.kind,
    data.operation ?? '',
    data.ruleId ?? '',
    stackObject(data.message).messageId ?? '',
  ]);
}
/** Compare two independent frozen runs through stable endpoints and finite order-preserving event correspondence. */
export function compareStackRuns(left: SavedStackRun, right: SavedStackRun, page = 0) {
  const lp = readStackRecord(left);
  const rp = readStackRecord(right);
  if (!lp.success || !rp.success)
    return {
      status: 'unavailable' as const,
      message: '모드/기록 검증에 실패했습니다.',
      rows: [],
      differences: [],
      limited: true,
    };
  const a = lp.value.view;
  const b = rp.value.view;
  const topology = (record: SavedStackRun) => {
    const c = record.view.snapshot.configuration;
    return {
      nodes: c.nodes,
      bindings: c.bindings,
      link: { id: c.link.id, A: c.link.A, B: c.link.B },
    };
  };
  const differences: {
    path: string;
    relation: 'same' | 'different' | 'limited';
    left: ReturnType<typeof previewJson>;
    right: ReturnType<typeof previewJson>;
  }[] = [];
  function compareValue(path: string, left: JsonValue, right: JsonValue) {
    const l = previewJson(left);
    const r = previewJson(right);
    const textA = canonicalStackJson(left);
    const textB = canonicalStackJson(right);
    const relation =
      textA.length + textB.length >
      (path === '/configuration'
        ? STACK_COMPARISON_POLICY.configurationCharacters
        : STACK_COMPARISON_POLICY.valueCharacters)
        ? 'limited'
        : textA === textB
          ? 'same'
          : 'different';
    differences.push({ path, relation, left: l, right: r });
  }
  compareValue(
    '/configuration',
    a.snapshot.configuration as unknown as JsonValue,
    b.snapshot.configuration as unknown as JsonValue,
  );
  compareValue('/status', a.status, b.status);
  compareValue('/timeMs', a.timeMs, b.timeMs);
  compareValue(
    '/expectations',
    a.expectations as unknown as JsonValue,
    b.expectations as unknown as JsonValue,
  );
  for (const target of new Set([...Object.keys(a.instances), ...Object.keys(b.instances)])) {
    const leftActor = a.instances[target];
    const rightActor = b.instances[target];
    if (leftActor && rightActor && !!leftActor.buffers !== !!rightActor.buffers) {
      const { buffers: leftBuffers, ...leftObserved } = leftActor;
      const { buffers: rightBuffers, ...rightObserved } = rightActor;
      compareValue(
        `/instances/${target}`,
        leftObserved as unknown as JsonValue,
        rightObserved as unknown as JsonValue,
      );
      differences.push({
        path: `/instances/${target}/buffers`,
        relation: 'limited',
        left: previewJson((leftBuffers ?? null) as unknown as JsonValue),
        right: previewJson((rightBuffers ?? null) as unknown as JsonValue),
      });
    } else
      compareValue(
        `/instances/${target}`,
        (leftActor ?? null) as unknown as JsonValue,
        (rightActor ?? null) as unknown as JsonValue,
      );
  }
  const incompatible =
    stackRecordCompatibility(a.snapshot) ||
    stackRecordCompatibility(b.snapshot) ||
    canonicalStackJson(topology(lp.value)) !== canonicalStackJson(topology(rp.value));
  if (incompatible)
    return {
      status: 'unavailable' as const,
      message:
        '다른 토폴로지/실행 버전입니다. 각 요약을 보존하며 계층/회차를 임의 대응하지 않습니다.',
      rows: [],
      differences,
      limited: true,
    };
  const ai = new Map(a.events.map((e, index) => [e.eventId, index]));
  const bi = new Map(b.events.map((e, index) => [e.eventId, index]));
  const budget = {
    bytes: STACK_COMPARISON_POLICY.bytes as number,
    events: STACK_COMPARISON_POLICY.events as number,
  };
  const rows: StackEventDifference[] = [];
  let l = 0;
  let r = 0;
  const add = (
    left: StackTrace | undefined,
    right: StackTrace | undefined,
    relation: StackEventDifference['relation'],
  ) => {
    const event = left ?? right;
    if (!event) return;
    rows.push({
      relation,
      endpoint: stackTarget(event.endpoint),
      kind: event.kind,
      ...(left ? { leftCursor: l + 1, left } : {}),
      ...(right ? { rightCursor: r + 1, right } : {}),
    });
  };
  while (
    (l < a.events.length || r < b.events.length) &&
    rows.length < STACK_COMPARISON_POLICY.rows
  ) {
    const le = a.events[l];
    const re = b.events[r];
    if (!le) {
      add(undefined, re, 'right-only');
      r++;
      continue;
    }
    if (!re) {
      add(le, undefined, 'left-only');
      l++;
      continue;
    }
    if (eventKey(le) === eventKey(re)) {
      let relation: StackEventDifference['relation'];
      try {
        relation =
          canonicalStackJson(semanticStackEvent(a, le, ai, budget)) ===
          canonicalStackJson(semanticStackEvent(b, re, bi, budget))
            ? 'same'
            : 'different';
      } catch (error) {
        if (!(error instanceof StackSemanticLimit)) throw error;
        relation = 'limited';
      }
      add(le, re, relation);
      l++;
      r++;
      continue;
    }
    const rightMatch = b.events
      .slice(r + 1, r + 1 + 16)
      .findIndex((event) => eventKey(event) === eventKey(le));
    const leftMatch = a.events
      .slice(l + 1, l + 1 + 16)
      .findIndex((event) => eventKey(event) === eventKey(re));
    if (rightMatch >= 0 && (leftMatch < 0 || rightMatch <= leftMatch)) {
      add(undefined, re, 'right-only');
      r++;
    } else {
      add(le, undefined, 'left-only');
      l++;
    }
  }
  const limited =
    l < a.events.length ||
    r < b.events.length ||
    rows.some((row) => row.relation === 'limited') ||
    differences.some((d) => d.relation === 'limited');
  const partial = a.status !== 'completed' || b.status !== 'completed';
  const different =
    rows.some((row) => !['same', 'limited'].includes(row.relation)) ||
    differences.some((d) => d.relation === 'different');
  const firstDifference = rows.find((row) => row.relation !== 'same');
  const pages = Math.max(1, Math.ceil(rows.length / 20));
  const selected = Number.isSafeInteger(page) ? Math.max(0, Math.min(page, pages - 1)) : 0;
  return {
    status: different
      ? ('different' as const)
      : limited || partial
        ? ('limited' as const)
        : ('same' as const),
    message:
      '실행별 ID는 공유 원인이 아닙니다. 순서를 보존한 유한 대응이며 양쪽의 실제 cursor로 이동합니다.',
    rows: rows.slice(selected * 20, selected * 20 + 20),
    totalRows: rows.length,
    page: selected,
    pages,
    differences,
    firstDifference,
    limited,
    partial,
  };
}
