import { snapshotCompatibility } from '../domain/workspace-validation.ts';
import type { SavedRun } from '../domain/workspace-model.ts';

/** Keep saved-record navigation and explicit snapshot execution separate from live-run controls. */
export function HistoryPanel({
  records,
  selectedId,
  position,
  playing,
  onSelect,
  onPosition,
  onPlay,
  onRerun,
  onRestore,
  onDelete,
  onLive,
}: {
  records: readonly SavedRun[];
  selectedId: string | undefined;
  position: number;
  playing: boolean;
  onSelect: (record: SavedRun) => void;
  onPosition: (position: number) => void;
  onPlay: () => void;
  onRerun: (record: SavedRun) => void;
  onRestore: (record: SavedRun) => void;
  onDelete: (id: string) => void;
  onLive: () => void;
}) {
  const record = records.find((item) => item.id === selectedId);
  const unsupported = record && snapshotCompatibility(record.view.snapshot);
  return (
    <section className='history-panel' aria-label='저장된 실행 기록'>
      <h2>실행 기록 · {records.length}개</h2>
      <label className='control'>
        <span>과거 실행 선택</span>
        <select
          value={selectedId ?? ''}
          onChange={(event) => {
            const found = records.find((item) => item.id === event.target.value);
            if (found) onSelect(found);
            else onLive();
          }}
        >
          <option value=''>현재 실행 보기</option>
          {[...records].reverse().map((item) => (
            <option key={item.id} value={item.id}>
              {item.view.snapshot.configuration.label} · {new Date(item.createdAt).toLocaleString()}{' '}
              · {item.id.slice(-8)} · {item.view.status}
            </option>
          ))}
        </select>
      </label>
      {record && (
        <>
          <p>
            과거 기록 · 원본 초안 v{record.draftVersion} · 엔진 {record.view.snapshot.engineVersion}{' '}
            · 읽기 전용
          </p>
          <p className='hint'>
            상태는 선택 위치까지의 전이 기록 기준입니다. 현재 실행의 상태·큐는 변경하지 않습니다.
          </p>
          <label className='control'>
            <span>
              기록 재생 위치 · {position}/{record.view.events.length + 1}
            </span>
            <input
              type='range'
              aria-label='기록 재생 위치'
              min={0}
              max={record.view.events.length + 1}
              value={position}
              onChange={(event) => onPosition(Number(event.target.value))}
            />
          </label>
          <div className='run-toolbar'>
            <button type='button' onClick={() => onPosition(0)}>
              기록 처음
            </button>
            <button
              type='button'
              disabled={position === 0}
              onClick={() => onPosition(position - 1)}
            >
              이전 이벤트
            </button>
            <button
              type='button'
              disabled={position >= record.view.events.length + 1}
              onClick={() => onPosition(position + 1)}
            >
              다음 이벤트
            </button>
            <button type='button' onClick={onPlay}>
              {playing ? '기록 재생 정지' : '기록 자동 재생'}
            </button>
            <button type='button' onClick={() => onPosition(record.view.events.length + 1)}>
              저장 시점
            </button>
          </div>
          <div className='run-toolbar'>
            <button type='button' disabled={!!unsupported} onClick={() => onRerun(record)}>
              이 snapshot으로 재실행
            </button>
            <button type='button' onClick={() => onRestore(record)}>
              이 설정을 새 초안으로
            </button>
            <button type='button' onClick={onLive}>
              현재 실행 보기
            </button>
            <button type='button' className='danger' onClick={() => onDelete(record.id)}>
              이 기록 삭제
            </button>
          </div>
          {unsupported && <p role='status'>{unsupported}</p>}
        </>
      )}
      {!records.length && (
        <p className='hint'>실행 시작·단계·정지·종료의 snapshot과 체크포인트를 보존합니다.</p>
      )}
    </section>
  );
}
