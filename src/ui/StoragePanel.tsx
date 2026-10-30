import { useState } from 'react';
import { exportWorkspace } from '../application/workspace-operations.ts';
import type { SaveState } from '../application/workspace-controller.ts';
import { WORKSPACE_POLICY, type WorkspaceData } from '../domain/workspace-model.ts';

/** Make save success/failure visible and stage local files before applying imported data. */
export function StoragePanel({
  state,
  onSave,
  onRetry,
  onImport,
}: {
  state: SaveState;
  onSave: () => void;
  onRetry: () => void;
  onImport: (text: string) => Promise<string | undefined>;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  function download(data: WorkspaceData) {
    const exported = exportWorkspace(data);
    if (!exported.success) {
      setError(exported.diagnostics[0]?.message ?? '내보내기 실패');
      return;
    }
    const url = URL.createObjectURL(new Blob([exported.value], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'protocol-studio.bundle.json';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setError('');
  }
  const status = {
    loading: '저장소 읽는 중',
    saved: '브라우저에 저장됨',
    unsaved: '미저장 변경 있음',
    saving: '저장 중',
    error: '저장 실패 · 메모리 초안 유지',
    conflict: '다른 탭과 저장 충돌 · 메모리 초안 유지',
  }[state.status];
  return (
    <section className='storage-panel' aria-label='로컬 저장과 파일'>
      <p role='status' aria-live='polite'>
        {status}
      </p>
      <div className='storage-actions'>
        <button type='button' disabled={!state.ready || state.status === 'saving'} onClick={onSave}>
          지금 저장
        </button>
        <button type='button' onClick={() => download(state.data)}>
          내보내기
        </button>
        <label className='file-control'>
          bundle 가져오기
          <input
            type='file'
            aria-label='bundle 가져오기'
            accept='.json,application/json'
            disabled={busy}
            onChange={async (event) => {
              const input = event.currentTarget;
              const file = input.files?.[0];
              if (!file) return;
              setBusy(true);
              setError('');
              try {
                if (file.size > WORKSPACE_POLICY.maxBytes)
                  setError('파일이 64 MiB 한도를 넘습니다.');
                else setError((await onImport(await file.text())) ?? '');
              } catch {
                setError('파일을 읽지 못했습니다. 기존 작업을 유지했습니다.');
              } finally {
                setBusy(false);
                input.value = '';
              }
            }}
          />
        </label>
      </div>
      {state.error && (
        <div role='alert'>
          <p>{state.error}</p>
          <button type='button' onClick={onRetry}>
            저장 다시 시도
          </button>
          <p>메모리 초안과 기록은 유지됩니다. 내보내기로 파일을 보관할 수 있습니다.</p>
        </div>
      )}
      {error && <p role='alert'>{error}</p>}
      {busy && <p role='status'>파일 검증 중 · 기존 작업 유지</p>}
    </section>
  );
}
