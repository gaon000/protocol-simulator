import assert from 'node:assert/strict';
import test from 'node:test';
import { createSimulation } from '../../src/application/create-simulation.ts';
import {
  changeProfile,
  createBlankExperiment,
  editExperiment,
  pointerToken,
  rebasePending,
  valueAt,
} from '../../src/application/edit-experiment.ts';
import { parseExperiment } from '../../src/domain/model-validation.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';

for (const codec of ['json-lines', 'json-datagram', 'logical-packet'] as const) {
  test(`the editable production starter completes actual ${codec} simulation`, () => {
    const created = createSimulation(createPingPongExperiment(codec));
    assert.ok(created.success);
    const result = created.value.run();
    assert.equal(result.status, 'completed');
    assert.equal(result.participants.A.stateId, 'Done');
    assert.equal(result.expectations.length, 4);
    assert.ok(result.expectations.every((item) => item.status === 'pass'));
  });
}

test('schema edits advance exact participant revisions and leave a captured run unchanged', () => {
  const original = createPingPongExperiment();
  const created = createSimulation(original);
  assert.ok(created.success);
  const edited = editExperiment(
    original,
    '/definitions/0/messages/0/fields/1/defaultValue',
    '편집됨',
  );
  assert.equal(edited.definitions[0]?.revision, 2);
  assert.equal(edited.protocols.A.revision, 2);
  assert.equal(edited.protocols.B.revision, 2);
  assert.equal(original.definitions[0]?.revision, 1);
  const next = createSimulation(edited);
  assert.ok(next.success);
  const changedTrace = JSON.stringify(next.value.run().events);
  assert.ok(changedTrace.includes('편집됨'));
  assert.ok(!JSON.stringify(created.value.run().events).includes('편집됨'));
});

test('changing a response guard changes real rule selection and final checks', () => {
  const changed = editExperiment(
    createPingPongExperiment(),
    '/definitions/0/rules/2/condition/operator',
    'ne',
  );
  const created = createSimulation(changed);
  assert.ok(created.success);
  const result = created.value.run();
  assert.ok(result.diagnostics.some((item) => item.code === 'unmatched-event'));
  assert.ok(result.expectations.some((item) => item.status !== 'pass'));
});

test('profile changes preserve authored data and select a compatible codec for both peers', () => {
  const edited = editExperiment(createPingPongExperiment(), '/label', '내 실험');
  const transport = changeProfile(edited, 'transport', 'stream');
  assert.equal(transport.label, '내 실험');
  assert.equal(transport.environment.kind, 'datagram');
  assert.equal(transport.definitions[0]?.codec, 'logical-packet');
  assert.ok(parseExperiment(transport).success);
  const application = changeProfile(transport, 'application', 'stream');
  assert.ok(parseExperiment(application).success);
  assert.equal(application.scenario, edited.scenario);
});

test('blank experiments contain no hidden inputs, messages, actions or expectations', () => {
  const blank = createBlankExperiment();
  const created = createSimulation(blank);
  assert.ok(!created.success);
  assert.ok(created.diagnostics.some((item) => item.path === '/definitions/0/messages'));
  assert.deepEqual(blank.scenario.inputs, []);
  assert.deepEqual(blank.scenario.expectations, []);
  assert.deepEqual(blank.definitions[0]?.messages, []);
  assert.deepEqual(blank.definitions[0]?.rules, []);
});

test('deletion preserves dangling references for validation instead of silently rewriting rules', () => {
  const edited = editExperiment(createPingPongExperiment(), '/definitions/0/messages/0', undefined);
  assert.equal(edited.definitions[0]?.messages.length, 1);
  const result = parseExperiment(edited);
  assert.ok(!result.success);
  assert.ok(result.diagnostics.some((item) => item.path.includes('/rules/')));
});

test('JSON Pointer editing handles escaped and prototype-shaped keys as own data', () => {
  const draft = createPingPongExperiment();
  const path = `/scenario/inputs/0/message/values/${pointerToken('a/b~c')}`;
  const edited = editExperiment(draft, path, 3);
  assert.equal(valueAt(edited, path), 3);
  const proto = editExperiment(edited, '/scenario/inputs/0/message/values/__proto__', 'data');
  assert.equal(valueAt(proto, '/scenario/inputs/0/message/values/__proto__'), 'data');
  assert.equal(valueAt(draft, '/constructor'), undefined);
  assert.equal(Object.getPrototypeOf(proto.scenario.inputs[0]?.message.values), Object.prototype);
});

test('deleting a definition never retargets its participants to the following definition', () => {
  const original = createPingPongExperiment();
  const definition = original.definitions[0];
  assert.ok(definition);
  const draft = {
    ...original,
    definitions: [definition, { ...definition, id: 'other', revision: 7 }],
  };
  const edited = editExperiment(draft, '/definitions/0', undefined);
  assert.equal(edited.definitions[0]?.id, 'other');
  assert.equal(edited.definitions[0]?.revision, 7);
  assert.deepEqual(edited.protocols, original.protocols);
  assert.equal(parseExperiment(edited).success, false);
});

test('unfinished JSON follows surviving rows and is preserved when new rows are appended', () => {
  const draft = createPingPongExperiment();
  const entries = {
    '/definitions/0/variables/0/initial': '{',
    '/definitions/0/variables/1/initial': '[',
  };
  const definition = draft.definitions[0];
  assert.ok(definition);
  const appended = rebasePending(entries, draft, '/definitions/0/variables', [
    ...definition.variables,
    { id: 'another', type: 'integer', initial: 0 },
  ]);
  assert.deepEqual(appended, entries);
  const deleted = rebasePending(entries, draft, '/definitions/0/variables/0', undefined);
  assert.deepEqual(deleted, { '/definitions/0/variables/0/initial': '[' });
});
