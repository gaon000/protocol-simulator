import assert from 'node:assert/strict';
import test from 'node:test';
import { createSeededRandom, EXECUTION_POLICY } from '../../src/domain/execution-contract.ts';
import type { EnvironmentDefinition } from '../../src/domain/protocol-model.ts';
import {
  EnvironmentLimit,
  type EnvironmentAdapter,
  type Transmission,
} from '../../src/engine/environment-port.ts';
import { createEnvironment } from '../../src/environments/simulated-environment.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';
import reference from '../fixtures/datagram-reference.json' with { type: 'json' };

function adapter(
  definition: EnvironmentDefinition,
  random = createSeededRandom(42),
): EnvironmentAdapter {
  const created = createEnvironment(definition, random);
  assert.ok(created.success);
  return created.value;
}
function stream() {
  const environment = createPingPongExperiment().environment;
  assert.equal(environment.kind, 'stream');
  return environment;
}
function datagram() {
  const environment = createPingPongExperiment('json-datagram').environment;
  assert.equal(environment.kind, 'datagram');
  return environment;
}
function tx(
  bytes: number[] = [1, 2, 3],
  transmission = 1,
  timeMs = 0,
  from: 'A' | 'B' = 'A',
): Transmission {
  return {
    from,
    to: from === 'A' ? 'B' : 'A',
    timeMs,
    transmission,
    causeEventId: `send-${from}-${transmission}`,
    payload: { kind: 'bytes', bytes: Uint8Array.from(bytes) },
  };
}
function drain(environment: EnvironmentAdapter, readId: string) {
  assert.ok(environment.readStream);
  return [...environment.readStream(readId)];
}

test('the actual datagram adapter matches the independent P0 seed/draw/delivery reference', () => {
  const base = datagram();
  const environment = adapter({
    ...base,
    directions: {
      ...base.directions,
      AtoB: {
        delayMs: reference.baseDelayMs,
        jitterMs: reference.jitterMs,
        lossRate: reference.lossRate,
        duplicateRate: reference.duplicateRate,
      },
    },
  });
  const events = [...environment.transmit(tx([1], 1, reference.sendTimeMs))];
  const decision = events.find((item) => item.kind === 'notice');
  assert.equal(decision?.kind, 'notice');
  assert.deepEqual(
    decision.detail.draws,
    reference.drawsUint32.map((value) => value / 4_294_967_296),
  );
  assert.deepEqual(
    events
      .filter((item) => item.kind === 'delivery')
      .map(({ copy, timeMs }) => ({ copy, timeMs }))
      .sort((a, b) => a.timeMs - b.timeMs),
    reference.expectedDeliveries,
  );
  for (const delivery of events.filter((item) => item.kind === 'delivery'))
    assert.equal(delivery.causeEventId, 'send-A-1');
});

test('targeted drops consume zero draws; random drops always consume exactly four', () => {
  let draws = 0;
  const base = datagram();
  const environment = adapter(
    {
      ...base,
      targetedDrops: [{ direction: 'AtoB', transmission: 1 }],
      directions: {
        ...base.directions,
        AtoB: { delayMs: 0, jitterMs: 0, lossRate: 1, duplicateRate: 1 },
      },
    },
    () => {
      draws++;
      return 0.25;
    },
  );
  assert.ok([...environment.transmit(tx())].every((item) => item.kind === 'notice'));
  assert.equal(draws, 0);
  assert.ok([...environment.transmit(tx([2], 2))].every((item) => item.kind === 'notice'));
  assert.equal(draws, 4);
  const opposite = [...environment.transmit(tx([3], 1, 0, 'B'))];
  assert.ok(opposite.some((item) => item.kind === 'delivery'));
  assert.equal(draws, 8);
});

test('probability boundaries use strict less-than and duplicates are not recursively duplicated', () => {
  const base = datagram();
  const environment = adapter(
    {
      ...base,
      directions: {
        ...base.directions,
        AtoB: { delayMs: 1, jitterMs: 0, lossRate: 0.5, duplicateRate: 0.5 },
      },
    },
    () => 0.5,
  );
  assert.equal(
    [...environment.transmit(tx())].filter((item) => item.kind === 'delivery').length,
    1,
  );
  const duplicated = adapter(
    {
      ...base,
      directions: {
        ...base.directions,
        AtoB: { delayMs: 1, jitterMs: 0, lossRate: 0, duplicateRate: 1 },
      },
    },
    () => 0,
  );
  assert.equal([...duplicated.transmit(tx())].filter((item) => item.kind === 'delivery').length, 2);
});

test('datagram copies and caller payloads do not share mutable bytes', () => {
  const base = datagram();
  const environment = adapter({
    ...base,
    directions: { ...base.directions, AtoB: { ...base.directions.AtoB, duplicateRate: 1 } },
  });
  const transmission = tx();
  const deliveries = [...environment.transmit(transmission)].filter(
    (item) => item.kind === 'delivery',
  );
  assert.ok(transmission.payload.kind === 'bytes');
  transmission.payload.bytes[0] = 90;
  const [first, second] = deliveries;
  assert.ok(first?.payload.kind === 'bytes' && second?.payload.kind === 'bytes');
  first.payload.bytes[0] = 80;
  assert.equal(second.payload.bytes[0], 1);
});

test('same-time writes coalesce before chunking and carry every contributing send cause', () => {
  const base = stream();
  const environment = adapter({
    ...base,
    directions: { ...base.directions, AtoB: { delayMs: 10, chunkBytes: 4 } },
  });
  const first = tx([1, 2, 3]);
  const marker = [...environment.transmit(first)][0];
  assert.equal(marker?.kind, 'stream-read');
  assert.deepEqual([...environment.transmit(tx([4, 5, 6, 7], 2))], []);
  assert.ok(first.payload.kind === 'bytes');
  first.payload.bytes[0] = 99;
  const chunks = drain(environment, marker.readId);
  assert.deepEqual(
    chunks.map((item) => (item.payload.kind === 'bytes' ? [...item.payload.bytes] : [])),
    [
      [1, 2, 3, 4],
      [5, 6, 7],
    ],
  );
  assert.deepEqual(
    chunks.map((item) => item.sourceEventIds),
    [['send-A-1', 'send-A-2'], ['send-A-2']],
  );
  assert.deepEqual(drain(environment, marker.readId), []);
});

test('different arrivals and directions do not wait for a future coalescing group', () => {
  const environment = adapter(stream());
  const markers = [tx([1], 1, 0), tx([2], 2, 1), tx([3], 1, 0, 'B')].flatMap((item) => [
    ...environment.transmit(item),
  ]);
  assert.equal(markers.length, 3);
  assert.deepEqual(
    markers.map((item) => item.timeMs),
    [10, 11, 10],
  );
  const bytes = markers.flatMap((marker) => {
    assert.equal(marker.kind, 'stream-read');
    return drain(environment, marker.readId);
  });
  assert.deepEqual(
    bytes.map((item) => item.to),
    ['B', 'B', 'A'],
  );
});

test('a flushed time group closes causally and later zero-delay feedback creates a new read', () => {
  const base = stream();
  const environment = adapter({
    ...base,
    directions: { ...base.directions, AtoB: { delayMs: 0, chunkBytes: 8 } },
  });
  const first = [...environment.transmit(tx([1]))][0];
  assert.equal(first?.kind, 'stream-read');
  assert.equal(drain(environment, first.readId).length, 1);
  const second = [...environment.transmit(tx([2], 2))][0];
  assert.equal(second?.kind, 'stream-read');
  assert.notEqual(second.readId, first.readId);
  assert.equal(drain(environment, second.readId).length, 1);
});

for (const kind of ['close', 'fail'] as const)
  test(`stream ${kind} preserves the received prefix and cuts off arrivals at the boundary`, () => {
    const base = stream();
    const environment = adapter({
      ...base,
      connections: [{ timeMs: 10, direction: 'AtoB', kind }],
      directions: { ...base.directions, AtoB: { delayMs: 0, chunkBytes: 8 } },
    });
    const first = [...environment.transmit(tx([1, 2], 1, 5))][0];
    assert.equal(first?.kind, 'stream-read');
    const prefix = drain(environment, first.readId)[0];
    assert.ok(prefix?.payload.kind === 'bytes');
    assert.deepEqual([...prefix.payload.bytes], [1, 2]);
    assert.deepEqual(
      [...environment.initialEvents()],
      [
        {
          kind: 'connection',
          timeMs: 10,
          participant: 'B',
          state: kind === 'close' ? 'closed' : 'failed',
        },
      ],
    );
    const cutoff = [...environment.transmit(tx([3], 2, 10))];
    assert.equal(cutoff.length, 1);
    assert.equal(cutoff[0]?.kind, 'notice');
  });

test('stream pending bytes are bounded by captured run limits and released on disposal', () => {
  const created = createEnvironment(stream(), createSeededRandom(42), {
    maxEvents: 100,
    maxMessageBytes: EXECUTION_POLICY.maxMessageBytes,
    maxBufferBytes: EXECUTION_POLICY.maxBufferBytes,
    maxTraceBytes: 3,
  });
  assert.ok(created.success);
  const environment = created.value;
  const marker = [...environment.transmit(tx([1, 2, 3]))][0];
  assert.equal(marker?.kind, 'stream-read');
  assert.throws(() => [...environment.transmit(tx([4], 2))], EnvironmentLimit);
  environment.dispose?.();
  assert.deepEqual(drain(environment, marker.readId), []);
  assert.deepEqual([...environment.transmit(tx([5], 3))], []);
});

test('disposing a stream stops an already-started chunk iterator', () => {
  const base = stream();
  const environment = adapter({
    ...base,
    directions: { ...base.directions, AtoB: { delayMs: 0, chunkBytes: 1 } },
  });
  const marker = [...environment.transmit(tx())][0];
  assert.equal(marker?.kind, 'stream-read');
  assert.ok(environment.readStream);
  const iterator = environment.readStream(marker.readId)[Symbol.iterator]();
  assert.equal(iterator.next().done, false);
  environment.dispose?.();
  assert.equal(iterator.next().done, true);
});
