import assert from 'node:assert/strict';
import test from 'node:test';
import type { ValidationResult } from '../../src/domain/protocol-model.ts';
import { serializeBytes } from '../../src/domain/stack-bytes.ts';
import {
  defaultStackLimits,
  type PayloadRange,
  type RunArtifacts,
  type StackLimits,
} from '../../src/domain/stack-model.ts';
import {
  parseRunArtifacts,
  parseStackTrace,
  readArtifactRange,
  StackPayloadStore,
} from '../../src/domain/stack-payloads.ts';
import { stackTraceFixture } from '../fixtures/stack-models.ts';

function ok<T>(result: ValidationResult<T>): T {
  assert.equal(result.success, true, JSON.stringify(result));
  if (!result.success) throw new Error('Invalid fixture');
  return result.value;
}
const reduced = (limits: Partial<StackLimits>): StackLimits => ({
  ...defaultStackLimits(),
  ...limits,
});

test('payload handles are store-local capabilities; range sharing allocates one immutable block', () => {
  const store = new StackPayloadStore('run');
  const other = new StackPayloadStore('run');
  const input = Uint8Array.of(0, 1, 255, 3);
  const handle = ok(store.add(input));
  input.fill(9);
  const part = ok(store.slice(handle, 1, 2));
  assert.equal(store.usage.uniqueBytes, 4);
  assert.equal(part.payloadId, handle.payloadId);
  assert.deepEqual(ok(store.read(part)), Uint8Array.of(1, 255));
  const copy = ok(store.read(part));
  copy.fill(8);
  assert.deepEqual(ok(store.read(part)), Uint8Array.of(1, 255));
  assert.equal(other.read(handle).success, false);
  assert.equal(store.read({ ...handle }).success, false);
  for (const [offset, length] of [
    [-1, 0],
    [0, 5],
    [0.5, 1],
    [4, 1],
    [Number.MAX_SAFE_INTEGER, 1],
  ])
    assert.equal(store.slice(handle, offset as number, length as number).success, false);
  assert.equal(ok(store.slice(handle, 4, 0)).length, 0);
});

test('global physical and logical budgets remain separate and owner replacements reserve atomically', () => {
  const store = new StackPayloadStore(
    'run',
    reduced({
      maxMessageBytes: 4,
      maxPayloadBytes: 8,
      maxLiveBytes: 6,
      maxPortBytes: 4,
      maxCodecBufferBytes: 3,
    }),
  );
  const handle = ok(store.add(Uint8Array.of(1, 2, 3, 4)));
  const part = ok(store.slice(handle, 0, 2));
  assert.equal(store.add(new Uint8Array(5)).success, false);
  ok(store.setOwner({ id: 'A/transport/pending', kind: 'port' }, [handle]));
  ok(store.setOwner({ id: 'B/app/codec', kind: 'codec' }, [part]));
  assert.equal(store.usage.uniqueBytes, 4);
  assert.equal(store.usage.liveBytes, 6);
  const before = store.usage;
  assert.equal(store.setOwner({ id: 'B/app/codec', kind: 'codec' }, [handle]).success, false);
  assert.equal(store.setOwner({ id: 'C/port', kind: 'port' }, [part]).success, false);
  assert.equal(store.setOwner({ id: 'A/transport/pending', kind: 'codec' }, [part]).success, false);
  assert.deepEqual(store.usage, before);
  store.releaseOwner('A/transport/pending');
  assert.equal(store.usage.liveBytes, 2);
  ok(store.setOwner({ id: 'B/app/codec', kind: 'codec' }, []));
  assert.equal(store.usage.liveBytes, 0);
  ok(store.add(new Uint8Array(4)));
  assert.equal(store.usage.uniqueBytes, 8);
  assert.equal(store.add(Uint8Array.of(1)).success, false);
});

test('cancel/reset cleanup drops temporary blocks but frozen captured trace artifacts survive', () => {
  const store = new StackPayloadStore('run');
  const handle = ok(store.add(Uint8Array.of(7, 8, 9)));
  const part = ok(store.slice(handle, 1, 2));
  const temp = ok(store.add(Uint8Array.of(99)));
  ok(store.setOwner({ id: 'A/transport/pending', kind: 'provider' }, [handle, temp]));
  ok(store.appendTrace([stackTraceFixture([part])]));
  const captured = store.capture();
  assert.ok(Object.isFrozen(captured.artifacts.payloads));
  store.clearLive();
  assert.equal(store.usage.liveBytes, 0);
  assert.equal(store.usage.uniqueBytes, 3);
  assert.equal(store.read(temp).success, false);
  assert.equal(store.read(handle).success, true);
  const newRun = new StackPayloadStore('run');
  const newHandle = ok(newRun.add(Uint8Array.of(42)));
  assert.equal(newHandle.payloadId, handle.payloadId);
  assert.equal(newRun.read(handle).success, false);
  assert.deepEqual(ok(readArtifactRange(captured.artifacts, part)), Uint8Array.of(8, 9));
  assert.deepEqual(
    ok(readArtifactRange(JSON.parse(JSON.stringify(captured.artifacts)), { ...part })),
    Uint8Array.of(8, 9),
  );
  assert.equal(captured.artifacts.payloads.length, 1);
  assert.equal(parseStackTrace(captured.trace, captured.artifacts).success, true);
});

test('record-local readers reject dangling/duplicate IDs and invalid or noncanonical byte ranges', () => {
  const bytes = serializeBytes(Uint8Array.of(1, 2));
  const artifacts: RunArtifacts = {
    schemaVersion: 2,
    mode: 'stack-artifacts',
    payloads: [{ payloadId: 'payload_1', bytes }],
  };
  const range: PayloadRange = { payloadId: 'payload_1', offset: 0, length: 2 };
  assert.equal(parseRunArtifacts(artifacts, [range]).success, true);
  for (const candidate of [
    { ...range, payloadId: 'missing' },
    { ...range, offset: -1 },
    { ...range, length: -1 },
    { ...range, offset: 1 },
    { ...range, offset: 0.5 },
    { ...range, length: Number.MAX_SAFE_INTEGER },
    { ...range, extra: 1 },
  ])
    assert.equal(parseRunArtifacts(artifacts, [candidate]).success, false);
  assert.equal(
    parseRunArtifacts({ ...artifacts, payloads: [...artifacts.payloads, ...artifacts.payloads] })
      .success,
    false,
  );
  assert.equal(
    parseRunArtifacts({
      ...artifacts,
      payloads: [{ payloadId: 'payload_1', bytes: { ...bytes, data: 'AQI' } }],
    }).success,
    false,
  );
  assert.equal(parseRunArtifacts({ ...artifacts, schemaVersion: 1 }).success, false);
  assert.equal(parseRunArtifacts(artifacts, [], reduced({ maxPayloadBytes: 1 })).success, false);
});

test('trace append reserves combined serialized base64/metadata bytes and fails without partial retention', () => {
  const bytes = new Uint8Array(200);
  const probe = new StackPayloadStore('run');
  const handle = ok(probe.add(bytes));
  const event = stackTraceFixture([handle]);
  ok(probe.appendTrace([event]));
  const fullSize = probe.usage.artifactBytes;
  assert.ok(fullSize > bytes.length);
  const store = new StackPayloadStore('run', reduced({ maxArtifactBytes: fullSize - 1 }));
  const owned = ok(store.add(bytes));
  const before = store.usage;
  assert.equal(store.appendTrace([stackTraceFixture([owned])]).success, false);
  assert.deepEqual(store.usage, before);
  store.clearLive();
  assert.equal(store.usage.uniqueBytes, 0);
  const exact = new StackPayloadStore('run', reduced({ maxArtifactBytes: fullSize }));
  ok(exact.appendTrace([stackTraceFixture([ok(exact.add(bytes))])]));
  assert.equal(exact.usage.artifactBytes, fullSize);
  const invalidBatch = [
    { ...stackTraceFixture(), eventId: 'event_2', sequence: 2 },
    { ...stackTraceFixture(), eventId: 'event_2', sequence: 3 },
  ];
  const state = exact.capture();
  assert.equal(exact.appendTrace(invalidBatch).success, false);
  assert.deepEqual(exact.capture(), state);
});

test('v2 trace validation enforces order, actual earlier causes and the same record payload pool', () => {
  const artifacts: RunArtifacts = { schemaVersion: 2, mode: 'stack-artifacts', payloads: [] };
  const first = stackTraceFixture();
  const second = { ...first, eventId: 'event_2', sequence: 2, sourceEventIds: ['event_1'] };
  assert.equal(parseStackTrace([first, second], artifacts).success, true);
  for (const value of [
    [first, { ...second, sequence: 1 }],
    [first, { ...second, timeMs: -1 }],
    [first, { ...second, sourceEventIds: ['future'] }],
    [first, { ...second, sourceEventIds: ['event_1', 'event_1'] }],
    [{ ...first, schemaVersion: 1 }],
    [{ ...first, endpoint: { participant: 'C', instanceId: 'app' } }],
    [{ ...first, kind: 'unknown' }],
    [{ ...first, extra: 'unsupported' }],
    [{ ...first, payloads: [{ payloadId: 'payload_1', offset: 0, length: 1 }] }],
  ])
    assert.equal(parseStackTrace(value, artifacts).success, false);
  assert.equal(
    parseStackTrace([first, second], artifacts, reduced({ maxTraceEvents: 1 })).success,
    false,
  );
});

test('rollback restores owner budgets and revoked temporary capabilities cannot alias reused payload IDs', () => {
  const store = new StackPayloadStore('run');
  const original = ok(store.add(Uint8Array.of(1)));
  ok(store.setOwner({ id: 'A/port', kind: 'port' }, [original], 10));
  const before = store.usage;
  const reservation = store.beginReservation();
  const temp = ok(store.add(Uint8Array.of(2)));
  const sliced = ok(store.slice(original, 0, 1));
  ok(store.setOwner({ id: 'A/port', kind: 'port' }, [temp], 20));
  reservation.rollback();
  assert.deepEqual(store.usage, before);
  assert.equal(store.read(temp).success, false);
  assert.equal(store.read(sliced).success, false);
  const reused = ok(store.add(Uint8Array.of(3)));
  assert.equal(temp.payloadId, reused.payloadId);
  assert.equal(store.read(temp).success, false);
  assert.deepEqual(ok(store.read(reused)), Uint8Array.of(3));
  assert.equal(store.setOwner({ id: 'A/port', kind: 'port' }, [original], 0).success, false);
});

test('incremental trace reservations account exact serialized bytes including shared payloads and commas', () => {
  const store = new StackPayloadStore('run');
  const range = ok(store.add(Uint8Array.of(1, 2, 3)));
  for (let index = 1; index <= 12; index++) {
    ok(
      store.appendTrace([
        {
          ...stackTraceFixture([range]),
          eventId: `event_${index}`,
          sequence: index,
          sourceEventIds: index === 1 ? [] : [`event_${index - 1}`],
        },
      ]),
    );
    const capture = store.capture();
    assert.equal(
      new TextEncoder().encode(JSON.stringify(capture)).length,
      store.usage.artifactBytes,
    );
  }
  assert.equal(store.capture().artifacts.payloads.length, 1);
  const before = store.capture();
  assert.equal(
    store.appendTrace([
      { ...stackTraceFixture([range]), eventId: 'bad', sequence: 13, sourceEventIds: ['missing'] },
    ]).success,
    false,
  );
  assert.deepEqual(store.capture(), before);
});
