import assert from 'node:assert/strict';
import test from 'node:test';
import { createSimulation } from '../../src/application/create-simulation.ts';
import { buildDiagramLinks, inspectDiagramLinks } from '../../src/application/diagram-links.ts';
import { editExperiment } from '../../src/application/edit-experiment.ts';
import {
  EXPLANATION_POLICY,
  explainExecution,
} from '../../src/application/execution-explanation.ts';
import { projectRecord } from '../../src/application/replay-record.ts';
import {
  captureRun,
  createWorkspace,
  exportWorkspace,
} from '../../src/application/workspace-operations.ts';
import type { JsonObject } from '../../src/domain/execution-contract.ts';
import type {
  EngineView,
  ExperimentDefinition,
  ValueExpression,
} from '../../src/domain/protocol-model.ts';
import { parseWorkspaceBundle } from '../../src/domain/workspace-validation.ts';
import { createExampleCopy, EXAMPLES } from '../../src/examples/catalog.ts';
import { createExplanationExperiment as fixture } from '../fixtures/explanation-experiment.ts';
import {
  createEventLimitExperiment,
  createMessageLimitExperiment,
} from '../fixtures/large-experiments.ts';

const literal = (value: number): ValueExpression => ({ kind: 'literal', value });
function run(config: ExperimentDefinition): EngineView {
  const created = createSimulation(config);
  assert.ok(created.success, JSON.stringify(created));
  return created.value.run();
}

test('every observed catalog transition reconstructs from its own snapshot and verifies recorded variables', () => {
  for (const example of EXAMPLES) {
    const view = run(createExampleCopy(example.id));
    const links = buildDiagramLinks(view);
    for (const transition of links.transitions) {
      const explanation = explainExecution(view, links, transition.eventId);
      assert.equal(
        explanation.status,
        'verified',
        `${example.id}/${transition.ruleId}: ${explanation.message}`,
      );
    }
  }
});

test('guards preserve nested boolean short-circuit and assignments use staged values in order', () => {
  const view = run(fixture());
  const links = buildDiagramLinks(view);
  const transition = links.transitions[0];
  assert.ok(transition);
  const explanation = explainExecution(view, links, transition.eventId);
  assert.equal(explanation.status, 'verified');
  assert.match(
    explanation.candidates[0]?.conditions.find((row) => row.result === 'skipped')?.detail ?? '',
    /앞 조건이 참/,
  );
  assert.equal(explanation.assignments[0]?.before, '0');
  assert.equal(explanation.assignments[0]?.value, '1');
  assert.equal(explanation.assignments[1]?.before, '1');
  assert.equal(explanation.assignments[1]?.value, '3');
  assert.equal(explanation.assignments[2]?.value, '3');
  assert.match(explanation.assignments[0]?.expression ?? '', /변수 count\(0\)/);
  assert.deepEqual(explanation.changes.find((row) => row.id === 'count')?.assignments, [0, 1]);
});

test('retry candidates explain selected and rejected conditions using before values, not current values', () => {
  const view = run(
    editExperiment(createExampleCopy('stop_wait'), '/environment/directions/AtoB/lossRate', 1),
  );
  const links = buildDiagramLinks(view);
  const retries = links.transitions.filter((event) => event.ruleId === 'retry');
  const first = retries[0];
  const last = retries[2];
  assert.ok(first && last);
  const explanation = explainExecution(view, links, first.eventId);
  assert.equal(explanation.status, 'verified');
  assert.deepEqual(
    explanation.candidates.map((candidate) => [candidate.id, candidate.result]),
    [
      ['retry', true],
      ['exhausted', false],
    ],
  );
  assert.equal(explanation.assignments[0]?.before, '0');
  assert.equal(explanation.assignments[0]?.value, '1');
  assert.equal(explainExecution(view, links, last.eventId).assignments[0]?.before, '2');
  assert.equal(view.participants.A.variables.retries, 3);
});

test('a cursor before commit cannot expose a later explanation through an input, action or transition ID', () => {
  const view = run(createExampleCopy('ping_pong'));
  const transition = view.events.find((event) => event.kind === 'transition');
  const sent = view.events.find((event) => event.kind === 'send');
  assert.ok(transition && sent);
  const links = buildDiagramLinks(view, transition.sequence);
  assert.equal(explainExecution(view, links, transition.eventId).status, 'unavailable');
  assert.equal(inspectDiagramLinks(links, view, sent.eventId)?.focusedTransition, undefined);
  assert.equal(explainExecution(view, links, sent.eventId).status, 'unavailable');
  const projected = projectRecord(
    captureRun(view, 'experiment_fixture', 1),
    transition.sequence + 1,
  );
  const prefix = buildDiagramLinks(projected, transition.sequence + 1);
  assert.equal(explainExecution(projected, prefix, transition.eventId).status, 'verified');
});

test('different draft edits and reloaded records cannot rewrite a frozen explanation', () => {
  const view = run(fixture());
  const data = createWorkspace(fixture());
  const record = captureRun(view, data.activeDraftId, 1);
  const exported = exportWorkspace({ ...data, runs: [record] });
  assert.ok(exported.success);
  const imported = parseWorkspaceBundle(exported.value);
  assert.ok(imported.success);
  const restored = imported.value.data.runs[0]?.view;
  assert.ok(restored);
  const links = buildDiagramLinks(restored);
  const transition = links.transitions[0];
  assert.ok(transition);
  const initial = explainExecution(restored, links, transition.eventId);
  const draft = data.drafts[0];
  assert.ok(draft);
  const edited = editExperiment(draft.configuration, '/definitions/0/variables/0/initial', 100);
  assert.equal(edited.definitions[0]?.variables[0]?.initial, 100);
  assert.deepEqual(explainExecution(restored, links, transition.eventId), initial);
  assert.equal(initial.status, 'verified');
});

test('atomic assignment failure has no committed transition and is never explained as applied', () => {
  const base = fixture();
  const overflow = editExperiment(
    base,
    '/definitions/0/rules/0/actions/1/value/right/value',
    Number.MAX_SAFE_INTEGER,
  );
  const view = run(overflow);
  assert.equal(view.participants.A.variables.count, 0);
  assert.equal(view.participants.A.outcome, 'error');
  const links = buildDiagramLinks(view);
  assert.equal(links.transitions.length, 0);
  const diagnostic = view.events.find((event) => event.kind === 'diagnostic');
  assert.ok(diagnostic);
  assert.equal(explainExecution(view, links, diagnostic.eventId).status, 'unavailable');
});

test('tampered recorded variables and unknown snapshot versions never claim verified calculations', () => {
  const view = run(fixture());
  const changed = structuredClone(view);
  const transition = changed.events.find((event) => event.kind === 'transition');
  assert.ok(transition);
  const after = (transition.data as JsonObject).after as JsonObject;
  (after.variables as Record<string, number>).count = 99;
  assert.equal(
    explainExecution(changed, buildDiagramLinks(changed), transition.eventId).status,
    'inconsistent',
  );
  const unknown = { ...view, snapshot: { ...view.snapshot, engineVersion: 'future-engine' } };
  assert.equal(
    explainExecution(unknown, buildDiagramLinks(unknown), transition.eventId).status,
    'unavailable',
  );
});

test('same-value and repeated writes remain visible even when final variables do not change', () => {
  let config = fixture();
  config = editExperiment(config, '/definitions/0/rules/0/actions/1/value', literal(0));
  const view = run(config);
  const links = buildDiagramLinks(view);
  const id = links.transitions[0]?.eventId;
  assert.ok(id);
  const explanation = explainExecution(view, links, id);
  assert.equal(explanation.status, 'verified');
  assert.equal(explanation.assignments.length, 3);
  assert.equal(explanation.changes.length, 0);
});

test('large values and deep conditions stop within explicit explanation budgets without copying wire data', () => {
  const base = fixture();
  const original = base.definitions[0];
  assert.ok(original);
  const config = {
    ...base,
    definitions: [
      {
        ...original,
        variables: [
          ...original.variables,
          {
            id: 'large',
            type: 'json' as const,
            initial: 'a'.repeat(EXPLANATION_POLICY.valueCharacters + 1),
          },
        ],
      },
    ],
  };
  const view = run(config);
  const links = buildDiagramLinks(view);
  const id = links.transitions[0]?.eventId;
  assert.ok(id);
  assert.equal(explainExecution(view, links, id).status, 'limited');
  const largeView = run(createMessageLimitExperiment());
  const largeLinks = buildDiagramLinks(largeView);
  const transition = largeLinks.transitions[0];
  assert.ok(transition);
  assert.equal(explainExecution(largeView, largeLinks, transition.eventId).status, 'verified');
  assert.equal(
    JSON.stringify(explainExecution(largeView, largeLinks, transition.eventId)).includes('aaaaaa'),
    false,
  );
});

test('10k repeated events explain one observed occurrence with bounded output', () => {
  const view = run(createEventLimitExperiment());
  assert.equal(view.events.length, 10_000);
  const links = buildDiagramLinks(view);
  const last = links.transitions.at(-1);
  assert.ok(last);
  const explanation = explainExecution(view, links, last.eventId);
  assert.equal(explanation.status, 'verified');
  assert.ok(JSON.stringify(explanation).length < 4096);
});

test('AND rejects a candidate without evaluating its invalid arithmetic branch', () => {
  const base = fixture();
  const protocol = base.definitions[0];
  assert.ok(protocol);
  const rejected = {
    id: 'reject',
    fromStateId: 'Idle',
    nextStateId: 'Done',
    event: { kind: 'input' as const, messageId: 'ping' },
    actions: [],
    condition: {
      kind: 'all' as const,
      conditions: [
        {
          kind: 'compare' as const,
          operator: 'eq' as const,
          left: { kind: 'variable' as const, variableId: 'count' },
          right: literal(1),
        },
        {
          kind: 'compare' as const,
          operator: 'eq' as const,
          left: {
            kind: 'add' as const,
            left: { kind: 'variable' as const, variableId: 'maximum' },
            right: literal(1),
          },
          right: literal(0),
        },
      ],
    },
  };
  const view = run({
    ...base,
    definitions: [{ ...protocol, rules: [rejected, ...protocol.rules] }],
  });
  const links = buildDiagramLinks(view);
  const id = links.transitions[0]?.eventId;
  assert.ok(id);
  const reason = explainExecution(view, links, id);
  assert.equal(reason.status, 'verified');
  assert.equal(reason.candidates[0]?.result, false);
  assert.match(
    reason.candidates[0]?.conditions.find((row) => row.result === 'skipped')?.detail ?? '',
    /앞 조건이 거짓/,
  );
});

test('deep conditions and long assignment programs stop at calculation budgets', () => {
  const base = fixture();
  let condition: import('../../src/domain/protocol-model.ts').Condition = {
    kind: 'compare',
    operator: 'eq',
    left: literal(1),
    right: literal(1),
  };
  for (let index = 0; index < 40; index++) condition = { kind: 'not', condition };
  for (const config of [
    editExperiment(base, '/definitions/0/rules/0/condition', condition),
    editExperiment(base, '/definitions/0/rules/0/actions', [
      ...Array.from({ length: 1100 }, () => ({
        kind: 'assign',
        variableId: 'count',
        value: literal(0),
      })),
      { kind: 'finish', outcome: 'success' },
    ]),
  ]) {
    const view = run(config);
    const links = buildDiagramLinks(view);
    const id = links.transitions[0]?.eventId;
    assert.ok(id);
    assert.equal(explainExecution(view, links, id).status, 'limited');
  }
});

test('structural JSON comparisons and defaulted input fields use engine semantics and mark value summaries', () => {
  const base = fixture();
  const protocol = base.definitions[0];
  assert.ok(protocol);
  const value = { first: Array.from({ length: 40 }, (_, index) => index), second: true };
  const config = {
    ...base,
    definitions: [
      {
        ...protocol,
        variables: [...protocol.variables, { id: 'json', type: 'json' as const, initial: value }],
        rules: protocol.rules.map((rule) => ({
          ...rule,
          condition: {
            kind: 'all' as const,
            conditions: [
              {
                kind: 'compare' as const,
                operator: 'eq' as const,
                left: { kind: 'variable' as const, variableId: 'json' },
                right: { kind: 'literal' as const, value: { second: true, first: value.first } },
              },
              {
                kind: 'compare' as const,
                operator: 'eq' as const,
                left: { kind: 'field' as const, fieldId: 'mode' },
                right: { kind: 'literal' as const, value: 'safe' },
              },
            ],
          },
        })),
      },
    ],
  };
  const view = run(config);
  const links = buildDiagramLinks(view);
  const id = links.transitions[0]?.eventId;
  assert.ok(id);
  const reason = explainExecution(view, links, id);
  assert.equal(reason.status, 'verified');
  assert.ok(reason.candidates[0]?.conditions.some((row) => row.detail.includes('값 요약')));
  assert.ok(
    reason.candidates[0]?.conditions.some((row) => row.detail.includes('필드 mode("safe")')),
  );
});
