import assert from 'node:assert/strict';
import test from 'node:test';
import { batchRunMetrics } from '../../src/application/batch-experiments.ts';
import { createSimulation } from '../../src/application/create-simulation.ts';
import { editExperiment } from '../../src/application/edit-experiment.ts';
import { compareRecord } from '../../src/application/replay-record.ts';
import {
  compareRegressionRuns,
  createRegressionSession,
  createScenarioSuite,
  editScenarioCase,
  editScenarioCaseJson,
  prepareRegression,
  regressionChange,
  scenarioCaseDiagnostics,
} from '../../src/application/scenario-suites.ts';
import {
  createDraftRecord,
  exportWorkspace,
  mergeWorkspaces,
} from '../../src/application/workspace-operations.ts';
import { caseConfiguration } from '../../src/domain/suite-validation.ts';
import type { DraftRecord, SavedRun, WorkspaceData } from '../../src/domain/workspace-model.ts';
import { parseWorkspaceBundle, parseWorkspaceData } from '../../src/domain/workspace-validation.ts';
import { createEventLimitExperiment } from '../fixtures/large-experiments.ts';
import { createSuiteDraft } from '../fixtures/scenario-suite.ts';

function run(draft: DraftRecord): SavedRun[] {
  const prepared = prepareRegression(draft, 100);
  assert.ok(prepared.success, JSON.stringify(prepared));
  const session = createRegressionSession(prepared.value);
  const records: SavedRun[] = [];
  while (!session.progress().done) {
    const record = session.advance();
    if (record) records.push(record);
  }
  return records;
}
function workspace(draft = createSuiteDraft()): WorkspaceData {
  return { schemaVersion: 1, activeDraftId: draft.id, drafts: [draft], runs: run(draft) };
}

test('a frozen suite runs normal, lost ACK and duplicate cases independently on one source version', () => {
  const draft = createSuiteDraft();
  const original = structuredClone(draft);
  const records = run(draft);
  assert.equal(records.length, 3);
  assert.deepEqual(
    records.map((record) => batchRunMetrics(record.view).verdict),
    ['pass', 'pass', 'pass'],
  );
  assert.equal(records[0]?.view.participants.A.variables.retries, 0);
  assert.equal(records[1]?.view.participants.A.variables.retries, 1);
  assert.equal(records[2]?.view.participants.A.variables.retries, 0);
  records.forEach((record, index) => {
    const item = draft.suite?.cases[index];
    assert.ok(item);
    const created = createSimulation(caseConfiguration(draft.configuration, item));
    assert.ok(created.success);
    assert.equal(
      compareRecord(record, created.value.run()),
      'snapshot 재실행의 의미적 기록·상태·판정이 일치합니다.',
    );
    assert.deepEqual(
      record.view.snapshot.configuration.definitions,
      draft.configuration.definitions,
    );
  });
  assert.deepEqual(draft, original);
});

test('source and case edits after preparation cannot change a captured regression run', () => {
  const draft = createSuiteDraft();
  const prepared = prepareRegression(draft, 100);
  assert.ok(prepared.success);
  const changed = editExperiment(draft.configuration, '/definitions/0/variables/0/initial', 99);
  assert.notDeepEqual(changed, prepared.value.draft.configuration);
  assert.ok(Object.isFrozen(prepared.value.cases[0]));
  const session = createRegressionSession(prepared.value);
  const first = session.advance();
  assert.ok(first);
  assert.equal(batchRunMetrics(first.view).verdict, 'pass');
});

test('case editors touch only owned settings and preserve shared definitions and pending JSON', () => {
  const draft = createSuiteDraft();
  const item = draft.suite?.cases[0];
  assert.ok(item);
  const changed = editScenarioCase(draft.configuration, item, '/scenario/observationMs', 700);
  assert.equal(changed.scenario.observationMs, 700);
  assert.equal(editScenarioCase(draft.configuration, item, '/definitions/0/label', 'bad'), item);
  assert.deepEqual(draft.suite?.cases[0], item);
  const raw = editScenarioCaseJson(
    draft.configuration,
    item,
    '/scenario/inputs/0/message/values/payload',
    '{',
  );
  assert.equal(raw.raw['/scenario/inputs/0/message/values/payload'], '{');
  assert.equal(
    scenarioCaseDiagnostics(draft, raw).some((item) => item.code === 'json-syntax'),
    true,
  );
});

test('invalid enabled cases and common pending definitions block execution, disabled errors do not', () => {
  const draft = createSuiteDraft();
  assert.ok(draft.suite);
  const originalCase = draft.suite.cases[1];
  assert.ok(originalCase);
  const invalid = { ...originalCase, scenario: { ...originalCase.scenario, observationMs: -1 } };
  assert.equal(
    prepareRegression({ ...draft, suite: { ...draft.suite, cases: [invalid] } }, 100).success,
    false,
  );
  const disabled = {
    ...draft,
    suite: {
      ...draft.suite,
      cases: [...draft.suite.cases.slice(0, 1), { ...invalid, enabled: false }],
    },
  };
  assert.equal(prepareRegression(disabled, 100).success, true);
  assert.equal(
    prepareRegression({ ...draft, raw: { '/definitions/0/variables/0/initial': '{' } }, 100)
      .success,
    false,
  );
  assert.equal(prepareRegression(draft, 2).success, false);
  assert.equal(
    prepareRegression({ ...draft, suite: { ...draft.suite, cases: [] } }, 100).success,
    false,
  );
});

test('pass-to-fail is a regression only under the same case settings and engine contract', () => {
  const draft = createSuiteDraft();
  const baseline = run(draft);
  const complete = draft.configuration.definitions[0]?.rules.findIndex((rule) =>
    rule.actions.some((action) => action.kind === 'finish' && action.outcome === 'success'),
  );
  assert.ok(complete !== undefined && complete >= 0);
  const changed = {
    ...draft,
    version: 2,
    configuration: editExperiment(
      draft.configuration,
      `/definitions/0/rules/${complete}/nextStateId`,
      'Failed',
    ),
  };
  const current = run(changed);
  const rows = compareRegressionRuns(
    [...baseline, ...current],
    current[0]?.regression?.id ?? '',
    baseline[0]?.regression?.id ?? '',
  );
  assert.deepEqual(
    rows.map((row) => row.change),
    ['새 실패', '새 실패', '새 실패'],
  );
  assert.equal(regressionChange(baseline[0], current[0]), '개선');
  const first = current[0];
  assert.ok(first);
  const conditions = {
    ...first,
    view: {
      ...first.view,
      snapshot: {
        ...first.view.snapshot,
        configuration: { ...first.view.snapshot.configuration, seed: 99 },
      },
    },
  };
  assert.equal(regressionChange(conditions, baseline[0]), '조건 변경');
  assert.equal(
    regressionChange({ ...first, view: { ...first.view, status: 'cancelled' } }, baseline[0]),
    '미판정',
  );
  assert.equal(
    regressionChange(
      {
        ...first,
        view: { ...first.view, snapshot: { ...first.view.snapshot, engineVersion: 'future' } },
      },
      baseline[0],
    ),
    '엔진 차이',
  );
});

test('cancellation fences later work and the full manifest preserves never-started cases', () => {
  const base = createDraftRecord(createEventLimitExperiment());
  const suite = createScenarioSuite(base);
  const item = suite.cases[0];
  assert.ok(item);
  const draft = {
    ...base,
    suite: { ...suite, cases: [item, { ...item, id: 'case_second', label: '두 번째' }] },
  };
  const prepared = prepareRegression(draft, 100);
  assert.ok(prepared.success);
  const session = createRegressionSession(prepared.value);
  assert.equal(session.advance(), undefined);
  const record = session.cancel();
  assert.ok(record);
  assert.equal(record.view.status, 'cancelled');
  assert.equal(session.advance(), undefined);
  assert.equal(session.cancel(), undefined);
  const rows = compareRegressionRuns([record], record.regression?.id ?? '', '');
  assert.equal(rows.length, 2);
  assert.equal(rows[1]?.current, undefined);
});

test('suites and records survive bundle validation, collision import and divergent conflict recovery', () => {
  const data = workspace();
  const exported = exportWorkspace(data);
  assert.ok(exported.success);
  assert.ok(parseWorkspaceBundle(exported.value).success);
  const imported = mergeWorkspaces(data, data);
  assert.ok(parseWorkspaceData(imported).success);
  assert.equal(imported.runs.length, 6);
  assert.notEqual(imported.drafts[0]?.suite?.id, imported.drafts[1]?.suite?.id);
  assert.equal(imported.runs[3]?.regression?.suiteId, imported.drafts[1]?.suite?.id);
  assert.equal(new Set(imported.runs.map((record) => record.regression?.id)).size, 2);
  assert.deepEqual(mergeWorkspaces(data, data, true), data);
  const diverged = {
    ...data,
    drafts: data.drafts.map((draft) => ({
      ...draft,
      configuration: { ...draft.configuration, label: '다른 초안' },
    })),
  };
  const recovered = mergeWorkspaces(data, diverged, true);
  assert.ok(parseWorkspaceData(recovered).success);
  assert.equal(recovered.runs.length, 6);
});

test('malformed manifests, duplicate slots, mixed source and invalid raw paths are rejected atomically', () => {
  const data = workspace();
  for (const change of [{ caseIndex: 99 }, { suiteRevision: 0 }, { cases: [] }, { extra: true }]) {
    const copy = structuredClone(data);
    Object.assign(copy.runs[0]?.regression ?? {}, change);
    assert.equal(parseWorkspaceData(copy).success, false);
  }
  const duplicate = structuredClone(data);
  const first = duplicate.runs[0];
  assert.ok(first);
  assert.equal(
    parseWorkspaceData({
      ...duplicate,
      runs: [...duplicate.runs, { ...first, id: 'duplicate_slot' }],
    }).success,
    false,
  );
  const raw = structuredClone(data);
  Object.assign(raw.drafts[0]?.suite?.cases[0]?.raw ?? {}, { '/definitions/0/label': '{' });
  assert.equal(parseWorkspaceData(raw).success, false);
  const old = {
    ...data,
    drafts: data.drafts.map(({ suite: _suite, ...draft }) => draft),
    runs: data.runs.map(({ regression: _regression, ...record }) => record),
  };
  assert.ok(parseWorkspaceData(old).success);
});

test('case capacity, all-disabled cases and common service changes are explicit readiness errors', () => {
  const draft = createSuiteDraft();
  const suite = draft.suite;
  const first = suite?.cases[0];
  assert.ok(suite && first);
  const maximum = {
    ...draft,
    suite: {
      ...suite,
      cases: Array.from({ length: 20 }, (_, index) => ({ ...first, id: `case_${index}` })),
    },
  };
  assert.equal(prepareRegression(maximum, 20).success, true);
  assert.equal(
    prepareRegression(
      {
        ...maximum,
        suite: { ...suite, cases: [...maximum.suite.cases, { ...first, id: 'case_overflow' }] },
      },
      100,
    ).success,
    false,
  );
  assert.equal(
    prepareRegression(
      {
        ...draft,
        suite: { ...suite, cases: suite.cases.map((item) => ({ ...item, enabled: false })) },
      },
      100,
    ).success,
    false,
  );
  assert.equal(prepareRegression({ ...draft, suite: { ...suite, label: '' } }, 100).success, false);
  assert.equal(
    prepareRegression(
      {
        ...draft,
        suite: {
          ...suite,
          cases: [
            {
              ...first,
              environment: {
                schemaVersion: 1,
                id: 'stream',
                kind: 'stream',
                directions: {
                  AtoB: { delayMs: 0, chunkBytes: 8 },
                  BtoA: { delayMs: 0, chunkBytes: 8 },
                },
                connections: [],
              },
            },
          ],
        },
      },
      100,
    ).success,
    false,
  );
});

test('renderable invalid and pending case data round-trip while a mixed-source group is rejected', () => {
  const data = workspace();
  const draft = data.drafts[0];
  const suite = draft?.suite;
  const first = suite?.cases[0];
  assert.ok(draft && suite && first);
  const invalid = {
    ...first,
    enabled: false,
    seed: -1,
    raw: { '/scenario/inputs/0/message/values/payload': '{' },
  };
  const pending = { ...data, drafts: [{ ...draft, suite: { ...suite, cases: [invalid] } }] };
  assert.ok(parseWorkspaceData(pending).success);
  const exported = exportWorkspace(pending);
  assert.ok(exported.success);
  const restored = parseWorkspaceBundle(exported.value);
  assert.ok(restored.success);
  assert.equal(
    restored.value.data.drafts[0]?.suite?.cases[0]?.raw[
      '/scenario/inputs/0/message/values/payload'
    ],
    '{',
  );
  const mixed = structuredClone(data);
  const second = mixed.runs[1];
  assert.ok(second);
  Object.assign(second.view.snapshot.configuration, { label: 'different source' });
  assert.equal(parseWorkspaceData(mixed).success, false);
});

test('different cases, different workspaces and absent manifests cannot be classified as regressions', () => {
  const records = run(createSuiteDraft());
  const first = records[0];
  const second = records[1];
  assert.ok(first && second);
  assert.equal(regressionChange(first, second), '비교 대상 없음');
  assert.equal(regressionChange({ ...first, experimentId: 'other' }, first), '다른 묶음');
  const { regression: _regression, ...ordinary } = first;
  assert.equal(regressionChange(ordinary, ordinary), '비교 대상 없음');
  const missing = compareRegressionRuns(records.slice(0, 1), first.regression?.id ?? '', '');
  assert.equal(missing[1]?.currentIncluded, true);
  assert.equal(missing[1]?.current, undefined);
});
