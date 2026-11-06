import type { ValidationResult } from '../domain/protocol-model.ts';
import type { StackSnapshot } from '../domain/stack-model.ts';
import { parseStackSnapshot, prepareStackSnapshot } from '../domain/stack-validation.ts';
import { StackScheduler, type StackSchedulerOptions } from '../engine/stack-scheduler.ts';

export type StackSimulationOptions = StackSchedulerOptions & { readonly runId?: string };
let nextRun = 0;
function assemble(
  snapshot: StackSnapshot,
  options: StackSimulationOptions,
): ValidationResult<StackScheduler> {
  try {
    return {
      success: true,
      value: new StackScheduler(
        snapshot,
        options.runId ?? `stack_${String(++nextRun).padStart(12, '0')}`,
        options,
      ),
    };
  } catch (error) {
    return {
      success: false,
      diagnostics: [
        {
          path: '/',
          code: 'stack-init',
          message: error instanceof Error ? error.message : 'Unable to initialize stack run',
        },
      ],
    };
  }
}

/** Validate/capture a separate stack run without putting it into the v1 App or workspace. */
export function createStackSimulation(
  input: unknown,
  options: StackSimulationOptions = {},
): ValidationResult<StackScheduler> {
  const prepared = prepareStackSnapshot(input);
  return prepared.success ? assemble(prepared.value, options) : prepared;
}

/** Rebuild only the exact supported stack snapshot/engine/random contract. */
export function createStackSimulationFromSnapshot(
  input: unknown,
  options: StackSimulationOptions = {},
): ValidationResult<StackScheduler> {
  const parsed = parseStackSnapshot(input);
  return parsed.success ? assemble(parsed.value, options) : parsed;
}

/** Fence late callbacks across cancel/reset/replacement; invalid drafts keep the current run alive. */
export function createStackRunSession(options: Omit<StackSimulationOptions, 'runId'> = {}): {
  readonly current: () => StackScheduler | undefined;
  readonly start: (input: unknown) => ValidationResult<StackScheduler>;
  readonly startSnapshot: (input: unknown) => ValidationResult<StackScheduler>;
  readonly apply: (runId: string, callback: (engine: StackScheduler) => void) => boolean;
  readonly reset: () => void;
} {
  let current: StackScheduler | undefined;
  const replace = (created: ValidationResult<StackScheduler>) => {
    if (created.success) {
      current?.cancel();
      current = created.value;
    }
    return created;
  };
  return {
    current: () => current,
    start: (input) => replace(createStackSimulation(input, options)),
    startSnapshot: (input) => replace(createStackSimulationFromSnapshot(input, options)),
    apply: (runId, callback) => {
      if (!current || current.runId !== runId || current.terminal) return false;
      callback(current);
      return true;
    },
    reset: () => {
      current?.cancel();
      current = undefined;
    },
  };
}
