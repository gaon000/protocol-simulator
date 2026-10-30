import type {
  JsonValue,
  ParticipantId,
  ProtocolLayer,
  RunSnapshot,
  ServiceKind,
} from './execution-contract.ts';

export type Scalar = string | number | boolean;
type FieldBase = {
  readonly id: string;
  readonly name: string;
  readonly required: boolean;
  readonly placement: 'header' | 'body' | 'payload';
};
export type FieldDefinition = FieldBase &
  (
    | {
        readonly type: 'string';
        readonly minLength?: number;
        readonly maxLength?: number;
        readonly defaultValue?: string;
      }
    | {
        readonly type: 'integer';
        readonly min?: number;
        readonly max?: number;
        readonly defaultValue?: number;
      }
    | { readonly type: 'boolean'; readonly defaultValue?: boolean }
    | { readonly type: 'enum'; readonly options: readonly string[]; readonly defaultValue?: string }
  );
export type MessageDefinition = {
  readonly id: string;
  readonly label: string;
  readonly fields: readonly FieldDefinition[];
};
export type MessageValues = Readonly<Record<string, Scalar>>;
export type ProtocolMessage = { readonly messageId: string; readonly values: MessageValues };
export type VariableDefinition = {
  readonly id: string;
  readonly type: 'string' | 'integer' | 'boolean' | 'json';
  readonly initial: JsonValue;
};
export type ValueExpression =
  | { readonly kind: 'literal'; readonly value: JsonValue }
  | { readonly kind: 'variable'; readonly variableId: string }
  | { readonly kind: 'field'; readonly fieldId: string }
  | {
      readonly kind: 'add' | 'subtract';
      readonly left: ValueExpression;
      readonly right: ValueExpression;
    };
export type Condition =
  | {
      readonly kind: 'compare';
      readonly operator: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
      readonly left: ValueExpression;
      readonly right: ValueExpression;
    }
  | { readonly kind: 'all' | 'any'; readonly conditions: readonly Condition[] }
  | { readonly kind: 'not'; readonly condition: Condition };
export type RuleEvent =
  | { readonly kind: 'input' | 'receive'; readonly messageId: string }
  | { readonly kind: 'timer'; readonly timerId: string }
  | { readonly kind: 'connection'; readonly state: 'closed' | 'failed' };
export type Action =
  | {
      readonly kind: 'send' | 'deliver';
      readonly messageId: string;
      readonly values: Readonly<Record<string, ValueExpression>>;
    }
  | { readonly kind: 'assign'; readonly variableId: string; readonly value: ValueExpression }
  | { readonly kind: 'start-timer'; readonly timerId: string; readonly durationMs: ValueExpression }
  | { readonly kind: 'cancel-timer'; readonly timerId: string }
  | { readonly kind: 'finish'; readonly outcome: 'success' | 'failure' };
export type RuleDefinition = {
  readonly id: string;
  readonly fromStateId: string;
  readonly event: RuleEvent;
  readonly condition?: Condition;
  readonly actions: readonly Action[];
  readonly nextStateId: string;
  readonly ignore?: boolean;
};
export type ProtocolDefinition = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly label: string;
  readonly layer: ProtocolLayer;
  readonly lowerService: ServiceKind;
  readonly codec: 'json-lines' | 'json-datagram' | 'logical-packet';
  readonly messages: readonly MessageDefinition[];
  readonly states: readonly {
    readonly id: string;
    readonly label: string;
    readonly terminal?: boolean;
  }[];
  readonly initialStateId: string;
  readonly variables: readonly VariableDefinition[];
  readonly timers: readonly { readonly id: string }[];
  readonly rules: readonly RuleDefinition[];
};

export type Direction = 'AtoB' | 'BtoA';
type DirectionSettings<Settings> = Readonly<Record<Direction, Settings>>;
export type EnvironmentDefinition = {
  readonly schemaVersion: 1;
  readonly id: string;
} & (
  | {
      readonly kind: 'stream';
      readonly directions: DirectionSettings<{
        readonly delayMs: number;
        readonly chunkBytes: number;
      }>;
      readonly connections: readonly {
        readonly timeMs: number;
        readonly direction: Direction;
        readonly kind: 'close' | 'fail';
      }[];
    }
  | {
      readonly kind: 'datagram';
      readonly directions: DirectionSettings<{
        readonly delayMs: number;
        readonly jitterMs: number;
        readonly lossRate: number;
        readonly duplicateRate: number;
      }>;
      readonly targetedDrops: readonly {
        readonly direction: Direction;
        readonly transmission: number;
      }[];
    }
);
export type Expectation = { readonly id: string; readonly participant: ParticipantId } & (
  | { readonly kind: 'state'; readonly stateId: string }
  | { readonly kind: 'delivery-count'; readonly messageId: string; readonly count: number }
  | { readonly kind: 'delivered-values'; readonly message: ProtocolMessage }
  | { readonly kind: 'completion-before'; readonly timeMs: number }
);
export type ScenarioDefinition = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly observationMs: number;
  readonly inputs: readonly {
    readonly id: string;
    readonly timeMs: number;
    readonly participant: ParticipantId;
    readonly message: ProtocolMessage;
  }[];
  readonly expectations: readonly Expectation[];
};
export type ExperimentDefinition = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly label: string;
  readonly seed: number;
  readonly protocols: Readonly<
    Record<ParticipantId, { readonly id: string; readonly revision: number }>
  >;
  readonly definitions: readonly ProtocolDefinition[];
  readonly environment: EnvironmentDefinition;
  readonly scenario: ScenarioDefinition;
};
export type ExperimentSnapshot = RunSnapshot<ExperimentDefinition>;
export type EventTrace = {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly eventId: string;
  readonly timeMs: number;
  readonly sequence: number;
  readonly kind:
    | 'input'
    | 'send'
    | 'receive'
    | 'parsed'
    | 'deliver'
    | 'timer'
    | 'connection'
    | 'transition'
    | 'environment'
    | 'diagnostic';
  readonly participant: ParticipantId;
  readonly causeEventId?: string;
  readonly ruleId?: string;
  readonly data: JsonValue;
};
export type RunResult = {
  readonly schemaVersion: 1;
  readonly status: 'completed' | 'cancelled' | 'invalid' | 'limit-reached' | 'engine-error';
  readonly snapshot: ExperimentSnapshot;
  readonly events: readonly EventTrace[];
  readonly diagnostics: readonly ModelDiagnostic[];
  readonly expectations: readonly {
    readonly expectationId: string;
    readonly status: 'pass' | 'fail' | 'undetermined';
    readonly detail: string;
  }[];
};
export type ModelDiagnostic = {
  readonly path: string;
  readonly code: string;
  readonly message: string;
};
export type ValidationResult<Value> =
  | { readonly success: true; readonly value: Value }
  | { readonly success: false; readonly diagnostics: readonly ModelDiagnostic[] };
