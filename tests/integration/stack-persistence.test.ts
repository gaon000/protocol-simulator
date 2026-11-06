import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createStackRunSession,
  createStackSimulation,
  createStackSimulationFromSnapshot,
} from '../../src/application/create-stack-simulation.ts';
import { compareStackReplay, projectStackRecord } from '../../src/application/stack-replay.ts';
import { createWorkspace } from '../../src/application/workspace-operations.ts';
import { createWorkspaceV2Controller } from '../../src/application/workspace-v2-controller.ts';
import {
  captureStackRun,
  createWorkspaceV2,
  exportLegacyFromV2,
  exportWorkspaceV2,
  stageWorkspaceV2Bundle,
} from '../../src/application/workspace-v2-operations.ts';
import type { ValidationResult } from '../../src/domain/protocol-model.ts';
import { parseStackView, stackObject } from '../../src/domain/stack-record.ts';
import type { WorkspaceV2 } from '../../src/domain/workspace-v2-model.ts';
import {
  parseWorkspaceV2,
  parseWorkspaceV2Bundle,
} from '../../src/domain/workspace-v2-validation.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';
import { STACK_EXAMPLES } from '../../src/examples/reliable-stack-examples.ts';
import { StorageFailure, type VersionedStoragePort } from '../../src/persistence/storage-port.ts';

function ok<T>(result: ValidationResult<T>): T {
  if (!result.success) assert.fail(JSON.stringify(result.diagnostics.slice(0, 4)));
  return result.value;
}
function data() {
  return createWorkspaceV2(createWorkspace(createPingPongExperiment()), STACK_EXAMPLES[1]?.build());
}
function recorded(partial = false) {
  const workspace = data();
  const draft = workspace.stack.drafts[0];
  assert.ok(draft);
  const engine = ok(createStackSimulation(draft.configuration));
  const view = partial ? engine.runBatch(12) : engine.run();
  return {
    ...workspace,
    stack: { ...workspace.stack, runs: [captureStackRun(view, draft.id, 1)] },
  };
}

for (const example of STACK_EXAMPLES)
  test(`saved stack ${example.id} validates and reconstructs every committed endpoint`, () => {
    const engine = ok(createStackSimulation(example.build()));
    const view = engine.run();
    ok(parseStackView(view));
    const record = captureStackRun(view, 'draft', 1);
    const zero = ok(projectStackRecord(record, 0));
    assert.equal(zero.events.length, 0);
    assert.equal(zero.artifacts.payloads.length, 0);
    assert.equal(Object.keys(zero.instances).length, 4);
    for (const target of ['A/app', 'B/app', 'A/transport', 'B/transport']) {
      const transition = view.events.find(
        (e) =>
          `${e.endpoint.participant}/${e.endpoint.instanceId}` === target &&
          e.kind === 'transition',
      );
      assert.ok(transition);
      const cursor = view.events.indexOf(transition) + 1;
      const projected = ok(projectStackRecord(record, cursor));
      assert.equal(projected.events.length, cursor);
      assert.equal(
        projected.instances[target]?.stateId,
        stackObject(stackObject(transition.data).after).stateId,
      );
      assert.ok(projected.expectations.every((e) => e.status === 'undetermined'));
      assert.ok(projected.events.every((e) => e.sequence <= transition.sequence));
    }
    assert.deepEqual(ok(projectStackRecord(record, view.events.length + 1)), view);
    assert.equal(
      compareStackReplay(record, ok(createStackSimulationFromSnapshot(view.snapshot)).run()),
      'same',
    );
  });

test('v2 bundle stages both modes, remaps collisions and leaves actual snapshot/event/payload identities untouched', () => {
  const original = recorded();
  ok(parseWorkspaceV2(original));
  const text = ok(exportWorkspaceV2(original));
  assert.deepEqual(ok(parseWorkspaceV2Bundle(text)).data, original);
  const merged = ok(stageWorkspaceV2Bundle(text, original));
  assert.equal(merged.stack.drafts.length, 2);
  assert.equal(merged.stack.runs.length, 2);
  assert.notEqual(merged.stack.drafts[0]?.id, merged.stack.drafts[1]?.id);
  assert.notEqual(merged.stack.runs[0]?.id, merged.stack.runs[1]?.id);
  assert.deepEqual(merged.stack.runs[0]?.view, merged.stack.runs[1]?.view);
  assert.equal(merged.stack.runs[1]?.experimentId, merged.stack.drafts[1]?.id);
  assert.equal(exportLegacyFromV2(original).success, false);
  assert.equal(exportLegacyFromV2(original, true).success, true);
  const legacyBundle = JSON.stringify({
    schemaVersion: 1,
    kind: 'protocol-studio-bundle',
    data: original.legacy,
  });
  assert.deepEqual(ok(parseWorkspaceV2Bundle(legacyBundle)).data.legacy, original.legacy);
});

test('invalid origin, endpoint, typed range, trace order and snapshot version cannot silently enter execution', () => {
  const original = recorded();
  const view = original.stack.runs[0]?.view;
  assert.ok(view);
  for (const change of [
    (v: Record<string, unknown>) => {
      v.mode = 'legacy';
    },
    (v: Record<string, unknown>) => {
      v.schemaVersion = 99;
    },
    (v: Record<string, unknown>) => {
      const first = (v.events as Record<string, unknown>[])[0];
      assert.ok(first);
      first.endpoint = {
        participant: 'A',
        instanceId: 'absent',
      };
    },
    (v: Record<string, unknown>) => {
      const range = (v.events as { payloads: { payloadId: string }[] }[]).find(
        (e) => e.payloads.length,
      )?.payloads[0];
      assert.ok(range);
      range.payloadId = 'absent';
    },
  ]) {
    const copy = structuredClone(view) as unknown as Record<string, unknown>;
    change(copy);
    assert.equal(parseStackView(copy).success, false);
  }
  const future = { ...view, snapshot: { ...view.snapshot, engineVersion: 'stack-future' } };
  ok(parseStackView(future));
  assert.equal(createStackSimulationFromSnapshot(future.snapshot).success, false);
  assert.equal(projectStackRecord(captureStackRun(future, 'draft', 1), 0).success, false);
});

test('cancelled records preserve actual bytes across reset, draft deletion, bundle roundtrip and snapshot prefix replay', () => {
  const workspace = recorded(true);
  const draft = workspace.stack.drafts[0];
  assert.ok(draft);
  const session = createStackRunSession();
  const engine = ok(session.start(draft.configuration));
  engine.runBatch(12);
  const record = captureStackRun(engine.cancel(), draft.id, 1);
  const before = JSON.stringify(record);
  session.reset();
  const restored = ok(
    parseWorkspaceV2Bundle(
      ok(
        exportWorkspaceV2({
          ...workspace,
          stack: { activeDraftId: null, drafts: [], runs: [record] },
        }),
      ),
    ),
  ).data.stack.runs[0];
  assert.ok(restored);
  assert.equal(JSON.stringify(restored), before);
  assert.ok(restored.view.artifacts.payloads.length > 0);
  assert.equal(
    compareStackReplay(restored, ok(createStackSimulationFromSnapshot(record.view.snapshot)).run()),
    'same',
  );
});

test('v2 controller preserves memory on quota and merges divergent native revisions as copies', async () => {
  let stored: { schemaVersion: 2; revision: number; data: WorkspaceV2 } | undefined;
  let quota = false;
  const port: VersionedStoragePort<WorkspaceV2> = {
    read: async () => structuredClone(stored),
    write: async (data, revision) => {
      if (quota) throw new StorageFailure('quota', 'quota');
      if ((stored?.revision ?? null) !== revision) throw new StorageFailure('conflict', 'conflict');
      const next = (revision ?? 0) + 1;
      stored = { schemaVersion: 2, revision: next, data: structuredClone(data) };
      return next;
    },
  };
  const a = createWorkspaceV2Controller(port, recorded());
  await a.load();
  await a.save();
  const b = createWorkspaceV2Controller(port, data());
  await b.load();
  const change = (workspace: WorkspaceV2) => ({
    ...workspace,
    stack: {
      ...workspace.stack,
      drafts: workspace.stack.drafts.map((d) => ({ ...d, version: d.version + 1 })),
    },
  });
  a.update(change);
  quota = true;
  await a.save();
  assert.equal(a.view().status, 'error');
  quota = false;
  await a.retry();
  assert.equal(a.view().status, 'saved');
  b.update((current) => change(change(current)));
  await b.save();
  assert.equal(b.view().status, 'conflict');
  await b.retry();
  assert.equal(b.view().status, 'saved');
  assert.equal(b.view().data.stack.drafts.length, 2);
});
