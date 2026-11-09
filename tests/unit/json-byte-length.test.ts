import assert from 'node:assert/strict';
import test from 'node:test';
import {
  jsonByteLength,
  parseJsonData,
  parseOwnedJsonData,
} from '../../src/domain/model-validation.ts';
import type { JsonValue } from '../../src/domain/execution-contract.ts';
const actual = (value: JsonValue) => new TextEncoder().encode(JSON.stringify(value)).length;

test('owned JSON byte counts exactly match native JSON UTF-8 for escaping, Unicode, numbers and byte arrays', () => {
  const values: JsonValue[] = [
    null,
    true,
    false,
    -0,
    2.5,
    1e21,
    1e-8,
    Number.MAX_SAFE_INTEGER,
    { '\n"\\ 한글': ['한글🧪', '\ud800', '\udfff', 'a\nb\t"\\', 0, -0, false, null] },
    Array.from({ length: 100000 }, (_, i) => i % 257),
    Array.from({ length: 1500 }, (_, i) => `고유한 문자열 ${i} 🧪`),
  ];
  for (const value of values) {
    const owned = parseOwnedJsonData(structuredClone(value), { maxNodes: 200000, maxDepth: 64 });
    assert.ok(owned.success, JSON.stringify(owned));
    assert.equal(jsonByteLength(owned.value), actual(value));
    assert.equal(parseJsonData(owned.value, { maxNodes: 200000, maxDepth: 64 }).success, true);
    assert.equal(jsonByteLength(owned.value), actual(value));
  }
});
test('each repeated alias and cached subtree contributes its full serialized bytes', () => {
  const child = parseOwnedJsonData({ text: '가"🧪', array: [9, 10, 99, 100, 255, 256, -1, -123] });
  assert.ok(child.success);
  const outer = { first: child.value, second: child.value, items: [child.value, child.value] };
  const checked = parseOwnedJsonData(outer);
  assert.ok(checked.success);
  assert.equal(jsonByteLength(checked.value), actual(outer));
  assert.equal(jsonByteLength(child.value), actual(child.value));
});
test('mutable or only shallow-frozen values never reuse an earlier byte count', () => {
  const child = { text: 'a' };
  const outer = Object.freeze({ child });
  assert.equal(jsonByteLength(outer), actual(outer));
  child.text = '한글'.repeat(100);
  assert.equal(jsonByteLength(outer), actual(outer));
  const array = [1, 2];
  assert.equal(jsonByteLength(array), actual(array));
  array.push(255);
  assert.equal(jsonByteLength(array), actual(array));
});
test('byte metadata never bypasses tighter node/depth limits on owned repeated values', () => {
  const child = { nested: [1, { value: false }] };
  const outer = [child, child];
  const checked = parseOwnedJsonData(outer);
  assert.ok(checked.success);
  assert.equal(jsonByteLength(checked.value), actual(outer));
  assert.equal(parseJsonData(checked.value, { maxNodes: 5, maxDepth: 64 }).success, false);
  assert.equal(parseJsonData(checked.value, { maxNodes: 100, maxDepth: 2 }).success, false);
  assert.equal(
    parseOwnedJsonData({ child: checked.value }, { maxNodes: 5, maxDepth: 64 }).success,
    false,
  );
  assert.equal(jsonByteLength(checked.value), actual(outer));
});
test('failed owned validation does not evaluate accessors, freeze callers or accept non-JSON graphs', () => {
  let calls = 0;
  const accessor = {
    get value() {
      calls++;
      return 1;
    },
  };
  assert.equal(parseOwnedJsonData(accessor).success, false);
  assert.equal(calls, 0);
  assert.equal(Object.isFrozen(accessor), false);
  const hole = new Array(2);
  assert.equal(parseOwnedJsonData(hole).success, false);
  assert.equal(Object.isFrozen(hole), false);
  const bad = { valid: [1, 2], invalid: Infinity };
  assert.equal(parseOwnedJsonData(bad).success, false);
  assert.equal(Object.isFrozen(bad.valid), false);
  const hidden: number[] = [1, 2];
  Object.defineProperty(hidden, 'toJSON', {
    get() {
      calls++;
      return () => 'different';
    },
  });
  assert.equal(parseOwnedJsonData(hidden).success, false);
  assert.equal(calls, 0);
  class AlternateArray extends Array<number> {
    toJSON() {
      return 'different';
    }
  }
  assert.equal(parseOwnedJsonData(new AlternateArray(1, 2)).success, false);
});

test('dense byte metadata counts every alias and preserves exact tighter-budget diagnostics', () => {
  const bytes = Array.from({ length: 256 }, (_, i) => i);
  const outer = [bytes, bytes];
  const checked = parseOwnedJsonData(outer, { maxNodes: 515, maxDepth: 2 });
  assert.ok(checked.success);
  assert.equal(jsonByteLength(checked.value), actual(outer));
  const limited = parseOwnedJsonData(checked.value, { maxNodes: 514, maxDepth: 2 });
  assert.ok(!limited.success);
  assert.deepEqual(
    limited.diagnostics.map((d) => [d.path, d.code]),
    [['/1/255', 'json-limit']],
  );
  const deep = parseJsonData(checked.value, { maxNodes: 515, maxDepth: 1 });
  assert.ok(!deep.success);
  assert.equal(deep.diagnostics[0]?.path, '/0/0');
  const empty = parseOwnedJsonData([], { maxNodes: 1, maxDepth: 0 });
  assert.ok(empty.success);
  assert.equal(jsonByteLength(empty.value), 2);
});

test('byte-array optimization retains holes, hidden/extra/symbol properties and accessor rejection without executing getters', () => {
  let calls = 0;
  const hole = [1, 2, 3];
  delete hole[1];
  const hidden = [1, 2];
  Object.defineProperty(hidden, 'toJSON', {
    get() {
      calls++;
      return () => [];
    },
  });
  const accessor = [1, 2];
  Object.defineProperty(accessor, '1', {
    get() {
      calls++;
      return 2;
    },
  });
  const extra = Object.assign([1, 2], { extra: true });
  const symbol = [1, 2];
  Object.defineProperty(symbol, Symbol('extra'), { value: 3 });
  const reordered = new Proxy(Object.assign([1, 2], { extra: true }), {
    ownKeys: () => ['0', 'extra', 'length'],
  });
  for (const value of [hole, hidden, accessor, extra, symbol, reordered, [0, NaN], [0, Infinity]]) {
    const checked = parseOwnedJsonData(value);
    assert.ok(!checked.success);
    assert.equal(Object.isFrozen(value), false);
  }
  assert.equal(calls, 0);
  for (const value of [
    [0, 256],
    [0, -1],
    [0, 1.5],
    [0, -0],
    [0, '1'],
    [0, false],
  ]) {
    const checked = parseOwnedJsonData(value);
    assert.ok(checked.success);
    assert.equal(jsonByteLength(checked.value), actual(value));
  }
});
