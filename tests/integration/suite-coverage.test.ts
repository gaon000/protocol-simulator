import assert from 'node:assert/strict';
import test from 'node:test';
import { createSimulation } from '../../src/application/create-simulation.ts';
import { projectRecord } from '../../src/application/replay-record.ts';
import {
  createRegressionSession,
  prepareRegression,
} from '../../src/application/scenario-suites.ts';
import { buildSuiteCoverage } from '../../src/application/suite-coverage.ts';
import type { SavedRun } from '../../src/domain/workspace-model.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';
import {
  createCoverageDraft,
  createPagedCoverageDraft,
  runCoverageSuite,
} from '../fixtures/coverage-suite.ts';
import {
  createEventLimitExperiment,
  createMessageLimitExperiment,
} from '../fixtures/large-experiments.ts';

function coverage(records: readonly SavedRun[]) {
  return buildSuiteCoverage(records, records[0]?.regression?.id ?? '');
}
function first(records: readonly SavedRun[]): SavedRun {
  const record = records[0];
  assert.ok(record);
  return record;
}

test('a real three-case suite counts committed rules and initial/after states independently per actor', () => {
  const records = runCoverageSuite();
  const before = JSON.stringify(records);
  const model = coverage(records);
  assert.equal(model.status, 'ready');
  assert.deepEqual(
    model.cases.map((item) => item.reason),
    ['관찰 완료', '관찰 완료', '관찰 완료'],
  );
  const a = model.actors[0];
  const b = model.actors[1];
  assert.ok(a && b);
  assert.equal(a.protocol, first(records).view.snapshot.configuration.definitions[0]);
  assert.deepEqual(
    a.states.map((item) => [item.id, item.count]),
    [
      ['Ready', 3],
      ['Waiting', 4],
      ['Done', 4],
      ['Failed', 0],
    ],
  );
  assert.deepEqual(
    b.states.map((item) => [item.id, item.count]),
    [
      ['Ready', 8],
      ['Waiting', 0],
      ['Done', 0],
      ['Failed', 0],
    ],
  );
  assert.equal(a.rules.find((item) => item.id === 'retry')?.count, 1);
  assert.equal(b.rules.find((item) => item.id === 'duplicate_data')?.count, 2);
  assert.equal(a.rules.filter((item) => item.count > 0).length, 4);
  assert.equal(b.rules.filter((item) => item.count > 0).length, 2);
  assert.equal(JSON.stringify(records), before);
});

test('initial states have position zero and first committed rule positions project exact replay states', () => {
  const records = runCoverageSuite();
  const a = coverage(records).actors[0];
  assert.ok(a);
  const initial = a.states.find((item) => item.id === 'Ready');
  assert.equal(initial?.cases.length, 3);
  assert.ok(initial?.cases.every((item) => item.position === 0 && item.count === 1));
  const retry = a.rules.find((item) => item.id === 'retry');
  const evidence = retry?.cases[0];
  assert.ok(evidence);
  assert.equal(evidence.label, 'ACK 손실');
  assert.equal(evidence.caseIndex, 1);
  assert.equal(evidence.record.view.events[evidence.position - 1]?.ruleId, 'retry');
  assert.equal(
    projectRecord(evidence.record, evidence.position).participants.A.variables.retries,
    1,
  );
  assert.equal(
    projectRecord(evidence.record, evidence.position - 1).participants.A.variables.retries,
    0,
  );
});

test('empty input and zero rules retain only initial observations without inventing a full-coverage rule', () => {
  const config = createPingPongExperiment();
  const draft = createCoverageDraft({
    ...config,
    definitions: config.definitions.map((item) => ({ ...item, rules: [] })),
    scenario: {
      ...config.scenario,
      inputs: [],
      expectations: [{ id: 'initial', kind: 'state', participant: 'A', stateId: 'Idle' }],
    },
  });
  const model = coverage(runCoverageSuite(draft));
  assert.equal(model.status, 'ready');
  for (const actor of model.actors) {
    assert.equal(actor.rules.length, 0);
    assert.equal(actor.states.filter((item) => item.count > 0).length, 1);
    assert.equal(actor.states[0]?.count, 1);
  }
});

test('cancelled cases contribute observed commits and missing/deleted manifest slots stay explicit', () => {
  const draft = createCoverageDraft(createEventLimitExperiment(), 3);
  const plan = prepareRegression(draft, 100);
  assert.ok(plan.success);
  const session = createRegressionSession(plan.value);
  assert.equal(session.advance(), undefined);
  const record = session.cancel();
  assert.ok(record);
  const model = coverage([record]);
  assert.equal(model.status, 'ready');
  assert.deepEqual(
    model.cases.map((item) => [item.status, item.partial]),
    [
      ['included', true],
      ['missing', false],
      ['missing', false],
    ],
  );
  assert.ok((model.actors[0]?.rules.find((item) => item.id === 'repeat')?.count ?? 0) > 0);
  const complete = runCoverageSuite();
  const deleted = coverage([first(complete), ...complete.slice(2)]);
  assert.equal(deleted.cases[1]?.status, 'missing');
  assert.equal(deleted.actors[0]?.states[0]?.count, 2);
});

test('event-limit actor views never fabricate an unrecorded state change or rule execution', () => {
  const records = runCoverageSuite(createCoverageDraft(createPingPongExperiment()));
  const record = first(records);
  const simulation = createSimulation(record.view.snapshot.configuration, {
    limits: { maxEvents: 2 },
  });
  assert.ok(simulation.success);
  const limited = { ...record, view: simulation.value.run() };
  assert.equal(limited.view.status, 'limit-reached');
  assert.equal(limited.view.participants.A.stateId, 'Waiting');
  assert.equal(
    limited.view.events.some((item) => item.kind === 'transition'),
    false,
  );
  const model = coverage([limited]);
  assert.equal(model.status, 'ready');
  assert.ok(model.actors[0]?.rules.every((item) => item.count === 0));
  assert.equal(model.actors[0]?.states.find((item) => item.id === 'Waiting')?.count, 0);
  assert.equal(model.actors[0]?.states.find((item) => item.id === 'Idle')?.count, 1);
});

test('a rolled-back rule with participant error contributes no commit but preserves initial coverage', () => {
  const config = createPingPongExperiment();
  const records = runCoverageSuite(
    createCoverageDraft({
      ...config,
      definitions: config.definitions.map((item) => ({
        ...item,
        rules: item.rules.map((rule, index) =>
          index
            ? rule
            : {
                ...rule,
                actions: [
                  {
                    kind: 'start-timer',
                    timerId: 'response',
                    durationMs: {
                      kind: 'subtract',
                      left: { kind: 'literal', value: 0 },
                      right: { kind: 'literal', value: 1 },
                    },
                  },
                ],
              },
        ),
      })),
    }),
  );
  const model = coverage(records);
  assert.equal(model.status, 'ready');
  assert.equal(first(records).view.participants.A.outcome, 'error');
  assert.match(model.cases[0]?.reason ?? '', /오류/);
  assert.equal(model.actors[0]?.states[0]?.count, 1);
  assert.ok(model.actors[0]?.rules.every((item) => item.count === 0));
  const looping = createEventLimitExperiment();
  const partial = runCoverageSuite(
    createCoverageDraft({
      ...looping,
      definitions: looping.definitions.map((protocol) => ({
        ...protocol,
        rules: protocol.rules.map((rule, index) =>
          index
            ? rule
            : {
                ...rule,
                actions: [
                  {
                    kind: 'start-timer',
                    timerId: 'response',
                    durationMs: {
                      kind: 'subtract',
                      left: { kind: 'field', fieldId: 'sequence' },
                      right: { kind: 'literal', value: 1 },
                    },
                  },
                ],
              },
        ),
      })),
      scenario: {
        ...looping.scenario,
        inputs: [
          {
            id: 'error',
            timeMs: 0,
            participant: 'A',
            message: { messageId: 'ping', values: { sequence: 0 } },
          },
          {
            id: 'loop',
            timeMs: 0,
            participant: 'B',
            message: { messageId: 'ping', values: { sequence: 2 } },
          },
        ],
      },
    }),
  );
  assert.equal(first(partial).view.status, 'limit-reached');
  assert.equal(first(partial).view.participants.A.outcome, 'error');
  assert.equal(coverage(partial).cases[0]?.reason, '부분 관찰 · limit-reached · 참여자 오류');
});

test('different frozen definitions, revisions, manifests and engine contracts cannot be merged', () => {
  const records = runCoverageSuite();
  for (const mutate of [
    (item: SavedRun) => ({ ...item, draftVersion: item.draftVersion + 1 }),
    (item: SavedRun) => {
      assert.ok(item.regression);
      return { ...item, regression: { ...item.regression, suiteRevision: 9 } };
    },
    (item: SavedRun) => ({
      ...item,
      view: { ...item.view, snapshot: { ...item.view.snapshot, engineVersion: 'future' } },
    }),
    (item: SavedRun) => ({
      ...item,
      view: {
        ...item.view,
        snapshot: {
          ...item.view.snapshot,
          limits: { ...item.view.snapshot.limits, maxEvents: 99 },
        },
      },
    }),
    (item: SavedRun) => ({
      ...item,
      view: {
        ...item.view,
        snapshot: {
          ...item.view.snapshot,
          configuration: {
            ...item.view.snapshot.configuration,
            definitions: item.view.snapshot.configuration.definitions.map((protocol) => ({
              ...protocol,
              label: '동일 ID의 다른 정의',
            })),
          },
        },
      },
    }),
  ]) {
    const changed = records.map((item, index) => (index === 1 ? mutate(item) : item));
    assert.equal(coverage(changed).status, 'unavailable');
  }
  const duplicate = { ...first(records), id: 'duplicate_slot' };
  assert.match(coverage([...records, duplicate]).message, /중복/);
  assert.equal(buildSuiteCoverage(records, 'missing').status, 'unavailable');
});

test('equivalent property order and record order are accepted while separate execution groups remain separate', () => {
  const records = runCoverageSuite();
  const reordered = records.map((record) => ({
    ...record,
    view: {
      ...record.view,
      snapshot: {
        ...record.view.snapshot,
        configuration: Object.fromEntries(
          Object.entries(record.view.snapshot.configuration).reverse(),
        ) as typeof record.view.snapshot.configuration,
      },
    },
  }));
  assert.equal(coverage(reordered).status, 'ready');
  const separate = runCoverageSuite();
  const combined = buildSuiteCoverage(
    [...records.toReversed(), ...separate],
    first(records).regression?.id ?? '',
  );
  assert.equal(combined.actors[0]?.states[0]?.count, 3);
  assert.deepEqual(
    combined.actors[0]?.rules.map((item) => item.count),
    coverage(records).actors[0]?.rules.map((item) => item.count),
  );
});

test('corrupt transition traces exclude the whole case, including its initial state, without contaminating valid cases', () => {
  const records = runCoverageSuite();
  const original = first(records);
  for (const update of [
    { ruleId: 'unknown' },
    { causeEventId: 'future' },
    { participant: 'B' as const },
  ]) {
    const changed = {
      ...original,
      view: {
        ...original.view,
        events: original.view.events.map((event) =>
          event.kind === 'transition' ? { ...event, ...update } : event,
        ),
      },
    };
    const model = coverage([changed, ...records.slice(1)]);
    assert.equal(model.status, 'ready');
    assert.equal(model.cases[0]?.status, 'excluded');
    assert.equal(model.actors[0]?.states[0]?.count, 2);
  }
  const wrongOrder = {
    ...original,
    view: {
      ...original.view,
      events: original.view.events.map((event, index) =>
        index ? event : { ...event, sequence: 9 },
      ),
    },
  };
  assert.equal(coverage([wrongOrder]).status, 'unavailable');
  assert.equal(coverage([wrongOrder]).cases[0]?.status, 'excluded');
});

test('unrelated definitions are not in actor denominators and individual parallel rules retain distinct observations', () => {
  const draft = createPagedCoverageDraft();
  const protocol = draft.configuration.definitions[0];
  assert.ok(protocol);
  const records = runCoverageSuite({
    ...draft,
    configuration: {
      ...draft.configuration,
      definitions: [...draft.configuration.definitions, { ...protocol, id: 'unused_definition' }],
    },
  });
  const model = coverage(records);
  assert.equal(model.actors[0]?.states.length, 49);
  assert.equal(model.actors[0]?.rules.length, 31);
  assert.equal(model.actors[0]?.rules.find((item) => item.id === 'parallel_unobserved')?.count, 0);
  assert.equal(model.actors[0]?.rules[0]?.count, 1);
});

test('large wire payloads are kept by reference without traversal or copying', () => {
  const records = runCoverageSuite(createCoverageDraft(createMessageLimitExperiment()));
  const record = first(records);
  const guarded = {
    ...record,
    view: {
      ...record.view,
      events: record.view.events.map((event) => {
        if (event.kind !== 'send' && event.kind !== 'receive') return event;
        return {
          ...event,
          data: new Proxy(event.data as object, {
            get(target, key, receiver) {
              if (key === 'wire') throw new Error('Wire payload traversed');
              return Reflect.get(target, key, receiver);
            },
          }) as typeof event.data,
        };
      }),
    },
  };
  assert.equal(coverage([guarded]).status, 'ready');
  assert.equal(coverage([guarded]).actors[0]?.rules[0]?.cases[0]?.record, guarded);
});

test('actual 10k traces preserve self-transition counts and reject an overflowing event budget', () => {
  const record = first(runCoverageSuite(createCoverageDraft(createEventLimitExperiment())));
  assert.equal(record.view.events.length, 10_000);
  const model = coverage([record]);
  assert.equal(model.status, 'ready');
  assert.equal(model.cases[0]?.partial, true);
  const transitions = record.view.events.filter((event) => event.kind === 'transition');
  const event = record.view.events[0];
  assert.ok(event);
  assert.equal(
    model.actors[0]?.states.find((item) => item.id === 'Waiting')?.count,
    transitions.length,
  );
  assert.equal(
    model.actors[0]?.rules.reduce((sum, item) => sum + item.count, 0),
    transitions.length,
  );
  assert.equal(
    coverage([
      {
        ...record,
        view: { ...record.view, events: [...record.view.events, event] },
      },
    ]).status,
    'unavailable',
  );
});
