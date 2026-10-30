import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpCodec } from '../../src/codecs/http-codec.ts';
import type { CodecLimits } from '../../src/codecs/message-codecs.ts';
import { EXECUTION_POLICY } from '../../src/domain/execution-contract.ts';
import { validateProtocolMessage } from '../../src/domain/model-validation.ts';
import type { ProtocolDefinition, ProtocolMessage } from '../../src/domain/protocol-model.ts';
import { createHttpProtocol } from '../../src/examples/http.ts';

const encoder = new TextEncoder();
const request = (body = '', method = 'POST'): ProtocolMessage => ({
  messageId: 'request',
  values: { method, target: '/echo?q=1', host: 'example.test', body },
});
function codec(protocol = createHttpProtocol(), limits: CodecLimits = {}) {
  const result = createHttpCodec(protocol, limits);
  assert.ok(result.success, JSON.stringify(result));
  return result.value;
}
function bytes(message = request('안녕하세요'), protocol = createHttpProtocol()) {
  const result = codec(protocol).encode(message);
  assert.ok(result.success, JSON.stringify(result));
  return result.value;
}
function normalized(message: ProtocolMessage, protocol = createHttpProtocol()) {
  const result = validateProtocolMessage(protocol, message);
  assert.ok(result.success);
  return result.value;
}
function raw(
  headers = 'Host: example.test\r\nContent-Length: 0',
  start = 'GET / HTTP/1.1',
  body = '',
) {
  return encoder.encode(`${start}\r\n${headers}\r\n\r\n${body}`);
}

test('HTTP encode derives Content-Length from UTF-8 bytes and preserves structured GET/POST values', () => {
  for (const message of [request('', 'GET'), request('안녕하세요'), request('🙂\r\n\r\nbody')]) {
    const encoded = bytes(message);
    const text = new TextDecoder().decode(encoded);
    assert.ok(
      text.includes(`Content-Length: ${encoder.encode(String(message.values.body)).length}\r\n`),
    );
    const decoder = codec();
    const result = decoder.push(encoded);
    assert.deepEqual(result.messages, [normalized(message)]);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(decoder.finish().diagnostics, []);
  }
});

test('every byte split and one-byte reads preserve Unicode HTTP start lines, headers and bodies', () => {
  const message = request('한글🙂');
  const encoded = bytes(message);
  for (let split = 0; split <= encoded.length; split++) {
    const decoder = codec();
    const first = decoder.push(encoded.subarray(0, split));
    const second = decoder.push(encoded.subarray(split));
    assert.deepEqual([...first.messages, ...second.messages], [normalized(message)]);
    assert.deepEqual(
      [...first.diagnostics, ...second.diagnostics, ...decoder.finish().diagnostics],
      [],
    );
  }
  const decoder = codec();
  const messages = [];
  for (const byte of encoded) messages.push(...decoder.push(Uint8Array.of(byte)).messages);
  assert.deepEqual(messages, [normalized(message)]);
});

test('complete frame parsing does not confuse body CRLF with headers and can frame concatenated messages', () => {
  const first = bytes(request('one\r\n\r\ntwo'));
  const second = bytes(request('다음'));
  const combined = new Uint8Array(first.length + second.length);
  combined.set(first);
  combined.set(second, first.length);
  const decoder = codec();
  assert.deepEqual(decoder.push(combined).messages, [
    normalized(request('one\r\n\r\ntwo')),
    normalized(request('다음')),
  ]);
  assert.deepEqual(decoder.finish().diagnostics, []);
});

const invalid: readonly [string, Uint8Array, string][] = [
  ['missing Host', raw('Content-Length: 0'), 'http-host'],
  [
    'duplicate Host',
    raw('Host: a.test\r\nhost: b.test\r\nContent-Length: 0'),
    'http-duplicate-header',
  ],
  ['userinfo Host', raw('Host: user@example.test\r\nContent-Length: 0'), 'http-host'],
  ['whitespace before colon', raw('Host : example.test\r\nContent-Length: 0'), 'http-header'],
  ['folded header', raw('Host: example.test\r\n folded\r\nContent-Length: 0'), 'http-header'],
  [
    'header control',
    raw('Host: example.test\r\nX: \u0001\r\nContent-Length: 0'),
    'http-header-ascii',
  ],
  [
    'non-ASCII header',
    raw('Host: example.test\r\nContent-Type: 한글\r\nContent-Length: 0'),
    'http-header-ascii',
  ],
  ['missing length', raw('Host: example.test'), 'http-content-length'],
  ['negative length', raw('Host: example.test\r\nContent-Length: -1'), 'http-content-length'],
  ['signed length', raw('Host: example.test\r\nContent-Length: +1'), 'http-content-length'],
  ['comma lengths', raw('Host: example.test\r\nContent-Length: 0, 0'), 'http-content-length'],
  ['fractional length', raw('Host: example.test\r\nContent-Length: 1.5'), 'http-content-length'],
  [
    'unsafe length',
    raw('Host: example.test\r\nContent-Length: 9007199254740992'),
    'http-content-length',
  ],
  [
    'identical duplicate lengths',
    raw('Host: example.test\r\nContent-Length: 0\r\ncontent-length: 0'),
    'http-duplicate-header',
  ],
  [
    'conflicting lengths',
    raw('Host: example.test\r\nContent-Length: 0\r\nContent-Length: 1'),
    'http-duplicate-header',
  ],
  ['chunked', raw('Host: example.test\r\nTransfer-Encoding: chunked'), 'http-transfer-encoding'],
  [
    'TE plus length',
    raw('Host: example.test\r\nTransfer-Encoding: chunked\r\nContent-Length: 0'),
    'http-length-conflict',
  ],
  [
    'compression',
    raw('Host: example.test\r\nContent-Encoding: gzip\r\nContent-Length: 0'),
    'http-unsupported-header',
  ],
  [
    'unknown header',
    raw('Host: example.test\r\nX-Unmapped: value\r\nContent-Length: 0'),
    'http-unsupported-header',
  ],
  ['old HTTP version', raw(undefined, 'GET / HTTP/1.0'), 'http-version'],
  ['unsupported method', raw(undefined, 'DELETE / HTTP/1.1'), 'http-method'],
  ['absolute form', raw(undefined, 'GET http://example.test/ HTTP/1.1'), 'http-target'],
  ['fragment', raw(undefined, 'GET /path#fragment HTTP/1.1'), 'http-target'],
  ['invalid percent escape', raw(undefined, 'GET /%GG HTTP/1.1'), 'http-target'],
  ['informational response', raw('Content-Length: 0', 'HTTP/1.1 100 Continue'), 'http-status'],
  ['204 response', raw('Content-Length: 0', 'HTTP/1.1 204 No Content'), 'http-status'],
  ['304 response', raw('Content-Length: 0', 'HTTP/1.1 304 Not Modified'), 'http-status'],
  ['205 with body', raw('Content-Length: 1', 'HTTP/1.1 205 Reset Content', 'x'), 'http-status'],
];
for (const [name, wire, code] of invalid)
  test(`limited HTTP rejects ${name} explicitly`, () => {
    const decoder = codec();
    const result = decoder.push(wire);
    assert.equal(result.closed, true);
    assert.equal(result.messages.length, 0);
    assert.equal(result.diagnostics[0]?.code, code);
  });

test('supported case-insensitive headers, OWS and IPv6 Host are decoded by declared stable field IDs', () => {
  const result = codec().push(raw('hOsT:\t[::1]:8080 \t\r\ncontent-length: 0'));
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.messages[0]?.values.host, '[::1]:8080');
});

test('normal response encoding rejects line injection and unsupported status/body combinations', () => {
  for (const values of [
    { status: 204, reason: 'No Content' },
    { status: 200, reason: 'OK\r\nInjected: x' },
    { status: 205, reason: 'Reset Content', body: 'x' },
  ]) {
    const result = codec().encode({ messageId: 'response', values });
    assert.ok(!result.success);
    assert.equal(result.diagnostics[0]?.code, 'http-status');
  }
  const accepted = codec().encode({
    messageId: 'response',
    values: { status: 205, reason: 'Reset Content' },
  });
  assert.ok(accepted.success);
  assert.deepEqual(codec().push(accepted.value).diagnostics, []);
  const injection = codec().encode({
    messageId: 'request',
    values: { ...request().values, contentType: 'text/plain\r\nX: y' },
  });
  assert.ok(!injection.success);
  assert.equal(injection.diagnostics[0]?.code, 'http-header');
});

test('EOF distinguishes incomplete headers/body while complete prior messages survive a later error', () => {
  const incomplete = codec();
  assert.deepEqual(
    incomplete.push(raw('Host: example.test\r\nContent-Length: 9', 'POST / HTTP/1.1', '안녕'))
      .messages,
    [],
  );
  assert.equal(incomplete.finish().diagnostics[0]?.code, 'http-incomplete-body');
  const headers = codec();
  headers.push(encoder.encode('GET / HTTP/1.1\nHost: example.test\n\n'));
  assert.equal(headers.finish().diagnostics[0]?.code, 'http-incomplete-headers');
  const first = bytes(request('ok'));
  const bad = raw('Host : example.test\r\nContent-Length: 0');
  const combined = new Uint8Array(first.length + bad.length);
  combined.set(first);
  combined.set(bad, first.length);
  const result = codec().push(combined);
  assert.equal(result.messages.length, 1);
  assert.equal(result.diagnostics[0]?.code, 'http-header');
});

test('too-small Content-Length frames the declared prefix and remaining bytes require another valid frame', () => {
  const decoder = codec();
  const result = decoder.push(
    raw('Host: example.test\r\nContent-Length: 6', 'POST / HTTP/1.1', '안녕하세요'),
  );
  assert.equal(result.messages[0]?.values.body, '안녕');
  assert.equal(decoder.finish().diagnostics[0]?.code, 'http-incomplete-headers');
  const brokenUtf8 = codec().push(
    raw('Host: example.test\r\nContent-Length: 2', 'POST / HTTP/1.1', '한'),
  );
  assert.equal(brokenUtf8.diagnostics[0]?.code, 'http-body-utf8');
});

test('raw UTF-8 sends deliberately malformed wire data through the normal receiver', () => {
  const wire = 'GET / HTTP/1.1\r\nHost : example.test\r\nContent-Length: 0\r\n\r\n';
  const encoded = codec().encode({ messageId: 'raw', values: { wire } });
  assert.ok(encoded.success);
  assert.equal(new TextDecoder().decode(encoded.value), wire);
  assert.equal(codec().push(encoded.value).diagnostics[0]?.code, 'http-header');
});

test('message and receive-buffer limits apply per HTTP frame, including declared length before allocation', () => {
  const encoded = bytes();
  const exact = codec(createHttpProtocol(), {
    maxMessageBytes: encoded.length,
    maxBufferBytes: encoded.length,
  });
  assert.deepEqual(exact.push(encoded).diagnostics, []);
  assert.equal(
    codec(createHttpProtocol(), { maxMessageBytes: encoded.length - 1 }).push(encoded)
      .diagnostics[0]?.code,
    'message-limit',
  );
  assert.equal(
    codec(createHttpProtocol(), { maxBufferBytes: encoded.length - 1 }).push(encoded).diagnostics[0]
      ?.code,
    'buffer-limit',
  );
  assert.equal(
    codec().push(raw('Host: example.test\r\nContent-Length: 1048577')).diagnostics[0]?.code,
    'message-limit',
  );
  const many = new Uint8Array(encoded.length * 30);
  for (let i = 0; i < 30; i++) many.set(encoded, i * encoded.length);
  assert.equal(
    codec(createHttpProtocol(), {
      maxMessageBytes: encoded.length,
      maxBufferBytes: encoded.length,
    }).push(many).messages.length,
    30,
  );
});

test('the 1 MiB default HTTP frame boundary is exact and an extra byte is rejected', () => {
  const original = createHttpProtocol();
  const protocol: ProtocolDefinition = {
    ...original,
    messages: original.messages.map((message) => ({
      ...message,
      fields: message.fields.map((field) =>
        field.id === 'body' && field.type === 'string'
          ? { ...field, maxLength: EXECUTION_POLICY.maxMessageBytes }
          : field,
      ),
    })),
  };
  const empty = bytes(request(), protocol);
  const bodySize = EXECUTION_POLICY.maxMessageBytes - empty.length - 6;
  const accepted = codec(protocol).encode(request('x'.repeat(bodySize)));
  assert.ok(accepted.success);
  assert.equal(accepted.value.length, EXECUTION_POLICY.maxMessageBytes);
  assert.equal(
    codec(protocol).push(accepted.value).messages[0]?.values.body?.toString().length,
    bodySize,
  );
  const rejected = codec(protocol).encode(request('x'.repeat(bodySize + 1)));
  assert.ok(!rejected.success);
  assert.equal(rejected.diagnostics[0]?.code, 'message-limit');
});

test('header length is bounded and abort releases an unfinished decoder without inventing an EOF error', () => {
  const huge = encoder.encode(
    `GET / HTTP/1.1\r\nHost: example.test\r\nX: ${'a'.repeat(65_536)}\r\n\r\n`,
  );
  assert.equal(codec().push(huge).diagnostics[0]?.code, 'http-header-limit');
  const decoder = codec();
  decoder.push(bytes().subarray(0, 10));
  decoder.abort();
  assert.deepEqual(decoder.finish().diagnostics, []);
  assert.equal(decoder.push(bytes()).diagnostics[0]?.code, 'codec-closed');
});

test('HTTP factories reject wrong codecs and invalid limits without changing their captured schema', () => {
  assert.equal(createHttpCodec({ ...createHttpProtocol(), codec: 'json-lines' }).success, false);
  for (const value of [0, -1, 1.5, Number.NaN, EXECUTION_POLICY.maxMessageBytes + 1])
    assert.equal(createHttpCodec(createHttpProtocol(), { maxMessageBytes: value }).success, false);
  const protocol = createHttpProtocol();
  const decoder = codec(protocol);
  const body = protocol.messages[0]?.fields.find((field) => field.id === 'body');
  assert.ok(body);
  Reflect.set(body, 'maxLength', 0);
  assert.equal(decoder.push(bytes(request('captured'))).messages[0]?.values.body, 'captured');
});

test('unpaired UTF-16 input is rejected rather than silently changing the transmitted body', () => {
  for (const message of [request('\ud800'), { messageId: 'raw', values: { wire: '\udc00' } }]) {
    const encoded = codec().encode(message);
    assert.ok(!encoded.success);
    assert.equal(encoded.diagnostics[0]?.code, 'http-body-utf8');
  }
});

test('HTTP mappings use authored stable IDs rather than special hard-coded field names', () => {
  const original = createHttpProtocol();
  const protocol: ProtocolDefinition = {
    ...original,
    rules: [],
    messages: original.messages.map((message) => ({
      ...message,
      fields: message.fields.map((field) => ({ ...field, id: `custom_${field.id}` })),
      http: Object.fromEntries(
        Object.entries(message.http ?? {}).map(([key, value]) => [
          key,
          key === 'kind' ? value : `custom_${value}`,
        ]),
      ) as NonNullable<typeof message.http>,
    })),
  };
  const value = {
    messageId: 'request',
    values: {
      custom_method: 'POST',
      custom_target: '/custom',
      custom_host: 'example.test',
      custom_body: '동작',
    },
  };
  const encoded = codec(protocol).encode(value);
  assert.ok(encoded.success);
  const result = codec(protocol).push(encoded.value);
  assert.equal(result.messages[0]?.values.custom_body, '동작');
  assert.equal(result.messages[0]?.values.custom_method, 'POST');
  assert.deepEqual(result.diagnostics, []);
});
