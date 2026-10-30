import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSimulation,
  type SimulationOptions,
} from '../../src/application/create-simulation.ts';
import { changeProfile, editExperiment } from '../../src/application/edit-experiment.ts';
import type { JsonObject } from '../../src/domain/execution-contract.ts';
import { parseExperiment } from '../../src/domain/model-validation.ts';
import type { EventTrace, ExperimentDefinition } from '../../src/domain/protocol-model.ts';
import {
  EnvironmentLimit,
  type EnvironmentAdapter,
  type EnvironmentFactory,
} from '../../src/engine/environment-port.ts';
import { createEnvironment } from '../../src/environments/simulated-environment.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';
import { createStopAndWaitExperiment } from '../../src/examples/stop-and-wait.ts';

function engine(input: ExperimentDefinition, options: SimulationOptions = {}) {
  const created = createSimulation(input, options);
  assert.ok(created.success, JSON.stringify(created));
  return created.value;
}
function settings(
  input: ExperimentDefinition,
  direction: 'AtoB' | 'BtoA',
  patch: Record<string, number>,
) {
  return Object.entries(patch).reduce(
    (draft, [key, value]) =>
      editExperiment(draft, `/environment/directions/${direction}/${key}`, value),
    input,
  );
}
function data(event: EventTrace): JsonObject {
  return event.data as JsonObject;
}
function messages(events: readonly EventTrace[], kind: string, participant: string, id: string) {
  return events.filter(
    (event) =>
      event.kind === kind &&
      event.participant === participant &&
      (data(event).message as JsonObject | undefined)?.messageId === id,
  );
}
function variable(input: ExperimentDefinition, id: string, value: number) {
  const index = input.definitions[0]?.variables.findIndex((item) => item.id === id);
  assert.ok(index !== undefined && index >= 0);
  return editExperiment(input, `/definitions/0/variables/${index}/initial`, value);
}
function semantic(events: readonly EventTrace[]) {
  return events.map(({ runId: _runId, ...event }) => event);
}

for (const lostDirection of ['AtoB', 'BtoA'] as const)
  test(`stop-and-wait recovers a targeted ${lostDirection === 'AtoB' ? 'DATA' : 'ACK'} loss with exactly one upper delivery`, () => {
    const input = editExperiment(createStopAndWaitExperiment(), '/environment/targetedDrops', [
      { direction: lostDirection, transmission: 1 },
    ]);
    const view = engine(input).run();
    assert.equal(view.status, 'completed');
    assert.deepEqual(view.diagnostics, []);
    assert.equal(view.participants.A.stateId, 'Done');
    assert.equal(view.participants.A.variables.initialSends, 1);
    assert.equal(view.participants.A.variables.retries, 1);
    assert.equal(view.participants.A.finishedAt, 120);
    assert.equal(messages(view.events, 'send', 'A', 'data').length, 2);
    assert.equal(messages(view.events, 'deliver', 'B', 'data').length, 1);
    assert.ok(view.expectations.every((item) => item.status === 'pass'));
    const drop = view.events.find(
      (event) => event.kind === 'environment' && data(event).outcome === 'drop-targeted',
    );
    assert.ok(drop?.causeEventId);
    assert.deepEqual(data(drop).draws, []);
  });

test('duplicate DATA and ACK packets remain bounded and never redeliver to the upper layer', () => {
  let input = settings(createStopAndWaitExperiment(), 'AtoB', { duplicateRate: 1 });
  input = settings(input, 'BtoA', { duplicateRate: 1 });
  const view = engine(input).run();
  assert.deepEqual(view.diagnostics, []);
  assert.equal(view.participants.A.stateId, 'Done');
  assert.equal(view.participants.A.variables.retries, 0);
  assert.equal(view.participants.B.variables.expectedSeq, 1);
  assert.equal(messages(view.events, 'deliver', 'B', 'data').length, 1);
  assert.equal(messages(view.events, 'send', 'B', 'ack').length, 2);
  assert.equal(messages(view.events, 'parsed', 'A', 'ack').length, 4);
  assert.ok(view.expectations.every((item) => item.status === 'pass'));
});

test('a delayed original may arrive after its duplicate without changing delivered content', () => {
  const input = settings(createStopAndWaitExperiment(), 'AtoB', { jitterMs: 4, duplicateRate: 1 });
  const view = engine(input).run();
  const arrivals = view.events.filter(
    (event) => event.kind === 'receive' && event.participant === 'B',
  );
  assert.deepEqual(
    arrivals.map((event) => [event.timeMs, data(event).copy]),
    [
      [11, 'duplicate'],
      [13, 'original'],
    ],
  );
  assert.equal(messages(view.events, 'deliver', 'B', 'data').length, 1);
  assert.ok(view.expectations.every((item) => item.status === 'pass'));
});

test('a later retransmission can arrive before its original while the receiver delivers only once', () => {
  const input = settings({ ...createStopAndWaitExperiment(), seed: 6 }, 'AtoB', {
    delayMs: 100,
    jitterMs: 100,
  });
  const view = engine(input).run();
  const arrivals = view.events.filter(
    (event) => event.kind === 'receive' && event.participant === 'B',
  );
  assert.deepEqual(
    arrivals.map((event) => [event.timeMs, data(event).transmission]),
    [
      [101, 2],
      [133, 1],
    ],
  );
  assert.equal(messages(view.events, 'deliver', 'B', 'data').length, 1);
  assert.equal(view.participants.A.stateId, 'Done');
  assert.deepEqual(view.diagnostics, []);
});

test('all DATA loss ends after one initial send plus three retries, with an observable expected failure', () => {
  let input = settings(createStopAndWaitExperiment(), 'AtoB', { lossRate: 1 });
  input = editExperiment(input, '/scenario/expectations', [
    { id: 'failed', kind: 'state', participant: 'A', stateId: 'Failed' },
    { id: 'none', kind: 'delivery-count', participant: 'B', messageId: 'data', count: 0 },
  ]);
  const view = engine(input).run();
  assert.equal(view.status, 'completed');
  assert.deepEqual(view.diagnostics, []);
  assert.equal(view.participants.A.stateId, 'Failed');
  assert.equal(view.participants.A.finishedAt, 400);
  assert.equal(view.participants.A.variables.initialSends, 1);
  assert.equal(view.participants.A.variables.retries, 3);
  assert.equal(messages(view.events, 'send', 'A', 'data').length, 4);
  assert.equal(messages(view.events, 'deliver', 'B', 'data').length, 0);
  assert.ok(view.expectations.every((item) => item.status === 'pass'));
});

test('a zero retry allowance still makes one initial attempt and fails at its first timeout', () => {
  const input = settings(variable(createStopAndWaitExperiment(), 'maxRetries', 0), 'AtoB', {
    lossRate: 1,
  });
  const view = engine(input).run();
  assert.equal(view.participants.A.finishedAt, 100);
  assert.equal(view.participants.A.variables.initialSends, 1);
  assert.equal(view.participants.A.variables.retries, 0);
  assert.equal(messages(view.events, 'send', 'A', 'data').length, 1);
});

test('late ACKs after retry exhaustion cannot revive the sender or duplicate receiver deliveries', () => {
  const view = engine(settings(createStopAndWaitExperiment(), 'BtoA', { delayMs: 500 })).run();
  assert.equal(view.status, 'completed');
  assert.deepEqual(view.diagnostics, []);
  assert.equal(view.participants.A.stateId, 'Failed');
  assert.equal(view.participants.A.finishedAt, 400);
  assert.equal(messages(view.events, 'deliver', 'B', 'data').length, 1);
  assert.ok(view.events.some((event) => event.ruleId === 'late_ack_Failed' && event.timeMs > 400));
});

test('a wrong ACK sequence is ignored until a matching retransmission ACK arrives', () => {
  const input = editExperiment(
    createStopAndWaitExperiment(),
    '/definitions/0/rules/1/actions/2/values/seq',
    { kind: 'literal', value: 999 },
  );
  const view = engine(input).run();
  assert.deepEqual(view.diagnostics, []);
  assert.ok(view.events.some((event) => event.ruleId === 'other_ack'));
  assert.equal(view.participants.A.finishedAt, 120);
  assert.equal(view.participants.A.variables.retries, 1);
  assert.equal(messages(view.events, 'deliver', 'B', 'data').length, 1);
});

test('future DATA sequences are not acknowledged or delivered unconditionally', () => {
  const view = engine(variable(createStopAndWaitExperiment(), 'nextSeq', 1)).run();
  assert.equal(view.participants.A.stateId, 'Failed');
  assert.deepEqual(view.diagnostics, []);
  assert.equal(messages(view.events, 'deliver', 'B', 'data').length, 0);
  assert.equal(messages(view.events, 'send', 'B', 'ack').length, 0);
  assert.ok(view.events.some((event) => event.ruleId === 'future_data'));
});

test('seeded loss/jitter/duplication replay identically in full, stepped and batched execution', () => {
  let input = settings(createStopAndWaitExperiment(), 'AtoB', {
    delayMs: 70,
    jitterMs: 60,
    lossRate: 0.2,
    duplicateRate: 0.7,
  });
  input = settings(input, 'BtoA', {
    delayMs: 60,
    jitterMs: 50,
    lossRate: 0.15,
    duplicateRate: 0.6,
  });
  const first = engine(input, { runId: 'first' });
  const stepped = engine(input, { runId: 'step' });
  const batched = engine(input, { runId: 'batch' });
  first.run();
  while (!stepped.result()) stepped.step();
  while (!batched.result()) batched.runBatch(2);
  assert.deepEqual(semantic(first.view().events), semantic(stepped.view().events));
  assert.deepEqual(semantic(first.view().events), semantic(batched.view().events));
  assert.deepEqual(first.view().expectations, stepped.view().expectations);
  for (let seed = 0; seed < 20; seed++) {
    const view = engine({ ...input, seed }).run();
    assert.equal(view.status, 'completed');
    assert.deepEqual(view.diagnostics, []);
    assert.ok(messages(view.events, 'deliver', 'B', 'data').length <= 1);
    assert.ok(Number(view.participants.A.variables.retries) <= 3);
    if (view.participants.A.stateId === 'Done')
      assert.equal(messages(view.events, 'deliver', 'B', 'data').length, 1);
  }
});

test('stream splitting/coalescing preserves every byte exactly once and Ping/Pong message meaning', () => {
  for (const chunkBytes of [1, 7, 65536]) {
    let input = createPingPongExperiment();
    const action = input.definitions[0]?.rules[0]?.actions[1];
    assert.ok(action);
    const actions = input.definitions[0]?.rules[0]?.actions;
    assert.ok(actions);
    input = editExperiment(input, '/definitions/0/rules/0/actions', [
      ...actions.slice(0, 2),
      action,
      ...actions.slice(2),
    ]);
    input = settings(settings(input, 'AtoB', { chunkBytes }), 'BtoA', { chunkBytes });
    const view = engine(input).run();
    assert.deepEqual(view.diagnostics, []);
    assert.ok(view.expectations.every((item) => item.status === 'pass'));
    assert.equal(messages(view.events, 'parsed', 'B', 'ping').length, 2);
    const wireBytes = (event: EventTrace) =>
      (data(event).wire as JsonObject).bytes as readonly number[];
    const sends = view.events
      .filter((event) => event.kind === 'send' && event.participant === 'A')
      .flatMap(wireBytes);
    const received = view.events
      .filter((event) => event.kind === 'receive' && event.participant === 'B')
      .flatMap(wireBytes);
    assert.deepEqual(received, sends);
    if (chunkBytes === 65536) {
      const read = view.events.find(
        (event) => event.kind === 'receive' && event.participant === 'B',
      );
      assert.ok(read);
      assert.equal((data(read).sourceEventIds as readonly string[]).length, 2);
      assert.equal(
        view.events.filter((event) => event.kind === 'receive' && event.participant === 'B').length,
        1,
      );
    }
  }
});

for (const kind of ['close', 'fail'] as const)
  test(`actual stream ${kind} handles a received incomplete prefix with the correct codec semantics`, () => {
    let input = createPingPongExperiment();
    const rules = input.definitions[0]?.rules;
    assert.ok(rules);
    input = editExperiment(input, '/definitions/0/rules', [
      ...rules,
      {
        id: 'connection_failed',
        fromStateId: 'Idle',
        event: { kind: 'connection', state: 'failed' },
        nextStateId: 'Failed',
        actions: [{ kind: 'finish', outcome: 'failure' }],
      },
    ]);
    input = editExperiment(input, '/environment/connections', [
      { direction: 'AtoB', kind, timeMs: 20 },
    ]);
    input = editExperiment(input, '/scenario/expectations', [
      { id: 'closed', participant: 'B', kind: 'state', stateId: 'Failed' },
    ]);
    const prefix: EnvironmentFactory = (definition, random, limits) => {
      const created = createEnvironment(definition, random, limits);
      assert.ok(created.success);
      const inner = created.value;
      return {
        success: true,
        value: {
          ...inner,
          transmit: (tx) =>
            inner.transmit({
              ...tx,
              payload:
                tx.payload.kind === 'bytes'
                  ? { kind: 'bytes', bytes: tx.payload.bytes.slice(0, -1) }
                  : tx.payload,
            }),
        },
      };
    };
    const view = engine(input, { environmentFactory: prefix }).run();
    assert.ok(view.events.some((event) => event.kind === 'receive' && event.participant === 'B'));
    assert.ok(
      view.events.some((event) => event.kind === 'connection' && event.participant === 'B'),
    );
    if (kind === 'close') {
      assert.ok(view.diagnostics.some((item) => item.code === 'incomplete-frame'));
      assert.equal(view.expectations[0]?.status, 'undetermined');
    } else {
      assert.deepEqual(view.diagnostics, []);
      assert.equal(view.participants.B.stateId, 'Failed');
      assert.equal(view.expectations[0]?.status, 'pass');
    }
  });

test('a clean stream EOF after complete messages can be handled by an explicit connection rule', () => {
  let input = createPingPongExperiment();
  const rules = input.definitions[0]?.rules;
  assert.ok(rules);
  input = editExperiment(input, '/definitions/0/rules', [
    ...rules,
    {
      id: 'eof',
      fromStateId: 'Idle',
      nextStateId: 'Idle',
      event: { kind: 'connection', state: 'closed' },
      actions: [],
      ignore: true,
    },
  ]);
  input = editExperiment(input, '/environment/connections', [
    { direction: 'AtoB', kind: 'close', timeMs: 30 },
  ]);
  const view = engine(input).run();
  assert.deepEqual(view.diagnostics, []);
  assert.ok(view.expectations.every((item) => item.status === 'pass'));
});

test('duplicate stream closures are rejected because reconnect is not part of this service model', () => {
  const input = editExperiment(createPingPongExperiment(), '/environment/connections', [
    { direction: 'AtoB', kind: 'close', timeMs: 20 },
    { direction: 'AtoB', kind: 'fail', timeMs: 30 },
  ]);
  const result = parseExperiment(input);
  assert.ok(!result.success);
  assert.ok(result.diagnostics.some((item) => item.code === 'duplicate-connection'));
});

test('environment byte exhaustion is a resource limit, not completed observation or participant failure', () => {
  const factory: EnvironmentFactory = () => ({
    success: true,
    value: {
      initialEvents: () => [],
      transmit: () => {
        throw new EnvironmentLimit();
      },
    },
  });
  const view = engine(createPingPongExperiment(), { environmentFactory: factory }).run();
  assert.equal(view.status, 'limit-reached');
  assert.ok(view.diagnostics.some((item) => item.code === 'environment-buffer-limit'));
  assert.ok(view.expectations.every((item) => item.status === 'undetermined'));
});

test('unexpected disposal errors leave the observation undetermined and still clear active timers', () => {
  const factory: EnvironmentFactory = () => ({
    success: true,
    value: {
      initialEvents: () => [],
      transmit: () => [],
      dispose: () => {
        throw new Error('cleanup failed');
      },
    },
  });
  const run = engine(createPingPongExperiment(), { environmentFactory: factory });
  run.step();
  const view = run.cancel();
  assert.equal(view.status, 'engine-error');
  assert.ok(view.diagnostics.some((item) => item.code === 'environment-dispose'));
  assert.ok(view.expectations.every((item) => item.status === 'undetermined'));
  assert.ok(view.participants.A.timers.every((timer) => !timer.active));
});

test('cancelling a stream run disposes unobserved coalescing buffers', () => {
  let captured: EnvironmentAdapter | undefined;
  const factory: EnvironmentFactory = (definition, random, limits) => {
    const created = createEnvironment(definition, random, limits);
    if (created.success) captured = created.value;
    return created;
  };
  const run = engine(createPingPongExperiment(), { environmentFactory: factory });
  run.step();
  run.cancel();
  assert.ok(captured?.readStream);
  assert.deepEqual([...captured.readStream('read-1')], []);
});

test('form edits break shared template object aliases without changing the other message or old draft', () => {
  const input = createPingPongExperiment();
  const edited = editExperiment(input, '/definitions/0/messages/0/fields/1/defaultValue', '수정됨');
  assert.equal(edited.definitions[0]?.messages[0]?.fields[1]?.defaultValue, '수정됨');
  assert.equal(edited.definitions[0]?.messages[1]?.fields[1]?.defaultValue, '안녕');
  assert.equal(input.definitions[0]?.messages[0]?.fields[1]?.defaultValue, '안녕');
});

test('switching the codec on an unchanged service preserves configured faults and exact references', () => {
  const input = settings(createStopAndWaitExperiment(), 'AtoB', { lossRate: 0.7 });
  const changed = changeProfile(input, 'application', 'datagram');
  assert.deepEqual(changed.environment, input.environment);
  assert.equal(changed.definitions[0]?.codec, 'json-datagram');
  assert.equal(changed.protocols.A.revision, changed.definitions[0]?.revision);
  const view = engine(changed).run();
  assert.deepEqual(view.diagnostics, []);
  assert.ok(
    view.events.some(
      (event) => event.kind === 'environment' && data(event).outcome === 'drop-random',
    ),
  );
});
