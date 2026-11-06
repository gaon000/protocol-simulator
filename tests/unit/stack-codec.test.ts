import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpCodec } from '../../src/codecs/http-codec.ts';
import { createJsonLinesCodec } from '../../src/codecs/message-codecs.ts';
import type { ValidationResult } from '../../src/domain/protocol-model.ts';
import { createHttpExperiment, createHttpProtocol } from '../../src/examples/http.ts';
import { protocolFixture } from '../fixtures/protocol-models.ts';

function ok<T>(result: ValidationResult<T>): T {
  assert.equal(result.success, true, JSON.stringify(result));
  if (!result.success) throw new Error('Invalid fixture');
  return result.value;
}
test('JSON Lines parser forks own their partial bytes/EOF and report each actual frame length', () => {
  const codec = ok(createJsonLinesCodec(protocolFixture()));
  const bytes = ok(codec.encode({ messageId: 'ping', values: { sequence: 1 } }));
  const split = 57;
  codec.push(bytes.subarray(0, split));
  assert.equal(codec.bufferedBytes(), split);
  const cancelled = codec.fork();
  const fork = codec.fork();
  cancelled.abort();
  assert.equal(codec.bufferedBytes(), split);
  assert.deepEqual(fork.pushTracked(bytes.subarray(split)).frameBytes, [bytes.length]);
  assert.equal(codec.bufferedBytes(), split);
  const remainder = new Uint8Array(bytes.length - split + bytes.length);
  remainder.set(bytes.subarray(split));
  remainder.set(bytes, bytes.length - split);
  const parsed = codec.pushTracked(remainder);
  assert.equal(parsed.messages.length, 2);
  assert.deepEqual(parsed.frameBytes, [bytes.length, bytes.length]);
  assert.equal(codec.bufferedBytes(), 0);
  assert.equal(fork.bufferedBytes(), 0);
});

test('HTTP parser forks preserve exact header/body framing while failure in a sibling cannot close the original', () => {
  const source = createHttpExperiment('post');
  const message = source.scenario.inputs[0]?.message;
  assert.ok(message);
  for (const split of [4, 25, 90]) {
    const codec = ok(createHttpCodec(createHttpProtocol()));
    const bytes: Uint8Array = ok(codec.encode(message));
    assert.ok(split < bytes.length);
    assert.equal(codec.pushTracked(bytes.subarray(0, split)).messages.length, 0);
    const incomplete = codec.fork();
    assert.ok(incomplete.finish().diagnostics.length > 0);
    const fork = codec.fork();
    const result = fork.pushTracked(bytes.subarray(split));
    assert.equal(result.messages.length, 1);
    assert.deepEqual(result.frameBytes, [bytes.length]);
    assert.equal(fork.bufferedBytes(), 0);
    assert.equal(codec.bufferedBytes(), split);
    assert.deepEqual(codec.pushTracked(bytes.subarray(split)), result);
    assert.deepEqual(codec.finish().diagnostics, []);
  }
});
