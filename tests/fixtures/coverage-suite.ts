import {
  createRegressionSession,
  createScenarioSuite,
  prepareRegression,
} from '../../src/application/scenario-suites.ts';
import { createDraftRecord } from '../../src/application/workspace-operations.ts';
import type { ExperimentDefinition } from '../../src/domain/protocol-model.ts';
import type { DraftRecord, SavedRun } from '../../src/domain/workspace-model.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';
import { createSuiteDraft } from './scenario-suite.ts';

/** Execute genuine suite engines, preserving their frozen metadata and complete event traces. */
export function runCoverageSuite(draft = createSuiteDraft()): SavedRun[] {
  const plan = prepareRegression(draft, 100);
  if (!plan.success) throw new Error(JSON.stringify(plan.diagnostics));
  const session = createRegressionSession(plan.value);
  const records: SavedRun[] = [];
  while (!session.progress().done) {
    const record = session.advance();
    if (record) records.push(record);
  }
  return records;
}

/** Create independently identified cases sharing exactly one protocol source. */
export function createCoverageDraft(configuration: ExperimentDefinition, count = 1): DraftRecord {
  const draft = createDraftRecord(configuration);
  const suite = createScenarioSuite(draft);
  const first = suite.cases[0];
  if (!first) throw new Error('Missing case');
  return {
    ...draft,
    suite: {
      ...suite,
      cases: Array.from({ length: count }, (_, index) => ({
        ...first,
        id: `coverage_${index}`,
        label: `관찰 사례 ${index + 1}`,
      })),
    },
  };
}

/** Exercise parallel-rule attribution and both rule/state pagination on an actual executable definition. */
export function createPagedCoverageDraft(): DraftRecord {
  const configuration = createPingPongExperiment();
  const protocol = configuration.definitions[0];
  const start = protocol?.rules[0];
  if (!protocol || !start) throw new Error('Missing protocol');
  return createCoverageDraft({
    ...configuration,
    definitions: [
      {
        ...protocol,
        states: [
          ...protocol.states,
          ...Array.from({ length: 45 }, (_, index) => ({
            id: `extra_${index}`,
            label: `추가 상태 ${index}`,
          })),
        ],
        rules: [
          ...protocol.rules.map((rule, index) =>
            index
              ? rule
              : {
                  ...rule,
                  condition: {
                    kind: 'compare' as const,
                    operator: 'eq' as const,
                    left: { kind: 'literal' as const, value: 1 },
                    right: { kind: 'literal' as const, value: 1 },
                  },
                },
          ),
          {
            ...start,
            id: 'parallel_unobserved',
            condition: {
              kind: 'compare',
              operator: 'eq',
              left: { kind: 'literal', value: 0 },
              right: { kind: 'literal', value: 1 },
            },
          },
          ...Array.from({ length: 25 }, (_, index) => ({
            ...start,
            id: `unused_${index}`,
            fromStateId: `extra_${index}`,
            nextStateId: `extra_${index}`,
            actions: [],
            ignore: true,
          })),
        ],
      },
    ],
  });
}
