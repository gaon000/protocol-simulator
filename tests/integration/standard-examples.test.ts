import assert from 'node:assert/strict';
import test from 'node:test';
import { createSimulation } from '../../src/application/create-simulation.ts';
import { changeProfile, editExperiment } from '../../src/application/edit-experiment.ts';
import type { JsonObject, JsonValue } from '../../src/domain/execution-contract.ts';
import { parseExperiment, parseProtocolDefinition } from '../../src/domain/model-validation.ts';
import type { EventTrace, ExperimentDefinition } from '../../src/domain/protocol-model.ts';
import { EXAMPLES, createExampleCopy, getExampleOriginal } from '../../src/examples/catalog.ts';
import { createHttpExperiment, createHttpProtocol } from '../../src/examples/http.ts';
import { createTcpHandshakeExperiment } from '../../src/examples/tcp-handshake.ts';

function engine(experiment: ExperimentDefinition) {
  const created = createSimulation(experiment);
  assert.ok(created.success, JSON.stringify(created));
  return created.value;
}
function data(event: EventTrace): JsonObject {
  return event.data as JsonObject;
}
function packet(event: EventTrace): JsonObject {
  return ((data(event).wire as JsonObject).packet as JsonObject).fields as JsonObject;
}

for (const example of EXAMPLES)
  test(`catalog original and user copy execute the declared ${example.id} behavior`, () => {
    const original = getExampleOriginal(example.id);
    assert.ok(parseExperiment(original).success);
    const baseline = engine(original).run();
    const copy = engine(createExampleCopy(example.id)).run();
    assert.equal(baseline.status, 'completed');
    assert.deepEqual(
      baseline.diagnostics.map((item) => item.code),
      example.diagnosticCodes,
    );
    assert.deepEqual(
      copy.events.map(({ runId: _id, ...event }) => event),
      baseline.events.map(({ runId: _id, ...event }) => event),
    );
    assert.deepEqual(copy.expectations, baseline.expectations);
    if (example.diagnosticCodes.length)
      assert.deepEqual(
        baseline.expectations.map((item) => item.status),
        ['pass', 'pass', 'undetermined'],
      );
    else assert.ok(baseline.expectations.every((item) => item.status === 'pass'));
  });

test('catalog originals are deeply immutable and edits only change isolated versioned user copies', () => {
  const original = getExampleOriginal('http_post');
  const originalJson = JSON.stringify(original);
  const first = createExampleCopy('http_post');
  const second = createExampleCopy('http_post');
  assert.notEqual(first.id, second.id);
  assert.deepEqual(first.origin, { exampleId: 'http_post', version: 1 });
  assert.equal(Reflect.set(original, 'label', 'mutated'), false);
  assert.ok(Object.isFrozen(original.definitions[0]?.messages[0]?.fields));
  const edited = editExperiment(first, '/scenario/inputs/0/message/values/body', '새 본문');
  assert.equal(edited.origin, first.origin);
  assert.equal(second.scenario.inputs[0]?.message.values.body, '안녕하세요');
  assert.equal(JSON.stringify(original), originalJson);
});

test('HTTP binds only to stream and changing the profile cannot silently substitute JSON for HTTP', () => {
  const changed = changeProfile(createHttpExperiment(), 'application', 'datagram');
  assert.equal(changed.definitions[0]?.codec, 'http-1.1');
  const result = createSimulation(changed);
  assert.ok(!result.success);
  assert.ok(result.diagnostics.some((item) => item.code === 'service-incompatible'));
  assert.ok(parseExperiment(changeProfile(changed, 'application', 'stream')).success);
});

test('HTTP response processing wait is separate from the lower-service delay and late responses stay unconsumed', () => {
  const view = engine(createHttpExperiment('delayed')).run();
  assert.equal(view.participants.A.finishedAt, 500);
  assert.equal(view.participants.A.stateId, 'TimedOut');
  assert.equal(view.participants.B.finishedAt, 610);
  const late = view.events.find((event) => event.kind === 'parsed' && event.participant === 'A');
  assert.equal(late?.timeMs, 620);
  assert.ok(!view.events.some((event) => event.kind === 'deliver' && event.participant === 'A'));
  assert.deepEqual(view.diagnostics, []);
});

test('split HTTP and whole-message HTTP have the same parsed bodies and final results', () => {
  const whole = engine(createHttpExperiment('post')).run();
  const split = engine(createHttpExperiment('split')).run();
  const parsed = (events: readonly EventTrace[]) =>
    events
      .filter((event) => event.kind === 'parsed')
      .map((event) => ({ timeMs: event.timeMs, participant: event.participant, data: event.data }));
  assert.deepEqual(parsed(split.events), parsed(whole.events));
  assert.deepEqual(split.expectations, whole.expectations);
  assert.ok(
    split.events.filter((event) => event.kind === 'receive').length >
      whole.events.filter((event) => event.kind === 'receive').length,
  );
});

test('a second HTTP request before the first response is rejected by the single-exchange model', () => {
  let input = createHttpExperiment();
  const actions = input.definitions[0]?.rules[0]?.actions;
  assert.ok(actions?.[0]);
  input = editExperiment(input, '/definitions/0/rules/0/actions', [
    actions[0],
    actions[0],
    ...actions.slice(1),
  ]);
  const view = engine(input).run();
  assert.ok(view.diagnostics.some((item) => item.code === 'unmatched-event'));
  assert.equal(view.participants.B.outcome, 'error');
});

test('HTTP schema errors identify mapped fields, reserved framing headers and case-insensitive duplicates', () => {
  const base = createHttpExperiment();
  const cases: readonly [string, JsonValue][] = [
    ['/definitions/0/messages/0/http/methodFieldId', 'missing'],
    ['/definitions/0/messages/0/http/bodyFieldId', 'host'],
    ['/definitions/0/messages/0/fields/0/options', ['GET', 'DELETE']],
    ['/definitions/0/messages/0/fields/2/name', 'Content-Length'],
    ['/definitions/0/messages/0/fields/3/name', 'host'],
    ['/definitions/0/messages/0/fields/3/placement', 'body'],
  ];
  for (const [path, value] of cases) {
    const invalid = editExperiment(base, path, value);
    const result = parseExperiment(invalid);
    assert.ok(!result.success, path);
    assert.ok(
      result.diagnostics.some((item) => item.code === 'http-schema'),
      path,
    );
  }
  assert.equal(
    parseProtocolDefinition({ ...createHttpProtocol(), codec: 'json-lines' }).success,
    false,
  );
  for (const http of [null, {}, { kind: 'request' }, { kind: 'bogus', wireFieldId: 'wire' }]) {
    const protocol = createHttpProtocol();
    const first = protocol.messages[0];
    assert.ok(first);
    assert.equal(
      parseProtocolDefinition({
        ...protocol,
        messages: [{ ...first, http }, ...protocol.messages.slice(1)],
      }).success,
      false,
    );
  }
});

test('source references survive JSON snapshots but malformed provenance blocks execution', () => {
  const copy = createExampleCopy('tcp_handshake');
  const run = engine(copy);
  run.run();
  assert.deepEqual(JSON.parse(JSON.stringify(run.snapshot)).configuration.origin, copy.origin);
  for (const origin of [
    null,
    {},
    { exampleId: 'http_get', version: 0 },
    { exampleId: 'bad/id', version: 1 },
    { exampleId: 'http_get', version: 1, url: 'unexpected' },
  ])
    assert.equal(parseExperiment({ ...copy, origin }).success, false);
});

test('TCP consumes one sequence number for each SYN while the final ACK consumes none', () => {
  const view = engine(createTcpHandshakeExperiment()).run();
  const sends = view.events.filter((event) => event.kind === 'send');
  assert.deepEqual(
    sends.map((event) => [
      event.participant,
      (data(event).message as JsonObject).messageId,
      packet(event),
    ]),
    [
      ['A', 'syn', { SYN: true, ACK: false, seq: 100, ack: 0 }],
      ['B', 'syn_ack', { SYN: true, ACK: true, seq: 300, ack: 101 }],
      ['A', 'ack', { SYN: false, ACK: true, seq: 101, ack: 301 }],
    ],
  );
  assert.equal(view.participants.A.stateId, 'ESTABLISHED');
  assert.equal(view.participants.B.stateId, 'ESTABLISHED');
  assert.equal(view.participants.A.variables.sndNxt, 101);
  assert.equal(view.participants.B.variables.sndNxt, 301);
  assert.equal(view.participants.A.finishedAt, 20);
  assert.equal(view.participants.B.finishedAt, 30);
});

test('TCP sequence synchronization derives from edited endpoint initial sequence numbers', () => {
  let input = editExperiment(
    createTcpHandshakeExperiment(),
    '/definitions/0/variables/0/initial',
    1459,
  );
  input = editExperiment(input, '/definitions/1/variables/0/initial', 999);
  const view = engine(input).run();
  const sends = view.events.filter((event) => event.kind === 'send');
  assert.deepEqual(
    sends.map((event) => [packet(event).seq, packet(event).ack]),
    [
      [1459, 0],
      [999, 1460],
      [1460, 1000],
    ],
  );
  assert.ok(view.expectations.every((item) => item.status === 'pass'));
});

for (const [path, value, actor] of [
  ['/definitions/1/rules/1/actions/2/values/ack', 100, 'A'],
  ['/definitions/0/rules/2/actions/2/values/ack', 300, 'B'],
  ['/definitions/0/rules/2/actions/2/values/seq', 100, 'B'],
  ['/definitions/0/rules/2/actions/2/values/ackFlag', false, 'B'],
] as const)
  test(`TCP never establishes ${actor} when a handshake guard is violated at ${path}`, () => {
    const input = editExperiment(createTcpHandshakeExperiment(), path, { kind: 'literal', value });
    const view = engine(input).run();
    assert.notEqual(view.participants[actor].stateId, 'ESTABLISHED');
    assert.equal(view.participants[actor].outcome, 'error');
    assert.ok(view.diagnostics.some((item) => item.code === 'unmatched-event'));
  });

test('TCP handshake loss times out without pretending this example implements retransmission', () => {
  const input = editExperiment(createTcpHandshakeExperiment(), '/environment/targetedDrops', [
    { direction: 'AtoB', transmission: 1 },
  ]);
  const view = engine(input).run();
  assert.equal(view.participants.A.stateId, 'TimedOut');
  assert.equal(view.participants.B.stateId, 'LISTEN');
  assert.equal(view.events.filter((event) => event.kind === 'send').length, 1);
  assert.deepEqual(view.diagnostics, []);
});
