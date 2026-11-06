import type { JsonValue, ParticipantId } from '../domain/execution-contract.ts';
import { serializeBytes } from '../domain/stack-bytes.ts';
import type {
  NativeStackProtocol,
  StackAction,
  StackCondition,
  StackExpression,
  StackMessageDefinition,
  StackRule,
} from '../domain/stack-model.ts';

export const RELIABLE_STREAM_LITE_VERSION = 1;
export const RELIABLE_STREAM_MAX_CHUNK_BYTES = 65_536;
export type ReliableStreamOptions = {
  readonly chunkBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly maxSequence?: number;
};
const empty = serializeBytes(new Uint8Array());
const fixed = (value: JsonValue): StackExpression => ({ kind: 'literal', value });
const variable = (variableId: string): StackExpression => ({ kind: 'variable', variableId });
const field = (fieldId: string): StackExpression => ({ kind: 'field', fieldId });
const payload: StackExpression = { kind: 'service-payload' };
const length = (value: StackExpression): StackExpression => ({ kind: 'byteLength', value });
const add = (left: StackExpression, right: StackExpression): StackExpression => ({
  kind: 'add',
  left,
  right,
});
const subtract = (left: StackExpression, right: StackExpression): StackExpression => ({
  kind: 'subtract',
  left,
  right,
});
const compare = (
  operator: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte',
  left: StackExpression,
  right: StackExpression,
): StackCondition => ({ kind: 'compare', operator, left, right });
const all = (...conditions: StackCondition[]): StackCondition => ({ kind: 'all', conditions });
const any = (...conditions: StackCondition[]): StackCondition => ({ kind: 'any', conditions });
const assign = (variableId: string, value: StackExpression): StackAction => ({
  kind: 'assign',
  variableId,
  value,
});
const increment = (id: string): StackAction => assign(id, add(variable(id), fixed(1)));
const sendData = (): StackAction => ({
  kind: 'send',
  messageId: 'DATA',
  values: {
    direction: variable('txDirection'),
    seq: variable('txSeq'),
    payload: variable('cached'),
  },
});
const sendAck = (): StackAction => ({
  kind: 'send',
  messageId: 'ACK',
  values: { direction: field('direction'), seq: field('seq') },
});
const startTimer = (): StackAction => ({
  kind: 'start-timer',
  timerId: 'ack',
  durationMs: variable('timeoutMs'),
});
const cancelTimer = (): StackAction => ({ kind: 'cancel-timer', timerId: 'ack' });
const fail = (reason: string): readonly StackAction[] => [
  cancelTimer(),
  assign('pending', fixed(empty)),
  assign('queued', fixed(empty)),
  assign('cached', fixed(empty)),
  assign('offset', fixed(0)),
  assign('failureReason', fixed(reason)),
  { kind: 'service-indicate', portId: 'upper', operation: 'failed' },
  { kind: 'finish', outcome: 'failure' },
];

function check(value: number, name: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be a safe integer in [${min}, ${max}]`);
}

/** Define a ready, bidirectional, bounded stop-and-wait byte service as editable protocol rules. */
export function createReliableStreamLiteProtocol(
  participant: ParticipantId,
  options: ReliableStreamOptions = {},
): NativeStackProtocol {
  if (participant !== 'A' && participant !== 'B')
    throw new RangeError('Expected participant A or B');
  const chunkBytes = options.chunkBytes ?? 64;
  const timeoutMs = options.timeoutMs ?? 100;
  const maxRetries = options.maxRetries ?? 3;
  const maxSequence = options.maxSequence ?? Number.MAX_SAFE_INTEGER - 1;
  check(chunkBytes, 'chunkBytes', 1, RELIABLE_STREAM_MAX_CHUNK_BYTES);
  check(timeoutMs, 'timeoutMs', 1, Number.MAX_SAFE_INTEGER - 1);
  check(maxRetries, 'maxRetries', 0, 1000);
  check(maxSequence, 'maxSequence', 0, Number.MAX_SAFE_INTEGER - 1);
  const dir = {
    id: 'direction',
    name: 'direction',
    type: 'enum',
    options: ['AtoB', 'BtoA'],
    required: true,
    placement: 'header',
  } as const;
  const seq = {
    id: 'seq',
    name: 'seq',
    type: 'integer',
    min: 0,
    max: Number.MAX_SAFE_INTEGER - 1,
    required: true,
    placement: 'header',
  } as const;
  const messages: readonly StackMessageDefinition[] = [
    {
      id: 'DATA',
      label: 'DATA · stream bytes',
      fields: [
        dir,
        seq,
        {
          id: 'payload',
          name: 'payload',
          type: 'bytes',
          minBytes: 1,
          maxBytes: RELIABLE_STREAM_MAX_CHUNK_BYTES,
          required: true,
          placement: 'payload',
        },
      ],
    },
    { id: 'ACK', label: 'ACK · DATA direction/sequence', fields: [dir, seq] },
  ];
  const hasSequence = compare('lte', variable('txSeq'), variable('maxSequence'));
  const correctAck = all(
    compare('eq', field('direction'), variable('txDirection')),
    compare('eq', field('seq'), variable('txSeq')),
  );
  const more = compare('lt', variable('offset'), length(variable('pending')));
  const end = compare('eq', variable('offset'), length(variable('pending')));
  const queued = compare('gt', length(variable('queued')), fixed(0));
  const noneQueued = compare('eq', length(variable('queued')), fixed(0));
  const canAdvance = compare('lt', variable('txSeq'), variable('maxSequence'));
  const remaining = subtract(length(variable('pending')), variable('offset'));
  const slice = (
    value: StackExpression,
    offset: StackExpression,
    size: StackExpression,
  ): StackExpression => ({ kind: 'slice', value, offset, length: size });
  const cacheChunk = (size: StackExpression): readonly StackAction[] => [
    assign('cached', slice(variable('pending'), variable('offset'), size)),
    assign('offset', add(variable('offset'), size)),
    assign('retries', fixed(0)),
    increment('initialSends'),
    sendData(),
    startTimer(),
  ];
  const rules: StackRule[] = [];
  for (const state of ['Ready', 'Waiting'] as const) {
    const receive = (
      id: string,
      condition: StackCondition,
      actions: readonly StackAction[],
      ignore = false,
      nextStateId: string = state,
    ): StackRule => ({
      id: `${id}_${state}`,
      fromStateId: state,
      nextStateId,
      event: { kind: 'receive', messageId: 'DATA' },
      condition,
      actions,
      ...(ignore ? { ignore: true } : {}),
    });
    const correctDirection = compare('eq', field('direction'), variable('rxDirection'));
    rules.push(
      receive(
        'accept_DATA',
        all(
          correctDirection,
          compare('eq', field('seq'), variable('expectedSeq')),
          compare('lte', variable('expectedSeq'), variable('maxSequence')),
        ),
        [
          {
            kind: 'service-indicate',
            portId: 'upper',
            operation: 'read',
            payload: field('payload'),
          },
          increment('expectedSeq'),
          increment('deliveredChunks'),
          assign('receivedBytes', add(variable('receivedBytes'), length(field('payload')))),
          sendAck(),
        ],
      ),
      receive(
        'duplicate_DATA',
        all(correctDirection, compare('lt', field('seq'), variable('expectedSeq'))),
        [increment('duplicateChunks'), sendAck()],
      ),
      receive(
        'ignore_future_DATA',
        all(correctDirection, compare('gt', field('seq'), variable('expectedSeq'))),
        [],
        true,
      ),
      receive(
        'ignore_wrong_direction_DATA',
        compare('ne', field('direction'), variable('rxDirection')),
        [],
        true,
      ),
      receive(
        'receive_sequence_exhausted',
        all(
          correctDirection,
          compare('eq', field('seq'), variable('expectedSeq')),
          compare('gt', variable('expectedSeq'), variable('maxSequence')),
        ),
        fail('sequence-exhausted'),
        false,
        'Failed',
      ),
      {
        id: `empty_write_${state}`,
        fromStateId: state,
        nextStateId: state,
        event: { kind: 'service-request', portId: 'upper', operation: 'write' },
        condition: compare('eq', length(payload), fixed(0)),
        actions: [],
        ignore: true,
      },
    );
  }
  for (const [suffix, size, condition] of [
    ['short', length(payload), compare('lte', length(payload), variable('chunkBytes'))],
    ['long', variable('chunkBytes'), compare('gt', length(payload), variable('chunkBytes'))],
  ] as const)
    rules.push({
      id: `write_${suffix}`,
      fromStateId: 'Ready',
      nextStateId: 'Waiting',
      event: { kind: 'service-request', portId: 'upper', operation: 'write' },
      condition: all(hasSequence, compare('gt', length(payload), fixed(0)), condition),
      actions: [assign('pending', payload), assign('offset', fixed(0)), ...cacheChunk(size)],
    });
  rules.push(
    {
      id: 'write_sequence_exhausted',
      fromStateId: 'Ready',
      nextStateId: 'Failed',
      event: { kind: 'service-request', portId: 'upper', operation: 'write' },
      condition: all(
        compare('gt', length(payload), fixed(0)),
        compare('gt', variable('txSeq'), variable('maxSequence')),
      ),
      actions: fail('sequence-exhausted'),
    },
    {
      id: 'queue_write',
      fromStateId: 'Waiting',
      nextStateId: 'Waiting',
      event: { kind: 'service-request', portId: 'upper', operation: 'write' },
      condition: compare('gt', length(payload), fixed(0)),
      actions: [assign('queued', { kind: 'concat', values: [variable('queued'), payload] })],
    },
    {
      id: 'ack_write_complete',
      fromStateId: 'Waiting',
      nextStateId: 'Ready',
      event: { kind: 'receive', messageId: 'ACK' },
      condition: all(correctAck, end, noneQueued),
      actions: [
        cancelTimer(),
        increment('txSeq'),
        assign('pending', fixed(empty)),
        assign('cached', fixed(empty)),
        assign('offset', fixed(0)),
      ],
    },
    {
      id: 'ack_sequence_exhausted',
      fromStateId: 'Waiting',
      nextStateId: 'Failed',
      event: { kind: 'receive', messageId: 'ACK' },
      condition: all(
        correctAck,
        any(more, queued),
        compare('gte', variable('txSeq'), variable('maxSequence')),
      ),
      actions: [increment('txSeq'), ...fail('sequence-exhausted')],
    },
    {
      id: 'ignore_other_ACK',
      fromStateId: 'Waiting',
      nextStateId: 'Waiting',
      event: { kind: 'receive', messageId: 'ACK' },
      condition: any(
        compare('ne', field('direction'), variable('txDirection')),
        compare('ne', field('seq'), variable('txSeq')),
      ),
      actions: [],
      ignore: true,
    },
    {
      id: 'ignore_idle_ACK',
      fromStateId: 'Ready',
      nextStateId: 'Ready',
      event: { kind: 'receive', messageId: 'ACK' },
      actions: [],
      ignore: true,
    },
    {
      id: 'retry_DATA',
      fromStateId: 'Waiting',
      nextStateId: 'Waiting',
      event: { kind: 'timer', timerId: 'ack' },
      condition: compare('lt', variable('retries'), variable('maxRetries')),
      actions: [increment('retries'), increment('retransmissions'), sendData(), startTimer()],
    },
    {
      id: 'retry_exhausted',
      fromStateId: 'Waiting',
      nextStateId: 'Failed',
      event: { kind: 'timer', timerId: 'ack' },
      condition: compare('gte', variable('retries'), variable('maxRetries')),
      actions: fail('retry-exhausted'),
    },
  );
  for (const [suffix, size, condition] of [
    ['short', remaining, compare('lte', remaining, variable('chunkBytes'))],
    ['long', variable('chunkBytes'), compare('gt', remaining, variable('chunkBytes'))],
  ] as const)
    rules.push({
      id: `ack_continue_${suffix}`,
      fromStateId: 'Waiting',
      nextStateId: 'Waiting',
      event: { kind: 'receive', messageId: 'ACK' },
      condition: all(correctAck, canAdvance, more, condition),
      actions: [cancelTimer(), increment('txSeq'), ...cacheChunk(size)],
    });
  for (const [suffix, size, condition] of [
    [
      'short',
      length(variable('pending')),
      compare('lte', length(variable('queued')), variable('chunkBytes')),
    ],
    [
      'long',
      variable('chunkBytes'),
      compare('gt', length(variable('queued')), variable('chunkBytes')),
    ],
  ] as const)
    rules.push({
      id: `ack_next_write_${suffix}`,
      fromStateId: 'Waiting',
      nextStateId: 'Waiting',
      event: { kind: 'receive', messageId: 'ACK' },
      condition: all(correctAck, canAdvance, end, queued, condition),
      actions: [
        cancelTimer(),
        increment('txSeq'),
        assign('pending', variable('queued')),
        assign('queued', fixed(empty)),
        assign('offset', fixed(0)),
        ...cacheChunk(size),
      ],
    });
  for (const event of [
    { kind: 'receive', messageId: 'DATA' },
    { kind: 'receive', messageId: 'ACK' },
    { kind: 'service-request', portId: 'upper', operation: 'write' },
  ] as const)
    rules.push({
      id: `ignore_after_failure_${event.kind === 'receive' ? event.messageId : 'write'}`,
      fromStateId: 'Failed',
      nextStateId: 'Failed',
      event,
      actions: [],
      ignore: true,
    });
  return {
    schemaVersion: 2,
    mode: 'stack-protocol',
    id: `reliable_stream_lite_${participant}`,
    revision: RELIABLE_STREAM_LITE_VERSION,
    label: `ReliableStreamLite · ${participant}`,
    layer: 'transport',
    codec: 'logical-packet',
    requires: {
      id: 'network',
      role: 'requires',
      service: {
        kind: 'datagram',
        payload: {
          id: 'reliable_stream_lite_packet',
          revision: RELIABLE_STREAM_LITE_VERSION,
          messages,
        },
      },
      request: 'send',
      indication: 'receive',
      lifecycle: { initial: 'ready', notifications: [] },
    },
    provides: {
      id: 'upper',
      role: 'provides',
      service: { kind: 'stream', payload: 'bytes' },
      request: 'write',
      indication: 'read',
      lifecycle: { initial: 'ready', notifications: ['failed'] },
    },
    messages,
    states: [
      { id: 'Ready', label: '쓰기 준비' },
      { id: 'Waiting', label: 'DATA ACK 대기' },
      { id: 'Failed', label: '서비스 실패', terminal: true },
    ],
    initialStateId: 'Ready',
    variables: [
      { id: 'txDirection', type: 'string', initial: participant === 'A' ? 'AtoB' : 'BtoA' },
      { id: 'rxDirection', type: 'string', initial: participant === 'A' ? 'BtoA' : 'AtoB' },
      ...['pending', 'queued', 'cached'].map((id) => ({
        id,
        type: 'bytes' as const,
        initial: empty,
      })),
      ...[
        'txSeq',
        'expectedSeq',
        'offset',
        'retries',
        'initialSends',
        'retransmissions',
        'deliveredChunks',
        'duplicateChunks',
        'receivedBytes',
      ].map((id) => ({ id, type: 'integer' as const, initial: 0 })),
      { id: 'chunkBytes', type: 'integer', initial: chunkBytes },
      { id: 'timeoutMs', type: 'integer', initial: timeoutMs },
      { id: 'maxRetries', type: 'integer', initial: maxRetries },
      { id: 'maxSequence', type: 'integer', initial: maxSequence },
      { id: 'failureReason', type: 'string', initial: '' },
    ],
    timers: [{ id: 'ack' }],
    rules,
  };
}
