import type { JsonValue } from './execution-contract.ts';
import type { StackExperiment } from './stack-model.ts';

/** Compare JSON structurally, preserving array order and scalar types. Call only after JSON validation. */
export function canonicalStackJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStackJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalStackJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
/** Freeze all definitions, topology and global budgets as a series' common source. */
export function stackCommonSource(configuration: StackExperiment): JsonValue {
  return {
    definitions: configuration.definitions,
    nodes: configuration.nodes,
    bindings: configuration.bindings,
    link: { id: configuration.link.id, A: configuration.link.A, B: configuration.link.B },
    limits: configuration.limits,
  } as unknown as JsonValue;
}
/** Identify an actual case's complete input, expectation, environment and seed contract. */
export function stackCaseCondition(configuration: StackExperiment): JsonValue {
  return {
    scenario: configuration.scenario,
    environment: configuration.link.environment,
    seed: configuration.seed,
  } as unknown as JsonValue;
}
