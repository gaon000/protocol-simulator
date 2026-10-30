import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRunSession,
  createSimulation,
  type SimulationOptions,
} from '../../src/application/create-simulation.ts';
import type {
  ExperimentDefinition,
  ProtocolDefinition,
  RuleDefinition,
} from '../../src/domain/protocol-model.ts';
import type { EnvironmentFactory } from '../../src/engine/environment-port.ts';
import { experimentFixture } from '../fixtures/protocol-models.ts';
import { createIdealEnvironment } from '../../src/environments/ideal-environment.ts';

function engine(input: unknown = experimentFixture(), options: SimulationOptions = {}) {
  const created = createSimulation(input, options);
  assert.ok(created.success, JSON.stringify(created));
  return created.value;
}
function updateProtocol(
  input: ExperimentDefinition,
  change: (protocol: ProtocolDefinition) => ProtocolDefinition,
): ExperimentDefinition {
  const protocol = input.definitions[0];
  assert.ok(protocol);
  return { ...input, definitions: [change(protocol)] };
}
function delayed(replyDelayMs: number): ExperimentDefinition {
  const input = experimentFixture('json-datagram');
  const environment = input.environment;
  assert.equal(environment.kind, 'datagram');
  return {
    ...input,
    environment: {
      ...environment,
      directions: {
        ...environment.directions,
        BtoA: { ...environment.directions.BtoA, delayMs: replyDelayMs },
      },
    },
  };
}
function ignoreFailed(input: ExperimentDefinition): ExperimentDefinition {
  return updateProtocol(input, (protocol) => ({
    ...protocol,
    rules: [
      ...protocol.rules,
      {
        id: 'late_failure',
        fromStateId: 'Failed',
        event: { kind: 'receive', messageId: 'pong' },
        actions: [],
        ignore: true,
        nextStateId: 'Failed',
      },
    ],
  }));
}

for (const codec of ['json-lines', 'json-datagram', 'logical-packet'] as const)
  test(`runs the actual ${codec} Ping/Pong flow with separate participant state`, () => {
    const run = engine(experimentFixture(codec));
    assert.equal(run.view().status, 'idle');
    const view = run.run();
    assert.equal(view.status, 'completed');
    assert.equal(view.timeMs, 600);
    assert.equal(view.participants.A.stateId, 'Done');
    assert.equal(view.participants.A.finishedAt, 20);
    assert.equal(view.participants.A.variables.counter, 1);
    assert.equal(view.participants.B.variables.counter, 0);
    assert.ok(view.expectations.every((item) => item.status === 'pass'));
    assert.deepEqual(view.diagnostics, []);
    assert.ok(view.events.some((event) => event.kind === 'parsed' && event.causeEventId));
    assert.ok(
      !view.events.some(
        (event) =>
          event.kind === 'timer' &&
          typeof event.data === 'object' &&
          event.data &&
          'operation' in event.data &&
          event.data.operation === 'expire',
      ),
    );
    assert.deepEqual(JSON.parse(JSON.stringify(run.result())), run.result());
  });

test('full, single-step and paused batch runs have identical semantic traces', () => {
  const one = engine(undefined, { runId: 'first' });
  const two = engine(undefined, { runId: 'second' });
  const three = engine();
  one.run();
  while (!two.result()) two.step();
  three.runBatch(2);
  assert.equal(three.view().status, 'paused');
  three.pause();
  while (!three.result()) three.runBatch(3);
  const semantic = (events: ReturnType<typeof one.view>['events']) =>
    events.map(({ runId: _runId, ...event }) => event);
  assert.deepEqual(semantic(one.view().events), semantic(two.view().events));
  assert.deepEqual(semantic(one.view().events), semantic(three.view().events));
});

test('valid response at the exact deadline beats expiry, but a later response does not', () => {
  const exact = engine(delayed(490)).run();
  assert.equal(exact.participants.A.finishedAt, 500);
  assert.equal(exact.participants.A.outcome, 'success');
  const late = engine(ignoreFailed(delayed(491))).run();
  assert.equal(late.participants.A.finishedAt, 500);
  assert.equal(late.participants.A.outcome, 'failure');
  assert.equal(late.participants.A.stateId, 'Failed');
  assert.deepEqual(late.diagnostics, []);
});

test('expected timeout is a completed observation and can pass its expected Failed state', () => {
  const input = delayed(1000);
  const view = engine({
    ...input,
    scenario: {
      ...input.scenario,
      expectations: [{ id: 'timeout', kind: 'state', participant: 'A', stateId: 'Failed' }],
    },
  }).run();
  assert.equal(view.status, 'completed');
  assert.equal(view.expectations[0]?.status, 'pass');
  assert.equal(view.participants.A.outcome, 'failure');
});

test('restarted and cancelled timer generations never execute obsolete expiry entries', () => {
  const input = updateProtocol(delayed(1000), (protocol) => ({
    ...protocol,
    rules: protocol.rules.map((rule) =>
      rule.id !== 'start'
        ? rule
        : {
            ...rule,
            actions: [
              ...rule.actions,
              { kind: 'cancel-timer', timerId: 'response' },
              {
                kind: 'start-timer',
                timerId: 'response',
                durationMs: { kind: 'literal', value: 100 },
              },
            ],
          },
    ),
  }));
  const view = engine(input).run();
  assert.equal(view.participants.A.finishedAt, 100);
  const expires = view.events.filter(
    (event) =>
      event.kind === 'timer' &&
      event.data &&
      typeof event.data === 'object' &&
      'operation' in event.data &&
      event.data.operation === 'expire',
  );
  assert.equal(expires.length, 1);
  assert.equal(expires[0]?.timeMs, 100);
  assert.ok(view.participants.A.timers.every((timer) => !timer.active));
});

test('runtime-overlapping conditions produce a diagnostic before any actions run', () => {
  const input = updateProtocol(experimentFixture(), (protocol) => {
    const original = protocol.rules[0];
    assert.ok(original);
    const rule = (id: string, threshold: number): RuleDefinition => ({
      ...original,
      id,
      condition: {
        kind: 'compare',
        operator: 'gte',
        left: { kind: 'field', fieldId: 'sequence' },
        right: { kind: 'literal', value: threshold },
      },
    });
    return {
      ...protocol,
      rules: [rule('first', 0), rule('second', 1), ...protocol.rules.slice(1)],
    };
  });
  const view = engine(input).run();
  assert.equal(view.participants.A.outcome, 'error');
  assert.equal(view.participants.A.variables.counter, 0);
  assert.ok(view.diagnostics.some((item) => item.code === 'rule-conflict'));
  assert.ok(!view.events.some((event) => event.kind === 'send'));
  assert.ok(view.expectations.every((item) => item.status === 'undetermined'));
});

test('dynamic field validation rolls back earlier staged assignments and sends nothing', () => {
  const input = updateProtocol(experimentFixture(), (protocol) => ({
    ...protocol,
    rules: protocol.rules.map((rule) =>
      rule.id !== 'start'
        ? rule
        : {
            ...rule,
            actions: rule.actions.map((action) =>
              action.kind !== 'send'
                ? action
                : {
                    ...action,
                    values: {
                      sequence: {
                        kind: 'add',
                        left: { kind: 'field', fieldId: 'sequence' },
                        right: { kind: 'literal', value: 255 },
                      },
                    },
                  },
            ),
          },
    ),
  }));
  const view = engine(input).run();
  assert.equal(view.participants.A.stateId, 'Idle');
  assert.equal(view.participants.A.variables.counter, 0);
  assert.ok(view.diagnostics.some((item) => item.code === 'field-value'));
  assert.ok(!view.events.some((event) => event.kind === 'send'));
});

test('dynamic arithmetic overflow is diagnosed without committing participant variables', () => {
  const input = updateProtocol(experimentFixture(), (protocol) => ({
    ...protocol,
    variables: protocol.variables.map((variable) =>
      variable.id === 'counter' ? { ...variable, initial: Number.MAX_SAFE_INTEGER } : variable,
    ),
  }));
  const view = engine(input).run();
  assert.ok(view.diagnostics.some((item) => item.code === 'integer-overflow'));
  assert.equal(view.participants.A.variables.counter, Number.MAX_SAFE_INTEGER);
});

test('cancel leaves all checks undetermined, releases the queue and makes future run calls inert', () => {
  const run = engine();
  run.step();
  const view = run.cancel();
  assert.equal(view.status, 'cancelled');
  assert.ok(view.participants.A.timers.every((timer) => !timer.active));
  assert.ok(view.expectations.every((item) => item.status === 'undetermined'));
  assert.deepEqual(run.run(), view);
});

test('queue, trace, frame and pending-buffer limits cannot be reported as successful observations', () => {
  for (const limits of [
    { maxEvents: 4 },
    { maxTraceBytes: 1 },
    { maxMessageBytes: 5 },
    { maxBufferBytes: 5 },
  ]) {
    const run = engine(undefined, { limits });
    const view = run.run();
    assert.equal(view.status, 'limit-reached', JSON.stringify(view.diagnostics));
    assert.ok(view.expectations.every((item) => item.status === 'undetermined'));
  }
});

test('zero-delay repeated sends stop at a finite resource limit', () => {
  let input = experimentFixture('json-datagram');
  const environment = input.environment;
  assert.equal(environment.kind, 'datagram');
  input = {
    ...input,
    environment: {
      ...environment,
      directions: {
        AtoB: { delayMs: 0, jitterMs: 0, lossRate: 0, duplicateRate: 0 },
        BtoA: { delayMs: 0, jitterMs: 0, lossRate: 0, duplicateRate: 0 },
      },
    },
  };
  input = updateProtocol(input, (protocol) => ({
    ...protocol,
    rules: [
      {
        id: 'begin',
        fromStateId: 'Idle',
        event: { kind: 'input', messageId: 'ping' },
        actions: [
          {
            kind: 'send',
            messageId: 'ping',
            values: { sequence: { kind: 'field', fieldId: 'sequence' } },
          },
        ],
        nextStateId: 'Idle',
      },
      {
        id: 'echo',
        fromStateId: 'Idle',
        event: { kind: 'receive', messageId: 'ping' },
        actions: [
          {
            kind: 'send',
            messageId: 'ping',
            values: { sequence: { kind: 'field', fieldId: 'sequence' } },
          },
        ],
        nextStateId: 'Idle',
      },
    ],
  }));
  const view = engine(input, { limits: { maxEvents: 64 } }).run();
  assert.equal(view.status, 'limit-reached');
  assert.ok(view.events.length <= 64);
});

test('session reset/replacement fences stale callbacks and preserves valid runs when new input is invalid', () => {
  const session = createRunSession();
  const first = session.start(experimentFixture());
  assert.ok(first.success);
  first.value.step();
  assert.equal(session.start({}).success, false);
  assert.equal(session.current(), first.value);
  const second = session.start(experimentFixture());
  assert.ok(second.success);
  assert.equal(first.value.view().status, 'cancelled');
  let called = false;
  assert.equal(
    session.apply(first.value.runId, () => {
      called = true;
    }),
    false,
  );
  assert.equal(called, false);
  assert.equal(
    session.apply(second.value.runId, (run) => {
      run.step();
    }),
    true,
  );
  assert.equal(second.value.view().participants.A.variables.counter, 1);
  session.reset();
  assert.equal(session.current(), undefined);
  assert.equal(
    session.apply(second.value.runId, () => {}),
    false,
  );
});

test('run views and snapshots do not expose mutable engine state', () => {
  const input = experimentFixture();
  const run = engine(input);
  const before = run.view();
  Reflect.set(input, 'seed', 99);
  run.step();
  assert.equal(before.participants.A.variables.counter, 0);
  assert.equal(run.snapshot.seed, 42);
  assert.equal(Reflect.set(run.view().participants.A.variables, 'counter', 99), false);
  assert.equal(run.view().participants.A.variables.counter, 1);
});

test('the explicit P2 ideal adapter still rejects faults instead of silently ignoring them', () => {
  const input = experimentFixture('json-datagram');
  const environment = input.environment;
  assert.equal(environment.kind, 'datagram');
  const created = createSimulation(
    {
      ...input,
      environment: { ...environment, targetedDrops: [{ direction: 'AtoB', transmission: 1 }] },
    },
    { environmentFactory: createIdealEnvironment },
  );
  assert.ok(!created.success);
  assert.equal(created.diagnostics[0]?.code, 'environment-not-supported');
});

test('unexpected adapter exceptions are engine errors with undetermined checks', () => {
  const broken: EnvironmentFactory = () => ({
    success: true,
    value: {
      initialEvents: () => [],
      transmit: () => {
        throw new Error('broken adapter');
      },
    },
  });
  const view = engine(undefined, { environmentFactory: broken }).run();
  assert.equal(view.status, 'engine-error');
  assert.ok(view.expectations.every((item) => item.status === 'undetermined'));
});

test('injected environments receive a fresh seeded PRNG for each replay', () => {
  const seeded: EnvironmentFactory = (_definition, random) => ({
    success: true,
    value: {
      initialEvents: () => [],
      transmit: (item) => [
        {
          kind: 'delivery',
          timeMs: item.timeMs + Math.floor(random() * 100),
          from: item.from,
          to: item.to,
          payload: item.payload,
          causeEventId: item.causeEventId,
        },
      ],
    },
  });
  const input = experimentFixture('json-datagram');
  const times = (seed: number) =>
    engine({ ...input, seed }, { environmentFactory: seeded })
      .run()
      .events.map((event) => [event.kind, event.timeMs]);
  assert.deepEqual(times(42), times(42));
  assert.notDeepEqual(times(42), times(43));
});

test('run metadata length does not affect trace quota or semantic results', () => {
  const short = engine(undefined, { runId: 'x', limits: { maxTraceBytes: 3000 } }).run();
  const long = engine(undefined, {
    runId: 'x'.repeat(1000),
    limits: { maxTraceBytes: 3000 },
  }).run();
  assert.equal(short.status, long.status);
  assert.equal(short.events.length, long.events.length);
  assert.deepEqual(short.expectations, long.expectations);
});

test('an initially terminal participant is complete at virtual time zero', () => {
  const input = updateProtocol(experimentFixture(), (protocol) => ({
    ...protocol,
    initialStateId: 'Done',
  }));
  const run = engine({ ...input, scenario: { ...input.scenario, inputs: [] } }).run();
  assert.equal(run.participants.A.finishedAt, 0);
  assert.equal(run.participants.A.outcome, 'success');
});
