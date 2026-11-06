import type { ProtocolDefinition } from '../../src/domain/protocol-model.ts';
import type {
  NativeStackProtocol,
  StackExperiment,
  StackExpression,
} from '../../src/domain/stack-model.ts';
import { adaptLegacyApplication } from '../../src/domain/stack-protocol-validation.ts';
import { protocolFixture } from './protocol-models.ts';
import { stackExperimentFixture } from './stack-models.ts';

/** Replace the common model-only transport fixture, without introducing a reliability example. */
export function changeStackTransport(
  input: StackExperiment,
  change: (definition: NativeStackProtocol) => NativeStackProtocol,
): StackExperiment {
  return {
    ...input,
    definitions: input.definitions.map((definition) =>
      definition.mode === 'stack-protocol' ? change(definition) : definition,
    ),
  };
}

/** Create a test-only provider that splits each real write across two DATA packets. */
export function splitStackFixture(split = 1): StackExperiment {
  const payload: StackExpression = { kind: 'service-payload' };
  return changeStackTransport(stackExperimentFixture(), (protocol) => ({
    ...protocol,
    rules: protocol.rules.map((rule) =>
      rule.id !== 'accept_write'
        ? rule
        : {
            ...rule,
            actions: [
              {
                kind: 'send',
                messageId: 'DATA',
                values: {
                  sequence: { kind: 'literal', value: 0 },
                  payload: {
                    kind: 'slice',
                    value: payload,
                    offset: { kind: 'literal', value: 0 },
                    length: { kind: 'literal', value: split },
                  },
                },
              },
              {
                kind: 'send',
                messageId: 'DATA',
                values: {
                  sequence: { kind: 'literal', value: 1 },
                  payload: {
                    kind: 'slice',
                    value: payload,
                    offset: { kind: 'literal', value: split },
                    length: {
                      kind: 'subtract',
                      left: { kind: 'byteLength', value: payload },
                      right: { kind: 'literal', value: split },
                    },
                  },
                },
              },
            ],
          },
    ),
  }));
}

/** Build a nonterminal v1 app used to verify several frames within one queue operation. */
export function repeatedAppFixture(): ProtocolDefinition {
  const protocol = protocolFixture();
  return {
    ...protocol,
    variables: [],
    timers: [],
    rules: [
      {
        id: 'start',
        fromStateId: 'Idle',
        nextStateId: 'Idle',
        event: { kind: 'input', messageId: 'ping' },
        actions: [
          {
            kind: 'send',
            messageId: 'ping',
            values: { sequence: { kind: 'field', fieldId: 'sequence' } },
          },
        ],
      },
      {
        id: 'reply',
        fromStateId: 'Idle',
        nextStateId: 'Idle',
        event: { kind: 'receive', messageId: 'ping' },
        actions: [
          {
            kind: 'send',
            messageId: 'pong',
            values: { sequence: { kind: 'field', fieldId: 'sequence' } },
          },
        ],
      },
      {
        id: 'record',
        fromStateId: 'Idle',
        nextStateId: 'Idle',
        event: { kind: 'receive', messageId: 'pong' },
        actions: [
          {
            kind: 'deliver',
            messageId: 'pong',
            values: { sequence: { kind: 'field', fieldId: 'sequence' } },
          },
        ],
      },
    ],
  };
}

/** Merge two independent DATA payloads into a single read, preserving both actual contributors. */
export function mergedStackFixture(): StackExperiment {
  const app = adaptLegacyApplication(repeatedAppFixture());
  if (!app.success) throw new Error(JSON.stringify(app));
  const original = stackExperimentFixture();
  const experiment: StackExperiment = {
    ...original,
    definitions: [app.value, ...original.definitions.slice(1)],
    scenario: {
      ...original.scenario,
      inputs: [1, 2].map((sequence) => ({
        id: `input_${sequence}`,
        timeMs: 0,
        target: { participant: 'A', instanceId: 'app' },
        message: { messageId: 'ping', values: { sequence } },
      })),
      expectations: [
        {
          id: 'twice',
          target: { participant: 'A', instanceId: 'app' },
          kind: 'delivery-count',
          messageId: 'pong',
          count: 2,
        },
      ],
    },
  };
  return changeStackTransport(experiment, (protocol) => ({
    ...protocol,
    states: [...protocol.states, { id: 'Buffered', label: 'Buffered' }],
    rules: [
      protocol.rules[0],
      {
        id: 'buffer',
        fromStateId: 'Ready',
        nextStateId: 'Buffered',
        event: { kind: 'receive', messageId: 'DATA' },
        actions: [
          { kind: 'assign', variableId: 'buffer', value: { kind: 'field', fieldId: 'payload' } },
        ],
      },
      {
        id: 'merge',
        fromStateId: 'Buffered',
        nextStateId: 'Ready',
        event: { kind: 'receive', messageId: 'DATA' },
        actions: [
          {
            kind: 'service-indicate',
            portId: 'upper',
            operation: 'read',
            payload: {
              kind: 'concat',
              values: [
                { kind: 'variable', variableId: 'buffer' },
                { kind: 'field', fieldId: 'payload' },
              ],
            },
          },
        ],
      },
    ].filter((rule): rule is NativeStackProtocol['rules'][number] => !!rule),
  }));
}
