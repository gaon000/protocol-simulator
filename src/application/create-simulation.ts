import { createSeededRandom } from '../domain/execution-contract.ts';
import { prepareExperimentSnapshot } from '../domain/model-validation.ts';
import type { ExperimentSnapshot, ValidationResult } from '../domain/protocol-model.ts';
import type { EnvironmentFactory } from '../engine/environment-port.ts';
import { SimulationEngine } from '../engine/simulation.ts';
import { createIdealEnvironment } from '../environments/ideal-environment.ts';

export type SimulationOptions = {
  readonly environmentFactory?: EnvironmentFactory;
  readonly runId?: string;
  readonly limits?: Partial<ExperimentSnapshot['limits']>;
};
let nextRun = 0;

/** Validate, capture and assemble an isolated run with an injected lower-service implementation. */
export function createSimulation(
  input: unknown,
  options: SimulationOptions = {},
): ValidationResult<SimulationEngine> {
  const prepared = prepareExperimentSnapshot(input);
  if (!prepared.success) return prepared;
  const limits = { ...prepared.value.limits, ...options.limits };
  for (const [key, maximum] of Object.entries(prepared.value.limits)) {
    const value = limits[key as keyof typeof limits];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      return {
        success: false,
        diagnostics: [
          {
            path: `/limits/${key}`,
            code: 'limit-range',
            message: 'Run limits must be positive integers within execution policy',
          },
        ],
      };
  }
  const snapshot: ExperimentSnapshot = Object.freeze({
    ...prepared.value,
    limits: Object.freeze(limits),
  });
  try {
    const environment = (options.environmentFactory ?? createIdealEnvironment)(
      snapshot.configuration.environment,
      createSeededRandom(snapshot.seed),
    );
    if (!environment.success) return environment;
    return {
      success: true,
      value: new SimulationEngine(snapshot, environment.value, options.runId ?? `run-${++nextRun}`),
    };
  } catch (error) {
    return {
      success: false,
      diagnostics: [
        {
          path: '/',
          code: 'engine-init',
          message: error instanceof Error ? error.message : 'Unable to initialize run',
        },
      ],
    };
  }
}

export type RunSession = {
  readonly current: () => SimulationEngine | undefined;
  readonly start: (input: unknown) => ValidationResult<SimulationEngine>;
  readonly reset: () => void;
  readonly apply: (runId: string, callback: (engine: SimulationEngine) => void) => boolean;
};

/** Fence callbacks by generation so reset or replacement cannot mutate the new run. */
export function createRunSession(options: Omit<SimulationOptions, 'runId'> = {}): RunSession {
  let current: SimulationEngine | undefined;
  return {
    current: () => current,
    start: (input) => {
      const created = createSimulation(input, { ...options, runId: `run-${++nextRun}` });
      if (created.success) {
        current?.cancel();
        current = created.value;
      }
      return created;
    },
    reset: () => {
      current?.cancel();
      current = undefined;
    },
    apply: (runId, callback) => {
      if (!current || current.runId !== runId) return false;
      callback(current);
      return true;
    },
  };
}
