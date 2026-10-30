import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareEventKeys,
  createSeededRandom,
  type EventOrderKey,
} from '../../src/domain/execution-contract.ts';
import { EventQueue } from '../../src/engine/event-queue.ts';
import { equalJson, evaluateCondition, evaluateValue } from '../../src/engine/expressions.ts';

test('heap matches reference ordering for interleaved times and same-time expiry', () => {
  const random = createSeededRandom(42);
  const queue = new EventQueue<EventOrderKey>();
  const events = Array.from(
    { length: 1000 },
    (_, sequence): EventOrderKey => ({
      timeMs: Math.floor(random() * 100),
      kind: sequence % 3 === 0 ? 'timer' : 'delivery',
      sequence,
    }),
  );
  for (const event of events) queue.push(event);
  const actual = [];
  while (queue.size) actual.push(queue.take());
  assert.deepEqual(actual, [...events].sort(compareEventKeys));
  assert.equal(queue.take(), undefined);
  assert.equal(queue.peek(), undefined);
  queue.push(events[0] ?? { timeMs: 0, kind: 'input', sequence: 0 });
  queue.clear();
  assert.equal(queue.size, 0);
});

test('expression evaluation preserves JSON equality and rejects missing/overflow values', () => {
  assert.ok(equalJson({ one: 1, two: [true, null] }, { two: [true, null], one: 1 }));
  assert.ok(!equalJson({ value: 1 }, { value: '1' }));
  assert.throws(
    () => evaluateValue({ kind: 'field', fieldId: 'absent' }, { variables: {} }),
    /absent/,
  );
  assert.throws(
    () =>
      evaluateValue(
        {
          kind: 'add',
          left: { kind: 'literal', value: Number.MAX_SAFE_INTEGER },
          right: { kind: 'literal', value: 1 },
        },
        { variables: {} },
      ),
    /safe integer range/,
  );
  assert.equal(
    evaluateCondition(
      {
        kind: 'any',
        conditions: [
          {
            kind: 'compare',
            operator: 'eq',
            left: { kind: 'literal', value: 1 },
            right: { kind: 'literal', value: 1 },
          },
          {
            kind: 'compare',
            operator: 'eq',
            left: { kind: 'field', fieldId: 'absent' },
            right: { kind: 'literal', value: 1 },
          },
        ],
      },
      { variables: {} },
    ),
    true,
  );
});
