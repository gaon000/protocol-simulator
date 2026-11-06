import assert from 'node:assert/strict';
import test from 'node:test';
import { createStackSimulation } from '../../src/application/create-stack-simulation.ts';
import {
  compileStackBreakpoints,
  matchStackBreakpoints,
  runStackWithBreakpoints,
  type StackBreakpoint,
} from '../../src/application/stack-breakpoints.ts';
import { compareStackRuns } from '../../src/application/stack-comparison.ts';
import { buildStackCoverage, compareStackCaseRuns } from '../../src/application/stack-coverage.ts';
import { explainStackExecution } from '../../src/application/stack-explanation.ts';
import { projectStackRecord } from '../../src/application/stack-replay.ts';
import { semanticStackEvent } from '../../src/application/stack-semantic-event.ts';
import {
  createStackSeriesSession,
  prepareStackSeries,
} from '../../src/application/stack-series.ts';
import { createWorkspace } from '../../src/application/workspace-operations.ts';
import {
  captureStackRun,
  createWorkspaceV2,
  exportWorkspaceV2,
  mergeWorkspacesV2,
  stageWorkspaceV2Bundle,
} from '../../src/application/workspace-v2-operations.ts';
import type { ValidationResult } from '../../src/domain/protocol-model.ts';
import { serializeBytes } from '../../src/domain/stack-bytes.ts';
import type { StackExperiment, StackTrace } from '../../src/domain/stack-model.ts';
import {
  parseStackView,
  stackObject,
  stackProtocolAt,
  stackRangeBytes,
} from '../../src/domain/stack-record.ts';
import { stackCommonSource } from '../../src/domain/stack-series-model.ts';
import { parseStackExperiment } from '../../src/domain/stack-validation.ts';
import type { SavedStackRun } from '../../src/domain/workspace-v2-model.ts';
import {
  parseWorkspaceV2,
  parseWorkspaceV2Bundle,
} from '../../src/domain/workspace-v2-validation.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';
import { createReliableStackExample } from '../../src/examples/reliable-stack-examples.ts';
import { stackExperimentFixture } from '../fixtures/stack-models.ts';
import { changeStackTransport, mergedStackFixture } from '../fixtures/stack-runtime.ts';

function ok<T>(result: ValidationResult<T>): T {
  if (!result.success) assert.fail(JSON.stringify(result.diagnostics.slice(0, 3)));
  return result.value;
}
function record(configuration = createReliableStackExample()) {
  return captureStackRun(ok(createStackSimulation(configuration)).run(), 'draft', 1);
}
function workspace(configuration = createReliableStackExample()) {
  return createWorkspaceV2(createWorkspace(createPingPongExperiment()), configuration);
}
const end = (r: SavedStackRun) => r.view.events.length + 1;
function suiteRun(configuration: StackExperiment): SavedStackRun {
  const data = workspace(configuration);
  const draft = data.stack.drafts[0];
  assert.ok(draft);
  const item = {
    ...draft,
    suite: {
      id: 'suite',
      label: '회귀',
      revision: 1,
      cases: [
        {
          id: 'one',
          label: '하나',
          enabled: true,
          seed: configuration.seed,
          scenario: configuration.scenario,
          environment: configuration.link.environment,
        },
      ],
    },
  };
  const plan = ok(prepareStackSeries(item, data, { kind: 'regression', label: '검사' }));
  const session = createStackSeriesSession(plan);
  for (let i = 0; i < 1000; i++) {
    const next = session.advance();
    if (next) return next;
  }
  throw new Error('Fixture did not finish');
}

test('actual 10k-event stack records remain readable with dense native variables and bounded comparisons', () => {
  const input = changeStackTransport(stackExperimentFixture(), (protocol) => ({
    ...protocol,
    variables: Array.from({ length: 100 }, (_, i) => ({
      id: `counter_${i}`,
      type: 'integer' as const,
      initial: 0,
    })),
    timers: [{ id: 'busy' }],
    rules: [
      {
        id: 'begin',
        fromStateId: 'Ready',
        nextStateId: 'Ready',
        event: { kind: 'service-request', portId: 'upper', operation: 'write' },
        actions: [
          { kind: 'start-timer', timerId: 'busy', durationMs: { kind: 'literal', value: 0 } },
        ],
      },
      {
        id: 'repeat',
        fromStateId: 'Ready',
        nextStateId: 'Ready',
        event: { kind: 'timer', timerId: 'busy' },
        actions: [
          { kind: 'start-timer', timerId: 'busy', durationMs: { kind: 'literal', value: 0 } },
        ],
      },
    ],
  }));
  const saved = record(input);
  assert.equal(saved.view.status, 'limit-reached');
  assert.ok(saved.view.events.length > 9900);
  ok(parseStackView(saved.view));
  const compared = compareStackRuns(saved, saved);
  assert.equal(compared.status, 'limited');
  assert.ok(compared.rows.length <= 20);
  assert.equal(ok(projectStackRecord(saved, 300)).events.length, 300);
});

test('a dense actual byte-variable artifact pool remains readable within unchanged physical and serialized limits', () => {
  const base = changeStackTransport(stackExperimentFixture(), (protocol) => ({
    ...protocol,
    variables: Array.from({ length: 100 }, (_, index) => ({
      id: `bytes_${index}`,
      type: 'bytes' as const,
      initial: serializeBytes(Uint8Array.of(index)),
    })),
    timers: [{ id: 'busy' }],
    rules: [
      {
        id: 'begin',
        fromStateId: 'Ready',
        nextStateId: 'Ready',
        event: { kind: 'service-request', portId: 'upper', operation: 'write' },
        actions: [
          { kind: 'start-timer', timerId: 'busy', durationMs: { kind: 'literal', value: 0 } },
        ],
      },
      {
        id: 'repeat',
        fromStateId: 'Ready',
        nextStateId: 'Ready',
        event: { kind: 'timer', timerId: 'busy' },
        actions: [
          ...Array.from({ length: 100 }, (_, index) => ({
            kind: 'assign' as const,
            variableId: `bytes_${index}`,
            value: {
              kind: 'concat' as const,
              values: [
                { kind: 'variable' as const, variableId: `bytes_${index}` },
                { kind: 'literal' as const, value: serializeBytes(Uint8Array.of(1)) },
              ],
            },
          })),
          { kind: 'start-timer', timerId: 'busy', durationMs: { kind: 'literal', value: 0 } },
        ],
      },
    ],
  }));
  const saved = record({ ...base, limits: { ...base.limits, maxEvents: 160 } });
  assert.equal(saved.view.status, 'limit-reached');
  assert.ok(saved.view.artifacts.payloads.length > 12500);
  assert.ok(saved.view.usage.uniqueBytes < base.limits.maxPayloadBytes);
  assert.ok(saved.view.usage.artifactBytes < base.limits.maxArtifactBytes);
  ok(parseStackView(saved.view));
});

test('unfinished native/legacy references and raw editor text survive v2 export but cannot execute', () => {
  const base = workspace();
  const draft = base.stack.drafts[0];
  assert.ok(draft);
  const configuration = {
    ...draft.configuration,
    bindings: [],
    definitions: draft.configuration.definitions.map((p) =>
      p.mode === 'stack-protocol'
        ? { ...p, initialStateId: 'missing' }
        : { ...p, source: { ...p.source, initialStateId: 'missing' } },
    ),
  };
  const changed = {
    ...base,
    stack: { ...base.stack, drafts: [{ ...draft, configuration, raw: { '/seed': '{' } }] },
  };
  ok(parseWorkspaceV2(changed));
  assert.deepEqual(ok(parseWorkspaceV2Bundle(ok(exportWorkspaceV2(changed)))).data, changed);
  assert.equal(createStackSimulation(configuration).success, false);
  assert.equal(
    prepareStackSeries(changed.stack.drafts[0] as typeof draft, changed, {
      kind: 'batch',
      label: 'bad',
      seeds: [1],
    }).success,
    false,
  );
  const stale = {
    ...base,
    stack: { ...base.stack, drafts: [{ ...draft, raw: { '/seed': '12345' } }] },
  };
  assert.equal(parseWorkspaceV2(stale).success, false);
  assert.equal(
    prepareStackSeries(stale.stack.drafts[0] as typeof draft, stale, {
      kind: 'batch',
      label: 'stale',
      seeds: [1],
    }).success,
    false,
  );
});

test('record continuity, missing commits, false routes and future byte origins are rejected during staging', () => {
  const original = record();
  const edit = (change: (events: StackTrace[]) => void) => {
    const events = structuredClone(original.view.events) as StackTrace[];
    change(events);
    return parseStackView({ ...original.view, events });
  };
  assert.equal(
    edit((events) => {
      const event = events.find(
        (e) => e.kind === 'transition' && e.endpoint.instanceId === 'transport',
      );
      assert.ok(event);
      stackObject(stackObject(event.data).before).stateId = 'Waiting';
    }).success,
    false,
  );
  assert.equal(
    edit((events) => {
      const event = events.find((e) => e.kind === 'service-request');
      assert.ok(event);
      stackObject(event.data).target = { participant: 'A', instanceId: 'absent', portId: 'lower' };
    }).success,
    false,
  );
  assert.equal(
    edit((events) => {
      const event = events.find(
        (e) =>
          e.kind === 'parsed' &&
          Array.isArray(stackObject(e.data).sourceRanges) &&
          (stackObject(e.data).sourceRanges as unknown[]).length,
      );
      assert.ok(event);
      const row = (stackObject(event.data).sourceRanges as Record<string, unknown>[])[0];
      assert.ok(row);
      row.sourceEventId = 'future';
    }).success,
    false,
  );
  const target = original.view.instances['A/transport'];
  assert.ok(target);
  assert.equal(
    parseStackView({
      ...original.view,
      instances: {
        ...original.view.instances,
        'A/transport': { ...target, variables: { ...target.variables, txSeq: 123 } },
      },
    }).success,
    false,
  );
});

test('native failure lifecycle and timer generations appear only at their recorded cursor', () => {
  const source = createReliableStackExample();
  const saved = record({
    ...source,
    link: {
      ...source.link,
      environment: {
        ...source.link.environment,
        directions: {
          ...source.link.environment.directions,
          AtoB: { delayMs: 10, jitterMs: 0, lossRate: 1, duplicateRate: 0 },
        },
      },
    },
  });
  const index = saved.view.events.findIndex(
    (e) => e.kind === 'connection' && e.endpoint.instanceId === 'app',
  );
  assert.ok(index > 0);
  assert.equal(ok(projectStackRecord(saved, index)).instances['A/app']?.ports.requires, 'ready');
  assert.equal(
    ok(projectStackRecord(saved, index + 1)).instances['A/app']?.ports.requires,
    'failed',
  );
  const timer = saved.view.events.findIndex(
    (e) =>
      e.kind === 'timer' &&
      stackObject(e.data).operation === 'start' &&
      e.endpoint.instanceId === 'transport',
  );
  assert.ok(timer > 0);
  assert.equal(
    ok(projectStackRecord(saved, timer + 1)).instances['A/transport']?.timers[0]?.active,
    true,
  );
});

test('explanations retain short-circuited branches and compare sequential assignments to the observed commit', () => {
  const saved = record();
  const event = saved.view.events.find(
    (e) => e.kind === 'transition' && stackObject(e.data).ruleId === 'ack_continue_short',
  );
  assert.ok(event);
  const explanation = explainStackExecution(saved, event.eventId, end(saved));
  assert.equal(explanation.status, 'verified');
  assert.ok(
    explanation.candidates.some((c) =>
      c.conditions.some((condition) => condition.result === 'skipped'),
    ),
  );
  assert.ok(explanation.assignments.length > 1);
});

test('coalesced reads preserve live debugger atomicity and history matches only the supplied observed event', () => {
  const engine = ok(createStackSimulation(mergedStackFixture()));
  const protocol = stackProtocolAt(engine.snapshot, { participant: 'B', instanceId: 'app' });
  const point: StackBreakpoint = {
    id: 'parsed',
    label: '해석',
    enabled: true,
    endpoint: { participant: 'B', instanceId: 'app' },
    protocolId: protocol.id,
    protocolRevision: protocol.revision,
    kind: 'message',
    targetId: 'ping',
    operator: 'eq',
    literal: 'null',
  };
  const plan = ok(compileStackBreakpoints(engine.snapshot, { enabled: true, points: [point] }));
  let stop: ReturnType<typeof runStackWithBreakpoints>['stop'];
  while (!engine.terminal && !stop) stop = runStackWithBreakpoints(engine, plan, 64).stop;
  assert.ok(stop);
  assert.equal(stop.event.kind, 'parsed');
  assert.ok(stop.trailingEvents > 0);
  const same = matchStackBreakpoints(plan, [stop.event], engine.readArtifacts());
  assert.equal(same?.trailingEvents, 0);
  assert.ok(engine.run().expectations.every((e) => e.status === 'pass'));
});

test('oversized debugger values pause only the debugger and disabling points restores unchanged engine results', () => {
  const engine = ok(createStackSimulation(createReliableStackExample()));
  const saved = captureStackRun(engine.run(), 'draft', 1);
  const protocol = stackProtocolAt(engine.snapshot, { participant: 'A', instanceId: 'transport' });
  const point: StackBreakpoint = {
    id: 'bytes',
    label: 'bytes',
    enabled: true,
    endpoint: { participant: 'A', instanceId: 'transport' },
    protocolId: protocol.id,
    protocolRevision: protocol.revision,
    kind: 'variable',
    targetId: 'pending',
    operator: 'eq',
    literal: JSON.stringify(serializeBytes(new Uint8Array())),
  };
  const plan = ok(compileStackBreakpoints(engine.snapshot, { enabled: true, points: [point] }));
  const event = saved.view.events.find(
    (e) =>
      e.kind === 'transition' &&
      e.endpoint.participant === 'A' &&
      e.endpoint.instanceId === 'transport',
  );
  assert.ok(event);
  const oversized = {
    ...event,
    data: {
      ...stackObject(event.data),
      after: {
        ...stackObject(stackObject(event.data).after),
        variables: {
          ...stackObject(stackObject(stackObject(event.data).after).variables),
          pending: { kind: 'payload-range', payloadId: 'large', offset: 0, length: 10000 },
        },
      },
    },
  } as StackTrace;
  const artifacts = {
    ...saved.view.artifacts,
    payloads: [
      ...saved.view.artifacts.payloads,
      { payloadId: 'large', bytes: serializeBytes(new Uint8Array(10000)) },
    ],
  };
  const error = matchStackBreakpoints(
    plan,
    [
      {
        ...oversized,
        payloads: [...oversized.payloads, { payloadId: 'large', offset: 0, length: 10000 }],
      },
    ],
    artifacts,
  );
  assert.equal(error?.kind, 'evaluation-error');
  const disabled = ok(
    compileStackBreakpoints(engine.snapshot, { enabled: false, points: [point] }),
  );
  assert.equal(disabled.points.length, 0);
  assert.equal(saved.view.status, 'completed');
});

test('arbitrary user JSON identity-shaped keys remain comparable data instead of becoming missing payload IDs', () => {
  const source = createReliableStackExample();
  const configuration = {
    ...source,
    definitions: source.definitions.map((p) =>
      p.mode === 'legacy-application'
        ? {
            ...p,
            source: {
              ...p.source,
              variables: [
                ...p.source.variables,
                {
                  id: 'metadata',
                  type: 'json' as const,
                  initial: {
                    payloadId: 'real-content',
                    sourceEventId: 'real-value',
                    kind: 'payload-range',
                  },
                },
              ],
            },
          }
        : p,
    ),
  };
  const saved = record(configuration);
  const event = saved.view.events.find(
    (e) => e.kind === 'transition' && e.endpoint.instanceId === 'app',
  );
  assert.ok(event);
  const normalized = semanticStackEvent(
    saved.view,
    event,
    new Map(saved.view.events.map((e, i) => [e.eventId, i])),
    { bytes: 100000, events: 10 },
  );
  assert.equal(
    stackObject(stackObject(stackObject(stackObject(normalized).data).after).variables).metadata &&
      stackObject(
        stackObject(stackObject(stackObject(stackObject(normalized).data).after).variables)
          .metadata,
      ).payloadId,
    'real-content',
  );
});

test('equal repeated bytes from different observed source positions remain different comparison evidence', () => {
  const original = createReliableStackExample();
  const configuration: StackExperiment = {
    ...original,
    definitions: original.definitions.map((p) =>
      p.mode === 'stack-protocol'
        ? {
            ...p,
            variables: p.variables.map((v) => (v.id === 'chunkBytes' ? { ...v, initial: 2 } : v)),
          }
        : {
            ...p,
            source: {
              ...p.source,
              rules: p.source.rules.map((rule) =>
                rule.id !== 'start'
                  ? rule
                  : {
                      ...rule,
                      actions: rule.actions.map((action) =>
                        action.kind !== 'send'
                          ? action
                          : {
                              ...action,
                              values: {
                                ...action.values,
                                text: { kind: 'field', fieldId: 'text' },
                              },
                            },
                      ),
                    },
              ),
            },
          },
    ),
    scenario: {
      ...original.scenario,
      observationMs: 5000,
      inputs: original.scenario.inputs.map((input) => ({
        ...input,
        message: { ...input.message, values: { ...input.message.values, text: 'a'.repeat(8) } },
      })),
    },
  };
  const saved = record(configuration);
  const changed = structuredClone(saved);
  let edited = false;
  for (const event of changed.view.events) {
    if (event.kind !== 'transition') continue;
    const rows = stackObject(stackObject(event.data).byteSources).cached;
    if (!Array.isArray(rows)) continue;
    for (const value of rows) {
      const range = stackObject(value);
      if (Number(range.length) !== 2) continue;
      const bytes = stackRangeBytes(
        changed.view.artifacts,
        range as unknown as import('../../src/domain/stack-model.ts').PayloadRange,
      );
      if (!bytes.every((byte) => byte === 97)) continue;
      const shifted = { ...range, offset: Number(range.offset) + 1 };
      const shiftedBytes = stackRangeBytes(
        changed.view.artifacts,
        shifted as unknown as import('../../src/domain/stack-model.ts').PayloadRange,
      );
      if (!shiftedBytes.every((byte) => byte === 97)) continue;
      range.offset = Number(range.offset) + 1;
      edited = true;
      break;
    }
    if (edited) break;
  }
  assert.ok(edited);
  ok(parseStackView(changed.view));
  assert.equal(compareStackRuns(saved, changed).status, 'different');
});

test('paired environments share the exact seed list and independent snapshots before execution', () => {
  const data = workspace();
  const draft = data.stack.drafts[0];
  assert.ok(draft);
  const normal = draft.configuration.link.environment;
  const plan = ok(
    prepareStackSeries(draft, data, {
      kind: 'batch',
      label: '대조',
      seeds: [1, 7],
      environments: [
        { id: 'normal', label: '정상', environment: normal },
        {
          id: 'loss',
          label: '손실',
          environment: {
            ...normal,
            directions: {
              ...normal.directions,
              AtoB: { delayMs: 10, jitterMs: 0, lossRate: 1, duplicateRate: 0 },
            },
          },
        },
      ],
    }),
  );
  assert.deepEqual(
    plan.cases.map((c) => c.configuration.seed),
    [1, 7, 1, 7],
  );
  assert.ok(
    plan.cases.every(
      (c) =>
        JSON.stringify(stackCommonSource(c.configuration)) ===
        JSON.stringify(stackCommonSource(draft.configuration)),
    ),
  );
  const session = createStackSeriesSession(plan);
  const runs: SavedStackRun[] = [];
  for (let i = 0; i < 1000 && !session.progress().done; i++) {
    const next = session.advance();
    if (next) runs.push(next);
  }
  assert.equal(runs.length, 4);
  assert.ok(runs.slice(0, 2).every((r) => r.view.expectations.every((e) => e.status === 'pass')));
  assert.ok(runs.slice(2).every((r) => r.view.expectations.some((e) => e.status === 'fail')));
});

test('regression changes require the same case contract and coverage excludes contradictory or unknown records', () => {
  const configuration = createReliableStackExample('first-ack-loss');
  const before = suiteRun(configuration);
  const failedConfiguration = {
    ...configuration,
    definitions: configuration.definitions.map((p) =>
      p.mode === 'stack-protocol'
        ? {
            ...p,
            variables: p.variables.map((v) => (v.id === 'maxRetries' ? { ...v, initial: 0 } : v)),
          }
        : p,
    ),
  };
  const after = suiteRun(failedConfiguration);
  assert.equal(compareStackCaseRuns(before, after), 'new-failure');
  assert.equal(compareStackCaseRuns(after, before), 'improved');
  const wrong = {
    ...after,
    view: { ...after.view, snapshot: { ...after.view.snapshot, engineVersion: 'future' } },
  };
  assert.equal(compareStackCaseRuns(before, wrong), 'incomparable');
  const series = before.series;
  assert.ok(series);
  const otherOwner = {
    ...before,
    id: 'other',
    experimentId: 'other',
    series: { ...series, index: 1, manifest: [...series.manifest, { id: 'two', label: '둘' }] },
  };
  const coverage = buildStackCoverage([before, otherOwner], series.id);
  assert.equal(coverage.excluded.length, 1);
  const contradictory = { ...before, view: { ...before.view, instances: {} } };
  assert.equal(buildStackCoverage([contradictory], series.id).status, 'unavailable');
});

test('combined mode capacity and unknown bundle versions are rejected without evicting existing records', () => {
  const data = workspace();
  const draft = data.stack.drafts[0];
  assert.ok(draft);
  const crowded = {
    ...data,
    stack: {
      ...data.stack,
      drafts: Array.from({ length: 100 }, (_, i) => ({ ...draft, id: `draft_${i}` })),
      activeDraftId: 'draft_0',
    },
  };
  assert.equal(parseWorkspaceV2(crowded).success, false);
  assert.equal(
    parseWorkspaceV2Bundle(
      JSON.stringify({ schemaVersion: 99, kind: 'protocol-studio-bundle', data }),
    ).success,
    false,
  );
  assert.equal(parseStackExperiment({ ...draft.configuration, bindings: [] }).success, false);
});

test('orphan record retries reuse identical records and imported regression copies remap suite/group ownership together', () => {
  const saved = suiteRun(createReliableStackExample());
  const data = workspace();
  const orphan = { ...data, stack: { activeDraftId: null, drafts: [], runs: [saved] } };
  const retried = mergeWorkspacesV2(orphan, orphan, true);
  assert.equal(retried.stack.runs.length, 1);
  const imported = ok(stageWorkspaceV2Bundle(ok(exportWorkspaceV2(orphan)), orphan));
  assert.equal(imported.stack.runs.length, 2);
  assert.notEqual(imported.stack.runs[0]?.experimentId, imported.stack.runs[1]?.experimentId);
  assert.notEqual(imported.stack.runs[0]?.series?.id, imported.stack.runs[1]?.series?.id);
  assert.notEqual(
    imported.stack.runs[0]?.series?.suite?.id,
    imported.stack.runs[1]?.series?.suite?.id,
  );
  assert.deepEqual(imported.stack.runs[0]?.view, imported.stack.runs[1]?.view);
});
