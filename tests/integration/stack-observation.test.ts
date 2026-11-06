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
import { diagnoseStackExpectation } from '../../src/application/stack-diagnostics.ts';
import {
  buildStackMessageStructure,
  buildStackSequence,
  buildStackStateDiagram,
  stackEventLinks,
  stackRuleOccurrences,
} from '../../src/application/stack-diagrams.ts';
import { explainStackExecution } from '../../src/application/stack-explanation.ts';
import {
  createStackSeriesSession,
  prepareStackSeries,
  summarizeStackSeries,
} from '../../src/application/stack-series.ts';
import { createWorkspace } from '../../src/application/workspace-operations.ts';
import {
  captureStackRun,
  createWorkspaceV2,
} from '../../src/application/workspace-v2-operations.ts';
import type { ValidationResult } from '../../src/domain/protocol-model.ts';
import { stackObject, stackProtocolAt, stackRangeBytes } from '../../src/domain/stack-record.ts';
import type { SavedStackRun } from '../../src/domain/workspace-v2-model.ts';
import { parseWorkspaceV2 } from '../../src/domain/workspace-v2-validation.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';
import { STACK_EXAMPLES } from '../../src/examples/reliable-stack-examples.ts';

function ok<T>(r: ValidationResult<T>): T {
  if (!r.success) assert.fail(JSON.stringify(r.diagnostics.slice(0, 3)));
  return r.value;
}
const example = (id = 'stack_first_ack_loss') => {
  const entry = STACK_EXAMPLES.find((e) => e.id === id);
  assert.ok(entry);
  return entry.build();
};
function recorded(id?: string) {
  const engine = ok(createStackSimulation(example(id)));
  return captureStackRun(engine.run(), 'draft', 1);
}
const final = (r: SavedStackRun) => r.view.events.length + 1;

for (const id of ['stack_ping_pong', 'stack_first_ack_loss', 'stack_http_post', 'stack_http_split'])
  test(`${id} explains actual endpoint rules and sequential variable changes`, () => {
    const record = recorded(id);
    const selected = new Map<string, string>();
    for (const event of record.view.events)
      if (event.kind === 'transition')
        selected.set(
          `${event.endpoint.participant}/${event.endpoint.instanceId}/${stackObject(event.data).ruleId}`,
          event.eventId,
        );
    for (const eventId of [...selected.values()].slice(0, 32)) {
      const result = explainStackExecution(record, eventId, final(record));
      assert.equal(result.status, 'verified', `${eventId} ${result.message}`);
      assert.equal(result.candidates.filter((c) => c.selected && c.result).length, 1);
    }
    const event = record.view.events.find((e) => e.kind === 'transition');
    assert.ok(event);
    assert.equal(
      explainStackExecution(record, event.eventId, record.view.events.indexOf(event)).status,
      'unavailable',
    );
  });

test('state graphs and sequence pages retain four endpoint lanes, exact cursors and prefix isolation', () => {
  const record = recorded();
  const cursor =
    record.view.events.findIndex(
      (e) => e.kind === 'parsed' && e.endpoint.instanceId === 'transport',
    ) + 1;
  const sequence = ok(buildStackSequence(record, cursor));
  assert.ok(sequence.rows.length <= 30);
  assert.ok(sequence.rows.every((row) => row.cursor <= cursor));
  const graph = ok(
    buildStackStateDiagram(record, { participant: 'A', instanceId: 'transport' }, cursor),
  );
  assert.equal(graph.protocol.mode, 'stack-protocol');
  assert.ok(graph.diagram.nodes.some((n) => n.id === 'Waiting'));
  assert.equal(
    buildStackStateDiagram(record, { participant: 'A', instanceId: 'absent' }, cursor).success,
    false,
  );
  const transport = ok(buildStackSequence(record, final(record), { layer: 'transport' }));
  assert.equal(
    buildStackSequence(record, cursor, { endpoint: { participant: 'A', instanceId: 'absent' } })
      .success,
    false,
  );
  assert.equal(
    stackRuleOccurrences(record, { participant: 'A', instanceId: 'transport' }, 'absent', cursor)
      .success,
    false,
  );
  assert.ok(transport.rows.every((row) => row.event.endpoint.instanceId === 'transport'));
  const rules = ok(
    stackRuleOccurrences(
      record,
      { participant: 'A', instanceId: 'transport' },
      'retry_DATA',
      final(record),
    ),
  );
  assert.equal(rules.total, 1);
  assert.ok(rules.rows[0]?.triggerId);
});

test('causal navigation follows actual service/codec links and refuses events outside the cursor', () => {
  const record = recorded();
  const sent = record.view.events.find((e) => e.kind === 'send' && e.endpoint.instanceId === 'app');
  assert.ok(sent);
  const links = ok(stackEventLinks(record, sent.eventId, final(record)));
  assert.ok(links.directChildren.some((r) => r.event.kind === 'service-request'));
  assert.ok(links.commits.some((r) => r.event.endpoint.instanceId === 'transport'));
  assert.equal(stackEventLinks(record, record.view.events.at(-1)?.eventId ?? '', 1).success, false);
  const large = recorded('stack_http_split');
  const root = large.view.events[0];
  assert.ok(root);
  const bounded = ok(stackEventLinks(large, root.eventId, final(large)));
  assert.equal(bounded.limited, true);
  assert.ok(bounded.commits.length <= 20);
  assert.ok(bounded.directCauses.length <= 20);
});

test('message inspection uses actual HTTP bytes, logical DATA payloads and explicit chunk boundaries', () => {
  const record = recorded('stack_http_post');
  const send = record.view.events.find((e) => e.kind === 'send' && e.endpoint.instanceId === 'app');
  assert.ok(send);
  const structure = ok(buildStackMessageStructure(record, send.eventId, final(record)));
  assert.ok(structure.layout);
  assert.equal(structure.codec, 'http-1.1');
  assert.ok(structure.layout.regions.length > 1);
  assert.ok(structure.bytePage);
  assert.ok(structure.selected);
  assert.ok(stackRangeBytes(record.view.artifacts, structure.selected, send.payloads).length > 0);
  const packet = record.view.events.find(
    (e) => e.kind === 'send' && e.endpoint.instanceId === 'transport',
  );
  assert.ok(packet);
  assert.equal(
    ok(buildStackMessageStructure(record, packet.eventId, final(record))).status,
    'logical',
  );
  const receive = record.view.events.find(
    (e) => e.kind === 'receive' && e.endpoint.instanceId === 'app',
  );
  assert.ok(receive);
  assert.equal(
    ok(buildStackMessageStructure(record, receive.eventId, final(record))).status,
    'chunk',
  );
  assert.equal(buildStackMessageStructure(record, send.eventId, 0).success, false);
  assert.throws(() =>
    stackRangeBytes(
      record.view.artifacts,
      { payloadId: structure.selected?.payloadId ?? '', offset: 0, length: 999999 },
      send.payloads,
    ),
  );
});

test('diagnosis preserves partial verdicts and keeps failure references separate from direct evidence', () => {
  const configuration = example();
  const engine = ok(
    createStackSimulation({
      ...configuration,
      link: {
        ...configuration.link,
        environment: {
          ...configuration.link.environment,
          directions: {
            ...configuration.link.environment.directions,
            AtoB: { delayMs: 10, jitterMs: 0, lossRate: 1, duplicateRate: 0 },
          },
        },
      },
    }),
  );
  const record = captureStackRun(engine.run(), 'draft', 1);
  const failed = record.view.expectations.find((e) => e.status === 'fail');
  assert.ok(failed);
  const result = ok(diagnoseStackExpectation(record, failed.expectationId, final(record)));
  assert.equal(result.status, 'fail');
  assert.equal(result.satisfiedSoFar, false);
  assert.ok(result.evidence.every((e) => e.cursor <= record.view.events.length));
  const prefix = ok(diagnoseStackExpectation(record, failed.expectationId, 2));
  assert.equal(prefix.status, 'undetermined');
  assert.equal(diagnoseStackExpectation(record, 'absent', final(record)).success, false);
});

test('endpoint breakpoints stop at actual commits, continue without repeating an event and preserve the final trace', () => {
  const configuration = example();
  const baseline = ok(createStackSimulation(configuration)).run();
  const engine = ok(createStackSimulation(configuration));
  const protocol = stackProtocolAt(engine.snapshot, { participant: 'A', instanceId: 'transport' });
  const point: StackBreakpoint = {
    id: 'retry',
    label: '첫 재전송',
    enabled: true,
    endpoint: { participant: 'A', instanceId: 'transport' },
    protocolId: protocol.id,
    protocolRevision: protocol.revision,
    kind: 'variable',
    targetId: 'retransmissions',
    operator: 'gte',
    literal: '1',
  };
  const plan = ok(compileStackBreakpoints(engine.snapshot, { enabled: true, points: [point] }));
  let stop: ReturnType<typeof runStackWithBreakpoints>['stop'];
  while (!engine.terminal && !stop) stop = runStackWithBreakpoints(engine, plan, 100).stop;
  assert.ok(stop);
  assert.equal(stop.event.kind, 'transition');
  const first = stop.event.eventId;
  const next = runStackWithBreakpoints(engine, plan, 100).stop;
  if (next) assert.notEqual(next.event.eventId, first);
  const result = engine.run();
  const strip = (view: typeof result) => view.events.map(({ runId: _runId, ...event }) => event);
  assert.deepEqual(strip(result), strip(baseline));
  assert.deepEqual(result.instances, baseline.instances);
  assert.equal(
    compileStackBreakpoints(engine.snapshot, {
      enabled: true,
      points: [{ ...point, endpoint: { participant: 'A', instanceId: 'absent' } }],
    }).success,
    false,
  );
  assert.equal(
    compileStackBreakpoints(engine.snapshot, {
      enabled: true,
      points: Array.from({ length: 21 }, (_, i) => ({ ...point, id: String(i), enabled: false })),
    }).success,
    false,
  );
  const wrongEndpoint = ok(
    compileStackBreakpoints(engine.snapshot, {
      enabled: true,
      points: [
        {
          ...point,
          endpoint: { participant: 'B', instanceId: 'transport' },
          protocolId: 'reliable_stream_lite_B',
        },
      ],
    }),
  );
  assert.equal(matchStackBreakpoints(wrongEndpoint, [stop.event], result.artifacts), undefined);
});

test('regression series freezes topology, covers actual endpoint commits, marks missing cases and fences cancellation', () => {
  let workspace = createWorkspaceV2(createWorkspace(createPingPongExperiment()), example());
  const draft = workspace.stack.drafts[0];
  assert.ok(draft);
  const configuration = draft.configuration;
  const suite = {
    id: 'suite',
    label: '회귀',
    revision: 1,
    cases: [0, 1].map((index) => ({
      id: `case_${index}`,
      label: `사례 ${index}`,
      enabled: true,
      seed: 7,
      scenario: configuration.scenario,
      environment: {
        ...configuration.link.environment,
        targetedDrops: index ? [] : configuration.link.environment.targetedDrops,
      },
    })),
  };
  const editable = { ...draft, suite };
  workspace = { ...workspace, stack: { ...workspace.stack, drafts: [editable] } };
  const plan = ok(prepareStackSeries(editable, workspace, { kind: 'regression', label: '검증' }));
  const session = createStackSeriesSession(plan);
  const runs: SavedStackRun[] = [];
  let spins = 0;
  while (!session.progress().done && ++spins < 1000) {
    const run = session.advance();
    if (run) runs.push(run);
  }
  assert.equal(runs.length, 2);
  assert.equal(summarizeStackSeries(runs, 2).passed, 2);
  ok(parseWorkspaceV2({ ...workspace, stack: { ...workspace.stack, runs } }));
  const coverage = buildStackCoverage(runs, plan.id, { endpoint: 'A/transport' });
  assert.equal(buildStackCoverage(runs, plan.id, { endpoint: 'A/absent' }).status, 'unavailable');
  assert.equal(coverage.status, 'available');
  const coverageItems = Array.from(
    { length: coverage.status === 'available' ? coverage.pages : 1 },
    (_, page) => buildStackCoverage(runs, plan.id, { endpoint: 'A/transport', page }).items,
  ).flat();
  assert.ok(coverageItems.some((item) => item.id === 'retry_DATA' && item.count === 1));
  const missing = buildStackCoverage(runs.slice(0, 1), plan.id);
  assert.equal(missing.cases.filter((c) => c.status === 'missing').length, 1);
  assert.ok(coverage.items.every((item) => item.evidence.every((e) => e.cursor >= 0)));
  assert.equal(
    compareStackCaseRuns(runs[0] as SavedStackRun, runs[1] as SavedStackRun),
    'incomparable',
  );
  const cancelled = createStackSeriesSession(plan);
  assert.ok(cancelled.advance());
  assert.equal(cancelled.cancel(), undefined);
  assert.equal(cancelled.advance(), undefined);
  const longDraft = { ...editable, configuration: example('stack_http_split') };
  const longPlan = ok(
    prepareStackSeries(longDraft, workspace, { kind: 'batch', label: '취소', seeds: [1, 2] }),
  );
  const longSession = createStackSeriesSession(longPlan);
  longSession.advance();
  const partial = longSession.cancel();
  assert.ok(partial);
  assert.equal(partial.view.status, 'cancelled');
  assert.equal(longSession.advance(), undefined);
  assert.equal(longSession.cancel(), undefined);
  assert.equal(summarizeStackSeries([partial], 2).undetermined, 1);
  const batch = ok(
    prepareStackSeries(editable, workspace, { kind: 'batch', label: '반복', seeds: [1, 7] }),
  );
  assert.equal(batch.cases.length, 2);
  assert.equal(
    prepareStackSeries(editable, workspace, { kind: 'batch', label: 'bad', seeds: [1, 1] }).success,
    false,
  );
});

test('side-by-side stack comparison ignores run IDs, keeps finite correspondence and refuses changed topology', () => {
  const a = recorded('stack_ping_pong');
  const b = recorded('stack_ping_pong');
  assert.equal(compareStackRuns(a, b).status, 'same');
  const lost = recorded();
  const changed = compareStackRuns(a, lost);
  assert.equal(changed.status, 'different');
  assert.ok(changed.firstDifference);
  assert.ok(changed.rows.length <= 20);
  assert.ok(changed.rows.every((r) => !r.leftCursor || r.leftCursor <= a.view.events.length));
  const future = {
    ...a,
    view: { ...a.view, snapshot: { ...a.view.snapshot, engineVersion: 'future' } },
  };
  assert.equal(compareStackRuns(a, future).status, 'unavailable');
  const partial = captureStackRun(
    ok(createStackSimulation(example('stack_ping_pong'))).runBatch(1),
    'draft',
    1,
  );
  assert.notEqual(compareStackRuns(partial, partial).status, 'same');
});
