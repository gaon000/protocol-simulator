import assert from 'node:assert/strict';
import test from 'node:test';
import { createStackSimulation } from '../../src/application/create-stack-simulation.ts';
import {
  editStackExperiment,
  retainedStackRaw,
  synchronizeStackMessages,
} from '../../src/application/edit-stack.ts';
import { createLegacyWorkspaceFacade } from '../../src/application/legacy-workspace-facade.ts';
import { buildStackPanelModel } from '../../src/application/stack-panel-model.ts';
import { compareStackReplay, projectStackRecord } from '../../src/application/stack-replay.ts';
import { StackWorkerClient } from '../../src/application/stack-worker-client.ts';
import { createWorkspace } from '../../src/application/workspace-operations.ts';
import { createWorkspaceV2Controller } from '../../src/application/workspace-v2-controller.ts';
import {
  captureStackRun,
  createWorkspaceV2,
} from '../../src/application/workspace-v2-operations.ts';
import { parseStackView } from '../../src/domain/stack-record.ts';
import { parseStackExperiment } from '../../src/domain/stack-validation.ts';
import type { WorkspaceV2 } from '../../src/domain/workspace-v2-model.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';
import { createStackExampleCopy } from '../../src/examples/reliable-stack-examples.ts';
import type { VersionedStoragePort } from '../../src/persistence/storage-port.ts';
import { largeStackEvents } from '../fixtures/large-stacks.ts';

function engine() {
  const result = createStackSimulation(createStackExampleCopy('stack_first_ack_loss'));
  if (!result.success) assert.fail(JSON.stringify(result.diagnostics));
  return result.value;
}

test('form revisions rebind exact peers while preserving previous source and historical snapshots', () => {
  const before = createStackExampleCopy('stack_ping_pong');
  const next = editStackExperiment(before, '/definitions/0/source/label', '새 이름');
  assert.notEqual(next, before);
  assert.equal(next.definitions[0]?.revision, (before.definitions[0]?.revision ?? 0) + 1);
  assert.equal(next.nodes.A.instances[0]?.definition.revision, next.definitions[0]?.revision);
  assert.equal(next.nodes.B.instances[0]?.definition.revision, next.definitions[0]?.revision);
  assert.equal(next.definitions[0]?.mode, 'legacy-application');
  assert.equal(before.definitions[0]?.revision, 1);
  assert.equal(parseStackExperiment(next).success, true);
});
test('instance rename updates only its own stable participant references and retains unfinished editors', () => {
  const before = createStackExampleCopy('stack_ping_pong');
  const next = editStackExperiment(before, '/nodes/A/instances/0/id', 'client');
  assert.equal(next.bindings[0]?.consumer.instanceId, 'client');
  assert.equal(next.scenario.inputs[0]?.target.instanceId, 'client');
  assert.equal(next.nodes.B.instances[0]?.id, 'app');
  assert.equal(parseStackExperiment(next).success, true);
  assert.deepEqual(
    retainedStackRaw(
      {
        '/scenario/inputs/0/message': '{',
        '/definitions/0/source/label': '"old"',
        '/missing': '{',
      },
      next,
      '/definitions/0/source/label',
    ),
    { '/scenario/inputs/0/message': '{' },
  );
  assert.equal(editStackExperiment(before, '/absent/property', 3), before);
});
test('explicit packet schema sync updates both transport peers without changing old values', () => {
  const before = createStackExampleCopy('stack_ping_pong');
  const native = before.definitions.find((d) => d.mode === 'stack-protocol');
  assert.ok(native && native.mode === 'stack-protocol');
  const next = synchronizeStackMessages(before, native);
  assert.equal(parseStackExperiment(next).success, true);
  assert.equal(before.definitions.find((d) => d.id === native.id)?.revision, 1);
  assert.ok(
    next.definitions.filter((d) => d.mode === 'stack-protocol').every((d) => d.revision > 1),
  );
});
test('one v2 controller projects legacy changes without copying or deleting owned stacked observations', async () => {
  const source = createWorkspaceV2(
    createWorkspace(createPingPongExperiment()),
    createStackExampleCopy('stack_ping_pong'),
  );
  const captured = captureStackRun(engine().run(), 'owner', 1);
  const initial = { ...source, stack: { ...source.stack, runs: [captured] } };
  let saved: WorkspaceV2 | undefined;
  const port: VersionedStoragePort<WorkspaceV2> = {
    read: async () => undefined,
    write: async (data) => {
      saved = data;
      return 1;
    },
  };
  const controller = createWorkspaceV2Controller(port, initial);
  await controller.load();
  const facade = createLegacyWorkspaceFacade(controller);
  const own = controller.view().data.stack.runs[0];
  facade.update((legacy) => ({
    ...legacy,
    drafts: legacy.drafts.map((draft) => ({
      ...draft,
      configuration: { ...draft.configuration, label: '새 단일 계층' },
    })),
  }));
  assert.equal(controller.view().data.stack.runs[0], own);
  assert.equal(own, captured);
  assert.equal(facade.view().data.drafts[0]?.configuration.label, '새 단일 계층');
  await facade.save();
  assert.equal(saved?.stack.runs[0], captured);
});
test('buffer checkpoints remain optional for old records and absent in unobserved history prefixes', () => {
  const simulator = engine();
  const view = simulator.run();
  assert.ok(Object.values(view.instances).every((i) => i.buffers && i.buffers.codecBytes === 0));
  const record = captureStackRun(view, 'owner', 1);
  const prefix = projectStackRecord(record, 3);
  assert.ok(prefix.success);
  assert.ok(Object.values(prefix.value.instances).every((i) => i.buffers === undefined));
  const old = {
    ...record,
    view: {
      ...view,
      instances: Object.fromEntries(
        Object.entries(view.instances).map(([id, { buffers: _, ...actor }]) => [id, actor]),
      ),
    },
  };
  assert.equal(parseStackView(old.view).success, true);
  assert.equal(compareStackReplay(old, view), 'same');
});
test('bounded worker presentation never exposes future selection, payload values or more than one page', () => {
  const record = captureStackRun(engine().run(), 'owner', 1);
  const query = {
    cursor: 0,
    endpoint: { participant: 'A' as const, instanceId: 'app' },
    page: 0,
    statePage: 0,
    rulePage: 0,
    layer: 'all' as const,
    filterTarget: false,
    eventId: record.view.events.at(-1)?.eventId ?? '',
    detail: 'event' as const,
    bytePage: 0,
    rangeIndex: 0,
  };
  const initial = buildStackPanelModel(record, query);
  assert.equal(initial.status, 'available');
  if (initial.status !== 'available') return;
  assert.equal(initial.selected, undefined);
  assert.equal(initial.sequence?.rows.length, 0);
  assert.equal(initial.globalBytes, undefined);
  const final = buildStackPanelModel(record, { ...query, cursor: record.view.events.length + 1 });
  assert.equal(final.status, 'available');
  if (final.status === 'available') {
    assert.ok((final.sequence?.rows.length ?? 0) <= 30);
    assert.ok(JSON.stringify(final).length < 32768);
  }
});
test('worker client rejects stale pending requests on close and discards delayed old responses', async () => {
  const fake = {
    onmessage: null,
    onerror: null,
    terminate: () => {},
    postMessage: () => {},
  } as unknown as Worker;
  const client = new StackWorkerClient(fake);
  const pending = client.request({ type: 'forget', id: 'missing' });
  let events = 0;
  client.onEvent = () => {
    events++;
  };
  client.close();
  await assert.rejects(pending, /닫았습니다/);
  fake.onmessage?.({
    data: { type: 'series-progress', id: 'old', finished: 0, total: 1, done: false },
  } as MessageEvent);
  assert.equal(events, 0);
  await assert.rejects(client.request({ type: 'forget', id: 'x' }), /닫혔습니다/);
});
test('large stack fixture reaches exactly ten thousand native trace events by atomic timer operations', () => {
  const created = createStackSimulation(largeStackEvents());
  assert.ok(created.success);
  const view = created.value.run();
  assert.equal(view.status, 'limit-reached');
  assert.equal(view.events.length, 10000);
  assert.equal(parseStackView(view).success, true);
});

test('an unfinished empty instance ID can be repaired without leaving old empty endpoint references', () => {
  const before = createStackExampleCopy('stack_ping_pong');
  const empty = editStackExperiment(before, '/nodes/A/instances/0/id', '');
  const repaired = editStackExperiment(empty, '/nodes/A/instances/0/id', 'app');
  assert.equal(parseStackExperiment(repaired).success, true);
});

test('native save worker keeps quota/conflict codes and rejects outstanding requests after close', async () => {
  const { createWorkerStorage } = await import('../../src/persistence/worker-storage.ts');
  const sent: { id: number; type: string }[] = [];
  const fake = {
    onmessage: null,
    onerror: null,
    terminate: () => {},
    postMessage: (message: { id: number; type: string }) => sent.push(message),
  } as unknown as Worker;
  const port = createWorkerStorage(() => fake);
  const pending = port.read();
  const id = sent[0]?.id;
  assert.ok(id);
  fake.onmessage?.({
    data: { id, error: { code: 'conflict', message: 'native CAS' } },
  } as MessageEvent);
  await assert.rejects(
    pending,
    (e: unknown) => e instanceof Error && 'code' in e && e.code === 'conflict',
  );
  const backup = port.readLegacyBackup();
  port.close();
  await assert.rejects(backup, /닫았습니다/);
  await assert.rejects(port.read(), /닫혔습니다/);
});

test('nonfinite unfinished JSON stays recoverable as raw draft text but cannot start a series', async () => {
  const { parseWorkspaceV2 } = await import('../../src/domain/workspace-v2-validation.ts');
  const { prepareStackSeries } = await import('../../src/application/stack-series.ts');
  const data = createWorkspaceV2(
    createWorkspace(createPingPongExperiment()),
    createStackExampleCopy('stack_ping_pong'),
  );
  const original = data.stack.drafts[0];
  assert.ok(original);
  const draft = { ...original, raw: { '/seed': '1e999' } };
  const workspace = { ...data, stack: { ...data.stack, drafts: [draft] } };
  assert.equal(parseWorkspaceV2(workspace).success, true);
  assert.equal(
    prepareStackSeries(draft, workspace, { kind: 'batch', label: 'test', seeds: [1] }).success,
    false,
  );
});

test('deleting a positional row drops pending sibling JSON rather than attaching it to a shifted rule', () => {
  const before = createStackExampleCopy('stack_ping_pong');
  const after = editStackExperiment(before, '/definitions/0/source/rules/0', undefined);
  assert.deepEqual(
    retainedStackRaw(
      { '/definitions/0/source/rules/1/event': '{' },
      before,
      '/definitions/0/source/rules/0',
    ),
    { '/definitions/0/source/rules/1/event': '{' },
  );
  assert.deepEqual(
    retainedStackRaw(
      { '/definitions/0/source/rules/1/event': '{' },
      after,
      '/definitions/0/source/rules/0',
      true,
    ),
    {},
  );
});

test('comparing an old checkpoint with missing buffer observations stays limited instead of inventing a changed byte count', async () => {
  const { compareStackRuns } = await import('../../src/application/stack-comparison.ts');
  const record = captureStackRun(engine().run(), 'owner', 1);
  const old = {
    ...record,
    id: 'old',
    view: {
      ...record.view,
      instances: Object.fromEntries(
        Object.entries(record.view.instances).map(([id, { buffers: _, ...actor }]) => [id, actor]),
      ),
    },
  };
  const result = compareStackRuns(old, record);
  assert.equal(result.status, 'limited');
  assert.ok(
    result.differences.some((d) => d.path.endsWith('/buffers') && d.relation === 'limited'),
  );
});

test('validated immutable workspace caching never trusts ownership alone or mutable external data', async () => {
  const { freezeOwned } = await import('../../src/domain/immutable-data.ts');
  const { parseWorkspaceV2 } = await import('../../src/domain/workspace-v2-validation.ts');
  const valid = freezeOwned(createWorkspaceV2(createWorkspace(createPingPongExperiment())));
  assert.equal(parseWorkspaceV2(valid).success, true);
  assert.equal(parseWorkspaceV2(valid).success, true);
  const mutable = structuredClone(valid);
  assert.equal(parseWorkspaceV2(mutable).success, true);
  Object.assign(mutable, { schemaVersion: 999 });
  assert.equal(parseWorkspaceV2(mutable).success, false);
  assert.equal(parseWorkspaceV2(freezeOwned(mutable)).success, false);
});

test('save worker reuses only the exact validated immutable payload and never ignores a mutable write', async () => {
  const { createWorkerStorage } = await import('../../src/persistence/worker-storage.ts');
  const sent: { id: number; type: string; data?: unknown; token?: number }[] = [];
  const fake = {
    onmessage: null,
    onerror: null,
    terminate: () => {},
    postMessage: (message: { id: number; type: string; data?: unknown; token?: number }) => {
      sent.push(message);
      fake.onmessage?.({
        data: {
          id: message.id,
          value: message.type === 'validate' ? { success: true, token: 42 } : 1,
        },
      } as MessageEvent);
    },
  } as unknown as Worker;
  const port = createWorkerStorage(() => fake);
  const source = createWorkspaceV2(createWorkspace(createPingPongExperiment()));
  const valid = await port.validation.workspace(source);
  assert.ok(valid.success);
  await port.write(valid.value, null);
  assert.equal(sent.at(-1)?.token, 42);
  assert.equal(sent.at(-1)?.data, undefined);
  const mutable = structuredClone(source);
  await port.write(mutable, 1);
  assert.equal(sent.at(-1)?.token, undefined);
  assert.equal(sent.at(-1)?.data, mutable);
  port.close();
});

test('shape-invalid but syntactically valid pending JSON round-trips without approving a renderable divergent value', async () => {
  const { parseWorkspaceV2 } = await import('../../src/domain/workspace-v2-validation.ts');
  const data = createWorkspaceV2(
    createWorkspace(createPingPongExperiment()),
    createStackExampleCopy('stack_ping_pong'),
  );
  const original = data.stack.drafts[0];
  assert.ok(original);
  const check = (raw: Readonly<Record<string, string>>) =>
    parseWorkspaceV2({ ...data, stack: { ...data.stack, drafts: [{ ...original, raw }] } });
  assert.equal(check({ '/definitions/0/requires': '{}' }).success, true);
  assert.equal(check({ '/definitions/0/source/timers': '{}' }).success, true);
  assert.equal(check({ '/seed': '3' }).success, false);
});

test('lazy JSON paths retain exact finite-value, accessor, depth and repeated-alias node-budget diagnostics', async () => {
  const { parseJsonData } = await import('../../src/domain/model-validation.ts');
  const path = (value: unknown, limits?: { maxNodes: number; maxDepth: number }) => {
    const result = limits ? parseJsonData(value, limits) : parseJsonData(value);
    assert.equal(result.success, false);
    return result.success ? [] : result.diagnostics.map((d) => [d.path, d.code]);
  };
  assert.deepEqual(path({ a: [1, true, null, Infinity] }), [['/a/3', 'json-value']]);
  assert.deepEqual(path({ a: [1] }, { maxNodes: 10, maxDepth: 1 }), [['/a/0', 'json-depth']]);
  const shared = [1, 2];
  assert.deepEqual(path([shared, shared], { maxNodes: 6, maxDepth: 10 }), [['/1/1', 'json-limit']]);
  let reads = 0;
  const array: unknown[] = [];
  Object.defineProperty(array, 0, {
    enumerable: true,
    get() {
      reads++;
      return 1;
    },
  });
  assert.deepEqual(path({ a: array }), [['/a/0', 'json-value']]);
  assert.equal(reads, 0);
});
