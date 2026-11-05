import { freezeOwned } from '../domain/immutable-data.ts';
import { parseExperiment } from '../domain/model-validation.ts';
import type {
  Direction,
  EngineView,
  ExperimentDefinition,
  ValidationResult,
} from '../domain/protocol-model.ts';
import type { BatchRunInfo, SavedRun } from '../domain/workspace-model.ts';
import { WORKSPACE_POLICY } from '../domain/workspace-model.ts';
import type { SimulationEngine } from '../engine/simulation.ts';
import { createSimulation } from './create-simulation.ts';
import { captureRun, workspaceId } from './workspace-operations.ts';

export type BatchOptions = {
  readonly label: string;
  readonly seeds: readonly number[];
  readonly delaysMs: readonly number[];
  readonly lossRates: readonly number[];
  readonly direction: BatchRunInfo['direction'];
};
export type BatchPlan = {
  readonly id: string;
  readonly source: ExperimentDefinition;
  readonly experimentId: string;
  readonly draftVersion: number;
  readonly options: BatchOptions;
  readonly variants: readonly {
    readonly delayMs: number | null;
    readonly lossRate: number | null;
  }[];
  readonly totalRuns: number;
};

/** Parse comma-separated decimal values without treating empty tokens as zero. */
export function parseBatchNumbers(text: string): readonly number[] {
  if (!text.trim()) return [];
  const tokens = text.split(',').map((item) => item.trim());
  if (
    tokens.length > WORKSPACE_POLICY.maxRuns ||
    tokens.some((item) => !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(item))
  )
    return [Number.NaN];
  return tokens.map(Number);
}

/** Capture one source version and validate bounded, paired-seed environment experiments. */
export function prepareBatch(
  source: ExperimentDefinition,
  experimentId: string,
  draftVersion: number,
  options: BatchOptions,
  available: number,
): ValidationResult<BatchPlan> {
  const valid = parseExperiment(source);
  if (!valid.success) return valid;
  const fail = (message: string): ValidationResult<BatchPlan> => ({
    success: false,
    diagnostics: [{ path: '/batch', code: 'batch-settings', message }],
  });
  if (!options.label.trim() || options.label.length > 80)
    return fail('묶음 이름은 1~80자로 입력하세요.');
  if (!['both', 'AtoB', 'BtoA'].includes(options.direction)) return fail('적용 방향을 선택하세요.');
  if (
    !options.seeds.length ||
    options.seeds.some((value) => !Number.isInteger(value) || value < 0 || value > 0xffff_ffff)
  )
    return fail('seed는 0~4294967295 사이 정수 목록이어야 합니다.');
  if (options.delaysMs.some((value) => !Number.isSafeInteger(value) || value < 0))
    return fail('지연은 0 이상의 안전한 정수 ms로 입력하세요.');
  if (options.lossRates.some((value) => !Number.isFinite(value) || value < 0 || value > 1))
    return fail('손실률은 0~100%로 입력하세요.');
  if (
    [options.seeds, options.delaysMs, options.lossRates].some(
      (list) => new Set(list).size !== list.length,
    )
  )
    return fail('각 목록에서 중복 값을 제거하세요.');
  if (source.environment.kind === 'stream' && options.lossRates.length)
    return fail('바이트 스트림에는 손실률을 설정할 수 없습니다.');
  const count =
    Math.max(1, options.delaysMs.length) *
    Math.max(1, options.lossRates.length) *
    options.seeds.length;
  if (count > WORKSPACE_POLICY.maxRuns || count > available)
    return fail(`총 ${count}회입니다. 남은 기록 ${available}개 안에서 설정하세요 (최대 100회).`);
  const variants: BatchPlan['variants'][number][] = [];
  for (const delayMs of options.delaysMs.length ? options.delaysMs : [null])
    for (const lossRate of options.lossRates.length ? options.lossRates : [null])
      variants.push({ delayMs, lossRate });
  return {
    success: true,
    value: freezeOwned({
      id: workspaceId('batch'),
      source: structuredClone(source),
      experimentId,
      draftVersion,
      options: structuredClone(options),
      variants,
      totalRuns: count,
    }),
  };
}

/** Override only the requested directions, retaining all other fault and framing settings. */
export function batchConfiguration(plan: BatchPlan, index: number): ExperimentDefinition {
  if (!Number.isInteger(index) || index < 0 || index >= plan.totalRuns)
    throw new RangeError('Unknown batch run');
  const variant = plan.variants[Math.floor(index / plan.options.seeds.length)];
  const seed = plan.options.seeds[index % plan.options.seeds.length];
  if (!variant || seed === undefined) throw new RangeError('Unknown batch variant');
  const base = plan.source.environment;
  const directions = { ...base.directions };
  for (const direction of (plan.options.direction === 'both'
    ? ['AtoB', 'BtoA']
    : [plan.options.direction]) as Direction[]) {
    const settings = directions[direction];
    directions[direction] = {
      ...settings,
      ...(variant.delayMs === null ? {} : { delayMs: variant.delayMs }),
      ...(base.kind === 'datagram' && variant.lossRate !== null
        ? { lossRate: variant.lossRate }
        : {}),
    };
  }
  // The discriminated service kind and direction shapes are preserved by the overrides above.
  const environment = { ...base, directions } as ExperimentDefinition['environment'];
  return { ...plan.source, seed, environment };
}

/** Execute finite queue slices; cancellation fences every later callback on this session. */
export function createBatchSession(plan: BatchPlan) {
  let index = 0;
  let stopped = false;
  let engine: SimulationEngine | undefined;
  function capture(view: EngineView): SavedRun {
    const variantIndex = Math.floor(index / plan.options.seeds.length);
    const variant = plan.variants[variantIndex];
    if (!variant) throw new RangeError('Unknown batch variant');
    return freezeOwned({
      ...captureRun(view, plan.experimentId, plan.draftVersion),
      batch: {
        id: plan.id,
        label: plan.options.label.trim(),
        totalRuns: plan.totalRuns,
        variantCount: plan.variants.length,
        variantIndex,
        seedIndex: index % plan.options.seeds.length,
        seeds: plan.options.seeds,
        direction: plan.options.direction,
        ...variant,
      },
    });
  }
  return {
    id: plan.id,
    progress: () => ({
      finished: index,
      total: plan.totalRuns,
      done: stopped || index >= plan.totalRuns,
    }),
    advance(): SavedRun | undefined {
      if (stopped || index >= plan.totalRuns) return;
      if (!engine) {
        const created = createSimulation(batchConfiguration(plan, index));
        if (!created.success)
          throw new Error(created.diagnostics[0]?.message ?? '반복 실행 초기화 실패');
        engine = created.value;
      }
      const view = engine.runBatch(64);
      if (view.status === 'paused') return;
      const record = capture(view);
      index++;
      engine = undefined;
      return record;
    },
    cancel(): SavedRun | undefined {
      if (stopped || index >= plan.totalRuns) return;
      stopped = true;
      if (!engine) return;
      const record = capture(engine.cancel());
      index++;
      engine = undefined;
      return record;
    },
  };
}

export type RunMetrics = {
  readonly verdict: 'pass' | 'fail' | 'undetermined';
  readonly completionMs: number | null;
  readonly sends: number;
  readonly expiries: number;
};
/** Judge expectations separately from engine completion and count only observed events. */
export function batchRunMetrics(view: EngineView): RunMetrics {
  const verdict =
    view.status !== 'completed' ||
    !view.expectations.length ||
    view.expectations.some((item) => item.status === 'undetermined')
      ? 'undetermined'
      : view.expectations.some((item) => item.status === 'fail')
        ? 'fail'
        : 'pass';
  const actors = Object.values(view.participants).filter((actor) => actor.outcome === 'success');
  const completionMs =
    verdict === 'pass' &&
    actors.length > 0 &&
    actors.every((actor) => actor.outcome === 'success' && actor.finishedAt !== null)
      ? Math.max(...actors.map((actor) => actor.finishedAt ?? 0))
      : null;
  let sends = 0;
  let expiries = 0;
  for (const event of view.events) {
    if (event.kind === 'send') sends++;
    if (
      event.kind === 'timer' &&
      event.data &&
      typeof event.data === 'object' &&
      !Array.isArray(event.data) &&
      'operation' in event.data &&
      event.data.operation === 'expire'
    )
      expiries++;
  }
  return { verdict, completionMs, sends, expiries };
}

/** Summarize only saved observations; deleted or never-started runs remain missing. */
export function summarizeBatch(records: readonly SavedRun[]) {
  const groups = new Map<string, { info: BatchRunInfo; records: SavedRun[] }>();
  for (const record of records) {
    const info = record.batch;
    if (!info) continue;
    const key = `${info.id}:${info.variantIndex}`;
    const group = groups.get(key) ?? { info, records: [] };
    group.records.push(record);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const metrics = group.records.map((record) => batchRunMetrics(record.view));
    const times = metrics.flatMap((metric) =>
      metric.completionMs === null ? [] : [metric.completionMs],
    );
    const pass = metrics.filter((metric) => metric.verdict === 'pass').length;
    const fail = metrics.filter((metric) => metric.verdict === 'fail').length;
    return {
      ...group,
      pass,
      fail,
      undetermined: metrics.length - pass - fail,
      missing: group.info.seeds.length - metrics.length,
      meanCompletionMs: times.length
        ? times.reduce((sum, value) => sum + value / times.length, 0)
        : null,
      completionSamples: times.length,
      meanSends: metrics.reduce((sum, value) => sum + value.sends / metrics.length, 0),
      meanExpiries: metrics.reduce((sum, value) => sum + value.expiries / metrics.length, 0),
    };
  });
}
