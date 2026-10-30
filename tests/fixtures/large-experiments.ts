import type { ExperimentDefinition, ProtocolDefinition } from '../../src/domain/protocol-model.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';

/** Reach the actual 10,000-trace limit through bounded native timer rules, without fabricated trace rows. */
export function createEventLimitExperiment(): ExperimentDefinition {
  const base = createPingPongExperiment();
  const original = base.definitions[0];
  if (!original) throw new Error('Missing fixture protocol');
  const protocol: ProtocolDefinition = {
    ...original,
    variables: [],
    rules: [
      {
        id: 'begin',
        fromStateId: 'Idle',
        event: { kind: 'input', messageId: 'ping' },
        actions: [
          { kind: 'start-timer', timerId: 'response', durationMs: { kind: 'literal', value: 1 } },
        ],
        nextStateId: 'Waiting',
      },
      {
        id: 'repeat',
        fromStateId: 'Waiting',
        event: { kind: 'timer', timerId: 'response' },
        actions: [
          { kind: 'start-timer', timerId: 'response', durationMs: { kind: 'literal', value: 1 } },
        ],
        nextStateId: 'Waiting',
      },
    ],
  };
  return {
    ...base,
    id: 'event_limit',
    label: '10,000 이벤트 실험',
    definitions: [protocol],
    scenario: {
      ...base.scenario,
      observationMs: 10_000,
      expectations: [{ id: 'unfinished', kind: 'state', participant: 'A', stateId: 'Done' }],
    },
  };
}

/** Send one real JSON Lines frame exactly at the 1 MiB byte limit, with an optional overflow byte. */
export function createMessageLimitExperiment(overflow = false): ExperimentDefinition {
  const base = createPingPongExperiment();
  const overhead = new TextEncoder().encode(
    `${JSON.stringify({ messageId: 'blob', fields: { body: '' } })}\n`,
  ).length;
  const protocol: ProtocolDefinition = {
    schemaVersion: 1,
    id: 'large_message',
    revision: 1,
    label: '1 MiB 전송',
    layer: 'application',
    lowerService: 'stream',
    codec: 'json-lines',
    messages: [
      {
        id: 'blob',
        label: '큰 메시지',
        fields: [
          {
            id: 'body',
            name: 'body',
            placement: 'body',
            required: true,
            type: 'string',
            maxLength: 1_048_576,
            defaultValue: 'a'.repeat(1_048_576 - overhead + (overflow ? 1 : 0)),
          },
        ],
      },
    ],
    states: [
      { id: 'Idle', label: '대기' },
      { id: 'Done', label: '완료', terminal: true },
    ],
    initialStateId: 'Idle',
    variables: [],
    timers: [],
    rules: [
      {
        id: 'send',
        fromStateId: 'Idle',
        event: { kind: 'input', messageId: 'blob' },
        actions: [
          { kind: 'send', messageId: 'blob', values: { body: { kind: 'field', fieldId: 'body' } } },
        ],
        nextStateId: 'Done',
      },
      {
        id: 'deliver',
        fromStateId: 'Idle',
        event: { kind: 'receive', messageId: 'blob' },
        actions: [
          {
            kind: 'deliver',
            messageId: 'blob',
            values: { body: { kind: 'field', fieldId: 'body' } },
          },
        ],
        nextStateId: 'Done',
      },
    ],
  };
  return {
    ...base,
    id: 'message_limit',
    label: overflow ? '1 MiB 초과 실험' : '1 MiB 전송 실험',
    definitions: [protocol],
    protocols: { A: { id: protocol.id, revision: 1 }, B: { id: protocol.id, revision: 1 } },
    environment: {
      schemaVersion: 1,
      id: 'large_stream',
      kind: 'stream',
      directions: {
        AtoB: { delayMs: 10, chunkBytes: 1_048_576 },
        BtoA: { delayMs: 10, chunkBytes: 1_048_576 },
      },
      connections: [],
    },
    scenario: {
      ...base.scenario,
      inputs: [
        { id: 'start', timeMs: 0, participant: 'A', message: { messageId: 'blob', values: {} } },
      ],
      expectations: [
        { id: 'once', kind: 'delivery-count', participant: 'B', messageId: 'blob', count: 1 },
      ],
    },
  };
}
