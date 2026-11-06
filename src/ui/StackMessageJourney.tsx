import { useEffect, useRef, useState } from 'react';
import type {
  StackJourneyQuery,
  StackMessageJourney,
} from '../application/stack-message-journey.ts';

/** Present bounded record-local byte paths and keep highlighting separate from moving the history cursor. */
export function StackMessageJourneyPanel({
  value,
  change,
  selected,
  select,
  replay,
  focus,
  setFocus,
}: {
  value: StackMessageJourney;
  change: (patch: StackJourneyQuery) => void;
  selected: string | undefined;
  select: (id: string, cursor: number) => void;
  replay: (id: string, cursor: number) => void;
  focus: string | undefined;
  setFocus: (key: string) => void;
}) {
  const container = useRef<HTMLElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (value && focus)
      [...(container.current?.querySelectorAll<HTMLElement>('[data-journey-focus]') ?? [])]
        .find((e) => e.dataset.journeyFocus === focus)
        ?.focus({ preventScroll: true });
  }, [value, focus]);
  const data = 'root' in value ? value : undefined;
  const root = data?.root;
  const roots = 'roots' in value ? value.roots : undefined;
  function update(key: string, patch: StackJourneyQuery) {
    setFocus(key);
    change(patch);
  }
  return (
    <section
      ref={container}
      className='stack-journey'
      aria-label='메시지 이동 경로'
      data-journey-status={value.status}
    >
      <h4>메시지의 계층별 이동 경로</h4>
      <p>{value.note}</p>
      {roots && (
        <div className='stack-inline'>
          <label>
            추적할 응용 송신
            <select
              aria-label='추적할 응용 송신'
              value={root?.id ?? ''}
              data-journey-focus='root'
              onChange={(e) =>
                update('root', {
                  rootId: e.target.value,
                  offset: 0,
                  page: 0,
                  bytePage: 0,
                  fieldPage: 0,
                })
              }
            >
              {!root && <option value=''>현재 위치의 송신 선택</option>}
              {root && !roots.rows.some((r) => r.id === root.id) && (
                <option value={root.id}>
                  #{root.cursor} · {root.target} · {root.title}
                </option>
              )}
              {roots.rows.map((r) => (
                <option key={r.id} value={r.id}>
                  #{r.cursor} · {r.target} · {r.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type='button'
            disabled={roots.page === 0}
            data-journey-focus='root-prev'
            onClick={() => update('root-prev', { rootPage: roots.page - 1 })}
          >
            송신 이전 목록
          </button>
          <span>
            {roots.page + 1}/{roots.pages} · 송신 {roots.total}개
          </span>
          <button
            type='button'
            disabled={roots.page + 1 === roots.pages}
            data-journey-focus='root-next'
            onClick={() => update('root-next', { rootPage: roots.page + 1 })}
          >
            송신 다음 목록
          </button>
        </div>
      )}
      {data && root && (
        <>
          <p className='journey-summary'>
            원본 #{root.cursor} · {root.target} · {root.title} · {root.byteLength} bytes
          </p>
          <p>
            선택 범위 [{data.selection.offset}, {data.selection.offset + data.selection.length}) ·{' '}
            {data.selection.length} bytes · 연결된 앱 해석 {data.frames}회 · 연결된 응용 전달{' '}
            {data.deliveries}회
          </p>
          {data.prefix && (
            <p>현재 기록 위치까지의 관찰입니다. 이후 수신·ACK·프레임은 표시하지 않습니다.</p>
          )}
          {data.partial && (
            <p>부분 실행 관찰입니다. 미관찰 구간의 성공·실패를 추정하지 않습니다.</p>
          )}
          {data.notes.map((note) => (
            <p key={note} role='status'>
              {note}
            </p>
          ))}
          <section
            className='journey-diagram-scroll'
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users scroll this bounded diagram region at narrow widths.
            tabIndex={0}
            aria-label='계층별 바이트 대응 그림 스크롤'
          >
            <svg
              role='img'
              aria-label='메시지의 네 계층 이동'
              viewBox='0 0 800 120'
              className='journey-diagram'
            >
              {data.stages.map((stage, index) => (
                <g key={stage.target}>
                  {index > 0 && (
                    <text x={index * 200 - 10} y={58} textAnchor='middle' fontSize={20}>
                      →
                    </text>
                  )}
                  <rect
                    x={index * 200 + 8}
                    y={8}
                    width={176}
                    height={96}
                    rx={8}
                    fill={stage.bytes ? '#e7f5ef' : '#eef1f4'}
                    stroke='#456478'
                  />
                  <text x={index * 200 + 20} y={30} fontSize={14}>
                    {stage.label}
                  </text>
                  <text x={index * 200 + 20} y={51} fontSize={12}>
                    {stage.target.slice(0, 22)}
                  </text>
                  <text x={index * 200 + 20} y={73} fontSize={13}>
                    {stage.bytes} / {data.selection.length} bytes 관찰
                  </text>
                  <text x={index * 200 + 20} y={92} fontSize={11}>
                    {stage.bytes ? '출처에 연결된 선택 byte' : '선택 byte 대응 미확인'}
                  </text>
                </g>
              ))}
            </svg>
          </section>
          <p>{data.layoutNote} · 좌표는 UTF-8 문자 수가 아닌 byte 위치입니다.</p>
          {data.fieldPages > 1 && (
            <div className='stack-inline'>
              <button
                type='button'
                data-journey-focus='field-prev'
                disabled={data.fieldPage === 0}
                onClick={() => update('field-prev', { fieldPage: data.fieldPage - 1 })}
              >
                필드 이전 목록
              </button>
              <span>
                byte 위치가 확인된 필드 {data.totalFields}개 · {data.fieldPage + 1}/
                {data.fieldPages}
              </span>
              <button
                type='button'
                data-journey-focus='field-next'
                disabled={data.fieldPage + 1 === data.fieldPages}
                onClick={() => update('field-next', { fieldPage: data.fieldPage + 1 })}
              >
                필드 다음 목록
              </button>
            </div>
          )}
          <fieldset className='journey-fields' aria-label='이동 경로의 원본 필드'>
            <legend>원본 필드</legend>
            <button
              type='button'
              data-journey-focus='whole'
              onClick={() =>
                update('whole', { offset: 0, length: root.byteLength, page: 0, bytePage: 0 })
              }
            >
              원본 전체 선택
            </button>
            {data.fields.map((field) => (
              <button
                type='button'
                key={field.id}
                data-journey-focus={`field:${field.id}`}
                aria-pressed={
                  data.selection.offset === field.start &&
                  data.selection.length === field.end - field.start
                }
                onClick={() =>
                  update(`field:${field.id}`, {
                    offset: field.start,
                    length: field.end - field.start,
                    page: 0,
                    bytePage: Math.floor(field.start / 256),
                  })
                }
              >
                필드 {field.name} · [{field.start}, {field.end})
              </button>
            ))}
          </fieldset>
          <form
            key={`${root.id}:${data.selection.offset}:${data.selection.length}`}
            className='stack-inline'
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const offsetText = String(form.get('offset') ?? '');
              const lengthText = String(form.get('length') ?? '');
              const offset = Number(offsetText);
              const length = Number(lengthText);
              if (
                !offsetText.trim() ||
                !lengthText.trim() ||
                !Number.isSafeInteger(offset) ||
                !Number.isSafeInteger(length) ||
                offset < 0 ||
                length < 0 ||
                offset + length > root.byteLength
              ) {
                setError('원본 프레임 안의 정수 byte 범위를 입력하세요.');
                return;
              }
              setError('');
              update('apply', { offset, length, page: 0, bytePage: Math.floor(offset / 256) });
            }}
          >
            <label>
              원본 byte 시작
              <input
                name='offset'
                type='number'
                min={0}
                max={root.byteLength}
                step={1}
                defaultValue={data.selection.offset}
              />
            </label>
            <label>
              선택 byte 길이
              <input
                name='length'
                type='number'
                min={0}
                max={root.byteLength}
                step={1}
                defaultValue={data.selection.length}
              />
            </label>
            <button type='submit' data-journey-focus='apply'>
              byte 범위 적용
            </button>
            {error && <p role='alert'>{error}</p>}
          </form>
          <details open={focus?.startsWith('byte:') || focus?.startsWith('bytes-')}>
            <summary>원본 byte 창 · 최대 256 bytes</summary>
            <div className='stack-inline'>
              <button
                type='button'
                disabled={data.bytePage === 0}
                data-journey-focus='bytes-prev'
                onClick={() => update('bytes-prev', { bytePage: data.bytePage - 1 })}
              >
                이동 경로 byte 이전
              </button>
              <span>
                byte 페이지 {data.bytePage + 1}/{data.bytePages}
              </span>
              <button
                type='button'
                disabled={data.bytePage + 1 === data.bytePages}
                data-journey-focus='bytes-next'
                onClick={() => update('bytes-next', { bytePage: data.bytePage + 1 })}
              >
                이동 경로 byte 다음
              </button>
            </div>
            <fieldset className='journey-byte-window' aria-label='이동 경로 원본 byte 창'>
              <legend>원본 byte 창</legend>
              {data.cells.map((cell, index) => (
                <button
                  key={cell.offset}
                  type='button'
                  data-journey-byte={cell.offset}
                  data-journey-focus={`byte:${cell.offset}`}
                  tabIndex={
                    focus?.startsWith('byte:')
                      ? focus === `byte:${cell.offset}`
                        ? 0
                        : -1
                      : index === 0
                        ? 0
                        : -1
                  }
                  aria-pressed={
                    cell.offset >= data.selection.offset &&
                    cell.offset < data.selection.offset + data.selection.length
                  }
                  aria-label={`원본 byte ${cell.offset} · ${cell.hex}`}
                  title={`${cell.offset} · ${cell.ascii}`}
                  onClick={() =>
                    update(`byte:${cell.offset}`, { offset: cell.offset, length: 1, page: 0 })
                  }
                  onKeyDown={(event) => {
                    const moves: Record<string, number> = {
                      ArrowLeft: -1,
                      ArrowRight: 1,
                      ArrowUp: -16,
                      ArrowDown: 16,
                    };
                    const move = moves[event.key];
                    if (move === undefined) return;
                    event.preventDefault();
                    const next = Math.max(0, Math.min(root.byteLength - 1, cell.offset + move));
                    update(`byte:${next}`, {
                      offset: next,
                      length: 1,
                      page: 0,
                      bytePage: Math.floor(next / 256),
                    });
                  }}
                >
                  {cell.hex}
                </button>
              ))}
            </fieldset>
          </details>
          <div className='stack-inline'>
            <button
              type='button'
              disabled={data.page === 0}
              data-journey-focus='prev'
              onClick={() => update('prev', { page: data.page - 1 })}
            >
              이동 경로 이전
            </button>
            <span>
              관찰 {data.total}개 · {data.page + 1}/{data.pages} · 페이지당 최대 20개
            </span>
            <button
              type='button'
              disabled={data.page + 1 === data.pages}
              data-journey-focus='next'
              onClick={() => update('next', { page: data.page + 1 })}
            >
              이동 경로 다음
            </button>
          </div>
          <p>
            막대는 원본 프레임 안의 선택 byte 위치입니다. 제어 후속은 점선으로 구분합니다. 범위의 끝
            위치는 포함하지 않습니다.
          </p>
          <ol className='journey-rows'>
            {data.rows.map((row) => (
              <li
                key={row.id}
                data-journey-event={row.id}
                className={row.id === selected ? 'is-selected' : ''}
              >
                <div className='journey-row-heading'>
                  <strong>
                    #{row.cursor} · {row.timeMs}ms · {row.target}
                  </strong>
                  <span>{row.title}</span>
                </div>
                <div className={`journey-span-track ${row.relation}`} aria-hidden='true'>
                  {row.spans.map((span) => (
                    <span
                      className='journey-span'
                      key={`${span.slot}:${span.start}:${span.local}:${span.length}`}
                      style={{
                        left: `${(span.start / Math.max(1, root.byteLength)) * 100}%`,
                        width: `${Math.max(0.5, (span.length / Math.max(1, root.byteLength)) * 100)}%`,
                      }}
                    />
                  ))}
                </div>
                <p>
                  {row.relation === 'bytes'
                    ? `${row.mappedBytes} bytes 대응`
                    : row.relation === 'message'
                      ? '연결된 프레임의 응용 전달 관찰'
                      : '제어/환경 후속 · byte 대응 아님'}
                </p>
                {row.spans.map((span) => (
                  <code key={`${span.slot}:${span.start}:${span.local}:${span.length}`}>
                    원본 [{span.start}, {span.start + span.length}) → {span.slot} [{span.local},{' '}
                    {span.local + span.length}){' '}
                  </code>
                ))}
                {row.totalSpans > 4 && <p>구간 처음 4개 표시 · 전체 {row.totalSpans}개</p>}
                {row.flags.map((flag) => (
                  <p className='journey-flag' key={flag}>
                    {flag}
                  </p>
                ))}
                <div className='stack-inline'>
                  <button
                    type='button'
                    data-journey-focus={`event:${row.id}`}
                    aria-pressed={row.id === selected}
                    onClick={() => {
                      setFocus(`event:${row.id}`);
                      select(row.id, row.cursor);
                    }}
                  >
                    시퀀스에서 강조 · #{row.cursor}
                  </button>
                  <button
                    type='button'
                    data-journey-focus={`replay:${row.id}`}
                    onClick={() => {
                      setFocus(`replay:${row.id}`);
                      replay(row.id, row.cursor);
                    }}
                  >
                    이 기록까지 재생 · #{row.cursor}
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
