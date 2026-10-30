import type { JsonValue } from '../domain/execution-contract.ts';

/** Bound inspection work and DOM text while preserving the original data for export. */
export function previewJson(value: JsonValue): {
  readonly text: string;
  readonly truncated: boolean;
} {
  let remainingNodes = 256;
  let remainingText = 4096;
  let truncated = false;
  function visit(node: JsonValue, depth: number): JsonValue {
    if (--remainingNodes < 0 || depth > 8) {
      truncated = true;
      return '…';
    }
    if (typeof node === 'string') {
      const size = Math.max(0, Math.min(2048, remainingText));
      remainingText -= Math.min(node.length, size);
      if (node.length > size) truncated = true;
      return node.length > size ? `${node.slice(0, size)}…` : node;
    }
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) {
      if (node.length > 32) truncated = true;
      return node.slice(0, 32).map((item) => visit(item, depth + 1));
    }
    const keys = Object.keys(node);
    if (keys.length > 32) truncated = true;
    return Object.fromEntries(
      keys.slice(0, 32).map((key) => {
        if (key.length > 64) truncated = true;
        return [
          key.slice(0, 64),
          visit((node as Record<string, JsonValue>)[key] ?? null, depth + 1),
        ];
      }),
    );
  }
  const text = JSON.stringify(visit(value, 0), null, 2);
  return { text: text.slice(0, 16_384), truncated: truncated || text.length > 16_384 };
}
