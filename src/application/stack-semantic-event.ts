import type { JsonValue } from '../domain/execution-contract.ts';
import { serializeBytes } from '../domain/stack-bytes.ts';
import { type PayloadRange, type StackTrace, stackProtocolBody } from '../domain/stack-model.ts';
import { stackObject, stackProtocolAt, stackRangeBytes } from '../domain/stack-record.ts';
import type { StackView } from '../domain/stack-runtime-model.ts';

export class StackSemanticLimit extends Error {}
export type StackSemanticBudget = { bytes: number; events: number };

/** Normalize only schema-owned identities/ranges; arbitrary user JSON keys remain real comparable content. */
export function semanticStackEvent(
  view: StackView,
  event: StackTrace,
  indexes: ReadonlyMap<string, number>,
  budget: StackSemanticBudget,
): JsonValue {
  if (--budget.events < 0) throw new StackSemanticLimit('이벤트 비교 한도입니다.');
  const protocol = stackProtocolAt(view.snapshot, event.endpoint);
  const body = stackProtocolBody(protocol);
  let sourceWork = 4096;
  const sourceWindows = new Map<string, Map<string, PayloadRange[]>>();
  function bytes(value: JsonValue): JsonValue {
    const range = stackObject(value) as unknown as PayloadRange;
    budget.bytes -= range.length;
    if (budget.bytes < 0) throw new StackSemanticLimit('실제 byte 비교 한도입니다.');
    return serializeBytes(stackRangeBytes(view.artifacts, range, event.payloads));
  }
  function origins(value: JsonValue): JsonValue {
    if (!Array.isArray(value)) return value;
    return value.map((row) => {
      const item = stackObject(row);
      const {
        payloadId: _payloadId,
        offset: _offset,
        length: _length,
        sourceEventId,
        ...rest
      } = item;
      const sourceIndex =
        typeof sourceEventId === 'string' ? indexes.get(sourceEventId) : undefined;
      const sourceEvent = sourceIndex === undefined ? undefined : view.events[sourceIndex];
      if (!sourceEvent) throw new StackSemanticLimit('실제 source를 대응할 수 없습니다.');
      let windows = sourceWindows.get(sourceEvent.eventId);
      if (!windows) {
        windows = new Map();
        const unique = new Set<string>();
        for (const range of sourceEvent.payloads) {
          if (--sourceWork < 0) throw new StackSemanticLimit('source 범위 비교 한도입니다.');
          const key = `${range.payloadId}/${range.offset}/${range.length}`;
          if (unique.has(key)) continue;
          unique.add(key);
          const list = windows.get(range.payloadId) ?? [];
          list.push(range);
          windows.set(range.payloadId, list);
        }
        sourceWindows.set(sourceEvent.eventId, windows);
      }
      const positions: { offset: number; length: number }[] = [];
      for (const range of windows.get(String(item.payloadId)) ?? []) {
        if (--sourceWork < 0) throw new StackSemanticLimit('source 범위 비교 한도입니다.');
        if (
          Number(item.offset) >= range.offset &&
          Number(item.offset) + Number(item.length) <= range.offset + range.length
        )
          positions.push({ offset: Number(item.offset) - range.offset, length: range.length });
      }
      if (!positions.length)
        throw new StackSemanticLimit('source 안의 실제 byte 위치를 대응할 수 없습니다.');
      positions.sort((a, b) => a.offset - b.offset || a.length - b.length);
      return {
        ...rest,
        bytes: bytes(row),
        source: sourceIndex ?? null,
        sourcePositions: positions,
      };
    });
  }
  const data = structuredClone(stackObject(event.data));
  if (data.message) {
    const message = stackObject(data.message);
    const values = { ...stackObject(message.values) };
    for (const field of body.messages.find((m) => m.id === message.messageId)?.fields ?? [])
      if (field.type === 'bytes' && values[field.id] !== undefined)
        values[field.id] = bytes(values[field.id] as JsonValue);
    data.message = { ...message, values };
  }
  for (const key of ['before', 'after'])
    if (data[key]) {
      const state = stackObject(data[key]);
      const variables = { ...stackObject(state.variables) };
      for (const variable of body.variables)
        if (variable.type === 'bytes' && variables[variable.id] !== undefined)
          variables[variable.id] = bytes(variables[variable.id] as JsonValue);
      data[key] = { ...state, variables };
    }
  for (const key of ['wire', 'payload'])
    if (data[key]) {
      const payload = stackObject(data[key]);
      if (payload.kind === 'bytes')
        data[key] = { kind: 'bytes', bytes: bytes(payload.range as JsonValue) };
      if (payload.kind === 'packet') {
        const packet = stackObject(payload.packet);
        const fields = { ...stackObject(packet.fields) };
        for (const [id, value] of Object.entries(fields))
          if (stackObject(value).kind === 'payload-range') fields[id] = bytes(value);
        data[key] = { ...payload, packet: { ...packet, fields } };
      }
    }
  for (const key of ['byteSources', 'fieldSources'])
    if (data[key])
      data[key] = Object.fromEntries(
        Object.entries(stackObject(data[key])).map(([id, rows]) => [id, origins(rows)]),
      );
  if (data.sourceRanges) data.sourceRanges = origins(data.sourceRanges);
  return {
    endpoint: event.endpoint,
    kind: event.kind,
    timeMs: event.timeMs,
    sequence: event.sequence,
    portId: event.portId ?? null,
    linkId: event.linkId ?? null,
    sources: event.sourceEventIds.map((id) => indexes.get(id) ?? null),
    payloads: event.payloads.map((range) => bytes(range as unknown as JsonValue)),
    data,
  };
}
