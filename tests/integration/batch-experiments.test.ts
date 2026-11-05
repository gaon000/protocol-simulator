import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type BatchOptions,
  type BatchPlan,
  batchConfiguration,
  batchRunMetrics,
  createBatchSession,
  parseBatchNumbers,
  prepareBatch,
  summarizeBatch,
} from '../../src/application/batch-experiments.ts';
import { createSimulation } from '../../src/application/create-simulation.ts';
import { editExperiment } from '../../src/application/edit-experiment.ts';
import { compareRecord } from '../../src/application/replay-record.ts';
import {
  createWorkspace,
  exportWorkspace,
  mergeWorkspaces,
} from '../../src/application/workspace-operations.ts';
import type { ExperimentDefinition } from '../../src/domain/protocol-model.ts';
import type { SavedRun } from '../../src/domain/workspace-model.ts';
import { parseWorkspaceData } from '../../src/domain/workspace-validation.ts';
import { createExampleCopy } from '../../src/examples/catalog.ts';
import { createEventLimitExperiment } from '../fixtures/large-experiments.ts';

const options: BatchOptions = {
  label: 'paired',
  seeds: [0, 1, 0xffff_ffff],
  delaysMs: [0, 40],
  lossRates: [0, 1],
  direction: 'both',
};
function plan(
  source = createExampleCopy('stop_wait'),
  changes: Partial<BatchOptions> = {},
  available = 100,
) {
  const result = prepareBatch(
    source,
    'experiment_fixture',
    1,
    { ...options, ...changes },
    available,
  );
  assert.ok(result.success, JSON.stringify(result));
  return result.value;
}
function run(prepared: BatchPlan): SavedRun[] {
  const session = createBatchSession(prepared);
  const records: SavedRun[] = [];
  while (!session.progress().done) {
    const record = session.advance();
    if (record) records.push(record);
  }
  return records;
}

test('batch conditions use identical seed order, isolate source edits, and retain directional faults', () => {
  const source = structuredClone(createExampleCopy('stop_wait'));
  const before = structuredClone(source);
  const prepared = plan(source, { direction: 'BtoA' });
  assert.equal(prepared.totalRuns, 12);
  assert.equal(prepared.variants.length, 4);
  for (let index = 0; index < 12; index++) {
    const config = batchConfiguration(prepared, index);
    assert.equal(config.seed, options.seeds[index % 3]);
    assert.deepEqual(config.environment.directions.AtoB, before.environment.directions.AtoB);
    assert.deepEqual(config.scenario, before.scenario);
    assert.deepEqual(config.definitions, before.definitions);
  }
  assert.deepEqual(source, before);
  (source as { label: string }).label = 'later';
  assert.notEqual(prepared.source.label, 'later');
  assert.ok(Object.isFrozen(prepared.source.definitions));
  assert.throws(() => batchConfiguration(prepared, -1));
});

test('batch list parsing and validation reject malformed, duplicate, overflowing and incompatible settings', () => {
  assert.deepEqual(parseBatchNumbers('0, 1, 4294967295'), [0, 1, 4294967295]);
  assert.deepEqual(parseBatchNumbers(' '), []);
  for (const value of ['1,', ',2', '1e3', 'Infinity', '-1', '1 2'])
    assert.ok(Number.isNaN(parseBatchNumbers(value)[0]));
  for (const change of [
    { seeds: [] },
    { seeds: [1, 1] },
    { seeds: [2 ** 32] },
    { seeds: [0.5] },
    { delaysMs: [1.1] },
    { lossRates: [NaN] },
    { lossRates: [1.1] },
    { label: '' },
  ]) {
    assert.equal(
      prepareBatch(createExampleCopy('stop_wait'), 'exp', 1, { ...options, ...change }, 100)
        .success,
      false,
    );
  }
  assert.equal(prepareBatch(createExampleCopy('stop_wait'), 'exp', 1, options, 11).success, false);
  assert.equal(prepareBatch(createExampleCopy('ping_pong'), 'exp', 1, options, 100).success, false);
  assert.equal(
    prepareBatch(
      editExperiment(createExampleCopy('stop_wait'), '/seed', -1),
      'exp',
      1,
      options,
      100,
    ).success,
    false,
  );
});

test('seeded repetitions match independent simulations and summaries reflect real loss failures', () => {
  const prepared = plan();
  const records = run(prepared);
  assert.equal(records.length, 12);
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    assert.ok(record);
    const created = createSimulation(batchConfiguration(prepared, index));
    assert.ok(created.success);
    assert.equal(
      compareRecord(record, created.value.run()),
      'snapshot 재실행의 의미적 기록·상태·판정이 일치합니다.',
    );
  }
  const summary = summarizeBatch(records);
  assert.equal(summary.length, 4);
  assert.equal(summary[0]?.pass, 3);
  assert.equal(summary[1]?.fail, 3);
  assert.equal(summary[0]?.missing, 0);
  assert.ok((summary[1]?.meanExpiries ?? 0) > 0);
  assert.ok((summary[1]?.meanSends ?? 0) > (summary[0]?.meanSends ?? 0));
  assert.equal(summarizeBatch(records.slice(0, 1))[0]?.missing, 2);
});

test('stream delay sweeps preserve framing and connection settings without injecting datagram fields', () => {
  const source = createExampleCopy('http_split');
  const prepared = plan(source, { lossRates: [], delaysMs: [5, 70] });
  const config = batchConfiguration(prepared, 3);
  assert.equal(config.environment.kind, 'stream');
  assert.equal(config.environment.directions.AtoB.delayMs, 70);
  assert.equal('lossRate' in config.environment.directions.AtoB, false);
  const kept = plan(source, { lossRates: [], delaysMs: [] });
  assert.deepEqual(batchConfiguration(kept, 0).environment, source.environment);
});

test('cancelled and limited runs stay undetermined, cancellation is idempotent and fences later work', () => {
  const prepared = plan(createEventLimitExperiment(), {
    seeds: [1, 2],
    lossRates: [],
    delaysMs: [],
  });
  const session = createBatchSession(prepared);
  assert.equal(session.advance(), undefined);
  const cancelled = session.cancel();
  assert.ok(cancelled);
  assert.equal(cancelled.view.status, 'cancelled');
  assert.equal(batchRunMetrics(cancelled.view).verdict, 'undetermined');
  assert.equal(session.cancel(), undefined);
  assert.equal(session.advance(), undefined);
  assert.equal(session.progress().finished, 1);
  const limited = run(
    plan(createEventLimitExperiment(), { seeds: [1], lossRates: [], delaysMs: [] }),
  )[0];
  assert.ok(limited);
  assert.equal(limited.view.events.length, 10_000);
  assert.equal(batchRunMetrics(limited.view).verdict, 'undetermined');
  assert.equal(batchRunMetrics(limited.view).completionMs, null);
});

test('engine completion, expectation verdict and participant completion time remain separate', () => {
  const record = run(
    plan(createExampleCopy('stop_wait'), { seeds: [1], delaysMs: [20], lossRates: [0] }),
  )[0];
  assert.ok(record);
  const metrics = batchRunMetrics(record.view);
  assert.equal(metrics.verdict, 'pass');
  assert.ok(metrics.completionMs !== null && metrics.completionMs < record.view.timeMs);
  assert.equal(batchRunMetrics({ ...record.view, expectations: [] }).verdict, 'undetermined');
  assert.equal(batchRunMetrics({ ...record.view, status: 'cancelled' }).verdict, 'undetermined');
  const [check] = record.view.expectations;
  assert.ok(check);
  assert.equal(
    batchRunMetrics({ ...record.view, expectations: [{ ...check, status: 'fail' }] }).verdict,
    'fail',
  );
});

function workspace() {
  const data = createWorkspace(createExampleCopy('stop_wait'));
  const draft = data.drafts[0];
  assert.ok(draft);
  const result = prepareBatch(
    draft.configuration,
    draft.id,
    draft.version,
    { ...options, seeds: [1], delaysMs: [0] },
    100,
  );
  assert.ok(result.success);
  return { ...data, runs: run(result.value) };
}

test('batch metadata round-trips with old records and bundle collision remaps whole groups', () => {
  const data = workspace();
  assert.ok(parseWorkspaceData(data).success);
  assert.ok(exportWorkspace(data).success);
  const merged = mergeWorkspaces(data, data);
  assert.ok(parseWorkspaceData(merged).success);
  assert.equal(new Set(merged.runs.map((record) => record.batch?.id)).size, 2);
  assert.equal(summarizeBatch(merged.runs).length, 4);
  const retried = mergeWorkspaces(data, data, true);
  assert.deepEqual(retried, data);
  const divergent = {
    ...data,
    drafts: data.drafts.map((draft) => ({
      ...draft,
      configuration: { ...draft.configuration, label: 'divergent draft' },
    })),
  };
  const recovered = mergeWorkspaces(data, divergent, true);
  assert.ok(parseWorkspaceData(recovered).success);
  assert.equal(recovered.runs.length, 4);
  assert.equal(new Set(recovered.runs.map((record) => record.batch?.id)).size, 2);
  const legacy = { ...data, runs: data.runs.map(({ batch: _batch, ...record }) => record) };
  assert.ok(parseWorkspaceData(legacy).success);
});

test('untrusted batch metadata rejects false seeds, conditions, group members and unknown fields', () => {
  const data = workspace();
  for (const changes of [
    { seeds: [2] },
    { variantIndex: 100 },
    { lossRate: 0.5 },
    { totalRuns: 999 },
    { seedIndex: -1 },
    { surprise: true },
  ]) {
    const copy = structuredClone(data);
    Object.assign(copy.runs[0]?.batch ?? {}, changes);
    assert.equal(parseWorkspaceData(copy).success, false, JSON.stringify(changes));
  }
  const copy = structuredClone(data);
  const record = copy.runs[0];
  assert.ok(record);
  copy.runs.push({ ...record, id: 'duplicate_slot' });
  assert.equal(parseWorkspaceData(copy).success, false);
  const changed = structuredClone(data);
  const next = changed.runs[1];
  assert.ok(next);
  (next as { view: SavedRun['view'] }).view = {
    ...next.view,
    snapshot: {
      ...next.view.snapshot,
      configuration: {
        ...next.view.snapshot.configuration,
        label: 'different source',
      } as ExperimentDefinition,
    },
  };
  assert.equal(parseWorkspaceData(changed).success, false);
});

test('malformed recorded views with batch metadata are rejected without throwing', () => {
  const data = workspace();
  for (const view of [
    null,
    {},
    { snapshot: null },
    { snapshot: { configuration: { environment: { kind: 'datagram' } } } },
  ]) {
    const copy = structuredClone(data);
    Object.assign(copy.runs[0] ?? {}, { view });
    assert.equal(parseWorkspaceData(copy).success, false);
  }
});

test('remaining workspace capacity is enforced before engine allocation', () => {
  const source = createExampleCopy('stop_wait');
  assert.equal(
    prepareBatch(
      source,
      'experiment_fixture',
      1,
      { ...options, seeds: [1], delaysMs: [], lossRates: [] },
      0,
    ).success,
    false,
  );
  const final = plan(source, { seeds: [1], delaysMs: [], lossRates: [] }, 1);
  assert.equal(run(final).length, 1);
});
