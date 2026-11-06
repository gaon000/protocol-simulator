import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createStackSimulation,
  createStackSimulationFromSnapshot,
  type StackSimulationOptions,
} from '../../src/application/create-stack-simulation.ts';
import { planDatagram } from '../../src/domain/datagram-policy.ts';
import type { ExperimentDefinition, ValidationResult } from '../../src/domain/protocol-model.ts';
import { deserializeBytes, serializeBytes } from '../../src/domain/stack-bytes.ts';
import type {
  NativeStackProtocol,
  StackExperiment,
  StackTrace,
} from '../../src/domain/stack-model.ts';
import { parseStackTrace, readArtifactRange } from '../../src/domain/stack-payloads.ts';
import { parseStackProtocol } from '../../src/domain/stack-protocol-validation.ts';
import type { StackView } from '../../src/domain/stack-runtime-model.ts';
import { parseStackExperiment } from '../../src/domain/stack-validation.ts';
import { createHttpExperiment } from '../../src/examples/http.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';
import {
  createReliableStackExample,
  createReliableStackExperiment,
  createStackExampleCopy,
  getStackExampleOriginal,
  STACK_EXAMPLES,
} from '../../src/examples/reliable-stack-examples.ts';
import { createReliableStreamLiteProtocol } from '../../src/examples/reliable-stream-lite.ts';
import { repeatedAppFixture } from '../fixtures/stack-runtime.ts';

function ok<T>(result: ValidationResult<T>): T {
  assert.equal(result.success, true, JSON.stringify(result));
  if (!result.success) throw new Error('Invalid fixture');
  return result.value;
}
function engine(
  input: unknown = createReliableStackExample(),
  options: StackSimulationOptions = {},
) {
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
function message(event: StackTrace): { messageId: string; values: Record<string, unknown> } {
  return data(event).message as { messageId: string; values: Record<string, unknown> };
}
function sent(view: StackView, endpoint: string, id: 'DATA' | 'ACK') {
  return at(view, endpoint, 'send').filter((event) => message(event).messageId === id);
}
function reads(view: StackView, endpoint: string) {
  return at(view, endpoint, 'service-indication').filter(
    (event) => data(event).operation === 'read',
  );
}
function join(view: StackView, events: readonly StackTrace[]): Uint8Array {
  const parts = events.map((event) => {
    const payload = data(event).payload as {
      range: { payloadId: string; offset: number; length: number };
    };
    return ok(readArtifactRange(view.artifacts, payload.range));
  });
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
function transport(
  input: StackExperiment,
  participant: 'A' | 'B',
  change: (protocol: NativeStackProtocol) => NativeStackProtocol,
): StackExperiment {
  return {
    ...input,
    definitions: input.definitions.map((definition) =>
      definition.mode === 'stack-protocol' &&
      definition.id === `reliable_stream_lite_${participant}`
        ? change(definition)
        : definition,
    ),
  };
}
function bulkApplication(inputs: ExperimentDefinition['scenario']['inputs']): ExperimentDefinition {
  const original = createPingPongExperiment();
  const protocol = repeatedAppFixture();
  return {
    ...original,
    definitions: [protocol],
    scenario: {
      ...original.scenario,
      observationMs: 1200,
      inputs,
      expectations: (['A', 'B'] as const).map((participant) => ({
        id: `delivered_${participant}`,
        kind: 'delivery-count',
        participant,
        messageId: 'pong',
        count: inputs.filter((input) => input.participant === participant).length,
      })),
    },
  };
}

for (const entry of STACK_EXAMPLES)
  test(`${entry.id} runs its versioned actual stack and satisfies every expectation`, () => {
    const original = getStackExampleOriginal(entry.id);
    assert.ok(Object.isFrozen(original));
    assert.deepEqual(original.origin, { exampleId: entry.id, version: 1 });
    const view = engine(original).run();
    assert.equal(view.status, 'completed');
    assert.deepEqual(view.diagnostics, []);
    assert.ok(
      view.expectations.every((item) => item.status === 'pass'),
      JSON.stringify(view.expectations),
    );
    assert.equal(view.instances['A/transport']?.outcome, 'active');
    assert.equal(view.instances['B/transport']?.outcome, 'active');
    assert.equal(view.instances['A/transport']?.stateId, 'Ready');
    assert.equal(view.instances['B/transport']?.stateId, 'Ready');
    assert.ok(
      view.events
        .filter((event) => event.kind === 'send' && event.endpoint.instanceId === 'transport')
        .every((event) => event.portId === 'network'),
    );
    assert.equal(parseStackTrace(view.events, view.artifacts).success, true);
  });

test('first ACK loss retransmits identical DATA and reACKs the duplicate without a second app delivery', () => {
  const view = engine(createReliableStackExample('first-ack-loss')).run();
  const first = sent(view, 'A/transport', 'DATA').filter(
    (event) => message(event).values.seq === 0,
  );
  assert.equal(first.length, 2);
  assert.deepEqual(message(first[0] as StackTrace), message(first[1] as StackTrace));
  assert.equal(view.instances['A/transport']?.variables.retransmissions, 1);
  assert.equal(view.instances['B/transport']?.variables.duplicateChunks, 1);
  assert.equal(
    at(view, 'B/app', 'deliver').filter((event) => message(event).messageId === 'ping').length,
    1,
  );
  assert.equal(
    at(view, 'A/app', 'deliver').filter((event) => message(event).messageId === 'pong').length,
    1,
  );
  const drop = view.events.find(
    (event) => event.kind === 'environment' && data(event).outcome === 'drop-targeted',
  );
  assert.ok(drop);
  const accepted = view.events.find((event) => event.eventId === drop.sourceEventIds[0]);
  assert.ok(accepted);
  const requested = view.events.find((event) => event.eventId === accepted.sourceEventIds[0]);
  assert.ok(requested);
  const lostAck = view.events.find((event) => event.eventId === requested.sourceEventIds[0]);
  assert.ok(lostAck);
  assert.equal(message(lostAck).messageId, 'ACK');
  const original = at(view, 'A/app', 'send')[0]?.payloads[0];
  assert.ok(original);
  assert.deepEqual(
    join(view, reads(view, 'B/transport')),
    ok(readArtifactRange(view.artifacts, original)),
  );
});

test('normal and duplicated frames preserve actual UTF-8 byte ranges and ignore late duplicate ACKs', () => {
  const base = createReliableStackExample();
  const input = {
    ...base,
    link: {
      ...base.link,
      environment: {
        ...base.link.environment,
        directions: {
          AtoB: { delayMs: 10, jitterMs: 5, lossRate: 0, duplicateRate: 1 },
          BtoA: { delayMs: 10, jitterMs: 5, lossRate: 0, duplicateRate: 1 },
        },
      },
    },
  };
  const view = engine(input).run();
  assert.deepEqual(view.diagnostics, []);
  assert.ok(view.expectations.every((item) => item.status === 'pass'));
  assert.equal(view.instances['B/transport']?.variables.deliveredChunks, 2);
  assert.ok(Number(view.instances['B/transport']?.variables.duplicateChunks) > 0);
  const outgoing = at(view, 'A/app', 'send')[0]?.payloads[0];
  assert.ok(outgoing);
  assert.deepEqual(
    join(view, reads(view, 'B/transport')),
    ok(readArtifactRange(view.artifacts, outgoing)),
  );
  assert.ok(
    at(view, 'A/transport', 'transition').some(
      (event) =>
        String(data(event).ruleId).startsWith('ignore_') &&
        message(
          view.events.find(
            (candidate) => candidate.eventId === event.sourceEventIds[0],
          ) as StackTrace,
        ).messageId === 'ACK',
    ),
  );
});

test('wrong-direction and mismatched ACKs cannot advance a waiting sender', () => {
  const input = transport(createReliableStackExample(), 'B', (protocol) => ({
    ...protocol,
    rules: protocol.rules.map((rule) =>
      !rule.id.startsWith('accept_DATA')
        ? rule
        : {
            ...rule,
            actions: [
              {
                kind: 'send',
                messageId: 'ACK',
                values: {
                  direction: { kind: 'variable', variableId: 'txDirection' },
                  seq: { kind: 'field', fieldId: 'seq' },
                },
              },
              {
                kind: 'send',
                messageId: 'ACK',
                values: {
                  direction: { kind: 'field', fieldId: 'direction' },
                  seq: { kind: 'literal', value: 99999 },
                },
              },
              ...rule.actions,
            ],
          },
    ),
  }));
  const view = engine(input).run();
  assert.deepEqual(view.diagnostics, []);
  assert.ok(view.expectations.every((item) => item.status === 'pass'));
  const ignored = at(view, 'A/transport', 'transition').filter(
    (event) => data(event).ruleId === 'ignore_other_ACK',
  );
  assert.equal(ignored.length, 4);
  assert.ok(ignored.every((event) => data(event).ignored === true));
  assert.deepEqual(
    sent(view, 'A/transport', 'DATA').map((event) => message(event).values.seq),
    [0, 1],
  );
});

test('future and wrong-direction DATA are explicit ignores with neither ACK nor upward read effects', () => {
  const bytes = serializeBytes(new TextEncoder().encode('never-deliver'));
  const input = transport(createReliableStackExample(), 'B', (protocol) => ({
    ...protocol,
    rules: protocol.rules.map((rule) =>
      !rule.id.startsWith('accept_DATA')
        ? rule
        : {
            ...rule,
            actions: [
              {
                kind: 'send',
                messageId: 'DATA',
                values: {
                  direction: { kind: 'variable', variableId: 'txDirection' },
                  seq: { kind: 'literal', value: 7 },
                  payload: { kind: 'literal', value: bytes },
                },
              },
              {
                kind: 'send',
                messageId: 'DATA',
                values: {
                  direction: { kind: 'variable', variableId: 'rxDirection' },
                  seq: { kind: 'literal', value: 0 },
                  payload: { kind: 'literal', value: bytes },
                },
              },
              ...rule.actions,
            ],
          },
    ),
  }));
  const view = engine(input).run();
  assert.deepEqual(view.diagnostics, []);
  assert.ok(view.expectations.every((item) => item.status === 'pass'));
  const ignored = at(view, 'A/transport', 'transition').filter((event) =>
    /ignore_(future|wrong_direction)_DATA/.test(String(data(event).ruleId)),
  );
  assert.equal(ignored.length, 4);
  for (const transition of ignored)
    assert.equal(
      view.events.filter(
        (event) =>
          ['send', 'service-indication'].includes(event.kind) &&
          event.sourceEventIds.includes(transition.sourceEventIds[0] ?? ''),
      ).length,
      0,
    );
  assert.equal(view.instances['A/transport']?.variables.deliveredChunks, 2);
});

test('queued and later writes retain stream order and monotone sequence identity when old DATA arrives late', () => {
  const application = bulkApplication(
    [0, 5, 250].map((timeMs, index) => ({
      id: `input_${index}`,
      timeMs,
      participant: 'A',
      message: { messageId: 'ping', values: { sequence: index + 1 } },
    })),
  );
  const input = createReliableStackExperiment(application);
  const view = engine(input, {
    datagramPlanner: (...args) => {
      const decision = planDatagram(...args);
      return args[1] === 'A' && args[3] === 1
        ? {
            ...decision,
            outcome: 'duplicate',
            deliveries: [...decision.deliveries, { copy: 'duplicate', timeMs: 550 }],
          }
        : decision;
    },
  }).run();
  assert.deepEqual(view.diagnostics, []);
  assert.ok(view.expectations.every((item) => item.status === 'pass'));
  assert.deepEqual(
    sent(view, 'A/transport', 'DATA').map((event) => message(event).values.seq),
    [0, 1, 2, 3, 4, 5],
  );
  assert.equal(view.instances['B/transport']?.variables.expectedSeq, 6);
  assert.equal(view.instances['B/transport']?.variables.duplicateChunks, 1);
  assert.equal(at(view, 'A/app', 'deliver').length, 3);
  assert.ok(
    at(view, 'A/transport', 'transition').some((event) => data(event).ruleId === 'queue_write'),
  );
  const frames = at(view, 'A/app', 'send').map((event) =>
    ok(
      readArtifactRange(
        view.artifacts,
        event.payloads[0] as NonNullable<(typeof event.payloads)[0]>,
      ),
    ),
  );
  const received = join(view, reads(view, 'B/transport'));
  assert.equal(
    received.length,
    frames.reduce((sum, frame) => sum + frame.length, 0),
  );
  assert.deepEqual(
    [...received],
    frames.flatMap((frame) => [...frame]),
  );
});

test('both directions can wait for ACK, receive peer DATA and queue new application writes concurrently', () => {
  const application = bulkApplication(
    (['A', 'B'] as const).map((participant) => ({
      id: `start_${participant}`,
      timeMs: 0,
      participant,
      message: { messageId: 'ping', values: { sequence: 1 } },
    })),
  );
  const view = engine(createReliableStackExperiment(application)).run();
  assert.deepEqual(view.diagnostics, []);
  assert.ok(view.expectations.every((item) => item.status === 'pass'));
  for (const participant of ['A', 'B']) {
    const endpoint = `${participant}/transport`;
    assert.equal(view.instances[endpoint]?.variables.txSeq, 4);
    assert.equal(view.instances[endpoint]?.variables.expectedSeq, 4);
    assert.equal(view.instances[endpoint]?.stateId, 'Ready');
    assert.ok(
      at(view, endpoint, 'transition').some(
        (event) => data(event).ruleId === 'accept_DATA_Waiting',
      ),
    );
  }
});

test('retry exhaustion reports a modeled failed service and keeps the already delivered byte prefix', () => {
  const base = createReliableStackExample();
  const providers = base.definitions.map((definition) =>
    definition.mode === 'stack-protocol'
      ? createReliableStreamLiteProtocol(definition.id.endsWith('_A') ? 'A' : 'B', {
          chunkBytes: 16,
          timeoutMs: 50,
          maxRetries: 1,
        })
      : definition,
  );
  const input: StackExperiment = {
    ...base,
    definitions: providers,
    link: {
      ...base.link,
      environment: {
        ...base.link.environment,
        targetedDrops: [
          { direction: 'AtoB', transmission: 2 },
          { direction: 'AtoB', transmission: 3 },
        ],
      },
    },
    scenario: {
      ...base.scenario,
      expectations: [
        {
          id: 'failed',
          kind: 'state',
          target: { participant: 'A', instanceId: 'transport' },
          stateId: 'Failed',
        },
        {
          id: 'app_failed',
          kind: 'state',
          target: { participant: 'A', instanceId: 'app' },
          stateId: 'StreamFailed',
        },
      ],
    },
  };
  const view = engine(input).run();
  assert.equal(view.status, 'completed');
  assert.deepEqual(view.diagnostics, []);
  assert.ok(view.expectations.every((item) => item.status === 'pass'));
  assert.equal(view.instances['A/transport']?.variables.failureReason, 'retry-exhausted');
  for (const id of ['pending', 'queued', 'cached'])
    assert.equal(
      (view.instances['A/transport']?.variables[id] as { byteLength: number } | undefined)
        ?.byteLength,
      0,
    );
  assert.equal(view.instances['A/transport']?.variables.retransmissions, 1);
  assert.equal(view.instances['A/app']?.tainted, false);
  assert.equal(reads(view, 'B/transport').length, 1);
  assert.equal(join(view, reads(view, 'B/transport')).length, 16);
  assert.equal(at(view, 'B/app', 'parsed').length, 0);
  assert.equal(sent(view, 'A/transport', 'DATA').length, 3);
  assert.equal(parseStackTrace(view.events, view.artifacts).success, true);
});

test('zero retries emits one original DATA and one failed notification, with no synthesized retransmission', () => {
  const base = createReliableStackExample();
  const input = {
    ...base,
    definitions: base.definitions.map((definition) =>
      definition.mode === 'stack-protocol'
        ? createReliableStreamLiteProtocol(definition.id.endsWith('_A') ? 'A' : 'B', {
            maxRetries: 0,
          })
        : definition,
    ),
    link: {
      ...base.link,
      environment: {
        ...base.link.environment,
        directions: {
          ...base.link.environment.directions,
          AtoB: { delayMs: 10, jitterMs: 0, lossRate: 1, duplicateRate: 0 },
        },
      },
    },
  };
  const view = engine(input).run();
  assert.equal(view.status, 'completed');
  assert.deepEqual(view.diagnostics, []);
  assert.equal(sent(view, 'A/transport', 'DATA').length, 1);
  assert.equal(view.instances['A/transport']?.variables.retransmissions, 0);
  assert.equal(
    at(view, 'A/transport', 'service-indication').filter(
      (event) => data(event).operation === 'failed',
    ).length,
    1,
  );
  assert.equal(reads(view, 'B/transport').length, 0);
});

test('sequence exhaustion fails explicitly without wrapping or reusing a packet sequence', () => {
  const base = createReliableStackExample();
  const input = {
    ...base,
    definitions: base.definitions.map((definition) =>
      definition.mode === 'stack-protocol'
        ? createReliableStreamLiteProtocol(definition.id.endsWith('_A') ? 'A' : 'B', {
            chunkBytes: 16,
            maxSequence: 1,
          })
        : definition,
    ),
  };
  const view = engine(input).run();
  assert.deepEqual(view.diagnostics, []);
  assert.equal(view.instances['A/transport']?.stateId, 'Failed');
  assert.equal(view.instances['A/transport']?.variables.failureReason, 'sequence-exhausted');
  assert.deepEqual(
    sent(view, 'A/transport', 'DATA').map((event) => message(event).values.seq),
    [0, 1],
  );
  assert.equal(join(view, reads(view, 'B/transport')).length, 32);
});

test('app completion leaves providers processing the final ACK and the complete observation horizon', () => {
  const run = engine();
  while (!run.result() && run.view().instances['A/app']?.stateId !== 'Done') run.step();
  const prefix = run.view();
  assert.equal(prefix.instances['A/app']?.stateId, 'Done');
  assert.equal(prefix.instances['B/transport']?.stateId, 'Waiting');
  const view = run.run();
  assert.equal(view.instances['B/transport']?.stateId, 'Ready');
  assert.equal(view.timeMs, view.snapshot.configuration.scenario.observationMs);
  assert.ok(view.events.length > prefix.events.length);
  assert.equal(view.instances['B/transport']?.outcome, 'active');
});

test('run/batch/observer and immutable replay agree for the ACK-loss example', () => {
  const input = createReliableStackExample('first-ack-loss');
  const full = engine(input).run();
  for (const size of [1, 7]) {
    const run = engine(input);
    while (!run.result()) run.runBatch(size, () => true);
    assert.deepEqual(run.result(), full);
  }
  assert.deepEqual(
    ok(
      createStackSimulationFromSnapshot(JSON.parse(JSON.stringify(full.snapshot)), {
        runId: 'run',
      }),
    ).run(),
    full,
  );
});

test('HTTP one-byte chunks cross real header/body and UTF-8 boundaries without changing either delivered message', () => {
  const view = engine(createReliableStackExample('http-split')).run();
  assert.deepEqual(view.diagnostics, []);
  for (const endpoint of ['A/transport', 'B/transport'])
    assert.ok(
      reads(view, endpoint).every(
        (event) =>
          Number((data(event).payload as { range: { length: number } }).range.length) === 1,
      ),
    );
  for (const endpoint of ['A/app', 'B/app']) {
    const delivered = at(view, endpoint, 'deliver');
    assert.equal(delivered.length, 1);
    assert.equal(message(delivered[0] as StackTrace).values.body, '안녕하세요');
    assert.ok(
      at(view, endpoint, 'parsed')[0]?.sourceEventIds.length &&
        Number(at(view, endpoint, 'parsed')[0]?.sourceEventIds.length) > 90,
    );
  }
});

test('example copies preserve version/source boundaries without changing originals or captured snapshots', () => {
  const original = getStackExampleOriginal('stack_first_ack_loss');
  const copy = createStackExampleCopy('stack_first_ack_loss');
  const other = createStackExampleCopy('stack_first_ack_loss');
  assert.notEqual(copy.id, other.id);
  assert.deepEqual(copy.origin, { exampleId: 'stack_first_ack_loss', version: 1 });
  const run = engine(copy);
  const bytes = JSON.stringify(run.snapshot);
  (copy as { label: string }).label = 'edited';
  const provider = copy.definitions.find((definition) => definition.mode === 'stack-protocol');
  assert.ok(provider?.mode === 'stack-protocol');
  (provider as { rules: readonly unknown[] }).rules = [];
  assert.equal(JSON.stringify(run.snapshot), bytes);
  assert.equal(original.label, other.label.replace(/ 사본$/, ''));
  assert.equal(
    run.run().expectations.every((item) => item.status === 'pass'),
    true,
  );
  assert.ok(
    STACK_EXAMPLES.every(
      (entry) => entry.sources.length && entry.omitted.some((text) => text.includes('TCP')),
    ),
  );
  assert.equal(
    parseStackExperiment({ ...other, origin: { exampleId: 'missing', version: 0 } }).success,
    false,
  );
  assert.equal(
    parseStackExperiment({ ...other, origin: { exampleId: 'valid', version: 1, unknown: true } })
      .success,
    false,
  );
});

test('constructors reject incompatible applications, unsupported closures, invalid options and ID collisions', () => {
  for (const participant of ['A', 'B'] as const)
    assert.equal(parseStackProtocol(createReliableStreamLiteProtocol(participant)).success, true);
  for (const options of [
    { chunkBytes: 0 },
    { chunkBytes: 65537 },
    { chunkBytes: 1.1 },
    { timeoutMs: 0 },
    { maxRetries: -1 },
    { maxRetries: Number.POSITIVE_INFINITY },
    { maxSequence: Number.MAX_SAFE_INTEGER },
  ])
    assert.throws(() => createReliableStreamLiteProtocol('A', options), RangeError);
  assert.throws(
    () => createReliableStackExperiment(createPingPongExperiment('json-datagram')),
    TypeError,
  );
  assert.throws(
    () => createReliableStackExperiment(createHttpExperiment('incomplete-body')),
    TypeError,
  );
  assert.throws(
    () => createReliableStackExperiment(createPingPongExperiment(), { observationMs: -1 }),
    TypeError,
  );
  assert.throws(() => createStackExampleCopy('absent'), RangeError);
  const source = createPingPongExperiment();
  const application = source.definitions[0];
  assert.ok(application);
  const collision: ExperimentDefinition = {
    ...source,
    definitions: [{ ...application, id: 'reliable_stream_lite_A' }],
    protocols: {
      A: { id: 'reliable_stream_lite_A', revision: 1 },
      B: { id: 'reliable_stream_lite_A', revision: 1 },
    },
  };
  assert.throws(() => createReliableStackExperiment(collision), /identity collision/);
  assert.equal(ok(deserializeBytes(serializeBytes(Uint8Array.of(0, 255)))).length, 2);
});

test('ACK arrival and the zero-delay local chain win at the exact retransmission deadline', () => {
  const view = engine(
    createReliableStackExperiment(createPingPongExperiment(), { timeoutMs: 20 }),
  ).run();
  assert.deepEqual(view.diagnostics, []);
  assert.ok(view.expectations.every((item) => item.status === 'pass'));
  for (const participant of ['A', 'B']) {
    assert.equal(view.instances[`${participant}/transport`]?.variables.retransmissions, 0);
    assert.equal(
      at(view, `${participant}/transport`, 'timer').filter(
        (event) => data(event).operation === 'expire',
      ).length,
      0,
    );
  }
});

test('empty writes in Ready and Waiting emit no empty DATA and do not consume a sequence', () => {
  const source = createHttpExperiment();
  const definition = source.definitions[0];
  assert.ok(definition);
  const empty: ExperimentDefinition = {
    ...source,
    scenario: {
      ...source.scenario,
      inputs: [
        {
          id: 'empty',
          timeMs: 0,
          participant: 'A',
          message: { messageId: 'raw', values: { wire: '' } },
        },
      ],
      expectations: [{ id: 'timeout', kind: 'state', participant: 'A', stateId: 'TimedOut' }],
    },
  };
  const idle = engine(createReliableStackExperiment(empty)).run();
  assert.deepEqual(idle.diagnostics, []);
  assert.equal(sent(idle, 'A/transport', 'DATA').length, 0);
  assert.equal(idle.instances['A/transport']?.variables.txSeq, 0);
  assert.equal(idle.expectations[0]?.status, 'pass');
  const waiting: ExperimentDefinition = {
    ...source,
    definitions: [
      {
        ...definition,
        rules: definition.rules.map((rule) =>
          rule.id !== 'start_request'
            ? rule
            : {
                ...rule,
                actions: [
                  ...rule.actions,
                  {
                    kind: 'send',
                    messageId: 'raw',
                    values: { wire: { kind: 'literal', value: '' } },
                  },
                ],
              },
        ),
      },
    ],
  };
  const view = engine(createReliableStackExperiment(waiting)).run();
  assert.deepEqual(view.diagnostics, []);
  assert.ok(view.expectations.every((item) => item.status === 'pass'));
  assert.ok(
    at(view, 'A/transport', 'transition').some(
      (event) => data(event).ruleId === 'empty_write_Waiting',
    ),
  );
  assert.ok(
    sent(view, 'A/transport', 'DATA').every(
      (event) => Number((message(event).values.payload as { length: number }).length) > 0,
    ),
  );
});

test('a new write after the final sequence fails without erasing previously delivered application messages', () => {
  const application = bulkApplication(
    [0, 250].map((timeMs, index) => ({
      id: `write_${index}`,
      timeMs,
      participant: 'A',
      message: { messageId: 'ping', values: { sequence: index + 1 } },
    })),
  );
  const protocol = application.definitions[0];
  assert.ok(protocol);
  const failureAware: ExperimentDefinition = {
    ...application,
    definitions: [
      {
        ...protocol,
        rules: [
          ...protocol.rules,
          {
            id: 'failed',
            fromStateId: 'Idle',
            nextStateId: 'Failed',
            event: { kind: 'connection', state: 'failed' },
            actions: [{ kind: 'finish', outcome: 'failure' }],
          },
        ],
      },
    ],
    scenario: {
      ...application.scenario,
      expectations: [
        { id: 'prefix', kind: 'delivery-count', participant: 'A', messageId: 'pong', count: 1 },
      ],
    },
  };
  const view = engine(
    createReliableStackExperiment(failureAware, { chunkBytes: 256, maxSequence: 0 }),
  ).run();
  assert.deepEqual(view.diagnostics, []);
  assert.equal(view.expectations[0]?.status, 'pass');
  assert.equal(view.instances['A/transport']?.stateId, 'Failed');
  assert.equal(view.instances['A/transport']?.variables.failureReason, 'sequence-exhausted');
  assert.equal(view.instances['A/app']?.stateId, 'Failed');
  assert.deepEqual(
    sent(view, 'A/transport', 'DATA').map((event) => message(event).values.seq),
    [0],
  );
});

test('the last supported safe-integer sequence advances only to a non-reused exhaustion sentinel', () => {
  let input = createReliableStackExample();
  input = transport(input, 'A', (protocol) => ({
    ...protocol,
    variables: protocol.variables.map((variable) =>
      variable.id === 'txSeq' ? { ...variable, initial: Number.MAX_SAFE_INTEGER - 2 } : variable,
    ),
  }));
  input = transport(input, 'B', (protocol) => ({
    ...protocol,
    variables: protocol.variables.map((variable) =>
      variable.id === 'expectedSeq'
        ? { ...variable, initial: Number.MAX_SAFE_INTEGER - 2 }
        : variable,
    ),
  }));
  const view = engine(input).run();
  assert.deepEqual(view.diagnostics, []);
  assert.ok(view.expectations.every((item) => item.status === 'pass'));
  assert.deepEqual(
    sent(view, 'A/transport', 'DATA').map((event) => message(event).values.seq),
    [Number.MAX_SAFE_INTEGER - 2, Number.MAX_SAFE_INTEGER - 1],
  );
  assert.equal(view.instances['A/transport']?.variables.txSeq, Number.MAX_SAFE_INTEGER);
  assert.equal(view.instances['B/transport']?.variables.expectedSeq, Number.MAX_SAFE_INTEGER);
});

test('queued write overflow is an explicit resource limit and preserves the last committed FIFO buffer', () => {
  const source = createHttpExperiment();
  const protocol = source.definitions[0];
  assert.ok(protocol);
  const application: ExperimentDefinition = {
    ...source,
    definitions: [
      {
        ...protocol,
        rules: protocol.rules.map((rule) =>
          rule.id !== 'start_raw'
            ? rule
            : {
                ...rule,
                nextStateId: 'Idle',
                actions: [rule.actions[0] as NonNullable<(typeof rule.actions)[0]>],
              },
        ),
      },
    ],
    scenario: {
      ...source.scenario,
      inputs: [0, 10, 20].map((timeMs, index) => ({
        id: `write_${index}`,
        timeMs,
        participant: 'A',
        message: { messageId: 'raw', values: { wire: 'x'.repeat(600) } },
      })),
      expectations: [{ id: 'idle', kind: 'state', participant: 'A', stateId: 'Idle' }],
    },
  };
  const base = createReliableStackExperiment(application);
  const input = {
    ...base,
    limits: { ...base.limits, maxMessageBytes: 1024 },
    link: {
      ...base.link,
      environment: {
        ...base.link.environment,
        directions: {
          ...base.link.environment.directions,
          AtoB: { delayMs: 10, jitterMs: 0, lossRate: 1, duplicateRate: 0 },
        },
      },
    },
  };
  const view = engine(input).run();
  assert.equal(view.status, 'limit-reached');
  assert.ok(view.diagnostics.some((item) => item.code === 'bytes-limit'));
  assert.equal(
    (view.instances['A/transport']?.variables.queued as { byteLength: number } | undefined)
      ?.byteLength,
    600,
  );
  assert.equal(view.instances['A/transport']?.variables.failureReason, '');
  assert.equal(view.instances['A/transport']?.stateId, 'Waiting');
  assert.equal(
    at(view, 'A/transport', 'transition').filter((event) => data(event).ruleId === 'queue_write')
      .length,
    1,
  );
  assert.equal(view.usage.liveBytes, 0);
  assert.equal(parseStackTrace(view.events, view.artifacts).success, true);
});

test('a delayed response cannot undo the app deadline even when already sent DATA arrives after retry exhaustion', () => {
  const view = engine(createReliableStackExample(), {
    datagramPlanner: (...args) => {
      const decision = planDatagram(...args);
      return args[1] === 'B' && args[3] >= 4
        ? {
            ...decision,
            deliveries: decision.deliveries.map((delivery) => ({
              ...delivery,
              timeMs: args[2] + 550,
            })),
          }
        : decision;
    },
  }).run();
  assert.deepEqual(view.diagnostics, []);
  assert.equal(view.instances['A/app']?.stateId, 'Failed');
  assert.equal(view.instances['A/app']?.outcome, 'failure');
  assert.equal(view.instances['A/app']?.finishedAt, 500);
  assert.equal(
    at(view, 'A/app', 'deliver').filter((event) => message(event).messageId === 'pong').length,
    0,
  );
  assert.ok(
    at(view, 'A/app', 'transition').some((event) => data(event).ruleId === 'late_pong_Failed'),
  );
  assert.equal(view.instances['B/transport']?.variables.failureReason, 'retry-exhausted');
  assert.equal(at(view, 'B/app', 'deliver').length, 1);
  assert.equal(join(view, reads(view, 'A/transport')).length, 88);
});

test('seeded loss, duplication and delay preserve a unique ordered byte prefix in either direction', () => {
  for (const seed of [0, 1, 7, 42, 71, 99]) {
    const source = createReliableStackExample();
    const view = engine({
      ...source,
      seed,
      link: {
        ...source.link,
        environment: {
          ...source.link.environment,
          directions: {
            AtoB: { delayMs: 10, jitterMs: 25, lossRate: 0.15, duplicateRate: 0.25 },
            BtoA: { delayMs: 10, jitterMs: 25, lossRate: 0.15, duplicateRate: 0.25 },
          },
        },
      },
    }).run();
    assert.equal(view.status, 'completed');
    assert.deepEqual(view.diagnostics, [], `seed ${seed}`);
    for (const [sender, receiver] of [
      ['A', 'B'],
      ['B', 'A'],
    ]) {
      const received = join(view, reads(view, `${receiver}/transport`));
      const frame = at(view, `${sender}/app`, 'send')[0]?.payloads[0];
      const sent = frame ? ok(readArtifactRange(view.artifacts, frame)) : new Uint8Array();
      assert.ok(received.length <= sent.length);
      assert.deepEqual(received, sent.subarray(0, received.length));
      assert.equal(
        view.instances[`${receiver}/transport`]?.variables.expectedSeq,
        reads(view, `${receiver}/transport`).length,
      );
    }
  }
});

test('several queued writes may share one DATA/read while the app codec restores each frame exactly once', () => {
  const application = bulkApplication(
    [0, 5, 10].map((timeMs, index) => ({
      id: `input_${index}`,
      timeMs,
      participant: 'A',
      message: { messageId: 'ping', values: { sequence: index + 1 } },
    })),
  );
  const view = engine(createReliableStackExperiment(application, { chunkBytes: 256 })).run();
  assert.deepEqual(view.diagnostics, []);
  assert.ok(view.expectations.every((item) => item.status === 'pass'));
  assert.equal(sent(view, 'A/transport', 'DATA').length, 2);
  assert.equal(reads(view, 'B/transport').length, 2);
  const parsed = at(view, 'B/app', 'parsed');
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[1]?.sourceEventIds, parsed[2]?.sourceEventIds);
  assert.equal(at(view, 'A/app', 'deliver').length, 3);
  assert.equal(view.instances['A/transport']?.variables.txSeq, 2);
});
