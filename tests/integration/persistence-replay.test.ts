import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRunSession,
  createSimulation,
  createSimulationFromSnapshot,
} from '../../src/application/create-simulation.ts';
import { editExperiment } from '../../src/application/edit-experiment.ts';
import { compareRecord, projectRecord } from '../../src/application/replay-record.ts';
import {
  captureRun,
  createWorkspace,
  definitionDeletionReason,
  exportWorkspace,
  stageBundle,
} from '../../src/application/workspace-operations.ts';
import { parseExperiment, parseExperimentDraft } from '../../src/domain/model-validation.ts';
import {
  parseRecordedSnapshot,
  parseWorkspaceBundle,
  parseWorkspaceData,
  parseWorkspaceEnvelope,
  rawDiagnostics,
} from '../../src/domain/workspace-validation.ts';
import type { JsonObject } from '../../src/domain/execution-contract.ts';
import type { ExperimentSnapshot } from '../../src/domain/protocol-model.ts';
import { WORKSPACE_POLICY, type WorkspaceData } from '../../src/domain/workspace-model.ts';
import { EXAMPLES, createExampleCopy } from '../../src/examples/catalog.ts';

function fixture() {
  const data = createWorkspace(createExampleCopy('ping_pong'));
  const draft = data.drafts[0];
  assert.ok(draft);
  const created = createSimulation(draft.configuration);
  assert.ok(created.success);
  const record = captureRun(created.value.run(), draft.id, draft.version);
  return { ...data, runs: [record] };
}
function text(data: WorkspaceData) {
  return JSON.stringify({ schemaVersion: 1, kind: 'protocol-studio-bundle', data });
}
function replaceAt(value: unknown, path: string, next: unknown) {
  const parts = path.split('/').slice(1);
  let target = value as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
  const key = parts.at(-1);
  assert.ok(key);
  target[key] = next;
}

test('invalid but renderable drafts retain unfinished JSON, empty IDs, ranges and dangling references', () => {
  const data = fixture();
  const draft = data.drafts[0];
  assert.ok(draft);
  let config = editExperiment(draft.configuration, '/definitions/0/messages/0/fields/0/name', '');
  config = editExperiment(config, '/protocols/A/id', 'missing');
  config = editExperiment(config, '/environment/ab/delayMs', -1);
  assert.equal(parseExperiment(config).success, false);
  assert.equal(parseExperimentDraft(config).success, true);
  const raw = {
    '/definitions/0/variables/0/initial': '{',
    '/definitions/0/variables/1/initial': '1e999',
  };
  const updated = { ...data, drafts: [{ ...draft, configuration: config, raw }] };
  assert.equal(parseWorkspaceData(updated).success, true);
  assert.equal(rawDiagnostics(raw).length, 2);
  const parsed = parseWorkspaceBundle(text(updated));
  assert.ok(parsed.success);
  assert.deepEqual(parsed.value.data.drafts[0]?.raw, raw);
  assert.deepEqual(parsed.value.data.runs, data.runs);
});

test('broken editor shapes are rejected even when semantic draft validation is deferred', () => {
  const config = fixture().drafts[0]?.configuration;
  assert.ok(config);
  for (const [path, value] of [
    ['/definitions', []],
    ['/definitions/0/variables', null],
    ['/definitions/0/messages/0/fields/0/type', 'unknown'],
    ['/environment/kind', 'unknown'],
  ] as const) {
    assert.equal(parseExperimentDraft(editExperiment(config, path, value)).success, false, path);
  }
  assert.equal(parseExperimentDraft({ ...config, extra: true }).success, false);
});

test('every catalog checkpoint and completed trace survives the full self-contained bundle validator', () => {
  for (const example of EXAMPLES) {
    const data = createWorkspace(createExampleCopy(example.id));
    const draft = data.drafts[0];
    assert.ok(draft);
    const created = createSimulation(draft.configuration);
    assert.ok(created.success);
    const engine = created.value;
    for (const view of [engine.view(), engine.step(), engine.pause(), engine.run()]) {
      const withRun: WorkspaceData = { ...data, runs: [captureRun(view, draft.id, draft.version)] };
      const result = exportWorkspace(withRun);
      assert.ok(result.success, `${example.id}/${view.status}: ${JSON.stringify(result)}`);
      const parsed = parseWorkspaceBundle(result.value);
      assert.ok(parsed.success);
      assert.deepEqual(parsed.value.data, withRun);
    }
  }
});

test('import collisions create copies while preserving IDs scoped inside historical snapshots', () => {
  const original = fixture();
  const before = JSON.stringify(original);
  const staged = stageBundle(text(original), original);
  assert.ok(staged.success);
  assert.equal(staged.value.drafts.length, 2);
  assert.equal(staged.value.runs.length, 2);
  const copy = staged.value.drafts[1];
  const run = staged.value.runs[1];
  assert.ok(copy && run);
  assert.notEqual(copy.id, original.activeDraftId);
  assert.notEqual(run.id, original.runs[0]?.id);
  assert.equal(run.experimentId, copy.id);
  assert.equal(staged.value.activeDraftId, copy.id);
  assert.deepEqual(run.view, original.runs[0]?.view);
  assert.equal(JSON.stringify(original), before);
});

test('unsupported bundle and envelope versions, corrupt traces and missing references are atomic rejections', () => {
  const data = fixture();
  const before = JSON.stringify(data);
  const send = data.runs[0]?.view.events.findIndex((event) => event.kind === 'send');
  assert.ok(send !== undefined && send >= 0);
  const changes: readonly [string, unknown][] = [
    ['/schemaVersion', 2],
    ['/activeDraftId', 'missing'],
    ['/runs/0/view/events/0/causeEventId', 'future'],
    ['/runs/0/view/events/0/sequence', 7],
    ['/runs/0/view/participants/A/stateId', 'missing'],
    ['/runs/0/view/snapshot/seed', 777],
    ['/runs/0/view/status', 'cancelled'],
    ['/runs/0/view/snapshot/limits/maxEvents', 1],
    ['/drafts/0/raw', { '/label': '{' }],
    ['/drafts/0/raw', { '/definitions/0/variables/0/initial': '999' }],
    [`/runs/0/view/events/${send}/data/wire`, { kind: 'bytes', bytes: [256] }],
  ];
  for (const [path, value] of changes) {
    const bad = structuredClone(data);
    replaceAt(bad, path, value);
    assert.equal(stageBundle(text(bad), data).success, false, path);
    assert.equal(JSON.stringify(data), before);
  }
  assert.equal(parseWorkspaceBundle('{').success, false);
  assert.equal(
    parseWorkspaceBundle(JSON.stringify({ schemaVersion: 2, kind: 'protocol-studio-bundle', data }))
      .success,
    false,
  );
  assert.equal(parseWorkspaceEnvelope({ schemaVersion: 2, revision: 1, data }).success, false);
  assert.equal(parseWorkspaceEnvelope({ schemaVersion: 1, revision: 0, data }).success, false);
});

test('file size and merged capacity are checked before replacement', () => {
  const data = fixture();
  const oversized = parseWorkspaceBundle(' '.repeat(WORKSPACE_POLICY.maxBytes + 1));
  assert.ok(!oversized.success);
  assert.equal(oversized.diagnostics[0]?.code, 'bundle-size');
  const draft = data.drafts[0];
  assert.ok(draft);
  const full = {
    ...data,
    drafts: Array.from({ length: 100 }, (_, i) => ({ ...draft, id: `draft_${i}` })),
    activeDraftId: 'draft_0',
  };
  assert.equal(stageBundle(text(data), full).success, false);
  assert.equal(full.drafts.length, 100);
});

test('orphan history is self-contained after deleting its draft and current definitions', () => {
  const data = fixture();
  const original = data.drafts[0];
  const saved = data.runs[0];
  assert.ok(original && saved);
  const other = createWorkspace(createExampleCopy('tcp_handshake'));
  const withOrphan = { ...other, runs: data.runs };
  assert.equal(parseWorkspaceData(withOrphan).success, true);
  const staged = stageBundle(text(withOrphan), withOrphan);
  assert.ok(staged.success);
  assert.notEqual(staged.value.runs[0]?.experimentId, staged.value.runs[1]?.experimentId);
  const replay = createSimulationFromSnapshot(saved.view.snapshot);
  assert.ok(replay.success);
  assert.match(compareRecord(saved, replay.value.run()), /일치/);
  assert.deepEqual(saved.view.snapshot.configuration, original.configuration);
});

test('definition deletion guards exact active revisions and edits never retarget a different revision', () => {
  const data = fixture();
  const config = data.drafts[0]?.configuration;
  const first = config?.definitions[0];
  assert.ok(config && first);
  const versioned = {
    ...config,
    definitions: [first, { ...first, revision: 5 }],
    protocols: { A: { id: first.id, revision: 5 }, B: { id: first.id, revision: 5 } },
  };
  assert.equal(definitionDeletionReason(versioned, 0), undefined);
  assert.match(definitionDeletionReason(versioned, 1) ?? '', /참조 중/);
  const edited = editExperiment(versioned, '/definitions/0/label', 'older');
  assert.deepEqual(edited.protocols, versioned.protocols);
  assert.equal(edited.definitions[0]?.revision, 2);
  assert.match(definitionDeletionReason(config, 0) ?? '', /하나 이상/);
});

test('snapshot replay uses saved seed, configuration and limits while leaving a changed draft untouched', () => {
  const data = fixture();
  const draft = data.drafts[0];
  assert.ok(draft);
  const created = createSimulation(draft.configuration, { limits: { maxEvents: 3 } });
  assert.ok(created.success);
  const record = captureRun(created.value.run(), draft.id, 1);
  const changed = editExperiment(draft.configuration, '/seed', 777);
  const replay = createSimulationFromSnapshot(record.view.snapshot);
  assert.ok(replay.success);
  const result = replay.value.run();
  assert.equal(result.status, 'limit-reached');
  assert.deepEqual(result.snapshot, record.view.snapshot);
  assert.match(compareRecord(record, result), /일치/);
  assert.equal(changed.seed, 777);
});

test('unknown engine/random versions remain viewable but cannot replace an existing session', () => {
  const record = fixture().runs[0];
  assert.ok(record);
  const session = createRunSession();
  const first = session.start(record.view.snapshot.configuration);
  assert.ok(first.success);
  for (const patch of [{ engineVersion: 'future' }, { randomAlgorithm: 'future' }]) {
    const snapshot: ExperimentSnapshot = { ...record.view.snapshot, ...patch };
    assert.equal(parseRecordedSnapshot(snapshot).success, true);
    assert.equal(session.startSnapshot(snapshot).success, false);
    assert.equal(session.current(), first.value);
    const data = fixture();
    assert.equal(
      parseWorkspaceData({ ...data, runs: [{ ...record, view: { ...record.view, snapshot } }] })
        .success,
      true,
    );
  }
  const next = session.startSnapshot(record.view.snapshot);
  assert.ok(next.success);
  assert.equal(
    session.apply(first.value.runId, () => assert.fail('stale callback')),
    false,
  );
  assert.equal(session.current(), next.value);
});

test('record navigation projects states and timers without executing or mutating original records', () => {
  const record = fixture().runs[0];
  assert.ok(record);
  const before = JSON.stringify(record);
  assert.equal(projectRecord(record, 0).participants.A.stateId, 'Idle');
  const start = record.view.events.findIndex(
    (event) => event.kind === 'timer' && (event.data as JsonObject).operation === 'start',
  );
  assert.ok(start >= 0);
  assert.equal(projectRecord(record, start + 1).participants.A.timers[0]?.active, true);
  const waiting = record.view.events.findIndex(
    (event) => event.kind === 'transition' && event.participant === 'A',
  );
  assert.equal(projectRecord(record, waiting + 1).participants.A.stateId, 'Waiting');
  assert.ok(projectRecord(record, 1).expectations.every((item) => item.status === 'undetermined'));
  assert.deepEqual(
    projectRecord(record, record.view.events.length).participants,
    record.view.participants,
  );
  assert.equal(projectRecord(record, record.view.events.length + 1), record.view);
  assert.equal(JSON.stringify(record), before);
  const wrong = { ...record.view, status: 'cancelled' as const };
  assert.match(compareRecord(record, wrong), /다릅니다/);
});

test('a partial checkpoint compares only its recorded prefix and mutable source views are detached', () => {
  const data = fixture();
  const draft = data.drafts[0];
  assert.ok(draft);
  const created = createSimulation(draft.configuration);
  assert.ok(created.success);
  created.value.step();
  const source = structuredClone(created.value.pause());
  const saved = captureRun(source, draft.id, 1);
  replaceAt(source, '/participants/A/variables/counter', 99);
  assert.notEqual(saved.view.participants.A.variables.counter, 99);
  const replay = createSimulationFromSnapshot(saved.view.snapshot);
  assert.ok(replay.success);
  assert.match(compareRecord(saved, replay.value.run()), /저장된 구간.*일치/);
});
