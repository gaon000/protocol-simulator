import { freezeOwned } from '../domain/immutable-data.ts';
import { valueAt } from '../domain/json-pointer.ts';
import type { ValidationResult } from '../domain/protocol-model.ts';
import type { StackExperiment } from '../domain/stack-model.ts';
import {
  canonicalStackJson,
  stackCaseCondition,
  stackCommonSource,
} from '../domain/stack-series-model.ts';
import { parseStackExperiment } from '../domain/stack-validation.ts';
import { WORKSPACE_POLICY } from '../domain/workspace-model.ts';
import type { SavedStackRun, StackDraft, WorkspaceV2 } from '../domain/workspace-v2-model.ts';
import { parseStackSuite } from '../domain/workspace-v2-validation.ts';
import { createStackSimulation } from './create-stack-simulation.ts';
import { workspaceId } from './workspace-operations.ts';
import { captureStackRun } from './workspace-v2-operations.ts';

export type StackSeriesPlan = {
  readonly id: string;
  readonly label: string;
  readonly kind: 'batch' | 'regression';
  readonly suite?: { readonly id: string; readonly revision: number };
  readonly owner: string;
  readonly draftVersion: number;
  readonly cases: readonly {
    readonly id: string;
    readonly label: string;
    readonly configuration: StackExperiment;
  }[];
};

/** Freeze common topology/definitions and each actual case before allocating any simulation engine. */
export function prepareStackSeries(
  draft: StackDraft,
  workspace: WorkspaceV2,
  options:
    | {
        readonly kind: 'batch';
        readonly label: string;
        readonly seeds: readonly number[];
        readonly environments?: readonly {
          readonly id: string;
          readonly label: string;
          readonly environment: StackExperiment['link']['environment'];
        }[];
      }
    | { readonly kind: 'regression'; readonly label: string },
): ValidationResult<StackSeriesPlan> {
  const failure = (message: string): ValidationResult<StackSeriesPlan> => ({
    success: false,
    diagnostics: [{ path: '/series', code: 'stack-series', message }],
  });
  for (const [path, text] of Object.entries(draft.raw)) {
    try {
      if (
        canonicalStackJson(JSON.parse(text)) !==
        canonicalStackJson(valueAt(draft.configuration, path))
      )
        return failure('편집 중인 JSON과 초안 값이 다릅니다.');
    } catch {
      return failure('미완성 JSON을 해결한 뒤 실행하세요.');
    }
  }
  const source = parseStackExperiment(draft.configuration);
  if (!source.success) return source;
  let cases: StackSeriesPlan['cases'];
  if (options.kind === 'batch') {
    if (
      !options.seeds.length ||
      options.seeds.length > 100 ||
      new Set(options.seeds).size !== options.seeds.length ||
      options.seeds.some((s) => !Number.isSafeInteger(s) || s < 0 || s > 0xffff_ffff)
    )
      return failure('seed는 중복 없이 1~100개, uint32 범위여야 합니다.');
    const environments = options.environments ?? [
      { id: 'current', label: '현재 환경', environment: draft.configuration.link.environment },
    ];
    if (
      !environments.length ||
      environments.length * options.seeds.length > 100 ||
      new Set(environments.map((e) => e.id)).size !== environments.length
    )
      return failure('환경/seed 조합은 중복 ID 없이 최대 100회입니다.');
    cases = environments.flatMap((environment, variant) =>
      options.seeds.map((seed, index) => ({
        id: `variant_${variant}_seed_${index}`,
        label: `${environment.label} · seed ${seed}`,
        configuration: {
          ...draft.configuration,
          seed,
          link: { ...draft.configuration.link, environment: environment.environment },
        },
      })),
    );
  } else {
    if (!draft.suite) return failure('시나리오 묶음이 없습니다.');
    const checked = parseStackSuite(draft.suite, draft.configuration);
    if (!checked.success) return checked;
    const active = draft.suite.cases.filter((c) => c.enabled);
    if (!active.length || active.length > 20) return failure('활성 사례는 1~20개여야 합니다.');
    cases = active.map((c) => ({
      id: c.id,
      label: c.label,
      configuration: {
        ...draft.configuration,
        seed: c.seed,
        scenario: c.scenario,
        link: { ...draft.configuration.link, environment: c.environment },
      },
    }));
  }
  if (
    workspace.legacy.runs.length + workspace.stack.runs.length + cases.length >
    WORKSPACE_POLICY.maxRuns
  )
    return failure('공유 저장 기록 100개 한도를 넘습니다.');
  for (const item of cases) {
    const parsed = parseStackExperiment(item.configuration);
    if (!parsed.success) return parsed;
  }
  return {
    success: true,
    value: freezeOwned(
      structuredClone({
        id: workspaceId('stack_series'),
        label: options.label,
        kind: options.kind,
        ...(options.kind === 'regression' && draft.suite
          ? { suite: { id: draft.suite.id, revision: draft.suite.revision } }
          : {}),
        owner: draft.id,
        draftVersion: draft.version,
        cases,
      }),
    ),
  };
}
/** Run independent cases in finite slices, fence stale callbacks after cancel, and retain partial artifacts. */
export function createStackSeriesSession(input: StackSeriesPlan) {
  const plan = freezeOwned(structuredClone(input));
  let index = 0;
  let stopped = false;
  let engine: import('../engine/stack-scheduler.ts').StackScheduler | undefined;
  const manifest = plan.cases.map(({ id, label }) => ({ id, label }));
  function capture(view: import('../domain/stack-runtime-model.ts').StackView): SavedStackRun {
    const record = captureStackRun(view, plan.owner, plan.draftVersion);
    return freezeOwned({
      ...record,
      series: {
        id: plan.id,
        label: plan.label,
        kind: plan.kind,
        ...(plan.suite ? { suite: plan.suite } : {}),
        manifest,
        index,
        source: stackCommonSource(view.snapshot.configuration),
        condition: stackCaseCondition(view.snapshot.configuration),
      },
    });
  }
  return {
    id: plan.id,
    progress: () => ({
      finished: index,
      total: plan.cases.length,
      done: stopped || index >= plan.cases.length,
    }),
    advance(): SavedStackRun | undefined {
      if (stopped || index >= plan.cases.length) return;
      const item = plan.cases[index];
      if (!item) return;
      if (!engine) {
        const created = createStackSimulation(item.configuration);
        if (!created.success) throw new Error(created.diagnostics[0]?.message);
        engine = created.value;
      }
      const view = engine.runBatch(64);
      if (!engine.terminal) return;
      const record = capture(view);
      index++;
      engine = undefined;
      return record;
    },
    cancel(): SavedStackRun | undefined {
      if (stopped || index >= plan.cases.length) return;
      stopped = true;
      if (!engine) return;
      const record = capture(engine.cancel());
      index++;
      engine = undefined;
      return record;
    },
  };
}
/** Count engine completion, expectation pass/fail, partial/undetermined and unrun cases separately. */
export function summarizeStackSeries(records: readonly SavedStackRun[], total: number) {
  return {
    recorded: records.length,
    completed: records.filter((r) => r.view.status === 'completed').length,
    passed: records.filter(
      (r) => r.view.status === 'completed' && r.view.expectations.every((e) => e.status === 'pass'),
    ).length,
    failed: records.filter(
      (r) => r.view.status === 'completed' && r.view.expectations.some((e) => e.status === 'fail'),
    ).length,
    undetermined: records.filter(
      (r) =>
        r.view.status !== 'completed' ||
        r.view.expectations.some((e) => e.status === 'undetermined'),
    ).length,
    unrun: Math.max(0, total - records.length),
  };
}
