import type {
  Condition,
  ExperimentDefinition,
  ProtocolDefinition,
  RuleDefinition,
  ValueExpression,
} from '../domain/protocol-model.ts';

const fixed = (value: number | boolean): ValueExpression => ({ kind: 'literal', value });
const variable = (variableId: string): ValueExpression => ({ kind: 'variable', variableId });
const field = (fieldId: string): ValueExpression => ({ kind: 'field', fieldId });
const plusOne = (left: ValueExpression): ValueExpression => ({
  kind: 'add',
  left,
  right: fixed(1),
});
const equal = (left: ValueExpression, right: ValueExpression): Condition => ({
  kind: 'compare',
  operator: 'eq',
  left,
  right,
});
const flags = (syn: boolean, ack: boolean): Condition[] => [
  equal(field('syn'), fixed(syn)),
  equal(field('ackFlag'), fixed(ack)),
];

/** Define active/passive normal TCP synchronization as logical packets, omitting full TCP behavior. */
export function createTcpHandshakeProtocol(role: 'active' | 'passive'): ProtocolDefinition {
  const rules: RuleDefinition[] = [
    {
      id: 'active_open',
      fromStateId: 'CLOSED',
      event: { kind: 'input', messageId: 'open' },
      nextStateId: 'SYN-SENT',
      actions: [
        { kind: 'assign', variableId: 'sndNxt', value: plusOne(variable('iss')) },
        { kind: 'send', messageId: 'syn', values: { seq: variable('iss') } },
        { kind: 'start-timer', timerId: 'handshake', durationMs: fixed(500) },
      ],
    },
    {
      id: 'passive_syn',
      fromStateId: 'LISTEN',
      event: { kind: 'receive', messageId: 'syn' },
      condition: { kind: 'all', conditions: flags(true, false) },
      nextStateId: 'SYN-RECEIVED',
      actions: [
        { kind: 'assign', variableId: 'rcvNxt', value: plusOne(field('seq')) },
        { kind: 'assign', variableId: 'sndNxt', value: plusOne(variable('iss')) },
        {
          kind: 'send',
          messageId: 'syn_ack',
          values: { seq: variable('iss'), ack: variable('rcvNxt') },
        },
        { kind: 'start-timer', timerId: 'handshake', durationMs: fixed(500) },
      ],
    },
    {
      id: 'active_syn_ack',
      fromStateId: 'SYN-SENT',
      event: { kind: 'receive', messageId: 'syn_ack' },
      condition: {
        kind: 'all',
        conditions: [...flags(true, true), equal(field('ack'), variable('sndNxt'))],
      },
      nextStateId: 'ESTABLISHED',
      actions: [
        { kind: 'assign', variableId: 'rcvNxt', value: plusOne(field('seq')) },
        { kind: 'cancel-timer', timerId: 'handshake' },
        {
          kind: 'send',
          messageId: 'ack',
          values: { seq: variable('sndNxt'), ack: variable('rcvNxt') },
        },
        { kind: 'finish', outcome: 'success' },
      ],
    },
    {
      id: 'passive_ack',
      fromStateId: 'SYN-RECEIVED',
      event: { kind: 'receive', messageId: 'ack' },
      condition: {
        kind: 'all',
        conditions: [
          ...flags(false, true),
          equal(field('seq'), variable('rcvNxt')),
          equal(field('ack'), variable('sndNxt')),
        ],
      },
      nextStateId: 'ESTABLISHED',
      actions: [
        { kind: 'cancel-timer', timerId: 'handshake' },
        { kind: 'finish', outcome: 'success' },
      ],
    },
    ...(['SYN-SENT', 'SYN-RECEIVED'] as const).map(
      (state): RuleDefinition => ({
        id: `timeout_${state}`,
        fromStateId: state,
        event: { kind: 'timer', timerId: 'handshake' },
        nextStateId: 'TimedOut',
        actions: [{ kind: 'finish', outcome: 'failure' }],
      }),
    ),
  ];
  const fields = (syn: boolean, ackFlag: boolean) =>
    [
      {
        id: 'syn',
        name: 'SYN',
        type: 'boolean',
        required: false,
        defaultValue: syn,
        placement: 'header',
      },
      {
        id: 'ackFlag',
        name: 'ACK',
        type: 'boolean',
        required: false,
        defaultValue: ackFlag,
        placement: 'header',
      },
      {
        id: 'seq',
        name: 'seq',
        type: 'integer',
        min: 0,
        max: 4_294_967_295,
        required: true,
        placement: 'header',
      },
      {
        id: 'ack',
        name: 'ack',
        type: 'integer',
        min: 0,
        max: 4_294_967_295,
        required: false,
        defaultValue: 0,
        placement: 'header',
      },
    ] as const;
  return {
    schemaVersion: 1,
    id: `tcp_${role}`,
    revision: 1,
    label: `TCP 연결 · ${role}`,
    layer: 'transport',
    lowerService: 'datagram',
    codec: 'logical-packet',
    messages: [
      { id: 'open', label: '능동 열기', fields: [] },
      { id: 'syn', label: 'SYN', fields: fields(true, false) },
      { id: 'syn_ack', label: 'SYN-ACK', fields: fields(true, true) },
      { id: 'ack', label: 'ACK', fields: fields(false, true) },
    ],
    states: ['CLOSED', 'LISTEN', 'SYN-SENT', 'SYN-RECEIVED', 'ESTABLISHED', 'TimedOut'].map(
      (id) => ({
        id,
        label: id,
        ...(['ESTABLISHED', 'TimedOut'].includes(id) ? { terminal: true } : {}),
      }),
    ),
    initialStateId: role === 'active' ? 'CLOSED' : 'LISTEN',
    variables: [
      { id: 'iss', type: 'integer', initial: role === 'active' ? 100 : 300 },
      { id: 'sndNxt', type: 'integer', initial: 0 },
      { id: 'rcvNxt', type: 'integer', initial: 0 },
    ],
    timers: [{ id: 'handshake' }],
    rules,
  };
}

/** Create the RFC 9293 Figure 6 normal 100/300 sequence synchronization scenario. */
export function createTcpHandshakeExperiment(): ExperimentDefinition {
  return {
    schemaVersion: 1,
    id: 'tcp_handshake',
    label: 'TCP · 정상 연결 수립 개념 모델',
    seed: 42,
    protocols: { A: { id: 'tcp_active', revision: 1 }, B: { id: 'tcp_passive', revision: 1 } },
    definitions: [createTcpHandshakeProtocol('active'), createTcpHandshakeProtocol('passive')],
    environment: {
      schemaVersion: 1,
      id: 'logical_network',
      kind: 'datagram',
      directions: {
        AtoB: { delayMs: 10, jitterMs: 0, lossRate: 0, duplicateRate: 0 },
        BtoA: { delayMs: 10, jitterMs: 0, lossRate: 0, duplicateRate: 0 },
      },
      targetedDrops: [],
    },
    scenario: {
      schemaVersion: 1,
      id: 'normal_handshake',
      observationMs: 600,
      inputs: [
        { id: 'open', timeMs: 0, participant: 'A', message: { messageId: 'open', values: {} } },
      ],
      expectations: [
        { id: 'active_established', kind: 'state', participant: 'A', stateId: 'ESTABLISHED' },
        { id: 'passive_established', kind: 'state', participant: 'B', stateId: 'ESTABLISHED' },
        { id: 'active_deadline', kind: 'completion-before', participant: 'A', timeMs: 100 },
        { id: 'passive_deadline', kind: 'completion-before', participant: 'B', timeMs: 100 },
      ],
    },
  };
}
