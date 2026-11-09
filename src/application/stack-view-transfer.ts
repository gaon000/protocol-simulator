import { freezeOwned, isOwnedImmutable } from '../domain/immutable-data.ts';
import type { RunArtifacts, StackTrace } from '../domain/stack-model.ts';
import type { StackView } from '../domain/stack-runtime-model.ts';

export type StackViewTransfer =
  | { readonly kind: 'full'; readonly serial: number; readonly view: StackView }
  | {
      readonly kind: 'append';
      readonly serial: number;
      readonly baseSerial: number;
      readonly view: Omit<StackView, 'snapshot' | 'events' | 'artifacts'>;
      readonly events: readonly StackTrace[];
      readonly payloads: RunArtifacts['payloads'];
    };

function prefix<T>(
  rows: readonly T[],
  base: readonly T[],
  equal: (left: T, right: T) => boolean = (left, right) => left === right,
): boolean {
  return (
    rows.length >= base.length &&
    base.every((row, index) => rows[index] !== undefined && equal(rows[index], row))
  );
}

/** Send only appended owned rows on one ordered worker channel; changed prefixes get a full view. */
export class StackViewPublisher {
  #serial = 0;
  #previous: StackView | undefined;

  /** Retain one exact immutable base, without inferring sameness from event or payload IDs. */
  capture(view: StackView): StackViewTransfer {
    const base = this.#previous;
    const baseSerial = this.#serial++;
    this.#previous = isOwnedImmutable(view) ? view : undefined;
    if (
      base &&
      isOwnedImmutable(view) &&
      base.runId === view.runId &&
      base.snapshot === view.snapshot &&
      prefix(view.events, base.events) &&
      prefix(
        view.artifacts.payloads,
        base.artifacts.payloads,
        // The store recreates wrappers but retains the exact immutable serialized byte object.
        (left, right) => left.payloadId === right.payloadId && left.bytes === right.bytes,
      )
    ) {
      const { snapshot: _snapshot, events, artifacts, ...header } = view;
      return {
        kind: 'append',
        serial: this.#serial,
        baseSerial,
        view: header,
        events: events.slice(base.events.length),
        payloads: artifacts.payloads.slice(base.artifacts.payloads.length),
      };
    }
    return { kind: 'full', serial: this.#serial, view };
  }
}

/** Rebuild exact readonly checkpoints, sharing prior rows while freezing only new transferred data. */
export class StackViewReceiver {
  #serial = 0;
  #previous: StackView | undefined;

  /** Reject missing, stale or foreign bases before publishing any partial observation. */
  receive(transfer: StackViewTransfer): StackView {
    if (!Number.isSafeInteger(transfer.serial) || transfer.serial <= this.#serial)
      throw new Error('오래된 스택 관찰 전송입니다. 마지막 관찰을 유지합니다.');
    let view: StackView;
    if (transfer.kind === 'full') view = freezeOwned(transfer.view);
    else {
      const base = this.#previous;
      if (!base || transfer.baseSerial !== this.#serial || transfer.view.runId !== base.runId)
        throw new Error('스택 관찰 기준본이 다릅니다. 마지막 관찰을 유지합니다.');
      view = freezeOwned({
        ...transfer.view,
        snapshot: base.snapshot,
        events: [...base.events, ...transfer.events],
        artifacts: {
          ...base.artifacts,
          payloads: [...base.artifacts.payloads, ...transfer.payloads],
        },
      });
    }
    this.#serial = transfer.serial;
    this.#previous = view;
    return view;
  }
}
