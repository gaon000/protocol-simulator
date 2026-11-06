import type { JsonValue } from '../domain/execution-contract.ts';
import { valueAt } from '../domain/json-pointer.ts';
import type { StackDraft } from '../domain/workspace-v2-model.ts';
import { editStackExperiment } from './edit-stack.ts';

export type StackListEdit =
  | { readonly kind: 'add'; readonly value: JsonValue }
  | { readonly kind: 'move'; readonly from: number; readonly to: number }
  | { readonly kind: 'duplicate'; readonly index: number }
  | { readonly kind: 'remove'; readonly index: number };
/** Find pending text at or above a form boundary, leaving descendant editors free to repair their own values. */
export function blockingStackRaw(
  raw: Readonly<Record<string, string>>,
  path: string,
): string | undefined {
  return Object.keys(raw)
    .filter((key) => key === path || path.startsWith(`${key}/`))
    .sort((a, b) => a.length - b.length)[0];
}

/** Apply a list change and remap pending child JSON atomically, with one exact definition/draft revision. */
export function editStackList(
  draft: StackDraft,
  path: string,
  operation: StackListEdit,
  now = Date.now(),
): StackDraft {
  if (
    !/^\/definitions\/\d+\/(?:source\/)?(?:rules\/\d+\/|variables$|timers$)/.test(path) ||
    blockingStackRaw(draft.raw, path)
  )
    return draft;
  const original = valueAt(draft.configuration, path);
  if (!Array.isArray(original)) return draft;
  const entries = original.map((value, index) => ({
    value: value as JsonValue,
    from: index as number | undefined,
  }));
  const valid = (i: number) => Number.isSafeInteger(i) && i >= 0 && i < entries.length;
  if (operation.kind === 'add')
    entries.push({ value: structuredClone(operation.value), from: undefined });
  else if (operation.kind === 'move') {
    if (!valid(operation.from) || !valid(operation.to) || operation.from === operation.to)
      return draft;
    const item = entries.splice(operation.from, 1)[0];
    if (item) entries.splice(operation.to, 0, item);
  } else {
    if (!valid(operation.index)) return draft;
    if (operation.kind === 'remove') entries.splice(operation.index, 1);
    else {
      const entry = entries[operation.index];
      if (entry)
        entries.splice(operation.index + 1, 0, {
          value: structuredClone(entry.value),
          from: entry.from,
        });
    }
  }
  const raw: Record<string, string> = {};
  for (const [key, text] of Object.entries(draft.raw)) {
    if (!key.startsWith(`${path}/`)) {
      raw[key] = text;
      continue;
    }
    const tail = key.slice(path.length + 1);
    const separator = tail.indexOf('/');
    const token = separator < 0 ? tail : tail.slice(0, separator);
    if (!/^\d+$/.test(token)) {
      raw[key] = text;
      continue;
    }
    entries.forEach((entry, index) => {
      if (entry.from === Number(token))
        raw[`${path}/${index}${separator < 0 ? '' : tail.slice(separator)}`] = text;
    });
  }
  return {
    ...draft,
    configuration: editStackExperiment(
      draft.configuration,
      path,
      entries.map((entry) => entry.value),
    ),
    raw,
    version: draft.version + 1,
    updatedAt: now,
  };
}
