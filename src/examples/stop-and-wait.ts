import type {
  Action,
  Condition,
  ExperimentDefinition,
  ProtocolDefinition,
  RuleDefinition,
  ValueExpression,
} from '../domain/protocol-model.ts';

const fixed = (value: string | number): ValueExpression => ({ kind: 'literal', value });
const variable = (variableId: string): ValueExpression => ({ kind: 'variable', variableId });
const field = (fieldId: string): ValueExpression => ({ kind: 'field', fieldId });
const compare = (
  operator: Extract<Condition, { kind: 'compare' }>['operator'],
  left: ValueExpression,
  right: ValueExpression,
): Condition => ({ kind: 'compare', operator, left, right });
const increment = (id: string): Action => ({
  kind: 'assign',
  variableId: id,
  value: { kind: 'add', left: variable(id), right: fixed(1) },
});
const data = (): Action => ({
  kind: 'send',
  messageId: 'data',
  values: { seq: variable('waitingSeq'), payload: variable('pending') },
});
const ack = (): Action => ({ kind: 'send', messageId: 'ack', values: { seq: field('seq') } });
const timer = (): Action => ({
  kind: 'start-timer',
  timerId: 'ack',
  durationMs: variable('timeoutMs'),
});

/** Define one-way stop-and-wait with sequence checking, bounded retries and duplicate suppression. */
export function createStopAndWaitProtocol(): ProtocolDefinition {
  const rules: RuleDefinition[] = [
    {
      id: 'submit',
      fromStateId: 'Ready',
      event: { kind: 'input', messageId: 'submit' },
      nextStateId: 'Waiting',
      actions: [
        { kind: 'assign', variableId: 'waitingSeq', value: variable('nextSeq') },
        { kind: 'assign', variableId: 'pending', value: field('payload') },
        { kind: 'assign', variableId: 'retries', value: fixed(0) },
        increment('initialSends'),
        data(),
        timer(),
      ],
    },
    {
      id: 'new_data',
      fromStateId: 'Ready',
      event: { kind: 'receive', messageId: 'data' },
      nextStateId: 'Ready',
      condition: compare('eq', field('seq'), variable('expectedSeq')),
      actions: [
        {
          kind: 'deliver',
          messageId: 'data',
          values: { seq: field('seq'), payload: field('payload') },
        },
        increment('expectedSeq'),
        ack(),
      ],
    },
    {
      id: 'duplicate_data',
      fromStateId: 'Ready',
      event: { kind: 'receive', messageId: 'data' },
      nextStateId: 'Ready',
      condition: compare('lt', field('seq'), variable('expectedSeq')),
      actions: [ack()],
    },
    {
      id: 'future_data',
      fromStateId: 'Ready',
      event: { kind: 'receive', messageId: 'data' },
      nextStateId: 'Ready',
      condition: compare('gt', field('seq'), variable('expectedSeq')),
      actions: [],
      ignore: true,
    },
    {
      id: 'matching_ack',
      fromStateId: 'Waiting',
      event: { kind: 'receive', messageId: 'ack' },
      nextStateId: 'Done',
      condition: compare('eq', field('seq'), variable('waitingSeq')),
      actions: [
        { kind: 'cancel-timer', timerId: 'ack' },
        {
          kind: 'assign',
          variableId: 'nextSeq',
          value: { kind: 'add', left: variable('waitingSeq'), right: fixed(1) },
        },
        { kind: 'finish', outcome: 'success' },
      ],
    },
    {
      id: 'other_ack',
      fromStateId: 'Waiting',
      event: { kind: 'receive', messageId: 'ack' },
      nextStateId: 'Waiting',
      condition: compare('ne', field('seq'), variable('waitingSeq')),
      actions: [],
      ignore: true,
    },
    {
      id: 'retry',
      fromStateId: 'Waiting',
      event: { kind: 'timer', timerId: 'ack' },
      nextStateId: 'Waiting',
      condition: compare('lt', variable('retries'), variable('maxRetries')),
      actions: [increment('retries'), data(), timer()],
    },
    {
      id: 'exhausted',
      fromStateId: 'Waiting',
      event: { kind: 'timer', timerId: 'ack' },
      nextStateId: 'Failed',
      condition: compare('gte', variable('retries'), variable('maxRetries')),
      actions: [{ kind: 'finish', outcome: 'failure' }],
    },
    ...(['Done', 'Failed'] as const).map(
      (state): RuleDefinition => ({
        id: `late_ack_${state}`,
        fromStateId: state,
        event: { kind: 'receive', messageId: 'ack' },
        nextStateId: state,
        actions: [],
        ignore: true,
      }),
    ),
  ];
  const seq = {
    id: 'seq',
    name: 'seq',
    type: 'integer',
    required: true,
    placement: 'header',
    min: 0,
  } as const;
  const payload = {
    id: 'payload',
    name: 'payload',
    type: 'string',
    required: true,
    placement: 'payload',
    maxLength: 1024,
  } as const;
  return {
    schemaVersion: 1,
    id: 'stop_wait',
    revision: 1,
    label: 'Stop-and-wait · 재전송',
    layer: 'transport',
    lowerService: 'datagram',
    codec: 'logical-packet',
    messages: [
      { id: 'submit', label: '상위 입력', fields: [payload] },
      { id: 'data', label: 'DATA', fields: [seq, payload] },
      { id: 'ack', label: 'ACK', fields: [seq] },
    ],
    states: [
      { id: 'Ready', label: '준비' },
      { id: 'Waiting', label: 'ACK 대기' },
      { id: 'Done', label: '완료', terminal: true },
      { id: 'Failed', label: '재시도 소진', terminal: true },
    ],
    initialStateId: 'Ready',
    variables: [
      ...['nextSeq', 'waitingSeq', 'expectedSeq', 'retries', 'initialSends'].map((id) => ({
        id,
        type: 'integer' as const,
        initial: 0,
      })),
      { id: 'pending', type: 'string', initial: '' },
      { id: 'maxRetries', type: 'integer', initial: 3 },
      { id: 'timeoutMs', type: 'integer', initial: 100 },
    ],
    timers: [{ id: 'ack' }],
    rules,
  };
}

/** Create a fully editable one-message A-to-B experiment whose receiver observes the whole window. */
export function createStopAndWaitExperiment(): ExperimentDefinition {
  const protocol = createStopAndWaitProtocol();
  return {
    schemaVersion: 1,
    id: 'reliable_transfer',
    label: '재전송과 ACK 손실 실험',
    seed: 42,
    protocols: { A: { id: protocol.id, revision: 1 }, B: { id: protocol.id, revision: 1 } },
    definitions: [protocol],
    environment: {
      schemaVersion: 1,
      id: 'packet_environment',
      kind: 'datagram',
      directions: {
        AtoB: { delayMs: 10, jitterMs: 0, lossRate: 0, duplicateRate: 0 },
        BtoA: { delayMs: 10, jitterMs: 0, lossRate: 0, duplicateRate: 0 },
      },
      targetedDrops: [],
    },
    scenario: {
      schemaVersion: 1,
      id: 'one_transfer',
      observationMs: 800,
      inputs: [
        {
          id: 'submit',
          timeMs: 0,
          participant: 'A',
          message: { messageId: 'submit', values: { payload: '안녕하세요' } },
        },
      ],
      expectations: [
        { id: 'sender_done', kind: 'state', participant: 'A', stateId: 'Done' },
        {
          id: 'delivered_once',
          kind: 'delivery-count',
          participant: 'B',
          messageId: 'data',
          count: 1,
        },
        {
          id: 'same_content',
          kind: 'delivered-values',
          participant: 'B',
          message: { messageId: 'data', values: { seq: 0, payload: '안녕하세요' } },
        },
        { id: 'bounded_completion', kind: 'completion-before', participant: 'A', timeMs: 450 },
      ],
    },
  };
}
