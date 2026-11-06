import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createLegacyWorkspaceFacade } from '../application/legacy-workspace-facade.ts';
import { createWorkspace } from '../application/workspace-operations.ts';
import { createWorkspaceV2Controller } from '../application/workspace-v2-controller.ts';
import {
  createWorkspaceV2,
  exportLegacyBackup,
  exportLegacyFromV2,
  stageWorkspaceV2Bundle,
} from '../application/workspace-v2-operations.ts';
import { createExampleCopy } from '../examples/catalog.ts';
import { createWorkerStorage } from '../persistence/worker-storage.ts';
import { App } from './App.tsx';
import { StackWorkspace } from './StackWorkspace.tsx';
import { WorkspaceContext, type WorkspaceHost } from './useWorkspace.ts';

/** Share one v2 save queue across the legacy and stacked editors; preserve a checkpoint before switching. */
export function WorkspaceRoot() {
  const [port] = useState(() => createWorkerStorage());
  const [full] = useState(() =>
    createWorkspaceV2Controller(
      port,
      createWorkspaceV2(createWorkspace(createExampleCopy('ping_pong'))),
      port.validation,
    ),
  );
  const [state, setState] = useState(full.view);
  const [mode, setMode] = useState<'legacy' | 'stack'>(() => {
    try {
      return sessionStorage.getItem('protocol-studio-mode') === 'stack' ? 'stack' : 'legacy';
    } catch {
      return 'legacy';
    }
  });
  const [switching, setSwitching] = useState(false);
  const leave = useRef<(() => void | Promise<void>) | undefined>(undefined);
  const registerLeave = useCallback((callback: () => void | Promise<void>) => {
    leave.current = callback;
    return () => {
      if (leave.current === callback) leave.current = undefined;
    };
  }, []);
  useEffect(() => full.subscribe(() => setState(full.view())), [full]);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current);
    void full.load();
    return () => {
      closeTimer.current = setTimeout(() => port.close(), 0);
    };
  }, [full, port]);
  useEffect(() => {
    if (!state.ready || !state.serial) return;
    const handle = window.setTimeout(() => {
      void full.save();
    }, 300);
    return () => clearTimeout(handle);
  }, [full, state.ready, state.serial]);
  const host = useMemo<WorkspaceHost>(
    () => ({
      full,
      controller: createLegacyWorkspaceFacade(full),
      registerLeave,
      stageImport: (text) => stageWorkspaceV2Bundle(text, full.view().data),
      applyImport: (data) => full.update(() => data),
      exportBundle: full.exportBundle,
      exportLegacy: () => exportLegacyFromV2(full.view().data, true),
      exportBackup: async () => {
        const data = await port.readLegacyBackup();
        return data === undefined
          ? {
              success: false,
              diagnostics: [
                { path: '/', code: 'no-backup', message: '보관한 v1 원본이 없습니다.' },
              ],
            }
          : exportLegacyBackup(data);
      },
    }),
    [full, port, registerLeave],
  );
  async function changeMode(next: 'legacy' | 'stack') {
    if (next === mode || switching) return;
    setSwitching(true);
    try {
      await leave.current?.();
      await full.save();
      setMode(next);
      try {
        sessionStorage.setItem('protocol-studio-mode', next);
      } catch {
        /* Memory editing remains available. */
      }
    } finally {
      setSwitching(false);
    }
  }
  return (
    <WorkspaceContext value={host}>
      <a className='skip-link' href={mode === 'stack' ? '#stack-main' : '#main-content'}>
        본문으로 이동
      </a>
      <nav className='mode-switch' aria-label='실험 모드'>
        <button
          type='button'
          aria-pressed={mode === 'legacy'}
          disabled={!state.ready || switching}
          onClick={() => {
            void changeMode('legacy');
          }}
        >
          단일 계층
        </button>
        <button
          type='button'
          aria-pressed={mode === 'stack'}
          disabled={!state.ready || switching}
          onClick={() => {
            void changeMode('stack');
          }}
        >
          계층 연결 스택
        </button>
        <span className='mode-hint'>하나의 로컬 작업 공간 · 실제 서버/기기 연결 없음</span>
      </nav>
      {!state.ready && <p role='status'>로컬 작업 공간을 불러오는 중…</p>}
      {switching && <p role='status'>진행 중인 기록을 저장하고 작업 모드를 바꾸는 중…</p>}
      <div inert={switching || !state.ready} aria-busy={switching || !state.ready}>
        {mode === 'legacy' ? <App /> : <StackWorkspace state={state} host={host} />}
      </div>
    </WorkspaceContext>
  );
}
