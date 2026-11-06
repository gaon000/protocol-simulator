import { expect, type Page, test } from '@playwright/test';
import { createStackSimulation } from '../../src/application/create-stack-simulation.ts';
import { createWorkspace } from '../../src/application/workspace-operations.ts';
import {
  captureStackRun,
  createWorkspaceV2,
} from '../../src/application/workspace-v2-operations.ts';
import type { WorkspaceV2 } from '../../src/domain/workspace-v2-model.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';
import {
  createReliableStackExample,
  createReliableStackExperiment,
} from '../../src/examples/reliable-stack-examples.ts';
import { createMessageLimitExperiment } from '../fixtures/large-experiments.ts';

const modulePath = '/src/persistence/indexed-db-v2.ts';
function fixture(partial = false): WorkspaceV2 {
  const configuration = createReliableStackExample('first-ack-loss');
  const data = createWorkspaceV2(createWorkspace(createPingPongExperiment()), configuration);
  const draft = data.stack.drafts[0];
  if (!draft) throw new Error('Missing draft');
  const created = createStackSimulation(configuration);
  if (!created.success) throw new Error('Invalid fixture');
  if (partial) created.value.runBatch(12);
  const view = partial ? created.value.cancel() : created.value.run();
  return { ...data, stack: { ...data.stack, runs: [captureStackRun(view, draft.id, 1)] } };
}
async function seed(page: Page, name: string, value: unknown) {
  await page.evaluate(
    async ({ name, value }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('workspace');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('workspace', 'readwrite');
          tx.objectStore('workspace').put(value, 'current');
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
    { name, value },
  );
}
async function inspect(page: Page, name: string) {
  return page.evaluate(
    async (name) =>
      new Promise<{ version: number; current: unknown; backup: unknown; stores: string[] }>(
        (resolve, reject) => {
          const request = indexedDB.open(name);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const stores = [...db.objectStoreNames];
            const tx = db.transaction(stores, 'readonly');
            const backup = tx.objectStore('workspace').get('current');
            const current = stores.includes('workspace-v2')
              ? tx.objectStore('workspace-v2').get('current')
              : undefined;
            tx.oncomplete = () => {
              const result = {
                version: db.version,
                current: current?.result,
                backup: backup.result,
                stores,
              };
              db.close();
              resolve(result);
            };
            tx.onabort = () => {
              db.close();
              reject(tx.error);
            };
          };
        },
      ),
    name,
  );
}

test('native atomic upgrade preserves v1 originals, blocks old writers and roundtrips actual cancelled artifacts after reload', async ({
  page,
}) => {
  await page.goto('/');
  const name = `s4_${crypto.randomUUID()}`;
  const data = fixture(true);
  const original = { schemaVersion: 1, revision: 7, data: data.legacy };
  await seed(page, name, original);
  const result = await page.evaluate(
    async ({ name, data, modulePath }) => {
      const api = await import(modulePath);
      const port = api.createIndexedDbV2Storage(indexedDB, name);
      const migrated = await port.read();
      const revision = await port.write(data, 7);
      const oldWriter = await new Promise<string>((resolve) => {
        const r = indexedDB.open(name, 1);
        r.onerror = () => resolve(r.error?.name ?? 'error');
        r.onsuccess = () => {
          r.result.close();
          resolve('unexpected');
        };
      });
      return { migrated, revision, oldWriter };
    },
    { name, data: data as unknown, modulePath },
  );
  expect(result.revision).toBe(8);
  expect(result.oldWriter).toBe('VersionError');
  expect(result.migrated.data.legacy).toEqual(data.legacy);
  expect((await inspect(page, name)).backup).toEqual(original);
  await page.reload();
  const restored = await page.evaluate(
    async ({ name, modulePath }) =>
      (await import(modulePath)).createIndexedDbV2Storage(indexedDB, name).read(),
    { name, modulePath },
  );
  expect(restored.data).toEqual(data);
  expect(restored.data.stack.runs[0].view.status).toBe('cancelled');
  expect(restored.data.stack.runs[0].view.artifacts.payloads.length).toBeGreaterThan(0);
});

test('invalid legacy data, migration quota and transaction abort leave DB version and original store untouched', async ({
  page,
}) => {
  await page.goto('/');
  const data = fixture();
  for (const failure of ['invalid', 'quota', 'abort']) {
    const name = `s4_${crypto.randomUUID()}`;
    const original = {
      schemaVersion: failure === 'invalid' ? 99 : 1,
      revision: 1,
      data: data.legacy,
    };
    await seed(page, name, original);
    const code = await page.evaluate(
      async ({ name, failure, modulePath }) => {
        const api = await import(modulePath);
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
          if (this.name === 'workspace-v2' && failure === 'quota')
            throw new DOMException('quota', 'QuotaExceededError');
          const request = put.apply(this, args);
          if (this.name === 'workspace-v2' && failure === 'abort')
            request.addEventListener('success', () => this.transaction.abort());
          return request;
        };
        try {
          await api.createIndexedDbV2Storage(indexedDB, name).read();
          return 'unexpected';
        } catch (error) {
          return (error as { code: string }).code;
        } finally {
          IDBObjectStore.prototype.put = put;
        }
      },
      { name, failure, modulePath },
    );
    expect(code).toBe(failure === 'abort' ? 'unknown' : failure);
    const saved = await inspect(page, name);
    expect(saved.version).toBe(1);
    expect(saved.stores).toEqual(['workspace']);
    expect(saved.backup).toEqual(original);
    if (failure !== 'invalid') {
      await page.evaluate(
        async ({ name, modulePath }) =>
          (await import(modulePath)).createIndexedDbV2Storage(indexedDB, name).read(),
        { name, modulePath },
      );
      expect((await inspect(page, name)).version).toBe(2);
    }
  }
});

test('blocked upgrade reports failure, cancels the pending upgrade and succeeds only on explicit retry', async ({
  page,
}) => {
  await page.goto('/');
  const name = `s4_${crypto.randomUUID()}`;
  const original = { schemaVersion: 1, revision: 1, data: fixture().legacy };
  await seed(page, name, original);
  const result = await page.evaluate(
    async ({ name, modulePath }) => {
      const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open(name, 1);
        r.onerror = () => reject(r.error);
        r.onsuccess = () => resolve(r.result);
      });
      blocker.onversionchange = () => {};
      const api = await import(modulePath);
      let code = '';
      try {
        await api.createIndexedDbV2Storage(indexedDB, name).read();
      } catch (error) {
        code = (error as { code: string }).code;
      }
      blocker.close();
      const version = await new Promise<number>((resolve, reject) => {
        const r = indexedDB.open(name);
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const v = r.result.version;
          r.result.close();
          resolve(v);
        };
      });
      await api.createIndexedDbV2Storage(indexedDB, name).read();
      return { code, version };
    },
    { name, modulePath },
  );
  expect(result).toEqual({ code: 'blocked', version: 1 });
  expect((await inspect(page, name)).version).toBe(2);
});

test('native versionchange closes an adapter connection with a pending read and fences later old-version access', async ({
  page,
}) => {
  await page.goto('/');
  const name = `s4_${crypto.randomUUID()}`;
  await seed(page, name, { schemaVersion: 1, revision: 1, data: fixture().legacy });
  const result = await page.evaluate(
    async ({ name, modulePath }) => {
      const api = await import(modulePath);
      const port = api.createIndexedDbV2Storage(indexedDB, name);
      await port.read();
      const originalTransaction = IDBDatabase.prototype.transaction;
      const originalClose = IDBDatabase.prototype.close;
      let released = false;
      let closedDuringRead = false;
      let begin: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        begin = resolve;
      });
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = originalTransaction.apply(this, args);
        if (this.name === name && args[1] === 'readonly') {
          const store = tx.objectStore('workspace-v2');
          const pump = () => {
            const r = store.get('keepalive');
            r.onsuccess = () => {
              if (!released) pump();
            };
          };
          pump();
          begin();
        }
        return tx;
      };
      IDBDatabase.prototype.close = function () {
        if (this.name === name && !released) {
          closedDuringRead = true;
          released = true;
        }
        originalClose.call(this);
      };
      try {
        const read = port.read();
        await started;
        await new Promise<void>((resolve, reject) => {
          const r = indexedDB.open(name, 3);
          r.onerror = () => reject(r.error);
          r.onsuccess = () => {
            r.result.close();
            resolve();
          };
        });
        await read;
        let fenced = false;
        try {
          await port.read();
        } catch {
          fenced = true;
        }
        return { closedDuringRead, fenced };
      } finally {
        released = true;
        IDBDatabase.prototype.transaction = originalTransaction;
        IDBDatabase.prototype.close = originalClose;
      }
    },
    { name, modulePath },
  );
  expect(result).toEqual({ closedDuringRead: true, fenced: true });
});

test('two native tabs cannot overwrite a shared revision and invalid payload writes preserve the last commit', async ({
  page,
  context,
}) => {
  await page.goto('/');
  const name = `s4_${crypto.randomUUID()}`;
  const data = fixture();
  await page.evaluate(
    async ({ name, data, modulePath }) =>
      (await import(modulePath)).createIndexedDbV2Storage(indexedDB, name).write(data, null),
    { name, data: data as unknown, modulePath },
  );
  const other = await context.newPage();
  await other.goto('/');
  const save = (tab: Page, version: number) =>
    tab.evaluate(
      async ({ name, data, modulePath, version }) => {
        const actual = data as WorkspaceV2;
        const next = {
          ...actual,
          stack: {
            ...actual.stack,
            drafts: actual.stack.drafts.map((draft) => ({ ...draft, version })),
          },
        };
        try {
          return {
            revision: await (await import(modulePath))
              .createIndexedDbV2Storage(indexedDB, name)
              .write(next, 1),
          };
        } catch (error) {
          return { error: (error as { code: string }).code };
        }
      },
      { name, data: data as unknown, modulePath, version },
    );
  const results = await Promise.all([save(page, 2), save(other, 3)]);
  expect(results.filter((r) => r.revision === 2)).toHaveLength(1);
  expect(results.filter((r) => r.error === 'conflict')).toHaveLength(1);
  const before = await inspect(page, name);
  const rejected = await page.evaluate(
    async ({ name, modulePath }) => {
      const port = (await import(modulePath)).createIndexedDbV2Storage(indexedDB, name);
      const current = await port.read();
      const event = current.data.stack.runs[0].view.events.find(
        (e: { payloads: unknown[] }) => e.payloads.length,
      );
      event.payloads[0].payloadId = 'absent';
      try {
        await port.write(current.data, 2);
        return 'unexpected';
      } catch (error) {
        return (error as { code: string }).code;
      }
    },
    { name, modulePath },
  );
  expect(rejected).toBe('invalid');
  expect(await inspect(page, name)).toEqual(before);
});

test('native controller quota recovery retains memory, retries a committed save and preserves original legacy recovery data', async ({
  page,
}) => {
  await page.goto('/');
  const name = `s4_${crypto.randomUUID()}`;
  const data = fixture();
  await seed(page, name, { schemaVersion: 1, revision: 1, data: data.legacy });
  const result = await page.evaluate(
    async ({ name, data, modulePath }) => {
      const storage = await import(modulePath);
      const controllerPath = '/src/application/workspace-v2-controller.ts';
      const api = await import(controllerPath);
      const port = storage.createIndexedDbV2Storage(indexedDB, name);
      const controller = api.createWorkspaceV2Controller(port, data);
      await controller.load();
      controller.update(() => data);
      await controller.save();
      controller.update((current: WorkspaceV2) => ({
        ...current,
        stack: {
          ...current.stack,
          drafts: current.stack.drafts.map((d) => ({ ...d, version: 9 })),
        },
      }));
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'workspace-v2') throw new DOMException('quota', 'QuotaExceededError');
        return put.apply(this, args);
      };
      try {
        await controller.save();
      } finally {
        IDBObjectStore.prototype.put = put;
      }
      const failed = controller.view();
      await controller.retry();
      return {
        failed: failed.status,
        memoryVersion: failed.data.stack.drafts[0].version,
        status: controller.view().status,
        stored: await port.read(),
        backup: await port.readLegacyBackup(),
      };
    },
    { name, data: data as unknown, modulePath },
  );
  expect(result.failed).toBe('error');
  expect(result.memoryVersion).toBe(9);
  expect(result.status).toBe('saved');
  expect(result.stored.data.stack.drafts[0].version).toBe(9);
  expect(result.backup.data).toEqual(data.legacy);
});

test('a real one MiB stack frame keeps actual payload ranges and bytes through native save/reload', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto('/');
  const name = `s4_${crypto.randomUUID()}`;
  const configuration = createReliableStackExperiment(createMessageLimitExperiment(), {
    chunkBytes: 65536,
    observationMs: 1000,
  });
  const created = createStackSimulation(configuration);
  if (!created.success) throw new Error('Invalid large fixture');
  const view = created.value.run();
  expect(view.status).toBe('completed');
  expect(view.expectations.every((e) => e.status === 'pass')).toBe(true);
  const base = createWorkspaceV2(createWorkspace(createPingPongExperiment()), configuration);
  const draft = base.stack.drafts[0];
  if (!draft) throw new Error('No draft');
  const data = { ...base, stack: { ...base.stack, runs: [captureStackRun(view, draft.id, 1)] } };
  await page.evaluate(
    async ({ name, data, modulePath }) =>
      (await import(modulePath)).createIndexedDbV2Storage(indexedDB, name).write(data, null),
    { name, data: data as unknown, modulePath },
  );
  await page.reload();
  const roundtrip = await page.evaluate(
    async ({ name, modulePath }) => {
      const p = (await import(modulePath)).createIndexedDbV2Storage(indexedDB, name);
      return (await p.read()).data.stack.runs[0].view;
    },
    { name, modulePath },
  );
  expect(roundtrip).toEqual(view);
});
