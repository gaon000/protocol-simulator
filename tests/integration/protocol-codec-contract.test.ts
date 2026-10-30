import assert from 'node:assert/strict';
import test from 'node:test';
import { createJsonDatagramCodec, createJsonLinesCodec } from '../../src/codecs/message-codecs.ts';
import { parseExperiment, prepareExperimentSnapshot } from '../../src/domain/model-validation.ts';
import { experimentFixture } from '../fixtures/protocol-models.ts';

test('a validated immutable experiment retains its schema across byte-framed encode/decode', () => {
  const input = experimentFixture();
  const prepared = prepareExperimentSnapshot(input);
  assert.ok(prepared.success);
  const restored = parseExperiment(JSON.parse(JSON.stringify(prepared.value.configuration)));
  assert.ok(restored.success);
  const protocol = restored.value.definitions[0];
  const initial = restored.value.scenario.inputs[0];
  assert.ok(protocol && initial);
  const created = createJsonLinesCodec(protocol);
  assert.ok(created.success);
  const encoded = created.value.encode(initial.message);
  assert.ok(encoded.success);
  const messages = [...encoded.value].flatMap(
    (byte) => created.value.push(new Uint8Array([byte])).messages,
  );
  assert.deepEqual(messages, [
    { messageId: 'ping', values: { sequence: 1, text: '안녕', mode: 'safe', urgent: false } },
  ]);
  assert.deepEqual(created.value.finish().diagnostics, []);
});

test('invalid drafts cannot become an executable snapshot, while a valid datagram schema can round trip', () => {
  const input = experimentFixture('json-datagram');
  assert.equal(prepareExperimentSnapshot({ ...input, seed: -1 }).success, false);
  const prepared = prepareExperimentSnapshot(input);
  assert.ok(prepared.success);
  const protocol = prepared.value.configuration.definitions[0];
  const initial = prepared.value.configuration.scenario.inputs[0];
  assert.ok(protocol && initial);
  const created = createJsonDatagramCodec(protocol);
  assert.ok(created.success);
  const encoded = created.value.encode(initial.message);
  assert.ok(encoded.success);
  assert.ok(created.value.decode(encoded.value).success);
});
