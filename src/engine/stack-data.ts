import type { JsonValue } from '../domain/execution-contract.ts';
import { deserializeBytes } from '../domain/stack-bytes.ts';
import type {
  BytesValue,
  PayloadRange,
  StackMessage,
  StackProtocol,
  StackService,
} from '../domain/stack-model.ts';
import { stackProtocolBody } from '../domain/stack-model.ts';
import type { StackPayloadStore } from '../domain/stack-payloads.ts';
import type { ByteOrigin } from '../domain/stack-runtime-model.ts';
import { stackValue } from './stack-codec.ts';

export type StoredPayload = {
  readonly value: JsonValue;
  readonly traced: JsonValue;
  readonly ranges: readonly PayloadRange[];
  readonly bytes: number;
};
export type ByteFragment = { readonly range: PayloadRange; readonly sourceEventId: string };
export type TracedValue = { readonly value: JsonValue; readonly ranges: readonly PayloadRange[] };

/** Intern canonical bytes within one run while keeping event causality independent of content identity. */
export class StackData {
  readonly store: StackPayloadStore;
  readonly #bytes = new Map<string, PayloadRange>();
  constructor(store: StackPayloadStore) {
    this.store = store;
  }
  checkpoint(): () => void {
    const before = new Map(this.#bytes);
    return () => {
      this.#bytes.clear();
      for (const [key, value] of before) this.#bytes.set(key, value);
    };
  }
  bytes(value: JsonValue): PayloadRange {
    const data = value as BytesValue;
    const key = `${data.byteLength}:${data.data}`;
    const existing = this.#bytes.get(key);
    if (existing && this.store.owns(existing)) return existing;
    const handle = stackValue(this.store.add(stackValue(deserializeBytes(value))));
    this.#bytes.set(key, handle);
    return handle;
  }
  message(protocol: StackProtocol, message: StackMessage, wire = false): TracedValue {
    const schema = stackProtocolBody(protocol).messages.find(
      (item) => item.id === message.messageId,
    );
    const ranges: PayloadRange[] = [];
    const values = Object.fromEntries(
      Object.entries(message.values).map(([id, value]) => {
        const field = schema?.fields.find((field) => (wire ? field.name : field.id) === id);
        if (field?.type !== 'bytes') return [id, value];
        const range = this.bytes(value);
        ranges.push(range);
        return [id, { kind: 'payload-range', ...range }];
      }),
    );
    return {
      value: { messageId: message.messageId, [wire ? 'fields' : 'values']: values },
      ranges,
    };
  }
  variables(protocol: StackProtocol, variables: Readonly<Record<string, JsonValue>>): TracedValue {
    const ranges: PayloadRange[] = [];
    const result = Object.fromEntries(
      Object.entries(variables).map(([id, value]) => {
        const definition = stackProtocolBody(protocol).variables.find(
          (variable) => variable.id === id,
        );
        if (definition?.type !== 'bytes') return [id, value];
        const range = this.bytes(value);
        ranges.push(range);
        return [id, { kind: 'payload-range', ...range }];
      }),
    );
    return { value: result, ranges };
  }
  payload(service: StackService, value: JsonValue): StoredPayload {
    if (service.payload === 'bytes') {
      const range = this.bytes(value);
      return { value, traced: { kind: 'bytes', range }, ranges: [range], bytes: range.length };
    }
    const packet = value as {
      readonly messageId: string;
      readonly fields: Readonly<Record<string, JsonValue>>;
    };
    const schema = service.payload.messages.find((message) => message.id === packet.messageId);
    const ranges: PayloadRange[] = [];
    const fields = Object.fromEntries(
      Object.entries(packet.fields).map(([name, value]) => {
        if (schema?.fields.find((field) => field.name === name)?.type !== 'bytes')
          return [name, value];
        const range = this.bytes(value);
        ranges.push(range);
        return [name, { kind: 'payload-range', ...range }];
      }),
    );
    return {
      value,
      traced: { kind: 'packet', packet: { messageId: packet.messageId, fields } },
      ranges,
      bytes: new TextEncoder().encode(JSON.stringify(value)).length,
    };
  }
  consume(fragments: ByteFragment[], count: number): ByteFragment[] {
    const used: ByteFragment[] = [];
    let remaining = count;
    while (remaining > 0) {
      const first = fragments.shift();
      if (!first) throw new Error('Codec consumed bytes outside its actual input');
      const length = Math.min(remaining, first.range.length);
      used.push({
        range: stackValue(this.store.slice(first.range, 0, length)),
        sourceEventId: first.sourceEventId,
      });
      if (length < first.range.length)
        fragments.unshift({
          range: stackValue(this.store.slice(first.range, length, first.range.length - length)),
          sourceEventId: first.sourceEventId,
        });
      remaining -= length;
    }
    return used;
  }
  collect(): void {
    this.store.collectUnreferenced();
    for (const [key, value] of this.#bytes) if (!this.store.owns(value)) this.#bytes.delete(key);
  }
  origins(values: readonly ByteOrigin[]): {
    readonly rows: readonly JsonValue[];
    readonly sources: readonly string[];
    readonly ranges: readonly PayloadRange[];
  } {
    const ranges = values.map((origin) =>
      stackValue(this.store.slice(origin.range, origin.sourceOffset, origin.length)),
    );
    return {
      rows: values.map((origin, index) => ({
        sourceEventId: origin.sourceEventId,
        valueOffset: origin.valueOffset,
        ...ranges[index],
      })),
      sources: [...new Set(values.map((origin) => origin.sourceEventId))],
      ranges,
    };
  }
}
