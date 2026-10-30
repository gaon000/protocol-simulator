import assert from 'node:assert/strict';
import test from 'node:test';
import { createSeededRandom } from '../../src/domain/execution-contract.ts';
import reference from '../fixtures/datagram-reference.json' with { type: 'json' };

test('P0 environment reference vector fixes draws and expected arrival order for P4', () => {
  const random = createSeededRandom(reference.seed);
  const draws = Array.from({ length: 4 }, () => random());
  assert.deepEqual(
    draws.map((value) => value * 4_294_967_296),
    reference.drawsUint32,
  );
  const [loss, duplicate, originalDelay, duplicateDelay] = draws;
  assert.ok(
    loss !== undefined &&
      duplicate !== undefined &&
      originalDelay !== undefined &&
      duplicateDelay !== undefined,
  );
  assert.ok(loss >= reference.lossRate);
  assert.ok(duplicate < reference.duplicateRate);
  const arrival = (value: number) =>
    reference.sendTimeMs +
    Math.max(0, reference.baseDelayMs + Math.round((value * 2 - 1) * reference.jitterMs));
  assert.deepEqual(
    [
      { copy: 'original', timeMs: arrival(originalDelay) },
      { copy: 'duplicate', timeMs: arrival(duplicateDelay) },
    ].sort((left, right) => left.timeMs - right.timeMs),
    reference.expectedDeliveries,
  );
});
