import assert from 'node:assert/strict';
import test from 'node:test';
import { editExperiment } from '../../src/application/edit-experiment.ts';
import { projectRecord } from '../../src/application/replay-record.ts';
import { compareRuns } from '../../src/application/run-comparison.ts';
import type { JsonObject } from '../../src/domain/execution-contract.ts';
import type { SavedRun } from '../../src/domain/workspace-model.ts';
import { createExampleCopy, EXAMPLES } from '../../src/examples/catalog.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';
import { runComparisonRecord } from '../fixtures/comparison-runs.ts';
import { runCoverageSuite } from '../fixtures/coverage-suite.ts';
import {
  createEventLimitExperiment,
  createMessageLimitExperiment,
} from '../fixtures/large-experiments.ts';

function pair() {
  const records = runCoverageSuite();
  const normal = records[0];
  const retry = records[1];
  assert.ok(normal && retry);
  return { normal, retry };
}

test('all real catalog reruns compare observations independently of generated run IDs and preserve their sources', () => {
  for (const example of EXAMPLES) {
    const config = createExampleCopy(example.id);
    const left = runComparisonRecord(config, { runId: 'left' });
    const right = runComparisonRecord(config, { runId: 'right' });
    const before = JSON.stringify([left, right]);
    const model = compareRuns(left, right);
    assert.equal(model.traceStatus, 'ready', example.id);
    assert.ok(
      model.events.every((row) => row.relation === 'same'),
      example.id,
    );
    assert.equal(model.firstDifference, undefined);
    assert.equal(JSON.stringify([left, right]), before);
  }
});

test('lost ACK comparison identifies changed environment, retry variables and one-sided observations without shifting the tail', () => {
  const { normal, retry } = pair();
  const model = compareRuns(normal, retry);
  assert.equal(model.traceStatus, 'ready');
  assert.equal(model.values.find((row) => row.id === 'environment')?.relation, 'different');
  const retries = model.values.find((row) => row.id === 'A:variable:retries');
  assert.deepEqual([retries?.left, retries?.right, retries?.relation], [0, 1, 'different']);
  assert.ok(
    model.events.some((row) => row.right?.ruleId === 'retry' && row.relation === 'right-only'),
  );
  assert.equal(
    model.events.find((row) => row.left?.ruleId === 'matching_ack')?.right?.ruleId,
    'matching_ack',
  );
  assert.deepEqual(
    model.events.flatMap((row) => (row.left ? [row.left] : [])),
    normal.view.events,
  );
  assert.deepEqual(
    model.events.flatMap((row) => (row.right ? [row.right] : [])),
    retry.view.events,
  );
  assert.ok(model.firstDifference !== undefined);
});

test('delay-only changes retain semantic pairing while displaying the direction of virtual time differences', () => {
  const config = createPingPongExperiment();
  const left = runComparisonRecord(config);
  const right = runComparisonRecord(
    editExperiment(config, '/environment/directions/AtoB/delayMs', 20),
  );
  const model = compareRuns(left, right);
  const received = model.events.find((row) => row.left?.kind === 'receive');
  assert.equal(received?.right?.kind, 'receive');
  assert.equal(received?.content, 'same');
  assert.equal(received?.deltaMs, 10);
  assert.equal(received?.relation, 'different');
  assert.equal(
    compareRuns(right, left).events.find((row) => row.right?.kind === 'receive')?.deltaMs,
    -10,
  );
});

test('different local event IDs and source-event lists do not masquerade as payload changes', () => {
  const left = runComparisonRecord();
  const right: SavedRun = {
    ...left,
    id: 'other',
    view: {
      ...left.view,
      runId: 'other',
      events: left.view.events.map((event) => ({
        ...event,
        runId: 'other',
        eventId: `r-${event.eventId}`,
        ...(event.causeEventId ? { causeEventId: `r-${event.causeEventId}` } : {}),
        data:
          event.kind === 'receive' && Array.isArray((event.data as JsonObject).sourceEventIds)
            ? {
                ...(event.data as JsonObject),
                sourceEventIds: ((event.data as JsonObject).sourceEventIds as string[]).map(
                  (id) => `r-${id}`,
                ),
              }
            : event.data,
      })),
    },
  };
  const model = compareRuns(left, right);
  assert.equal(model.traceStatus, 'ready');
  assert.ok(model.events.every((row) => row.relation === 'same'));
});

test('protocol revisions can be compared while changed expectation definitions remain visible beside their recorded verdicts', () => {
  const config = createPingPongExperiment();
  const left = runComparisonRecord(config);
  const changed = editExperiment(config, '/definitions/0/rules/2/nextStateId', 'Failed');
  const right = {
    ...runComparisonRecord(editExperiment(changed, '/scenario/expectations/0/stateId', 'Failed')),
    draftVersion: 2,
  };
  const model = compareRuns(left, right);
  assert.equal(model.traceStatus, 'ready');
  assert.equal(model.values.find((row) => row.id === 'protocols')?.relation, 'different');
  const expectation = model.values.find(
    (row) => row.section === 'expectation' && row.relation === 'different',
  );
  assert.ok(expectation);
  assert.match(JSON.stringify(expectation.left), /Done/);
  assert.match(JSON.stringify(expectation.right), /Failed/);
  assert.equal(
    model.events.find((row) => row.left?.kind === 'transition' && row.left.ruleId === 'complete')
      ?.content,
    'different',
  );
});

test('partial records keep saved status and absence distinct from a failed or missing network transmission', () => {
  const config = createPingPongExperiment();
  const left = runComparisonRecord(config, { limits: { maxEvents: 2 } });
  const right = runComparisonRecord(config);
  const model = compareRuns(left, right);
  assert.equal(model.traceStatus, 'ready');
  assert.equal(model.values.find((row) => row.id === 'status')?.left, 'limit-reached');
  assert.ok(model.events.some((row) => row.relation === 'right-only'));
  const metrics = model.values.find((row) => row.id === 'metrics');
  assert.ok(metrics);
  assert.equal((metrics.left as JsonObject).verdict, 'undetermined');
  assert.equal(model.values.find((row) => row.id === 'A:state')?.relation, 'different');
});

test('added and removed variables preserve missing versus null, false and zero', () => {
  const left = runComparisonRecord();
  const right = {
    ...left,
    view: {
      ...left.view,
      participants: {
        ...left.view.participants,
        A: { ...left.view.participants.A, variables: { fresh: null, zero: 0, flag: false } },
      },
    },
  };
  const model = compareRuns(left, right);
  assert.equal(model.values.find((row) => row.id === 'A:variable:counter')?.relation, 'left-only');
  for (const id of ['fresh', 'zero', 'flag'])
    assert.equal(model.values.find((row) => row.id === `A:variable:${id}`)?.relation, 'right-only');
  assert.equal(model.values.find((row) => row.id === 'A:variable:fresh')?.right, null);
  assert.equal(model.values.find((row) => row.id === 'A:variable:flag')?.right, false);
});

test('unrelated protocols and unsupported engine versions retain summaries but refuse trace correspondence', () => {
  const left = runComparisonRecord();
  const other = runComparisonRecord(createExampleCopy('stop_wait'));
  assert.equal(compareRuns(left, other).traceStatus, 'unavailable');
  const unsupported = {
    ...left,
    view: { ...left.view, snapshot: { ...left.view.snapshot, engineVersion: 'future' } },
  };
  const model = compareRuns(left, unsupported);
  assert.equal(model.traceStatus, 'unavailable');
  assert.match(model.message, /지원하지 않는/);
  assert.ok(model.values.length > 0);
  assert.equal(model.events.length, 0);
});

test('inconsistent sequence, causes and transition states cannot produce a claimed comparison', () => {
  const left = runComparisonRecord();
  for (const update of [{ sequence: 999 }, { causeEventId: 'future' }, { ruleId: 'unknown' }]) {
    const right = {
      ...left,
      view: {
        ...left.view,
        events: left.view.events.map((event) =>
          event.kind === 'transition' ? { ...event, ...update } : event,
        ),
      },
    };
    assert.equal(compareRuns(left, right).traceStatus, 'unavailable');
  }
});

test('arbitrary environment targets and oversized IDs never serialize deep payloads during indexing', () => {
  const left = runComparisonRecord();
  const guarded = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('Arbitrary target traversed');
      },
    },
  );
  for (const operation of [guarded, 'x'.repeat(1025)]) {
    const right = {
      ...left,
      view: {
        ...left.view,
        events: left.view.events.map((event, index) =>
          index ? event : { ...event, kind: 'environment' as const, data: { operation } },
        ),
      },
    };
    const model = compareRuns(left, right);
    assert.equal(model.traceStatus, 'unavailable');
    assert.match(model.message, /대상 ID/);
  }
});

test('a selected aligned transition replays each original cursor independently', () => {
  const { normal, retry } = pair();
  const model = compareRuns(normal, retry);
  const row = model.events.find(
    (row) => row.left?.kind === 'transition' && row.left.ruleId === 'matching_ack',
  );
  assert.ok(row?.left && row.right);
  assert.notEqual(row.left.sequence, row.right.sequence);
  assert.equal(projectRecord(normal, row.left.sequence + 1).participants.A.variables.retries, 0);
  assert.equal(projectRecord(retry, row.right.sequence + 1).participants.A.variables.retries, 1);
  assert.equal(projectRecord(normal, row.left.sequence + 1).participants.A.stateId, 'Done');
});

test('large wire arrays remain shared and unvisited beyond comparison limits rather than being claimed equal', () => {
  const config = createMessageLimitExperiment();
  const left = runComparisonRecord(config);
  const right = runComparisonRecord(config);
  const guarded = {
    ...right,
    view: {
      ...right.view,
      events: right.view.events.map((event) => {
        const data = event.data as JsonObject;
        const wire = data.wire as JsonObject | undefined;
        if (!wire || !Array.isArray(wire.bytes)) return event;
        const bytes = new Proxy(wire.bytes, {
          get(target, property, receiver) {
            if (/^\d+$/.test(String(property))) throw new Error('Large byte array traversed');
            return Reflect.get(target, property, receiver);
          },
        });
        return { ...event, data: { ...data, wire: { ...wire, bytes } } };
      }),
    },
  };
  const model = compareRuns(left, guarded);
  assert.equal(model.traceStatus, 'ready');
  assert.ok(model.events.some((row) => row.relation === 'limited'));
  assert.equal(
    model.events.find((row) => row.right?.kind === 'send')?.right,
    guarded.view.events.find((event) => event.kind === 'send'),
  );
  assert.equal(model.limitedBeforeFirst, true);
});

test('two actual 10k traces preserve every repeated observation with bounded alignment', () => {
  const config = createEventLimitExperiment();
  const left = runComparisonRecord(config);
  const right = runComparisonRecord(config);
  const model = compareRuns(left, right);
  assert.equal(model.traceStatus, 'ready');
  assert.equal(model.events.length, 10_000);
  assert.ok(model.events.every((row) => row.relation === 'same'));
  const overflow = {
    ...left,
    view: { ...left.view, events: [...left.view.events, ...left.view.events.slice(0, 1)] },
  };
  assert.equal(compareRuns(left, overflow).traceStatus, 'unavailable');
});

test('reordered and extra repeated messages preserve monotone coverage without treating IDs as causal matches', () => {
  const { normal } = pair();
  const duplicate = runCoverageSuite()[2];
  assert.ok(duplicate);
  const model = compareRuns(normal, duplicate);
  assert.equal(model.traceStatus, 'ready');
  assert.deepEqual(
    model.events.flatMap((row) => (row.left ? [row.left.eventId] : [])),
    normal.view.events.map((event) => event.eventId),
  );
  assert.deepEqual(
    model.events.flatMap((row) => (row.right ? [row.right.eventId] : [])),
    duplicate.view.events.map((event) => event.eventId),
  );
  assert.ok(model.events.some((row) => row.relation === 'right-only'));
});
