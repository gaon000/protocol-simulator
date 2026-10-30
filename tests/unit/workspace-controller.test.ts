import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceController } from '../../src/application/workspace-controller.ts';
import { createWorkspace } from '../../src/application/workspace-operations.ts';
import type { WorkspaceData, WorkspaceEnvelope } from '../../src/domain/workspace-model.ts';
import { createExampleCopy } from '../../src/examples/catalog.ts';
import {
  StorageFailure,
  createIndexedDbStorage,
  type StoragePort,
} from '../../src/persistence/indexed-db.ts';

function workspace() {
  return createWorkspace(createExampleCopy('ping_pong'));
}
function rename(data: WorkspaceData, label: string): WorkspaceData {
  return {
    ...data,
    drafts: data.drafts.map((item) =>
      item.id === data.activeDraftId
        ? { ...item, configuration: { ...item.configuration, label }, version: item.version + 1 }
        : item,
    ),
  };
}
function memory(initial?: WorkspaceData) {
  let stored: WorkspaceEnvelope | undefined = initial
    ? { schemaVersion: 1, revision: 1, data: structuredClone(initial) }
    : undefined;
  let failure: Error | undefined;
  let writes = 0;
  const port: StoragePort = {
    read: async () => structuredClone(stored),
    write: async (data, revision) => {
      writes++;
      if (failure) throw failure;
      if ((stored?.revision ?? null) !== revision)
        throw new StorageFailure('conflict', 'revision conflict');
      stored = { schemaVersion: 1, revision: (revision ?? 0) + 1, data: structuredClone(data) };
      return stored.revision;
    },
  };
  return {
    port,
    stored: () => stored,
    fail: (error?: Error) => {
      failure = error;
    },
    writes: () => writes,
  };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => assert.fail('not initialized');
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('controller acknowledges only committed saves and serializes the latest edit during an in-flight transaction', async () => {
  const first = deferred<number>();
  const second = deferred<number>();
  const writes: { data: WorkspaceData; revision: number | null }[] = [];
  const controller = createWorkspaceController(
    {
      read: async () => undefined,
      write: async (data, revision) => {
        writes.push({ data, revision });
        return writes.length === 1 ? first.promise : second.promise;
      },
    },
    workspace(),
  );
  await controller.load();
  assert.equal(controller.view().status, 'unsaved');
  controller.update((data) => rename(data, 'first'));
  const saving = controller.save();
  assert.equal(controller.view().status, 'saving');
  controller.update((data) => rename(data, 'latest'));
  first.resolve(1);
  await Promise.resolve();
  await Promise.resolve();
  assert.notEqual(controller.view().status, 'saved');
  second.resolve(2);
  await saving;
  assert.equal(writes.length, 2);
  assert.equal(writes[0]?.data.drafts[0]?.configuration.label, 'first');
  assert.equal(writes[1]?.data.drafts[0]?.configuration.label, 'latest');
  assert.equal(writes[1]?.revision, 1);
  assert.equal(controller.view().status, 'saved');
});

test('quota failure preserves memory and last committed data, and retry persists the latest draft', async () => {
  const store = memory(workspace());
  const controller = createWorkspaceController(store.port, workspace());
  await controller.load();
  const old = structuredClone(store.stored());
  store.fail(new StorageFailure('quota', 'quota'));
  controller.update((data) => rename(data, 'keep memory'));
  await controller.save();
  assert.equal(controller.view().status, 'error');
  assert.equal(controller.view().data.drafts[0]?.configuration.label, 'keep memory');
  assert.deepEqual(store.stored(), old);
  store.fail();
  await controller.retry();
  assert.equal(controller.view().status, 'saved');
  assert.equal(store.stored()?.data.drafts[0]?.configuration.label, 'keep memory');
  const restored = createWorkspaceController(store.port, workspace());
  await restored.load();
  assert.deepEqual(restored.view().data, controller.view().data);
  assert.equal(store.writes(), 2);
});

test('two controllers cannot silently overwrite each other; retry merges both divergent drafts as copies', async () => {
  const store = memory(workspace());
  const a = createWorkspaceController(store.port, workspace());
  const b = createWorkspaceController(store.port, workspace());
  await Promise.all([a.load(), b.load()]);
  a.update((data) => rename(data, 'tab A'));
  b.update((data) => rename(data, 'tab B'));
  await a.save();
  await b.save();
  assert.equal(b.view().status, 'conflict');
  assert.equal(store.stored()?.data.drafts[0]?.configuration.label, 'tab A');
  assert.equal(b.view().data.drafts[0]?.configuration.label, 'tab B');
  await b.save();
  assert.equal(store.writes(), 2);
  await b.retry();
  assert.equal(b.view().status, 'saved');
  assert.deepEqual(
    store
      .stored()
      ?.data.drafts.map((item) => item.configuration.label)
      .sort(),
    ['tab A', 'tab B'],
  );
  assert.equal(new Set(store.stored()?.data.drafts.map((item) => item.id)).size, 2);
});

test('retry reuses unchanged records instead of duplicating an entire shared workspace', async () => {
  const initial = workspace();
  const extra = workspace().drafts[0];
  assert.ok(extra);
  const store = memory({ ...initial, drafts: [...initial.drafts, extra] });
  const a = createWorkspaceController(store.port, workspace());
  const b = createWorkspaceController(store.port, workspace());
  await Promise.all([a.load(), b.load()]);
  a.update((data) => rename(data, 'A'));
  await a.save();
  b.update((data) => rename(data, 'B'));
  await b.save();
  await b.retry();
  assert.equal(b.view().data.drafts.length, 3);
  assert.equal(b.view().data.drafts.filter((item) => item.id === extra.id).length, 1);
});

test('unreadable storage is never overwritten and memory editing remains available', async () => {
  const data = workspace();
  let writes = 0;
  const bad = { schemaVersion: 99, revision: 1, data };
  const controller = createWorkspaceController(
    {
      read: async () => bad,
      write: async () => {
        writes++;
        return 2;
      },
    },
    workspace(),
  );
  await controller.load();
  assert.equal(controller.view().ready, true);
  assert.equal(controller.view().status, 'error');
  controller.update((current) => rename(current, 'unsaved edit'));
  await controller.save();
  await controller.retry();
  assert.equal(writes, 0);
  assert.equal(controller.view().data.drafts[0]?.configuration.label, 'unsaved edit');
  assert.equal(bad.schemaVersion, 99);
});

test('unavailable storage reports an actionable failure and can recover by merging an existing workspace', async () => {
  const remote = memory(workspace());
  let available = false;
  const controller = createWorkspaceController(
    {
      read: async () => {
        if (!available) throw new StorageFailure('unavailable', 'unavailable');
        return remote.port.read();
      },
      write: remote.port.write,
    },
    workspace(),
  );
  await controller.load();
  controller.update((data) => rename(data, 'offline edit'));
  await controller.save();
  assert.equal(remote.writes(), 0);
  available = true;
  await controller.retry();
  assert.equal(controller.view().status, 'saved');
  assert.equal(controller.view().data.drafts.length, 2);
  assert.ok(
    controller.view().data.drafts.some((item) => item.configuration.label === 'offline edit'),
  );
  await assert.rejects(
    createIndexedDbStorage(undefined).read(),
    (error: unknown) => error instanceof StorageFailure && error.code === 'unavailable',
  );
});

test('workspace capacity failures keep memory without evicting any stored records', async () => {
  const store = memory(workspace());
  const controller = createWorkspaceController(store.port, workspace());
  await controller.load();
  controller.update((data) => {
    const draft = data.drafts[0];
    assert.ok(draft);
    return {
      ...data,
      drafts: Array.from({ length: 101 }, (_, i) => ({ ...draft, id: `draft_${i}` })),
      activeDraftId: 'draft_0',
    };
  });
  await controller.save();
  assert.equal(controller.view().status, 'error');
  assert.equal(controller.view().data.drafts.length, 101);
  assert.equal(store.stored()?.data.drafts.length, 1);
  assert.equal(store.writes(), 0);
});
