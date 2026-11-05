import { useMemo, useState } from 'react';
import {
  type ByteRange,
  buildMessageStructure,
  STRUCTURE_POLICY,
  type StructureField,
  structureBytePage,
} from '../application/message-structure.ts';
import type { EngineView } from '../domain/protocol-model.ts';

function rangeText(value: ByteRange | undefined) {
  return value
    ? `[${value.start}, ${value.end}) · ${value.end - value.start} bytes`
    : '이 이벤트에서 byte 범위를 정하지 않음';
}
function valueText(field: StructureField) {
  const value = field.value;
  if (value === undefined) return '이 이벤트에 값 없음';
  const text = String(value);
  return text.length > 240
    ? `${text.slice(0, 240)} … (${text.length} UTF-16 단위)`
    : text === ''
      ? '(빈 문자열)'
      : text;
}

function StructureContent({
  run,
  selected,
  eventCount,
}: {
  run: EngineView;
  selected: string | undefined;
  eventCount: number;
}) {
  const model = useMemo(
    () => buildMessageStructure(run, selected, eventCount),
    [run, selected, eventCount],
  );
  const [fieldPage, setFieldPage] = useState(0);
  const [regionPage, setRegionPage] = useState(0);
  const [bytePage, setBytePage] = useState(0);
  const [choice, setChoice] = useState<{ kind: 'field' | 'region'; id: string }>();
  const field =
    choice?.kind === 'field'
      ? model.fields.find((item) => item.definition.id === choice.id)
      : undefined;
  const region =
    choice?.kind === 'region' ? model.regions.find((item) => item.id === choice.id) : undefined;
  const highlight = field?.range ?? region?.range;
  const bytes = model.bytes ? structureBytePage(model.bytes, bytePage) : undefined;
  const fieldPages = Math.max(1, Math.ceil(model.fields.length / STRUCTURE_POLICY.pageSize));
  const regionPages = Math.max(1, Math.ceil(model.regions.length / STRUCTURE_POLICY.pageSize));
  const currentFields = Math.min(fieldPage, fieldPages - 1);
  const currentRegions = Math.min(regionPage, regionPages - 1);
  function choose(kind: 'field' | 'region', id: string, range: ByteRange | undefined) {
    setChoice({ kind, id });
    if (range) setBytePage(Math.floor(range.start / STRUCTURE_POLICY.bytePageSize));
  }
  const status = {
    mapped: '바이트 범위 확인',
    logical: '논리 필드 구조',
    chunk: '수신 청크',
    limited: '일부 구조',
    raw: '원시 구조',
    unavailable: '구조 확인 불가',
  }[model.status];
  return (
    <section aria-label='선택 메시지 구조' data-structure-status={model.status}>
      <h3>
        {model.event?.eventId} · {model.messageId.slice(0, 120) || '메시지 미선택'} · {model.codec}
      </h3>
      <p role='status'>
        <strong>{status}</strong> · {model.note}
      </p>
      {model.declaredLength !== undefined && (
        <p>
          Content-Length: {model.declaredLength} bytes · 현재 송신 본문: {model.bodyBytes} bytes
        </p>
      )}
      {!!model.regions.length && (
        <section aria-label='전송 영역 구조'>
          <h4>전송 영역 · {model.regions.length}개</h4>
          <div className='structure-regions'>
            {model.regions.slice(currentRegions * 20, (currentRegions + 1) * 20).map((item) => (
              <button
                key={item.id}
                type='button'
                aria-pressed={choice?.kind === 'region' && choice.id === item.id}
                className={`structure-region structure-region-${item.id.split('-')[0]}`}
                onClick={() => choose('region', item.id, item.range)}
              >
                <strong>{item.label}</strong>
                <span>{rangeText(item.range)}</span>
              </button>
            ))}
          </div>
          {regionPages > 1 && (
            <nav className='sequence-controls' aria-label='전송 영역 페이지'>
              <button
                type='button'
                disabled={!currentRegions}
                onClick={() => setRegionPage(currentRegions - 1)}
              >
                영역 이전
              </button>
              <span>
                {currentRegions + 1}/{regionPages} · 최대 20개
              </span>
              <button
                type='button'
                disabled={currentRegions + 1 >= regionPages}
                onClick={() => setRegionPage(currentRegions + 1)}
              >
                영역 다음
              </button>
            </nav>
          )}
        </section>
      )}
      {!!model.fields.length && (
        <section aria-label='메시지 필드 구조'>
          <h4>
            필드 · {model.fields.length}/{model.totalFields}개
          </h4>
          <div className='structure-fields'>
            {model.fields.slice(currentFields * 20, (currentFields + 1) * 20).map((item) => (
              <button
                key={item.definition.id}
                type='button'
                data-structure-field={item.definition.id}
                aria-pressed={choice?.kind === 'field' && choice.id === item.definition.id}
                className='structure-field'
                onClick={() => choose('field', item.definition.id, item.range)}
              >
                <strong>
                  필드 {item.definition.id.slice(0, 100)} · {item.definition.name.slice(0, 100)}
                </strong>
                <span>
                  {item.location} · {item.definition.type} ·{' '}
                  {item.definition.required ? '필수' : '선택'}
                </span>
                <span>기록 값: {valueText(item)}</span>
                <span>{rangeText(item.range)}</span>
              </button>
            ))}
          </div>
          {fieldPages > 1 && (
            <nav className='sequence-controls' aria-label='구조 필드 페이지'>
              <button
                type='button'
                disabled={!currentFields}
                onClick={() => setFieldPage(currentFields - 1)}
              >
                필드 이전
              </button>
              <span>
                {currentFields + 1}/{fieldPages} · 최대 20개
              </span>
              <button
                type='button'
                disabled={currentFields + 1 >= fieldPages}
                onClick={() => setFieldPage(currentFields + 1)}
              >
                필드 다음
              </button>
            </nav>
          )}
        </section>
      )}
      {choice && (
        <p className='structure-selection' role='status'>
          선택: {field?.definition.id.slice(0, 100) ?? region?.label ?? '현재 구간에 없음'} ·{' '}
          {rangeText(highlight)}
        </p>
      )}
      {bytes && (
        <section aria-label='실제 바이트 탐색'>
          <h4>실제 전송 데이터 · {model.bytes?.length} bytes</h4>
          <nav className='sequence-controls' aria-label='바이트 페이지 이동'>
            <button type='button' disabled={!bytes.page} onClick={() => setBytePage(0)}>
              처음 바이트
            </button>
            <button
              type='button'
              disabled={!bytes.page}
              onClick={() => setBytePage(bytes.page - 1)}
            >
              이전 바이트
            </button>
            <label>
              바이트 페이지
              <input
                aria-label='바이트 페이지'
                type='number'
                min={1}
                max={bytes.pages}
                value={bytes.page + 1}
                onChange={(event) => setBytePage(Number(event.target.value) - 1)}
              />
            </label>
            <span>/{bytes.pages} · 최대 256 bytes</span>
            <button
              type='button'
              disabled={bytes.page + 1 >= bytes.pages}
              onClick={() => setBytePage(bytes.page + 1)}
            >
              다음 바이트
            </button>
            <button
              type='button'
              disabled={bytes.page + 1 >= bytes.pages}
              onClick={() => setBytePage(bytes.pages - 1)}
            >
              끝 바이트
            </button>
            {highlight && (
              <button type='button' onClick={() => setBytePage(Math.floor(highlight.start / 256))}>
                선택 범위로 이동
              </button>
            )}
          </nav>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Native byte table scrolling must be keyboard accessible. */}
          <section className='structure-byte-scroll' aria-label='hex ASCII 바이트 표' tabIndex={0}>
            <table className='structure-byte-table'>
              <caption>
                바이트 {bytes.start}~{bytes.start + bytes.values.length} (끝 제외) · ASCII 이외는 ·
              </caption>
              <thead>
                <tr>
                  <th scope='col'>offset (hex)</th>
                  <th scope='col'>hex</th>
                  <th scope='col'>ASCII</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: Math.ceil(bytes.values.length / 16) }, (_, row) => {
                  const start = bytes.start + row * 16;
                  const values = bytes.values.slice(row * 16, row * 16 + 16);
                  return (
                    <tr key={start}>
                      <th scope='row'>{start.toString(16).padStart(6, '0')}</th>
                      <td>
                        {values.map((byte, index) => {
                          const offset = start + index;
                          return (
                            <span
                              key={offset}
                              className='structure-byte'
                              data-byte-offset={offset}
                              data-byte-selected={
                                !!highlight && offset >= highlight.start && offset < highlight.end
                              }
                            >
                              {byte.toString(16).padStart(2, '0')}
                            </span>
                          );
                        })}
                      </td>
                      <td className='structure-ascii'>
                        {values
                          .map((byte) =>
                            byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '·',
                          )
                          .join('')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
          {!bytes.values.length && <p>이 이벤트에는 바이트가 없습니다.</p>}
        </section>
      )}
    </section>
  );
}

/** Visualize only the selected frozen event, leaving large payloads in the original trace. */
export function MessageStructurePanel({
  run,
  selected,
  eventCount,
  context,
}: {
  run: EngineView;
  selected: string | undefined;
  eventCount: number;
  context: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      className='message-structure'
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>메시지 구조 보기</summary>
      {expanded && (
        <StructureContent
          key={`${context}-${selected ?? ''}`}
          run={run}
          selected={selected}
          eventCount={eventCount}
        />
      )}
    </details>
  );
}
