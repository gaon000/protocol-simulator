import { createSeededRandom } from '../domain/execution-contract.ts';
import { prepareExperimentSnapshot } from '../domain/model-validation.ts';
import type { ExperimentSnapshot, ValidationResult } from '../domain/protocol-model.ts';
import type { EnvironmentFactory } from '../engine/environment-port.ts';
import { SimulationEngine } from '../engine/simulation.ts';
import { createEnvironment } from '../environments/simulated-environment.ts';
import { parseRecordedSnapshot, snapshotCompatibility } from '../domain/workspace-validation.ts';

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
    const environment = (options.environmentFactory ?? createEnvironment)(
      snapshot.configuration.environment,
      createSeededRandom(snapshot.seed),
      snapshot.limits,
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
  readonly startSnapshot: (snapshot: unknown) => ValidationResult<SimulationEngine>;
  readonly reset: () => void;
  readonly apply: (runId: string, callback: (engine: SimulationEngine) => void) => boolean;
};

/** Fence callbacks by generation so reset or replacement cannot mutate the new run. */
export function createRunSession(options: Omit<SimulationOptions, 'runId'> = {}): RunSession {
  let current: SimulationEngine | undefined;
  function replace(
    created: ValidationResult<SimulationEngine>,
  ): ValidationResult<SimulationEngine> {
    if (created.success) {
      current?.cancel();
      current = created.value;
    }
    return created;
  }
  return {
    current: () => current,
    start: (input) => {
      const created = createSimulation(input, { ...options, runId: `run-${++nextRun}` });
      return replace(created);
    },
    startSnapshot: (snapshot) =>
      replace(createSimulationFromSnapshot(snapshot, { ...options, runId: `run-${++nextRun}` })),
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

/** Rebuild an isolated run only when snapshot versions, seed and captured limits are compatible. */
export function createSimulationFromSnapshot(
  input: unknown,
  options: Omit<SimulationOptions, 'limits'> = {},
): ValidationResult<SimulationEngine> {
  const parsed = parseRecordedSnapshot(input);
  if (!parsed.success) return parsed;
  const message = snapshotCompatibility(parsed.value);
  if (message)
    return {
      success: false,
      diagnostics: [{ path: '/snapshot/engineVersion', code: 'snapshot-version', message }],
    };
  return createSimulation(parsed.value.configuration, { ...options, limits: parsed.value.limits });
}
