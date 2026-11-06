import type { JsonValue, ParticipantId, ProtocolLayer } from './execution-contract.ts';
import type {
  EnvironmentDefinition,
  FieldDefinition,
  MessageDefinition,
  ProtocolDefinition,
} from './protocol-model.ts';

/** Versioned stack-only limits; legacy execution policy remains unchanged. */
export const STACK_POLICY = {
  schemaVersion: 2,
  engineVersion: 'stack-1',
  randomAlgorithm: 'mulberry32-v1',
  adapterVersion: 'v1-application-ports/1',
  maxEvents: 10_000,
  maxPendingOperations: 10_000,
  maxTraceEvents: 10_000,
  maxMessageBytes: 1_048_576,
  maxCodecBufferBytes: 1_048_576,
  maxPortBytes: 1_048_576,
  maxPayloadBytes: 8_388_608,
  maxLiveBytes: 8_388_608,
  maxArtifactBytes: 16_777_216,
  maxExpressionDepth: 32,
  maxExpressionNodes: 4_096,
} as const;

export type StackLimits = {
  readonly [Key in keyof Pick<
    typeof STACK_POLICY,
    | 'maxEvents'
    | 'maxPendingOperations'
    | 'maxTraceEvents'
    | 'maxMessageBytes'
    | 'maxCodecBufferBytes'
    | 'maxPortBytes'
    | 'maxPayloadBytes'
    | 'maxLiveBytes'
    | 'maxArtifactBytes'
  >]: number;
};

export type BytesValue = {
  readonly kind: 'bytes';
  readonly encoding: 'base64';
  readonly byteLength: number;
  readonly data: string;
};
export type StackValueType = 'string' | 'integer' | 'boolean' | 'json' | 'bytes';
export type StackField =
  | FieldDefinition
  | {
      readonly id: string;
      readonly name: string;
      readonly required: boolean;
      readonly placement: 'header' | 'body' | 'payload';
      readonly type: 'bytes';
      readonly minBytes?: number;
      readonly maxBytes?: number;
      readonly defaultValue?: BytesValue;
    };
export type StackMessageDefinition = Omit<MessageDefinition, 'fields'> & {
  readonly fields: readonly StackField[];
};
export type StackMessage = {
  readonly messageId: string;
  readonly values: Readonly<Record<string, string | number | boolean | BytesValue>>;
};
export type StackExpression =
  | { readonly kind: 'literal'; readonly value: JsonValue }
  | { readonly kind: 'variable'; readonly variableId: string }
  | { readonly kind: 'field'; readonly fieldId: string }
  | { readonly kind: 'service-payload' }
  | {
      readonly kind: 'add' | 'subtract';
      readonly left: StackExpression;
      readonly right: StackExpression;
    }
  | { readonly kind: 'byteLength'; readonly value: StackExpression }
  | {
      readonly kind: 'slice';
      readonly value: StackExpression;
      readonly offset: StackExpression;
      readonly length: StackExpression;
    }
  | { readonly kind: 'concat'; readonly values: readonly StackExpression[] };
export type StackCondition =
  | {
      readonly kind: 'compare';
      readonly operator: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
      readonly left: StackExpression;
      readonly right: StackExpression;
    }
  | { readonly kind: 'all' | 'any'; readonly conditions: readonly StackCondition[] }
  | { readonly kind: 'not'; readonly condition: StackCondition };

export type PacketSchema = {
  readonly id: string;
  readonly revision: number;
  readonly messages: readonly StackMessageDefinition[];
};
export type StackService =
  | { readonly kind: 'stream'; readonly payload: 'bytes' }
  | { readonly kind: 'datagram'; readonly payload: 'bytes' }
  | { readonly kind: 'datagram'; readonly payload: PacketSchema };
export type ServicePort = {
  readonly id: string;
  readonly role: 'requires' | 'provides';
  readonly service: StackService;
  readonly request: 'write' | 'send';
  readonly indication: 'read' | 'receive';
  readonly lifecycle: {
    readonly initial: 'ready';
    readonly notifications: readonly ('failed' | 'closed')[];
  };
};
export type StackRuleEvent =
  | { readonly kind: 'input' | 'receive'; readonly messageId: string }
  | { readonly kind: 'timer'; readonly timerId: string }
  | { readonly kind: 'connection'; readonly state: 'closed' | 'failed' }
  | {
      readonly kind: 'service-request';
      readonly portId: string;
      readonly operation: 'write' | 'send';
    }
  | {
      readonly kind: 'service-indication';
      readonly portId: string;
      readonly operation: 'read' | 'receive' | 'failed' | 'closed';
    };
export type StackAction =
  | {
      readonly kind: 'send' | 'deliver';
      readonly messageId: string;
      readonly values: Readonly<Record<string, StackExpression>>;
    }
  | { readonly kind: 'assign'; readonly variableId: string; readonly value: StackExpression }
  | { readonly kind: 'start-timer'; readonly timerId: string; readonly durationMs: StackExpression }
  | { readonly kind: 'cancel-timer'; readonly timerId: string }
  | { readonly kind: 'finish'; readonly outcome: 'success' | 'failure' }
  | {
      readonly kind: 'service-indicate';
      readonly portId: string;
      readonly operation: 'read' | 'receive';
      readonly payload: StackExpression;
    }
  | {
      readonly kind: 'service-indicate';
      readonly portId: string;
      readonly operation: 'failed' | 'closed';
    };
export type StackRule = {
  readonly id: string;
  readonly fromStateId: string;
  readonly event: StackRuleEvent;
  readonly condition?: StackCondition;
  readonly actions: readonly StackAction[];
  readonly nextStateId: string;
  readonly ignore?: boolean;
};
export type StackProtocolBody = {
  readonly layer: ProtocolLayer;
  readonly codec: ProtocolDefinition['codec'];
  readonly messages: readonly StackMessageDefinition[];
  readonly states: ProtocolDefinition['states'];
  readonly initialStateId: string;
  readonly variables: readonly {
    readonly id: string;
    readonly type: StackValueType;
    readonly initial: JsonValue;
  }[];
  readonly timers: ProtocolDefinition['timers'];
  readonly rules: readonly StackRule[];
};
export type NativeStackProtocol = StackProtocolBody & {
  readonly schemaVersion: 2;
  readonly mode: 'stack-protocol';
  readonly id: string;
  readonly revision: number;
  readonly label: string;
  readonly requires: ServicePort;
  readonly provides?: ServicePort;
};
export type LegacyStackApplication = {
  readonly schemaVersion: 2;
  readonly mode: 'legacy-application';
  readonly id: string;
  readonly revision: number;
  readonly adapterVersion: typeof STACK_POLICY.adapterVersion;
  readonly requires: ServicePort;
  readonly source: ProtocolDefinition;
};
export type StackProtocol = NativeStackProtocol | LegacyStackApplication;
export type StackEndpoint = { readonly participant: ParticipantId; readonly instanceId: string };
export type StackPortEndpoint = StackEndpoint & { readonly portId: string };
export type StackInstance = {
  readonly id: string;
  readonly definition: { readonly id: string; readonly revision: number };
};
export type StackBinding = {
  readonly id: string;
  readonly consumer: StackPortEndpoint;
  readonly provider: StackPortEndpoint;
};
export type StackLink = {
  readonly id: string;
  readonly A: StackPortEndpoint;
  readonly B: StackPortEndpoint;
  readonly environment: Extract<EnvironmentDefinition, { readonly kind: 'datagram' }>;
};
export type StackExpectation = { readonly id: string; readonly target: StackEndpoint } & (
  | { readonly kind: 'state'; readonly stateId: string }
  | { readonly kind: 'delivery-count'; readonly messageId: string; readonly count: number }
  | { readonly kind: 'delivered-values'; readonly message: StackMessage }
  | { readonly kind: 'completion-before'; readonly timeMs: number }
);
export type StackScenario = {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly observationMs: number;
  readonly inputs: readonly {
    readonly id: string;
    readonly timeMs: number;
    readonly target: StackEndpoint;
    readonly message: StackMessage;
  }[];
  readonly expectations: readonly StackExpectation[];
};
export type StackExperiment = {
  readonly schemaVersion: 2;
  readonly mode: 'stack';
  readonly id: string;
  readonly label: string;
  readonly origin?: { readonly exampleId: string; readonly version: number };
  readonly seed: number;
  readonly definitions: readonly StackProtocol[];
  readonly nodes: Readonly<Record<ParticipantId, { readonly instances: readonly StackInstance[] }>>;
  readonly bindings: readonly StackBinding[];
  readonly link: StackLink;
  readonly scenario: StackScenario;
  readonly limits: StackLimits;
};
export type StackSnapshot = {
  readonly schemaVersion: 2;
  readonly mode: 'stack';
  readonly engineVersion: string;
  readonly randomAlgorithm: string;
  readonly configuration: StackExperiment;
};
export type PayloadRange = {
  readonly payloadId: string;
  readonly offset: number;
  readonly length: number;
};
export type StackTrace = {
  readonly schemaVersion: 2;
  readonly mode: 'stack';
  readonly runId: string;
  readonly eventId: string;
  readonly timeMs: number;
  readonly sequence: number;
  readonly endpoint: StackEndpoint;
  readonly portId?: string;
  readonly linkId?: string;
  readonly kind:
    | 'input'
    | 'send'
    | 'receive'
    | 'parsed'
    | 'deliver'
    | 'timer'
    | 'transition'
    | 'diagnostic'
    | 'environment'
    | 'connection'
    | 'service-request'
    | 'service-accepted'
    | 'service-received'
    | 'service-indication';
  readonly sourceEventIds: readonly string[];
  readonly payloads: readonly PayloadRange[];
  readonly data: JsonValue;
};
export type RunArtifacts = {
  readonly schemaVersion: 2;
  readonly mode: 'stack-artifacts';
  readonly payloads: readonly {
    readonly payloadId: string;
    readonly bytes: BytesValue;
  }[];
};

/** Resolve the executable body without treating a legacy transport as a service provider. */
export function stackProtocolBody(protocol: StackProtocol): StackProtocolBody {
  return protocol.mode === 'legacy-application' ? protocol.source : protocol;
}

/** Return a fresh JSON limit object for a new experiment. */
export function defaultStackLimits(): StackLimits {
  const {
    maxEvents,
    maxPendingOperations,
    maxTraceEvents,
    maxMessageBytes,
    maxCodecBufferBytes,
    maxPortBytes,
    maxPayloadBytes,
    maxLiveBytes,
    maxArtifactBytes,
  } = STACK_POLICY;
  return {
    maxEvents,
    maxPendingOperations,
    maxTraceEvents,
    maxMessageBytes,
    maxCodecBufferBytes,
    maxPortBytes,
    maxPayloadBytes,
    maxLiveBytes,
    maxArtifactBytes,
  };
}
