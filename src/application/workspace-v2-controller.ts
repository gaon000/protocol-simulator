import { freezeOwned } from '../domain/immutable-data.ts';
import type { WorkspaceV2 } from '../domain/workspace-v2-model.ts';
import { parseWorkspaceV2, parseWorkspaceV2Envelope } from '../domain/workspace-v2-validation.ts';
import { StorageFailure, type VersionedStoragePort } from '../persistence/storage-port.ts';
import {
  exportWorkspaceV2,
  mergeWorkspacesV2,
  stageWorkspaceV2Bundle,
} from './workspace-v2-operations.ts';

/** Serialize v2 CAS saves; preserve memory on quota/abort/conflict and merge divergent retries as copies. */
export function createWorkspaceV2Controller(
  port: VersionedStoragePort<WorkspaceV2>,
  initial: WorkspaceV2,
) {
  let state: {
    readonly data: WorkspaceV2;
    readonly ready: boolean;
    readonly status: 'loading' | 'saved' | 'unsaved' | 'saving' | 'conflict' | 'error';
    readonly serial: number;
    readonly error: string;
  } = {
    data: freezeOwned(structuredClone(initial)),
    ready: false,
    status: 'loading',
    serial: 0,
    error: '',
  };
  let revision: number | null = null;
  let writable = false;
  let committed = -1;
  let loading: Promise<void> | undefined;
  let saving: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  function publish(patch: Partial<typeof state>) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  function fail(error: unknown) {
    publish({
      status: error instanceof StorageFailure && error.code === 'conflict' ? 'conflict' : 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  }
  async function load(): Promise<void> {
    if (loading) return loading;
    loading = (async () => {
      try {
        const stored = await port.read();
        if (stored === undefined) {
          writable = true;
          publish({ ready: true, status: 'unsaved', serial: 1 });
        } else {
          const parsed = parseWorkspaceV2Envelope(stored);
          if (!parsed.success)
            throw new StorageFailure('invalid', '저장 자료를 검사하지 못해 원본을 유지했습니다.');
          revision = parsed.value.revision;
          writable = true;
          committed = 0;
          publish({
            data: freezeOwned(structuredClone(parsed.value.data)),
            ready: true,
            status: 'saved',
          });
        }
      } catch (error) {
        publish({ ready: true });
        fail(error);
      }
    })();
    return loading;
  }
  function update(change: (data: WorkspaceV2) => WorkspaceV2) {
    const data = change(state.data);
    if (data === state.data) return;
    publish({
      data: freezeOwned(structuredClone(data)),
      serial: state.serial + 1,
      status: !writable || state.status === 'conflict' ? state.status : 'unsaved',
    });
  }
  async function save(): Promise<void> {
    if (!state.ready || !writable || state.status === 'conflict') return;
    if (saving) return saving;
    saving = (async () => {
      while (committed !== state.serial) {
        const target = state.data;
        const serial = state.serial;
        try {
          const parsed = parseWorkspaceV2(target);
          if (!parsed.success)
            throw new StorageFailure(
              'invalid',
              parsed.diagnostics[0]?.message ?? 'Invalid workspace',
            );
          publish({ status: 'saving', error: '' });
          revision = await port.write(target, revision);
          committed = serial;
          publish({ status: committed === state.serial ? 'saved' : 'unsaved' });
        } catch (error) {
          fail(error);
          return;
        }
      }
    })();
    try {
      await saving;
    } finally {
      saving = undefined;
    }
  }
  async function retry(): Promise<void> {
    if (saving) await saving;
    try {
      const stored = await port.read();
      let data = state.data;
      if (stored !== undefined) {
        const parsed = parseWorkspaceV2Envelope(stored);
        if (!parsed.success)
          throw new StorageFailure('invalid', '저장 자료를 읽지 못해 기존 데이터를 유지했습니다.');
        if (!writable || parsed.value.revision !== revision)
          data = mergeWorkspacesV2(parsed.value.data, data, true);
        revision = parsed.value.revision;
      } else revision = null;
      writable = true;
      publish({ data: freezeOwned(data), serial: state.serial + 1, status: 'unsaved', error: '' });
      await save();
    } catch (error) {
      fail(error);
    }
  }
  return {
    view: () => state,
    load,
    update,
    save,
    retry,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    exportBundle: () => exportWorkspaceV2(state.data),
    importBundle: (text: string) => {
      const parsed = stageWorkspaceV2Bundle(text, state.data);
      if (parsed.success) update(() => parsed.value);
      return parsed;
    },
  };
}
