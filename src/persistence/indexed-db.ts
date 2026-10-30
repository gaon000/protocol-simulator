import type { WorkspaceData } from '../domain/workspace-model.ts';

export type StoragePort = {
  readonly read: () => Promise<unknown>;
  readonly write: (data: WorkspaceData, expectedRevision: number | null) => Promise<number>;
};
/** Describe a recoverable storage failure without treating a request success as a committed save. */
export class StorageFailure extends Error {
  readonly code: 'unavailable' | 'blocked' | 'quota' | 'conflict' | 'invalid' | 'unknown';
  constructor(code: StorageFailure['code'], message: string) {
    super(message);
    this.code = code;
  }
}
function problem(error: unknown): StorageFailure {
  if (error instanceof StorageFailure) return error;
  if (error && typeof error === 'object' && 'name' in error && error.name === 'QuotaExceededError')
    return new StorageFailure(
      'quota',
      '브라우저 저장 공간이 부족합니다. 메모리 초안을 유지했습니다.',
    );
  return new StorageFailure(
    'unknown',
    error instanceof Error ? error.message : '브라우저 저장에 실패했습니다.',
  );
}

/** Use native IndexedDB transactions and revision checks; no production package is needed. */
export function createIndexedDbStorage(
  factory: IDBFactory | undefined = globalThis.indexedDB,
  name = 'protocol-studio',
): StoragePort {
  async function open(): Promise<IDBDatabase> {
    if (!factory)
      throw new StorageFailure('unavailable', '이 브라우저에서 IndexedDB를 사용할 수 없습니다.');
    return new Promise((resolve, reject) => {
      let settled = false;
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('workspace'))
          request.result.createObjectStore('workspace');
      };
      request.onblocked = () => {
        settled = true;
        reject(new StorageFailure('blocked', '다른 탭이 저장소 갱신을 막고 있습니다.'));
      };
      request.onerror = () => {
        settled = true;
        reject(problem(request.error));
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
  return {
    read: async () => {
      const database = await open();
      try {
        return await new Promise<unknown>((resolve, reject) => {
          const transaction = database.transaction('workspace', 'readonly');
          const request = transaction.objectStore('workspace').get('current');
          transaction.oncomplete = () => resolve(request.result);
          transaction.onabort = () => reject(problem(transaction.error));
          transaction.onerror = () => {};
        });
      } finally {
        database.close();
      }
    },
    write: async (data, expectedRevision) => {
      const database = await open();
      try {
        return await new Promise<number>((resolve, reject) => {
          const transaction = database.transaction('workspace', 'readwrite');
          const store = transaction.objectStore('workspace');
          let failure: StorageFailure | undefined;
          const next = (expectedRevision ?? 0) + 1;
          const existing = store.get('current');
          existing.onsuccess = () => {
            try {
              const value = existing.result as
                | { revision?: unknown; schemaVersion?: unknown }
                | undefined;
              if (
                value !== undefined &&
                (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision))
              )
                throw new StorageFailure(
                  'invalid',
                  '저장소 형식이 달라 기존 데이터를 덮어쓰지 않았습니다.',
                );
              if ((value?.revision ?? null) !== expectedRevision)
                throw new StorageFailure(
                  'conflict',
                  '다른 탭의 변경과 충돌했습니다. 다시 시도하면 현재 변경을 사본으로 합칩니다.',
                );
              if (!Number.isSafeInteger(next))
                throw new StorageFailure('invalid', '저장 revision 한도를 넘었습니다.');
              store.put({ schemaVersion: 1, revision: next, data }, 'current');
            } catch (error) {
              failure = problem(error);
              transaction.abort();
            }
          };
          transaction.oncomplete = () => resolve(next);
          transaction.onabort = () => reject(failure ?? problem(transaction.error));
          transaction.onerror = () => {};
        });
      } finally {
        database.close();
      }
    },
  };
}
