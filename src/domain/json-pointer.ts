/** Read own data through a JSON Pointer without interpreting user expressions. */
export function valueAt(root: unknown, path: string): unknown {
  let value = root;
  for (const part of path.split('/').slice(1)) {
    if (!value || typeof value !== 'object') return undefined;
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Escape an identifier when it becomes a JSON Pointer key. */
export function pointerToken(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}
