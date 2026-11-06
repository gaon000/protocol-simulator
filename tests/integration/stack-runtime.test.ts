import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createStackRunSession,
  createStackSimulation,
  createStackSimulationFromSnapshot,
  type StackSimulationOptions,
} from '../../src/application/create-stack-simulation.ts';
import { planDatagram } from '../../src/domain/datagram-policy.ts';
import type { ValidationResult } from '../../src/domain/protocol-model.ts';
import type { StackTrace } from '../../src/domain/stack-model.ts';
import { parseStackTrace, readArtifactRange } from '../../src/domain/stack-payloads.ts';
import { adaptLegacyApplication } from '../../src/domain/stack-protocol-validation.ts';
import type { StackView } from '../../src/domain/stack-runtime-model.ts';
import { createHttpExperiment, createHttpProtocol } from '../../src/examples/http.ts';
import { stackExperimentFixture } from '../fixtures/stack-models.ts';
import {
  changeStackTransport,
  mergedStackFixture,
  repeatedAppFixture,
  splitStackFixture,
} from '../fixtures/stack-runtime.ts';

function ok<T>(result: ValidationResult<T>): T {
  assert.equal(result.success, true, JSON.stringify(result));
  if (!result.success) throw new Error('Invalid fixture');
  return result.value;
}
function engine(input: unknown = stackExperimentFixture(), options: StackSimulationOptions = {}) {
  return ok(createStackSimulation(input, { runId: 'run', ...options }));
}
function data(event: StackTrace): Record<string, unknown> {
  return event.data as Record<string, unknown>;
}
function at(view: StackView, endpoint: string, kind?: StackTrace['kind']) {
  return view.events.filter(
    (event) =>
      `${event.endpoint.participant}/${event.endpoint.instanceId}` === endpoint &&
      (!kind || event.kind === kind),
  );
}

test('one clock routes four isolated runtimes, actual port acceptance and codec bytes without recursive dispatch', () => {
  const run = engine();
  const first = run.step();
  assert.equal(first.instances['A/app']?.stateId, 'Waiting');
  assert.equal(first.instances['A/transport']?.variables.size, 0);
  assert.ok(at(first, 'A/app', 'service-accepted').length);
  assert.equal(at(first, 'A/transport', 'service-received').length, 0);
  const next = run.step();
  assert.equal(next.instances['A/transport']?.variables.size, 88);
  assert.equal(next.instances['B/transport']?.variables.size, 0);
  const view = run.run();
  assert.equal(view.status, 'completed');
  assert.equal(view.timeMs, 1000);
  assert.deepEqual(view.diagnostics, []);
  assert.equal(view.instances['A/app']?.stateId, 'Done');
  assert.equal(view.instances['B/app']?.stateId, 'Idle');
  assert.equal(view.instances['A/app']?.variables.counter, 1);
  assert.equal(view.instances['B/app']?.variables.counter, 0);
  assert.ok(view.expectations.every((item) => item.status === 'pass'));
  assert.equal(view.instances['A/transport']?.outcome, 'active');
  assert.equal(view.usage.liveBytes, 0);
  assert.equal(parseStackTrace(view.events, view.artifacts).success, true);
  const wire = at(view, 'A/app', 'send')[0];
  assert.ok(wire?.payloads[0]);
  const bytes = ok(readArtifactRange(view.artifacts, wire.payloads[0]));
  assert.equal(
    new TextDecoder().decode(bytes),
    '{"messageId":"ping","fields":{"number":1,"text":"안녕","mode":"safe","urgent":false}}\n',
  );
});

test('run, step, arbitrary batches, observer stops and snapshot replay have identical committed semantics', () => {
  const input = splitStackFixture(57);
  const full = engine(input).run();
  for (const budget of [1, 2, 7]) {
    const run = engine(input);
    while (!run.result()) run.runBatch(budget);
    assert.deepEqual(run.result(), full);
  }
  const stopped = engine(input);
  while (!stopped.result()) stopped.runBatch(25, () => true);
  assert.deepEqual(stopped.result(), full);
  const replay = ok(
    createStackSimulationFromSnapshot(JSON.parse(JSON.stringify(full.snapshot)), { runId: 'run' }),
  );
  assert.deepEqual(replay.run(), full);
  assert.equal(
    createStackSimulationFromSnapshot({ ...full.snapshot, engineVersion: 'future' }).success,
    false,
  );
});

test('same-time network and newly queued local handoffs finish before the app deadline timer', () => {
  const fixture = stackExperimentFixture();
  const input = {
    ...fixture,
    link: {
      ...fixture.link,
      environment: {
        ...fixture.link.environment,
        directions: {
          AtoB: { delayMs: 250, jitterMs: 0, lossRate: 0, duplicateRate: 0 },
          BtoA: { delayMs: 250, jitterMs: 0, lossRate: 0, duplicateRate: 0 },
        },
      },
    },
  };
  const view = engine(input).run();
  assert.equal(view.instances['A/app']?.finishedAt, 500);
  assert.equal(view.instances['A/app']?.outcome, 'success');
  assert.equal(
    at(view, 'A/app', 'timer').filter((event) => data(event).operation === 'expire').length,
    0,
  );
  assert.equal(view.diagnostics.length, 0);
});

test('same-named timers are scoped by endpoint/generation and providers continue after app completion', () => {
  const input = changeStackTransport(stackExperimentFixture(), (protocol) => ({
    ...protocol,
    timers: [{ id: 'response' }],
    rules: [
      ...protocol.rules.map((rule) =>
        rule.id === 'accept_write'
          ? {
              ...rule,
              actions: [
                ...rule.actions,
                {
                  kind: 'start-timer' as const,
                  timerId: 'response',
                  durationMs: { kind: 'literal' as const, value: 8 },
                },
              ],
            }
          : rule,
      ),
      {
        id: 'tick',
        fromStateId: 'Ready',
        nextStateId: 'Ready',
        event: { kind: 'timer', timerId: 'response' },
        actions: [{ kind: 'assign', variableId: 'size', value: { kind: 'literal', value: 999 } }],
      },
    ],
  }));
  const view = engine(input).run();
  assert.deepEqual(view.diagnostics, []);
  assert.equal(view.instances['A/app']?.finishedAt, 2);
  for (const endpoint of ['A/transport', 'B/transport']) {
    assert.equal(view.instances[endpoint]?.variables.size, 999);
    assert.equal(
      at(view, endpoint, 'timer').filter((event) => data(event).operation === 'expire').length,
      1,
    );
  }
  assert.equal(view.instances['A/app']?.variables.counter, 1);
});

test('split UTF-8/frames and merged reads keep actual contributing ranges and atomic multi-frame transitions', () => {
  const split = engine(splitStackFixture(57)).run();
  assert.deepEqual(split.diagnostics, []);
  const parsed = at(split, 'B/app', 'parsed')[0];
  assert.ok(parsed);
  assert.equal(parsed.sourceEventIds.length, 2);
  const sources = parsed.sourceEventIds.map((id) =>
    split.events.find((event) => event.eventId === id),
  );
  assert.ok(
    sources.every((source) => source?.kind === 'receive' && source.endpoint.participant === 'B'),
  );
  const mergedRun = engine(mergedStackFixture());
  const groups: StackTrace[][] = [];
  while (!mergedRun.result())
    mergedRun.runBatch(1, (events) => {
      groups.push([...events]);
      return false;
    });
  const merged = mergedRun.result();
  assert.ok(merged);
  assert.deepEqual(merged.diagnostics, []);
  assert.equal(merged.expectations[0]?.status, 'pass');
  assert.ok(
    groups.some(
      (events) =>
        events.filter(
          (event) =>
            event.kind === 'parsed' &&
            event.endpoint.participant === 'B' &&
            event.endpoint.instanceId === 'app',
        ).length === 2,
    ),
  );
  const reads = at(merged, 'B/transport', 'service-indication');
  assert.equal(reads.length, 1);
  const ranges = data(reads[0] as StackTrace).sourceRanges as readonly {
    sourceEventId: string;
    length: number;
  }[];
  assert.equal(ranges.length, 2);
  assert.equal(new Set(ranges.map((range) => range.sourceEventId)).size, 2);
  assert.ok(
    ranges.every((range) => (reads[0] as StackTrace).sourceEventIds.includes(range.sourceEventId)),
  );
  assert.equal(parseStackTrace(merged.events, merged.artifacts).success, true);
});

test('rule faults roll back prior assignments, outgoing effects and timers and taint only dependent expectations', () => {
  const input = changeStackTransport(stackExperimentFixture(), (protocol) => ({
    ...protocol,
    rules: protocol.rules.map((rule) =>
      rule.id !== 'accept_write'
        ? rule
        : {
            ...rule,
            actions: [
              ...rule.actions,
              {
                kind: 'assign',
                variableId: 'size',
                value: {
                  kind: 'add',
                  left: { kind: 'literal', value: Number.MAX_SAFE_INTEGER },
                  right: { kind: 'literal', value: 1 },
                },
              },
            ],
          },
    ),
  }));
  let transmissions = 0;
  const view = engine(input, {
    datagramPlanner: (...args) => {
      transmissions++;
      throw new Error(`Should not transmit ${args[3]}`);
    },
  }).run();
  assert.equal(view.status, 'completed');
  assert.equal(transmissions, 0);
  assert.equal(view.instances['A/transport']?.variables.size, 0);
  assert.equal(at(view, 'A/transport', 'send').length, 0);
  assert.equal(at(view, 'A/transport', 'transition').length, 0);
  assert.equal(view.instances['A/transport']?.outcome, 'error');
  assert.equal(view.expectations[0]?.status, 'undetermined');
  assert.equal(view.expectations[1]?.status, 'pass');
  assert.ok(view.diagnostics.some((item) => item.code === 'integer'));
});

test('a later bad frame rule retains earlier committed messages in the same read but none of the rejected rule effects', () => {
  const input = mergedStackFixture();
  const source = repeatedAppFixture();
  const app = ok(
    adaptLegacyApplication({
      ...source,
      variables: [{ id: 'counter', type: 'integer', initial: 0 }],
      timers: [{ id: 'check' }],
      rules: source.rules.map((rule) =>
        rule.id !== 'record'
          ? rule
          : {
              ...rule,
              actions: [
                {
                  kind: 'assign',
                  variableId: 'counter',
                  value: { kind: 'field', fieldId: 'sequence' },
                },
                {
                  kind: 'start-timer',
                  timerId: 'check',
                  durationMs: {
                    kind: 'subtract',
                    left: { kind: 'literal', value: 1 },
                    right: { kind: 'field', fieldId: 'sequence' },
                  },
                },
                ...rule.actions,
              ],
            },
      ),
    }),
  );
  const view = engine({ ...input, definitions: [app, ...input.definitions.slice(1)] }).run();
  assert.equal(view.status, 'completed');
  assert.equal(view.instances['A/app']?.variables.counter, 1);
  assert.equal(at(view, 'A/app', 'deliver').length, 1);
  assert.equal(view.expectations[0]?.status, 'undetermined');
  assert.ok(view.diagnostics.some((item) => item.code === 'timer-duration'));
});

for (const [key, value] of [
  ['maxTraceEvents', 2],
  ['maxPendingOperations', 1],
  ['maxPayloadBytes', 1],
  ['maxLiveBytes', 1],
  ['maxPortBytes', 1],
  ['maxArtifactBytes', 200],
] as const)
  test(`${key} reservation failure leaves no partial transition, accepted send or retained temporary payload`, () => {
    const input = stackExperimentFixture();
    const view = engine({ ...input, limits: { ...input.limits, [key]: value } }).run();
    assert.equal(view.status, 'limit-reached', JSON.stringify(view.diagnostics));
    assert.equal(view.events.length, 0);
    assert.equal(view.instances['A/app']?.stateId, 'Idle');
    assert.equal(view.instances['A/app']?.variables.counter, 0);
    assert.equal(view.artifacts.payloads.length, 0);
    assert.equal(view.usage.uniqueBytes, 0);
    assert.equal(view.usage.liveBytes, 0);
    assert.ok(view.expectations.every((item) => item.status === 'undetermined'));
  });

test('global processed work and 0ms protocol loops are bounded across all layers', () => {
  const fixture = stackExperimentFixture();
  const app = repeatedAppFixture();
  const loop = ok(
    adaptLegacyApplication({
      ...app,
      rules: app.rules
        .filter((rule) => rule.id !== 'record')
        .map((rule) =>
          rule.id !== 'reply'
            ? rule
            : {
                ...rule,
                actions: [
                  {
                    kind: 'send',
                    messageId: 'ping',
                    values: { sequence: { kind: 'field', fieldId: 'sequence' } },
                  },
                ],
              },
        ),
    }),
  );
  const input = {
    ...fixture,
    definitions: [loop, ...fixture.definitions.slice(1)],
    limits: { ...fixture.limits, maxEvents: 50 },
    link: {
      ...fixture.link,
      environment: {
        ...fixture.link.environment,
        directions: {
          AtoB: { delayMs: 0, jitterMs: 0, lossRate: 0, duplicateRate: 0 },
          BtoA: { delayMs: 0, jitterMs: 0, lossRate: 0, duplicateRate: 0 },
        },
      },
    },
  };
  const view = engine(input).run();
  assert.equal(view.status, 'limit-reached');
  assert.equal(view.processedOperations, 50);
  assert.equal(view.timeMs, 0);
  assert.ok(view.events.length > 100);
  assert.ok(view.diagnostics.some((item) => item.code === 'operation-limit'));
});

test('codec buffer exhaustion keeps the observed prefix and rolls back the entire overflowing operation', () => {
  const fixture = splitStackFixture(1);
  const view = engine({ ...fixture, limits: { ...fixture.limits, maxCodecBufferBytes: 1 } }).run();
  assert.equal(view.status, 'limit-reached');
  assert.ok(view.diagnostics.some((item) => item.code === 'buffer-limit'));
  assert.equal(at(view, 'B/app', 'receive').length, 1);
  assert.equal(at(view, 'B/app', 'parsed').length, 0);
  assert.equal(view.instances['B/app']?.stateId, 'Idle');
  assert.equal(parseStackTrace(view.events, view.artifacts).success, true);
});

test('internal planner exceptions are engine errors while protocol errors remain endpoint diagnostics', () => {
  const view = engine(undefined, {
    datagramPlanner: () => {
      throw new Error('Planner broke');
    },
  }).run();
  assert.equal(view.status, 'engine-error');
  assert.equal(view.instances['A/transport']?.stateId, 'Ready');
  assert.equal(at(view, 'A/transport', 'transition').length, 0);
  assert.ok(view.diagnostics.some((item) => item.code === 'engine-exception'));
});

test('cancel/reset/replacement fence callbacks and retain previously captured bytes and immutable snapshots', () => {
  const session = createStackRunSession();
  const first = ok(session.start(stackExperimentFixture()));
  const prefix = first.step();
  const range = prefix.events.find((event) => event.kind === 'send')?.payloads[0];
  assert.ok(range);
  const expected = ok(readArtifactRange(prefix.artifacts, range));
  assert.equal(session.start({}).success, false);
  assert.equal(session.current(), first);
  session.reset();
  assert.equal(first.view().status, 'cancelled');
  assert.equal(first.view().usage.liveBytes, 0);
  let calls = 0;
  assert.equal(
    session.apply(first.runId, () => {
      calls++;
    }),
    false,
  );
  const second = ok(session.startSnapshot(prefix.snapshot));
  assert.notEqual(first.runId, second.runId);
  assert.equal(
    session.apply(first.runId, () => {
      calls++;
    }),
    false,
  );
  assert.equal(calls, 0);
  assert.deepEqual(ok(readArtifactRange(prefix.artifacts, range)), expected);
  assert.deepEqual(ok(readArtifactRange(first.view().artifacts, range)), expected);
  second.run();
  assert.equal(
    session.apply(second.runId, () => {
      calls++;
    }),
    false,
  );
  assert.ok(Object.isFrozen(prefix.events));
  assert.ok(Object.isFrozen(prefix.snapshot.configuration));
});

test('observer exceptions stop after a committed operation and preserve exact continuation semantics', () => {
  const run = engine();
  assert.throws(
    () =>
      run.runBatch(100, () => {
        throw new Error('Observer');
      }),
    /Observer/,
  );
  assert.equal(run.view().status, 'paused');
  assert.equal(run.view().instances['A/app']?.stateId, 'Waiting');
  assert.deepEqual(run.run(), engine().run());
  assert.throws(() => engine().runBatch(0), RangeError);
});

test('legacy JSON values with a byte-like tag remain ordinary JSON in the explicit compatibility path', () => {
  const fixture = stackExperimentFixture();
  const definition = fixture.definitions[0];
  assert.equal(definition?.mode, 'legacy-application');
  if (definition?.mode !== 'legacy-application') throw new Error('Wrong fixture');
  const json = { kind: 'bytes', encoding: 'made-up', data: 'literal JSON' };
  const app = ok(
    adaptLegacyApplication({
      ...definition.source,
      variables: [...definition.source.variables, { id: 'legacy', type: 'json', initial: null }],
      rules: definition.source.rules.map((rule) =>
        rule.id === 'start'
          ? {
              ...rule,
              actions: [
                { kind: 'assign', variableId: 'legacy', value: { kind: 'literal', value: json } },
                ...rule.actions,
              ],
            }
          : rule,
      ),
    }),
  );
  const view = engine({ ...fixture, definitions: [app, ...fixture.definitions.slice(1)] }).run();
  assert.deepEqual(view.diagnostics, []);
  assert.deepEqual(view.instances['A/app']?.variables.legacy, json);
});

test('existing HTTP application semantics execute through the test transport with split header/body bytes', () => {
  const app = ok(adaptLegacyApplication(createHttpProtocol()));
  const fixture = splitStackFixture(3);
  const legacy = createHttpExperiment('post');
  const instance = { id: 'app', definition: { id: app.id, revision: app.revision } };
  const input = {
    ...fixture,
    definitions: [app, ...fixture.definitions.slice(1)],
    nodes: {
      A: { instances: [instance, fixture.nodes.A.instances[1]] },
      B: { instances: [instance, fixture.nodes.B.instances[1]] },
    },
    scenario: {
      schemaVersion: 2,
      id: 'http_test',
      observationMs: legacy.scenario.observationMs,
      inputs: legacy.scenario.inputs.map(({ participant, ...input }) => ({
        ...input,
        target: { participant, instanceId: 'app' },
      })),
      expectations: legacy.scenario.expectations.map(({ participant, ...expectation }) => ({
        ...expectation,
        target: { participant, instanceId: 'app' },
      })),
    },
  };
  const view = engine(input).run();
  assert.equal(view.status, 'completed');
  assert.deepEqual(view.diagnostics, []);
  assert.ok(view.expectations.every((expectation) => expectation.status === 'pass'));
  assert.ok(at(view, 'B/app', 'parsed')[0]?.sourceEventIds.length === 2);
});

test('native scalar byte-codec protocols share the same staged rule and wire path without a legacy wrapper', () => {
  const fixture = stackExperimentFixture();
  const app = fixture.definitions[0];
  if (app?.mode !== 'legacy-application') throw new Error('Wrong fixture');
  const { schemaVersion: _schema, lowerService: _lower, ...body } = app.source;
  const native = { ...body, schemaVersion: 2, mode: 'stack-protocol', requires: app.requires };
  const view = engine({ ...fixture, definitions: [native, ...fixture.definitions.slice(1)] }).run();
  assert.deepEqual(view.diagnostics, []);
  assert.ok(view.expectations.every((item) => item.status === 'pass'));
});

test('modeled service failure is delivered on the local queue and can satisfy a failure-state expectation', () => {
  const fixture = stackExperimentFixture();
  const old = fixture.definitions[0];
  if (old?.mode !== 'legacy-application') throw new Error('Wrong fixture');
  const app = ok(
    adaptLegacyApplication({
      ...old.source,
      rules: [
        ...old.source.rules,
        {
          id: 'service_failed',
          fromStateId: 'Waiting',
          nextStateId: 'Failed',
          event: { kind: 'connection', state: 'failed' },
          actions: [{ kind: 'finish', outcome: 'failure' }],
        },
      ],
    }),
  );
  const input = changeStackTransport(
    {
      ...fixture,
      definitions: [app, ...fixture.definitions.slice(1)],
      scenario: {
        ...fixture.scenario,
        expectations: [
          {
            id: 'failed',
            kind: 'state',
            target: { participant: 'A', instanceId: 'app' },
            stateId: 'Failed',
          },
        ],
      },
    },
    (protocol) => ({
      ...protocol,
      states: [...protocol.states, { id: 'Failed', label: 'Failed', terminal: true }],
      rules: protocol.rules.map((rule) =>
        rule.id !== 'accept_write'
          ? rule
          : {
              ...rule,
              nextStateId: 'Failed',
              actions: [
                { kind: 'service-indicate', portId: 'upper', operation: 'failed' },
                { kind: 'finish', outcome: 'failure' },
              ],
            },
      ),
    }),
  );
  const run = engine(input);
  run.step();
  const provider = run.step();
  assert.equal(provider.instances['A/transport']?.outcome, 'failure');
  assert.equal(provider.instances['A/app']?.stateId, 'Waiting');
  assert.equal(provider.instances['A/app']?.ports.requires, 'ready');
  const view = run.run();
  assert.deepEqual(view.diagnostics, []);
  assert.equal(view.expectations[0]?.status, 'pass');
  assert.equal(view.instances['A/app']?.tainted, false);
  assert.equal(view.instances['A/app']?.ports.requires, 'failed');
});

for (const operation of ['closed', 'failed'] as const)
  test(`${operation} preserves actual partial bytes and distinguishes EOF errors from a modeled lower failure`, () => {
    const fixture = stackExperimentFixture();
    const old = fixture.definitions[0];
    if (old?.mode !== 'legacy-application') throw new Error('Wrong fixture');
    const app = ok(
      adaptLegacyApplication({
        ...old.source,
        rules: [
          ...old.source.rules,
          {
            id: 'failed',
            fromStateId: 'Waiting',
            nextStateId: 'Failed',
            event: { kind: 'connection', state: 'failed' },
            actions: [{ kind: 'finish', outcome: 'failure' }],
          },
        ],
      }),
    );
    const input = changeStackTransport(
      { ...fixture, definitions: [app, ...fixture.definitions.slice(1)] },
      (protocol) => ({
        ...protocol,
        provides: {
          ...(protocol.provides as NonNullable<typeof protocol.provides>),
          lifecycle: { initial: 'ready', notifications: ['failed', 'closed'] },
        },
        rules: protocol.rules.map((rule) =>
          rule.id !== 'accept_write'
            ? rule
            : {
                ...rule,
                actions: [
                  {
                    kind: 'service-indicate',
                    portId: 'upper',
                    operation: 'read',
                    payload: {
                      kind: 'slice',
                      value: { kind: 'service-payload' },
                      offset: { kind: 'literal', value: 0 },
                      length: { kind: 'literal', value: 1 },
                    },
                  },
                  { kind: 'service-indicate', portId: 'upper', operation },
                ],
              },
        ),
      }),
    );
    const view = engine(input).run();
    assert.equal(view.status, 'completed');
    assert.equal(at(view, 'A/app', 'receive').length, 1);
    assert.equal(at(view, 'A/app', 'parsed').length, 0);
    assert.equal(view.instances['A/app']?.outcome, operation === 'closed' ? 'error' : 'failure');
    assert.equal(
      view.diagnostics.some((item) => item.code === 'incomplete-frame'),
      operation === 'closed',
    );
    const range = at(view, 'A/app', 'receive')[0]?.payloads[0];
    assert.ok(range);
    assert.equal(new TextDecoder().decode(ok(readArtifactRange(view.artifacts, range))), '{');
  });

test('datagram byte service keeps packet boundaries and never joins two malformed datagrams into a frame', () => {
  const fixture = splitStackFixture(1);
  const old = fixture.definitions[0];
  if (old?.mode !== 'legacy-application') throw new Error('Wrong fixture');
  const app = ok(
    adaptLegacyApplication({ ...old.source, codec: 'json-datagram', lowerService: 'datagram' }),
  );
  const input = changeStackTransport(
    { ...fixture, definitions: [app, ...fixture.definitions.slice(1)] },
    (protocol) => ({
      ...protocol,
      provides: {
        ...(protocol.provides as NonNullable<typeof protocol.provides>),
        service: { kind: 'datagram', payload: 'bytes' },
        request: 'send',
        indication: 'receive',
      },
      rules: protocol.rules.map((rule) => ({
        ...rule,
        event:
          rule.event.kind === 'service-request' ? { ...rule.event, operation: 'send' } : rule.event,
        actions: rule.actions.map((action) =>
          action.kind === 'service-indicate' && action.operation === 'read'
            ? { ...action, operation: 'receive' }
            : action,
        ),
      })),
    }),
  );
  const view = engine(input).run();
  assert.equal(view.status, 'completed');
  assert.equal(view.instances['B/app']?.outcome, 'error');
  assert.equal(at(view, 'B/app', 'parsed').length, 0);
  assert.ok(view.diagnostics.some((item) => item.code === 'invalid-json'));
});

test('native explicit data-indication hooks share the atomic operation with normal codec parsing', () => {
  const fixture = stackExperimentFixture();
  const app = fixture.definitions[0];
  if (app?.mode !== 'legacy-application') throw new Error('Wrong fixture');
  const { schemaVersion: _schema, lowerService: _lower, ...body } = app.source;
  const native = {
    ...body,
    schemaVersion: 2,
    mode: 'stack-protocol',
    requires: app.requires,
    variables: [...body.variables, { id: 'observed', type: 'integer', initial: 0 }],
    rules: [
      ...body.rules,
      ...['Idle', 'Waiting'].map((state) => ({
        id: `observe_${state}`,
        fromStateId: state,
        nextStateId: state,
        event: { kind: 'service-indication', portId: 'lower', operation: 'read' },
        actions: [
          {
            kind: 'assign',
            variableId: 'observed',
            value: { kind: 'byteLength', value: { kind: 'service-payload' } },
          },
        ],
      })),
    ],
  };
  const view = engine({ ...fixture, definitions: [native, ...fixture.definitions.slice(1)] }).run();
  assert.deepEqual(view.diagnostics, []);
  assert.equal(view.instances['A/app']?.variables.observed, 88);
  assert.equal(view.instances['B/app']?.variables.observed, 88);
  assert.equal(at(view, 'B/app', 'parsed').length, 1);
});

test('seeded network decisions match the shared targeted-drop/4-draw contract across batch boundaries', () => {
  const fixture = stackExperimentFixture();
  const input = {
    ...fixture,
    seed: 71,
    link: {
      ...fixture.link,
      environment: {
        ...fixture.link.environment,
        directions: {
          AtoB: { delayMs: 10, jitterMs: 5, lossRate: 0, duplicateRate: 0 },
          BtoA: { delayMs: 10, jitterMs: 5, lossRate: 0, duplicateRate: 0 },
        },
        targetedDrops: [{ direction: 'BtoA' as const, transmission: 1 }],
      },
    },
  };
  const full = engine(input).run();
  const run = engine(input);
  while (!run.result()) run.runBatch(2);
  assert.deepEqual(run.result(), full);
  const decisions = full.events.filter((event) => event.kind === 'environment').map(data);
  assert.ok(decisions[0] && decisions[1]);
  assert.equal((decisions[0].draws as readonly number[]).length, 4);
  assert.equal((decisions[1].draws as readonly number[]).length, 0);
  assert.equal(decisions[1]?.outcome, 'drop-targeted');
  let calls = 0;
  assert.equal(
    planDatagram(input.link.environment, 'B', 0, 1, () => {
      calls++;
      return 0;
    }).draws.length,
    0,
  );
  assert.equal(calls, 0);
});

test('the default 10000-event trace budget bounds a real zero-time four-instance loop globally', () => {
  const fixture = stackExperimentFixture();
  const app = repeatedAppFixture();
  const loop = ok(
    adaptLegacyApplication({
      ...app,
      rules: app.rules
        .filter((rule) => rule.id !== 'record')
        .map((rule) =>
          rule.id !== 'reply'
            ? rule
            : {
                ...rule,
                actions: [
                  {
                    kind: 'send',
                    messageId: 'ping',
                    values: { sequence: { kind: 'field', fieldId: 'sequence' } },
                  },
                ],
              },
        ),
    }),
  );
  const input = {
    ...fixture,
    definitions: [loop, ...fixture.definitions.slice(1)],
    link: {
      ...fixture.link,
      environment: {
        ...fixture.link.environment,
        directions: {
          AtoB: { delayMs: 0, jitterMs: 0, lossRate: 0, duplicateRate: 0 },
          BtoA: { delayMs: 0, jitterMs: 0, lossRate: 0, duplicateRate: 0 },
        },
      },
    },
  };
  const view = engine(input).run();
  assert.equal(view.status, 'limit-reached');
  assert.ok(view.events.length <= 10000 && view.events.length > 9900);
  assert.ok(view.diagnostics.some((item) => item.code === 'trace-limit'));
  assert.equal(view.timeMs, 0);
  assert.equal(parseStackTrace(view.events, view.artifacts).success, true);
});

test('logical packet services execute through declared schemas without inventing binary encoding or byte conversion', () => {
  const fixture = stackExperimentFixture();
  const messages = [
    {
      id: 'signal',
      label: 'Signal',
      fields: [{ id: 'flag', name: 'flag', required: true, placement: 'payload', type: 'boolean' }],
    },
  ];
  const service = { kind: 'datagram', payload: { id: 'signal_packet', revision: 1, messages } };
  const lower = {
    id: 'lower',
    role: 'requires',
    service,
    request: 'send',
    indication: 'receive',
    lifecycle: { initial: 'ready', notifications: ['failed'] },
  };
  const app = {
    schemaVersion: 2,
    mode: 'stack-protocol',
    id: 'packet_app',
    revision: 1,
    label: 'Packet app',
    layer: 'application',
    codec: 'logical-packet',
    requires: lower,
    messages,
    states: [
      { id: 'Ready', label: 'Ready' },
      { id: 'Done', label: 'Done', terminal: true },
    ],
    initialStateId: 'Ready',
    variables: [],
    timers: [],
    rules: [
      {
        id: 'start',
        fromStateId: 'Ready',
        nextStateId: 'Ready',
        event: { kind: 'input', messageId: 'signal' },
        actions: [
          {
            kind: 'send',
            messageId: 'signal',
            values: { flag: { kind: 'field', fieldId: 'flag' } },
          },
        ],
      },
      {
        id: 'receive',
        fromStateId: 'Ready',
        nextStateId: 'Done',
        event: { kind: 'receive', messageId: 'signal' },
        actions: [
          {
            kind: 'deliver',
            messageId: 'signal',
            values: { flag: { kind: 'field', fieldId: 'flag' } },
          },
          { kind: 'finish', outcome: 'success' },
        ],
      },
    ],
  };
  const provider = {
    ...app,
    id: 'packet_provider',
    label: 'Packet provider',
    layer: 'transport',
    requires: { ...lower, id: 'network' },
    provides: { ...lower, id: 'upper', role: 'provides' },
    rules: [
      {
        id: 'request',
        fromStateId: 'Ready',
        nextStateId: 'Ready',
        event: { kind: 'service-request', portId: 'upper', operation: 'send' },
        actions: [
          { kind: 'send', messageId: 'signal', values: { flag: { kind: 'literal', value: true } } },
        ],
      },
      {
        id: 'receive',
        fromStateId: 'Ready',
        nextStateId: 'Ready',
        event: { kind: 'receive', messageId: 'signal' },
        actions: [
          {
            kind: 'service-indicate',
            portId: 'upper',
            operation: 'receive',
            payload: { kind: 'literal', value: { messageId: 'signal', fields: { flag: true } } },
          },
        ],
      },
    ],
  };
  const instances = [
    { id: 'app', definition: { id: 'packet_app', revision: 1 } },
    { id: 'transport', definition: { id: 'packet_provider', revision: 1 } },
  ];
  const input = {
    ...fixture,
    definitions: [app, provider],
    nodes: { A: { instances }, B: { instances } },
    scenario: {
      ...fixture.scenario,
      inputs: [
        {
          id: 'signal',
          timeMs: 0,
          target: { participant: 'A', instanceId: 'app' },
          message: { messageId: 'signal', values: { flag: true } },
        },
      ],
      expectations: [
        {
          id: 'delivered',
          kind: 'delivery-count',
          target: { participant: 'B', instanceId: 'app' },
          messageId: 'signal',
          count: 1,
        },
      ],
    },
  };
  const view = engine(input).run();
  assert.deepEqual(view.diagnostics, []);
  assert.equal(view.expectations[0]?.status, 'pass');
  assert.equal(view.artifacts.payloads.length, 0);
  assert.equal(view.usage.uniqueBytes, 0);
  const sent = at(view, 'A/transport', 'send')[0];
  assert.ok(sent);
  assert.equal((data(sent).wire as { kind: string }).kind, 'packet');
});

test('editing the source after capture cannot change states, payload bytes, topology or run expectations', () => {
  const input = JSON.parse(JSON.stringify(stackExperimentFixture()));
  const run = engine(input);
  input.definitions[0].source.rules = [];
  input.link.environment.directions.AtoB.lossRate = 1;
  input.nodes.A.instances[0].id = 'changed';
  input.scenario.expectations = [];
  const view = run.run();
  assert.deepEqual(view.diagnostics, []);
  assert.equal(view.instances['A/app']?.stateId, 'Done');
  assert.equal(view.expectations.length, 2);
  assert.ok(view.expectations.every((item) => item.status === 'pass'));
});
