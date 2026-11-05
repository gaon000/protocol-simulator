import {
  createSimulation,
  type SimulationOptions,
} from '../../src/application/create-simulation.ts';
import { captureRun } from '../../src/application/workspace-operations.ts';
import type { ExperimentDefinition } from '../../src/domain/protocol-model.ts';
import type { SavedRun } from '../../src/domain/workspace-model.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';

/** Capture a genuine engine result with one stable workspace identity for two-run comparisons. */
export function runComparisonRecord(
  configuration: ExperimentDefinition = createPingPongExperiment(),
  options: SimulationOptions = {},
): SavedRun {
  const simulation = createSimulation(configuration, options);
  if (!simulation.success) throw new Error(JSON.stringify(simulation.diagnostics));
  return captureRun(simulation.value.run(), 'comparison_experiment', 1);
}
