import assert from 'node:assert/strict';
import test from 'node:test';
import { createSimulation } from '../../src/application/create-simulation.ts';
import { editExperiment } from '../../src/application/edit-experiment.ts';
import {
  buildSequenceModel,
  sequenceProtocol,
  traceMessage,
  traceObject,
} from '../../src/application/sequence-diagram.ts';
import type { EngineView, ExperimentDefinition } from '../../src/domain/protocol-model.ts';
import { EXAMPLES, getExampleOriginal } from '../../src/examples/catalog.ts';
import { createStopAndWaitExperiment } from '../../src/examples/stop-and-wait.ts';
import {
  createEventLimitExperiment,
  createMessageLimitExperiment,
} from '../fixtures/large-experiments.ts';

function run(config: ExperimentDefinition): EngineView {
  const created = createSimulation(config);
  assert.ok(created.success);
  return created.value.run();
}
test('all catalog traces retain identities, order, causal edges and the frozen actor definitions', () => {
  for (const example of EXAMPLES) {
    const view = run(getExampleOriginal(example.id));
    const before = JSON.stringify(view);
    const model = buildSequenceModel(view);
    assert.equal(model.rows.length, view.events.length);
    assert.deepEqual(
      model.rows.map((row) => row.event),
      view.events,
    );
    for (const row of model.rows) {
      assert.equal(model.byId.get(row.event.eventId), row);
      for (const id of row.sources) {
        assert.ok(model.byId.has(id));
        assert.ok(model.effects.get(id)?.includes(row.event.eventId));
      }
      assert.equal(row.shape === 'receive', row.event.kind === 'receive');
    }
    assert.ok(sequenceProtocol(view, 'A'));
    assert.equal(JSON.stringify(view), before);
  }
});
test('a scheduled delivery never counts as receipt and history prefixes never reveal future arrival', () => {
  const view = run(createStopAndWaitExperiment());
  const send = view.events.findIndex((event) => event.kind === 'send');
  const receive = view.events.findIndex((event) => event.kind === 'receive');
  assert.ok(send >= 0 && receive > send);
  const prefix = buildSequenceModel(view, receive);
  const row = prefix.byId.get(view.events[send]?.eventId ?? '');
  assert.equal(row?.shape, 'send');
  assert.equal(row?.note, '수신 미관찰');
  assert.equal(
    prefix.rows.some((item) => item.shape === 'receive'),
    false,
  );
  assert.equal(buildSequenceModel(view, 0).rows.length, 0);
  assert.equal(buildSequenceModel(view, -1).rows.length, 0);
  assert.equal(buildSequenceModel(view, Infinity).rows.length, view.events.length);
  assert.match(
    buildSequenceModel(view).byId.get(row?.event.eventId ?? '')?.note ?? '',
    /수신 관찰됨/,
  );
});
test('targeted ACK loss is explicit and only timer-caused identical sends are retransmission candidates', () => {
  const config = editExperiment(createStopAndWaitExperiment(), '/environment/targetedDrops', [
    { direction: 'BtoA', transmission: 1 },
  ]);
  const model = buildSequenceModel(run(config));
  assert.equal(model.rows.filter((row) => row.label === '데이터그램 지정 손실').length, 1);
  const retries = model.rows.filter((row) => row.note.includes('재전송 후보'));
  assert.equal(retries.length, 1);
  assert.equal(
    traceMessage(retries[0]?.event as NonNullable<(typeof retries)[0]>['event'])?.messageId,
    'data',
  );
  assert.equal(
    model.rows.filter((row) => row.event.kind === 'deliver' && row.event.participant === 'B')
      .length,
    1,
  );
  assert.ok(
    model.rows.some((row) => row.note.includes('동일 값 반복 송신') && row.label === '송신 ack'),
  );
});
test('processing timers stay expiry events while observed failure classifies response timeout', () => {
  const view = run(getExampleOriginal('http_delayed'));
  const model = buildSequenceModel(view);
  const expiries = model.rows.filter(
    (row) => row.event.kind === 'timer' && traceObject(row.event.data).operation === 'expire',
  );
  assert.ok(expiries.some((row) => row.label.startsWith('타이머 만료')));
  const failed = expiries.find((row) => row.label.startsWith('타임아웃 실패'));
  assert.ok(failed);
  const prefix = buildSequenceModel(view, view.events.indexOf(failed.event) + 1);
  assert.match(prefix.byId.get(failed.event.eventId)?.label ?? '', /^타이머 만료/);
});
test('duplicate-before-original receipts use observed copy metadata and preserve single upper delivery', () => {
  let config = editExperiment(
    createStopAndWaitExperiment(),
    '/environment/directions/AtoB/jitterMs',
    4,
  );
  config = editExperiment(config, '/environment/directions/AtoB/duplicateRate', 1);
  const model = buildSequenceModel(run(config));
  const received = model.rows.filter(
    (row) => row.shape === 'receive' && row.event.participant === 'B',
  );
  assert.deepEqual(
    received.map((row) => row.note),
    ['중복 복사본 도착', '원본 도착'],
  );
  assert.ok(received[0] && received[1] && received[0].event.timeMs < received[1].event.timeMs);
});
test('split bytes and coalesced reads retain many-to-many source links and separate parsed messages', () => {
  const base = getExampleOriginal('ping_pong');
  const actions = base.definitions[0]?.rules[0]?.actions;
  assert.ok(actions?.[1]);
  const two = editExperiment(base, '/definitions/0/rules/0/actions', [
    ...actions.slice(0, 2),
    actions[1],
    ...actions.slice(2),
  ]);
  for (const size of [1, 65536]) {
    const config = editExperiment(two, '/environment/directions/AtoB/chunkBytes', size);
    const view = run(config);
    const model = buildSequenceModel(view);
    const reads = model.rows.filter(
      (row) => row.shape === 'receive' && row.event.participant === 'B',
    );
    if (size === 1) {
      assert.ok(reads.length > 10);
      assert.equal(
        (model.effects.get(reads[0]?.event.eventId ?? '') ?? []).some(
          (id) => model.byId.get(id)?.event.kind === 'parsed',
        ),
        false,
      );
    } else {
      assert.equal(reads.length, 1);
      assert.equal(reads[0]?.sources.length, 2);
      assert.equal(
        (model.effects.get(reads[0]?.event.eventId ?? '') ?? []).filter(
          (id) => model.byId.get(id)?.event.kind === 'parsed',
        ).length,
        2,
      );
    }
  }
});
test('stream cutoff is distinct from datagram loss and incomplete observation is not labeled as loss', () => {
  const config = editExperiment(getExampleOriginal('ping_pong'), '/environment/connections', [
    { direction: 'AtoB', kind: 'close', timeMs: 1 },
  ]);
  const model = buildSequenceModel(run(config));
  assert.ok(model.rows.some((row) => row.label.includes('스트림 연결 종료로 차단')));
  assert.equal(
    model.rows.some((row) => row.label.includes('데이터그램')),
    false,
  );
  assert.ok(model.rows.some((row) => row.event.kind === 'send' && row.note === '수신 미관찰'));
});
test('changed values and participant identities do not create false retransmission candidates', () => {
  const base = run(createStopAndWaitExperiment());
  const send = base.events.find((event) => event.kind === 'send');
  assert.ok(send);
  const message = traceMessage(send);
  assert.ok(message);
  const events = [
    send,
    { ...send, eventId: 'other', participant: 'B' as const },
    {
      ...send,
      eventId: 'changed',
      data: { message: { ...message, values: { ...message.values, payload: 'different' } } },
    },
  ];
  assert.equal(
    buildSequenceModel({ events }).rows.some((row) => /반복|재전송/.test(row.note)),
    false,
  );
});
test('10k events and 1 MiB messages stay shared, without serializing or copying the wire', () => {
  const large = run(createMessageLimitExperiment());
  const model = buildSequenceModel(large);
  const sent = model.rows.find((row) => row.event.kind === 'send');
  assert.ok(sent);
  assert.equal(
    sent.event,
    large.events.find((event) => event.kind === 'send'),
  );
  assert.equal(
    (traceObject(traceObject(sent.event.data).wire).bytes as readonly number[]).length,
    1_048_576,
  );
  assert.ok(model.rows.every((row) => row.label.length < 200 && row.note.length < 200));
  const limit = run(createEventLimitExperiment());
  assert.equal(buildSequenceModel(limit).rows.length, 10_000);
});
