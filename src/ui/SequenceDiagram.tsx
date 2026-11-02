import { useEffect, useMemo, useRef, useState } from 'react';
import type { DiagramInspection } from '../application/diagram-links.ts';
import {
  buildSequenceModel,
  SEQUENCE_PAGE_SIZE,
  type SequenceModel,
  type SequenceRow,
  sequenceProtocol,
  traceMessage,
} from '../application/sequence-diagram.ts';
import type { EngineView, EventTrace } from '../domain/protocol-model.ts';
import { EventInspector } from './RunView.tsx';
import { useDiagramPanel } from './useDiagramPanel.ts';

function ArrowRow({
  row,
  selected,
  onSelect,
  related,
}: {
  row: SequenceRow;
  selected: boolean;
  onSelect: () => void;
  related: boolean;
}) {
  const { event, shape } = row;
  const sender = shape === 'receive' ? (event.participant === 'A' ? 'B' : 'A') : event.participant;
  const start = sender === 'A' ? 100 : 600;
  const end = shape === 'receive' ? (sender === 'A' ? 600 : 100) : 350;
  const direction = end > start ? 1 : -1;
  return (
    <button
      type='button'
      className={`sequence-row sequence-${shape} ${related ? 'is-related' : ''}`}
      data-sequence-id={event.eventId}
      aria-pressed={selected}
      aria-label={`통신 시퀀스 ${event.eventId}: ${row.label} · ${row.note}${related ? ' · 상태도 관련' : ''}`}
      onClick={onSelect}
    >
      <span className='sequence-time'>
        {event.timeMs} ms
        <small>
          {event.eventId} · #{event.sequence}
          {related ? ' · 관련' : ''}
        </small>
      </span>
      <svg viewBox='0 0 700 90' aria-hidden='true'>
        <title>{row.label}</title>
        <path className='sequence-lifeline' d='M100 0V90 M600 0V90' />
        <rect className='sequence-label' x='168' y='5' width='364' height='42' rx='6' />
        <text x='350' y='22' textAnchor='middle'>
          {row.label.slice(0, 43)}
        </text>
        <text className='sequence-note' x='350' y='39' textAnchor='middle'>
          {row.note.slice(0, 46) || `${event.participant} 내부 이벤트`}
        </text>
        {shape === 'local' ? (
          <>
            <path
              className='sequence-arrow'
              d={`M${start} 53h${sender === 'A' ? 32 : -32}v24H${start}`}
            />
            <circle cx={start} cy='77' r='4' className='sequence-dot' />
          </>
        ) : (
          <>
            <path className='sequence-arrow' d={`M${start} 65H${end}`} />
            {shape === 'blocked' ? (
              <path className='sequence-cross' d='M343 58l14 14 M343 72l14-14' />
            ) : (
              <path
                className='sequence-arrow'
                d={`M${end - direction * 9} 59l${direction * 9} 6l${-direction * 9} 6`}
              />
            )}
          </>
        )}
      </svg>
    </button>
  );
}

function MessageFields({
  run,
  event,
  caption,
}: {
  run: EngineView;
  event: EventTrace;
  caption: string;
}) {
  const message = traceMessage(event);
  if (!message) return null;
  const definition = sequenceProtocol(run, event.participant)?.messages.find(
    (item) => item.id === message.messageId,
  );
  const entries = Object.entries(message.values);
  return (
    <div className='sequence-fields'>
      <table>
        <caption>
          {caption} · {message.messageId} · {entries.length}개 필드
        </caption>
        <thead>
          <tr>
            <th>필드 ID</th>
            <th>wire 이름</th>
            <th>실제 값</th>
          </tr>
        </thead>
        <tbody>
          {entries.slice(0, 32).map(([id, value]) => (
            <tr key={id}>
              <th scope='row'>{id.slice(0, 100)}</th>
              <td>
                {definition?.fields.find((field) => field.id === id)?.name.slice(0, 100) ?? '—'}
              </td>
              <td>
                {String(value).slice(0, 240)}
                {String(value).length > 240 ? '…' : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className='hint'>
        최대 32개 필드·값 240자 미리보기. 전체 값은 내보낸 bundle에 보존됩니다.
      </p>
    </div>
  );
}

function Relations({
  model,
  row,
  onSelect,
}: {
  model: SequenceModel;
  row: SequenceRow;
  onSelect: (id: string) => void;
}) {
  const [offset, setOffset] = useState(0);
  const relations = [
    ...row.sources.map((id) => ({ id, type: '원인·합쳐진 송신' })),
    ...(model.effects.get(row.event.eventId) ?? []).map((id) => ({ id, type: '직접 후속' })),
  ];
  const page = Math.min(offset, Math.max(0, Math.ceil(relations.length / 20) - 1));
  return (
    <section aria-label='시퀀스 인과관계'>
      <h3>원인과 직접 후속 · {relations.length}개</h3>
      <div className='sequence-controls'>
        {relations.slice(page * 20, (page + 1) * 20).map(({ id, type }) => (
          <button type='button' key={`${type}-${id}`} onClick={() => onSelect(id)}>
            {type} {id} · {model.byId.get(id)?.label}
          </button>
        ))}
      </div>
      {relations.length > 20 && (
        <div className='sequence-controls'>
          <button type='button' disabled={!page} onClick={() => setOffset(page - 1)}>
            관계 이전 페이지
          </button>
          <span>
            {page + 1}/{Math.ceil(relations.length / 20)}
          </span>
          <button
            type='button'
            disabled={(page + 1) * 20 >= relations.length}
            onClick={() => setOffset(page + 1)}
          >
            관계 다음 페이지
          </button>
        </div>
      )}
      {!relations.length && <p>이 관찰 범위에 연결된 기록이 없습니다.</p>}
    </section>
  );
}

function SequenceContent({
  run,
  eventCount,
  selected,
  onSelect,
  onRule,
  inspection,
  onState,
  revealRequest,
}: Props) {
  const model = useMemo(
    () => buildSequenceModel({ events: run.events }, eventCount),
    [run.events, eventCount],
  );
  const [all, setAll] = useState(false);
  const [relatedFilter, setRelatedFilter] = useState({
    value: revealRequest > 0,
    request: revealRequest,
  });
  const relatedOnly =
    !!inspection &&
    (relatedFilter.request === revealRequest ? relatedFilter.value : revealRequest > 0);
  const [navigation, setNavigation] = useState<{
    page: number | 'latest';
    selected: string | undefined;
    linkKey: string | undefined;
  }>({ page: 'latest', selected, linkKey: undefined });
  const firstRequest = useRef(revealRequest);
  const [detailOpen, setDetailOpen] = useState(revealRequest > 0);
  const showDetail = detailOpen || firstRequest.current !== revealRequest;
  function navigate(page: number | 'latest', resetAnchor = false) {
    setNavigation({
      page,
      selected: resetAnchor ? undefined : selected,
      linkKey: resetAnchor ? undefined : inspection?.key,
    });
  }
  const canvas = useRef<HTMLDivElement>(null);
  const detail = useRef<HTMLDivElement>(null);
  const rows = useMemo(
    () =>
      model.rows.filter(
        (row) =>
          (all || row.communication || row.event.eventId === selected) &&
          (!relatedOnly || inspection?.relatedEventIds.has(row.event.eventId)),
      ),
    [model, all, selected, relatedOnly, inspection],
  );
  const count = Math.max(1, Math.ceil(rows.length / SEQUENCE_PAGE_SIZE));
  const selectedIndex = rows.findIndex((row) => row.event.eventId === selected);
  const page =
    (navigation.selected !== selected || navigation.linkKey !== inspection?.key) &&
    selectedIndex >= 0
      ? Math.floor(selectedIndex / SEQUENCE_PAGE_SIZE)
      : navigation.page === 'latest'
        ? count - 1
        : Math.min(navigation.page, count - 1);
  const row = selected ? model.byId.get(selected) : undefined;
  const pick = (id: string) => {
    setDetailOpen(true);
    onSelect(id);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: Scroll geometry changes with selection and pagination after the DOM commits.
  useEffect(() => {
    const container = canvas.current;
    const element = container?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!container || !element) return;
    const top =
      element.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop;
    if (
      top < container.scrollTop + 60 ||
      top + element.offsetHeight > container.scrollTop + container.clientHeight
    )
      container.scrollTop = Math.max(0, top - 70);
  }, [selected, page]);
  const parsed = row
    ? (model.effects.get(row.event.eventId) ?? [])
        .map((id) => model.byId.get(id)?.event)
        .filter((event): event is EventTrace => event?.kind === 'parsed')
    : [];
  const origin = row?.sources
    .map((id) => model.byId.get(id)?.event)
    .find((event) => event?.kind === 'send');
  return (
    <section className='communication-sequence' aria-label='통신 시퀀스 다이어그램'>
      <p className='hint'>
        실행 당시 snapshot · {run.runId} · 관찰 기록 {model.rows.length}개. 위에서 아래로 가상
        시각·기록 순서이며 행 간격은 시간 비율이 아닙니다.
      </p>
      <p className='hint'>
        반쪽 화살표: 송신 · 전체 화살표: 실제 하위 수신 · ×: 손실/연결 차단 · 꺾인 선: 참여자 내부.
        해석과 상위 전달은 별도 이벤트입니다. 재전송 후보는 타이머 만료 뒤 동일 값 반복 송신에서
        추정합니다.
      </p>
      <nav className='sequence-controls' aria-label='시퀀스 페이지 이동'>
        <label>
          <input
            type='checkbox'
            disabled={!inspection}
            checked={relatedOnly}
            onChange={(event) => {
              setRelatedFilter({ value: event.target.checked, request: revealRequest });
              navigate('latest', true);
            }}
          />
          연결된 기록만 보기
        </label>
        {inspection && (
          <>
            <span>
              상태도 연결 · {inspection.participant} · 관련 {inspection.relatedEventIds.size}개 기록
              / {inspection.transitions.length}회 전이
            </span>
            <button type='button' onClick={onState}>
              연결된 상태도 보기
            </button>
          </>
        )}
        <label>
          <input
            type='checkbox'
            checked={all}
            onChange={(event) => {
              setAll(event.target.checked);
              navigate('latest', true);
            }}
          />
          전체 이벤트 표시
        </label>
        <button type='button' disabled={!page} onClick={() => navigate(0)}>
          시퀀스 처음
        </button>
        <button type='button' disabled={!page} onClick={() => navigate(page - 1)}>
          시퀀스 이전
        </button>
        <span role='status'>
          {page + 1}/{count} 페이지 · {rows.length}행 · 최대 30행
        </span>
        <button type='button' disabled={page >= count - 1} onClick={() => navigate(page + 1)}>
          시퀀스 다음
        </button>
        <button type='button' onClick={() => navigate('latest')}>
          시퀀스 현재 끝
        </button>
        {showDetail && row && (
          <button
            type='button'
            onClick={() => {
              detail.current?.focus();
              detail.current?.scrollIntoView({ block: 'start' });
            }}
          >
            시퀀스 선택 상세로 이동
          </button>
        )}
      </nav>
      <section className='sequence-canvas' ref={canvas} aria-label='A B 통신 화살표'>
        <div className='sequence-header'>
          <span className='sequence-header-time'>가상 시각</span>
          <div>
            {(['A', 'B'] as const).map((id) => (
              <span key={id} className={`sequence-header-actor actor-${id}`}>
                <strong>{id}</strong>
                <small>
                  {sequenceProtocol(run, id)?.label.slice(0, 42)} · v
                  {sequenceProtocol(run, id)?.revision}
                </small>
              </span>
            ))}
          </div>
        </div>
        {rows.slice(page * SEQUENCE_PAGE_SIZE, (page + 1) * SEQUENCE_PAGE_SIZE).map((item) => (
          <ArrowRow
            key={item.event.eventId}
            row={item}
            selected={item.event.eventId === selected}
            onSelect={() => pick(item.event.eventId)}
            related={inspection?.relatedEventIds.has(item.event.eventId) ?? false}
          />
        ))}
        {!rows.length && (
          <p>
            {relatedOnly
              ? '선택한 상태도와 연결된 기록이 없습니다.'
              : '이 관찰 범위에는 기록이 없습니다.'}
          </p>
        )}
      </section>
      {showDetail && row && (
        <div className='sequence-detail' ref={detail} tabIndex={-1}>
          <EventInspector
            event={row.event}
            label='시퀀스 선택 상세'
            onCause={pick}
            onRule={() => onRule(row.event)}
          />
          <MessageFields run={run} event={row.event} caption='선택 이벤트의 메시지' />
          {row.event.kind === 'receive' && (
            <>
              {parsed.slice(0, 4).map((event) => (
                <MessageFields
                  key={event.eventId}
                  run={run}
                  event={event}
                  caption={`관찰된 해석 ${event.eventId}`}
                />
              ))}
              {parsed.length > 4 && (
                <p>해석 4개 미리보기. 아래 직접 후속에서 나머지를 선택할 수 있습니다.</p>
              )}
              {!parsed.length && (
                <p>
                  이 관찰 범위에는 이 수신에서 나온 메시지 해석이 없습니다. 청크 수신은 완성 메시지
                  수신을 뜻하지 않습니다.
                </p>
              )}
              {!parsed.length && origin && (
                <MessageFields
                  run={run}
                  event={origin}
                  caption='원인 송신 필드 · 수신 해석 결과 아님'
                />
              )}
            </>
          )}
          <Relations key={row.event.eventId} model={model} row={row} onSelect={pick} />
        </div>
      )}
    </section>
  );
}

type Props = {
  run: EngineView;
  eventCount: number;
  selected: string | undefined;
  onSelect: (id: string) => void;
  onRule: (event: EventTrace) => void;
  inspection: DiagramInspection | undefined;
  onState: () => void;
  revealRequest: number;
  context: string;
};

/** Display a bounded, keyboard-operable sequence from the selected run's observed trace prefix. */
export function SequenceDiagram(props: Props) {
  const panel = useDiagramPanel(props.revealRequest);
  return (
    <details
      ref={panel.ref}
      className='execution-state-diagram'
      open={panel.expanded}
      onToggle={(event) => panel.onToggle(event.currentTarget.open)}
    >
      <summary>통신 시퀀스 보기</summary>
      {panel.expanded && <SequenceContent key={props.context} {...props} />}
    </details>
  );
}
