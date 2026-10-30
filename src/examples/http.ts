import type {
  Action,
  ExperimentDefinition,
  ProtocolDefinition,
  RuleDefinition,
  ValueExpression,
} from '../domain/protocol-model.ts';

export type HttpVariant = 'get' | 'post' | 'split' | 'bad-header' | 'incomplete-body' | 'delayed';
const fixed = (value: string | number): ValueExpression => ({ kind: 'literal', value });
const field = (fieldId: string): ValueExpression => ({ kind: 'field', fieldId });
const variable = (variableId: string): ValueExpression => ({ kind: 'variable', variableId });
const copy = (ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id, field(id)]));

/** Define a single HTTP exchange with byte framing, configurable processing wait and response timeout. */
export function createHttpProtocol(): ProtocolDefinition {
  const requestValues = copy(['method', 'target', 'host', 'contentType', 'body']);
  const responseValues = {
    status: fixed(200),
    reason: fixed('OK'),
    contentType: fixed('text/plain; charset=utf-8'),
    body: variable('pendingBody'),
  };
  const send: Action = { kind: 'send', messageId: 'request', values: requestValues };
  const responseTimer: Action = {
    kind: 'start-timer',
    timerId: 'response',
    durationMs: fixed(500),
  };
  const rules: RuleDefinition[] = [
    {
      id: 'start_request',
      fromStateId: 'Idle',
      event: { kind: 'input', messageId: 'request' },
      actions: [send, responseTimer],
      nextStateId: 'Waiting',
    },
    {
      id: 'start_raw',
      fromStateId: 'Idle',
      event: { kind: 'input', messageId: 'raw' },
      actions: [{ kind: 'send', messageId: 'raw', values: { wire: field('wire') } }, responseTimer],
      nextStateId: 'Waiting',
    },
    {
      id: 'receive_request',
      fromStateId: 'Idle',
      event: { kind: 'receive', messageId: 'request' },
      actions: [
        { kind: 'deliver', messageId: 'request', values: requestValues },
        { kind: 'assign', variableId: 'pendingBody', value: field('body') },
        { kind: 'start-timer', timerId: 'processing', durationMs: variable('responseDelayMs') },
      ],
      nextStateId: 'Responding',
    },
    {
      id: 'send_response',
      fromStateId: 'Responding',
      event: { kind: 'timer', timerId: 'processing' },
      actions: [
        { kind: 'send', messageId: 'response', values: responseValues },
        { kind: 'finish', outcome: 'success' },
      ],
      nextStateId: 'Done',
    },
    {
      id: 'complete',
      fromStateId: 'Waiting',
      event: { kind: 'receive', messageId: 'response' },
      actions: [
        { kind: 'cancel-timer', timerId: 'response' },
        {
          kind: 'deliver',
          messageId: 'response',
          values: copy(['status', 'reason', 'contentType', 'body']),
        },
        { kind: 'finish', outcome: 'success' },
      ],
      nextStateId: 'Done',
    },
    {
      id: 'timeout',
      fromStateId: 'Waiting',
      event: { kind: 'timer', timerId: 'response' },
      actions: [{ kind: 'finish', outcome: 'failure' }],
      nextStateId: 'TimedOut',
    },
    ...(['Done', 'TimedOut'] as const).map(
      (state): RuleDefinition => ({
        id: `late_response_${state}`,
        fromStateId: state,
        event: { kind: 'receive', messageId: 'response' },
        actions: [],
        ignore: true,
        nextStateId: state,
      }),
    ),
    ...(['Idle', 'Done', 'TimedOut'] as const).map(
      (state): RuleDefinition => ({
        id: `eof_${state}`,
        fromStateId: state,
        event: { kind: 'connection', state: 'closed' },
        actions: [],
        ignore: true,
        nextStateId: state,
      }),
    ),
  ];
  const body = {
    id: 'body',
    name: 'body',
    type: 'string',
    required: false,
    defaultValue: '',
    placement: 'body',
    maxLength: 100_000,
  } as const;
  const contentType = {
    id: 'contentType',
    name: 'Content-Type',
    type: 'string',
    required: false,
    defaultValue: 'text/plain; charset=utf-8',
    placement: 'header',
  } as const;
  return {
    schemaVersion: 1,
    id: 'http_exchange',
    revision: 1,
    label: 'HTTP/1.1 · 제한된 요청/응답',
    layer: 'application',
    lowerService: 'stream',
    codec: 'http-1.1',
    messages: [
      {
        id: 'request',
        label: 'HTTP 요청',
        http: {
          kind: 'request',
          methodFieldId: 'method',
          targetFieldId: 'target',
          bodyFieldId: 'body',
        },
        fields: [
          {
            id: 'method',
            name: 'method',
            type: 'enum',
            options: ['GET', 'POST'],
            required: true,
            placement: 'header',
          },
          {
            id: 'target',
            name: 'target',
            type: 'string',
            required: true,
            placement: 'header',
            minLength: 1,
          },
          {
            id: 'host',
            name: 'Host',
            type: 'string',
            required: true,
            placement: 'header',
            minLength: 1,
          },
          contentType,
          body,
        ],
      },
      {
        id: 'response',
        label: 'HTTP 응답',
        http: {
          kind: 'response',
          statusFieldId: 'status',
          reasonFieldId: 'reason',
          bodyFieldId: 'body',
        },
        fields: [
          {
            id: 'status',
            name: 'status',
            type: 'integer',
            min: 200,
            max: 599,
            required: true,
            placement: 'header',
          },
          { id: 'reason', name: 'reason', type: 'string', required: true, placement: 'header' },
          contentType,
          body,
        ],
      },
      {
        id: 'raw',
        label: '원시 HTTP · 오류 실험',
        http: { kind: 'raw', wireFieldId: 'wire' },
        fields: [
          {
            id: 'wire',
            name: 'raw HTTP bytes (UTF-8)',
            type: 'string',
            required: true,
            placement: 'payload',
            maxLength: 100_000,
          },
        ],
      },
    ],
    states: [
      { id: 'Idle', label: '대기' },
      { id: 'Waiting', label: '응답 대기' },
      { id: 'Responding', label: '응답 처리 중' },
      { id: 'Done', label: '완료', terminal: true },
      { id: 'TimedOut', label: '응답 기한 초과', terminal: true },
    ],
    initialStateId: 'Idle',
    variables: [
      { id: 'pendingBody', type: 'string', initial: '' },
      { id: 'responseDelayMs', type: 'integer', initial: 0 },
    ],
    timers: [{ id: 'response' }, { id: 'processing' }],
    rules,
  };
}

/** Build the normal, split, malformed or delayed HTTP scenario used by the catalog and runtime. */
export function createHttpExperiment(variant: HttpVariant = 'get'): ExperimentDefinition {
  let protocol = createHttpProtocol();
  const malformed = variant === 'bad-header' || variant === 'incomplete-body';
  const post = variant === 'post' || variant === 'split';
  const payload = post ? '안녕하세요' : '';
  if (variant === 'delayed')
    protocol = {
      ...protocol,
      variables: protocol.variables.map((item) =>
        item.id === 'responseDelayMs' ? { ...item, initial: 600 } : item,
      ),
    };
  return {
    schemaVersion: 1,
    id: `http_${variant.replaceAll('-', '_')}`,
    label: `HTTP/1.1 · ${variant}`,
    seed: 42,
    protocols: { A: { id: protocol.id, revision: 1 }, B: { id: protocol.id, revision: 1 } },
    definitions: [protocol],
    environment: {
      schemaVersion: 1,
      id: 'http_stream',
      kind: 'stream',
      directions: {
        AtoB: { delayMs: 10, chunkBytes: variant === 'split' ? 1 : 65536 },
        BtoA: { delayMs: 10, chunkBytes: variant === 'split' ? 1 : 65536 },
      },
      connections:
        variant === 'incomplete-body' ? [{ direction: 'AtoB', kind: 'close', timeMs: 50 }] : [],
    },
    scenario: {
      schemaVersion: 1,
      id: 'http_scenario',
      observationMs: 800,
      inputs: [
        {
          id: 'initial',
          timeMs: 0,
          participant: 'A',
          message: malformed
            ? {
                messageId: 'raw',
                values: {
                  wire:
                    variant === 'bad-header'
                      ? 'GET / HTTP/1.1\r\nHost : example.test\r\nContent-Length: 0\r\n\r\n'
                      : 'POST /echo HTTP/1.1\r\nHost: example.test\r\nContent-Length: 9\r\n\r\n안녕',
                },
              }
            : {
                messageId: 'request',
                values: {
                  method: post ? 'POST' : 'GET',
                  target: post ? '/echo' : '/',
                  host: 'example.test',
                  body: payload,
                },
              },
        },
      ],
      expectations: malformed
        ? [
            {
              id: 'no_response',
              kind: 'delivery-count',
              participant: 'A',
              messageId: 'response',
              count: 0,
            },
            { id: 'sender_timeout', kind: 'state', participant: 'A', stateId: 'TimedOut' },
            {
              id: 'receiver_no_request',
              kind: 'delivery-count',
              participant: 'B',
              messageId: 'request',
              count: 0,
            },
          ]
        : variant === 'delayed'
          ? [
              { id: 'expected_timeout', kind: 'state', participant: 'A', stateId: 'TimedOut' },
              {
                id: 'no_upper_response',
                kind: 'delivery-count',
                participant: 'A',
                messageId: 'response',
                count: 0,
              },
            ]
          : [
              { id: 'client_done', kind: 'state', participant: 'A', stateId: 'Done' },
              { id: 'server_done', kind: 'state', participant: 'B', stateId: 'Done' },
              {
                id: 'response_once',
                kind: 'delivery-count',
                participant: 'A',
                messageId: 'response',
                count: 1,
              },
              {
                id: 'response_content',
                kind: 'delivered-values',
                participant: 'A',
                message: {
                  messageId: 'response',
                  values: { status: 200, reason: 'OK', body: payload },
                },
              },
            ],
    },
  };
}
