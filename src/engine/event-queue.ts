import { compareEventKeys, type EventOrderKey } from '../domain/execution-contract.ts';

/** Stable binary min-heap for the engine's virtual-time events. */
export class EventQueue<Value extends EventOrderKey> {
  private readonly items: Value[] = [];

  /** Number of events currently queued. */
  get size(): number {
    return this.items.length;
  }

  /** Inspect the next event without removing it. */
  peek(): Value | undefined {
    return this.items[0];
  }

  /** Insert an event according to virtual time, priority and creation order. */
  push(value: Value): void {
    this.items.push(value);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const existing = this.items[parent];
      if (!existing || compareEventKeys(existing, value) <= 0) break;
      this.items[index] = existing;
      index = parent;
    }
    this.items[index] = value;
  }

  /** Remove the next event, or return undefined for an empty queue. */
  take(): Value | undefined {
    const first = this.items[0];
    const last = this.items.pop();
    if (!this.items.length || !last) return first;
    let index = 0;
    while (index * 2 + 1 < this.items.length) {
      let child = index * 2 + 1;
      const right = this.items[child + 1];
      const left = this.items[child];
      if (right && left && compareEventKeys(right, left) < 0) child++;
      const next = this.items[child];
      if (!next || compareEventKeys(last, next) <= 0) break;
      this.items[index] = next;
      index = child;
    }
    this.items[index] = last;
    return first;
  }

  /** Release queued payloads after completion, cancellation or reset. */
  clear(): void {
    this.items.length = 0;
  }
}
