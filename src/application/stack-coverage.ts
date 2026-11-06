import { stackProtocolBody } from '../domain/stack-model.ts';
import {
  stackObject,
  stackProtocolAt,
  stackRecordCompatibility,
  stackTarget,
} from '../domain/stack-record.ts';
import { canonicalStackJson, stackCaseCondition } from '../domain/stack-series-model.ts';
import type { SavedStackRun } from '../domain/workspace-v2-model.ts';
import { readStackRecord } from './stack-replay.ts';

export type StackCoverageEvidence = {
  readonly recordId: string;
  readonly caseId: string;
  readonly caseLabel: string;
  readonly cursor: number;
  readonly count: number;
};
export type StackCoverageItem = {
  readonly endpoint: string;
  readonly kind: 'state' | 'rule';
  readonly id: string;
  readonly count: number;
  readonly evidence: readonly StackCoverageEvidence[];
};

/** Count initial and committed observations in one frozen regression group; never infer unreachability or failure. */
export function buildStackCoverage(
  records: readonly SavedStackRun[],
  groupId: string,
  options: { endpoint?: string; unobservedOnly?: boolean; page?: number } = {},
) {
  const selected = records.filter((r) => r.series?.id === groupId);
  const excluded: { recordId: string; reason: string }[] = [];
  const included: SavedStackRun[] = [];
  const indexes = new Set<number>();
  let common: string | undefined;
  let manifest: string | undefined;
  let owner: string | undefined;
  let suite: string | undefined;
  for (const candidate of selected.slice(0, 100)) {
    const parsed = readStackRecord(candidate);
    if (!parsed.success) {
      excluded.push({ recordId: candidate.id, reason: 'invalid record' });
      continue;
    }
    const record = parsed.value;
    const series = record.series;
    if (series?.kind !== 'regression' || stackRecordCompatibility(record.view.snapshot)) {
      excluded.push({ recordId: record.id, reason: 'unsupported group or version' });
      continue;
    }
    const source = canonicalStackJson(series.source);
    const declared = canonicalStackJson(series.manifest);
    if (
      (common && common !== source) ||
      (manifest && manifest !== declared) ||
      indexes.has(series.index) ||
      (suite !== undefined && suite !== canonicalStackJson(series.suite)) ||
      (owner !== undefined && owner !== record.experimentId)
    ) {
      excluded.push({ recordId: record.id, reason: 'different source/manifest or duplicate case' });
      continue;
    }
    common = source;
    manifest = declared;
    indexes.add(series.index);
    owner = record.experimentId;
    suite = canonicalStackJson(series.suite);
    included.push(record);
  }
  const first = included[0];
  if (!first?.series)
    return {
      status: 'unavailable' as const,
      message: '검사할 공통 snapshot의 회귀 기록이 없습니다.',
      items: [],
      cases: [],
      excluded,
    };
  const items = new Map<
    string,
    {
      endpoint: string;
      kind: 'state' | 'rule';
      id: string;
      count: number;
      evidence: StackCoverageEvidence[];
    }
  >();
  for (const participant of ['A', 'B'] as const)
    for (const instance of first.view.snapshot.configuration.nodes[participant].instances) {
      const endpoint = { participant, instanceId: instance.id };
      const target = stackTarget(endpoint);
      const body = stackProtocolBody(stackProtocolAt(first.view.snapshot, endpoint));
      for (const [kind, declarations] of [
        ['state', body.states],
        ['rule', body.rules],
      ] as const)
        for (const declaration of declarations)
          items.set(`${target}/${kind}/${declaration.id}`, {
            endpoint: target,
            kind,
            id: declaration.id,
            count: 0,
            evidence: [],
          });
    }
  if (options.endpoint && ![...items.values()].some((item) => item.endpoint === options.endpoint))
    return {
      status: 'unavailable' as const,
      message: '공통 snapshot에 없는 인스턴스입니다.',
      items: [],
      cases: [],
      excluded,
    };
  for (const record of included) {
    const series = record.series;
    if (!series) continue;
    const member = series.manifest[series.index];
    if (!member) continue;
    const local = new Map<string, { count: number; cursor: number }>();
    function observe(key: string, cursor: number) {
      const value = local.get(key);
      if (value) value.count++;
      else local.set(key, { count: 1, cursor });
    }
    for (const participant of ['A', 'B'] as const)
      for (const instance of record.view.snapshot.configuration.nodes[participant].instances) {
        const endpoint = { participant, instanceId: instance.id };
        const body = stackProtocolBody(stackProtocolAt(record.view.snapshot, endpoint));
        observe(`${stackTarget(endpoint)}/state/${body.initialStateId}`, 0);
      }
    record.view.events.forEach((event, index) => {
      if (event.kind !== 'transition') return;
      const data = stackObject(event.data);
      const target = stackTarget(event.endpoint);
      observe(`${target}/rule/${String(data.ruleId)}`, index + 1);
      observe(`${target}/state/${String(stackObject(data.after).stateId)}`, index + 1);
    });
    for (const [key, observation] of local) {
      const item = items.get(key);
      if (!item) continue;
      item.count += observation.count;
      item.evidence.push({
        recordId: record.id,
        caseId: member.id,
        caseLabel: member.label,
        ...observation,
      });
    }
  }
  const cases = first.series.manifest.map((member, index) => {
    const record = included.find((r) => r.series?.index === index);
    return {
      ...member,
      recordId: record?.id,
      status: record ? (record.view.status === 'completed' ? 'complete' : 'partial') : 'missing',
    };
  });
  const all = [...items.values()].filter(
    (i) =>
      (!options.endpoint || i.endpoint === options.endpoint) &&
      (!options.unobservedOnly || i.count === 0),
  );
  const pages = Math.max(1, Math.ceil(all.length / 20));
  const page = Number.isSafeInteger(options.page)
    ? Math.max(0, Math.min(options.page ?? 0, pages - 1))
    : 0;
  return {
    status: 'available' as const,
    message: '선택한 공통 source의 실제 관찰입니다. 미관찰은 실패/도달 불가능을 뜻하지 않습니다.',
    items: all.slice(page * 20, page * 20 + 20),
    totalItems: all.length,
    pages,
    page,
    cases,
    excluded,
    partial: cases.some((c) => c.status !== 'complete'),
    source: first.series.source,
  };
}

/** Compare verdict changes only for the same actual case/environment/seed and engine contract. */
export function compareStackCaseRuns(left: SavedStackRun, right: SavedStackRun) {
  const a = readStackRecord(left);
  const b = readStackRecord(right);
  if (!a.success || !b.success || !a.value.series || !b.value.series)
    return 'incomparable' as const;
  const av = a.value.view;
  const bv = b.value.view;
  const caseA = a.value.series.manifest[a.value.series.index]?.id;
  const caseB = b.value.series.manifest[b.value.series.index]?.id;
  if (
    stackRecordCompatibility(av.snapshot) ||
    stackRecordCompatibility(bv.snapshot) ||
    caseA !== caseB ||
    a.value.series.suite?.id !== b.value.series.suite?.id ||
    a.value.series.kind !== 'regression' ||
    b.value.series.kind !== 'regression' ||
    av.snapshot.engineVersion !== bv.snapshot.engineVersion ||
    av.snapshot.randomAlgorithm !== bv.snapshot.randomAlgorithm ||
    canonicalStackJson(av.snapshot.configuration.limits) !==
      canonicalStackJson(bv.snapshot.configuration.limits) ||
    canonicalStackJson(stackCaseCondition(av.snapshot.configuration)) !==
      canonicalStackJson(stackCaseCondition(bv.snapshot.configuration))
  )
    return 'incomparable' as const;
  if (
    av.status !== 'completed' ||
    bv.status !== 'completed' ||
    av.expectations.some((e) => e.status === 'undetermined') ||
    bv.expectations.some((e) => e.status === 'undetermined')
  )
    return 'undetermined' as const;
  const failedA = av.expectations.some((e) => e.status === 'fail');
  const failedB = bv.expectations.some((e) => e.status === 'fail');
  return failedA === failedB
    ? ('unchanged' as const)
    : failedA
      ? ('improved' as const)
      : ('new-failure' as const);
}
