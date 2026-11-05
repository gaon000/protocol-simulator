import type { EngineView, ValidationResult } from '../domain/protocol-model.ts';
import type { SavedRun } from '../domain/workspace-model.ts';
import type { SimulationEngine } from '../engine/simulation.ts';

/** Execute isolated engines in bounded slices, fencing all callbacks after cancellation. */
export function createRunSeries(plan: {
  readonly id: string;
  readonly totalRuns: number;
  readonly create: (index: number) => ValidationResult<SimulationEngine>;
  readonly capture: (view: EngineView, index: number) => SavedRun;
}) {
  let index = 0;
  let stopped = false;
  let engine: SimulationEngine | undefined;
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
        const created = plan.create(index);
        if (!created.success)
          throw new Error(created.diagnostics[0]?.message ?? '실행 초기화 실패');
        engine = created.value;
      }
      const view = engine.runBatch(64);
      if (view.status === 'paused') return;
      const record = plan.capture(view, index);
      index++;
      engine = undefined;
      return record;
    },
    cancel(): SavedRun | undefined {
      if (stopped || index >= plan.totalRuns) return;
      stopped = true;
      if (!engine) return;
      const record = plan.capture(engine.cancel(), index);
      index++;
      engine = undefined;
      return record;
    },
  };
}
