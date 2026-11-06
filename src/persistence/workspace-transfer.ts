import type { WorkspaceV2 } from '../domain/workspace-v2-model.ts';
import { Reader } from '../domain/model-validation.ts';
import type { ValidationResult } from '../domain/protocol-model.ts';

function compact<T>(rows: readonly T[], base: readonly T[]) {
  const indexes = new Map(base.map((row, index) => [row, index]));
  return rows.map((row) => {
    const index = indexes.get(row);
    return index === undefined ? { value: row } : { index };
  });
}
/** Transfer changed immutable rows while preserving every other field for full workspace validation. */
export function compactWorkspace(data: WorkspaceV2, base: WorkspaceV2): unknown {
  return {
    ...data,
    legacy: { ...data.legacy, runs: compact(data.legacy.runs, base.legacy.runs) },
    stack: { ...data.stack, runs: compact(data.stack.runs, base.stack.runs) },
  };
}
/** Restore exact worker-owned rows; reference checks never replace the final domain/schema validation. */
export function restoreWorkspace(value: unknown, base: WorkspaceV2): ValidationResult<unknown> {
  const r = new Reader();
  const root = r.object(value, '');
  const legacy = root && r.object(root.legacy, '/legacy');
  const stack = root && r.object(root.stack, '/stack');
  function rows(value: unknown, previous: readonly unknown[], path: string) {
    if (!Array.isArray(value) || value.length > 100) {
      r.issue(path, 'transfer-rows', 'Expected at most 100 transferred rows');
      return [];
    }
    return value.map((item, index) => {
      const where = `${path}/${index}`;
      const row = r.object(item, where, ['index', 'value'], []);
      if (!row) return undefined;
      if (Object.keys(row).length !== 1) {
        r.issue(where, 'transfer-reference', 'Expected exactly one value or reference');
        return undefined;
      }
      if (Object.hasOwn(row, 'index')) {
        r.number(row.index, `${where}/index`, 0, previous.length - 1);
        return previous[Number(row.index)];
      }
      if (Object.hasOwn(row, 'value')) return row.value;
      r.issue(where, 'transfer-reference', 'Missing transferred value');
      return undefined;
    });
  }
  const old = rows(legacy?.runs, base.legacy.runs, '/legacy/runs');
  const next = rows(stack?.runs, base.stack.runs, '/stack/runs');
  return r.result({ ...root, legacy: { ...legacy, runs: old }, stack: { ...stack, runs: next } });
}
