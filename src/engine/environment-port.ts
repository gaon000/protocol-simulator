import type { LogicalPacket } from '../codecs/message-codecs.ts';
import type { JsonObject, ParticipantId } from '../domain/execution-contract.ts';
import type {
  EnvironmentDefinition,
  ExperimentSnapshot,
  ValidationResult,
} from '../domain/protocol-model.ts';

export type WirePayload =
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
  | { readonly kind: 'packet'; readonly packet: LogicalPacket };
export type Transmission = {
  readonly from: ParticipantId;
  readonly to: ParticipantId;
  readonly timeMs: number;
  readonly transmission: number;
  readonly causeEventId: string;
  readonly payload: WirePayload;
};
export type DeliveryEvent = {
  readonly kind: 'delivery';
  readonly timeMs: number;
  readonly from: ParticipantId;
  readonly to: ParticipantId;
  readonly payload: WirePayload;
  readonly causeEventId: string;
  readonly sourceEventIds?: readonly string[];
  readonly copy?: 'original' | 'duplicate';
  readonly transmission?: number;
};
export type EnvironmentEvent =
  | DeliveryEvent
  | { readonly kind: 'stream-read'; readonly timeMs: number; readonly readId: string }
  | {
      readonly kind: 'connection';
      readonly timeMs: number;
      readonly participant: ParticipantId;
      readonly state: 'closed' | 'failed';
    }
  | {
      readonly kind: 'notice';
      readonly timeMs: number;
      readonly participant: ParticipantId;
      readonly causeEventId: string;
      readonly detail: JsonObject;
    };
export type EnvironmentAdapter = {
  readonly initialEvents: () => Iterable<EnvironmentEvent>;
  readonly transmit: (transmission: Transmission) => Iterable<EnvironmentEvent>;
  readonly readStream?: (readId: string) => Iterable<DeliveryEvent>;
  readonly dispose?: () => void;
};
export type EnvironmentFactory = (
  definition: EnvironmentDefinition,
  random: () => number,
  limits?: ExperimentSnapshot['limits'],
) => ValidationResult<EnvironmentAdapter>;

/** Signal bounded environment storage exhaustion without misreporting protocol failure. */
export class EnvironmentLimit extends Error {
  constructor() {
    super('Pending stream bytes exceed the run environment limit');
  }
}
