import { freezeOwned } from './immutable-data.ts';
import { parseJsonData, Reader } from './model-validation.ts';
import type { ValidationResult } from './protocol-model.ts';
import { type BytesValue, STACK_POLICY } from './stack-model.ts';

function sizeLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > STACK_POLICY.maxPayloadBytes)
    throw new RangeError('Invalid byte limit');
}

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}

/** Copy bytes into the canonical JSON representation; the mutable source is never retained. */
export function serializeBytes(
  bytes: Uint8Array,
  maxBytes: number = STACK_POLICY.maxMessageBytes,
): BytesValue {
  sizeLimit(maxBytes);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes)
    throw new RangeError('Byte value exceeds its limit');
  return freezeOwned({
    kind: 'bytes',
    encoding: 'base64',
    byteLength: bytes.length,
    data: encode(bytes),
  });
}

/** Read tagged bytes, rejecting unknown fields, padding variants, noncanonical bits and bad lengths. */
export function parseBytesValue(
  value: unknown,
  maxBytes: number = STACK_POLICY.maxMessageBytes,
): ValidationResult<BytesValue> {
  sizeLimit(maxBytes);
  const json = parseJsonData(value);
  if (!json.success) return json;
  const r = new Reader();
  const node = r.object(value, '', ['kind', 'encoding', 'byteLength', 'data']);
  if (!node) return { success: false, diagnostics: r.diagnostics };
  r.choice(node.kind, '/kind', ['bytes']);
  r.choice(node.encoding, '/encoding', ['base64']);
  r.number(node.byteLength, '/byteLength', 0, maxBytes);
  if (typeof node.data !== 'string') r.issue('/data', 'base64', 'Expected canonical base64');
  else if (node.data.length > 4 * Math.ceil(maxBytes / 3))
    r.issue('/data', 'bytes-limit', 'Encoded bytes exceed the limit');
  else {
    try {
      const decoded = atob(node.data);
      if (btoa(decoded) !== node.data)
        r.issue('/data', 'base64', 'Expected canonical padded base64');
      if (decoded.length !== node.byteLength)
        r.issue('/byteLength', 'bytes-length', 'Decoded length differs from byteLength');
    } catch {
      r.issue('/data', 'base64', 'Expected canonical padded base64');
    }
  }
  return r.diagnostics.length
    ? { success: false, diagnostics: r.diagnostics }
    : r.result(freezeOwned({ ...(value as BytesValue) }));
}

/** Decode validated JSON bytes into a fresh mutable copy, never into shared storage. */
export function deserializeBytes(
  value: unknown,
  maxBytes: number = STACK_POLICY.maxMessageBytes,
): ValidationResult<Uint8Array> {
  const parsed = parseBytesValue(value, maxBytes);
  if (!parsed.success) return parsed;
  const binary = atob(parsed.value.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return { success: true, value: bytes };
}

/** Immutable byte owner. Every outward byte view is a copy; freezing a typed array is unnecessary. */
export class OwnedBytes {
  readonly #bytes: Uint8Array;
  constructor(bytes: Uint8Array, maxBytes: number = STACK_POLICY.maxMessageBytes) {
    sizeLimit(maxBytes);
    if (!(bytes instanceof Uint8Array) || bytes.length > maxBytes)
      throw new RangeError('Byte value exceeds its limit');
    this.#bytes = new Uint8Array(bytes);
    Object.freeze(this);
  }
  get byteLength(): number {
    return this.#bytes.length;
  }
  copy(): Uint8Array {
    return this.#bytes.slice();
  }
  slice(offset: number, length: number): OwnedBytes {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset > this.byteLength - length
    )
      throw new RangeError('Byte range is outside the payload');
    return new OwnedBytes(
      this.#bytes.subarray(offset, offset + length),
      STACK_POLICY.maxPayloadBytes,
    );
  }
  toJSON(): BytesValue {
    return serializeBytes(this.#bytes, STACK_POLICY.maxPayloadBytes);
  }
}
