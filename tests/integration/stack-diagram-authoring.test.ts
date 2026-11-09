import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendStackDiagram,
  captureStackDiagramSource,
  pendingStackDiagramCommand,
  prepareStackDiagramTransition,
  stackDiagramEvents,
} from '../../src/application/stack-diagram-authoring.ts';
import { createNewStack, NEW_STACK_DEFAULTS } from '../../src/application/new-stack.ts';
import { createStackDraft } from '../../src/application/workspace-v2-operations.ts';
import { editStackExperiment } from '../../src/application/edit-stack.ts';
import { editStackList } from '../../src/application/edit-stack-list.ts';
import { createStackEditHistory } from '../../src/application/stack-edit-history.ts';
import { createStackSimulation } from '../../src/application/create-stack-simulation.ts';
import { buildStateDiagram } from '../../src/application/state-diagram.ts';
import type { JsonValue } from '../../src/domain/execution-contract.ts';
import { freezeOwned } from '../../src/domain/immutable-data.ts';
import {
  stackProtocolBody,
  type StackProtocol,
  type StackRuleEvent,
} from '../../src/domain/stack-model.ts';
import {
  parseStackExperiment,
  parseStackExperimentDraft,
} from '../../src/domain/stack-validation.ts';
import type { StackDraft } from '../../src/domain/workspace-v2-model.ts';
import { createStackExampleCopy } from '../../src/examples/reliable-stack-examples.ts';

function need<T>(value: T | undefined): T {
  assert.ok(value);
  return value;
}
const A = { participant: 'A', instanceId: 'app' } as const;
function fresh() {
  const result = createNewStack({ ...NEW_STACK_DEFAULTS, flow: 'empty' }, 'visual');
  assert.ok(result.success);
  return freezeOwned(createStackDraft(result.value));
}
function source(draft: StackDraft, endpoint = A as { participant: 'A' | 'B'; instanceId: string }) {
  const result = captureStackDiagramSource(draft, endpoint);
  assert.ok(result);
  return result;
}
function change(draft: StackDraft, path: string, value: JsonValue) {
  return freezeOwned({
    ...draft,
    configuration: editStackExperiment(draft.configuration, path, value),
    version: draft.version + 1,
  });
}
function proto(draft: StackDraft, index = 0) {
  const protocol = draft.configuration.definitions[index];
  assert.ok(protocol);
  return protocol;
}
function addState(draft: StackDraft) {
  const result = appendStackDiagram(draft, source(draft), { kind: 'state' }, 100);
  assert.ok(result);
  return freezeOwned(result.draft);
}
const endpoint = (protocol: StackProtocol, index: number) => ({
  index,
  id: stackProtocolBody(protocol).states[index]?.id ?? '',
});

test('state creation reserves dangling references and atomically rebinds shared exact revisions without mutating frozen sources', () => {
  let draft = fresh();
  draft = change(draft, '/definitions/0/initialStateId', 'state_1');
  draft = change(draft, '/definitions/0/rules', [
    {
      id: 'old',
      fromStateId: 'state_2',
      nextStateId: 'state_3',
      event: { kind: 'input', messageId: 'message' },
      actions: [],
    },
  ]);
  const before = JSON.stringify(draft);
  const result = appendStackDiagram(draft, source(draft), { kind: 'state' }, 101);
  assert.ok(result);
  assert.deepEqual(result.selection, { kind: 'state', index: 1 });
  assert.equal(stackProtocolBody(proto(result.draft)).states[1]?.id, 'state_4');
  assert.equal(result.draft.updatedAt, 101);
  assert.equal(result.draft.version, draft.version + 1);
  assert.equal(proto(result.draft).revision, proto(draft).revision + 1);
  for (const participant of ['A', 'B'] as const)
    assert.equal(
      result.draft.configuration.nodes[participant].instances[0]?.definition.revision,
      proto(result.draft).revision,
    );
  assert.equal(JSON.stringify(draft), before);
  assert.ok(parseStackExperimentDraft(result.draft.configuration).success);
});

test('native event choices use unique declarations and the actual provides/requires operation and lifecycle', () => {
  const draft = fresh();
  const p = proto(draft, 1);
  assert.equal(p.mode, 'stack-protocol');
  if (p.mode !== 'stack-protocol') return;
  const events = stackDiagramEvents(p).map((c) => c.event);
  assert.ok(
    events.some(
      (e) => e.kind === 'service-request' && e.portId === p.provides?.id && e.operation === 'write',
    ),
  );
  assert.ok(
    events.some(
      (e) =>
        e.kind === 'service-indication' && e.portId === p.requires.id && e.operation === 'receive',
    ),
  );
  assert.ok(!events.some((e) => e.kind === 'service-indication' && e.operation === 'closed'));
  const altered = {
    ...p,
    messages: [...p.messages, need(p.messages[0])],
    timers: [{ id: 't' }, { id: 't' }],
    provides: { ...need(p.provides), request: 'send' as const },
    requires: {
      ...p.requires,
      lifecycle: { ...p.requires.lifecycle, notifications: ['closed'] as const },
    },
  };
  const choices = stackDiagramEvents(altered).map((c) => c.event);
  assert.ok(!choices.some((e) => e.kind === 'service-request' || e.kind === 'timer'));
  assert.ok(choices.some((e) => e.kind === 'connection' && e.state === 'closed'));
  assert.ok(!choices.some((e) => 'messageId' in e && e.messageId === p.messages[0]?.id));
  assert.ok(stackDiagramEvents(proto(draft)).every((c) => c.event.kind !== 'service-request'));
});

test('legacy creation keeps its source identity and legacy trigger language instead of exposing native ports', () => {
  const draft = freezeOwned(createStackDraft(createStackExampleCopy('stack_ping_pong')));
  const p = proto(draft);
  assert.equal(p.mode, 'legacy-application');
  assert.ok(
    stackDiagramEvents(p).every(
      (c) => c.event.kind !== 'service-request' && c.event.kind !== 'service-indication',
    ),
  );
  const result = appendStackDiagram(draft, source(draft), { kind: 'state' });
  assert.ok(result);
  const revised = proto(result.draft);
  assert.equal(revised.mode, 'legacy-application');
  if (revised.mode === 'legacy-application')
    assert.equal(revised.source.revision, revised.revision);
  assert.equal(stackProtocolBody(revised).states.length, stackProtocolBody(p).states.length + 1);
  assert.equal(proto(result.draft, 1).revision, proto(draft, 1).revision);
});

test('transition preparation rejects ambiguous or stale endpoints and unsupported references/operations', () => {
  const draft = addState(fresh());
  const p = proto(draft);
  const from = endpoint(p, 0),
    to = endpoint(p, 1);
  const event = { kind: 'input', messageId: 'message' } as const;
  assert.ok(prepareStackDiagramTransition(p, from, to, event).success);
  for (const point of [
    { index: -1, id: from.id },
    { index: 0.5, id: from.id },
    { ...from, id: 'renamed' },
    { index: 99, id: from.id },
  ])
    assert.equal(prepareStackDiagramTransition(p, point, to, event).success, false);
  for (const bad of [
    { kind: 'input', messageId: 'missing' },
    { kind: 'timer', timerId: 'none' },
    { kind: 'connection', state: 'closed' },
    { kind: 'service-request', portId: 'lower', operation: 'write' },
    { kind: 'service-indication', portId: 'lower', operation: 'receive' },
  ] satisfies StackRuleEvent[])
    assert.equal(prepareStackDiagramTransition(p, from, to, bad).success, false);
  if (p.mode === 'stack-protocol') {
    const duplicate = { ...p, states: [...p.states, need(p.states[0])] };
    assert.equal(prepareStackDiagramTransition(duplicate, from, to, event).success, false);
    assert.equal(
      prepareStackDiagramTransition(
        { ...p, messages: [...p.messages, need(p.messages[0])] },
        from,
        to,
        event,
      ).success,
      false,
    );
  }
});

test('append fences old draft/version, exact source and raw references, reordered definitions and ambiguous owners', () => {
  const draft = fresh();
  const captured = source(draft);
  const command = { kind: 'state' } as const;
  const changed = change(draft, '/definitions/0/label', 'new');
  for (const value of [
    changed,
    { ...draft, id: 'another' },
    { ...draft, version: draft.version + 1 },
    { ...draft, configuration: structuredClone(draft.configuration) },
    { ...draft, raw: {} },
  ])
    assert.equal(appendStackDiagram(value, captured, command), undefined);
  const reordered = {
    ...draft,
    configuration: {
      ...draft.configuration,
      definitions: [...draft.configuration.definitions].reverse(),
    },
  };
  assert.equal(appendStackDiagram(reordered, captured, command), undefined);
  const duplicate = {
    ...draft,
    configuration: {
      ...draft.configuration,
      definitions: [...draft.configuration.definitions, proto(draft)],
    },
  };
  assert.equal(captureStackDiagramSource(duplicate, A), undefined);
  const duplicateEndpoint = {
    ...draft,
    configuration: {
      ...draft.configuration,
      nodes: {
        ...draft.configuration.nodes,
        A: {
          ...draft.configuration.nodes.A,
          instances: [
            ...draft.configuration.nodes.A.instances,
            need(draft.configuration.nodes.A.instances[0]),
          ],
        },
      },
    },
  };
  assert.equal(captureStackDiagramSource(duplicateEndpoint, A), undefined);
});

test('different revisions of one protocol ID remain distinct when authoring the selected B instance', () => {
  const original = fresh();
  const app = proto(original);
  assert.ok(app.mode === 'stack-protocol');
  const other = { ...app, revision: 12 };
  const draft = freezeOwned({
    ...original,
    configuration: {
      ...original.configuration,
      definitions: [...original.configuration.definitions, other],
      nodes: {
        ...original.configuration.nodes,
        B: {
          ...original.configuration.nodes.B,
          instances: original.configuration.nodes.B.instances.map((instance, i) =>
            i === 0 ? { ...instance, definition: { id: other.id, revision: 12 } } : instance,
          ),
        },
      },
    },
  });
  const captured = source(draft, { participant: 'B', instanceId: 'app' });
  assert.equal(captured.definition, 3);
  const result = appendStackDiagram(draft, captured, { kind: 'state' });
  assert.ok(result);
  assert.equal(proto(result.draft).revision, app.revision);
  assert.equal(stackProtocolBody(proto(result.draft)).states.length, 1);
  assert.equal(proto(result.draft, 3).revision, 13);
  assert.equal(result.draft.configuration.nodes.A.instances[0]?.definition.revision, app.revision);
  assert.equal(result.draft.configuration.nodes.B.instances[0]?.definition.revision, 13);
});

test('parent pending text blocks creation and pending endpoint/event text cannot become a committed connection', () => {
  const base = addState(fresh());
  const p = proto(base);
  const command = {
    kind: 'rule',
    from: endpoint(p, 0),
    to: endpoint(p, 1),
    event: { kind: 'input', messageId: 'message' },
  } as const;
  for (const path of [
    '/definitions',
    '/definitions/0',
    '/definitions/0/states',
    '/definitions/0/rules',
    '/definitions/0/states/0',
    '/definitions/0/states/1/id',
    '/definitions/0/messages/0',
    '/definitions/0/messages/0/fields',
  ]) {
    const draft = { ...base, raw: { [path]: '{pending' } };
    assert.equal(pendingStackDiagramCommand(draft, source(draft), command), path);
    assert.equal(appendStackDiagram(draft, source(draft), command), undefined);
    assert.equal(draft.raw[path], '{pending');
  }
  const unrelated = { ...base, raw: { '/definitions/0/rules/0/condition': '{pending' } };
  assert.ok(appendStackDiagram(unrelated, source(unrelated), command));
  assert.ok(appendStackDiagram(unrelated, source(unrelated), { kind: 'state' }));
});

test('new self loops are explicit ignores and parallel triggers remain drafts for the authoritative conflict checker', () => {
  let draft = fresh();
  const from = endpoint(proto(draft), 0);
  const event = { kind: 'input', messageId: 'message' } as const;
  const first = appendStackDiagram(draft, source(draft), { kind: 'rule', from, to: from, event });
  assert.ok(first);
  assert.deepEqual(stackProtocolBody(proto(first.draft)).rules[0], {
    id: 'rule_1',
    fromStateId: from.id,
    nextStateId: from.id,
    event,
    actions: [],
    ignore: true,
  });
  draft = freezeOwned(first.draft);
  const prepared = prepareStackDiagramTransition(proto(draft), from, from, event);
  assert.ok(prepared.success && prepared.overlaps);
  const second = appendStackDiagram(draft, source(draft), { kind: 'rule', from, to: from, event });
  assert.ok(second);
  const validation = parseStackExperiment(second.draft.configuration);
  assert.ok(!validation.success && validation.diagnostics.some((d) => d.code === 'rule-conflict'));
});

test('the drawn state-only transition executes against the real stack engine and undo/redo preserve the frozen run', () => {
  let draft = addState(fresh());
  const from = endpoint(proto(draft), 0),
    to = endpoint(proto(draft), 1);
  const result = appendStackDiagram(draft, source(draft), {
    kind: 'rule',
    from,
    to,
    event: { kind: 'input', messageId: 'message' },
  });
  assert.ok(result);
  const history = createStackEditHistory();
  const after = freezeOwned(result.draft);
  history.record(draft, after);
  draft = change(after, '/scenario/inputs', [
    {
      id: 'input_1',
      timeMs: 0,
      target: A,
      message: { messageId: 'message', values: { text: 'actual' } },
    },
  ]);
  draft = change(draft, '/scenario/expectations', [
    { id: 'state_1', kind: 'state', target: A, stateId: to.id },
  ]);
  const created = createStackSimulation(draft.configuration);
  assert.ok(created.success, JSON.stringify(created));
  created.value.run();
  assert.equal(created.value.view().status, 'completed');
  assert.ok(created.value.view().expectations.every((e) => e.status === 'pass'));
  assert.ok(created.value.view().events.some((e) => e.kind === 'transition'));
  const snapshot = JSON.stringify(created.value.view());
  const restored = history.travel(after, 'undo');
  assert.ok(restored);
  assert.equal(stackProtocolBody(proto(restored)).rules.length, 0);
  const redone = history.travel(restored, 'redo');
  assert.ok(redone);
  assert.equal(stackProtocolBody(proto(redone)).rules.length, 1);
  assert.ok(proto(redone).revision > proto(after).revision);
  assert.equal(JSON.stringify(created.value.view()), snapshot);
});

test('top-level state and rule list changes remap child raw atomically and their undo restores the exact pending paths', () => {
  let draft = addState(addState(fresh()));
  draft = freezeOwned({
    ...draft,
    raw: {
      '/definitions/0/states/2/label': '{pending',
      '/definitions/1/rules/0/actions': '[pending',
    },
  });
  const moved = freezeOwned(
    editStackList(draft, '/definitions/0/states', { kind: 'move', from: 2, to: 0 }, 100),
  );
  assert.equal(moved.raw['/definitions/0/states/0/label'], '{pending');
  assert.equal(moved.raw['/definitions/1/rules/0/actions'], '[pending');
  const history = createStackEditHistory();
  history.record(draft, moved);
  const restored = history.travel(moved, 'undo');
  assert.ok(restored);
  assert.deepEqual(restored.raw, draft.raw);
  const transport = '/definitions/1/rules';
  const removed = editStackList(moved, transport, { kind: 'remove', index: 0 });
  assert.equal(removed.raw['/definitions/1/rules/0/actions'], undefined);
  assert.equal(
    stackProtocolBody(proto(removed, 1)).rules.length,
    stackProtocolBody(proto(draft, 1)).rules.length - 1,
  );
});

test('large diagram pages stay bounded and pin actual selected endpoints without changing the definition', () => {
  const p = stackProtocolBody(proto(fresh()));
  const large = {
    ...p,
    states: Array.from({ length: 125 }, (_, i) => ({ id: `s_${i}`, label: `S ${i}` })),
    initialStateId: 's_0',
    rules: Array.from({ length: 605 }, (_, i) => ({
      id: `r_${i}`,
      fromStateId: `s_${i % 125}`,
      nextStateId: `s_${(i + 1) % 125}`,
      event: { kind: 'input' as const, messageId: 'message' },
      actions: [],
    })),
  };
  const before = JSON.stringify(large);
  const graph = buildStateDiagram(large, {
    statePage: 3,
    rulePage: 30,
    selectedStateIds: ['s_1', 's_124'],
  });
  assert.equal(graph.visibleRules.length, 5);
  assert.ok(graph.nodes.length <= 53);
  assert.ok(graph.nodes.some((n) => n.id === 's_1'));
  assert.equal(graph.statePages, 4);
  assert.equal(graph.rulePages, 31);
  assert.equal(JSON.stringify(large), before);
});
