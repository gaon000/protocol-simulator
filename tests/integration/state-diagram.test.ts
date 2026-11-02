import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appliedDiagramRule,
  buildStateDiagram,
  DIAGRAM_POLICY,
  diagramProtocolsMatch,
  matchingDiagramDefinition,
} from '../../src/application/state-diagram.ts';
import { createSimulation } from '../../src/application/create-simulation.ts';
import { editExperiment } from '../../src/application/edit-experiment.ts';
import type { ProtocolDefinition } from '../../src/domain/protocol-model.ts';
import { EXAMPLES, getExampleOriginal } from '../../src/examples/catalog.ts';

function protocol() {
  const value = getExampleOriginal('ping_pong').definitions[0];
  assert.ok(value);
  return value;
}

test('all catalog definitions expose every rule, initial/terminal state and finite route without modifying originals', () => {
  for (const example of EXAMPLES)
    for (const definition of getExampleOriginal(example.id).definitions) {
      const before = JSON.stringify(definition);
      const seen: number[] = [];
      for (
        let rulePage = 0;
        rulePage < Math.max(1, Math.ceil(definition.rules.length / DIAGRAM_POLICY.rulesPerPage));
        rulePage++
      ) {
        const graph = buildStateDiagram(definition, { rulePage });
        seen.push(...graph.edges.flatMap((edge) => edge.ruleIndices));
        assert.ok(
          graph.nodes.some((node) => node.initial && node.id === definition.initialStateId),
        );
        assert.equal(
          graph.nodes.filter((node) => node.terminal).length,
          definition.states.filter((state) => state.terminal).length,
        );
        for (const edge of graph.edges) {
          assert.ok(graph.nodes.some((node) => node.key === edge.from));
          assert.ok(graph.nodes.some((node) => node.key === edge.to));
          assert.ok(!/NaN|Infinity/.test(edge.path));
          assert.ok(edge.labelX >= 0 && edge.labelX < graph.width);
          assert.ok(edge.labelY >= 0 && edge.labelY < graph.height);
          for (const other of graph.edges)
            if (other !== edge)
              assert.ok(
                Math.abs(edge.labelX - other.labelX) >= 108 ||
                  Math.abs(edge.labelY - other.labelY) >= 44,
                `${example.id}: overlapping rule labels`,
              );
          for (const node of graph.nodes)
            assert.ok(
              edge.labelX + 54 <= node.x ||
                edge.labelX - 54 >= node.x + 170 ||
                edge.labelY + 22 <= node.y ||
                edge.labelY - 22 >= node.y + 92,
              `${example.id}: label obscures a state`,
            );
        }
      }
      assert.deepEqual(
        seen.sort((a, b) => a - b),
        definition.rules.map((_, index) => index),
      );
      assert.equal(JSON.stringify(definition), before);
    }
});

test('parallel rules keep their own identities inside a grouped arrow, including repeated IDs in an invalid draft', () => {
  const base = protocol();
  const start = base.rules[0];
  assert.ok(start);
  const invalid = {
    ...base,
    rules: [
      start,
      {
        ...start,
        condition: {
          kind: 'compare' as const,
          operator: 'eq' as const,
          left: { kind: 'literal' as const, value: 1 },
          right: { kind: 'literal' as const, value: 1 },
        },
      },
    ],
  };
  const graph = buildStateDiagram(invalid);
  assert.equal(graph.edges.length, 1);
  assert.deepEqual(graph.edges[0]?.ruleIndices, [0, 1]);
  assert.deepEqual(graph.visibleRules, [0, 1]);
});

test('self loops, reverse transitions and disconnected states remain selectable graph data', () => {
  const base = protocol();
  const start = base.rules[0];
  assert.ok(start);
  const value = {
    ...base,
    states: [...base.states, { id: 'Disconnected', label: '독립 상태' }],
    rules: [
      start,
      { ...start, id: 'self', nextStateId: start.fromStateId },
      { ...start, id: 'reverse', fromStateId: start.nextStateId, nextStateId: start.fromStateId },
    ],
  };
  const graph = buildStateDiagram(value);
  assert.equal(graph.edges.length, 3);
  assert.ok(graph.edges.some((edge) => edge.from === edge.to));
  assert.ok(graph.nodes.some((node) => node.id === 'Disconnected'));
  assert.ok(graph.edges.every((edge) => edge.path.startsWith('M ') && edge.path.includes(' C ')));
});

test('missing, ambiguous and empty references never silently choose one declared state', () => {
  const base = protocol();
  const start = base.rules[0];
  assert.ok(start);
  const value = {
    ...base,
    initialStateId: '',
    states: [
      { id: 'same', label: '첫 상태' },
      { id: 'same', label: '두 번째 상태' },
      { id: '', label: '빈 ID' },
    ],
    rules: [
      { ...start, fromStateId: 'absent', nextStateId: 'same' },
      { ...start, fromStateId: '', nextStateId: 'absent' },
    ],
  };
  const graph = buildStateDiagram(value);
  assert.ok(
    graph.nodes.some(
      (node) =>
        node.id === 'same' && node.stateIndex === undefined && node.problem === '중복 ID 참조',
    ),
  );
  assert.equal(
    graph.nodes.filter((node) => node.id === 'same' && node.stateIndex !== undefined).length,
    2,
  );
  assert.ok(graph.nodes.some((node) => node.id === 'absent' && node.problem === '없는 상태 참조'));
  assert.ok(graph.nodes.some((node) => node.initial && node.problem === '빈 상태 참조'));
  assert.ok(
    graph.edges.every(
      (edge) => edge.from.startsWith('reference-') && edge.to.startsWith('reference-'),
    ),
  );
});

test('large graphs paginate every declaration while including remote endpoints and current/initial states within a bounded page', () => {
  const base = protocol();
  const start = base.rules[0];
  assert.ok(start);
  const value: ProtocolDefinition = {
    ...base,
    initialStateId: 'S0',
    states: Array.from({ length: 203 }, (_, index) => ({
      id: `S${index}`,
      label: `상태 ${index}`,
    })),
    rules: Array.from({ length: 205 }, (_, index) => ({
      ...start,
      id: `r${index}`,
      fromStateId: `S${index % 203}`,
      nextStateId: `S${(index + 1) % 203}`,
    })),
  };
  const first = buildStateDiagram(value, { rulePage: 7, currentStateIds: ['S202', 'S201'] });
  assert.equal(first.statePages, 6);
  assert.equal(first.rulePages, 11);
  assert.ok(first.nodes.length <= 83);
  for (const id of ['S0', 'S140', 'S160', 'S202', 'S201'])
    assert.ok(
      first.nodes.some((node) => node.id === id),
      id,
    );
  const declared = new Set<number>();
  const rules = new Set<number>();
  for (let index = 0; index < first.statePages; index++)
    for (const node of buildStateDiagram(value, { statePage: index }).nodes)
      if (node.stateIndex !== undefined) declared.add(node.stateIndex);
  for (let index = 0; index < first.rulePages; index++)
    for (const rule of buildStateDiagram(value, { rulePage: index }).visibleRules) rules.add(rule);
  assert.equal(declared.size, value.states.length);
  assert.equal(rules.size, value.rules.length);
  assert.equal(buildStateDiagram(value, { statePage: -2, rulePage: Number.NaN }).statePage, 0);
  assert.equal(buildStateDiagram(value, { statePage: 999, rulePage: 999 }).rulePage, 10);
  assert.equal(buildStateDiagram(value, { rulePage: Infinity }).rulePage, 0);
});

test('applied-rule highlighting respects cursor boundaries, committed transitions and independent participants', () => {
  const config = getExampleOriginal('ping_pong');
  const source = protocol();
  const created = createSimulation(config);
  assert.ok(created.success);
  const view = created.value.run();
  const before = JSON.stringify(view);
  const firstA = view.events.findIndex(
    (event) => event.kind === 'transition' && event.participant === 'A',
  );
  assert.ok(firstA > 0);
  assert.equal(appliedDiagramRule(view, 'A', source, firstA), undefined);
  assert.equal(appliedDiagramRule(view, 'A', source, firstA + 1), 0);
  assert.equal(appliedDiagramRule(view, 'B', source, firstA + 1), undefined);
  assert.equal(source.rules[appliedDiagramRule(view, 'A', source) ?? -1]?.id, 'complete');
  assert.equal(source.rules[appliedDiagramRule(view, 'B', source) ?? -1]?.id, 'reply');
  assert.equal(appliedDiagramRule(view, 'A', source, -1), undefined);
  assert.equal(appliedDiagramRule(view, 'A', source, Infinity), undefined);
  assert.equal(appliedDiagramRule(view, 'A', { ...source, label: '다른 모델' }), undefined);
  assert.equal(JSON.stringify(view), before);
});

test('snapshot editing requires content and revision equality and resolves the exact definition index', () => {
  const config = getExampleOriginal('ping_pong');
  const source = protocol();
  assert.equal(diagramProtocolsMatch(source, structuredClone(source)), true);
  assert.equal(matchingDiagramDefinition(config, source), 0);
  assert.equal(
    matchingDiagramDefinition(
      editExperiment(config, '/definitions/0/rules/0/nextStateId', 'Failed'),
      source,
    ),
    undefined,
  );
  assert.equal(
    matchingDiagramDefinition(
      { ...config, definitions: [{ ...source, label: 'same IDs, other experiment' }] },
      source,
    ),
    undefined,
  );
  assert.equal(
    matchingDiagramDefinition(
      { ...config, definitions: [{ ...source, revision: 8 }, source] },
      source,
    ),
    1,
  );
  assert.equal(diagramProtocolsMatch(source, { ...source, revision: 2 }), false);
});
