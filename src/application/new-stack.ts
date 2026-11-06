import type { ValidationResult } from '../domain/protocol-model.ts';
import {
  defaultStackLimits,
  type NativeStackProtocol,
  type ServicePort,
  type StackExperiment,
  type StackMessageDefinition,
} from '../domain/stack-model.ts';
import { parseStackExperiment, parseStackExperimentDraft } from '../domain/stack-validation.ts';
import { createReliableStreamLiteProtocol } from '../examples/reliable-stream-lite.ts';

export type NewStackOptions = {
  readonly name: string;
  readonly protocolId: string;
  readonly transport: 'reliable-stream' | 'datagram';
  readonly flow: 'empty' | 'one-way';
  readonly messageId: string;
  readonly fieldId: string;
  readonly value: string;
};
export const NEW_STACK_DEFAULTS: NewStackOptions = {
  name: '나의 프로토콜',
  protocolId: 'my_protocol',
  transport: 'reliable-stream',
  flow: 'one-way',
  messageId: 'message',
  fieldId: 'text',
  value: '안녕하세요',
};

function datagramProvider(): NativeStackProtocol {
  const messages: readonly StackMessageDefinition[] = [
    {
      id: 'DATA',
      label: 'Data',
      fields: [
        { id: 'payload', name: 'payload', type: 'bytes', required: true, placement: 'payload' },
      ],
    },
  ];
  return {
    schemaVersion: 2,
    mode: 'stack-protocol',
    id: 'datagram_forwarder',
    revision: 1,
    label: '데이터그램 전달 뼈대',
    layer: 'transport',
    codec: 'logical-packet',
    requires: {
      id: 'network',
      role: 'requires',
      service: { kind: 'datagram', payload: { id: 'forwarder_packet', revision: 1, messages } },
      request: 'send',
      indication: 'receive',
      lifecycle: { initial: 'ready', notifications: [] },
    },
    provides: {
      id: 'upper',
      role: 'provides',
      service: { kind: 'datagram', payload: 'bytes' },
      request: 'send',
      indication: 'receive',
      lifecycle: { initial: 'ready', notifications: [] },
    },
    messages,
    states: [{ id: 'Ready', label: '준비' }],
    initialStateId: 'Ready',
    variables: [],
    timers: [],
    rules: [
      {
        id: 'forward',
        fromStateId: 'Ready',
        nextStateId: 'Ready',
        event: { kind: 'service-request', portId: 'upper', operation: 'send' },
        actions: [
          { kind: 'send', messageId: 'DATA', values: { payload: { kind: 'service-payload' } } },
        ],
      },
      {
        id: 'indicate',
        fromStateId: 'Ready',
        nextStateId: 'Ready',
        event: { kind: 'receive', messageId: 'DATA' },
        actions: [
          {
            kind: 'service-indicate',
            portId: 'upper',
            operation: 'receive',
            payload: { kind: 'field', fieldId: 'payload' },
          },
        ],
      },
    ],
  };
}

/** Build a user-owned native application and explicit providers without copying an example experiment. */
export function createNewStack(
  options: NewStackOptions,
  id: string,
): ValidationResult<StackExperiment> {
  const diagnostics = [];
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id))
    diagnostics.push({
      path: '/id',
      code: 'new-stack-id',
      message: '유효한 스택 ID가 필요합니다.',
    });
  for (const key of ['name', 'protocolId', 'messageId', 'fieldId'] as const)
    if (!options[key].trim() || options[key].length > 80)
      diagnostics.push({
        path: `/${key}`,
        code: 'new-stack-input',
        message: '이름과 ID는 공백이 아닌 1~80자로 입력하세요.',
      });
  for (const key of ['protocolId', 'messageId', 'fieldId'] as const)
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(options[key]))
      diagnostics.push({
        path: `/${key}`,
        code: 'new-stack-id',
        message: 'ID는 영문/밑줄로 시작하고 영문·숫자·밑줄·하이픈을 사용하세요.',
      });
  if (options.value.length > 4096)
    diagnostics.push({
      path: '/value',
      code: 'new-stack-input',
      message: '첫 값은 4096자 이내로 입력하세요.',
    });
  if (
    !['reliable-stream', 'datagram'].includes(options.transport) ||
    !['empty', 'one-way'].includes(options.flow)
  )
    diagnostics.push({
      path: '/',
      code: 'new-stack-input',
      message: '전송과 시작 구성을 확인하세요.',
    });
  if (diagnostics.length) return { success: false, diagnostics };
  const stream = options.transport === 'reliable-stream';
  const transports = stream
    ? [createReliableStreamLiteProtocol('A'), createReliableStreamLiteProtocol('B')]
    : [datagramProvider()];
  if (transports.some((p) => p.id === options.protocolId))
    return {
      success: false,
      diagnostics: [
        {
          path: '/protocolId',
          code: 'identity-collision',
          message: '전송 정의와 다른 프로토콜 ID를 입력하세요.',
        },
      ],
    };
  const sourcePort = transports[0]?.provides;
  if (!sourcePort) throw new Error('New stack provider has no upper port');
  const requires: ServicePort = { ...structuredClone(sourcePort), id: 'lower', role: 'requires' };
  const application: NativeStackProtocol = {
    schemaVersion: 2,
    mode: 'stack-protocol',
    id: options.protocolId,
    revision: 1,
    label: options.name,
    layer: 'application',
    codec: stream ? 'json-lines' : 'json-datagram',
    requires,
    messages: [
      {
        id: options.messageId,
        label: options.messageId,
        fields: [
          {
            id: options.fieldId,
            name: options.fieldId,
            type: 'string',
            required: true,
            placement: 'payload',
          },
        ],
      },
    ],
    states: [{ id: 'Ready', label: '준비' }],
    initialStateId: 'Ready',
    variables: [],
    timers: [],
    rules:
      options.flow === 'empty'
        ? []
        : [
            {
              id: 'send_input',
              fromStateId: 'Ready',
              nextStateId: 'Ready',
              event: { kind: 'input', messageId: options.messageId },
              actions: [
                {
                  kind: 'send',
                  messageId: options.messageId,
                  values: { [options.fieldId]: { kind: 'field', fieldId: options.fieldId } },
                },
              ],
            },
            {
              id: 'deliver_message',
              fromStateId: 'Ready',
              nextStateId: 'Ready',
              event: { kind: 'receive', messageId: options.messageId },
              actions: [
                {
                  kind: 'deliver',
                  messageId: options.messageId,
                  values: { [options.fieldId]: { kind: 'field', fieldId: options.fieldId } },
                },
              ],
            },
            ...(stream
              ? [
                  {
                    id: 'lower_failed',
                    fromStateId: 'Ready',
                    nextStateId: 'Ready',
                    event: { kind: 'connection' as const, state: 'failed' as const },
                    actions: [],
                    ignore: true,
                  },
                ]
              : []),
          ],
  };
  const node = (participant: 'A' | 'B') => {
    const transport = transports[participant === 'B' && stream ? 1 : 0];
    if (!transport) throw new Error('Missing new stack provider');
    return {
      instances: [
        { id: 'app', definition: { id: application.id, revision: 1 } },
        { id: 'transport', definition: { id: transport.id, revision: 1 } },
      ],
    };
  };
  const configuration: StackExperiment = {
    schemaVersion: 2,
    mode: 'stack',
    id,
    label: options.name,
    seed: 0,
    definitions: [application, ...transports],
    nodes: { A: node('A'), B: node('B') },
    bindings: (['A', 'B'] as const).map((participant) => ({
      id: `local_${participant}`,
      consumer: { participant, instanceId: 'app', portId: 'lower' },
      provider: { participant, instanceId: 'transport', portId: 'upper' },
    })),
    link: {
      id: 'network',
      A: { participant: 'A', instanceId: 'transport', portId: 'network' },
      B: { participant: 'B', instanceId: 'transport', portId: 'network' },
      environment: {
        schemaVersion: 1,
        id: 'environment',
        kind: 'datagram',
        directions: {
          AtoB: { delayMs: 10, jitterMs: 0, lossRate: 0, duplicateRate: 0 },
          BtoA: { delayMs: 10, jitterMs: 0, lossRate: 0, duplicateRate: 0 },
        },
        targetedDrops: [],
      },
    },
    scenario: {
      schemaVersion: 2,
      id: 'first_scenario',
      observationMs: 1000,
      inputs:
        options.flow === 'empty'
          ? []
          : [
              {
                id: 'first_input',
                timeMs: 0,
                target: { participant: 'A', instanceId: 'app' },
                message: {
                  messageId: options.messageId,
                  values: { [options.fieldId]: options.value },
                },
              },
            ],
      expectations:
        options.flow === 'empty'
          ? []
          : [
              {
                id: 'first_delivery_count',
                kind: 'delivery-count',
                target: { participant: 'B', instanceId: 'app' },
                messageId: options.messageId,
                count: 1,
              },
              {
                id: 'first_delivery',
                kind: 'delivered-values',
                target: { participant: 'B', instanceId: 'app' },
                message: {
                  messageId: options.messageId,
                  values: { [options.fieldId]: options.value },
                },
              },
            ],
    },
    limits: defaultStackLimits(),
  };
  return (options.flow === 'empty' ? parseStackExperimentDraft : parseStackExperiment)(
    configuration,
  );
}
