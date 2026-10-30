import { useState } from 'react';
import type { JsonObject, JsonValue } from '../domain/execution-contract.ts';
import type { EventTrace } from '../domain/protocol-model.ts';
import type { EngineView } from '../engine/simulation.ts';
import { WireInspector } from './WireInspector.tsx';

const statusLabels = {
  idle: '실행 대기',
  running: '실행 중',
  paused: '일시 정지',
  completed: '관찰 완료',
  cancelled: '실행 취소',
  invalid: '정의 오류',
  'limit-reached': '실행 한도 도달',
  'engine-error': '엔진 오류',
} as const;

function eventLabel(event: EventTrace): string {
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return '';
  const data = event.data as JsonObject;
  if (data.message && typeof data.message === 'object' && !Array.isArray(data.message))
    return String((data.message as JsonObject).messageId ?? '');
  if (data.after && typeof data.after === 'object' && !Array.isArray(data.after))
    return String((data.after as JsonObject).stateId ?? '');
  return [data.operation ?? data.code ?? '', data.outcome ?? '', data.copy ?? '']
    .filter(Boolean)
    .join(' ');
}

/** Show real participant state, chronological trace and final expectations from a captured run. */
export function RunView({
  run,
  playing,
  selected,
  onSelect,
  historyLabel,
}: {
  run: EngineView | undefined;
  playing: boolean;
  selected: string | undefined;
  onSelect: (id: string) => void;
  historyLabel?: string | undefined;
}) {
  const [messagesOnly, setMessagesOnly] = useState(false);
  if (!run)
    return (
      <section className='empty-state'>
        <h2>편집한 실험을 실행하세요</h2>
        <p>전체 실행은 가상 시간을 진행하고, 한 단계는 큐의 이벤트 하나를 처리합니다.</p>
      </section>
    );
  const events = run.events.filter(
    (event) =>
      !messagesOnly ||
      ['send', 'parsed', 'deliver', 'diagnostic', 'environment'].includes(event.kind),
  );
  return (
    <>
      <p className='run-status' role='status'>
        {historyLabel ? (
          `${historyLabel} · 가상 시간 ${run.timeMs} ms`
        ) : (
          <>
            {playing ? '실행 중' : statusLabels[run.status]} · 가상 시간 {run.timeMs} ms · 처리
            이벤트 {run.processedEvents}
          </>
        )}
      </p>
      <div className='participant-grid'>
        {(['A', 'B'] as const).map((participant) => {
          const actor = run.participants[participant];
          return (
            <section
              key={participant}
              aria-label={`참여자 ${participant} 상태`}
              className='participant-card'
            >
              <h2>
                {participant} · {actor.stateId}
              </h2>
              <p>
                {actor.outcome} · 완료 시각 {actor.finishedAt ?? '—'}
              </p>
              {typeof actor.variables.initialSends === 'number' &&
                typeof actor.variables.retries === 'number' && (
                  <p>
                    최초 송신 {actor.variables.initialSends}회 · 재시도 {actor.variables.retries}회
                  </p>
                )}
              <pre>{JSON.stringify(actor.variables, null, 2)}</pre>
              <p>
                활성 타이머:{' '}
                {actor.timers
                  .filter((timer) => timer.active)
                  .map((timer) => `${timer.timerId} @${timer.due}ms`)
                  .join(', ') || '없음'}
              </p>
            </section>
          );
        })}
      </div>
      <section aria-label='시퀀스 기록'>
        <div className='section-heading'>
          <h2>시퀀스 · 이벤트 기록</h2>
          <label>
            <input
              type='checkbox'
              checked={messagesOnly}
              onChange={(event) => setMessagesOnly(event.target.checked)}
            />{' '}
            메시지 중심으로 보기
          </label>
        </div>
        <p className='hint'>
          송신(send) → 하위 수신(receive) → 해석(parsed) → 상위 전달(deliver)을 구분합니다. 최근
          200개를 표시합니다.
        </p>
        <div className='sequence-head'>
          <span>가상 시간</span>
          <span>A</span>
          <span>B</span>
        </div>
        <div className='trace-list'>
          {events.slice(-200).map((event) => (
            <button
              type='button'
              key={event.eventId}
              data-event-id={event.eventId}
              aria-pressed={selected === event.eventId}
              className={`trace-row actor-${event.participant}`}
              onClick={() => onSelect(event.eventId)}
            >
              <time>{event.timeMs} ms</time>
              <span className='trace-event'>
                <small>
                  {event.eventId} · {event.participant}
                  {event.kind === 'send' ? (event.participant === 'A' ? ' → B' : ' → A') : ''}
                </small>
                <strong>
                  {event.kind} {eventLabel(event)}
                </strong>
              </span>
            </button>
          ))}
        </div>
        {!events.length && <p>아직 기록이 없습니다.</p>}
      </section>
      <section className='results-panel' aria-label='기대 조건 결과'>
        <h2>기대 조건 결과</h2>
        {run.expectations.length ? (
          <ul>
            {run.expectations.map((item) => (
              <li key={item.expectationId} className={`result-${item.status}`}>
                <strong>
                  {item.expectationId} ·{' '}
                  {item.status === 'pass' ? '통과' : item.status === 'fail' ? '실패' : '미판정'}
                </strong>
                <span>{item.detail}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>
            {run.status === 'completed'
              ? '설정된 기대 조건이 없습니다.'
              : '관찰 종료 후 판정합니다.'}
          </p>
        )}
      </section>
    </>
  );
}

/** Inspect causal links and the exact event data from the immutable run rather than the draft. */
export function EventInspector({
  event,
  onCause,
  onRule,
}: {
  event: EventTrace | undefined;
  onCause: (id: string) => void;
  onRule: () => void;
}) {
  return (
    <section aria-label='이벤트 상세'>
      <h2>이벤트 상세</h2>
      {event ? (
        <>
          <p>
            {event.eventId} · {event.kind} · {event.timeMs} ms
          </p>
          {event.causeEventId && (
            <button type='button' onClick={() => onCause(event.causeEventId as string)}>
              원인 이벤트 {event.causeEventId}
            </button>
          )}
          {event.ruleId && (
            <button type='button' onClick={onRule}>
              규칙 {event.ruleId} 편집 위치
            </button>
          )}
          {event.data &&
            typeof event.data === 'object' &&
            !Array.isArray(event.data) &&
            Array.isArray((event.data as JsonObject).sourceEventIds) && (
              <div className='source-links'>
                <p>이 청크에 합쳐진 송신</p>
                {((event.data as JsonObject).sourceEventIds as readonly string[]).map((id) => (
                  <button key={id} type='button' onClick={() => onCause(id)}>
                    송신 이벤트 {id}
                  </button>
                ))}
              </div>
            )}
          <WireInspector data={event.data} />
          <pre>{formatData(event.data)}</pre>
        </>
      ) : (
        <p>기록을 선택하면 메시지·바이트·규칙·상태 변화를 확인할 수 있습니다.</p>
      )}
    </section>
  );
}

function formatData(value: JsonValue): string {
  return JSON.stringify(value, null, 2);
}
