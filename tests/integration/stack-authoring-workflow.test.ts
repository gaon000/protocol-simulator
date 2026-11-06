import assert from 'node:assert/strict';
import test from 'node:test';
import { createNewStack, NEW_STACK_DEFAULTS } from '../../src/application/new-stack.ts';
import { createStackEditHistory } from '../../src/application/stack-edit-history.ts';
import { editStackExperiment } from '../../src/application/edit-stack.ts';
import { editStackList } from '../../src/application/edit-stack-list.ts';
import { createStackSimulation } from '../../src/application/create-stack-simulation.ts';
import {
  createStackDraft,
  createWorkspaceV2,
} from '../../src/application/workspace-v2-operations.ts';
import { createWorkspace } from '../../src/application/workspace-operations.ts';
import { createWorkspaceV2Controller } from '../../src/application/workspace-v2-controller.ts';
import { StorageFailure } from '../../src/persistence/storage-port.ts';
import { freezeOwned } from '../../src/domain/immutable-data.ts';
import {
  parseStackExperiment,
  parseStackExperimentDraft,
} from '../../src/domain/stack-validation.ts';
import { parseWorkspaceV2 } from '../../src/domain/workspace-v2-validation.ts';
import type { StackDraft } from '../../src/domain/workspace-v2-model.ts';
import type { ValidationResult } from '../../src/domain/protocol-model.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';
import { createStackExampleCopy } from '../../src/examples/reliable-stack-examples.ts';

function ok<T>(result: ValidationResult<T>): T {
  assert.ok(result.success, JSON.stringify(result));
  return result.value;
}
function draft() {
  return freezeOwned(createStackDraft(createStackExampleCopy('stack_ping_pong')));
}
function changed(before: StackDraft, path: string, value: string | number) {
  return freezeOwned({
    ...before,
    configuration: editStackExperiment(before.configuration, path, value),
    version: before.version + 1,
    updatedAt: before.updatedAt + 1,
  });
}
for (const transport of ['reliable-stream', 'datagram'] as const) {
  test(`new ${transport} definitions carry the authored message and pass the first actual delivery check`, () => {
    const source = ok(
      createNewStack(
        {
          ...NEW_STACK_DEFAULTS,
          name: '새 정의',
          protocolId: 'custom',
          messageId: 'notice',
          fieldId: 'body',
          value: '한글 / 📨',
          transport,
        },
        'new_one',
      ),
    );
    assert.equal(source.origin, undefined);
    assert.equal(source.definitions[0]?.mode, 'stack-protocol');
    const engine = ok(createStackSimulation(source));
    engine.run();
    assert.equal(engine.view().status, 'completed');
    assert.ok(engine.view().expectations.every((v) => v.status === 'pass'));
    assert.equal(
      engine.view().events.filter((e) => e.kind === 'deliver' && e.endpoint.participant === 'B')
        .length,
      1,
    );
    const original = JSON.stringify(engine.view().snapshot);
    editStackExperiment(source, '/definitions/0/label', 'new label');
    assert.equal(JSON.stringify(engine.view().snapshot), original);
    const independent = ok(createNewStack({ ...NEW_STACK_DEFAULTS, transport }, 'second'));
    assert.equal(independent.id, 'second');
    assert.equal(
      independent.nodes.A.instances[0]?.definition.id,
      independent.nodes.B.instances[0]?.definition.id,
    );
    assert.equal(
      parseWorkspaceV2(createWorkspaceV2(createWorkspace(createPingPongExperiment()), source))
        .success,
      true,
    );
  });
  test(`new ${transport} blank rules remain a saveable incomplete draft without invented input or success`, () => {
    const source = ok(createNewStack({ ...NEW_STACK_DEFAULTS, transport, flow: 'empty' }, 'blank'));
    assert.equal(
      source.definitions[0]?.mode === 'stack-protocol' && source.definitions[0].rules.length,
      0,
    );
    assert.deepEqual(source.scenario.inputs, []);
    assert.deepEqual(source.scenario.expectations, []);
    assert.equal(parseStackExperimentDraft(source).success, true);
    assert.equal(parseStackExperiment(source).success, false);
    assert.equal(
      parseWorkspaceV2(createWorkspaceV2(createWorkspace(createPingPongExperiment()), source))
        .success,
      true,
    );
  });
}
test('new stack rejects invalid stable IDs, oversized values and provider identity collisions without editing options', () => {
  const options = { ...NEW_STACK_DEFAULTS };
  const before = JSON.stringify(options);
  for (const change of [
    { protocolId: '한글' },
    { fieldId: 'bad/id' },
    { messageId: '' },
    { value: 'x'.repeat(4097) },
    { protocolId: 'reliable_stream_lite_A' },
  ])
    assert.equal(
      createNewStack({ ...options, ...change }, 'new').success,
      false,
      JSON.stringify(change),
    );
  assert.equal(JSON.stringify(options), before);
});
test('undo/redo preserves invalid raw, current suite, exact references, monotonic revisions and prior snapshots', () => {
  const history = createStackEditHistory();
  const before = draft();
  const engine = ok(createStackSimulation(before.configuration));
  engine.run();
  const snapshot = JSON.stringify(engine.view());
  const next = freezeOwned({
    ...changed(before, '/definitions/0/source/label', '편집'),
    raw: { '/definitions/0/source/rules/0/actions/0/value/right/value': 'number:-' },
  });
  history.record(before, next);
  const withSuite = freezeOwned({
    ...next,
    suite: { id: 'suite', label: '그대로', revision: 1, cases: [] },
  });
  const undo = history.travel(withSuite, 'undo', 10);
  assert.ok(undo);
  assert.equal(undo.suite, withSuite.suite);
  assert.deepEqual(undo.raw, before.raw);
  assert.equal(undo.version, next.version + 1);
  assert.ok(
    undo.configuration.definitions.every(
      (p) => p.revision > Math.max(...next.configuration.definitions.map((p) => p.revision)),
    ),
  );
  for (const node of Object.values(undo.configuration.nodes))
    for (const instance of node.instances)
      assert.ok(
        undo.configuration.definitions.some(
          (p) => p.id === instance.definition.id && p.revision === instance.definition.revision,
        ),
      );
  const redo = history.travel(undo, 'redo', 11);
  assert.ok(redo);
  assert.deepEqual(redo.raw, next.raw);
  assert.equal(redo.version, undo.version + 1);
  assert.ok(
    redo.configuration.definitions.every(
      (p) => p.revision > Math.max(...undo.configuration.definitions.map((p) => p.revision)),
    ),
  );
  assert.equal(JSON.stringify(engine.view()), snapshot);
  const data = createWorkspaceV2(createWorkspace(createPingPongExperiment()));
  assert.equal(
    parseWorkspaceV2({ ...data, stack: { ...data.stack, drafts: [redo], activeDraftId: redo.id } })
      .success,
    true,
  );
});
test('same-path edits group, structural edits split, travel breaks groups and a new branch removes redo', () => {
  const history = createStackEditHistory();
  const a = draft(),
    b = changed(a, '/label', 'b'),
    c = changed(b, '/label', 'bc');
  history.record(a, b, '/label', 100);
  history.record(b, c, '/label', 200);
  assert.equal(history.view(c).undo, 1);
  const d = freezeOwned(
    editStackList(c, '/definitions/0/source/timers', { kind: 'add', value: { id: 'extra' } }),
  );
  history.record(c, d, undefined, 300);
  assert.equal(history.view(d).undo, 2);
  const back = history.travel(d, 'undo');
  assert.ok(back);
  const replacement = changed(back, '/label', 'new');
  history.record(back, replacement, '/label', 301);
  assert.equal(history.view(replacement).redo, 0);
  assert.equal(history.view(replacement).undo, 2);
});
test('histories are per draft; external replacement fences old entries while suite-only changes do not', () => {
  const history = createStackEditHistory();
  const a = draft(),
    b = draft();
  const aa = changed(a, '/label', 'a'),
    bb = changed(b, '/label', 'b');
  history.record(a, aa);
  history.record(b, bb);
  assert.equal(history.view(aa).undo, 1);
  assert.equal(history.view(bb).undo, 1);
  assert.equal(history.view(a).undo, 0);
  assert.equal(
    history.view(aa).undo,
    1,
    'Reading an older render must not invalidate canonical history',
  );
  const replaced = freezeOwned(structuredClone(aa));
  history.reconcile([replaced, bb]);
  assert.equal(history.view(replaced).undo, 0);
  assert.equal(history.view(aa).undo, 0, 'A canonical replacement fences the old journal');
  assert.equal(history.view(bb).undo, 1);
  history.prune([aa.id]);
  assert.equal(history.view(bb).undo, 0);
});
test('entry, memory and owner limits preserve the current draft and fence evicted history', () => {
  const history = createStackEditHistory({ entries: 2, bytes: 1_000_000, owners: 1, groupMs: 750 });
  let current = draft();
  for (let i = 0; i < 4; i++) {
    const next = changed(current, '/label', `edit${i}`);
    history.record(current, next);
    current = next;
  }
  assert.equal(history.view(current).undo, 2);
  assert.equal(history.view(current).limited, true);
  const other = draft(),
    next = changed(other, '/label', 'other');
  history.record(other, next);
  assert.equal(history.view(current).undo, 0);
  assert.equal(history.view(next).undo, 1);
  const tiny = createStackEditHistory({ entries: 50, bytes: 1, owners: 100, groupMs: 750 });
  tiny.record(other, next);
  assert.equal(tiny.view(next).undo, 0);
  assert.equal(tiny.view(next).limited, true);
  assert.equal(next.configuration.label, 'other');
  assert.equal(tiny.travel(next, 'undo'), undefined);
});
test('restoring renamed/deleted definitions never reuses an earlier identity or silently repairs invalid references', () => {
  const history = createStackEditHistory();
  const a = draft();
  const b = changed(a, '/definitions/0/source/id', 'renamed');
  history.record(a, b);
  const undo = history.travel(b, 'undo');
  assert.ok(undo);
  const redo = history.travel(undo, 'redo');
  assert.ok(redo);
  assert.equal(redo.configuration.nodes.A.instances[0]?.definition.id, 'renamed');
  const protocol = redo.configuration.definitions[0];
  assert.equal(protocol?.mode === 'legacy-application' && protocol.source.id, 'renamed');
  assert.equal(
    protocol?.mode === 'legacy-application' && protocol.source.revision,
    protocol?.revision,
  );
  const invalid = changed(redo, '/nodes/A/instances/0/definition/id', 'missing');
  history.record(redo, invalid);
  const valid = history.travel(invalid, 'undo');
  assert.ok(valid);
  const restored = history.travel(valid, 'redo');
  assert.ok(restored);
  assert.equal(restored.configuration.nodes.A.instances[0]?.definition.id, 'missing');
  assert.equal(parseStackExperiment(restored.configuration).success, false);
});
test('declaration list deletion/remapping retains the other unfinished value and parent JSON blocks edits', () => {
  const source = draft();
  const base = '/definitions/0/source/variables';
  const a = freezeOwned(
    editStackList(source, base, {
      kind: 'add',
      value: { id: 'other', type: 'integer', initial: 0 },
    }),
  );
  const raw = freezeOwned({ ...a, raw: { [`${base}/1/initial`]: 'number:-' } });
  const b = editStackList(raw, base, { kind: 'remove', index: 0 });
  assert.deepEqual(b.raw, { [`${base}/0/initial`]: 'number:-' });
  const blocked = freezeOwned({ ...b, raw: { [base]: '{' } });
  assert.equal(
    editStackList(blocked, base, { kind: 'add', value: { id: 'x', type: 'integer', initial: 0 } }),
    blocked,
  );
  assert.equal(editStackList(source, '/scenario/inputs', { kind: 'remove', index: 0 }), source);
});

test('multiple revisions of the same protocol remain distinct after restore and subsequent edits', () => {
  const original = draft();
  const first = original.configuration.definitions[0];
  assert.ok(first?.mode === 'legacy-application');
  const second = { ...first, revision: 2, source: { ...first.source, revision: 2 } };
  const configuration = {
    ...original.configuration,
    definitions: [...original.configuration.definitions, second],
    nodes: {
      ...original.configuration.nodes,
      B: {
        instances: original.configuration.nodes.B.instances.map((i) =>
          i.id === 'app' ? { ...i, definition: { id: second.id, revision: 2 } } : i,
        ),
      },
    },
  };
  assert.equal(parseStackExperiment(configuration).success, true);
  const a = freezeOwned({ ...original, configuration }),
    b = changed(a, '/label', 'changed');
  const history = createStackEditHistory();
  history.record(a, b);
  const restored = history.travel(b, 'undo');
  assert.ok(restored);
  assert.equal(parseStackExperiment(restored.configuration).success, true);
  assert.notEqual(
    restored.configuration.nodes.A.instances[0]?.definition.revision,
    restored.configuration.nodes.B.instances[0]?.definition.revision,
  );
  const edited = editStackExperiment(
    restored.configuration,
    '/definitions/0/source/label',
    'safe revision',
  );
  assert.equal(parseStackExperiment(edited).success, true);
  assert.equal(
    edited.nodes.B.instances[0]?.definition.revision,
    restored.configuration.nodes.B.instances[0]?.definition.revision,
  );
});

test('failed saves retain editable undo history and saving a restored canonical draft preserves current data', async () => {
  const source = draft();
  const initial = createWorkspaceV2(
    createWorkspace(createPingPongExperiment()),
    source.configuration,
  );
  let fail = true,
    persisted: typeof initial | undefined;
  const controller = createWorkspaceV2Controller(
    {
      read: async () => undefined,
      write: async (data) => {
        if (fail) throw new StorageFailure('quota', 'Injected quota failure');
        persisted = data;
        return 1;
      },
    },
    initial,
  );
  await controller.load();
  const before = controller.view().data.stack.drafts[0];
  assert.ok(before);
  const after = changed(before, '/label', '저장 실패 중 편집');
  const history = createStackEditHistory();
  history.record(before, after);
  const replace = (value: StackDraft) =>
    controller.update((data) => ({ ...data, stack: { ...data.stack, drafts: [value] } }));
  replace(after);
  await controller.save();
  assert.equal(controller.view().status, 'error');
  const current = controller.view().data.stack.drafts[0];
  assert.ok(current);
  assert.equal(history.view(current).undo, 1);
  const restored = history.travel(current, 'undo');
  assert.ok(restored);
  replace(restored);
  fail = false;
  await controller.save();
  assert.equal(controller.view().status, 'saved');
  assert.equal(persisted?.stack.drafts[0]?.configuration.label, before.configuration.label);
  assert.equal(history.view(restored).redo, 1);
  assert.equal(parseWorkspaceV2(controller.view().data).success, true);
});
