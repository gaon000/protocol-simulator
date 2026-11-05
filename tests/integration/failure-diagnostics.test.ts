import assert from 'node:assert/strict';
import test from 'node:test';
import { createSimulation } from '../../src/application/create-simulation.ts';
import { editExperiment } from '../../src/application/edit-experiment.ts';
import {
  diagnoseExpectation,
  diagnosisEventLabel,
  diagnosisTrail,
} from '../../src/application/failure-diagnostics.ts';
import { projectRecord } from '../../src/application/replay-record.ts';
import { captureRun } from '../../src/application/workspace-operations.ts';
import type { EngineView, ExperimentDefinition } from '../../src/domain/protocol-model.ts';
import { createExampleCopy, EXAMPLES } from '../../src/examples/catalog.ts';
import { createMessageLimitExperiment } from '../fixtures/large-experiments.ts';

function engine(configuration: ExperimentDefinition) {
  const created = createSimulation(configuration);
  assert.ok(created.success, created.success ? '' : JSON.stringify(created.diagnostics));
  return created.value;
}
function diagnosis(view: EngineView, index = 0) {
  const id = view.expectations[index]?.expectationId;
  assert.ok(id);
  return diagnoseExpectation(view, id);
}

test('all catalog expectations reconstruct the authoritative verdict without changing snapshots', () => {
  for (const example of EXAMPLES) {
    const view = engine(createExampleCopy(example.id)).run();
    const before = JSON.stringify(view);
    for (const item of view.expectations) {
      const result = diagnoseExpectation(view, item.expectationId);
      assert.equal(result.recorded, item.status);
      assert.equal(
        result.status,
        item.status === 'undetermined' ? 'incomplete' : 'verified',
        example.id,
      );
    }
    assert.equal(JSON.stringify(view), before);
  }
});

test('state failures identify the actual final transition and timer generation without inventing loss causality', () => {
  const config = editExperiment(
    createExampleCopy('ping_pong'),
    '/environment/directions/AtoB/delayMs',
    2000,
  );
  const view = engine(config).run();
  const state = diagnosis(view);
  assert.equal(state.recorded, 'fail');
  assert.equal(state.status, 'verified');
  assert.match(state.expected, /Done/);
  assert.match(state.actual, /Failed/);
  const last = state.evidence[0];
  assert.equal(last?.ruleId, 'expire');
  assert.ok(last);
  const trail = diagnosisTrail(view, last.eventId);
  assert.ok(trail.items.some((item) => item.relation.includes('같은 타이머 세대')));
  assert.ok(trail.items.some((item) => item.event.kind === 'input'));
  assert.equal(trail.missing, false);
  assert.equal(trail.limited, false);
});

test('delivery counts use upper delivery only and distinguish an absent delivery from packet loss', () => {
  let config = createExampleCopy('ping_pong');
  config = editExperiment(config, '/scenario/expectations', [
    { id: 'count', kind: 'delivery-count', participant: 'A', messageId: 'pong', count: 2 },
    { id: 'absent', kind: 'delivery-count', participant: 'B', messageId: 'pong', count: 1 },
  ]);
  const view = engine(config).run();
  const result = diagnosis(view);
  assert.equal(result.status, 'verified');
  assert.equal(result.recorded, 'fail');
  assert.match(result.actual, /1회/);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0]?.kind, 'deliver');
  assert.equal(diagnosis(view, 1).evidence.length, 0);
});

test('delivered-values normalizes defaults and shows mismatched actual values from the saved message', () => {
  const config = editExperiment(createExampleCopy('ping_pong'), '/scenario/expectations', [
    {
      id: 'default',
      kind: 'delivered-values',
      participant: 'A',
      message: { messageId: 'pong', values: { sequence: 1 } },
    },
    {
      id: 'mismatch',
      kind: 'delivered-values',
      participant: 'A',
      message: { messageId: 'pong', values: { sequence: 2 } },
    },
  ]);
  const view = engine(config).run();
  assert.equal(diagnosis(view).recorded, 'pass');
  assert.match(diagnosis(view).expected, /safe/);
  const result = diagnosis(view, 1);
  assert.equal(result.status, 'verified');
  assert.equal(result.recorded, 'fail');
  assert.match(result.actual, /일치 0회/);
  assert.match(result.actual, /"sequence": 1/);
  assert.match(result.expected, /"sequence": 2/);
});

test('completion failures distinguish lateness from unsuccessful or missing completion', () => {
  const base = createExampleCopy('ping_pong');
  const expectation = [{ id: 'deadline', kind: 'completion-before', participant: 'A', timeMs: 1 }];
  const late = engine(editExperiment(base, '/scenario/expectations', expectation)).run();
  assert.equal(diagnosis(late).status, 'verified');
  assert.equal(diagnosis(late).recorded, 'fail');
  assert.match(diagnosis(late).actual, /success/);
  const failed = engine(
    editExperiment(
      editExperiment(base, '/scenario/expectations', expectation),
      '/environment/directions/AtoB/delayMs',
      2000,
    ),
  ).run();
  assert.match(diagnosis(failed).actual, /failure/);
  const waitingConfig = editExperiment(
    editExperiment(base, '/scenario/expectations', expectation),
    '/scenario/inputs',
    [],
  );
  const waiting = engine(waitingConfig).run();
  assert.equal(diagnosis(waiting).status, 'verified');
  assert.equal(diagnosis(waiting).recorded, 'fail');
  assert.match(diagnosis(waiting).actual, /최초 종료 없음/);
  assert.equal(diagnosis(waiting).evidence.length, 0);
  const initiallyDone = engine(
    editExperiment(waitingConfig, '/definitions/0/initialStateId', 'Done'),
  ).run();
  assert.equal(diagnosis(initiallyDone).status, 'verified');
  assert.equal(diagnosis(initiallyDone).recorded, 'pass');
  assert.match(diagnosis(initiallyDone).actual, /최초 종료 0 ms/);
});

test('cancelled, limited, error and historical prefix observations never become failed conclusions', () => {
  const created = engine(createExampleCopy('ping_pong'));
  created.step();
  const cancelled = created.cancel();
  assert.equal(diagnosis(cancelled).status, 'incomplete');
  assert.equal(diagnosis(cancelled).recorded, 'undetermined');
  const completed = engine(createExampleCopy('ping_pong')).run();
  const record = captureRun(completed, 'draft', 1);
  for (let position = 0; position <= completed.events.length; position++) {
    const prefix = projectRecord(record, position);
    const result = diagnoseExpectation(
      prefix,
      prefix.expectations[0]?.expectationId ?? '',
      position,
    );
    assert.equal(result.status, 'incomplete');
    assert.ok(
      [...result.evidence, ...result.context].every(
        (event) => completed.events.indexOf(event) < position,
      ),
    );
    const future = completed.events[position];
    if (future) assert.equal(diagnosisTrail(prefix, future.eventId, position).items.length, 0);
  }
  assert.equal(diagnosis(projectRecord(record, completed.events.length + 1)).status, 'verified');
  const initial = diagnoseExpectation(completed, completed.expectations[0]?.expectationId ?? '', 0);
  assert.equal(initial.status, 'incomplete');
  assert.equal(initial.recorded, 'undetermined');
  assert.match(initial.actual, /Idle/);
  assert.equal(diagnosis({ ...cancelled, status: 'limit-reached' }).status, 'incomplete');
  assert.equal(
    diagnosis({
      ...completed,
      participants: {
        ...completed.participants,
        A: { ...completed.participants.A, outcome: 'error' },
      },
      expectations: completed.expectations.map((item) => ({ ...item, status: 'undetermined' })),
    }).status,
    'incomplete',
  );
});

test('mismatched stored verdicts, missing transitions, unknown expectations and unsupported versions are explicit', () => {
  const view = engine(createExampleCopy('ping_pong')).run();
  assert.equal(
    diagnosis({
      ...view,
      expectations: view.expectations.map((item) => ({ ...item, status: 'fail' })),
    }).status,
    'inconsistent',
  );
  assert.equal(diagnosis({ ...view, events: [] }).status, 'inconsistent');
  assert.equal(
    diagnosis({
      ...view,
      participants: { ...view.participants, A: { ...view.participants.A, finishedAt: 0 } },
    }).status,
    'inconsistent',
  );
  assert.equal(diagnoseExpectation(view, 'absent').status, 'unavailable');
  assert.equal(
    diagnosis({ ...view, snapshot: { ...view.snapshot, engineVersion: 'future' } }).status,
    'unavailable',
  );
});

test('ACK loss remains contextual and exact send ancestry is followed without asserting a unique cause', () => {
  const config = editExperiment(
    createExampleCopy('stop_wait'),
    '/environment/directions/BtoA/lossRate',
    1,
  );
  const view = engine(config).run();
  const result = diagnosis(view);
  assert.equal(result.status, 'verified');
  const drop = result.context.find(
    (event) => event.kind === 'environment' && String(diagnosisEventLabel(event)).includes('drop'),
  );
  assert.ok(drop);
  const trail = diagnosisTrail(view, drop.eventId);
  assert.ok(
    trail.items.some((item) => item.event.kind === 'send' && item.relation.includes('직접 원인')),
  );
  assert.equal(
    trail.items.some((item) => item.event.kind === 'timer'),
    false,
  );
});

test('large message comparisons are bounded and wire payload arrays are never traversed', () => {
  const config = createMessageLimitExperiment();
  const view = engine(config).run();
  const result = diagnosis(view);
  assert.equal(result.status, 'verified');
  const deliver = view.events.find((event) => event.kind === 'deliver');
  assert.ok(deliver);
  const message = (
    deliver.data as { message: { messageId: string; values: Record<string, string> } }
  ).message;
  const altered = {
    ...view,
    snapshot: {
      ...view.snapshot,
      configuration: {
        ...view.snapshot.configuration,
        scenario: {
          ...view.snapshot.configuration.scenario,
          expectations: [
            { id: 'large', kind: 'delivered-values' as const, participant: 'B' as const, message },
          ],
        },
      },
    },
    expectations: [{ expectationId: 'large', status: 'pass' as const, detail: '' }],
  };
  const bounded = diagnoseExpectation(altered, 'large');
  assert.equal(bounded.status, 'limited');
  assert.ok(bounded.expected.length < 600);
  assert.ok(bounded.actual.length < 600);
});

test('trail handles coalesced sources, missing and cyclic references, and caps ancestry', () => {
  const view = engine(createExampleCopy('ping_pong')).run();
  const first = view.events[0];
  assert.ok(first);
  const records = Array.from({ length: 100 }, (_, index) => ({
    ...first,
    eventId: `n-${index}`,
    sequence: index,
    ...(index ? { causeEventId: `n-${index - 1}` } : {}),
  }));
  const bounded = diagnosisTrail({ ...view, events: records }, 'n-99');
  assert.equal(bounded.items.length, 64);
  assert.equal(bounded.limited, true);
  const missing = diagnosisTrail(
    { ...view, events: [{ ...first, causeEventId: 'absent' }] },
    first.eventId,
  );
  assert.equal(missing.missing, true);
  const cyclic = diagnosisTrail(
    { ...view, events: [{ ...first, causeEventId: first.eventId }] },
    first.eventId,
  );
  assert.equal(cyclic.items.length, 1);
  assert.equal(cyclic.missing, true);
  const combined = {
    ...first,
    kind: 'receive' as const,
    eventId: 'combined',
    data: { sourceEventIds: [records[0]?.eventId ?? '', records[1]?.eventId ?? ''] },
  };
  const merged = diagnosisTrail({ ...view, events: [...records, combined] }, 'combined');
  assert.ok(merged.items.some((item) => item.relation.includes('합쳐진 송신')));
});
