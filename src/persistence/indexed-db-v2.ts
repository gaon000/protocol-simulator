import { parseOwnedJsonData } from '../domain/model-validation.ts';
import { WORKSPACE_POLICY } from '../domain/workspace-model.ts';
import type { WorkspaceV2 } from '../domain/workspace-v2-model.ts';
import {
  parseWorkspaceV2,
  parseWorkspaceV2Envelope,
  upgradeWorkspaceData,
} from '../domain/workspace-v2-validation.ts';
import { parseWorkspaceEnvelope } from '../domain/workspace-validation.ts';
import { StorageFailure, storageProblem, type VersionedStoragePort } from './storage-port.ts';

export const WORKSPACE_DB_VERSION = 2;
export const WORKSPACE_V2_STORE = 'workspace-v2';

/** Upgrade atomically, retain the v1 store as a read-only recovery copy, and CAS all future writes in v2. */
export function createIndexedDbV2Storage(
  factory: IDBFactory | undefined = globalThis.indexedDB,
  name = 'protocol-studio',
): VersionedStoragePort<WorkspaceV2> & {
  readonly readLegacyBackup: () => Promise<unknown>;
  readonly replaceLegacy: (
    data: WorkspaceV2['legacy'],
    expectedRevision: number | null,
  ) => Promise<number>;
} {
  async function open(): Promise<IDBDatabase> {
    if (!factory)
      throw new StorageFailure('unavailable', '이 브라우저에서 IndexedDB를 사용할 수 없습니다.');
    return new Promise((resolve, reject) => {
      let settled = false;
      let migrationError: StorageFailure | undefined;
      const request = factory.open(name, WORKSPACE_DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        const transaction = request.transaction;
        if (!transaction) return;
        if (settled) {
          transaction.abort();
          return;
        }
        if (!database.objectStoreNames.contains('workspace'))
          database.createObjectStore('workspace');
        const target = database.createObjectStore(WORKSPACE_V2_STORE);
        const legacy = transaction.objectStore('workspace').get('current');
        legacy.onsuccess = () => {
          try {
            if (legacy.result === undefined) return;
            const checked = parseWorkspaceEnvelope(legacy.result);
            if (!checked.success)
              throw new StorageFailure(
                'invalid',
                '이전 저장 자료를 검사하지 못해 DB 갱신을 취소했습니다. 원본을 유지했습니다.',
              );
            const data = upgradeWorkspaceData(checked.value.data);
            const parsed = parseWorkspaceV2(data);
            if (!parsed.success)
              throw new StorageFailure('invalid', '이전 자료를 새 저장 형식에 담지 못했습니다.');
            target.put({ schemaVersion: 2, revision: checked.value.revision, data }, 'current');
          } catch (error) {
            migrationError = storageProblem(error);
            transaction.abort();
          }
        };
      };
      request.onblocked = () => {
        settled = true;
        reject(
          new StorageFailure(
            'blocked',
            '다른 탭이 저장소 갱신을 막고 있습니다. 해당 탭을 닫고 다시 시도하세요.',
          ),
        );
      };
      request.onerror = () => {
        settled = true;
        reject(migrationError ?? storageProblem(request.error));
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        if (settled) database.close();
        else {
          settled = true;
          resolve(database);
        }
      };
    });
  }
  async function readStore(store: string): Promise<unknown> {
    const database = await open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(store, 'readonly');
        const request = transaction.objectStore(store).get('current');
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(storageProblem(transaction.error));
        transaction.onerror = () => {};
      });
    } finally {
      database.close();
    }
  }
  async function write(
    change: (old: WorkspaceV2 | undefined) => WorkspaceV2,
    expectedRevision: number | null,
  ): Promise<number> {
    const database = await open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(WORKSPACE_V2_STORE, 'readwrite');
        const store = transaction.objectStore(WORKSPACE_V2_STORE);
        const existing = store.get('current');
        let failure: StorageFailure | undefined;
        const next = (expectedRevision ?? 0) + 1;
        existing.onsuccess = () => {
          try {
            if (existing.result !== undefined && existing.result?.schemaVersion !== 2)
              throw new StorageFailure(
                'invalid',
                'v2 저장 영역의 형식이 달라 덮어쓰지 않았습니다.',
              );
            let parsed: ReturnType<typeof parseWorkspaceV2Envelope> | undefined;
            if (existing.result !== undefined) {
              const json = parseOwnedJsonData(existing.result, {
                maxNodes: WORKSPACE_POLICY.maxJsonNodes,
                maxDepth: 132,
              });
              if (!json.success)
                throw new StorageFailure(
                  'invalid',
                  '저장 자료의 JSON 형식이 달라 원본을 유지했습니다.',
                );
              parsed = parseWorkspaceV2Envelope(json.value);
            }
            if (parsed && !parsed.success)
              throw new StorageFailure(
                'invalid',
                '저장된 형식이 달라 기존 데이터를 덮어쓰지 않았습니다.',
              );
            if ((parsed?.success ? parsed.value.revision : null) !== expectedRevision)
              throw new StorageFailure(
                'conflict',
                '다른 탭의 변경과 충돌했습니다. 다시 시도하면 현재 변경을 사본으로 합칩니다.',
              );
            if (!Number.isSafeInteger(next))
              throw new StorageFailure('invalid', '저장 revision 한도를 넘었습니다.');
            const data = change(parsed?.success ? parsed.value.data : undefined);
            const valid = parseWorkspaceV2(data);
            if (!valid.success)
              throw new StorageFailure(
                'invalid',
                `저장 자료 검사 실패: ${valid.diagnostics[0]?.code}`,
              );
            store.put({ schemaVersion: 2, revision: next, data }, 'current');
          } catch (error) {
            failure = storageProblem(error);
            transaction.abort();
          }
        };
        transaction.oncomplete = () => resolve(next);
        transaction.onabort = () => reject(failure ?? storageProblem(transaction.error));
        transaction.onerror = () => {};
      });
    } finally {
      database.close();
    }
  }
  return {
    read: () => readStore(WORKSPACE_V2_STORE),
    readLegacyBackup: () => readStore('workspace'),
    write: (data, revision) => write(() => data, revision),
    replaceLegacy: (data, revision) =>
      write((old) => (old ? { ...old, legacy: data } : upgradeWorkspaceData(data)), revision),
  };
}
