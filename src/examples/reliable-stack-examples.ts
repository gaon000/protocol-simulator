import { freezeOwned } from '../domain/immutable-data.ts';
import { parseExperiment } from '../domain/model-validation.ts';
import type {
  EnvironmentDefinition,
  ExperimentDefinition,
  ProtocolDefinition,
  RuleDefinition,
} from '../domain/protocol-model.ts';
import {
  defaultStackLimits,
  type StackExperiment,
  type StackProtocol,
} from '../domain/stack-model.ts';
import { adaptLegacyApplication } from '../domain/stack-protocol-validation.ts';
import { parseStackExperiment } from '../domain/stack-validation.ts';
import { createHttpExperiment } from './http.ts';
import { createPingPongExperiment } from './ping-pong.ts';
import {
  createReliableStreamLiteProtocol,
  type ReliableStreamOptions,
} from './reliable-stream-lite.ts';

export type ReliableStackOptions = ReliableStreamOptions & {
  readonly environment?: Extract<EnvironmentDefinition, { kind: 'datagram' }>;
  readonly observationMs?: number;
};
export type ReliableStackVariant =
  | 'ping-pong'
  | 'first-ack-loss'
  | 'http-get'
  | 'http-post'
  | 'http-split';

/** Compose an explicit stream application with two independent providers and one bottom datagram link. */
export function createReliableStackExperiment(
  application: ExperimentDefinition,
  options: ReliableStackOptions = {},
): StackExperiment {
  const checked = parseExperiment(application);
  if (!checked.success)
    throw new TypeError(`Invalid application: ${JSON.stringify(checked.diagnostics)}`);
  if (application.environment.kind !== 'stream' || application.environment.connections.length)
    throw new TypeError(
      'Composition requires a stream application without scheduled close/fail events',
    );
  const definitions = new Map<string, StackProtocol>();
  const reference = (participant: 'A' | 'B') => {
    const source = application.protocols[participant];
    const protocol = application.definitions.find(
      (definition) => definition.id === source.id && definition.revision === source.revision,
    );
    const adapted = adaptLegacyApplication(protocol);
    if (!adapted.success || adapted.value.requires.service.kind !== 'stream')
      throw new TypeError('ReliableStreamLite provides stream bytes to applications only');
    definitions.set(`${adapted.value.id}@${adapted.value.revision}`, adapted.value);
    return { id: adapted.value.id, revision: adapted.value.revision };
  };
  const apps = { A: reference('A'), B: reference('B') };
  const providers = {
    A: createReliableStreamLiteProtocol('A', options),
    B: createReliableStreamLiteProtocol('B', options),
  };
  for (const provider of Object.values(providers)) {
    const key = `${provider.id}@${provider.revision}`;
    if (definitions.has(key))
      throw new TypeError('Application/provider definition identity collision');
    definitions.set(key, provider);
  }
  const node = (participant: 'A' | 'B') => ({
    instances: [
      { id: 'app', definition: apps[participant] },
      {
        id: 'transport',
        definition: { id: providers[participant].id, revision: providers[participant].revision },
      },
    ],
  });
  const nodes = { A: node('A'), B: node('B') };
  const observationMs = options.observationMs ?? application.scenario.observationMs;
  const experiment: StackExperiment = {
    schemaVersion: 2,
    mode: 'stack',
    id: `reliable_${application.id}`,
    label: `${application.label} · ReliableStreamLite`,
    seed: application.seed,
    definitions: [...definitions.values()],
    nodes,
    bindings: (['A', 'B'] as const).map((participant) => ({
      id: `local_${participant}`,
      consumer: { participant, instanceId: 'app', portId: 'lower' },
      provider: { participant, instanceId: 'transport', portId: 'upper' },
    })),
    link: {
      id: 'datagram_link',
      A: { participant: 'A', instanceId: 'transport', portId: 'network' },
      B: { participant: 'B', instanceId: 'transport', portId: 'network' },
      environment: options.environment
        ? structuredClone(options.environment)
        : {
            schemaVersion: 1,
            id: 'reliable_link',
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
      id: application.scenario.id,
      observationMs,
      inputs: application.scenario.inputs.map(({ participant, ...input }) => ({
        ...structuredClone(input),
        target: { participant, instanceId: 'app' },
      })),
      expectations: application.scenario.expectations.map(({ participant, ...expectation }) => ({
        ...structuredClone(expectation),
        target: { participant, instanceId: 'app' },
      })),
    },
    limits: defaultStackLimits(),
  };
  const parsed = parseStackExperiment(experiment);
  if (!parsed.success)
    throw new TypeError(`Invalid stack composition: ${JSON.stringify(parsed.diagnostics)}`);
  return experiment;
}

function serviceAwareCopy(protocol: ProtocolDefinition, responseMs: number): ProtocolDefinition {
  const states = [
    ...protocol.states,
    { id: 'StreamFailed', label: '하위 스트림 실패', terminal: true },
  ];
  const failureRules: RuleDefinition[] = states.map((state) => ({
    id: `stream_failed_${state.id}`,
    fromStateId: state.id,
    nextStateId: state.terminal ? state.id : 'StreamFailed',
    event: { kind: 'connection', state: 'failed' },
    actions: state.terminal ? [] : [{ kind: 'finish', outcome: 'failure' }],
    ...(state.terminal ? { ignore: true } : {}),
  }));
  return {
    ...protocol,
    id: `${protocol.id}_reliable`,
    revision: 1,
    label: `${protocol.label} · stream failure handling`,
    states,
    rules: [
      ...protocol.rules.map((rule) => ({
        ...rule,
        actions: [
          ...(protocol.id === 'ping_pong' && rule.id === 'reply'
            ? [
                {
                  kind: 'deliver' as const,
                  messageId: 'ping',
                  values: Object.fromEntries(
                    ['sequence', 'text', 'mode', 'urgent'].map((fieldId) => [
                      fieldId,
                      { kind: 'field' as const, fieldId },
                    ]),
                  ),
                },
              ]
            : []),
          ...rule.actions.map((action) =>
            action.kind === 'start-timer' && action.timerId === 'response'
              ? { ...action, durationMs: { kind: 'literal' as const, value: responseMs } }
              : action,
          ),
        ],
      })),
      ...failureRules,
      ...(protocol.id === 'ping_pong'
        ? [
            {
              id: 'late_pong_Failed',
              fromStateId: 'Failed',
              nextStateId: 'Failed',
              event: { kind: 'receive' as const, messageId: 'pong' },
              actions: [],
              ignore: true,
            },
          ]
        : []),
    ],
  };
}

/** Build the initial Ping/Pong and limited HTTP examples without exposing unfinished stack UI/storage. */
export function createReliableStackExample(
  variant: ReliableStackVariant = 'ping-pong',
): StackExperiment {
  if (!['ping-pong', 'first-ack-loss', 'http-get', 'http-post', 'http-split'].includes(variant))
    throw new RangeError('Unknown reliable stack example');
  const split = variant === 'http-split';
  const original = variant.startsWith('http-')
    ? createHttpExperiment(variant === 'http-get' ? 'get' : 'post')
    : createPingPongExperiment();
  const responseMs = split ? 15_000 : 500;
  const source = original.definitions[0];
  if (!source) throw new Error('Application example is absent');
  const application = serviceAwareCopy(source, responseMs);
  const adapted: ExperimentDefinition = {
    ...original,
    definitions: [application],
    protocols: {
      A: { id: application.id, revision: application.revision },
      B: { id: application.id, revision: application.revision },
    },
    scenario: {
      ...original.scenario,
      observationMs: split ? 16_000 : 800,
      expectations: original.scenario.expectations.map((expectation) =>
        expectation.kind === 'completion-before'
          ? { ...expectation, timeMs: responseMs }
          : expectation,
      ),
    },
  };
  const result = createReliableStackExperiment(adapted, { chunkBytes: split ? 1 : 64 });
  return {
    ...result,
    id: `stack_${variant.replaceAll('-', '_')}`,
    label: `ReliableStreamLite · ${variant}`,
    link: {
      ...result.link,
      environment: {
        ...result.link.environment,
        targetedDrops: variant === 'first-ack-loss' ? [{ direction: 'BtoA', transmission: 1 }] : [],
      },
    },
    scenario: {
      ...result.scenario,
      expectations: [
        ...result.scenario.expectations,
        {
          id: 'request_once',
          kind: 'delivery-count',
          target: { participant: 'B', instanceId: 'app' },
          messageId: variant.startsWith('http-') ? 'request' : 'ping',
          count: 1,
        },
        ...(result.scenario.inputs[0]
          ? [
              {
                id: 'request_content',
                kind: 'delivered-values' as const,
                target: { participant: 'B' as const, instanceId: 'app' },
                message: structuredClone(result.scenario.inputs[0].message),
              },
            ]
          : []),
        ...(['A', 'B'] as const).map((participant) => ({
          id: `provider_ready_${participant}`,
          kind: 'state' as const,
          target: { participant, instanceId: 'transport' },
          stateId: 'Ready',
        })),
      ],
    },
  };
}

export type StackExample = {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly supported: readonly string[];
  readonly omitted: readonly string[];
  readonly sources: readonly { readonly title: string; readonly url: string }[];
  readonly build: () => StackExperiment;
};
const entries: readonly StackExample[] = (
  ['ping-pong', 'first-ack-loss', 'http-get', 'http-post', 'http-split'] as const
).map((variant) => ({
  id: `stack_${variant.replaceAll('-', '_')}`,
  version: 1,
  title: `ReliableStreamLite · ${variant}`,
  description:
    variant === 'first-ack-loss'
      ? '첫 ACK 손실 뒤 실제 재전송과 한 번 전달을 관찰합니다.'
      : '사용자 정의 양방향 스트림 provider에 응용 메시지 코덱을 연결합니다.',
  supported: [
    '이미 준비된 A/B 양방향 스트림, 방향별 DATA 하나와 write 사이에 이어지는 seq',
    '유한 재시도·기대 순서 read·중복 DATA 재ACK·미래/다른 방향 패킷 무시',
    ...(variant.startsWith('http-')
      ? ['기존 제한된 HTTP/1.1 GET/POST·Content-Length·UTF-8 점진 해석']
      : ['JSON Lines Ping/Pong·UTF-8와 프레임 경계']),
  ],
  omitted: [
    'TCP가 아닌 프로젝트 사용자 정의 규약. 연결 수립/종료·half-close·재연결 제외',
    '윈도/혼잡 제어·seq wraparound·영구적인 장애에서 전달 보장 제외',
    '실제 소켓·스택 UI/저장·관찰 도구 통합은 후속',
    ...(variant.startsWith('http-') ? ['전체 HTTP/TLS·HTTP/2/3·chunked·압축·다중 교환 제외'] : []),
  ],
  sources: [
    {
      title: '프로젝트 ReliableStreamLite 설계 v1',
      url: 'https://github.com/gaon000/protocol-simulator/blob/master/docs/design-docs/s3-reliable-stream-lite.md',
    },
    ...(variant.startsWith('http-')
      ? [
          {
            title: '기존 제한된 HTTP 코덱/응용 예제',
            url: 'https://github.com/gaon000/protocol-simulator/blob/88ba047/src/examples/http.ts',
          },
        ]
      : []),
  ],
  build: () => createReliableStackExample(variant),
}));
export const STACK_EXAMPLES: readonly StackExample[] = freezeOwned(entries);
const originals = new Map(
  STACK_EXAMPLES.map((entry) => [
    entry.id,
    freezeOwned({ ...entry.build(), origin: { exampleId: entry.id, version: entry.version } }),
  ]),
);
let nextCopy = 0;

/** Read a versioned immutable stack example with its complete actual definitions and topology. */
export function getStackExampleOriginal(id: string): StackExperiment {
  const original = originals.get(id);
  if (!original) throw new RangeError(`Unknown stack example ${id}`);
  return original;
}

/** Create an independent editable copy without rewriting any previous source or execution snapshot. */
export function createStackExampleCopy(id: string): StackExperiment {
  const original = getStackExampleOriginal(id);
  return {
    ...structuredClone(original),
    id: `stack_copy_${++nextCopy}`,
    label: `${original.label} 사본`,
  };
}
