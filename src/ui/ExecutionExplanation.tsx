import { type ReactNode, useMemo, useState } from 'react';
import type { DiagramInspection, DiagramLinks } from '../application/diagram-links.ts';
import { EXPLANATION_POLICY, explainExecution } from '../application/execution-explanation.ts';
import type { EngineView, EventTrace } from '../domain/protocol-model.ts';
import { useDiagramPanel } from './useDiagramPanel.ts';

function Pages<T>({
  items,
  label,
  children,
}: {
  items: readonly T[];
  label: string;
  children: (item: T, index: number) => ReactNode;
}) {
  const [page, setPage] = useState(0);
  const count = Math.max(1, Math.ceil(items.length / EXPLANATION_POLICY.pageSize));
  const current = Math.min(page, count - 1);
  return (
    <section aria-label={label}>
      {items
        .slice(current * EXPLANATION_POLICY.pageSize, (current + 1) * EXPLANATION_POLICY.pageSize)
        .map((item, index) => children(item, current * EXPLANATION_POLICY.pageSize + index))}
      {count > 1 && (
        <nav className='sequence-controls' aria-label={`${label} 페이지`}>
          <button type='button' disabled={current === 0} onClick={() => setPage(current - 1)}>
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

function ExplanationContent({
  run,
  links,
  transition,
}: {
  run: EngineView;
  links: DiagramLinks;
  transition: EventTrace;
}) {
  const explanation = useMemo(
    () => explainExecution(run, links, transition.eventId),
    [run, links, transition.eventId],
  );
  const [candidateId, setCandidateId] = useState<string>();
  const candidate =
    explanation.candidates.find((item) => item.id === candidateId) ??
    explanation.candidates.find((item) => item.selected) ??
    explanation.candidates[0];
  const status = {
    verified: '기록과 일치',
    limited: '일부 설명',
    inconsistent: '기록 불일치',
    unavailable: '설명 불가',
  }[explanation.status];
  return (
    <section aria-label='선택 실행의 설명' data-explanation-status={explanation.status}>
      <h3>
        {explanation.participant} · 규칙 {explanation.ruleId.slice(0, 100)} · {transition.eventId}
      </h3>
      <p className={`explanation-status explanation-${explanation.status}`} role='status'>
        <strong>{status}</strong> · {explanation.message}
      </p>
      <p>
        출발 상태 {explanation.beforeState.slice(0, 100)} → 도착 상태{' '}
        {explanation.afterState.slice(0, 100)} · 발생 이벤트 {explanation.triggerId} (
        {explanation.triggerLabel}) · {explanation.ignored ? '명시적 무시' : '상태 전이'}
      </p>
      <p className='hint'>
        실행 당시 정의와 전이 전 값으로 조건을 재구성합니다. 현재 초안이나 현재 참여자 값은 사용하지
        않습니다. 아래 대입 계산은 실제 전이의 최종 값과 대조하며, 동작별 중간 값은 저장된
        snapshot의 선언형 계산으로 복원한 값입니다.
      </p>
      <h4>규칙 선택 근거</h4>
      <p>
        같은 출발 상태·발생 이벤트의 후보 {explanation.candidates.length}개를 계산했습니다. 후보의
        조건은 모두 대입 전 변수로 평가합니다.
      </p>
      <Pages items={explanation.candidates} label='규칙 후보'>
        {(item) => (
          <button
            key={item.id}
            type='button'
            className='explanation-candidate'
            aria-pressed={item.id === candidate?.id}
            onClick={() => setCandidateId(item.id)}
          >
            후보 {item.id.slice(0, 100)} · {item.result ? '참' : '거짓'}
            {item.selected ? ' · 기록된 선택' : ''}
          </button>
        )}
      </Pages>
      {candidate && (
        <section aria-label='후보 조건 계산'>
          <h4>
            후보 {candidate.id.slice(0, 100)} · {candidate.result ? '참' : '거짓'}
          </h4>
          <Pages key={candidate.id} items={candidate.conditions} label='조건 계산'>
            {(item) => (
              <p className='explanation-row' key={item.path}>
                <strong>
                  {item.path} ·{' '}
                  {item.result === 'true' ? '참' : item.result === 'false' ? '거짓' : '평가 생략'}
                </strong>
                <span>{item.detail}</span>
              </p>
            )}
          </Pages>
        </section>
      )}
      <h4>동작 순서대로 계산한 대입</h4>
      <p className='hint'>
        전체 동작 {explanation.actionCount}개 중 대입을 표시합니다. 각 식은 앞선 대입까지 반영한
        임시 변수 값을 읽습니다. 송신·상위 전달·타이머·종료 동작은 변수를 직접 대입하지 않습니다.
      </p>
      <Pages items={explanation.assignments} label='대입 계산'>
        {(item) => (
          <div
            className='explanation-row'
            key={item.actionIndex}
            data-explained-assignment={item.actionIndex}
          >
            <strong>
              동작 {item.actionIndex + 1} · 변수 {item.variableId.slice(0, 100)}
            </strong>
            <span>대입 전 값: {item.before}</span>
            <span>계산식: {item.expression}</span>
            <span>대입 계산 결과: {item.value}</span>
          </div>
        )}
      </Pages>
      {!explanation.assignments.length && (
        <p>
          {explanation.status === 'verified'
            ? '이 규칙에는 변수 대입이 없습니다.'
            : '확인한 대입 계산이 없습니다.'}
        </p>
      )}
      <h4>기록의 최종 변수 변경</h4>
      <Pages items={explanation.changes} label='변수 변경'>
        {(item) => (
          <div className='explanation-row' key={item.id} data-explained-variable={item.id}>
            <strong>변수 {item.id.slice(0, 100)}</strong>
            <span>전이 전: {item.before}</span>
            <span>전이 후: {item.after}</span>
            <span>
              관련 대입 동작: {item.assignments.map((index) => index + 1).join(', ') || '없음'}
            </span>
          </div>
        )}
      </Pages>
      {!explanation.changes.length && explanation.status === 'verified' && (
        <p>
          최종 변수 값은 바뀌지 않았습니다. 같은 값 대입과 중간 값의 변경은 위 동작 순서에서
          확인하세요.
        </p>
      )}
      {explanation.status !== 'verified' && (
        <p>
          이 설명을 적용 완료의 증거로 사용하지 마세요. 기록의 전후 값은 연결된 상태도 회차와 원본
          이벤트에서 확인할 수 있습니다.
        </p>
      )}
    </section>
  );
}

/** Explain only observed transitions of the current shared selection, computing on explicit expansion. */
export function ExecutionExplanation({
  run,
  links,
  inspection,
  onSelect,
  context,
  revealRequest = 0,
}: {
  run: EngineView;
  links: DiagramLinks | undefined;
  inspection: DiagramInspection | undefined;
  onSelect: (id: string) => void;
  context: string;
  revealRequest?: number;
}) {
  const panel = useDiagramPanel(revealRequest);
  const transition = inspection?.focusedTransition;
  return (
    <details
      className='execution-explanation'
      ref={panel.ref}
      open={panel.expanded}
      onToggle={(event) => panel.onToggle(event.currentTarget.open)}
    >
      <summary>실행 이유 설명</summary>
      {panel.expanded && (
        <div key={context}>
          {!inspection ? (
            <p>시퀀스·이벤트 기록이나 실행 상태도에서 설명할 이벤트 또는 회차를 선택하세요.</p>
          ) : !transition || !links ? (
            <>
              <p>
                이 관찰 위치에 하나의 상태 전이 회차가 선택되지 않았습니다. 여러 전이가 연결되면
                회차를 고르세요. 전이 기록이 없는 송신·오류에서는 변수 적용 완료를 추정하지
                않습니다.
              </p>
              <Pages items={inspection.transitions} label='설명할 실행 회차'>
                {(item) => (
                  <button type='button' key={item.eventId} onClick={() => onSelect(item.eventId)}>
                    설명할 회차 {item.eventId} · {item.participant} · {item.ruleId?.slice(0, 100)}
                  </button>
                )}
              </Pages>
            </>
          ) : (
            <ExplanationContent
              key={transition.eventId}
              run={run}
              links={links}
              transition={transition}
            />
          )}
        </div>
      )}
    </details>
  );
}
