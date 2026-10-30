import assert from 'node:assert/strict';
import test from 'node:test';
import { createRunSnapshot, EXECUTION_POLICY } from '../../src/domain/execution-contract.ts';
import configuration from '../fixtures/run-configuration.json' with { type: 'json' };

test('snapshot contains definitions, settings, limits and version metadata without live references', () => {
  const draft = structuredClone(configuration);
  const snapshot = createRunSnapshot(draft, 42);
  draft.protocols.A.revision = 2;
  draft.environment.delayMs = 300;
  assert.equal(snapshot.configuration.protocols?.A?.revision, 1);
  assert.equal(snapshot.configuration.environment?.delayMs, 10);
  assert.equal(snapshot.seed, 42);
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.engineVersion, EXECUTION_POLICY.engineVersion);
  assert.equal(snapshot.limits.maxEvents, 10_000);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.configuration));
  assert.ok(Object.isFrozen(snapshot.configuration.protocols));
  assert.ok(Object.isFrozen(snapshot.configuration.definitions[0]?.messages));
  assert.equal(Reflect.set(snapshot.configuration.protocols.A, 'revision', 99), false);
});

test('JSON export round trip retains the complete captured configuration', () => {
  const snapshot = createRunSnapshot(configuration, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
});

test('separate snapshots isolate future draft edits', () => {
  const draft = structuredClone(configuration);
  const before = createRunSnapshot(draft, 42);
  draft.environment.delayMs = 20;
  const after = createRunSnapshot(draft, 42);
  assert.notDeepEqual(before.configuration, after.configuration);
  assert.notEqual(before.configuration, after.configuration);
});
