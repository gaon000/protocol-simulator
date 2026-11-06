import { freezeOwned } from './immutable-data.ts';
import { parseJsonData, Reader } from './model-validation.ts';
import type { ValidationResult } from './protocol-model.ts';
import { deserializeBytes, OwnedBytes, parseBytesValue } from './stack-bytes.ts';
import {
  defaultStackLimits,
  type PayloadRange,
  type RunArtifacts,
  STACK_POLICY,
  type StackLimits,
  type StackTrace,
} from './stack-model.ts';
import { parseStackLimits } from './stack-validation.ts';

export type PayloadOwner = { readonly id: string; readonly kind: 'codec' | 'provider' | 'port' };
export type PayloadUsage = {
  readonly uniqueBytes: number;
  readonly liveBytes: number;
  readonly traceEvents: number;
  readonly artifactBytes: number;
};

const jsonSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
function failure<T>(path: string, code: string, message: string): ValidationResult<T> {
  return { success: false, diagnostics: [{ path, code, message }] };
}
function rangeShape(value: unknown, path: string, r: Reader): PayloadRange | undefined {
  const range = r.object(value, path, ['payloadId', 'offset', 'length']);
  if (!range) return;
  r.text(range.payloadId, `${path}/payloadId`, true);
  r.number(range.offset, `${path}/offset`);
  r.number(range.length, `${path}/length`);
  return range as PayloadRange;
}

/** Validate a record-local artifact pool and every supplied byte range, including serialized size. */
export function parseRunArtifacts(
  value: unknown,
  references: unknown = [],
  limits: StackLimits = defaultStackLimits(),
): ValidationResult<RunArtifacts> {
  const parsedLimits = parseStackLimits(limits);
  if (!parsedLimits.success) return parsedLimits;
  const json = parseJsonData(value, { maxDepth: 64, maxNodes: limits.maxArtifactBytes });
  if (!json.success) return json;
  const refsJson = parseJsonData(references, { maxDepth: 64, maxNodes: limits.maxArtifactBytes });
  if (!refsJson.success) return refsJson;
  if (jsonSize(references) > limits.maxArtifactBytes)
    return failure(
      '/references',
      'artifact-limit',
      'Serialized references exceed the record budget',
    );
  const r = new Reader();
  if (jsonSize(value) > limits.maxArtifactBytes)
    return failure('/', 'artifact-limit', 'Serialized artifacts exceed the trace/payload limit');
  const node = r.object(value, '', ['schemaVersion', 'mode', 'payloads']);
  if (!node) return { success: false, diagnostics: r.diagnostics };
  r.choice(node.schemaVersion, '/schemaVersion', [2]);
  r.choice(node.mode, '/mode', ['stack-artifacts']);
  const lengths = new Map<string, number>();
  let uniqueBytes = 0;
  r.array(node.payloads, '/payloads', (item, path) => {
    const payload = r.object(item, path, ['payloadId', 'bytes']);
    if (!payload) return;
    r.text(payload.payloadId, `${path}/payloadId`, true);
    const bytes = parseBytesValue(payload.bytes, limits.maxPayloadBytes);
    if (!bytes.success)
      for (const d of bytes.diagnostics)
        r.issue(`${path}/bytes${d.path === '/' ? '' : d.path}`, d.code, d.message);
    if (typeof payload.payloadId === 'string' && bytes.success) {
      if (lengths.has(payload.payloadId))
        r.issue(
          `${path}/payloadId`,
          'duplicate-payload',
          'Payload IDs must be unique inside this record',
        );
      lengths.set(payload.payloadId, bytes.value.byteLength);
      uniqueBytes += bytes.value.byteLength;
    }
  });
  if (uniqueBytes > limits.maxPayloadBytes)
    r.issue('/payloads', 'payload-limit', 'Unique payload pool exceeds its global limit');
  if (jsonSize(value) > limits.maxArtifactBytes)
    r.issue('/', 'artifact-limit', 'Serialized artifacts exceed the trace/payload limit');
  r.array(references, '/references', (item, path) => {
    const range = rangeShape(item, path, r);
    if (!range) return;
    const length = lengths.get(range.payloadId);
    if (length === undefined)
      r.issue(`${path}/payloadId`, 'payload-reference', 'Payload is absent from this record');
    else if (range.offset > length - range.length)
      r.issue(path, 'payload-range', 'Range exceeds its record-local payload');
  });
  return r.diagnostics.length
    ? { success: false, diagnostics: r.diagnostics }
    : r.result(freezeOwned(structuredClone(value as RunArtifacts)));
}

/** Resolve only against the supplied record, returning a copy rather than exposing artifact storage. */
export function readArtifactRange(
  artifacts: unknown,
  range: PayloadRange,
): ValidationResult<Uint8Array> {
  const parsed = parseRunArtifacts(artifacts, [range]);
  if (!parsed.success) return parsed;
  const entry = parsed.value.payloads.find((entry) => entry.payloadId === range.payloadId);
  if (!entry) return failure('/payloadId', 'payload-reference', 'Payload is absent');
  const bytes = deserializeBytes(entry.bytes, STACK_POLICY.maxPayloadBytes);
  return bytes.success
    ? { success: true, value: bytes.value.slice(range.offset, range.offset + range.length) }
    : bytes;
}

/** Read a bounded v2 trace and its record-local payload references; this does not replay transitions. */
export function parseStackTrace(
  value: unknown,
  artifacts: unknown,
  limits: StackLimits = defaultStackLimits(),
): ValidationResult<readonly StackTrace[]> {
  return traceBatch(value, artifacts, limits);
}

function traceBatch(
  value: unknown,
  artifacts: unknown,
  limits: StackLimits,
  prefix?: { readonly ids: ReadonlySet<string>; readonly last: StackTrace | undefined },
): ValidationResult<readonly StackTrace[]> {
  const parsedLimits = parseStackLimits(limits);
  if (!parsedLimits.success) return parsedLimits;
  // A valid dense 10k trace may exceed 500k nodes; serialized bytes remain the hard global bound.
  const json = parseJsonData(value, { maxDepth: 64, maxNodes: limits.maxArtifactBytes });
  if (!json.success) return json;
  const r = new Reader();
  if (!Array.isArray(value)) return failure('/', 'array', 'Expected trace events');
  if (value.length > limits.maxTraceEvents)
    return failure('/', 'trace-limit', 'Global trace event limit exceeded');
  const ids = new Set<string>();
  const ranges: PayloadRange[] = [];
  let runId: string | undefined = prefix?.last?.runId;
  let previousSequence = prefix?.last?.sequence ?? -1;
  let previousTime = prefix?.last?.timeMs ?? 0;
  r.array(value, '', (item, path) => {
    const event = r.object(
      item,
      path,
      [
        'schemaVersion',
        'mode',
        'runId',
        'eventId',
        'timeMs',
        'sequence',
        'endpoint',
        'portId',
        'linkId',
        'kind',
        'sourceEventIds',
        'payloads',
        'data',
      ],
      ['data'],
    );
    if (!event) return;
    r.choice(event.schemaVersion, `${path}/schemaVersion`, [2]);
    r.choice(event.mode, `${path}/mode`, ['stack']);
    r.text(event.runId, `${path}/runId`, true);
    r.text(event.eventId, `${path}/eventId`, true);
    r.number(event.timeMs, `${path}/timeMs`);
    r.number(event.sequence, `${path}/sequence`);
    r.choice(event.kind, `${path}/kind`, [
      'input',
      'send',
      'receive',
      'parsed',
      'deliver',
      'timer',
      'transition',
      'diagnostic',
      'environment',
      'connection',
      'service-request',
      'service-accepted',
      'service-received',
      'service-indication',
    ]);
    if (Object.hasOwn(event, 'portId')) r.text(event.portId, `${path}/portId`, true);
    if (Object.hasOwn(event, 'linkId')) r.text(event.linkId, `${path}/linkId`, true);
    const endpoint = r.object(event.endpoint, `${path}/endpoint`, ['participant', 'instanceId']);
    if (endpoint) {
      r.choice(endpoint.participant, `${path}/endpoint/participant`, ['A', 'B']);
      r.text(endpoint.instanceId, `${path}/endpoint/instanceId`, true);
    }
    const sources = new Set<string>();
    r.array(event.sourceEventIds, `${path}/sourceEventIds`, (source, location) => {
      r.text(source, location, true);
      if (typeof source === 'string') {
        if (!ids.has(source) && !prefix?.ids.has(source))
          r.issue(location, 'source-reference', 'Source must be an earlier event in this record');
        if (sources.has(source)) r.issue(location, 'duplicate-source', 'Repeated source event');
        sources.add(source);
      }
    });
    r.array(event.payloads, `${path}/payloads`, (range, location) => {
      const parsed = rangeShape(range, location, r);
      if (parsed) ranges.push(parsed);
    });
    if (typeof event.eventId === 'string') {
      if (ids.has(event.eventId) || prefix?.ids.has(event.eventId))
        r.issue(`${path}/eventId`, 'duplicate-id', 'Duplicate trace event ID');
      ids.add(event.eventId);
    }
    if (typeof event.runId === 'string') {
      if (runId !== undefined && runId !== event.runId)
        r.issue(`${path}/runId`, 'trace-contract', 'Trace contains more than one run');
      runId = event.runId;
    }
    if (typeof event.sequence === 'number') {
      if (event.sequence <= previousSequence)
        r.issue(`${path}/sequence`, 'trace-order', 'Trace sequences must strictly increase');
      previousSequence = event.sequence;
    }
    if (typeof event.timeMs === 'number') {
      if (event.timeMs < previousTime)
        r.issue(`${path}/timeMs`, 'trace-order', 'Trace virtual time must not decrease');
      previousTime = event.timeMs;
    }
  });
  const parsedArtifacts = parseRunArtifacts(artifacts, ranges, limits);
  if (!parsedArtifacts.success)
    for (const d of parsedArtifacts.diagnostics)
      r.issue(`/artifacts${d.path === '/' ? '' : d.path}`, d.code, d.message);
  else if (jsonSize({ trace: value, artifacts }) > limits.maxArtifactBytes)
    r.issue('/', 'artifact-limit', 'Trace plus base64 artifacts exceed the combined global limit');
  return r.diagnostics.length
    ? { success: false, diagnostics: r.diagnostics }
    : r.result(freezeOwned(structuredClone(value as StackTrace[])));
}

/** Own one run's blocks/handles and finite live budgets; trace capture survives live cleanup. */
export class StackPayloadStore {
  readonly #limits: StackLimits;
  readonly #blocks = new Map<string, OwnedBytes>();
  readonly #handles = new WeakSet<object>();
  readonly #owners = new Map<
    string,
    {
      readonly kind: PayloadOwner['kind'];
      readonly ranges: readonly PayloadRange[];
      readonly bytes: number;
    }
  >();
  readonly #committed = new Set<string>();
  readonly #trace: StackTrace[] = [];
  readonly #eventIds = new Set<string>();
  readonly #runId: string;
  readonly #serialized = new Map<string, import('./stack-model.ts').BytesValue>();
  #reserving = false;
  #reservedHandles: PayloadRange[] = [];
  #nextId = 1;
  #uniqueBytes = 0;
  #liveBytes = 0;
  #artifactBytes = jsonSize({
    trace: [],
    artifacts: { schemaVersion: 2, mode: 'stack-artifacts', payloads: [] },
  });

  constructor(runId: string, limits: StackLimits = defaultStackLimits()) {
    const parsed = parseStackLimits(limits);
    if (!parsed.success || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(runId))
      throw new RangeError('Invalid run ID or limits');
    this.#limits = { ...limits };
    this.#runId = runId;
  }
  #handle(payloadId: string, offset: number, length: number): PayloadRange {
    const handle = Object.freeze({ payloadId, offset, length });
    this.#handles.add(handle);
    if (this.#reserving) this.#reservedHandles.push(handle);
    return handle;
  }
  #owns(range: PayloadRange): boolean {
    if (!range || typeof range !== 'object') return false;
    const block = this.#blocks.get(range.payloadId);
    return (
      this.#handles.has(range) &&
      !!block &&
      Number.isSafeInteger(range.offset) &&
      Number.isSafeInteger(range.length) &&
      range.offset >= 0 &&
      range.length >= 0 &&
      range.offset <= block.byteLength - range.length
    );
  }
  #artifacts(ids: ReadonlySet<string>): RunArtifacts {
    return {
      schemaVersion: 2,
      mode: 'stack-artifacts',
      payloads: [...ids].map((payloadId) => {
        const block = this.#blocks.get(payloadId);
        if (!block) throw new Error('Committed payload ownership was lost');
        let bytes = this.#serialized.get(payloadId);
        if (!bytes) {
          bytes = block.toJSON();
          this.#serialized.set(payloadId, bytes);
        }
        return { payloadId, bytes };
      }),
    };
  }
  get usage(): PayloadUsage {
    return Object.freeze({
      uniqueBytes: this.#uniqueBytes,
      liveBytes: this.#liveBytes,
      traceEvents: this.#trace.length,
      artifactBytes: this.#artifactBytes,
    });
  }
  /** Read logical live ownership without exposing mutable payloads or confusing it with archived artifacts. */
  ownerBytes(ownerId: string): number {
    return this.#owners.get(ownerId)?.bytes ?? 0;
  }
  add(bytes: Uint8Array): ValidationResult<PayloadRange> {
    if (!(bytes instanceof Uint8Array) || bytes.length > this.#limits.maxMessageBytes)
      return failure('/', 'message-limit', 'Payload exceeds the message limit');
    if (this.#uniqueBytes + bytes.length > this.#limits.maxPayloadBytes)
      return failure('/', 'payload-limit', 'Global unique payload limit exceeded');
    if (this.#blocks.size >= this.#limits.maxPendingOperations + this.#limits.maxTraceEvents)
      return failure('/', 'payload-limit', 'Payload block index budget exceeded');
    const payloadId = `payload_${this.#nextId++}`;
    this.#blocks.set(payloadId, new OwnedBytes(bytes));
    this.#uniqueBytes += bytes.length;
    return { success: true, value: this.#handle(payloadId, 0, bytes.length) };
  }
  slice(range: PayloadRange, offset: number, length: number): ValidationResult<PayloadRange> {
    if (!this.#owns(range))
      return failure('/', 'payload-owner', 'Handle belongs to another store or has been released');
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset > range.length - length
    )
      return failure('/', 'payload-range', 'Slice exceeds its handle');
    return { success: true, value: this.#handle(range.payloadId, range.offset + offset, length) };
  }
  read(range: PayloadRange): ValidationResult<Uint8Array> {
    if (!this.#owns(range))
      return failure('/', 'payload-owner', 'Handle belongs to another store or has been released');
    const block = this.#blocks.get(range.payloadId);
    if (!block) return failure('/', 'payload-reference', 'Payload is absent');
    return { success: true, value: block.slice(range.offset, range.length).copy() };
  }
  /** Check live handle ownership without copying its bytes. */
  owns(range: PayloadRange): boolean {
    return this.#owns(range);
  }
  setOwner(
    owner: PayloadOwner,
    ranges: readonly PayloadRange[],
    logicalBytes = ranges.reduce((sum, range) => sum + range.length, 0),
  ): ValidationResult<PayloadUsage> {
    if (
      !/^[A-Za-z_][A-Za-z0-9_/-]*$/.test(owner.id) ||
      !['codec', 'provider', 'port'].includes(owner.kind)
    )
      return failure('/owner', 'payload-owner', 'Invalid owner identity');
    if (ranges.some((range) => !this.#owns(range)))
      return failure(
        '/ranges',
        'payload-owner',
        'A handle belongs to another store or has been released',
      );
    const previous = this.#owners.get(owner.id);
    if (previous && previous.kind !== owner.kind)
      return failure('/owner', 'payload-owner', 'Owner kind cannot change');
    const length = logicalBytes;
    if (
      !Number.isSafeInteger(length) ||
      length < ranges.reduce((sum, range) => sum + range.length, 0)
    )
      return failure('/ranges', 'live-buffer-limit', 'Logical bytes must cover all owned ranges');
    const maximum =
      owner.kind === 'codec'
        ? this.#limits.maxCodecBufferBytes
        : owner.kind === 'port'
          ? this.#limits.maxPortBytes
          : this.#limits.maxLiveBytes;
    const oldLength = previous?.bytes ?? 0;
    if (length > maximum || this.#liveBytes - oldLength + length > this.#limits.maxLiveBytes)
      return failure(
        '/ranges',
        'live-buffer-limit',
        'Per-owner or global logical buffer budget exceeded',
      );
    this.#owners.set(owner.id, { kind: owner.kind, ranges: [...ranges], bytes: length });
    this.#liveBytes += length - oldLength;
    return { success: true, value: this.usage };
  }
  releaseOwner(ownerId: string): void {
    const owner = this.#owners.get(ownerId);
    if (owner) this.#liveBytes -= owner.bytes;
    this.#owners.delete(ownerId);
  }
  collectUnreferenced(): void {
    const keep = new Set(this.#committed);
    for (const owner of this.#owners.values())
      for (const range of owner.ranges) keep.add(range.payloadId);
    for (const [id, block] of this.#blocks)
      if (!keep.has(id)) {
        this.#uniqueBytes -= block.byteLength;
        this.#blocks.delete(id);
        this.#serialized.delete(id);
      }
  }
  clearLive(): void {
    this.#owners.clear();
    this.#liveBytes = 0;
    this.collectUnreferenced();
  }

  /** Stage private blocks/owners until trace reservation succeeds; rollback cannot erase a commit. */
  beginReservation(): { readonly rollback: () => void; readonly commit: () => void } {
    if (this.#reserving) throw new Error('Nested payload reservation');
    this.#reserving = true;
    this.#reservedHandles = [];
    const blocks = new Map(this.#blocks);
    const owners = new Map(this.#owners);
    const serialized = new Map(this.#serialized);
    const unique = this.#uniqueBytes;
    const live = this.#liveBytes;
    const next = this.#nextId;
    const count = this.#trace.length;
    let closed = false;
    return {
      rollback: () => {
        if (closed) return;
        if (count !== this.#trace.length) throw new Error('Cannot roll back committed trace');
        this.#blocks.clear();
        for (const [key, value] of blocks) this.#blocks.set(key, value);
        this.#owners.clear();
        for (const [key, value] of owners) this.#owners.set(key, value);
        this.#serialized.clear();
        for (const [key, value] of serialized) this.#serialized.set(key, value);
        this.#uniqueBytes = unique;
        this.#liveBytes = live;
        this.#nextId = next;
        for (const handle of this.#reservedHandles) this.#handles.delete(handle);
        this.#reservedHandles = [];
        this.#reserving = false;
        closed = true;
      },
      commit: () => {
        if (closed) return;
        this.#reserving = false;
        this.#reservedHandles = [];
        closed = true;
      },
    };
  }

  /** Validate/reserve the entire trace batch before committing any event or retained payload. */
  appendTrace(events: readonly StackTrace[]): ValidationResult<PayloadUsage> {
    const json = parseJsonData(events, { maxDepth: 64, maxNodes: 500_000 });
    if (!json.success) return json;
    if (events.length + this.#trace.length > this.#limits.maxTraceEvents)
      return failure('/', 'trace-limit', 'Global trace event limit exceeded');
    const ids = new Set<string>();
    const eventIds = new Set<string>();
    for (const [index, event] of events.entries()) {
      if (
        !event ||
        typeof event !== 'object' ||
        event.schemaVersion !== 2 ||
        event.mode !== 'stack' ||
        event.runId !== this.#runId ||
        !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(event.eventId) ||
        eventIds.has(event.eventId) ||
        this.#eventIds.has(event.eventId)
      )
        return failure(
          `/${index}`,
          'trace-contract',
          'Trace identity/version differs from this run',
        );
      if (!Array.isArray(event.payloads))
        return failure(`/${index}/payloads`, 'trace-contract', 'Expected payload ranges');
      for (const range of event.payloads) {
        if (!this.#owns(range))
          return failure(
            `/${index}/payloads`,
            'payload-owner',
            'Trace range is not an owned handle from this run',
          );
        ids.add(range.payloadId);
      }
      eventIds.add(event.eventId);
    }
    const validated = traceBatch(events, this.#artifacts(ids), this.#limits, {
      ids: this.#eventIds,
      last: this.#trace.at(-1),
    });
    if (!validated.success) return validated;
    const fresh = new Set([...ids].filter((id) => !this.#committed.has(id)));
    const entries = this.#artifacts(fresh).payloads;
    const artifactBytes =
      this.#artifactBytes +
      events.reduce((sum, event) => sum + jsonSize(event), 0) +
      Math.max(0, events.length - (this.#trace.length ? 0 : 1)) +
      entries.reduce((sum, entry) => sum + jsonSize(entry), 0) +
      Math.max(0, entries.length - (this.#committed.size ? 0 : 1));
    if (artifactBytes > this.#limits.maxArtifactBytes)
      return failure('/', 'artifact-limit', 'Trace plus payload artifacts exceed the global limit');
    for (const event of events) {
      this.#trace.push(freezeOwned(structuredClone(event)));
      this.#eventIds.add(event.eventId);
    }
    for (const id of ids) this.#committed.add(id);
    this.#artifactBytes = artifactBytes;
    return { success: true, value: this.usage };
  }
  capture(): { readonly trace: readonly StackTrace[]; readonly artifacts: RunArtifacts } {
    return freezeOwned({ trace: [...this.#trace], artifacts: this.#artifacts(this.#committed) });
  }
}
