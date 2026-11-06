import type { ParticipantId } from './execution-contract.ts';
import type { EnvironmentDefinition } from './protocol-model.ts';

export type DatagramDecision = {
  readonly direction: 'AtoB' | 'BtoA';
  readonly transmission: number;
  readonly outcome: 'drop-targeted' | 'drop-random' | 'duplicate' | 'deliver';
  readonly draws: readonly number[];
  readonly deliveries: readonly {
    readonly copy: 'original' | 'duplicate';
    readonly timeMs: number;
  }[];
};

/** Plan one bottom transmission with the v1 targeted-drop/4-draw contract, without owning a queue. */
export function planDatagram(
  definition: Extract<EnvironmentDefinition, { kind: 'datagram' }>,
  from: ParticipantId,
  timeMs: number,
  transmission: number,
  random: () => number,
): DatagramDecision {
  const direction = from === 'A' ? 'AtoB' : 'BtoA';
  const settings = definition.directions[direction];
  const targeted = definition.targetedDrops.some(
    (drop) => drop.direction === direction && drop.transmission === transmission,
  );
  const draws = targeted ? [] : Array.from({ length: 4 }, () => random());
  const [loss = 0, duplicate = 0, original = 0, copy = 0] = draws;
  const dropped = targeted || loss < settings.lossRate;
  const duplicated = !dropped && duplicate < settings.duplicateRate;
  const arrival = (sample: number) => {
    const time =
      timeMs + Math.max(0, settings.delayMs + Math.round((sample * 2 - 1) * settings.jitterMs));
    if (!Number.isSafeInteger(time) || time < 0)
      throw new RangeError('Delivery time exceeds safe integer range');
    return time;
  };
  return {
    direction,
    transmission,
    outcome: targeted
      ? 'drop-targeted'
      : dropped
        ? 'drop-random'
        : duplicated
          ? 'duplicate'
          : 'deliver',
    draws,
    deliveries: dropped
      ? []
      : [
          { copy: 'original', timeMs: arrival(original) },
          ...(duplicated ? [{ copy: 'duplicate' as const, timeMs: arrival(copy) }] : []),
        ],
  };
}
