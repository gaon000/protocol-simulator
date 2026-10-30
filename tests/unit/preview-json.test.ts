import assert from 'node:assert/strict';
import test from 'node:test';
import { previewJson } from '../../src/application/preview-json.ts';

test('ordinary event detail is unchanged while large strings, arrays and nested values stay bounded', () => {
  const small = { message: { messageId: 'ping', values: { text: '안녕', sequence: 1 } } };
  assert.deepEqual(previewJson(small), { text: JSON.stringify(small, null, 2), truncated: false });
  const large = {
    wire: { bytes: Array.from({ length: 1_048_576 }, () => 97) },
    message: { body: '\u0000'.repeat(1_048_576) },
  };
  const preview = previewJson(large);
  assert.equal(preview.truncated, true);
  assert.ok(preview.text.length <= 16_384);
  assert.equal(large.wire.bytes.length, 1_048_576);
  assert.equal(large.message.body.length, 1_048_576);
  let nested: { nested: unknown } = { nested: null };
  for (let i = 0; i < 64; i++) nested = { nested };
  assert.equal(previewJson(JSON.parse(JSON.stringify(nested))).truncated, true);
});
