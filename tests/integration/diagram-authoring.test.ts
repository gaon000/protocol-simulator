import assert from 'node:assert/strict';
import test from 'node:test';
import { createSimulation } from '../../src/application/create-simulation.ts';
import {
  newDiagramState,
  prepareDiagramTransition,
  validDiagramEndpoint,
  validDiagramEvent,
} from '../../src/application/diagram-authoring.ts';
import {
  createBlankExperiment,
  editExperiment,
  rebasePending,
} from '../../src/application/edit-experiment.ts';
import { parseExperiment } from '../../src/domain/model-validation.ts';
import type { ProtocolDefinition, RuleEvent } from '../../src/domain/protocol-model.ts';
import { EXAMPLES, getExampleOriginal } from '../../src/examples/catalog.ts';

function protocol() {
  const value = getExampleOriginal('ping_pong').definitions[0];
  assert.ok(value);
  return value;
}
const endpoint = (value: ProtocolDefinition, index: number) => ({
  index,
  id: value.states[index]?.id ?? '',
});
test('new state IDs reserve dangling references and initial IDs without mutating the existing definition', () => {
  const base = protocol();
  const rule = base.rules[0];
  assert.ok(rule);
  const invalid = {
    ...base,
    initialStateId: 'state_1',
    states: [...base.states, { id: 'state_2', label: '기존' }],
    rules: [...base.rules, { ...rule, fromStateId: 'state_3', nextStateId: 'state_4' }],
  };
  const before = JSON.stringify(invalid);
  assert.deepEqual(newDiagramState(invalid), { id: 'state_5', label: '새 상태' });
  assert.equal(JSON.stringify(invalid), before);
});
test('endpoint checks reject duplicate, empty, renamed, deleted and moved states including unsafe indices', () => {
  const base = protocol();
  assert.ok(validDiagramEndpoint(base, endpoint(base, 0)));
  for (const index of [-1, NaN, Infinity, 0.5, 999])
    assert.equal(validDiagramEndpoint(base, { index, id: 'Idle' }), false);
  const captured = endpoint(base, 1);
  assert.equal(validDiagramEndpoint({ ...base, states: base.states.slice(1) }, captured), false);
  assert.equal(
    validDiagramEndpoint(
      { ...base, states: [...base.states, { id: 'Waiting', label: 'duplicate' }] },
      captured,
    ),
    false,
  );
  assert.equal(
    validDiagramEndpoint({ ...base, states: [{ id: '', label: 'empty' }] }, { index: 0, id: '' }),
    false,
  );
  assert.equal(
    validDiagramEndpoint({ ...base, states: [{ id: 'renamed', label: 'new' }] }, endpoint(base, 0)),
    false,
  );
});
test('all trigger kinds require unique current references and connection requires a stream', () => {
  const base = protocol();
  for (const event of [
    { kind: 'input', messageId: 'ping' },
    { kind: 'receive', messageId: 'pong' },
    { kind: 'timer', timerId: 'response' },
    { kind: 'connection', state: 'closed' },
    { kind: 'connection', state: 'failed' },
  ] satisfies RuleEvent[])
    assert.ok(validDiagramEvent(base, event));
  assert.equal(validDiagramEvent(base, { kind: 'input', messageId: 'missing' }), false);
  assert.equal(
    validDiagramEvent({ ...base, timers: [] }, { kind: 'timer', timerId: 'response' }),
    false,
  );
  assert.equal(
    validDiagramEvent(
      { ...base, lowerService: 'datagram' },
      { kind: 'connection', state: 'failed' },
    ),
    false,
  );
  const first = base.messages[0];
  assert.ok(first);
  assert.equal(
    validDiagramEvent(
      { ...base, messages: [...base.messages, first] },
      { kind: 'input', messageId: first.id },
    ),
    false,
  );
});
test('new transitions preserve existing rules and contain no invented sends, timers or completion actions', () => {
  const base = protocol();
  const prepared = prepareDiagramTransition(base, endpoint(base, 0), endpoint(base, 2), {
    kind: 'input',
    messageId: 'pong',
  });
  assert.ok(prepared.success);
  assert.deepEqual(prepared.rule.actions, []);
  assert.equal(prepared.rule.ignore, undefined);
  assert.equal(prepared.rule.fromStateId, 'Idle');
  assert.equal(prepared.rule.nextStateId, 'Done');
  assert.ok(!base.rules.some((rule) => rule.id === prepared.rule.id));
  assert.equal(prepared.overlaps, false);
});
test('self loops start as explicit no-ops and duplicate trigger warnings ignore JSON property order', () => {
  const base = protocol();
  const prepared = prepareDiagramTransition(base, endpoint(base, 0), endpoint(base, 0), {
    messageId: 'ping',
    kind: 'input',
  });
  assert.ok(prepared.success);
  assert.equal(prepared.rule.ignore, true);
  assert.deepEqual(prepared.rule.actions, []);
  assert.equal(prepared.overlaps, true);
});
test('missing state or trigger references never produce a transition draft', () => {
  const base = protocol();
  assert.equal(
    prepareDiagramTransition(base, { index: 0, id: 'other' }, endpoint(base, 2), {
      kind: 'input',
      messageId: 'ping',
    }).success,
    false,
  );
  assert.equal(
    prepareDiagramTransition(base, endpoint(base, 0), endpoint(base, 2), {
      kind: 'receive',
      messageId: '',
    }).success,
    false,
  );
});
test('existing trigger collisions remain editable drafts and are rejected for execution by the real validator', () => {
  const original = getExampleOriginal('ping_pong');
  const base = protocol();
  const prepared = prepareDiagramTransition(base, endpoint(base, 0), endpoint(base, 2), {
    kind: 'input',
    messageId: 'ping',
  });
  assert.ok(prepared.success && prepared.overlaps);
  const edited = editExperiment(original, '/definitions/0/rules', [...base.rules, prepared.rule]);
  const result = parseExperiment(edited);
  assert.ok(!result.success);
  assert.ok(result.diagnostics.some((item) => item.code === 'rule-conflict'));
  assert.equal(createSimulation(edited).success, false);
});
test('graph appends advance exact A/B references once, preserve pending JSON and never change a captured run', () => {
  const original = getExampleOriginal('ping_pong');
  const base = protocol();
  const created = createSimulation(original);
  assert.ok(created.success);
  const snapshot = created.value.view().snapshot;
  const rules = JSON.stringify(snapshot.configuration.definitions[0]?.rules);
  const pending = { '/definitions/0/rules/0/condition': '{ unfinished' };
  const value = [...base.states, newDiagramState(base)];
  const rebased = rebasePending(pending, original, '/definitions/0/states', value);
  const edited = editExperiment(original, '/definitions/0/states', value);
  assert.equal(edited.definitions[0]?.revision, base.revision + 1);
  assert.equal(edited.protocols.A.revision, base.revision + 1);
  assert.equal(edited.protocols.B.revision, base.revision + 1);
  assert.deepEqual(rebased, pending);
  assert.equal(JSON.stringify(snapshot.configuration.definitions[0]?.rules), rules);
  assert.equal(snapshot.configuration.definitions[0]?.states.length, base.states.length);
});
test('an authored state and transition participate in a real simulation from a blank experiment', () => {
  let draft = createBlankExperiment();
  let base = draft.definitions[0];
  assert.ok(base);
  draft = editExperiment(draft, '/definitions/0/messages', [{ id: 'go', label: 'Go', fields: [] }]);
  draft = editExperiment(draft, '/definitions/0/states', [
    ...base.states,
    { ...newDiagramState(base), terminal: true },
  ]);
  base = draft.definitions[0];
  assert.ok(base);
  const prepared = prepareDiagramTransition(base, endpoint(base, 0), endpoint(base, 1), {
    kind: 'input',
    messageId: 'go',
  });
  assert.ok(prepared.success);
  draft = editExperiment(draft, '/definitions/0/rules', [prepared.rule]);
  draft = editExperiment(draft, '/scenario/inputs', [
    { id: 'start', participant: 'A', timeMs: 0, message: { messageId: 'go', values: {} } },
  ]);
  draft = editExperiment(draft, '/scenario/expectations', [
    { id: 'arrived', participant: 'A', kind: 'state', stateId: 'state_1' },
  ]);
  const engine = createSimulation(draft);
  assert.ok(engine.success);
  const result = engine.value.run();
  assert.equal(result.participants.A.stateId, 'state_1');
  assert.equal(result.participants.B.stateId, 'Idle');
  assert.ok(
    result.events.some((event) => event.kind === 'transition' && event.ruleId === prepared.rule.id),
  );
});
test('state append is compatible with every frozen catalog protocol and leaves originals intact', () => {
  for (const example of EXAMPLES) {
    const original = getExampleOriginal(example.id);
    for (const [index, definition] of original.definitions.entries()) {
      const edited = editExperiment(original, `/definitions/${index}/states`, [
        ...definition.states,
        newDiagramState(definition),
      ]);
      assert.ok(parseExperiment(edited).success);
      assert.equal(original.definitions[index]?.revision, definition.revision);
    }
  }
});
