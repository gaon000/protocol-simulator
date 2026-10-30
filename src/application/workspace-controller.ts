import { freezeOwned as freeze } from '../domain/immutable-data.ts';
import { parseWorkspaceEnvelope } from '../domain/workspace-validation.ts';
import { WORKSPACE_POLICY, type WorkspaceData } from '../domain/workspace-model.ts';
import { StorageFailure, type StoragePort } from '../persistence/indexed-db.ts';
import { mergeWorkspaces } from './workspace-operations.ts';

export type SaveState = {
  readonly data: WorkspaceData;
  readonly ready: boolean;
  readonly status: 'loading' | 'saved' | 'unsaved' | 'saving' | 'error' | 'conflict';
  readonly error: string;
  readonly serial: number;
};

/** Coordinate immutable memory state, debounced clients and serialized revision-checked saves. */
export function createWorkspaceController(port: StoragePort, initial: WorkspaceData) {
  let state: SaveState = {
    data: freeze(initial),
    ready: false,
    status: 'loading',
    error: '',
    serial: 0,
  };
  let revision: number | null = null;
  let writable = false;
  let loading: Promise<void> | undefined;
  let saving: Promise<void> | undefined;
  let committedSerial = -1;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<SaveState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const failure = (error: unknown) =>
    publish({
      status: error instanceof StorageFailure && error.code === 'conflict' ? 'conflict' : 'error',
      error: error instanceof Error ? error.message : '브라우저 저장에 실패했습니다.',
    });
  async function load() {
    if (loading) return loading;
    loading = (async () => {
      try {
        const stored = await port.read();
        if (stored === undefined) {
          writable = true;
          publish({ ready: true, status: 'unsaved', serial: 1 });
        } else {
          const valid = parseWorkspaceEnvelope(stored);
          if (!valid.success)
            throw new StorageFailure(
              'invalid',
              `저장된 데이터를 읽지 못했습니다: ${valid.diagnostics[0]?.code ?? 'invalid'}`,
            );
          revision = valid.value.revision;
          writable = true;
          committedSerial = 0;
          publish({ data: freeze(valid.value.data), ready: true, status: 'saved' });
        }
      } catch (error) {
        publish({ ready: true });
        failure(error);
      }
    })();
    return loading;
  }
  function update(change: (data: WorkspaceData) => WorkspaceData) {
    const next = change(state.data);
    if (next === state.data) return;
    publish({
      data: freeze(next),
      serial: state.serial + 1,
      status: state.status === 'conflict' || !writable ? state.status : 'unsaved',
    });
  }
  async function save(): Promise<void> {
    if (!state.ready || !writable || state.status === 'conflict') return;
    if (saving) return saving;
    saving = (async () => {
      while (committedSerial !== state.serial) {
        const target = state.data;
        const serial = state.serial;
        try {
          if (
            target.drafts.length > WORKSPACE_POLICY.maxDrafts ||
            target.runs.length > WORKSPACE_POLICY.maxRuns ||
            new TextEncoder().encode(JSON.stringify(target)).length > WORKSPACE_POLICY.maxBytes
          )
            throw new StorageFailure(
              'quota',
              '작업 공간 한도를 넘었습니다. 내보내기 후 불필요한 기록을 삭제하세요.',
            );
          publish({ status: 'saving', error: '' });
          revision = await port.write(target, revision);
          committedSerial = serial;
          publish({ status: committedSerial === state.serial ? 'saved' : 'unsaved' });
        } catch (error) {
          failure(error);
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
  async function retry() {
    if (saving) await saving;
    try {
      const stored = await port.read();
      let data = state.data;
      if (stored !== undefined) {
        const valid = parseWorkspaceEnvelope(stored);
        if (!valid.success)
          throw new StorageFailure(
            'invalid',
            '저장된 형식을 읽지 못해 기존 데이터를 유지했습니다.',
          );
        if (!writable || valid.value.revision !== revision)
          data = mergeWorkspaces(valid.value.data, state.data, true);
        revision = valid.value.revision;
      } else revision = null;
      writable = true;
      publish({ data: freeze(data), serial: state.serial + 1, status: 'unsaved', error: '' });
      await save();
    } catch (error) {
      failure(error);
    }
  }
  return {
    view: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    update,
    save,
    retry,
  };
}
