import type {
  Condition,
  ExperimentDefinition,
  ValueExpression,
} from '../../src/domain/protocol-model.ts';
import { createExampleCopy } from '../../src/examples/catalog.ts';

const literal = (value: number): ValueExpression => ({ kind: 'literal', value });
const variable = (variableId: string): ValueExpression => ({ kind: 'variable', variableId });
const compare = (left: ValueExpression, right: ValueExpression): Condition => ({
  kind: 'compare',
  operator: 'eq',
  left,
  right,
});
/** Build a real short-circuit and sequential-assignment experiment for core and browser evidence. */
export function createExplanationExperiment(): ExperimentDefinition {
  const base = createExampleCopy('ping_pong');
  const original = base.definitions[0];
  if (!original) throw new Error('Missing protocol fixture');
  return {
    ...base,
    definitions: [
      {
        ...original,
        variables: [
          { id: 'count', type: 'integer', initial: 0 },
          { id: 'copy', type: 'integer', initial: 0 },
          { id: 'maximum', type: 'integer', initial: Number.MAX_SAFE_INTEGER },
        ],
        rules: [
          {
            id: 'calculate',
            fromStateId: 'Idle',
            event: { kind: 'input', messageId: 'ping' },
            condition: {
              kind: 'all',
              conditions: [
                compare({ kind: 'field', fieldId: 'sequence' }, literal(1)),
                {
                  kind: 'any',
                  conditions: [
                    compare(variable('count'), literal(0)),
                    compare(
                      { kind: 'add', left: variable('maximum'), right: literal(1) },
                      literal(0),
                    ),
                  ],
                },
                { kind: 'not', condition: compare(variable('count'), literal(1)) },
              ],
            },
            actions: [
              {
                kind: 'assign',
                variableId: 'count',
                value: { kind: 'add', left: variable('count'), right: literal(1) },
              },
              {
                kind: 'assign',
                variableId: 'count',
                value: { kind: 'add', left: variable('count'), right: literal(2) },
              },
              { kind: 'assign', variableId: 'copy', value: variable('count') },
              { kind: 'finish', outcome: 'success' },
            ],
            nextStateId: 'Done',
          },
        ],
      },
    ],
    scenario: {
      ...base.scenario,
      expectations: [{ id: 'done', kind: 'state', participant: 'A', stateId: 'Done' }],
    },
  };
}
