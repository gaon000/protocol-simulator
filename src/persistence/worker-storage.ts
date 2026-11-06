import { freezeOwned, isOwnedImmutable } from '../domain/immutable-data.ts';
import type { ValidationResult } from '../domain/protocol-model.ts';
import type { WorkspaceV2, WorkspaceV2Envelope } from '../domain/workspace-v2-model.ts';
import { StorageFailure } from './storage-port.ts';

type Checked =
  | { success: true; token?: number; upgraded?: WorkspaceV2Envelope }
  | Extract<ValidationResult<never>, { success: false }>;
/** Keep native v2 transactions and full record validation off the rendering thread, preserving typed failures. */
export function createWorkerStorage(
  createWorker: () => Worker = () =>
    new Worker(new URL('./workspace-storage-worker.ts', import.meta.url), { type: 'module' }),
) {
  const tokens = new WeakMap<WorkspaceV2, number>();
  let worker: Worker | undefined;
  let next = 0;
  let closed = false;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  function request<T>(
    type: string,
    data?: unknown,
    revision?: number | null,
    token?: number,
  ): Promise<T> {
    if (closed)
      return Promise.reject(new StorageFailure('unavailable', '저장 worker가 닫혔습니다.'));
    if (!worker) {
      const active = createWorker();
      worker = active;
      active.onmessage = ({ data: reply }) => {
        if (closed || worker !== active) return;
        const item = pending.get(reply.id);
        pending.delete(reply.id);
        if (reply.error) item?.reject(new StorageFailure(reply.error.code, reply.error.message));
        else item?.resolve(reply.value);
      };
      active.onerror = () => {
        if (closed || worker !== active) return;
        for (const item of pending.values())
          item.reject(
            new StorageFailure('unavailable', '저장 worker 오류입니다. 메모리 자료를 유지합니다.'),
          );
        pending.clear();
        active.terminate();
        worker = undefined;
      };
    }
    const id = ++next;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try {
        worker?.postMessage({ id, type, data, revision, token });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }
  return {
    read: () => request<unknown>('read'),
    write: async (data: WorkspaceV2, revision: number | null) => {
      const token = isOwnedImmutable(data) ? tokens.get(data) : undefined;
      tokens.delete(data);
      return request<number>('write', token === undefined ? data : undefined, revision, token);
    },
    readLegacyBackup: () => request<unknown>('backup'),
    validation: {
      workspace: async (data: WorkspaceV2): Promise<ValidationResult<WorkspaceV2>> => {
        const source = isOwnedImmutable(data) ? data : freezeOwned(structuredClone(data));
        const result = await request<Checked>('validate', source);
        if (result.success && result.token !== undefined) tokens.set(source, result.token);
        return result.success ? { success: true, value: source } : result;
      },
      envelope: async (data: unknown): Promise<ValidationResult<WorkspaceV2Envelope>> => {
        const result = await request<Checked>('envelope', data);
        return result.success
          ? { success: true, value: result.upgraded ?? (data as WorkspaceV2Envelope) }
          : result;
      },
    },
    close: () => {
      closed = true;
      worker?.terminate();
      for (const item of pending.values())
        item.reject(new StorageFailure('unavailable', '저장 창을 닫았습니다.'));
      pending.clear();
    },
  };
}
