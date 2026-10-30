const owned = new WeakSet<object>();

/** Deep-freeze trusted owned data once, recording the entire boundary for safe immutable sharing. */
export function freezeOwned<T>(value: T): T {
  if (value && typeof value === 'object' && !owned.has(value)) {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
    owned.add(value);
  }
  return value;
}

/** Recognize this module's deep-frozen data without trusting an arbitrary shallow Object.freeze. */
export function isOwnedImmutable(value: unknown): boolean {
  return !!value && typeof value === 'object' && owned.has(value);
}
