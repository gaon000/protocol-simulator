/** biome-ignore-all lint/a11y/noNoninteractiveTabindex: Native scrolling comparison tables need a keyboard target. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { batchRunMetrics } from '../application/batch-experiments.ts';
import { previewJson } from '../application/preview-json.ts';
import {
  COMPARISON_POLICY,
  type ComparisonRelation,
  compareRuns,
  comparisonEventTitle,
  type EventDifference,
  type ValueDifference,
} from '../application/run-comparison.ts';
import type { JsonValue } from '../domain/execution-contract.ts';
import type { EventTrace } from '../domain/protocol-model.ts';
import type { SavedRun } from '../domain/workspace-model.ts';

const labels: Record<ComparisonRelation, string> = {
  same: '동일',
  different: '차이',
  limited: '비교 한도',
  'left-only': '왼쪽 관찰만',
  'right-only': '오른쪽 관찰만',
};
const verdicts = { pass: '통과', fail: '실패', undetermined: '미판정' };
const sections = {
  configuration: '당시 설정',
  result: '저장 결과',
  A: '참여자 A 상태·변수',
  B: '참여자 B 상태·변수',
  expectation: '기대 조건과 저장 판정',
} as const;
function recordLabel(record: SavedRun) {
  const name =
    record.regression?.cases[record.regression.caseIndex]?.label ??
    record.batch?.label ??
    record.view.snapshot.configuration.label;
  return `${name.slice(0, 80)} · 초안 v${record.draftVersion} · seed ${record.view.snapshot.seed} · ${record.view.status} · ${record.id.slice(-8)}`;
}
function Preview({ value, size = 360 }: { value: JsonValue | undefined; size?: number }) {
  if (value === undefined) return <span>관찰 없음</span>;
  const preview = previewJson(value);
  return (
    <pre>
      {preview.text.slice(0, size)}
      {preview.truncated || preview.text.length > size ? '\n… (값 요약)' : ''}
    </pre>
  );
}
function eventRelation(row: EventDifference) {
  if (row.relation === 'different')
    return row.content === 'different'
      ? row.deltaMs
        ? '내용·시각 차이'
        : '내용 차이'
      : '시각 차이';
  return labels[row.relation];
}
function EventCell({ event }: { event: EventTrace | undefined }) {
  return event ? (
    <>
      <strong>{comparisonEventTitle(event)}</strong>
      <p>
        {event.eventId.slice(0, 80)} · {event.timeMs} ms
      </p>
    </>
  ) : (
    <span>대응 관찰 없음</span>
  );
}
function ComparisonBody({
  left,
  right,
  onInspect,
}: {
  left: SavedRun;
  right: SavedRun;
  onInspect: (record: SavedRun, position?: number) => void;
}) {
  const model = useMemo(() => compareRuns(left, right), [left, right]);
  const [section, setSection] = useState<ValueDifference['section']>('result');
  const [differencesOnly, setDifferencesOnly] = useState(false);
  const [valuePage, setValuePage] = useState(0);
  const [eventPage, setEventPage] = useState(0);
  const [selected, setSelected] = useState<number>();
  const [reveal, setReveal] = useState(0);
  const values = model.values.filter(
    (row) => row.section === section && (!differencesOnly || row.relation !== 'same'),
  );
  const events = useMemo(
    () => model.events.filter((row) => !differencesOnly || row.relation !== 'same'),
    [model, differencesOnly],
  );
  const valuePages = Math.max(1, Math.ceil(values.length / COMPARISON_POLICY.pageSize));
  const eventPages = Math.max(1, Math.ceil(events.length / COMPARISON_POLICY.pageSize));
  const valueCurrent = Math.min(valuePage, valuePages - 1);
  const eventCurrent = Math.min(eventPage, eventPages - 1);
  const valueScroll = useRef<HTMLElement>(null);
  const eventScroll = useRef<HTMLElement>(null);
  const selectedElement = useRef<HTMLTableRowElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Native scroll resets when the displayed page, section or filter changes.
  useEffect(() => {
    valueScroll.current?.scrollTo({ top: 0 });
  }, [valueCurrent, section, differencesOnly]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Scroll geometry changes after selection, pagination and repeated explicit reveal actions.
  useEffect(() => {
    const container = eventScroll.current;
    if (!container) return;
    if (selected === undefined) {
      container.scrollTop = 0;
      return;
    }
    const element = selectedElement.current;
    if (!element) return;
    const outer = container.getBoundingClientRect();
    const inner = element.getBoundingClientRect();
    if (inner.top < outer.top) container.scrollTop += inner.top - outer.top;
    else if (inner.bottom > outer.bottom) container.scrollTop += inner.bottom - outer.bottom;
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected, eventCurrent, reveal]);
  const selectedRow = selected === undefined ? undefined : model.events[selected];
  const firstLimit = model.events.find((row) => row.relation === 'limited')?.index;
  function choose(index: number | undefined) {
    if (index === undefined) return;
    setReveal((value) => value + 1);
    setSelected(index);
    const position = events.findIndex((row) => row.index === index);
    if (position >= 0) setEventPage(Math.floor(position / COMPARISON_POLICY.pageSize));
  }
  const differing = model.events.filter((row) => row.relation !== 'same');
  const previous = differing.findLast((row) => row.index < (selected ?? 0));
  const next = differing.find((row) => row.index > (selected ?? -1));
  return (
    <section
      aria-label='두 실행 비교 결과'
      className='run-comparison-result'
      data-comparison-status={model.traceStatus}
    >
      <div className='comparison-cards'>
        {(
          [
            ['왼쪽', left],
            ['오른쪽', right],
          ] as const
        ).map(([side, record]) => {
          const metrics = batchRunMetrics(record.view);
          return (
            <section key={side} aria-label={`${side} 실행 요약`} className='participant-card'>
              <h2>
                {side} · {record.view.snapshot.configuration.label.slice(0, 100)}
              </h2>
              <p>{recordLabel(record)}</p>
              <p>
                {verdicts[metrics.verdict]} · {record.view.status} · 관찰 {record.view.timeMs} ms
              </p>
              <p>
                송신 {metrics.sends}회 · 타이머 만료 {metrics.expiries}회 · 기록{' '}
                {record.view.events.length}개
              </p>
              <p>
                A: {record.view.participants.A.stateId.slice(0, 80)} (
                {record.view.participants.A.outcome}) · B:{' '}
                {record.view.participants.B.stateId.slice(0, 80)} (
                {record.view.participants.B.outcome})
              </p>
              <button type='button' onClick={() => onInspect(record)}>
                {side} 저장 시점 재생
              </button>
            </section>
          );
        })}
      </div>
      <p className='hint'>
        각 저장 시점의 관찰을 비교합니다. 현재 초안과 원본 기록은 변경하지 않습니다. 실행
        중단·한도·오류와 기대 조건 실패를 구분하고, 설정이 다르면 결과 차이를 같은 조건의 회귀로
        단정하지 마세요.
      </p>
      <p>
        설정 차이{' '}
        {
          model.values.filter(
            (row) =>
              row.section === 'configuration' &&
              row.relation !== 'same' &&
              row.relation !== 'limited',
          ).length
        }
        개 · 설정 비교 한도{' '}
        {
          model.values.filter(
            (row) => row.section === 'configuration' && row.relation === 'limited',
          ).length
        }
        개
      </p>
      <label className='check-control'>
        <span>차이·한도 항목만 보기</span>
        <input
          type='checkbox'
          checked={differencesOnly}
          onChange={(event) => {
            setDifferencesOnly(event.target.checked);
            setValuePage(0);
            setEventPage(0);
            setSelected(undefined);
          }}
        />
      </label>
      <section aria-label='설정과 결과 차이'>
        <label className='control'>
          <span>비교 항목 종류</span>
          <select
            value={section}
            onChange={(event) => {
              setSection(event.target.value as ValueDifference['section']);
              setValuePage(0);
            }}
          >
            {Object.entries(sections).map(([id, label]) => (
              <option value={id} key={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <section
          ref={valueScroll}
          className='comparison-scroll'
          aria-label='설정과 결과 비교 표 스크롤'
          tabIndex={0}
        >
          <table className='comparison-table'>
            <caption>{sections[section]} 비교</caption>
            <thead>
              <tr>
                <th scope='col'>항목·차이</th>
                <th scope='col'>왼쪽 저장 값</th>
                <th scope='col'>오른쪽 저장 값</th>
              </tr>
            </thead>
            <tbody>
              {values.slice(valueCurrent * 20, (valueCurrent + 1) * 20).map((row) => (
                <tr key={row.id} data-compare-value={row.id} data-relation={row.relation}>
                  <th scope='row'>
                    {row.label.slice(0, 120)}
                    <br />
                    <span className='comparison-badge'>{labels[row.relation]}</span>
                  </th>
                  <td>
                    <Preview value={row.left} />
                  </td>
                  <td>
                    <Preview value={row.right} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        {!values.length && <p>필터에 맞는 항목이 없습니다.</p>}
        {valuePages > 1 && (
          <nav className='sequence-controls' aria-label='값 비교 페이지'>
            <button
              type='button'
              disabled={!valueCurrent}
              onClick={() => setValuePage(valueCurrent - 1)}
            >
              이전 비교 항목
            </button>
            <span>
              {valueCurrent + 1}/{valuePages} · 최대 20개
            </span>
            <button
              type='button'
              disabled={valueCurrent + 1 >= valuePages}
              onClick={() => setValuePage(valueCurrent + 1)}
            >
              다음 비교 항목
            </button>
          </nav>
        )}
      </section>
      <section aria-label='나란한 관찰 기록'>
        <h2>시간순 관찰 비교</h2>
        <p role='status'>{model.message}</p>
        {model.traceStatus === 'ready' && (
          <>
            <p>
              관찰 대응 {model.events.length}행 · 차이{' '}
              {model.events.filter((row) => row.relation === 'different').length} · 한쪽 관찰{' '}
              {
                model.events.filter(
                  (row) => row.relation === 'left-only' || row.relation === 'right-only',
                ).length
              }{' '}
              · 비교 한도 {model.events.filter((row) => row.relation === 'limited').length}
            </p>
            <p>
              {model.firstDifference === undefined
                ? firstLimit === undefined
                  ? '관찰 기록에서 차이를 찾지 못했습니다.'
                  : '일부 내용은 비교 한도로 일치를 확인하지 못했습니다.'
                : `확인된 첫 관찰 차이: ${model.firstDifference + 1}행`}
              {model.limitedBeforeFirst
                ? ' · 앞선 비교 한도가 있어 최초 차이임을 보장하지 않습니다.'
                : ''}
            </p>
            <div className='sequence-controls'>
              <button
                type='button'
                disabled={model.firstDifference === undefined}
                onClick={() => choose(model.firstDifference)}
              >
                첫 관찰 차이
              </button>
              <button
                type='button'
                disabled={firstLimit === undefined}
                onClick={() => choose(firstLimit)}
              >
                첫 비교 한도
              </button>
              <button type='button' disabled={!previous} onClick={() => choose(previous?.index)}>
                이전 차이·한도
              </button>
              <button type='button' disabled={!next} onClick={() => choose(next?.index)}>
                다음 차이·한도
              </button>
            </div>
            <section
              ref={eventScroll}
              className='comparison-scroll'
              aria-label='관찰 비교 표 스크롤'
              tabIndex={0}
            >
              <table className='comparison-table'>
                <caption>두 실행 관찰 기록</caption>
                <thead>
                  <tr>
                    <th scope='col'>비교 행</th>
                    <th scope='col'>왼쪽 관찰</th>
                    <th scope='col'>오른쪽 관찰</th>
                  </tr>
                </thead>
                <tbody>
                  {events.slice(eventCurrent * 20, (eventCurrent + 1) * 20).map((row) => (
                    <tr
                      key={row.index}
                      ref={selected === row.index ? selectedElement : undefined}
                      data-compare-row={row.index}
                      data-relation={row.relation}
                      aria-selected={selected === row.index}
                    >
                      <th scope='row'>
                        <button
                          type='button'
                          aria-label={`비교 행 ${row.index + 1} 선택`}
                          aria-pressed={selected === row.index}
                          onClick={() => choose(row.index)}
                        >
                          {row.index + 1}행 · {eventRelation(row)}
                        </button>
                        {row.deltaMs !== undefined && row.deltaMs !== 0 && (
                          <p>오른쪽 − 왼쪽: {row.deltaMs} ms</p>
                        )}
                      </th>
                      <td>
                        <EventCell event={row.left} />
                      </td>
                      <td>
                        <EventCell event={row.right} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            {!events.length && <p>필터에 맞는 관찰이 없습니다.</p>}
            <nav className='sequence-controls' aria-label='관찰 비교 페이지'>
              <button
                type='button'
                disabled={!eventCurrent}
                onClick={() => {
                  setEventPage(eventCurrent - 1);
                  setSelected(undefined);
                }}
              >
                이전 관찰 페이지
              </button>
              <span>
                {eventCurrent + 1}/{eventPages} · 전체 {events.length}행 · 최대 20개
              </span>
              <button
                type='button'
                disabled={eventCurrent + 1 >= eventPages}
                onClick={() => {
                  setEventPage(eventCurrent + 1);
                  setSelected(undefined);
                }}
              >
                다음 관찰 페이지
              </button>
            </nav>
            {selectedRow && (
              <section aria-label='선택한 비교 관찰' className='comparison-cards'>
                {(
                  [
                    ['왼쪽', left, selectedRow.left],
                    ['오른쪽', right, selectedRow.right],
                  ] as const
                ).map(([side, record, event]) => (
                  <section key={side} aria-label={`${side} 선택 관찰`} className='participant-card'>
                    <h3>
                      {side} · {eventRelation(selectedRow)}
                    </h3>
                    <EventCell event={event} />
                    {event && (
                      <>
                        <p>이 기록의 직접 발생 이벤트: {event.causeEventId ?? '없음'}</p>
                        <Preview value={event.data} size={1600} />
                        <button type='button' onClick={() => onInspect(record, event.sequence + 1)}>
                          {side} 관련 기록 재생
                        </button>
                      </>
                    )}
                  </section>
                ))}
              </section>
            )}
          </>
        )}
      </section>
    </section>
  );
}

/** Choose two immutable saved observations and inspect differences without running or editing either source. */
export function RunComparison({
  records,
  pair,
  onPair,
  onInspect,
}: {
  records: readonly SavedRun[];
  pair: readonly [string, string];
  onPair: (pair: readonly [string, string]) => void;
  onInspect: (record: SavedRun, position?: number) => void;
}) {
  const left = records.find((record) => record.id === pair[0]);
  const right = records.find((record) => record.id === pair[1]);
  return (
    <section aria-label='두 실행 나란히 비교' className='run-comparison'>
      <div className='form-grid'>
        {([0, 1] as const).map((side) => (
          <label className='control' key={side}>
            <span>{side === 0 ? '왼쪽 비교 실행' : '오른쪽 비교 실행'}</span>
            <select
              value={pair[side]}
              onChange={(event) =>
                onPair(side === 0 ? [event.target.value, pair[1]] : [pair[0], event.target.value])
              }
            >
              <option value=''>실행 선택</option>
              {records.toReversed().map((record) => (
                <option key={record.id} value={record.id}>
                  {recordLabel(record)}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <button type='button' onClick={() => onPair([pair[1], pair[0]])}>
        왼쪽·오른쪽 바꾸기
      </button>
      {!left || !right ? (
        <p role='status'>
          비교할 저장 실행 두 개를 선택하세요. 삭제되거나 없는 기록은 다른 실행으로 자동 대체하지
          않습니다.
        </p>
      ) : (
        <ComparisonBody
          key={JSON.stringify([left.id, right.id])}
          left={left}
          right={right}
          onInspect={onInspect}
        />
      )}
    </section>
  );
}
