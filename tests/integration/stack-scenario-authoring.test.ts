import assert from 'node:assert/strict';
import test from 'node:test';
import { editStackExperiment } from '../../src/application/edit-stack.ts';
import { editStackList } from '../../src/application/edit-stack-list.ts';
import {
  newStackScenarioRow,
  prepareStackExpectationKind,
  stackScenarioExpectation,
  stackScenarioFieldValue,
  stackScenarioMessage,
  stackScenarioProtocol,
  stackScenarioTargets,
  uniqueScenarioDeclarations,
} from '../../src/application/stack-scenario-authoring.ts';
import { createStackSimulation } from '../../src/application/create-stack-simulation.ts';
import {
  createStackDraft,
  captureStackRun,
} from '../../src/application/workspace-v2-operations.ts';
import { createStackEditHistory } from '../../src/application/stack-edit-history.ts';
import { parseWorkspaceV2 } from '../../src/domain/workspace-v2-validation.ts';
import { validateStackMessage } from '../../src/domain/stack-protocol-validation.ts';
import {
  parseStackExperiment,
  parseStackExperimentDraft,
} from '../../src/domain/stack-validation.ts';
import { stackProtocolBody } from '../../src/domain/stack-model.ts';
import { stackObject } from '../../src/domain/stack-record.ts';
import { serializeBytes } from '../../src/domain/stack-bytes.ts';
import { createStackExampleCopy } from '../../src/examples/reliable-stack-examples.ts';
import {
  stackScenarioConfiguration,
  stackScenarioWorkspace,
} from '../fixtures/stack-scenario-forms.ts';

const A = { participant: 'A' as const, instanceId: 'app' };
const B = { participant: 'B' as const, instanceId: 'app' };

test('scenario declarations use exact unique endpoint/revision and native or legacy bodies', () => {
  const draft = createStackDraft(stackScenarioConfiguration());
  const source = stackScenarioProtocol(draft, A);
  assert.equal(source?.protocol.mode, 'stack-protocol');
  assert.equal(stackScenarioTargets(draft, true).length, 2);
  assert.equal(stackScenarioTargets(draft, false).length, 4);
  const legacy = createStackDraft(createStackExampleCopy('stack_ping_pong'));
  assert.equal(stackScenarioProtocol(legacy, A)?.protocol.mode, 'legacy-application');
  const app = draft.configuration.definitions[0];
  assert.ok(app);
  const other = {
    ...draft,
    configuration: {
      ...draft.configuration,
      definitions: [...draft.configuration.definitions, { ...app, revision: app.revision + 1 }],
    },
  };
  assert.equal(stackScenarioProtocol(other, A)?.protocol.revision, app.revision);
  const ambiguous = {
    ...other,
    configuration: {
      ...other.configuration,
      definitions: [...other.configuration.definitions, structuredClone(app)],
    },
  };
  assert.equal(stackScenarioProtocol(ambiguous, A), undefined);
  const nodes = structuredClone(draft.configuration.nodes);
  const duplicate = nodes.A.instances[0];
  assert.ok(duplicate);
  const duplicatedNodes = {
    ...nodes,
    A: { ...nodes.A, instances: [...nodes.A.instances, duplicate] },
  };
  assert.equal(
    stackScenarioProtocol(
      { ...draft, configuration: { ...draft.configuration, nodes: duplicatedNodes } },
      A,
    ),
    undefined,
  );
  assert.equal(stackScenarioProtocol(draft, { ...A, instanceId: 'absent' }), undefined);
});

test('explicit field inclusion preserves default values, 0/false/empty text/bytes and leaves omission untouched', () => {
  const draft = createStackDraft(stackScenarioConfiguration());
  const source = stackScenarioMessage(draft, A, 'message');
  assert.ok(source?.message);
  const original = JSON.stringify(draft.configuration);
  const omitted = validateStackMessage(source.body, { messageId: 'message', values: {} });
  assert.ok(omitted.success);
  assert.equal(omitted.value.values.count, 7);
  assert.equal(omitted.value.values.flag, false);
  for (const field of source.message.fields)
    assert.deepEqual(stackScenarioFieldValue(field), field.defaultValue);
  assert.equal(
    stackScenarioFieldValue({
      id: 'i',
      name: 'i',
      type: 'integer',
      required: true,
      placement: 'body',
    }),
    0,
  );
  assert.deepEqual(
    stackScenarioFieldValue({
      id: 'b',
      name: 'b',
      type: 'bytes',
      required: true,
      placement: 'body',
    }),
    serializeBytes(new Uint8Array()),
  );
  assert.equal(JSON.stringify(draft.configuration), original);
  assert.equal(stackScenarioMessage(draft, A, 'unknown')?.message, undefined);
  assert.deepEqual(
    uniqueScenarioDeclarations([{ id: 'same' }, { id: '' }, { id: 'same' }, { id: 'valid' }]),
    [{ id: 'valid' }],
  );
});

test('pending selected declarations and ancestors remain distinct from unrelated raw', () => {
  const draft = createStackDraft(stackScenarioConfiguration());
  for (const path of [
    '/definitions/0',
    '/definitions/0/messages',
    '/definitions/0/messages/0',
    '/definitions/0/messages/0/fields/0/defaultValue',
  ]) {
    assert.equal(
      stackScenarioMessage({ ...draft, raw: { [path]: '{' } }, A, 'message')?.blocked,
      path,
    );
  }
  assert.equal(
    stackScenarioMessage(
      { ...draft, raw: { '/definitions/0/messages/1/label': '{' } },
      A,
      'message',
    )?.blocked,
    undefined,
  );
});

test('four expectation shapes use the row target and pending descendants prevent destructive kind replacement', () => {
  const draft = createStackDraft(stackScenarioConfiguration());
  for (const kind of [
    'state',
    'delivery-count',
    'delivered-values',
    'completion-before',
  ] as const) {
    const value = stackScenarioExpectation(draft, 'expected', B, kind);
    const configuration = {
      ...draft.configuration,
      scenario: { ...draft.configuration.scenario, expectations: [value] },
    };
    assert.equal(parseStackExperimentDraft(configuration).success, true);
    assert.deepEqual(value.target, B);
    assert.equal(parseStackExperiment(configuration).success, true);
  }
  const path = '/scenario/expectations/0';
  const next = prepareStackExpectationKind(draft, path, 'delivery-count');
  assert.ok(next?.kind === 'delivery-count');
  assert.deepEqual(Object.keys(next).sort(), ['count', 'id', 'kind', 'messageId', 'target']);
  for (const rawPath of ['/scenario', path, `${path}/message/values/count`])
    assert.equal(
      prepareStackExpectationKind({ ...draft, raw: { [rawPath]: 'number:-' } }, path, 'state'),
      undefined,
    );
  assert.ok(
    prepareStackExpectationKind(
      { ...draft, raw: { '/scenario/inputs/0/timeMs': 'number:-' } },
      path,
      'state',
    ),
  );
});

test('scenario list insertion, removal and moves remap integer/hex/escaped child raw atomically without revising definitions', () => {
  let draft = createStackDraft(stackScenarioConfiguration());
  const revision = draft.configuration.definitions.map((d) => d.revision);
  draft = editStackList(
    draft,
    '/scenario/inputs',
    { kind: 'add', value: newStackScenarioRow(draft, 'inputs') },
    1,
  );
  draft = {
    ...draft,
    raw: {
      '/scenario/inputs/0/message/values/count': 'number:-',
      '/scenario/inputs/1/message/values/bytes': 'hex:a',
      '/scenario/expectations/0/message/values/token~1id~0x': '"pending',
    },
  };
  const moved = editStackList(draft, '/scenario/inputs', { kind: 'move', from: 0, to: 1 }, 2);
  assert.equal(moved.raw['/scenario/inputs/1/message/values/count'], 'number:-');
  assert.equal(moved.raw['/scenario/inputs/0/message/values/bytes'], 'hex:a');
  assert.equal(moved.raw['/scenario/expectations/0/message/values/token~1id~0x'], '"pending');
  assert.deepEqual(
    moved.configuration.definitions.map((d) => d.revision),
    revision,
  );
  assert.equal(moved.version, draft.version + 1);
  const removed = editStackList(moved, '/scenario/inputs', { kind: 'remove', index: 0 }, 3);
  assert.equal(removed.raw['/scenario/inputs/0/message/values/count'], 'number:-');
  assert.equal(Object.values(removed.raw).includes('hex:a'), false);
  const blocked = { ...draft, raw: { '/scenario/inputs': '[' } };
  assert.equal(editStackList(blocked, '/scenario/inputs', { kind: 'remove', index: 0 }), blocked);
});

test('new scenario rows choose an actual application and fresh IDs rather than the active transport editor', () => {
  const draft = createStackDraft(stackScenarioConfiguration());
  const input = newStackScenarioRow(draft, 'inputs');
  const expectation = newStackScenarioRow(draft, 'expectations');
  assert.deepEqual(input, {
    id: 'input_2',
    timeMs: 0,
    target: A,
    message: { messageId: 'message', values: {} },
  });
  assert.ok(expectation && typeof expectation === 'object' && !Array.isArray(expectation));
  assert.deepEqual(stackObject(expectation).target, A);
});

test('actual typed scenario edits change delivery verdicts while saved snapshots, undo/redo and persisted values stay independent', () => {
  const workspace = stackScenarioWorkspace();
  const draft = workspace.stack.drafts[0];
  assert.ok(draft);
  const created = createStackSimulation(draft.configuration);
  assert.ok(created.success, JSON.stringify(created));
  const record = captureStackRun(created.value.run(), draft.id, draft.version);
  assert.ok(record.view.expectations.every((e) => e.status === 'pass'));
  const before = JSON.stringify(record);
  const history = createStackEditHistory();
  const configuration = editStackExperiment(
    draft.configuration,
    '/scenario/expectations/0/message/values/text',
    '다른 값',
  );
  const next = { ...draft, configuration, version: draft.version + 1 };
  history.record(draft, next);
  const changed = createStackSimulation(next.configuration);
  assert.ok(changed.success);
  assert.equal(changed.value.run().expectations[0]?.status, 'fail');
  const restored = history.travel(next, 'undo');
  assert.ok(restored);
  assert.deepEqual(restored.configuration.scenario, draft.configuration.scenario);
  const redone = history.travel(restored, 'redo');
  assert.ok(redone);
  assert.deepEqual(redone.configuration.scenario, next.configuration.scenario);
  const parsed = parseWorkspaceV2({
    ...workspace,
    stack: { ...workspace.stack, drafts: [redone], runs: [record] },
  });
  assert.ok(parsed.success);
  assert.equal(JSON.stringify(record), before);
  const original = draft.configuration.definitions[0];
  const frozen = record.view.snapshot.configuration.definitions[0];
  assert.ok(original && frozen);
  assert.deepEqual(stackProtocolBody(frozen).messages, stackProtocolBody(original).messages);
});
