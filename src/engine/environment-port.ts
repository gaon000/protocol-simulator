import type { LogicalPacket } from '../codecs/message-codecs.ts';
import type { JsonObject, ParticipantId } from '../domain/execution-contract.ts';
import type { EnvironmentDefinition, ValidationResult } from '../domain/protocol-model.ts';

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
export type EnvironmentEvent =
  | {
      readonly kind: 'delivery';
      readonly timeMs: number;
      readonly from: ParticipantId;
      readonly to: ParticipantId;
      readonly payload: WirePayload;
      readonly causeEventId: string;
    }
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
};
export type EnvironmentFactory = (
  definition: EnvironmentDefinition,
  random: () => number,
) => ValidationResult<EnvironmentAdapter>;
