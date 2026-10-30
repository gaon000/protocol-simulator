import type {
  EnvironmentFactory,
  EnvironmentEvent,
  Transmission,
} from '../engine/environment-port.ts';

/** Supply a loss-free environment; explicitly reject impairments reserved for P4. */
export const createIdealEnvironment: EnvironmentFactory = (definition) => {
  if (
    (definition.kind === 'stream' && definition.connections.length) ||
    (definition.kind === 'datagram' &&
      (definition.targetedDrops.length ||
        Object.values(definition.directions).some(
          (settings) => settings.lossRate || settings.duplicateRate || settings.jitterMs,
        )))
  ) {
    return {
      success: false,
      diagnostics: [
        {
          path: '/environment',
          code: 'environment-not-supported',
          message: 'P2 ideal environment does not support faults; use a compatible adapter',
        },
      ],
    };
  }
  function* transmit(transmission: Transmission): Iterable<EnvironmentEvent> {
    const direction = transmission.from === 'A' ? 'AtoB' : 'BtoA';
    const settings = definition.directions[direction];
    const timeMs = transmission.timeMs + settings.delayMs;
    if (!Number.isSafeInteger(timeMs))
      throw new RangeError('Delivery time exceeds safe integer range');
    if (definition.kind === 'stream' && transmission.payload.kind === 'bytes') {
      const chunkBytes = definition.directions[direction].chunkBytes;
      for (let offset = 0; offset < transmission.payload.bytes.length; offset += chunkBytes)
        yield {
          kind: 'delivery',
          timeMs,
          from: transmission.from,
          to: transmission.to,
          payload: {
            kind: 'bytes',
            bytes: transmission.payload.bytes.slice(offset, offset + chunkBytes),
          },
          causeEventId: transmission.causeEventId,
        };
    } else
      yield {
        kind: 'delivery',
        timeMs,
        from: transmission.from,
        to: transmission.to,
        payload: transmission.payload,
        causeEventId: transmission.causeEventId,
      };
  }
  return { success: true, value: { initialEvents: () => [], transmit } };
};
