import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type Breakpoint,
  type BreakpointSettings,
  type BreakpointStop,
  compileBreakpoints,
  matchBreakpoints,
} from '../../src/application/breakpoints.ts';
import { createRunSession, createSimulation } from '../../src/application/create-simulation.ts';
import { editExperiment } from '../../src/application/edit-experiment.ts';
import { projectRecord } from '../../src/application/replay-record.ts';
import { captureRun } from '../../src/application/workspace-operations.ts';
import type { ExperimentDefinition } from '../../src/domain/protocol-model.ts';
import { createExampleCopy, EXAMPLES } from '../../src/examples/catalog.ts';
import { createExplanationExperiment } from '../fixtures/explanation-experiment.ts';
import { createEventLimitExperiment } from '../fixtures/large-experiments.ts';

function engine(config: ExperimentDefinition) {
  const created = createSimulation(config, { runId: 'same-run' });
  assert.ok(created.success, created.success ? '' : JSON.stringify(created.diagnostics));
  return created.value;
}
function point(config: ExperimentDefinition, change: Partial<Breakpoint> = {}): Breakpoint {
  return {
    id: 'point',
    label: 'test point',
    enabled: true,
    participant: 'A',
    protocolId: config.protocols.A.id,
    protocolRevision: config.protocols.A.revision,
    kind: 'state',
    targetId: 'Waiting',
    operator: 'eq',
    literal: '1',
    ...change,
  };
}
function compile(config: ExperimentDefinition, points: readonly Breakpoint[]) {
  const parsed = compileBreakpoints(config, { enabled: true, points });
  assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.diagnostics));
  return parsed.value;
}

test('all catalog engines resume after breakpoints to exactly the same trace, participants and final verdicts', () => {
  for (const example of EXAMPLES) {
    const config = createExampleCopy(example.id);
    const baseline = engine(config).run();
    const points = (['A', 'B'] as const)
      .flatMap((participant) => {
        const reference = config.protocols[participant];
        const protocol = config.definitions.find((item) => item.id === reference.id);
        return (protocol?.states ?? []).map((state) =>
          point(config, {
            id: `${participant}-${state.id}`,
            participant,
            protocolId: reference.id,
            protocolRevision: reference.revision,
            targetId: state.id,
          }),
        );
      })
      .slice(0, 20);
    const plan = compile(config, points);
    const actual = engine(config);
    let iterations = 0;
    while (!actual.result()) {
      actual.runBatch(64, (events) => !!matchBreakpoints(plan, events));
      assert.ok(++iterations <= 10_000);
    }
    assert.deepEqual(actual.view(), baseline, example.id);
  }
});

test('state entry stops after commit, ignores self transitions, and continuing cannot hit the same event twice', () => {
  const config = createExampleCopy('ping_pong');
  const plan = compile(config, [point(config), point(config, { id: 'done', targetId: 'Done' })]);
  const actual = engine(config);
  let stop: BreakpointStop | undefined;
  const advance = () =>
    actual.runBatch(1000, (events) => {
      stop = matchBreakpoints(plan, events);
      return !!stop;
    });
  const waiting = advance();
  assert.equal(waiting.status, 'paused');
  assert.equal(waiting.participants.A.stateId, 'Waiting');
  assert.equal(waiting.participants.A.variables.counter, 1);
  const first = stop?.event.eventId;
  assert.ok(first);
  const done = advance();
  assert.equal(done.participants.A.stateId, 'Done');
  assert.notEqual(stop?.event.eventId, first);
  assert.deepEqual(actual.run(), engine(config).run());
});

test('message points match decoded receiver messages rather than chunks or upper deliveries', () => {
  const config = createExampleCopy('http_split');
  const ref = config.protocols.B;
  const plan = compile(config, [
    point(config, {
      participant: 'B',
      protocolId: ref.id,
      protocolRevision: ref.revision,
      kind: 'message',
      targetId: 'request',
    }),
  ]);
  const actual = engine(config);
  let stop: BreakpointStop | undefined;
  const paused = actual.runBatch(1000, (events) => {
    stop = matchBreakpoints(plan, events);
    return !!stop;
  });
  assert.equal(stop?.event.kind, 'parsed');
  assert.equal(stop?.event.participant, 'B');
  assert.ok(paused.events.filter((event) => event.kind === 'receive').length > 1);
  assert.ok((stop?.trailingEvents ?? 0) > 0);
  assert.deepEqual(actual.run(), engine(config).run());
});

test('variable conditions read committed after values, preserve false/null and compare JSON structurally', () => {
  const config = createExplanationExperiment();
  const actual = engine(config);
  const plan = compile(config, [
    point(config, { kind: 'variable', targetId: 'count', operator: 'gte', literal: '3' }),
  ]);
  let stop: BreakpointStop | undefined;
  actual.runBatch(64, (events) => {
    stop = matchBreakpoints(plan, events);
    return !!stop;
  });
  assert.match(stop?.hits[0]?.detail ?? '', /count = 3/);
  const base = createExampleCopy('ping_pong');
  const object = editExperiment(base, '/definitions/0/variables/1/initial', { a: 1, b: false });
  const record = engine(object).run();
  assert.ok(
    matchBreakpoints(
      compile(object, [
        point(object, { kind: 'variable', targetId: 'pending', literal: '{"b":false,"a":1}' }),
      ]),
      record.events,
    ),
  );
  const nullable = engine(base).run();
  assert.ok(
    matchBreakpoints(
      compile(base, [point(base, { kind: 'variable', targetId: 'pending', literal: 'null' })]),
      nullable.events,
    ),
  );
  const boolean = editExperiment(base, '/definitions/0/variables', [
    { id: 'counter', type: 'integer', initial: 0 },
    { id: 'pending', type: 'json', initial: null },
    { id: 'flag', type: 'boolean', initial: false },
  ]);
  assert.ok(
    matchBreakpoints(
      compile(boolean, [point(boolean, { kind: 'variable', targetId: 'flag', literal: 'false' })]),
      engine(boolean).run().events,
    ),
  );
});

test('the first conditional hit inside a large batch is preserved and a still-true condition stops at the next commit', () => {
  const base = createEventLimitExperiment();
  const protocol = base.definitions[0];
  assert.ok(protocol);
  const config = {
    ...base,
    definitions: [
      {
        ...protocol,
        variables: [{ id: 'counter', type: 'integer' as const, initial: 0 }],
        rules: protocol.rules.map((rule) => ({
          ...rule,
          actions: [
            {
              kind: 'assign' as const,
              variableId: 'counter',
              value: {
                kind: 'add' as const,
                left: { kind: 'variable' as const, variableId: 'counter' },
                right: { kind: 'literal' as const, value: 1 },
              },
            },
            ...rule.actions,
          ],
        })),
      },
    ],
  };
  const plan = compile(config, [
    point(config, { kind: 'variable', targetId: 'counter', operator: 'gte', literal: '200' }),
  ]);
  const actual = engine(config);
  const paused = actual.runBatch(1000, (events) => !!matchBreakpoints(plan, events));
  assert.equal(paused.participants.A.variables.counter, 200);
  const next = actual.runBatch(1000, (events) => !!matchBreakpoints(plan, events));
  assert.equal(next.participants.A.variables.counter, 201);
  assert.deepEqual(actual.run(), engine(config).run());
});

test('coalesced reads finish their atomic queue operation and report the first observed match plus trailing events', () => {
  const base = createExampleCopy('ping_pong');
  const actions = base.definitions[0]?.rules[0]?.actions;
  assert.ok(actions?.[1]);
  let config = editExperiment(base, '/definitions/0/rules/0/actions', [
    ...actions.slice(0, 2),
    actions[1],
    ...actions.slice(2),
  ]);
  config = editExperiment(config, '/environment/directions/AtoB/chunkBytes', 65536);
  const actual = engine(config);
  const plan = compile(config, [
    point(config, { participant: 'B', kind: 'message', targetId: 'ping' }),
  ]);
  let stop: BreakpointStop | undefined;
  const paused = actual.runBatch(1000, (events) => {
    stop = matchBreakpoints(plan, events);
    return !!stop;
  });
  const parsed = paused.events.filter(
    (event) => event.kind === 'parsed' && event.participant === 'B',
  );
  assert.equal(parsed.length, 2);
  assert.equal(stop?.event.eventId, parsed[0]?.eventId);
  assert.ok((stop?.trailingEvents ?? 0) > 2);
  assert.deepEqual(actual.run(), engine(config).run());
});

test('rolled-back actions cannot trigger variable or state points without an observed commit', () => {
  const base = createExplanationExperiment();
  const config = editExperiment(base, '/definitions/0/rules/0/actions/0/value', {
    kind: 'add',
    left: { kind: 'literal', value: Number.MAX_SAFE_INTEGER },
    right: { kind: 'literal', value: 1 },
  });
  const plan = compile(config, [
    point(config, { kind: 'variable', targetId: 'count', literal: '1' }),
    point(config, { id: 'done', targetId: 'Done' }),
  ]);
  const actual = engine(config);
  let stop: BreakpointStop | undefined;
  const view = actual.runBatch(1000, (events) => {
    stop = matchBreakpoints(plan, events);
    return !!stop;
  });
  assert.equal(stop, undefined);
  assert.equal(view.participants.A.outcome, 'error');
  assert.equal(
    view.events.some((event) => event.kind === 'transition'),
    false,
  );
});

test('validation blocks enabled invalid references, literals, operators and capacity but keeps disabled drafts usable', () => {
  const config = createExampleCopy('ping_pong');
  const invalid = [
    point(config, { targetId: 'absent' }),
    point(config, { protocolId: 'other' }),
    point(config, { label: '' }),
    point(config, { kind: 'variable', targetId: 'counter', literal: '{' }),
    point(config, { kind: 'variable', targetId: 'counter', literal: '"1"' }),
    point(config, { kind: 'variable', targetId: 'pending', operator: 'lt', literal: '1' }),
    point(config, { kind: 'variable', targetId: 'counter', literal: '1'.repeat(8193) }),
  ];
  for (const item of invalid) {
    assert.equal(compileBreakpoints(config, { enabled: true, points: [item] }).success, false);
    assert.equal(
      compileBreakpoints(config, { enabled: true, points: [{ ...item, enabled: false }] }).success,
      true,
    );
    assert.equal(compileBreakpoints(config, { enabled: false, points: [item] }).success, true);
  }
  assert.equal(
    compileBreakpoints(config, { enabled: true, points: [point(config), point(config)] }).success,
    false,
  );
  assert.equal(
    compileBreakpoints(config, {
      enabled: true,
      points: Array.from({ length: 21 }, (_, index) => point(config, { id: String(index) })),
    }).success,
    false,
  );
});

test('runtime value limits stop the debugger without failing the protocol and disabled continuation is equivalent', () => {
  const config = editExperiment(
    createExampleCopy('ping_pong'),
    '/definitions/0/variables/1/initial',
    'a'.repeat(9000),
  );
  const actual = engine(config);
  const plan = compile(config, [
    point(config, { kind: 'variable', targetId: 'pending', literal: 'null' }),
  ]);
  let stop: BreakpointStop | undefined;
  const view = actual.runBatch(1000, (events) => {
    stop = matchBreakpoints(plan, events);
    return !!stop;
  });
  assert.equal(stop?.kind, 'evaluation-error');
  assert.equal(view.status, 'paused');
  assert.equal(view.participants.A.outcome, 'active');
  assert.equal(view.diagnostics.length, 0);
  assert.deepEqual(actual.run(), engine(config).run());
});

test('history conditions use only the next recorded event and the snapshot rather than final actor values', () => {
  const config = createExampleCopy('ping_pong');
  const completed = engine(config).run();
  const plan = compile(config, [
    point(config, { kind: 'variable', targetId: 'counter', literal: '1' }),
  ]);
  const commit = completed.events.find(
    (event) => event.kind === 'transition' && event.ruleId === 'start',
  );
  assert.ok(commit);
  const record = captureRun(completed, 'draft', 1);
  const prefix = projectRecord(record, commit.sequence);
  assert.equal(prefix.participants.A.variables.counter, 0);
  assert.equal(matchBreakpoints(plan, completed.events.slice(0, commit.sequence)), undefined);
  assert.equal(matchBreakpoints(plan, [commit])?.event.eventId, commit.eventId);
  const before = JSON.stringify(record);
  for (const event of record.view.events) matchBreakpoints(plan, [event]);
  assert.equal(JSON.stringify(record), before);
});

test('compiled points are isolated and unsupported snapshots require disabling active debugger points', () => {
  const config = createExampleCopy('ping_pong');
  const editable = { ...point(config), targetId: 'Done' };
  const settings: BreakpointSettings = { enabled: true, points: [editable] };
  const parsed = compileBreakpoints(config, settings);
  assert.ok(parsed.success);
  editable.targetId = 'absent';
  assert.ok(matchBreakpoints(parsed.value, engine(config).run().events));
  const snapshot = engine(config).snapshot;
  const future = { ...snapshot, engineVersion: 'future' };
  assert.equal(
    compileBreakpoints(config, { enabled: true, points: [point(config)] }, future).success,
    false,
  );
  assert.equal(
    compileBreakpoints(config, { enabled: false, points: [point(config)] }, future).success,
    true,
  );
});

test('observer exceptions leave a resumable paused engine and session replacement fences stale callbacks', () => {
  const config = createExampleCopy('ping_pong');
  const actual = engine(config);
  assert.throws(
    () =>
      actual.runBatch(64, () => {
        throw new Error('observer');
      }),
    /observer/,
  );
  assert.equal(actual.view().status, 'paused');
  assert.deepEqual(actual.run(), engine(config).run());
  const session = createRunSession();
  const old = session.start(config);
  const next = session.start(config);
  assert.ok(old.success && next.success);
  let invoked = false;
  assert.equal(
    session.apply(old.value.runId, (current) =>
      current.runBatch(64, () => {
        invoked = true;
        return true;
      }),
    ),
    false,
  );
  assert.equal(invoked, false);
  assert.equal(next.value.view().events.length, 0);
  session.reset();
  assert.equal(
    session.apply(next.value.runId, () => {
      invoked = true;
    }),
    false,
  );
});

test('stable targets rebind to each frozen revision while changed types and removed targets are rejected', () => {
  const config = createExampleCopy('ping_pong');
  const settings = { enabled: true, points: [point(config)] };
  const edited = editExperiment(config, '/definitions/0/variables/0/initial', 100);
  assert.notEqual(edited.protocols.A.revision, config.protocols.A.revision);
  const plan = compileBreakpoints(edited, settings);
  assert.ok(plan.success);
  const actual = engine(edited);
  const paused = actual.runBatch(64, (events) => !!matchBreakpoints(plan.value, events));
  assert.equal(paused.participants.A.variables.counter, 101);
  assert.equal(paused.participants.A.stateId, 'Waiting');
  const variable = {
    enabled: true,
    points: [point(config, { kind: 'variable', targetId: 'counter', literal: '1' })],
  };
  const changedType = editExperiment(config, '/definitions/0/variables/0/type', 'string');
  assert.equal(compileBreakpoints(changedType, variable).success, false);
  const removed = editExperiment(
    config,
    '/definitions/0/states',
    config.definitions[0]?.states.filter((item) => item.id !== 'Waiting') ?? [],
  );
  assert.equal(compileBreakpoints(removed, settings).success, false);
  assert.equal(settings.points[0]?.protocolRevision, config.protocols.A.revision);
});
