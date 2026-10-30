import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createJsonDatagramCodec,
  createJsonLinesCodec,
  createLogicalPacketCodec,
} from '../../src/codecs/message-codecs.ts';
import type { ValidationResult } from '../../src/domain/protocol-model.ts';
import { protocolFixture } from '../fixtures/protocol-models.ts';

function value<Value>(result: ValidationResult<Value>): Value {
  assert.ok(result.success, JSON.stringify(result));
  return result.value;
}
const encoder = new TextEncoder();
const input = (text = '한😀\n글') => ({ messageId: 'ping', values: { sequence: 1, text } });
const expected = (text = '한😀\n글') => ({
  messageId: 'ping',
  values: { sequence: 1, text, mode: 'safe', urgent: false },
});

test('JSON Lines survives every byte split, including UTF-8 characters and escaped newlines', () => {
  const protocol = protocolFixture();
  const bytes = value(value(createJsonLinesCodec(protocol)).encode(input()));
  for (let split = 0; split <= bytes.length; split++) {
    const codec = value(createJsonLinesCodec(protocol));
    const first = codec.push(bytes.subarray(0, split));
    const second = codec.push(bytes.subarray(split));
    assert.deepEqual([...first.messages, ...second.messages], [expected()], `split ${split}`);
    assert.deepEqual([...first.diagnostics, ...second.diagnostics], []);
    assert.deepEqual(codec.finish().diagnostics, []);
  }
});

test('one-byte reads and coalesced multiple frames produce the same messages', () => {
  const codec = value(createJsonLinesCodec(protocolFixture()));
  const encoded = value(codec.encode(input('first')));
  const other = value(codec.encode(input('second')));
  const together = new Uint8Array([...encoded, ...other]);
  const oneByte = value(createJsonLinesCodec(protocolFixture()));
  const messages = [...together].flatMap((byte) => oneByte.push(new Uint8Array([byte])).messages);
  assert.deepEqual(messages, [expected('first'), expected('second')]);
  assert.deepEqual(codec.push(together).messages, messages);
});

test('a large chunk containing many bounded frames does not violate the partial-buffer limit', () => {
  const bytes = value(value(createJsonLinesCodec(protocolFixture())).encode(input()));
  const codec = value(
    createJsonLinesCodec(protocolFixture(), {
      maxMessageBytes: bytes.length,
      maxBufferBytes: bytes.length,
    }),
  );
  const batch = codec.push(new Uint8Array([...bytes, ...bytes, ...bytes]));
  assert.deepEqual(batch.messages, [expected(), expected(), expected()]);
  assert.deepEqual(batch.diagnostics, []);
});

test('buffers copied bytes rather than caller-owned mutable chunks', () => {
  const codec = value(createJsonLinesCodec(protocolFixture()));
  const bytes = value(codec.encode(input()));
  const split = Math.floor(bytes.length / 2);
  const first = bytes.slice(0, split);
  codec.push(first);
  first.fill(0);
  assert.deepEqual(codec.push(bytes.subarray(split)).messages, [expected()]);
});

test('EOF requires LF even when the pending JSON itself is syntactically valid', () => {
  const codec = value(createJsonLinesCodec(protocolFixture()));
  const bytes = value(codec.encode(input()));
  assert.equal(codec.push(bytes.subarray(0, bytes.length - 1)).messages.length, 0);
  assert.equal(codec.finish().diagnostics[0]?.code, 'incomplete-frame');
  assert.equal(codec.push(new Uint8Array([10])).diagnostics[0]?.code, 'codec-closed');
});

test('exact wire byte limit includes LF and counts UTF-8 bytes rather than characters', () => {
  const bytes = value(value(createJsonLinesCodec(protocolFixture())).encode(input()));
  const exact = value(createJsonLinesCodec(protocolFixture(), { maxMessageBytes: bytes.length }));
  assert.ok(exact.encode(input()).success);
  assert.equal(exact.push(bytes).messages.length, 1);
  const short = value(
    createJsonLinesCodec(protocolFixture(), { maxMessageBytes: bytes.length - 1 }),
  );
  const encoded = short.encode(input());
  assert.ok(!encoded.success);
  assert.equal(encoded.diagnostics[0]?.code, 'message-limit');
  assert.equal(short.push(bytes).diagnostics[0]?.code, 'message-limit');
  const buffer = value(createJsonLinesCodec(protocolFixture(), { maxBufferBytes: 8 }));
  assert.equal(buffer.push(encoder.encode('123456789')).diagnostics[0]?.code, 'buffer-limit');
});

test('bad frames preserve earlier completed messages, close the decoder and discard later frames', () => {
  const codec = value(createJsonLinesCodec(protocolFixture()));
  const good = value(codec.encode(input()));
  const batch = codec.push(new Uint8Array([...good, ...encoder.encode('bad\n'), ...good]));
  assert.deepEqual(batch.messages, [expected()]);
  assert.equal(batch.closed, true);
  assert.equal(batch.diagnostics[0]?.path, '/frames/1');
  assert.equal(batch.diagnostics[0]?.code, 'invalid-json');
  assert.equal(codec.push(good).messages.length, 0);
});

test('rejects invalid UTF-8, BOM, blank lines and bad field values', () => {
  const cases = [
    new Uint8Array([0xff, 10]),
    encoder.encode('\n'),
    encoder.encode('\ufeff{}\n'),
    encoder.encode('{"messageId":"ping","fields":{"number":"one"}}\n'),
  ];
  for (const bytes of cases) {
    const batch = value(createJsonLinesCodec(protocolFixture())).push(bytes);
    assert.equal(batch.messages.length, 0);
    assert.ok(batch.diagnostics.length);
    assert.ok(batch.closed);
  }
});

test('empty input and repeated normal EOF do not create phantom messages', () => {
  const codec = value(createJsonLinesCodec(protocolFixture()));
  assert.equal(codec.push(new Uint8Array()).messages.length, 0);
  assert.deepEqual(codec.finish().diagnostics, []);
  assert.deepEqual(codec.finish().diagnostics, []);
});

test('JSON datagrams round trip with wire names and never join partial packets', () => {
  const codec = value(createJsonDatagramCodec(protocolFixture('json-datagram')));
  const bytes = value(codec.encode(input()));
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.includes('"number":1'));
  assert.ok(!text.includes('"sequence":1'));
  assert.deepEqual(value(codec.decode(bytes)), expected());
  const split = Math.floor(bytes.length / 2);
  assert.equal(codec.decode(bytes.subarray(0, split)).success, false);
  assert.equal(codec.decode(bytes.subarray(split)).success, false);
  assert.deepEqual(value(codec.decode(bytes)), expected());
});

test('datagrams reject over-limit data, unknown envelope/fields and malformed UTF-8', () => {
  const codec = value(
    createJsonDatagramCodec(protocolFixture('json-datagram'), { maxMessageBytes: 100 }),
  );
  for (const bytes of [
    new Uint8Array(101),
    new Uint8Array([0xff]),
    encoder.encode('{"messageId":"missing","fields":{}}'),
    encoder.encode('{"messageId":"ping","fields":{"number":1,"extra":1}}'),
    encoder.encode('{"messageId":"ping","fields":{"number":1},"extra":1}'),
  ]) {
    assert.equal(codec.decode(bytes).success, false);
  }
});

test('logical packets are isolated JSON models with the same validation and size rules', () => {
  const codec = value(createLogicalPacketCodec(protocolFixture('logical-packet')));
  const message = input();
  const packet = value(codec.encode(message));
  message.values.sequence = 2;
  assert.equal(packet.fields.number, 1);
  assert.ok(Object.isFrozen(packet.fields));
  assert.deepEqual(value(codec.decode(packet)), expected());
  assert.equal(codec.decode({ messageId: 'ping', fields: { number: 300 } }).success, false);
  assert.equal(codec.decode(new Date()).success, false);
  assert.equal(
    value(
      createLogicalPacketCodec(protocolFixture('logical-packet'), { maxMessageBytes: 5 }),
    ).encode(input()).success,
    false,
  );
});

test('codec schema is captured so draft edits cannot change an active decoder', () => {
  const protocol = protocolFixture();
  const codec = value(createJsonLinesCodec(protocol));
  const bytes = value(codec.encode(input()));
  const field = protocol.messages[0]?.fields[0];
  assert.ok(field);
  Reflect.set(field, 'name', 'changed');
  assert.deepEqual(codec.push(bytes).messages, [expected()]);
});

test('factories reject wrong protocol types, missing definitions and invalid limits', () => {
  assert.equal(createJsonLinesCodec(protocolFixture('json-datagram')).success, false);
  assert.equal(createJsonDatagramCodec({}).success, false);
  for (const limit of [0, -1, 1.5, Number.NaN, 1_048_577])
    assert.equal(
      createJsonLinesCodec(protocolFixture(), { maxMessageBytes: limit }).success,
      false,
    );
});

test('grows the bounded frame buffer across many small reads', () => {
  const protocol = protocolFixture();
  const textField = protocol.messages[0]?.fields.find((field) => field.id === 'text');
  assert.ok(textField);
  Reflect.set(textField, 'maxLength', 1000);
  const codec = value(createJsonLinesCodec(protocol));
  const message = input('가'.repeat(500));
  const encoded = value(codec.encode(message));
  assert.ok(encoded.length > 1024);
  const messages = [];
  for (let offset = 0; offset < encoded.length; offset += 17) {
    const batch = codec.push(encoded.subarray(offset, offset + 17));
    assert.deepEqual(batch.diagnostics, []);
    messages.push(...batch.messages);
  }
  assert.deepEqual(messages, [expected('가'.repeat(500))]);
});

test('wire names that match object prototype properties remain ordinary own fields', () => {
  const protocol = protocolFixture('json-datagram');
  const field = protocol.messages[0]?.fields[0];
  assert.ok(field);
  Reflect.set(field, 'name', '__proto__');
  const codec = value(createJsonDatagramCodec(protocol));
  const encoded = value(codec.encode(input()));
  assert.ok(new TextDecoder().decode(encoded).includes('"__proto__":1'));
  assert.deepEqual(value(codec.decode(encoded)), expected());
});

test('logical packet decoding rejects getters without executing them', () => {
  const codec = value(createLogicalPacketCodec(protocolFixture('logical-packet')));
  let invoked = false;
  const packet = {
    messageId: 'ping',
    get fields() {
      invoked = true;
      return { number: 1 };
    },
  };
  assert.equal(codec.decode(packet).success, false);
  assert.equal(invoked, false);
});

test('the default 1 MiB pending-frame bound is enforced before accepting another byte', () => {
  const codec = value(createJsonLinesCodec(protocolFixture()));
  assert.deepEqual(codec.push(new Uint8Array(1_048_576).fill(32)).diagnostics, []);
  assert.equal(codec.push(new Uint8Array([32])).diagnostics[0]?.code, 'message-limit');
});

test('two JSON messages in one datagram are not treated as a stream', () => {
  const codec = value(createJsonDatagramCodec(protocolFixture('json-datagram')));
  const bytes = value(codec.encode(input()));
  assert.equal(codec.decode(new Uint8Array([...bytes, ...bytes])).success, false);
});
