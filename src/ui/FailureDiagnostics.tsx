import { useMemo, useState } from 'react';
import type { DiagramLinks } from '../application/diagram-links.ts';
import {
  DIAGNOSIS_POLICY,
  diagnoseExpectation,
  diagnosisEventLabel,
  diagnosisTrail,
} from '../application/failure-diagnostics.ts';
import type { EngineView, EventTrace } from '../domain/protocol-model.ts';
import { useDiagramPanel } from './useDiagramPanel.ts';

const verdicts = { pass: '통과', fail: '실패', undetermined: '미판정' };
const statuses = {
  verified: '판정과 일치',
  incomplete: '관찰 미완료·오류',
  limited: '일부 진단',
  inconsistent: '기록 불일치',
  unavailable: '진단 불가',
};
function Evidence({
  events,
  label,
  links,
  onTrail,
  onInspect,
}: {
  events: readonly EventTrace[];
  label: string;
  links: DiagramLinks | undefined;
  onTrail: (id: string) => void;
  onInspect: (id: string, explain: boolean) => void;
}) {
  const [page, setPage] = useState(0);
  const count = Math.max(1, Math.ceil(events.length / DIAGNOSIS_POLICY.pageSize));
  const current = Math.min(page, count - 1);
  return (
    <section aria-label={label}>
      <h4>
        {label} · {events.length}개
      </h4>
      {!events.length && (
        <p>이 구간에 해당 기록이 없습니다. 부재 자체를 특정 장애의 증거로 단정하지 않습니다.</p>
      )}
      {events.slice(current * 20, (current + 1) * 20).map((event) => {
        const transitions = links?.transitionsByEvent.get(event.eventId) ?? [];
        const transition = transitions.length === 1 ? transitions[0] : undefined;
        return (
          <div
            key={event.eventId}
            className='diagnosis-evidence'
            data-diagnosis-event={event.eventId}
          >
            <p>{diagnosisEventLabel(event)}</p>
            <div className='sequence-controls'>
              <button type='button' onClick={() => onTrail(event.eventId)}>
                연결 근거 {event.eventId}
              </button>
              <button type='button' onClick={() => onInspect(event.eventId, false)}>
                기록 보기 {event.eventId}
              </button>
              {transition && (
                <button type='button' onClick={() => onInspect(transition.eventId, true)}>
                  실행 설명 보기 {transition.eventId}
                </button>
              )}
            </div>
          </div>
        );
      })}
      {count > 1 && (
        <nav className='sequence-controls' aria-label={`${label} 페이지`}>
          <button type='button' disabled={!current} onClick={() => setPage(current - 1)}>
            {label} 이전
          </button>
          <span>
            {current + 1}/{count} · 최대 20개
          </span>
          <button
            type='button'
            disabled={current + 1 >= count}
            onClick={() => setPage(current + 1)}
          >
            {label} 다음
          </button>
        </nav>
      )}
    </section>
  );
}

function DiagnosisContent({
  run,
  links,
  onInspect,
  selectedId,
  onSelect,
  eventCount,
}: {
  run: EngineView;
  links: DiagramLinks | undefined;
  onInspect: (id: string, explain: boolean) => void;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  eventCount: number;
}) {
  const [trailId, setTrailId] = useState<string>();
  const [trailPage, setTrailPage] = useState(0);
  const id =
    run.expectations.find((item) => item.expectationId === selectedId)?.expectationId ??
    run.expectations.find((item) => item.status === 'fail')?.expectationId ??
    run.expectations[0]?.expectationId;
  const diagnosis = useMemo(
    () => (id ? diagnoseExpectation(run, id, eventCount) : undefined),
    [run, id, eventCount],
  );
  const trail = useMemo(
    () => (trailId ? diagnosisTrail(run, trailId, eventCount) : undefined),
    [run, trailId, eventCount],
  );
  const pageCount = Math.max(1, Math.ceil((trail?.items.length ?? 0) / 20));
  const current = Math.min(trailPage, pageCount - 1);
  function selectTrail(value: string) {
    setTrailId(value);
    setTrailPage(0);
  }
  return (
    <>
      <p className='hint'>
        실행 당시 정의와 현재 관찰 구간만 사용합니다. 직접 원인·타이머 수명과 참고 관찰을 구분하며,
        메시지 부재만으로 손실이나 유일한 원인을 추정하지 않습니다.
      </p>
      {id ? (
        <>
          <label>
            <span>진단할 기대 조건</span>
            <select
              value={id}
              onChange={(event) => {
                onSelect(event.target.value);
                setTrailId(undefined);
              }}
            >
              {run.expectations.map((item) => (
                <option key={item.expectationId} value={item.expectationId}>
                  {item.expectationId.slice(0, 120)} · {verdicts[item.status]}
                </option>
              ))}
            </select>
          </label>
          {diagnosis && (
            <section aria-label='선택 기대 조건 진단' data-diagnosis-status={diagnosis.status}>
              <h3>
                {id.slice(0, 160)} · {verdicts[diagnosis.recorded]}
              </h3>
              <p role='status'>
                <strong>{statuses[diagnosis.status]}</strong> · {diagnosis.message}
              </p>
              <dl className='diagnosis-values'>
                <dt>기대값</dt>
                <dd>{diagnosis.expected || '확인 불가'}</dd>
                <dt>관찰값</dt>
                <dd>{diagnosis.actual || '확인 불가'}</dd>
              </dl>
              <Evidence
                key={`evidence-${id}`}
                events={diagnosis.evidence}
                label='판정 근거'
                links={links}
                onTrail={selectTrail}
                onInspect={onInspect}
              />
              <p className='hint'>
                참고 관찰은 같은 실행의 환경 이벤트와 이 참여자의 타이머 만료·연결·오류·최근
                전이입니다. 기대 조건 실패의 확정 원인 사슬이 아닙니다.
              </p>
              <Evidence
                key={`context-${id}`}
                events={diagnosis.context}
                label='참고 관찰'
                links={links}
                onTrail={selectTrail}
                onInspect={onInspect}
              />
            </section>
          )}
        </>
      ) : (
        <p>진단할 기대 조건이 없습니다.</p>
      )}
      {trail && (
        <section aria-label='선택 근거의 연결 기록'>
          <h3>연결 기록 · {trailId}</h3>
          <p>
            원본 cause·합쳐진 송신 참조와 같은 참여자/타이머/세대의 시작을 따라갑니다. 타이머 만료와
            메시지 손실 사이의 직접 인과관계는 기록되어 있지 않습니다.
          </p>
          {trail.items.slice(current * 20, (current + 1) * 20).map(({ event, relation }) => (
            <div className='diagnosis-evidence' key={event.eventId}>
              <p>
                {relation} · {diagnosisEventLabel(event)}
              </p>
              <button type='button' onClick={() => onInspect(event.eventId, false)}>
                연결 기록 보기 {event.eventId}
              </button>
            </div>
          ))}
          {(trail.missing || trail.limited) && (
            <p role='status'>
              {trail.missing ? '현재 구간에 없는 참조가 있습니다. ' : ''}
              {trail.limited ? '최대 64개의 연결 기록만 확인했습니다.' : ''}
            </p>
          )}
          {pageCount > 1 && (
            <nav className='sequence-controls' aria-label='연결 기록 페이지'>
              <button type='button' disabled={!current} onClick={() => setTrailPage(current - 1)}>
                연결 기록 이전
              </button>
              <span>
                {current + 1}/{pageCount} · 최대 20개
              </span>
              <button
                type='button'
                disabled={current + 1 >= pageCount}
                onClick={() => setTrailPage(current + 1)}
              >
                연결 기록 다음
              </button>
            </nav>
          )}
        </section>
      )}
    </>
  );
}

/** Inspect failed or undetermined expectations without changing the authoritative run or verdict. */
export function FailureDiagnostics({
  run,
  links,
  onInspect,
  selectedId,
  onSelect,
  revealRequest,
  eventCount,
}: {
  run: EngineView;
  links: DiagramLinks | undefined;
  onInspect: (id: string, explain: boolean) => void;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  revealRequest: number;
  eventCount: number;
}) {
  const panel = useDiagramPanel(revealRequest);
  return (
    <details
      ref={panel.ref}
      className='failure-diagnostics'
      open={panel.expanded}
      onToggle={(event) => panel.onToggle(event.currentTarget.open)}
    >
      <summary>실패 진단과 관련 기록</summary>
      {panel.expanded && (
        <DiagnosisContent
          eventCount={eventCount}
          run={run}
          links={links}
          onInspect={onInspect}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      )}
    </details>
  );
}
