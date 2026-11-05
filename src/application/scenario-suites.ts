import type { JsonValue } from '../domain/execution-contract.ts';
import { freezeOwned } from '../domain/immutable-data.ts';
import { parseExperiment, parseJsonData } from '../domain/model-validation.ts';
import type {
  ExperimentDefinition,
  ModelDiagnostic,
  ValidationResult,
} from '../domain/protocol-model.ts';
import { caseConfiguration } from '../domain/suite-validation.ts';
import {
  type DraftRecord,
  type SavedRun,
  type ScenarioCase,
  type ScenarioSuite,
  WORKSPACE_POLICY,
} from '../domain/workspace-model.ts';
import { rawDiagnostics } from '../domain/workspace-validation.ts';
import { equalJson } from '../engine/expressions.ts';
import { batchRunMetrics } from './batch-experiments.ts';
import { createSimulation } from './create-simulation.ts';
import { editExperiment, rebasePending } from './edit-experiment.ts';
import { createRunSeries } from './run-series.ts';
import { captureRun, workspaceId } from './workspace-operations.ts';

/** Capture case-owned settings while keeping all protocol definitions shared with the draft. */
export function captureScenarioCase(draft: DraftRecord, label = '기본 사례'): ScenarioCase {
  const { scenario, environment, seed } = draft.configuration;
  return {
    id: workspaceId('case'),
    label,
    enabled: true,
    ...structuredClone({ scenario, environment, seed }),
    raw: Object.fromEntries(
      Object.entries(draft.raw).filter(([path]) => path.startsWith('/scenario/')),
    ),
  };
}
/** Create one editable suite from the draft's current settings. */
export function createScenarioSuite(draft: DraftRecord): ScenarioSuite {
  return {
    id: workspaceId('suite'),
    label: '프로토콜 검증',
    revision: 1,
    cases: [captureScenarioCase(draft)],
  };
}
/** Edit only case-owned paths, rebasing unfinished input without changing the shared protocol. */
export function editScenarioCase(
  source: ExperimentDefinition,
  item: ScenarioCase,
  path: string,
  value: JsonValue | undefined,
): ScenarioCase {
  if (!/^\/(?:scenario|environment|seed)(?:\/|$)/.test(path)) return item;
  const before = caseConfiguration(source, item);
  const next = editExperiment(before, path, value);
  return {
    ...item,
    scenario: next.scenario,
    environment: next.environment,
    seed: next.seed,
    raw: rebasePending(item.raw, before, path, value),
  };
}
/** Retain unfinished JSON separately from the last syntactically valid case value. */
export function editScenarioCaseJson(
  source: ExperimentDefinition,
  item: ScenarioCase,
  path: string,
  text: string,
): ScenarioCase {
  if (!/^\/scenario\/(?:inputs|expectations)\/\d+\/message\/values\/[^/]+$/.test(path)) return item;
  let next = item;
  try {
    const parsed = parseJsonData(JSON.parse(text));
    if (parsed.success) next = editScenarioCase(source, item, path, parsed.value);
  } catch {
    /* Preserve unfinished input. */
  }
  return { ...next, raw: { ...next.raw, [path]: text } };
}
/** Inspect execution readiness, including unfinished common-definition and case JSON. */
export function scenarioCaseDiagnostics(
  draft: DraftRecord,
  item: ScenarioCase,
): readonly ModelDiagnostic[] {
  const validation = parseExperiment(caseConfiguration(draft.configuration, item));
  return [
    ...(validation.success ? [] : validation.diagnostics),
    ...rawDiagnostics(
      Object.fromEntries(
        Object.entries(draft.raw).filter(([path]) => path.startsWith('/definitions/')),
      ),
    ),
    ...rawDiagnostics(item.raw),
  ];
}
export type RegressionPlan = {
  readonly id: string;
  readonly draft: DraftRecord;
  readonly suite: ScenarioSuite;
  readonly cases: readonly ScenarioCase[];
  readonly totalRuns: number;
};
/** Check enabled cases without allocating or freezing another copy during editing. */
export function checkRegression(
  draft: DraftRecord,
  available: number,
): ValidationResult<readonly ScenarioCase[]> {
  const suite = draft.suite;
  const fail = (message: string): ValidationResult<readonly ScenarioCase[]> => ({
    success: false,
    diagnostics: [{ path: '/suite', code: 'regression-settings', message }],
  });
  if (!suite?.label.trim() || suite.label.length > 80)
    return fail('묶음 이름을 1~80자로 입력하세요.');
  if (suite.cases.length > WORKSPACE_POLICY.maxCases) return fail('사례는 최대 20개입니다.');
  if (new Set(suite.cases.map((item) => item.id)).size !== suite.cases.length)
    return fail('사례 ID가 중복됩니다.');
  const cases = suite.cases.filter((item) => item.enabled);
  if (!cases.length) return fail('실행할 사례를 하나 이상 활성화하세요.');
  if (cases.length > available)
    return fail(
      `활성 사례 ${cases.length}개를 저장할 공간이 없습니다. 남은 기록 ${available}개입니다.`,
    );
  const diagnostics: ModelDiagnostic[] = [];
  for (const item of cases) {
    if (!item.label.trim() || item.label.length > 80)
      return fail('활성 사례 이름을 1~80자로 입력하세요.');
    diagnostics.push(
      ...scenarioCaseDiagnostics(draft, item).map((diagnostic) => ({
        ...diagnostic,
        message: `${item.label}: ${diagnostic.message}`,
      })),
    );
  }
  if (diagnostics.length) return { success: false, diagnostics };
  return { success: true, value: cases };
}
/** Freeze one common source revision and its validated ordered case manifest at execution time. */
export function prepareRegression(
  draft: DraftRecord,
  available: number,
): ValidationResult<RegressionPlan> {
  const checked = checkRegression(draft, available);
  if (!checked.success) return checked;
  const captured = structuredClone(draft);
  const frozenSuite = captured.suite;
  if (!frozenSuite) throw new Error('Validated suite is missing');
  return {
    success: true,
    value: freezeOwned({
      id: workspaceId('regression'),
      draft: captured,
      suite: frozenSuite,
      cases: frozenSuite.cases.filter((item) => item.enabled),
      totalRuns: checked.value.length,
    }),
  };
}
/** Run each frozen case on a fresh engine with the suite's common protocol snapshot. */
export function createRegressionSession(plan: RegressionPlan) {
  return createRunSeries({
    id: plan.id,
    totalRuns: plan.totalRuns,
    create: (index) => {
      const item = plan.cases[index];
      if (!item) throw new Error('Missing case');
      return createSimulation(caseConfiguration(plan.draft.configuration, item));
    },
    capture: (view, index) =>
      freezeOwned({
        ...captureRun(view, plan.draft.id, plan.draft.version),
        regression: {
          id: plan.id,
          label: plan.suite.label,
          suiteId: plan.suite.id,
          suiteRevision: plan.suite.revision,
          cases: plan.cases.map((item) => ({ id: item.id, label: item.label })),
          caseIndex: index,
        },
      }),
  });
}
export type RegressionChange =
  | '새 실패'
  | '개선'
  | '동일 판정'
  | '조건 변경'
  | '엔진 차이'
  | '미판정'
  | '미실행'
  | '비교 대상 없음'
  | '다른 묶음'
  | '기준 없음';
/** Compare actual case settings before declaring a regression across protocol source versions. */
export function regressionChange(
  current: SavedRun | undefined,
  baseline: SavedRun | undefined,
): RegressionChange {
  if (!current || !baseline) return '미실행';
  if (
    !current.regression ||
    !baseline.regression ||
    current.regression.cases[current.regression.caseIndex]?.id !==
      baseline.regression.cases[baseline.regression.caseIndex]?.id
  )
    return '비교 대상 없음';
  if (
    current.experimentId !== baseline.experimentId ||
    current.regression?.suiteId !== baseline.regression?.suiteId
  )
    return '다른 묶음';
  const a = current.view.snapshot;
  const b = baseline.view.snapshot;
  if (
    a.engineVersion !== b.engineVersion ||
    a.randomAlgorithm !== b.randomAlgorithm ||
    JSON.stringify(a.limits) !== JSON.stringify(b.limits)
  )
    return '엔진 차이';
  const settings = (configuration: ExperimentDefinition) => ({
    scenario: configuration.scenario,
    environment: configuration.environment,
    seed: configuration.seed,
  });
  if (!equalJson(settings(a.configuration), settings(b.configuration))) return '조건 변경';
  const next = batchRunMetrics(current.view).verdict;
  const old = batchRunMetrics(baseline.view).verdict;
  if (next === 'undetermined' || old === 'undetermined') return '미판정';
  return next === old ? '동일 판정' : next === 'fail' ? '새 실패' : '개선';
}
/** Project case manifests including never-started or deleted runs, without inventing verdicts. */
export function compareRegressionRuns(
  records: readonly SavedRun[],
  currentId: string,
  baselineId: string,
) {
  const group = (id: string) => records.filter((item) => item.regression?.id === id);
  const current = group(currentId);
  const baseline = group(baselineId);
  const a = current[0]?.regression;
  const b = baseline[0]?.regression;
  const manifest = new Map(
    [...(a?.cases ?? []), ...(b?.cases ?? [])].map((item) => [item.id, item]),
  );
  return [...manifest.values()].map((item) => {
    const find = (items: readonly SavedRun[]) =>
      items.find((record) => record.regression?.cases[record.regression.caseIndex]?.id === item.id);
    const next = find(current);
    const old = find(baseline);
    const included = a?.cases.some((entry) => entry.id === item.id);
    const wasIncluded = b?.cases.some((entry) => entry.id === item.id);
    const change: RegressionChange = !b
      ? '기준 없음'
      : !included || !wasIncluded
        ? '비교 대상 없음'
        : regressionChange(next, old);
    return {
      id: item.id,
      label: a?.cases.find((entry) => entry.id === item.id)?.label ?? item.label,
      current: next,
      baseline: old,
      currentIncluded: Boolean(included),
      baselineIncluded: Boolean(wasIncluded),
      change,
    };
  });
}
