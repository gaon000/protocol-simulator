import { useState } from 'react';
import type { DiagramInspection } from '../application/diagram-links.ts';
import { traceObject } from '../application/sequence-diagram.ts';
import { DataPreview } from './RunView.tsx';

/** Inspect bounded execution occurrences, including the exact observed before/after commit. */
export function DiagramLinkDetails({
  inspection,
  selected,
  onSelect,
  onSequence,
}: {
  inspection: DiagramInspection;
  selected: string | undefined;
  onSelect: (id: string) => void;
  onSequence: () => void;
}) {
  const [navigation, setNavigation] = useState<{ page: number; selected: string | undefined }>({
    page: 0,
    selected: undefined,
  });
  const pages = Math.max(1, Math.ceil(inspection.transitions.length / 20));
  const selectedIndex = inspection.transitions.findIndex((event) => event.eventId === selected);
  const currentPage =
    selected !== navigation.selected && selectedIndex >= 0
      ? Math.floor(selectedIndex / 20)
      : Math.min(navigation.page, pages - 1);
  const focused = inspection.focusedTransition;
  const data = traceObject(focused?.data);
  return (
    <section className='diagram-link-details' aria-label='연결된 실행 회차'>
      <h3>
        연결된 실행 · {inspection.participant} · {inspection.transitions.length}회
      </h3>
      <p className='hint'>
        현재 관찰 위치 안에서 실행된 회차만 표시합니다. 규칙/상태를 고르면 최근 회차를 선택합니다.
        다른 회차는 아래에서 고르세요. 현재 상태 표시는 cursor 기준이며 선택 전/후와 구분됩니다.
      </p>
      <button type='button' onClick={onSequence}>
        시퀀스에서 관련 기록 보기
      </button>
      {!inspection.transitions.length && (
        <p>
          {inspection.ruleIndex !== undefined
            ? '이 관찰 범위에 이 규칙의 상태 전이 기록이 없습니다. 정의/동작 선택은 실행 완료의 증거가 아닙니다.'
            : '이 관찰 범위에 연결된 상태 전이가 없습니다. 초기 상태나 아직 해석되지 않은 청크에서 전이를 추정하지 않습니다.'}
        </p>
      )}
      {inspection.transitions.length > 1 && !focused && (
        <p>여러 전이가 연결되어 있습니다. 한 회차를 골라 전후 상태를 확인하세요.</p>
      )}
      <div className='sequence-controls'>
        {inspection.transitions.slice(currentPage * 20, (currentPage + 1) * 20).map((event) => (
          <button
            key={event.eventId}
            type='button'
            data-linked-transition={event.eventId}
            aria-pressed={event.eventId === selected}
            onClick={() => onSelect(event.eventId)}
          >
            실행 회차 {event.eventId} · {event.timeMs} ms · {event.ruleId?.slice(0, 80)}
          </button>
        ))}
      </div>
      {pages > 1 && (
        <nav className='sequence-controls' aria-label='실행 회차 페이지'>
          <button
            type='button'
            disabled={!currentPage}
            onClick={() => setNavigation({ page: currentPage - 1, selected })}
          >
            회차 이전 페이지
          </button>
          <span>
            {currentPage + 1}/{pages} · 최대 20회
          </span>
          <button
            type='button'
            disabled={currentPage >= pages - 1}
            onClick={() => setNavigation({ page: currentPage + 1, selected })}
          >
            회차 다음 페이지
          </button>
        </nav>
      )}
      {focused && (
        <section aria-label='선택 회차의 전후 상태'>
          <h4>
            {focused.eventId} · {focused.timeMs} ms ·{' '}
            {data.ignored ? '명시적 무시' : String(data.outcome ?? '')}
          </h4>
          <div className='participant-grid'>
            <section aria-label='선택 전 상태와 변수'>
              <h4>선택 전</h4>
              <DataPreview value={data.before ?? null} />
            </section>
            <section aria-label='선택 후 상태와 변수'>
              <h4>선택 후</h4>
              <DataPreview value={data.after ?? null} />
            </section>
          </div>
        </section>
      )}
    </section>
  );
}
