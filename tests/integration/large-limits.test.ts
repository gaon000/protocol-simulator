import assert from 'node:assert/strict';
import test from 'node:test';
import { createSimulation } from '../../src/application/create-simulation.ts';
import type { JsonObject } from '../../src/domain/execution-contract.ts';
import {
  createEventLimitExperiment,
  createMessageLimitExperiment,
} from '../fixtures/large-experiments.ts';

test('the large-event fixture reaches the real trace quota and remains deterministic across batch sizes', () => {
  const created = createSimulation(createEventLimitExperiment(), { runId: 'bounded' });
  const replay = createSimulation(createEventLimitExperiment(), { runId: 'bounded' });
  assert.ok(created.success && replay.success);
  const all = created.value.run();
  let batched = replay.value.view();
  while (!replay.value.result()) batched = replay.value.runBatch(64);
  assert.equal(all.status, 'limit-reached');
  assert.equal(all.events.length, 10_000);
  assert.deepEqual(batched, all);
});

test('the byte fixture sends exactly 1 MiB and a one-byte overflow is rejected before sending', () => {
  const created = createSimulation(createMessageLimitExperiment());
  assert.ok(created.success);
  const result = created.value.run();
  assert.equal(result.status, 'completed');
  assert.equal(result.expectations[0]?.status, 'pass');
  const send = result.events.find((event) => event.kind === 'send');
  assert.ok(send);
  const wire = (send.data as JsonObject).wire as JsonObject;
  assert.ok(Array.isArray(wire.bytes));
  assert.equal(wire.bytes.length, 1_048_576);
  const overflow = createSimulation(createMessageLimitExperiment(true));
  assert.ok(overflow.success);
  const rejected = overflow.value.run();
  assert.equal(rejected.status, 'limit-reached');
  assert.equal(rejected.events.filter((event) => event.kind === 'send').length, 0);
});
