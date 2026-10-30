import type { ExperimentDefinition, ProtocolDefinition } from '../domain/protocol-model.ts';

type PingPongCodec = Exclude<ProtocolDefinition['codec'], 'http-1.1'>;

/** Create a fresh editable Ping/Pong protocol with explicit response and timeout rules. */
export function createPingPongProtocol(codec: PingPongCodec = 'json-lines'): ProtocolDefinition {
  const fields = [
    {
      id: 'sequence',
      name: 'number',
      required: true,
      placement: 'header',
      type: 'integer',
      min: 0,
      max: 255,
    },
    {
      id: 'text',
      name: 'text',
      required: false,
      placement: 'body',
      type: 'string',
      minLength: 0,
      maxLength: 8,
      defaultValue: '안녕',
    },
    {
      id: 'mode',
      name: 'mode',
      required: false,
      placement: 'header',
      type: 'enum',
      options: ['safe', 'fast'],
      defaultValue: 'safe',
    },
    {
      id: 'urgent',
      name: 'urgent',
      required: false,
      placement: 'header',
      type: 'boolean',
      defaultValue: false,
    },
  ] as const;
  return {
    schemaVersion: 1,
    id: 'ping_pong',
    revision: 1,
    label: 'Ping / Pong',
    layer: codec === 'logical-packet' ? 'transport' : 'application',
    lowerService: codec === 'json-lines' ? 'stream' : 'datagram',
    codec,
    messages: [
      { id: 'ping', label: 'Ping', fields },
      { id: 'pong', label: 'Pong', fields },
    ],
    states: [
      { id: 'Idle', label: '대기' },
      { id: 'Waiting', label: '응답 대기' },
      { id: 'Done', label: '완료', terminal: true },
      { id: 'Failed', label: '실패', terminal: true },
    ],
    initialStateId: 'Idle',
    variables: [
      { id: 'counter', type: 'integer', initial: 0 },
      { id: 'pending', type: 'json', initial: null },
    ],
    timers: [{ id: 'response' }],
    rules: [
      {
        id: 'start',
        fromStateId: 'Idle',
        event: { kind: 'input', messageId: 'ping' },
        actions: [
          {
            kind: 'assign',
            variableId: 'counter',
            value: {
              kind: 'add',
              left: { kind: 'variable', variableId: 'counter' },
              right: { kind: 'literal', value: 1 },
            },
          },
          {
            kind: 'send',
            messageId: 'ping',
            values: { sequence: { kind: 'field', fieldId: 'sequence' } },
          },
          { kind: 'start-timer', timerId: 'response', durationMs: { kind: 'literal', value: 500 } },
        ],
        nextStateId: 'Waiting',
      },
      {
        id: 'reply',
        fromStateId: 'Idle',
        event: { kind: 'receive', messageId: 'ping' },
        actions: [
          {
            kind: 'send',
            messageId: 'pong',
            values: { sequence: { kind: 'field', fieldId: 'sequence' } },
          },
        ],
        nextStateId: 'Idle',
      },
      {
        id: 'complete',
        fromStateId: 'Waiting',
        event: { kind: 'receive', messageId: 'pong' },
        condition: {
          kind: 'compare',
          operator: 'eq',
          left: { kind: 'field', fieldId: 'sequence' },
          right: { kind: 'variable', variableId: 'counter' },
        },
        actions: [
          { kind: 'cancel-timer', timerId: 'response' },
          {
            kind: 'deliver',
            messageId: 'pong',
            values: { sequence: { kind: 'field', fieldId: 'sequence' } },
          },
          { kind: 'finish', outcome: 'success' },
        ],
        nextStateId: 'Done',
      },
      {
        id: 'expire',
        fromStateId: 'Waiting',
        event: { kind: 'timer', timerId: 'response' },
        actions: [{ kind: 'finish', outcome: 'failure' }],
        nextStateId: 'Failed',
      },
      {
        id: 'ignore_late',
        fromStateId: 'Done',
        event: { kind: 'receive', messageId: 'pong' },
        actions: [],
        ignore: true,
        nextStateId: 'Done',
      },
    ],
  };
}

/** Create an isolated starter experiment backed by the same model used by the runtime. */
export function createPingPongExperiment(
  codec: PingPongCodec = 'json-lines',
): ExperimentDefinition {
  return {
    schemaVersion: 1,
    id: 'ping_test',
    label: '나의 Ping / Pong 실험',
    seed: 42,
    protocols: { A: { id: 'ping_pong', revision: 1 }, B: { id: 'ping_pong', revision: 1 } },
    definitions: [createPingPongProtocol(codec)],
    environment:
      codec === 'json-lines'
        ? {
            schemaVersion: 1,
            id: 'local_stream',
            kind: 'stream',
            directions: {
              AtoB: { delayMs: 10, chunkBytes: 8 },
              BtoA: { delayMs: 10, chunkBytes: 8 },
            },
            connections: [],
          }
        : {
            schemaVersion: 1,
            id: 'local_datagram',
            kind: 'datagram',
            directions: {
              AtoB: { delayMs: 10, jitterMs: 0, lossRate: 0, duplicateRate: 0 },
              BtoA: { delayMs: 10, jitterMs: 0, lossRate: 0, duplicateRate: 0 },
            },
            targetedDrops: [],
          },
    scenario: {
      schemaVersion: 1,
      id: 'normal',
      observationMs: 600,
      inputs: [
        {
          id: 'initial',
          timeMs: 0,
          participant: 'A',
          message: { messageId: 'ping', values: { sequence: 1 } },
        },
      ],
      expectations: [
        { id: 'finished', kind: 'state', participant: 'A', stateId: 'Done' },
        { id: 'once', kind: 'delivery-count', participant: 'A', messageId: 'pong', count: 1 },
        {
          id: 'content',
          kind: 'delivered-values',
          participant: 'A',
          message: { messageId: 'pong', values: { sequence: 1 } },
        },
        { id: 'deadline', kind: 'completion-before', participant: 'A', timeMs: 500 },
      ],
    },
  };
}
