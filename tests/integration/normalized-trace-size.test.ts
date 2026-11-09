import assert from 'node:assert/strict';
import test from 'node:test';
import { createSimulation } from '../../src/application/create-simulation.ts';
import { editExperiment } from '../../src/application/edit-experiment.ts';
import { captureRun, createWorkspace } from '../../src/application/workspace-operations.ts';
import { parseOwnedJsonData } from '../../src/domain/model-validation.ts';
import { parseWorkspaceData } from '../../src/domain/workspace-validation.ts';
import { WORKSPACE_POLICY } from '../../src/domain/workspace-model.ts';
import { createMessageLimitExperiment } from '../fixtures/large-experiments.ts';

test('cached immutable event sizes preserve exact normalized-runId trace limits and fresh-data checks', () => {
  const configuration = editExperiment(
    createMessageLimitExperiment(),
    '/definitions/0/messages/0/fields/0/defaultValue',
    '한글🧪\n"\\\ud800',
  );
  let previousSize: number | undefined;
  for (const runId of ['r_short', `r_${'x'.repeat(512)}`]) {
    const created = createSimulation(configuration, { runId });
    assert.ok(created.success);
    const view = created.value.run();
    const size = view.events.reduce(
      (sum, event) =>
        sum + new TextEncoder().encode(JSON.stringify({ ...event, runId: '' })).length,
      0,
    );
    if (previousSize !== undefined) assert.equal(size, previousSize);
    previousSize = size;
    const workspace = createWorkspace(configuration);
    const saved = captureRun(view, workspace.activeDraftId, 1);
    for (const delta of [0, -1]) {
      const data = {
        ...workspace,
        runs: [
          {
            ...saved,
            view: {
              ...view,
              snapshot: {
                ...view.snapshot,
                limits: { ...view.snapshot.limits, maxTraceBytes: size + delta },
              },
            },
          },
        ],
      };
      const external = structuredClone(data);
      const plain = parseWorkspaceData(external);
      const owned = parseOwnedJsonData(structuredClone(data), {
        maxNodes: WORKSPACE_POLICY.maxJsonNodes,
        maxDepth: WORKSPACE_POLICY.maxJsonDepth,
      });
      assert.ok(owned.success);
      const checked = parseWorkspaceData(owned.value);
      assert.equal(plain.success, delta === 0);
      assert.equal(checked.success, plain.success);
      if (!plain.success && !checked.success)
        assert.deepEqual(checked.diagnostics, plain.diagnostics);
    }
  }
});
