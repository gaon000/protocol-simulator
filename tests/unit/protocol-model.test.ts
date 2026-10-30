import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseExperiment,
  parseProtocolDefinition,
  prepareExperimentSnapshot,
  validateProtocolMessage,
} from '../../src/domain/model-validation.ts';
import type { ValidationResult } from '../../src/domain/protocol-model.ts';
import { experimentFixture, protocolFixture } from '../fixtures/protocol-models.ts';

function fails(result: ValidationResult<unknown>, code: string, path?: string): void {
  assert.equal(result.success, false);
  if (!result.success)
    assert.ok(
      result.diagnostics.some(
        (item) => item.code === code && (path === undefined || item.path === path),
      ),
      JSON.stringify(result.diagnostics),
    );
}

for (const codec of ['json-lines', 'json-datagram', 'logical-packet'] as const) {
  test(`accepts a complete ${codec} definition and self-contained experiment`, () => {
    assert.equal(parseProtocolDefinition(protocolFixture(codec)).success, true);
    assert.equal(parseExperiment(experimentFixture(codec)).success, true);
  });
}

test('fills defaults by stable field ID, retains zero/false, and leaves input unchanged', () => {
  const protocol = protocolFixture();
  const input = { messageId: 'ping', values: { sequence: 0 } };
  const parsed = validateProtocolMessage(protocol, input);
  assert.ok(parsed.success);
  assert.deepEqual(parsed.value.values, { sequence: 0, text: '안녕', mode: 'safe', urgent: false });
  assert.deepEqual(input.values, { sequence: 0 });
});

for (const [label, values, code] of [
  ['required', {}, 'required-field'],
  ['out of range', { sequence: 256 }, 'field-value'],
  ['fractional', { sequence: 1.5 }, 'field-value'],
  ['numeric string', { sequence: '1' }, 'field-value'],
  ['long text', { sequence: 1, text: '123456789' }, 'field-value'],
  ['bad enum', { sequence: 1, mode: 'unknown' }, 'field-value'],
  ['bad boolean', { sequence: 1, urgent: 0 }, 'field-value'],
  ['unknown field', { sequence: 1, extra: true }, 'unknown-field'],
] as const)
  test(`rejects ${label} message values`, () =>
    fails(validateProtocolMessage(protocolFixture(), { messageId: 'ping', values }), code));

test('string length is Unicode code points while byte limits remain a codec concern', () => {
  assert.equal(
    validateProtocolMessage(protocolFixture(), {
      messageId: 'ping',
      values: { sequence: 1, text: '😀'.repeat(8) },
    }).success,
    true,
  );
});

test('reports initial-state and unknown-property errors using JSON pointers', () => {
  fails(
    parseProtocolDefinition({ ...protocolFixture(), initialStateId: 'missing' }),
    'reference',
    '/initialStateId',
  );
  fails(parseProtocolDefinition({ ...protocolFixture(), typo: true }), 'unknown-property', '/typo');
});

test('validates field IDs, wire names, ranges, enum options and defaults', () => {
  const protocol = protocolFixture();
  const message = protocol.messages[0];
  assert.ok(message);
  const field = message.fields[0];
  assert.ok(field);
  const withFields = (fields: unknown) => ({ ...protocol, messages: [{ ...message, fields }] });
  fails(
    parseProtocolDefinition(withFields([field, field])),
    'duplicate-id',
    '/messages/0/fields/1/id',
  );
  fails(parseProtocolDefinition(withFields([field, { ...field, id: 'other' }])), 'duplicate-name');
  fails(parseProtocolDefinition(withFields([{ ...field, min: 9, max: 2 }])), 'range-order');
  fails(parseProtocolDefinition(withFields([{ ...field, defaultValue: 999 }])), 'field-value');
  fails(
    parseProtocolDefinition(withFields([{ ...field, type: 'boolean', min: 1 }])),
    'unknown-property',
  );
  fails(
    parseProtocolDefinition(
      withFields([
        {
          id: 'mode',
          name: 'mode',
          placement: 'body',
          required: true,
          type: 'enum',
          options: ['a', 'a'],
        },
      ]),
    ),
    'duplicate-option',
  );
});

test('validates state, timer, message and variable references', () => {
  const protocol = protocolFixture();
  fails(parseProtocolDefinition({ ...protocol, timers: [] }), 'reference');
  fails(parseProtocolDefinition({ ...protocol, variables: [] }), 'reference');
  fails(parseProtocolDefinition({ ...protocol, messages: [protocol.messages[0]] }), 'reference');
  const rule = protocol.rules[0];
  assert.ok(rule);
  fails(
    parseProtocolDefinition({ ...protocol, rules: [{ ...rule, fromStateId: 'missing' }] }),
    'reference',
  );
  fails(
    parseProtocolDefinition({
      ...protocol,
      rules: [{ ...rule, event: { kind: 'receive', messageId: 'missing' } }],
    }),
    'reference',
  );
});

test('rejects wrong variable, expression, timer and guard types', () => {
  const protocol = protocolFixture();
  const rule = protocol.rules[0];
  assert.ok(rule);
  fails(
    parseProtocolDefinition({
      ...protocol,
      variables: [{ id: 'counter', type: 'integer', initial: 'zero' }],
    }),
    'variable-type',
  );
  fails(
    parseProtocolDefinition({
      ...protocol,
      rules: [
        {
          ...rule,
          actions: [
            { kind: 'assign', variableId: 'counter', value: { kind: 'literal', value: 'oops' } },
          ],
        },
      ],
    }),
    'expression-type',
  );
  fails(
    parseProtocolDefinition({
      ...protocol,
      rules: [
        {
          ...rule,
          actions: [
            {
              kind: 'start-timer',
              timerId: 'response',
              durationMs: { kind: 'literal', value: -1 },
            },
          ],
        },
      ],
    }),
    'number-range',
  );
  fails(
    parseProtocolDefinition({
      ...protocol,
      rules: [
        {
          ...rule,
          condition: {
            kind: 'compare',
            operator: 'gt',
            left: { kind: 'literal', value: true },
            right: { kind: 'literal', value: false },
          },
        },
      ],
    }),
    'condition-type',
  );
});

test('nested guards are checked, and timer events cannot read message fields', () => {
  const protocol = protocolFixture();
  const rule = protocol.rules[0];
  assert.ok(rule);
  const condition = {
    kind: 'not',
    condition: {
      kind: 'all',
      conditions: [
        {
          kind: 'compare',
          operator: 'eq',
          left: { kind: 'literal', value: 1 },
          right: { kind: 'literal', value: 2 },
        },
      ],
    },
  };
  assert.ok(parseProtocolDefinition({ ...protocol, rules: [{ ...rule, condition }] }).success);
  fails(
    parseProtocolDefinition({
      ...protocol,
      rules: [{ ...rule, event: { kind: 'timer', timerId: 'response' } }],
    }),
    'reference',
  );
});

test('requires explicit ignore and rejects statically overlapping rules', () => {
  const protocol = protocolFixture();
  const rule = protocol.rules[0];
  assert.ok(rule);
  fails(
    parseProtocolDefinition({
      ...protocol,
      rules: [{ ...rule, actions: [], nextStateId: rule.fromStateId }],
    }),
    'explicit-ignore',
  );
  fails(
    parseProtocolDefinition({ ...protocol, rules: [{ ...rule, ignore: true }] }),
    'explicit-ignore',
  );
  fails(
    parseProtocolDefinition({ ...protocol, rules: [rule, { ...rule, id: 'duplicate' }] }),
    'rule-conflict',
    '/rules/1',
  );
});

test('rejects codec/service mismatch and incompatible experiment environment', () => {
  fails(
    parseProtocolDefinition({ ...protocolFixture(), lowerService: 'datagram' }),
    'service-incompatible',
  );
  const experiment = experimentFixture();
  fails(
    parseExperiment({ ...experiment, environment: experimentFixture('json-datagram').environment }),
    'service-incompatible',
    '/protocols/A',
  );
  fails(
    parseExperiment({
      ...experiment,
      protocols: { ...experiment.protocols, B: { id: 'missing', revision: 1 } },
    }),
    'reference',
    '/protocols/B',
  );
});

test('rejects duplicate revisions and malformed seed/rates/environment settings', () => {
  const experiment = experimentFixture();
  fails(
    parseExperiment({
      ...experiment,
      definitions: [...experiment.definitions, ...experiment.definitions],
    }),
    'duplicate-revision',
  );
  fails(parseExperiment({ ...experiment, seed: -1 }), 'number-range', '/seed');
  const environment = experiment.environment;
  assert.equal(environment.kind, 'stream');
  fails(
    parseExperiment({
      ...experiment,
      environment: {
        ...environment,
        directions: { ...environment.directions, AtoB: { delayMs: 10, chunkBytes: 0 } },
      },
    }),
    'number-range',
  );
  const datagram = experimentFixture('json-datagram');
  fails(
    parseExperiment({
      ...datagram,
      environment: {
        ...datagram.environment,
        directions: {
          ...datagram.environment.directions,
          AtoB: { delayMs: 0, jitterMs: 0, lossRate: 1.1, duplicateRate: 0 },
        },
      },
    }),
    'number-range',
  );
});

test('validates scenario values, references, IDs, observation periods and expectation count', () => {
  const experiment = experimentFixture();
  const input = experiment.scenario.inputs[0];
  assert.ok(input);
  const scenario = experiment.scenario;
  fails(
    parseExperiment({
      ...experiment,
      scenario: { ...scenario, inputs: [{ ...input, timeMs: 601 }] },
    }),
    'observation-window',
  );
  fails(
    parseExperiment({ ...experiment, scenario: { ...scenario, inputs: [input, input] } }),
    'duplicate-id',
  );
  fails(
    parseExperiment({
      ...experiment,
      scenario: { ...scenario, inputs: [{ ...input, message: { messageId: 'ping', values: {} } }] },
    }),
    'required-field',
  );
  fails(parseExperiment({ ...experiment, scenario: { ...scenario, expectations: [] } }), 'empty');
  fails(
    parseExperiment({
      ...experiment,
      scenario: {
        ...scenario,
        expectations: [{ id: 'state', participant: 'A', kind: 'state', stateId: 'absent' }],
      },
    }),
    'reference',
  );
  fails(
    parseExperiment({
      ...experiment,
      scenario: {
        ...scenario,
        expectations: [
          { id: 'deadline', participant: 'A', kind: 'completion-before', timeMs: 1000 },
        ],
      },
    }),
    'observation-window',
  );
});

test('malformed non-JSON data fails with diagnostics, not an uncaught exception', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const value of [
    null,
    [],
    { x: undefined },
    { x: Number.NaN },
    { x: () => 1 },
    new Date(),
    cyclic,
  ]) {
    assert.equal(parseExperiment(value).success, false);
  }
  const value = {
    ...experimentFixture(),
    get secret() {
      throw new Error('must not read getters');
    },
  };
  fails(parseExperiment(value), 'json-accessor');
});

test('validated snapshots survive JSON round trips and reject invalid drafts', () => {
  const experiment = experimentFixture();
  const result = prepareExperimentSnapshot(experiment);
  assert.ok(result.success);
  assert.deepEqual(JSON.parse(JSON.stringify(result.value)), result.value);
  assert.ok(Object.isFrozen(result.value.configuration.definitions));
  assert.equal(Reflect.set(experiment, 'seed', 1), true);
  assert.equal(result.value.seed, 42);
  fails(prepareExperimentSnapshot({ ...experiment, seed: -1 }), 'number-range');
});

test('finish must be last and the next state must be terminal', () => {
  const protocol = protocolFixture();
  const rule = protocol.rules[0];
  assert.ok(rule);
  fails(
    parseProtocolDefinition({
      ...protocol,
      rules: [
        {
          ...rule,
          nextStateId: 'Done',
          actions: [{ kind: 'finish', outcome: 'success' }, ...rule.actions],
        },
      ],
    }),
    'finish-order',
  );
  fails(
    parseProtocolDefinition({
      ...protocol,
      rules: [{ ...rule, actions: [{ kind: 'finish', outcome: 'success' }] }],
    }),
    'terminal-state',
  );
});

test('missing and null properties throughout an experiment produce diagnostics without throwing', () => {
  const source = experimentFixture();
  const paths: string[][] = [];
  function collect(value: unknown, path: string[]): void {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      paths.push([...path, key]);
      collect(child, [...path, key]);
    }
  }
  collect(source, []);
  for (const path of paths) {
    for (const remove of [false, true]) {
      const draft = structuredClone(source);
      let parent: object = draft;
      for (const key of path.slice(0, -1)) {
        const child: unknown = Reflect.get(parent, key);
        assert.ok(child && typeof child === 'object');
        parent = child;
      }
      const key = path.at(-1);
      assert.ok(key);
      if (remove) Reflect.deleteProperty(parent, key);
      else Reflect.set(parent, key, null);
      assert.doesNotThrow(() => parseExperiment(draft), path.join('/'));
    }
  }
});
