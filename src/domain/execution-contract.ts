export type ProtocolLayer = 'application' | 'transport';
export type ServiceKind = 'stream' | 'datagram';
export type ParticipantId = 'A' | 'B';
export type JsonValue = null | boolean | number | string | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };
export type ImmutableJson<Value> = Value extends readonly (infer Item)[]
  ? readonly ImmutableJson<Item>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: ImmutableJson<Value[Key]> }
    : Value;

export const EXECUTION_POLICY = {
  schemaVersion: 1,
  engineVersion: '0.1.0-p5',
  randomAlgorithm: 'mulberry32-v1',
  maxEvents: 10_000,
  maxMessageBytes: 1_048_576,
  maxBufferBytes: 1_048_576,
  maxTraceBytes: 16_777_216,
  ruleConflict: 'stop',
  unmatchedEvent: 'stop-unless-explicit-ignore',
  timerIdentity: 'participant-name-generation',
  datagramDrawOrder: ['loss', 'duplicate', 'original-delay', 'duplicate-delay'],
} as const;

export interface EventOrderKey {
  readonly timeMs: number;
  readonly kind: 'input' | 'delivery' | 'connection' | 'timer';
  readonly sequence: number;
}

export interface RunSnapshot<Configuration extends JsonObject = JsonObject> {
  readonly schemaVersion: typeof EXECUTION_POLICY.schemaVersion;
  readonly engineVersion: typeof EXECUTION_POLICY.engineVersion;
  readonly randomAlgorithm: typeof EXECUTION_POLICY.randomAlgorithm;
  readonly seed: number;
  readonly configuration: ImmutableJson<Configuration>;
  readonly limits: {
    readonly maxEvents: number;
    readonly maxMessageBytes: number;
    readonly maxBufferBytes: number;
    readonly maxTraceBytes: number;
  };
}

/** Describe each lower service without making a protocol depend on its implementation. */
export type LowerServicePort =
  | { readonly kind: 'stream'; send: (bytes: readonly number[]) => void }
  | { readonly kind: 'datagram'; send: (packet: JsonObject) => void };

/** Order same-time deliveries before expiry, then preserve creation order. */
export function compareEventKeys(left: EventOrderKey, right: EventOrderKey): number {
  const leftPriority = left.kind === 'timer' ? 1 : 0;
  const rightPriority = right.kind === 'timer' ? 1 : 0;
  return (
    left.timeMs - right.timeMs || leftPriority - rightPriority || left.sequence - right.sequence
  );
}

function checkSeed(seed: number): void {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError('seed must be an unsigned 32-bit integer');
  }
}

/** Create the versioned deterministic PRNG; a zero seed is valid. */
export function createSeededRandom(seed: number): () => number {
  checkSeed(seed);
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function freezeJson(value: JsonValue): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
}

/** Capture an isolated JSON configuration; full protocol validation belongs to P1. */
export function createRunSnapshot<Configuration extends JsonObject>(
  configuration: Configuration,
  seed: number,
): RunSnapshot<Configuration> {
  checkSeed(seed);
  const copy = structuredClone(configuration);
  freezeJson(copy);
  return Object.freeze({
    schemaVersion: EXECUTION_POLICY.schemaVersion,
    engineVersion: EXECUTION_POLICY.engineVersion,
    randomAlgorithm: EXECUTION_POLICY.randomAlgorithm,
    seed,
    configuration: copy as ImmutableJson<Configuration>,
    limits: Object.freeze({
      maxEvents: EXECUTION_POLICY.maxEvents,
      maxMessageBytes: EXECUTION_POLICY.maxMessageBytes,
      maxBufferBytes: EXECUTION_POLICY.maxBufferBytes,
      maxTraceBytes: EXECUTION_POLICY.maxTraceBytes,
    }),
  });
}
