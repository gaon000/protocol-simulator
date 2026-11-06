import { freezeOwned } from '../domain/immutable-data.ts';
import type { StackDraft } from '../domain/workspace-v2-model.ts';

export const STACK_EDIT_HISTORY_POLICY = {
  entries: 50,
  bytes: 8_388_608,
  owners: 100,
  groupMs: 750,
} as const;
type Content = Pick<StackDraft, 'configuration' | 'raw'>;
type Entry = {
  before: Content;
  after: Content;
  bytes: number;
  beforeBytes: number;
  key: string | undefined;
  time: number;
};
type Journal = {
  present: Content;
  past: Entry[];
  future: Entry[];
  revision: number;
  touched: number;
  limited: boolean;
};
const same = (a: Content, b: Content) => a.configuration === b.configuration && a.raw === b.raw;
const content = (draft: Content): Content => ({
  configuration: draft.configuration,
  raw: draft.raw,
});
const revisionOf = (draft: Content) =>
  draft.configuration.definitions.reduce((maximum, p) => Math.max(maximum, p.revision), 0);
const byteSize = (text: string) => new TextEncoder().encode(text).length;

/** Keep bounded, tab-local configuration/raw undo journals; persist only the current canonical draft. */
export function createStackEditHistory(
  policy: {
    entries: number;
    bytes: number;
    owners: number;
    groupMs: number;
  } = STACK_EDIT_HISTORY_POLICY,
) {
  const owners = new Map<string, Journal>();
  let sequence = 0;
  function journal(draft: StackDraft): Journal | undefined {
    const found = owners.get(draft.id);
    if (found && !same(found.present, draft)) {
      owners.delete(draft.id);
      return undefined;
    }
    return found;
  }
  const total = () =>
    [...owners.values()].reduce(
      (n, j) => n + [...j.past, ...j.future].reduce((s, e) => s + e.bytes, 0),
      0,
    );
  function trim(active: string) {
    while (owners.size > policy.owners || total() > policy.bytes) {
      const other = [...owners.entries()]
        .filter(([id]) => id !== active)
        .sort((a, b) => a[1].touched - b[1].touched)[0];
      if (other) {
        owners.delete(other[0]);
        continue;
      }
      const current = owners.get(active);
      if (!current) break;
      current.limited = true;
      if (current.past.length) current.past.shift();
      else if (current.future.length) current.future.shift();
      else {
        owners.delete(active);
        break;
      }
    }
  }
  function record(before: StackDraft, after: StackDraft, key?: string, time = Date.now()) {
    if (same(before, after)) return;
    const current = journal(before) ?? {
      present: content(before),
      past: [],
      future: [],
      revision: revisionOf(before),
      touched: ++sequence,
      limited: false,
    };
    owners.set(before.id, current);
    const beforeText = JSON.stringify(content(before)),
      afterText = JSON.stringify(content(after));
    const first = byteSize(beforeText),
      last = byteSize(afterText);
    current.revision = Math.max(current.revision, revisionOf(after));
    current.present = content(after);
    current.touched = ++sequence;
    if (beforeText === afterText) return;
    const previous = current.past.at(-1);
    const grouped =
      previous &&
      key !== undefined &&
      key === previous.key &&
      time >= previous.time &&
      time - previous.time <= policy.groupMs &&
      !current.future.length;
    current.future = [];
    if (grouped) {
      current.past[current.past.length - 1] = {
        ...previous,
        after: content(after),
        bytes: previous.beforeBytes + last,
        time,
      };
    } else
      current.past.push({
        before: content(before),
        after: content(after),
        bytes: first + last,
        beforeBytes: first,
        key,
        time,
      });
    while (current.past.length > policy.entries) {
      current.past.shift();
      current.limited = true;
    }
    trim(before.id);
  }
  function travel(
    draft: StackDraft,
    direction: 'undo' | 'redo',
    now = Date.now(),
  ): StackDraft | undefined {
    const current = journal(draft);
    const from = direction === 'undo' ? current?.past : current?.future;
    const entry = from?.at(-1);
    if (!current || !from || !entry) return undefined;
    const target = direction === 'undo' ? entry.before : entry.after;
    const firstRevision = Math.max(current.revision, revisionOf(draft)) + 1;
    const revision = firstRevision + target.configuration.definitions.length - 1;
    if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(draft.version + 1))
      return undefined;
    const configuration = structuredClone(target.configuration);
    const definitions = configuration.definitions.map((p, index) =>
      p.mode === 'legacy-application'
        ? {
            ...p,
            revision: firstRevision + index,
            source: { ...p.source, id: p.id, revision: firstRevision + index },
          }
        : { ...p, revision: firstRevision + index },
    );
    const node = (participant: 'A' | 'B') => ({
      instances: configuration.nodes[participant].instances.map((instance) => {
        const index = configuration.definitions.findIndex(
          (p) => p.id === instance.definition.id && p.revision === instance.definition.revision,
        );
        const definition = definitions[index];
        return definition
          ? { ...instance, definition: { id: definition.id, revision: definition.revision } }
          : instance;
      }),
    });
    const nodes = { A: node('A'), B: node('B') };
    const restored = freezeOwned({
      ...draft,
      configuration: { ...configuration, definitions, nodes },
      raw: structuredClone(target.raw),
      version: draft.version + 1,
      updatedAt: now,
    });
    from.pop();
    const moved = { ...entry, key: undefined };
    (direction === 'undo' ? current.future : current.past).push(moved);
    // Returning to typing after travel starts a new edit group.
    const previous = current.past.at(-1);
    if (previous) previous.key = undefined;
    current.present = content(restored);
    current.revision = revision;
    current.touched = ++sequence;
    return restored;
  }
  return {
    record,
    travel,
    view: (draft: StackDraft) => {
      const found = owners.get(draft.id);
      const current = found && same(found.present, draft) ? found : undefined;
      return {
        undo: current?.past.length ?? 0,
        redo: current?.future.length ?? 0,
        limited: current?.limited ?? false,
        bytes: total(),
      };
    },
    reconcile: (drafts: readonly StackDraft[]) => {
      const current = new Map(drafts.map((draft) => [draft.id, draft]));
      for (const [id, entry] of owners) {
        const draft = current.get(id);
        if (!draft || !same(entry.present, draft)) owners.delete(id);
      }
    },
    prune: (ids: readonly string[]) => {
      for (const id of owners.keys()) if (!ids.includes(id)) owners.delete(id);
    },
    clear: () => owners.clear(),
  };
}
export type StackEditHistory = ReturnType<typeof createStackEditHistory>;
