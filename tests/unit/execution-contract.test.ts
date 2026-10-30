import assert from 'node:assert/strict';
import test from 'node:test';
import { compareEventKeys, createSeededRandom } from '../../src/domain/execution-contract.ts';

test('same-time input and delivery precede expiry while keeping creation order', () => {
  const events = [
    { id: 'expiry', timeMs: 500, kind: 'timer', sequence: 0 },
    { id: 'reply', timeMs: 500, kind: 'delivery', sequence: 3 },
    { id: 'start', timeMs: 0, kind: 'input', sequence: 1 },
    { id: 'disconnect', timeMs: 500, kind: 'connection', sequence: 2 },
  ] as const;
  assert.deepEqual(
    [...events].sort(compareEventKeys).map((event) => event.id),
    ['start', 'disconnect', 'reply', 'expiry'],
  );
});

test('earlier timer is not delayed by a later delivery', () => {
  assert.ok(
    compareEventKeys(
      { timeMs: 499, kind: 'timer', sequence: 10 },
      { timeMs: 500, kind: 'delivery', sequence: 0 },
    ) < 0,
  );
});

test('same seed reproduces the sequence and independent instances do not share state', () => {
  const first = createSeededRandom(42);
  const second = createSeededRandom(42);
  const third = createSeededRandom(43);
  const firstValues = Array.from({ length: 8 }, () => first());
  assert.deepEqual(
    firstValues,
    Array.from({ length: 8 }, () => second()),
  );
  assert.notDeepEqual(
    firstValues,
    Array.from({ length: 8 }, () => third()),
  );
});

test('mulberry32-v1 keeps the fixed seed-42 reference vector', () => {
  const random = createSeededRandom(42);
  assert.deepEqual(
    Array.from({ length: 4 }, () => random() * 4_294_967_296),
    [2_581_720_956, 1_925_393_290, 3_661_312_704, 2_876_485_805],
  );
});

test('zero is a valid seed and random output is bounded', () => {
  const random = createSeededRandom(0);
  for (let index = 0; index < 1000; index++) {
    const value = random();
    assert.ok(value >= 0 && value < 1);
  }
});

test('invalid seeds are rejected instead of silently rounded or truncated', () => {
  for (const seed of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0x1_0000_0000]) {
    assert.throws(() => createSeededRandom(seed), RangeError);
  }
});
