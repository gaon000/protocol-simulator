import { createStackSimulation } from '../../src/application/create-stack-simulation.ts';
import {
  createStackSeriesSession,
  prepareStackSeries,
} from '../../src/application/stack-series.ts';
import { createWorkspace } from '../../src/application/workspace-operations.ts';
import { createWorkspaceV2 } from '../../src/application/workspace-v2-operations.ts';
import type { SavedStackRun } from '../../src/domain/workspace-v2-model.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';
import { createReliableStackExperiment } from '../../src/examples/reliable-stack-examples.ts';
import { createEventLimitExperiment, createMessageLimitExperiment } from './large-experiments.ts';

/** Exercise the real four-instance scheduler until its native trace budget, with no fabricated events. */
export function largeStackEvents(traceLimit = 10000) {
  const application = createEventLimitExperiment();
  const definition = application.definitions[0];
  if (!definition) throw new Error('Missing timer app');
  const stack = createReliableStackExperiment({
    ...application,
    definitions: [
      {
        ...definition,
        rules: definition.rules.map((rule, index) =>
          index ? rule : { ...rule, actions: [...rule.actions, ...rule.actions] },
        ),
      },
    ],
  });
  return {
    ...stack,
    label: `실제 스택 ${traceLimit} 관찰`,
    limits: { ...stack.limits, maxTraceEvents: traceLimit },
  };
}
/** Transfer one actual one-MiB app frame through sixteen acknowledged provider fragments. */
export function largeStackFrame() {
  return createReliableStackExperiment(createMessageLimitExperiment(), {
    chunkBytes: 65536,
    observationMs: 1000,
  });
}
/** Generate a bounded but substantial twenty-case group using the same actual compiled engine contract. */
export function largeStackSuite() {
  const base = createWorkspaceV2(
    createWorkspace(createPingPongExperiment()),
    largeStackEvents(601),
  );
  const original = base.stack.drafts[0];
  if (!original) throw new Error('Missing draft');
  const draft = {
    ...original,
    suite: {
      id: 'large_stack_suite',
      revision: 1,
      label: '스택 20사례',
      cases: Array.from({ length: 20 }, (_, index) => ({
        id: `case_${index}`,
        label: `사례 ${index + 1}`,
        enabled: true,
        seed: index,
        scenario: original.configuration.scenario,
        environment: original.configuration.link.environment,
      })),
    },
  };
  const plan = prepareStackSeries(draft, base, { kind: 'regression', label: '스택 20사례' });
  if (!plan.success) throw new Error(JSON.stringify(plan.diagnostics));
  const session = createStackSeriesSession(plan.value);
  const runs: SavedStackRun[] = [];
  while (!session.progress().done) {
    const record = session.advance();
    if (record) runs.push(record);
  }
  return { ...base, stack: { activeDraftId: draft.id, drafts: [draft], runs } };
}
/** Execute and assert that a fixture really reaches a native engine terminal boundary. */
export function runLargeStack(configuration = largeStackEvents()) {
  const created = createStackSimulation(configuration);
  if (!created.success) throw new Error(JSON.stringify(created.diagnostics));
  return created.value.run();
}
