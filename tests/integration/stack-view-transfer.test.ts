import assert from 'node:assert/strict';
import test from 'node:test';
import { createStackSimulation } from '../../src/application/create-stack-simulation.ts';
import {
  StackViewPublisher,
  StackViewReceiver,
} from '../../src/application/stack-view-transfer.ts';
import { StackWorkerClient } from '../../src/application/stack-worker-client.ts';
import { freezeOwned, isOwnedImmutable } from '../../src/domain/immutable-data.ts';
import { parseStackView } from '../../src/domain/stack-record.ts';
import { createStackExampleCopy } from '../../src/examples/reliable-stack-examples.ts';
import { largeStackEvents } from '../fixtures/large-stacks.ts';

function engine(large = false) {
  const created = createStackSimulation(
    large ? largeStackEvents() : createStackExampleCopy('stack_first_ack_loss'),
    { runId: large ? 'large' : 'transfer' },
  );
  if (!created.success) assert.fail(JSON.stringify(created.diagnostics));
  return created.value;
}

test('ordered incremental observations preserve exact checkpoints, native payloads and readonly earlier snapshots', () => {
  const runtime = engine();
  const publisher = new StackViewPublisher();
  const receiver = new StackViewReceiver();
  const first = receiver.receive(structuredClone(publisher.capture(runtime.view())));
  const original = JSON.stringify(first);
  let previous = first;
  let appended = 0;
  while (!runtime.terminal) {
    const view = runtime.step();
    const packet = publisher.capture(view);
    assert.equal(packet.kind, 'append');
    if (packet.kind === 'append') appended += packet.events.length;
    const decoded = receiver.receive(structuredClone(packet));
    assert.deepEqual(decoded, view);
    assert.equal(decoded.snapshot, first.snapshot);
    assert.equal(isOwnedImmutable(decoded), true);
    if (previous.events.length) assert.equal(decoded.events[0], previous.events[0]);
    if (previous.artifacts.payloads.length)
      assert.equal(decoded.artifacts.payloads[0], previous.artifacts.payloads[0]);
    previous = decoded;
  }
  assert.ok(previous.artifacts.payloads.length > 0);
  assert.ok(appended > 0);
  assert.equal(appended, previous.events.length - first.events.length);
  assert.equal(JSON.stringify(first), original);
  assert.equal(parseStackView(previous).success, true);
});

test('changed prefixes, mutable data and different exact snapshots transfer in full even with matching IDs and counts', () => {
  const publisher = new StackViewPublisher();
  const view = engine().run();
  assert.equal(publisher.capture(view).kind, 'full');
  const originalEvent = view.events[0];
  assert.ok(originalEvent);
  const replacedEvent = freezeOwned({ ...originalEvent, data: { changed: true } });
  const rewritten = freezeOwned({ ...view, events: [replacedEvent, ...view.events.slice(1)] });
  assert.equal(publisher.capture(rewritten).kind, 'full');
  const payloads = [...rewritten.artifacts.payloads];
  const first = payloads[0];
  assert.ok(first);
  payloads[0] = {
    ...first,
    bytes: { kind: 'bytes', encoding: 'base64', byteLength: 1, data: 'Kg==' },
  };
  const otherPayload = freezeOwned({ ...rewritten, artifacts: { ...view.artifacts, payloads } });
  assert.equal(publisher.capture(otherPayload).kind, 'full');
  const otherSnapshot = freezeOwned({ ...otherPayload, snapshot: structuredClone(view.snapshot) });
  assert.equal(publisher.capture(otherSnapshot).kind, 'full');
  assert.equal(publisher.capture(structuredClone(otherSnapshot)).kind, 'full');
  assert.equal(publisher.capture(view).kind, 'full');
  assert.equal(publisher.capture(freezeOwned({ ...view, events: [] })).kind, 'full');
  assert.equal(publisher.capture(freezeOwned({ ...view, runId: 'new-run' })).kind, 'full');
});

test('missing, stale and foreign incremental bases cannot replace the last complete observation', () => {
  const publisher = new StackViewPublisher();
  const runtime = engine();
  const first = publisher.capture(runtime.view());
  const next = publisher.capture(runtime.step());
  assert.equal(next.kind, 'append');
  assert.throws(() => new StackViewReceiver().receive(next), /기준본/);
  const receiver = new StackViewReceiver();
  receiver.receive(structuredClone(first));
  if (next.kind !== 'append') assert.fail();
  assert.throws(() => receiver.receive({ ...next, baseSerial: 0 }), /기준본/);
  assert.throws(
    () => receiver.receive({ ...next, view: { ...next.view, runId: 'foreign' } }),
    /기준본/,
  );
  assert.deepEqual(receiver.receive(structuredClone(next)), runtime.view());
  assert.throws(() => receiver.receive(next), /오래된/);
  assert.throws(() => receiver.receive(first), /오래된/);
  assert.throws(() => receiver.receive({ ...next, serial: NaN }), /오래된/);
  // A subsequent full view is self-contained even when an earlier packet was not retained.
  const full = publisher.capture(freezeOwned({ ...runtime.view(), runId: 'another-run' }));
  assert.equal(receiver.receive(structuredClone(full)).runId, 'another-run');
});

test('the actual 10k run transfers each committed event and payload once without changing the final view', () => {
  const runtime = engine(true);
  const publisher = new StackViewPublisher();
  const receiver = new StackViewReceiver();
  let eventRows = 0;
  let payloadRows = 0;
  let packetBytes = 0;
  let decoded = runtime.view();
  do {
    const view = runtime.runBatch(64);
    const packet = publisher.capture(view);
    packetBytes += JSON.stringify(packet).length;
    eventRows += packet.kind === 'full' ? packet.view.events.length : packet.events.length;
    payloadRows +=
      packet.kind === 'full' ? packet.view.artifacts.payloads.length : packet.payloads.length;
    decoded = receiver.receive(structuredClone(packet));
  } while (!runtime.terminal);
  assert.equal(decoded.events.length, 10000);
  assert.equal(eventRows, decoded.events.length);
  assert.equal(payloadRows, decoded.artifacts.payloads.length);
  assert.deepEqual(decoded, runtime.view());
  assert.ok(packetBytes < JSON.stringify(decoded).length * 2);
});

test('client restores published views for observation lookup and fences invalid transfers after closing', async () => {
  const fake = {
    onmessage: null,
    onerror: null,
    terminate: () => {},
    postMessage: () => assert.fail('Published observations must not be retransferred'),
  } as unknown as Worker;
  const client = new StackWorkerClient(fake);
  const publisher = new StackViewPublisher();
  const runtime = engine();
  const received: import('../../src/domain/stack-runtime-model.ts').StackView[] = [];
  client.onEvent = (event) => {
    if (event.type === 'view') received.push(event.view);
  };
  const errors: string[] = [];
  client.onError = (message) => errors.push(message);
  const send = (transfer: ReturnType<StackViewPublisher['capture']>) =>
    fake.onmessage?.({
      data: {
        type: 'view-transfer',
        transfer: structuredClone(transfer),
        meta: { id: 'saved', runId: 'transfer', createdAt: 0, draftVersion: 1, experimentId: 'e' },
        running: true,
        checkpoint: false,
      },
    } as MessageEvent);
  send(publisher.capture(runtime.view()));
  const next = publisher.capture(runtime.step());
  send(next);
  assert.equal(received.length, 2);
  const view = received[1];
  assert.ok(view);
  await client.register({
    mode: 'stack',
    id: 'saved',
    createdAt: 0,
    draftVersion: 1,
    experimentId: 'e',
    view,
  });
  send(next);
  assert.equal(errors.length, 1);
  send(publisher.capture(runtime.step()));
  assert.equal(received.length, 2);
  assert.equal(errors.length, 1);
  await assert.rejects(client.request({ type: 'forget', id: 'saved' }), /닫혔/);
});
