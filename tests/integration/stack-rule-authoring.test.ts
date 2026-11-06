import assert from 'node:assert/strict';
import test from 'node:test';
import { editStackExperiment } from '../../src/application/edit-stack.ts';
import { createStackSimulation } from '../../src/application/create-stack-simulation.ts';
import {
  blockingRuleRaw,
  editStackRuleList,
  ruleAction,
  ruleCondition,
  ruleEvent,
  ruleExpression,
  ruleFormFocusPages,
  ruleFormTreePaths,
  ruleLiteral,
  stackRuleValueContext,
} from '../../src/application/stack-rule-authoring.ts';
import {
  createStackDraft,
  createWorkspaceV2,
} from '../../src/application/workspace-v2-operations.ts';
import { createWorkspace } from '../../src/application/workspace-operations.ts';
import { valueAt } from '../../src/domain/json-pointer.ts';
import { parseStackExpression } from '../../src/domain/stack-expressions.ts';
import { stackObject, stackTarget } from '../../src/domain/stack-record.ts';
import {
  type StackProtocol,
  type StackRule,
  stackProtocolBody,
} from '../../src/domain/stack-model.ts';
import { parseStackExperiment } from '../../src/domain/stack-validation.ts';
import { parseWorkspaceV2 } from '../../src/domain/workspace-v2-validation.ts';
import {
  createStackExampleCopy,
  STACK_EXAMPLES,
} from '../../src/examples/reliable-stack-examples.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';

const appActions = '/definitions/0/source/rules/0/actions';
function draft() {
  return createStackDraft(createStackExampleCopy('stack_ping_pong'));
}
function body(protocol: StackProtocol) {
  return stackProtocolBody(protocol);
}
function first(protocol: StackProtocol) {
  const rule = body(protocol).rules[0];
  assert.ok(rule);
  return rule;
}

for (const example of STACK_EXAMPLES)
  test(`${example.id} authoring reads every original rule without changing its expressions or snapshot`, () => {
    const config = createStackExampleCopy(example.id);
    const original = JSON.stringify(config);
    for (const protocol of config.definitions)
      for (const rule of body(protocol).rules) {
        const context = stackRuleValueContext(protocol, rule);
        for (const action of rule.actions)
          assert.equal(ruleAction(action.kind, protocol, context, action), action);
        const paths = ruleFormTreePaths(rule, 0, '/rule', {});
        assert.ok(paths.size <= 48);
        assert.deepEqual([...paths], [...ruleFormTreePaths(rule, 0, '/rule', {})]);
      }
    assert.equal(JSON.stringify(config), original);
  });

test('scope comes only from the exact input/receive or service operation and preserves stable IDs', () => {
  const config = draft().configuration;
  const application = config.definitions[0];
  const transport = config.definitions.find((p) => p.mode === 'stack-protocol');
  assert.ok(application && transport);
  const rule = first(application);
  assert.ok(
    stackRuleValueContext(application, rule).fields.some(
      (f) => f.id === 'sequence' && f.name === 'number',
    ),
  );
  assert.equal(
    stackRuleValueContext(application, { ...rule, event: { kind: 'timer', timerId: 'response' } })
      .fields.length,
    0,
  );
  const request = { ...first(transport), event: ruleEvent('service-request', transport) };
  assert.equal(stackRuleValueContext(transport, request).payload, 'bytes');
  const failure = {
    ...request,
    event: {
      kind: 'service-indication' as const,
      portId: transport.requires.id,
      operation: 'failed' as const,
    },
  };
  assert.equal(stackRuleValueContext(transport, failure).payload, undefined);
});

test('all native expression defaults parse and arithmetic/boolean kind changes retain compatible children', () => {
  const protocol = draft().configuration.definitions.find((p) => p.mode === 'stack-protocol');
  assert.ok(protocol);
  const context = stackRuleValueContext(protocol, first(protocol));
  for (const kind of [
    'literal',
    'variable',
    'field',
    'service-payload',
    'add',
    'subtract',
    'byteLength',
    'slice',
    'concat',
  ] as const)
    assert.equal(parseStackExpression(ruleExpression(kind, context)).success, true);
  const original = ruleExpression('add', context);
  assert.equal(original.kind, 'add');
  if (original.kind !== 'add') assert.fail();
  const changed = ruleExpression('subtract', context, 'integer', original);
  assert.equal(changed.kind, 'subtract');
  if (changed.kind !== 'subtract') assert.fail();
  assert.equal(changed.left, original.left);
  const compare = ruleCondition('compare');
  const all = ruleCondition('all', compare);
  assert.equal(all.kind, 'all');
  if (all.kind !== 'all') assert.fail();
  const any = ruleCondition('any', all);
  assert.equal(any.kind, 'any');
  if (any.kind !== 'any') assert.fail();
  assert.equal(any.conditions, all.conditions);
  assert.equal(any.conditions[0], compare);
  assert.equal(stackObject(ruleLiteral('bytes')).kind, 'bytes');
  assert.equal(ruleLiteral('json'), null);
});

test('message action switches preserve authored expressions instead of silently dropping unavailable fields', () => {
  const p = draft().configuration.definitions[0];
  assert.ok(p);
  const context = stackRuleValueContext(p, first(p));
  const action = ruleAction('send', p, context);
  const next = ruleAction('deliver', p, context, action);
  assert.equal(next.kind, 'deliver');
  if (next.kind !== 'deliver' || action.kind !== 'send') assert.fail();
  assert.equal(next.values, action.values);
  assert.equal(next.messageId, action.messageId);
});

test('moving an action changes actual sequential execution and updates exact draft/definition revisions only once', () => {
  const initial = draft();
  const original = {
    ...initial,
    configuration: editStackExperiment(initial.configuration, `${appActions}/1/values/sequence`, {
      kind: 'variable',
      variableId: 'counter',
    }),
  };
  const snapshot = JSON.stringify(original);
  const moved = editStackRuleList(original, appActions, { kind: 'move', from: 0, to: 1 }, 123);
  assert.equal(moved.version, original.version + 1);
  assert.equal(moved.updatedAt, 123);
  assert.equal(
    moved.configuration.definitions[0]?.revision,
    (original.configuration.definitions[0]?.revision ?? 0) + 1,
  );
  assert.equal(
    moved.configuration.nodes.A.instances[0]?.definition.revision,
    moved.configuration.definitions[0]?.revision,
  );
  assert.equal(
    moved.configuration.nodes.B.instances[0]?.definition.revision,
    moved.configuration.definitions[0]?.revision,
  );
  assert.equal(parseStackExperiment(moved.configuration).success, true);
  const sent = (configuration: typeof original.configuration) => {
    const result = createStackSimulation(configuration);
    if (!result.success) assert.fail(JSON.stringify(result.diagnostics));
    const view = result.value.run();
    return view.events.find((e) => e.kind === 'send' && stackTarget(e.endpoint) === 'A/app');
  };
  const before = stackObject(stackObject(sent(original.configuration)?.data).message);
  const after = stackObject(stackObject(sent(moved.configuration)?.data).message);
  assert.equal(stackObject(before.values).sequence, 1);
  assert.equal(stackObject(after.values).sequence, 0);
  assert.equal(JSON.stringify(original), snapshot);
});

test('move, duplicate, delete and append retain pending child text on its actual action occurrence', () => {
  const original = draft();
  const at = `${appActions}/0/value/right/value`;
  assert.notEqual(valueAt(original.configuration, at), undefined);
  const raw = {
    ...original,
    raw: {
      [at]: 'number:-',
      [`${appActions}/1/values/sequence`]: '{',
      '/scenario/inputs/0/message': '{',
    },
  };
  const moved = editStackRuleList(raw, appActions, { kind: 'move', from: 0, to: 2 });
  assert.equal(moved.raw[`${appActions}/2/value/right/value`], 'number:-');
  assert.equal(moved.raw[`${appActions}/0/values/sequence`], '{');
  const copied = editStackRuleList(moved, appActions, { kind: 'duplicate', index: 2 });
  assert.equal(copied.raw[`${appActions}/3/value/right/value`], 'number:-');
  const removed = editStackRuleList(copied, appActions, { kind: 'remove', index: 2 });
  assert.equal(removed.raw[`${appActions}/2/value/right/value`], 'number:-');
  assert.equal(removed.raw[`${appActions}/3/value/right/value`], undefined);
  const appended = editStackRuleList(removed, appActions, {
    kind: 'add',
    value: { kind: 'cancel-timer', timerId: 'response' },
  });
  assert.deepEqual(appended.raw, removed.raw);
  assert.equal(appended.raw['/scenario/inputs/0/message'], '{');
  const workspace = createWorkspaceV2(createWorkspace(createPingPongExperiment()));
  assert.equal(
    parseWorkspaceV2({
      ...workspace,
      stack: { activeDraftId: appended.id, drafts: [appended], runs: [] },
    }).success,
    true,
  );
});

test('nested condition/concat list operations preserve unrelated raw paths and block pending parent JSON', () => {
  const initial = draft();
  const prefix = '/definitions/0/source/rules/0';
  const config = editStackExperiment(initial.configuration, `${prefix}/condition`, {
    kind: 'all',
    conditions: [ruleCondition('compare'), ruleCondition('compare')],
  });
  const edited = {
    ...initial,
    configuration: config,
    raw: { [`${prefix}/condition/conditions/1/right/value`]: 'number:' },
  };
  const moved = editStackRuleList(edited, `${prefix}/condition/conditions`, {
    kind: 'move',
    from: 1,
    to: 0,
  });
  assert.equal(moved.raw[`${prefix}/condition/conditions/0/right/value`], 'number:');
  const blocked = { ...initial, raw: { [appActions]: '{' } };
  assert.equal(editStackRuleList(blocked, appActions, { kind: 'remove', index: 0 }), blocked);
  assert.equal(blockingRuleRaw({ [appActions]: '{' }, `${appActions}/0/value`), appActions);
  assert.equal(blockingRuleRaw({ [`${appActions}/0/value`]: '{' }, appActions), undefined);
});

test('invalid list requests cannot edit another part of the workspace or change revisions', () => {
  const initial = draft();
  for (const change of [
    { kind: 'move', from: -1, to: 0 },
    { kind: 'move', from: 0, to: 999 },
    { kind: 'move', from: 0, to: 0 },
    { kind: 'remove', index: 0.5 },
  ] as const)
    assert.equal(editStackRuleList(initial, appActions, change), initial);
  assert.equal(
    editStackRuleList(initial, '/scenario/inputs', { kind: 'remove', index: 0 }),
    initial,
  );
  assert.equal(
    editStackRuleList(initial, '/definitions/0/source/rules/0/event', { kind: 'remove', index: 0 }),
    initial,
  );
});

test('large, deep and malformed expression trees are bounded without normalizing their source JSON', () => {
  const p = draft().configuration.definitions[0];
  assert.ok(p);
  let expression: unknown = { kind: 'future-expression', body: 'kept' };
  for (let i = 0; i < 40; i++)
    expression = { kind: 'add', left: expression, right: { kind: 'literal', value: i } };
  const rule = {
    ...first(p),
    condition: {
      kind: 'all',
      conditions: Array.from({ length: 200 }, () => ({
        kind: 'compare',
        operator: 'eq',
        left: expression,
        right: null,
      })),
    },
  } as unknown as StackRule;
  const source = JSON.stringify(rule);
  const paths = ruleFormTreePaths(rule, 0, '/rule', {});
  assert.ok(paths.size <= 48);
  assert.ok(!paths.has('/rule/condition/conditions/199'));
  assert.equal(JSON.stringify(rule), source);
});

test('diagnostic pages point to the actual action and nested list positions', () => {
  const value = {
    definitions: [
      {
        rules: [
          {
            actions: Array.from({ length: 25 }, () => ({
              value: {
                kind: 'concat',
                values: Array.from({ length: 30 }, () => ({ kind: 'literal', value: 0 })),
              },
            })),
          },
        ],
      },
    ],
  };
  const pages = ruleFormFocusPages(
    value,
    '/definitions/0/rules/0/actions/24/value/values/29/value',
  );
  assert.equal(pages['/definitions/0/rules/0/actions'], 2);
  assert.equal(pages['/definitions/0/rules/0/actions/24/value/values'], 2);
});
