import { EXECUTION_POLICY } from '../domain/execution-contract.ts';
import type { Direction, EnvironmentDefinition } from '../domain/protocol-model.ts';
import {
  EnvironmentLimit,
  type DeliveryEvent,
  type EnvironmentEvent,
  type EnvironmentFactory,
  type Transmission,
  type WirePayload,
} from '../engine/environment-port.ts';

function directionOf(transmission: Transmission): Direction {
  return transmission.from === 'A' ? 'AtoB' : 'BtoA';
}
function safeTime(time: number): number {
  if (!Number.isSafeInteger(time) || time < 0)
    throw new RangeError('Delivery time exceeds safe integer range');
  return time;
}
function copyPayload(payload: WirePayload): WirePayload {
  return payload.kind === 'bytes'
    ? { kind: 'bytes', bytes: payload.bytes.slice() }
    : { kind: 'packet', packet: structuredClone(payload.packet) };
}

function datagramEnvironment(
  definition: Extract<EnvironmentDefinition, { kind: 'datagram' }>,
  random: () => number,
) {
  const drops = new Set(
    definition.targetedDrops.map((item) => `${item.direction}:${item.transmission}`),
  );
  function* transmit(tx: Transmission): Iterable<EnvironmentEvent> {
    const direction = directionOf(tx);
    const settings = definition.directions[direction];
    const targeted = drops.has(`${direction}:${tx.transmission}`);
    const draws = targeted ? [] : Array.from({ length: 4 }, () => random());
    const [loss = 0, duplicate = 0, originalDelay = 0, duplicateDelay = 0] = draws;
    const dropped = targeted || loss < settings.lossRate;
    const duplicated = !dropped && duplicate < settings.duplicateRate;
    const arrival = (sample: number) =>
      safeTime(
        tx.timeMs +
          Math.max(0, settings.delayMs + Math.round((sample * 2 - 1) * settings.jitterMs)),
      );
    const deliveries: { copy: 'original' | 'duplicate'; timeMs: number }[] = dropped
      ? []
      : [
          { copy: 'original', timeMs: arrival(originalDelay) },
          ...(duplicated ? [{ copy: 'duplicate' as const, timeMs: arrival(duplicateDelay) }] : []),
        ];
    const payload = dropped ? undefined : copyPayload(tx.payload);
    yield {
      kind: 'notice',
      timeMs: tx.timeMs,
      participant: tx.from,
      causeEventId: tx.causeEventId,
      detail: {
        operation: 'datagram-decision',
        direction,
        transmission: tx.transmission,
        outcome: targeted
          ? 'drop-targeted'
          : dropped
            ? 'drop-random'
            : duplicated
              ? 'duplicate'
              : 'deliver',
        draws,
        deliveries,
      },
    };
    if (!payload) return;
    for (const delivery of deliveries)
      yield {
        kind: 'delivery',
        from: tx.from,
        to: tx.to,
        timeMs: delivery.timeMs,
        payload: copyPayload(payload),
        causeEventId: tx.causeEventId,
        copy: delivery.copy,
        transmission: tx.transmission,
      };
  }
  return { initialEvents: () => [], transmit };
}

type PendingWrite = { bytes: Uint8Array; cause: string };
type ReadGroup = {
  id: string;
  key: string;
  tx: Pick<Transmission, 'from' | 'to' | 'causeEventId'>;
  direction: Direction;
  timeMs: number;
  writes: PendingWrite[];
  total: number;
};

/** Model seeded datagram faults and reliable ordered stream reads, without real networking. */
export const createEnvironment: EnvironmentFactory = (definition, random, limits) => {
  if (definition.kind === 'datagram')
    return { success: true, value: datagramEnvironment(definition, random) };
  const maximum = limits?.maxTraceBytes ?? EXECUTION_POLICY.maxTraceBytes;
  const stream = definition;
  const byId = new Map<string, ReadGroup>();
  const byTime = new Map<string, ReadGroup>();
  const latest: Record<Direction, number> = { AtoB: 0, BtoA: 0 };
  const closures = new Map(definition.connections.map((item) => [item.direction, item]));
  let nextRead = 0;
  let pendingBytes = 0;
  let disposed = false;
  function* initialEvents(): Iterable<EnvironmentEvent> {
    for (const connection of stream.connections)
      yield {
        kind: 'connection',
        timeMs: connection.timeMs,
        participant: connection.direction === 'AtoB' ? 'B' : 'A',
        state: connection.kind === 'close' ? 'closed' : 'failed',
      };
  }
  function* transmit(tx: Transmission): Iterable<EnvironmentEvent> {
    if (disposed) return;
    if (tx.payload.kind !== 'bytes') throw new Error('Stream requires byte payloads');
    const direction = directionOf(tx);
    const settings = definition.directions[direction];
    const arrival = safeTime(Math.max(latest[direction], safeTime(tx.timeMs + settings.delayMs)));
    const cutoff = closures.get(direction);
    if (cutoff && arrival >= cutoff.timeMs) {
      yield {
        kind: 'notice',
        timeMs: tx.timeMs,
        participant: tx.from,
        causeEventId: tx.causeEventId,
        detail: {
          operation: 'stream-cutoff',
          direction,
          transmission: tx.transmission,
          cutoffMs: cutoff.timeMs,
          state: cutoff.kind === 'close' ? 'closed' : 'failed',
        },
      };
      return;
    }
    latest[direction] = arrival;
    if (!tx.payload.bytes.length) return;
    if (pendingBytes + tx.payload.bytes.length > maximum) throw new EnvironmentLimit();
    const key = `${direction}:${arrival}`;
    let group = byTime.get(key);
    const first = !group;
    if (!group) {
      group = {
        id: `read-${++nextRead}`,
        key,
        tx: { from: tx.from, to: tx.to, causeEventId: tx.causeEventId },
        direction,
        timeMs: arrival,
        writes: [],
        total: 0,
      };
      byTime.set(key, group);
      byId.set(group.id, group);
    }
    group.writes.push({ bytes: tx.payload.bytes.slice(), cause: tx.causeEventId });
    group.total += tx.payload.bytes.length;
    pendingBytes += tx.payload.bytes.length;
    if (first) yield { kind: 'stream-read', timeMs: arrival, readId: group.id };
  }
  function* readStream(id: string): Iterable<DeliveryEvent> {
    const group = byId.get(id);
    if (!group) return;
    byId.delete(id);
    byTime.delete(group.key);
    const chunkBytes = stream.directions[group.direction].chunkBytes;
    let writeIndex = 0;
    let offset = 0;
    let remaining = group.total;
    while (remaining > 0 && !disposed) {
      const bytes = new Uint8Array(Math.min(chunkBytes, remaining));
      const sources = new Set<string>();
      let filled = 0;
      while (filled < bytes.length) {
        const write = group.writes[writeIndex];
        if (!write) throw new Error('Missing pending stream write');
        const size = Math.min(write.bytes.length - offset, bytes.length - filled);
        bytes.set(write.bytes.subarray(offset, offset + size), filled);
        sources.add(write.cause);
        filled += size;
        offset += size;
        if (offset === write.bytes.length) {
          group.writes[writeIndex] = { bytes: new Uint8Array(0), cause: write.cause };
          writeIndex++;
          offset = 0;
        }
      }
      remaining -= bytes.length;
      pendingBytes -= bytes.length;
      const sourceEventIds = [...sources];
      yield {
        kind: 'delivery',
        timeMs: group.timeMs,
        from: group.tx.from,
        to: group.tx.to,
        payload: { kind: 'bytes', bytes },
        causeEventId: sourceEventIds[0] ?? group.tx.causeEventId,
        sourceEventIds,
      };
    }
  }
  return {
    success: true,
    value: {
      initialEvents,
      transmit,
      readStream,
      dispose: () => {
        disposed = true;
        byId.clear();
        byTime.clear();
        pendingBytes = 0;
      },
    },
  };
};
