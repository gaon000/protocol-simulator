/** biome-ignore-all lint/a11y/useSemanticElements: Interactive SVG groups use keyboard-enabled button roles, since HTML buttons cannot be children of SVG. */
import { useEffect, useMemo, useState } from 'react';
import type { StackBreakpointStop } from '../application/stack-breakpoints.ts';
import type { StackPanelModel, StackPanelQuery } from '../application/stack-panel-model.ts';
import type { StackWorkerClient } from '../application/stack-worker-client.ts';
import type { StackDebugSettings } from '../application/stack-worker-protocol.ts';
import { stackTarget } from '../domain/stack-record.ts';
import type { SavedStackRun } from '../domain/workspace-v2-model.ts';
import { useStackQuery } from './useStackQuery.ts';

type Props = {
  record: SavedStackRun | undefined;
  running: boolean;
  cursor: number;
  setCursor: (cursor: number) => void;
  selected: string | undefined;
  select: (id: string, cursor: number) => void;
  client: StackWorkerClient | undefined;
  ready: boolean;
  replay: () => void;
  stored: boolean;
  saveCurrent: () => void;
  settings: StackDebugSettings;
  onStop: (stop: StackBreakpointStop) => void;
};
type Row = { id: string; cursor: number; target: string; timeMs: number; title: string };
function Pager({
  label,
  page,
  pages,
  change,
}: {
  label: string;
  page: number;
  pages: number;
  change: (page: number) => void;
}) {
  return (
    <div className='stack-pager'>
      <button type='button' disabled={page === 0} onClick={() => change(page - 1)}>
        {label} 이전
      </button>
      <span>
        {page + 1} / {pages}
      </span>
      <button type='button' disabled={page + 1 >= pages} onClick={() => change(page + 1)}>
        {label} 다음
      </button>
    </div>
  );
}
function Rows({ rows, select }: { rows: readonly Row[]; select: Props['select'] }) {
  return (
    <ul className='stack-event-links'>
      {rows.map((row) => (
        <li key={row.id}>
          <button type='button' onClick={() => select(row.id, row.cursor)}>
            #{row.cursor} · {row.target} · {row.timeMs}ms · {row.title}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Inspect only a frozen run's observed prefix and link every selection to that run's actual cursor. */
export function StackRunPanel({
  record,
  running,
  cursor,
  setCursor,
  selected,
  select,
  client,
  ready,
  replay,
  stored,
  saveCurrent,
  settings,
  onStop,
}: Props) {
  const [playId, setPlayId] = useState<string>();
  const [playError, setPlayError] = useState('');
  const playing = playId !== undefined && playId === record?.id && !running;
  useEffect(() => {
    if (!playing || !record || !client || cursor >= record.view.events.length + 1) return;
    let current = true;
    const timer = setTimeout(async () => {
      try {
        await client.register(record);
        const next = await client.request<{
          cursor: number;
          eventId?: string;
          stop?: StackBreakpointStop;
        }>({ type: 'history-step', recordId: record.id, cursor, settings });
        if (!current) return;
        if (next.eventId) select(next.eventId, next.cursor);
        else setCursor(next.cursor);
        if (next.stop) {
          setPlayId(undefined);
          onStop(next.stop);
        } else if (next.cursor >= record.view.events.length + 1) setPlayId(undefined);
      } catch (error) {
        if (current) {
          setPlayError(String(error));
          setPlayId(undefined);
        }
      }
    }, 120);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  });
  const [target, setTarget] = useState('A/app');
  const [layer, setLayer] = useState<StackPanelQuery['layer']>('all');
  const [filterTarget, setFilterTarget] = useState(false);
  const [page, setPage] = useState(0);
  const [followSelection, setFollowSelection] = useState(true);
  const [statePage, setStatePage] = useState(0);
  const [rulePage, setRulePage] = useState(0);
  const [ruleId, setRuleId] = useState<string>();
  const [stateId, setStateId] = useState<string>();
  const [detail, setDetail] = useState<StackPanelQuery['detail']>('event');
  const [rangeIndex, setRangeIndex] = useState(0);
  const [bytePage, setBytePage] = useState(0);
  const [field, setField] = useState<string>();
  const [expectationId, setExpectationId] = useState('');
  const endpoints = useMemo(
    () =>
      record
        ? (['A', 'B'] as const).flatMap((participant) =>
            record.view.snapshot.configuration.nodes[participant].instances.map((i) => ({
              participant,
              instanceId: i.id,
            })),
          )
        : [],
    [record],
  );
  const endpoint = endpoints.find((e) => stackTarget(e) === target) ?? endpoints[0];
  const position = record ? Math.max(0, Math.min(cursor, record.view.events.length + 1)) : 0;
  const query = useMemo<StackPanelQuery | undefined>(
    () =>
      endpoint
        ? {
            cursor: position,
            endpoint,
            page,
            statePage,
            rulePage,
            layer,
            filterTarget,
            detail,
            bytePage,
            rangeIndex,
            followSelection,
            ...(selected ? { eventId: selected } : {}),
            ...(ruleId ? { ruleId } : {}),
            ...(stateId ? { stateId } : {}),
            ...(expectationId ? { expectationId } : {}),
          }
        : undefined,
    [
      endpoint,
      position,
      page,
      statePage,
      rulePage,
      layer,
      filterTarget,
      detail,
      bytePage,
      rangeIndex,
      selected,
      ruleId,
      stateId,
      expectationId,
      followSelection,
    ],
  );
  const key = useMemo(
    () => (record && query && client && ready && !running ? { record, query, client } : undefined),
    [record, query, client, ready, running],
  );
  const result = useStackQuery<StackPanelModel>(key, async () => {
    if (!key) throw new Error('기록이 없습니다.');
    await key.client.register(key.record);
    return key.client.request({ type: 'panel', recordId: key.record.id, query: key.query });
  });
  const model = result?.value;
  function choose(id: string, next: number) {
    setFollowSelection(true);
    setRangeIndex(0);
    setBytePage(0);
    setField(undefined);
    const own = record?.view.events[next - 1];
    if (own) setTarget(stackTarget(own.endpoint));
    select(id, next);
  }
  if (!record)
    return (
      <section aria-label='스택 실행 관찰'>
        <h2>스택 실행 관찰</h2>
        <p>예제 사본을 선택한 뒤 전체 실행 또는 한 단계를 시작하세요.</p>
      </section>
    );
  const max = record.view.events.length + 1;
  const shift = (next: number) => {
    setPlayId(undefined);
    setCursor(next);
    setFollowSelection(true);
  };
  return (
    <section className='stack-run-panel' aria-label='스택 실행 관찰'>
      <h2>스택 실행 관찰</h2>
      <p className='stack-run-summary' role='status'>
        {running ? '실행 요약' : '기록 요약'} · {record.view.status} · {record.view.timeMs}ms · 관찰{' '}
        {record.view.events.length}개 · 실행 v{record.draftVersion} ·{' '}
        {running ? '가상 실행 중' : '읽기 전용 snapshot'}
      </p>
      <p>
        {stored
          ? '작업 공간의 저장 목록에 포함된 기록입니다. 브라우저 저장 상태는 위에서 확인하세요.'
          : '현재 메모리의 관찰입니다. 저장 한도에 도달했다면 과거 기록을 정리한 뒤 목록에 추가할 수 있습니다.'}
      </p>
      <button type='button' disabled={stored || running} onClick={saveCurrent}>
        이 실행을 저장 목록에 추가
      </button>
      <button type='button' onClick={replay} disabled={running}>
        이 snapshot으로 새 스택 실행
      </button>
      <div className='stack-inline'>
        <button
          type='button'
          disabled={running || playing || position === max}
          onClick={() => {
            setPlayError('');
            setPlayId(record.id);
          }}
        >
          스택 기록 자동 재생
        </button>
        <button type='button' disabled={!playing} onClick={() => setPlayId(undefined)}>
          스택 기록 재생 정지
        </button>
        {playError && <p role='alert'>{playError}</p>}
      </div>
      <div role='group' className='stack-cursor' aria-label='스택 기록 위치'>
        <button type='button' disabled={running || position === 0} onClick={() => shift(0)}>
          기록 처음
        </button>
        <button
          type='button'
          disabled={running || position === 0}
          onClick={() => shift(position - 1)}
        >
          기록 이전
        </button>
        <label>
          기록 위치{' '}
          <input
            aria-label='스택 기록 위치 값'
            type='range'
            min={0}
            max={max}
            value={position}
            disabled={running}
            onChange={(event) => shift(Number(event.target.value))}
          />
        </label>
        <output>
          {position} / {max}
        </output>
        <button
          type='button'
          disabled={running || position === max}
          onClick={() => shift(position + 1)}
        >
          기록 다음
        </button>
        <button type='button' disabled={running || position === max} onClick={() => shift(max)}>
          저장 시점
        </button>
      </div>
      <p>
        {position === max
          ? '저장 당시 상태·판정입니다.'
          : '선택 위치까지의 관찰입니다. 최종 판정·버퍼는 적용하지 않습니다.'}
      </p>
      <label className='control'>
        관찰할 인스턴스
        <select
          aria-label='관찰할 인스턴스'
          value={endpoint ? stackTarget(endpoint) : ''}
          onChange={(event) => {
            setTarget(event.target.value);
            setRuleId(undefined);
            setStateId(undefined);
            setStatePage(0);
            setRulePage(0);
            setPage(0);
          }}
        >
          {endpoints.map((e) => (
            <option key={stackTarget(e)}>{stackTarget(e)}</option>
          ))}
        </select>
      </label>
      {running ? (
        <p>실행 중입니다. 정지하면 현재 snapshot의 다이어그램과 상세를 확인할 수 있습니다.</p>
      ) : result?.error ? (
        <p role='alert'>{result.error}</p>
      ) : !model ? (
        <p role='status'>선택한 관찰 준비 중…</p>
      ) : model.status === 'unavailable' ? (
        <p role='status'>{model.message} · 원본 요약과 내보내기는 유지합니다.</p>
      ) : (
        <>
          <div className='stack-node-grid'>
            <section className='stack-card' aria-label='인스턴스 상태'>
              <h3>
                {endpoint && stackTarget(endpoint)} · {model.actor?.stateId}
              </h3>
              <p>
                가상 시각 {model.timeMs}ms · {model.actor?.outcome}
              </p>
              <p>
                송신 {model.counts.sends} · 해석 {model.counts.parsed} · 앱 전달{' '}
                {model.counts.deliveries}
              </p>
              <p>
                전체 live bytes {model.globalBytes ?? '이 위치에 기록되지 않음'} · 기록 artifact{' '}
                {model.artifactBytes} bytes
              </p>
              {model.actor && (
                <>
                  <p>
                    버퍼{' '}
                    {model.actor.buffers
                      ? `codec ${model.actor.buffers.codecBytes} · 변수 ${model.actor.buffers.variableBytes} · 포트 ${model.actor.buffers.portBytes} bytes`
                      : '이 위치에 기록되지 않음'}
                  </p>
                  <pre>{JSON.stringify(model.actor.ports, null, 2)}</pre>
                  <p>
                    타이머 {model.actor.timers.length ? JSON.stringify(model.actor.timers) : '없음'}
                  </p>
                  <dl>
                    {model.actor.variables.map((v) => (
                      <div key={v.id}>
                        <dt>{v.id}</dt>
                        <dd>
                          <code>{v.value}</code>
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {model.actor.totalVariables > 20 && <p>변수는 처음 20개를 표시합니다.</p>}
                </>
              )}
            </section>
            <section className='stack-card' aria-label='스택 기대 조건'>
              <h3>기대 조건</h3>
              {model.expectations.map((e) => (
                <button
                  className='diagnostic-link'
                  type='button'
                  key={e.expectationId}
                  onClick={() => {
                    setExpectationId(e.expectationId);
                    setDetail('diagnosis');
                  }}
                >
                  {e.expectationId} · {e.status} · {e.detail}
                </button>
              ))}
              {!model.expectations.length && <p>선언된 기대 조건이 없습니다.</p>}
              {model.diagnostics.map((d) => (
                <p key={`${d.path}:${d.message}`}>
                  {d.path} · {d.message}
                </p>
              ))}
            </section>
          </div>
          <section className='stack-card' aria-label='스택 상태도'>
            <h3>상태도 · 실행 snapshot</h3>
            <p>상태와 규칙을 선택하면 이 인스턴스에서 실제 관찰된 회차만 표시합니다.</p>
            {model.diagram && (
              <>
                <Pager
                  label='상태'
                  page={model.diagram.statePage}
                  pages={model.diagram.statePages}
                  change={setStatePage}
                />
                <Pager
                  label='규칙'
                  page={model.diagram.rulePage}
                  pages={model.diagram.rulePages}
                  change={setRulePage}
                />
                <div className='stack-diagram-scroll'>
                  <svg
                    width={model.diagram.width}
                    height={model.diagram.height}
                    aria-label='스택 상태도 그림'
                    role='img'
                  >
                    <title>현재 인스턴스의 상태와 전이</title>
                    <defs>
                      <marker
                        id='stack-state-arrow'
                        markerWidth={7}
                        markerHeight={7}
                        refX={6}
                        refY={3.5}
                        orient='auto'
                      >
                        <path d='M0 0 L7 3.5 L0 7' fill='#6e90af' />
                      </marker>
                    </defs>
                    {model.diagram.edges.map((edge) => (
                      <g key={edge.key}>
                        <path
                          d={edge.path}
                          fill='none'
                          stroke='#6e90af'
                          strokeWidth={2}
                          markerEnd='url(#stack-state-arrow)'
                        />
                        <text x={edge.labelX} y={edge.labelY} fontSize={11}>
                          {edge.ruleIndices
                            .map(
                              (index) =>
                                model.rules[
                                  model.diagram?.visibleRules.indexOf(index) ?? -1
                                ]?.id.slice(0, 26) ?? String(index + 1),
                            )
                            .join(', ')}
                        </text>
                      </g>
                    ))}
                    {model.diagram.nodes.map((node) => (
                      <g
                        key={node.key}
                        role='button'
                        tabIndex={0}
                        aria-label={`상태 관찰 ${node.id}`}
                        onClick={() => {
                          setStateId(node.id);
                          setRuleId(undefined);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setStateId(node.id);
                            setRuleId(undefined);
                          }
                        }}
                      >
                        <rect
                          x={node.x}
                          y={node.y}
                          width={170}
                          height={92}
                          rx={10}
                          fill={model.actor?.stateId === node.id ? '#d4ebdf' : '#edf3f8'}
                          stroke={model.actor?.stateId === node.id ? '#257550' : '#8ea3b8'}
                          strokeWidth={node.terminal ? 3 : 1}
                        />
                        <text x={node.x + 10} y={node.y + 28}>
                          {node.id.slice(0, 22)}
                        </text>
                        <text x={node.x + 10} y={node.y + 50} fontSize={11}>
                          {node.label.slice(0, 24)}
                        </text>
                        <text x={node.x + 10} y={node.y + 72} fontSize={11}>
                          {node.initial ? '초기 상태' : node.terminal ? '종료 상태' : ''}
                        </text>
                      </g>
                    ))}
                  </svg>
                </div>
              </>
            )}
            <div className='stack-rule-list'>
              {model.rules.map((rule) => (
                <button
                  type='button'
                  key={rule.id}
                  title={rule.description}
                  onClick={() => {
                    setRuleId(rule.id);
                    setStateId(undefined);
                  }}
                >
                  {rule.id} · {rule.from} → {rule.to}
                </button>
              ))}
            </div>
            {model.occurrences && (
              <div>
                <h4>
                  {ruleId} 실제 전이 · {model.occurrences.total}회
                </h4>
                <Rows rows={model.occurrences.rows} select={choose} />
                {model.occurrences.total > 20 && <p>처음 20회 표시</p>}
              </div>
            )}
            {model.stateOccurrences && (
              <div>
                <h4>
                  {stateId} 상태 관찰 · {model.stateOccurrences.total}회
                </h4>
                {model.stateOccurrences.initial && (
                  <button type='button' onClick={() => shift(0)}>
                    초기 상태 관찰로 이동
                  </button>
                )}
                <Rows rows={model.stateOccurrences.rows} select={choose} />
                {model.stateOccurrences.total > 20 && <p>처음 20회 표시</p>}
              </div>
            )}
          </section>
          <section className='stack-card' aria-label='스택 통신 시퀀스'>
            <h3>통신 시퀀스 · 네 인스턴스</h3>
            <p>
              점선은 요청·예정, 실선은 실제 수신, 원은 해당 인스턴스의 관찰입니다. 송신만으로 상대
              앱 완료를 뜻하지 않습니다.
            </p>
            <div className='stack-inline'>
              <label>
                계층 필터
                <select
                  value={layer}
                  onChange={(event) => {
                    setLayer(event.target.value as StackPanelQuery['layer']);
                    setPage(0);
                    setFollowSelection(false);
                  }}
                >
                  <option value='all'>모든 계층</option>
                  <option value='application'>응용 계층</option>
                  <option value='transport'>전송 계층</option>
                </select>
              </label>
              <label>
                <input
                  type='checkbox'
                  checked={filterTarget}
                  onChange={(event) => {
                    setFilterTarget(event.target.checked);
                    setPage(0);
                    setFollowSelection(false);
                  }}
                />
                선택 인스턴스만
              </label>
            </div>
            {model.sequence && (
              <>
                <Pager
                  label='시퀀스'
                  page={model.sequence.page}
                  pages={model.sequence.pages}
                  change={(next) => {
                    setPage(next);
                    setFollowSelection(false);
                  }}
                />
                <p>관찰 {model.sequence.total}개 · 페이지당 30개</p>
                <div className='stack-diagram-scroll'>
                  <svg
                    className='stack-sequence-svg'
                    width={900}
                    height={70 + model.sequence.rows.length * 42}
                    role='img'
                    aria-label='스택 통신 시퀀스 그림'
                  >
                    <title>실제 관찰의 인과 순서</title>
                    <defs>
                      <marker
                        id='stack-arrow'
                        markerWidth={8}
                        markerHeight={8}
                        refX={7}
                        refY={4}
                        orient='auto'
                      >
                        <path d='M0 0 L8 4 L0 8' fill='#315875' />
                      </marker>
                    </defs>
                    {endpoints.map((e, i) => (
                      <g key={stackTarget(e)}>
                        <text x={100 + i * 205} y={22} textAnchor='middle'>
                          {stackTarget(e)}
                        </text>
                        <line
                          x1={100 + i * 205}
                          y1={36}
                          x2={100 + i * 205}
                          y2={65 + (model.sequence?.rows.length ?? 0) * 42}
                          stroke='#b3c3d2'
                          strokeDasharray='4 4'
                        />
                      </g>
                    ))}
                    {model.sequence.rows.map((row, i) => {
                      const x =
                        100 +
                        Math.max(
                          0,
                          endpoints.findIndex((e) => stackTarget(e) === row.from),
                        ) *
                          205;
                      const tx =
                        100 +
                        Math.max(
                          0,
                          endpoints.findIndex((e) => stackTarget(e) === row.to),
                        ) *
                          205;
                      const y = 60 + i * 42;
                      return (
                        <g
                          key={row.id}
                          role='button'
                          tabIndex={0}
                          aria-label={`스택 관찰 ${row.cursor} ${row.title}`}
                          onClick={() => choose(row.id, row.cursor)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              choose(row.id, row.cursor);
                            }
                          }}
                        >
                          <rect
                            x={0}
                            y={y - 18}
                            width={900}
                            height={40}
                            fill={row.id === selected ? '#e4edf7' : 'transparent'}
                          />
                          {row.from === row.to ? (
                            <circle cx={x} cy={y + 9} r={4} fill='#315875' />
                          ) : (
                            <line
                              x1={x}
                              y1={y + 9}
                              x2={tx === x ? x + 32 : tx}
                              y2={y + 9}
                              stroke='#315875'
                              strokeDasharray={row.pending ? '5 3' : undefined}
                              markerEnd='url(#stack-arrow)'
                            />
                          )}
                          <text x={8} y={y - 3} fontSize={11}>
                            #{row.cursor} · {row.timeMs}ms · {row.title.slice(0, 105)}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </>
            )}
          </section>
          <section className='stack-card stack-detail' aria-label='스택 관찰 상세'>
            <h3>
              선택 관찰{' '}
              {model.selected ? `#${model.selected.cursor} · ${model.selected.target}` : '없음'}
            </h3>
            <div className='stack-tabs'>
              {(
                [
                  ['event', '이벤트·연결'],
                  ['explanation', '규칙·변수 이유'],
                  ['structure', '메시지 구조'],
                  ['diagnosis', '실패 원인'],
                ] as const
              ).map(([id, label]) => (
                <button
                  type='button'
                  key={id}
                  aria-pressed={detail === id}
                  onClick={() => setDetail(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            {detail === 'event' && (
              <>
                {model.selected && <pre>{model.selected.preview}</pre>}
                {model.links && (
                  <>
                    <h4>직접 원인</h4>
                    <Rows rows={model.links.causes} select={choose} />
                    <h4>직접 후속 관찰</h4>
                    <Rows rows={model.links.children} select={choose} />
                    <h4>관찰된 전이</h4>
                    <Rows rows={model.links.commits} select={choose} />
                    {model.links.limited && (
                      <p>인과 탐색·표시 한도입니다. 생략 관찰을 추정하지 않습니다.</p>
                    )}
                  </>
                )}
              </>
            )}
            {detail === 'explanation' &&
              (model.explanation ? (
                <>
                  <p>
                    {model.explanation.status} · {model.explanation.message}
                  </p>
                  {model.explanation.candidates.map((candidate) => (
                    <div key={candidate.id}>
                      <h4>
                        {candidate.id} · {candidate.selected ? '선택됨' : candidate.result}
                      </h4>
                      {candidate.conditions.map((condition) => (
                        <p key={condition.path}>
                          {condition.path} · {String(condition.result)} · {condition.left} /{' '}
                          {condition.right}
                        </p>
                      ))}
                      {candidate.limited && <p>조건 처음 3개 표시</p>}
                    </div>
                  ))}
                  <h4>순차 대입</h4>
                  {model.explanation.assignments.map((a) => (
                    <p key={`${a.index}:${a.id}`}>
                      {a.id}: {a.before} → {a.after}
                    </p>
                  ))}
                  <h4>관찰된 최종 변화</h4>
                  {model.explanation.changes.map((c) => (
                    <p key={c.id}>
                      {c.id}: {c.before} → {c.after}
                    </p>
                  ))}
                </>
              ) : (
                <p>관찰된 transition을 선택하세요.</p>
              ))}
            {detail === 'structure' &&
              (model.structure ? (
                <>
                  <p>
                    {model.structure.status} · {model.structure.codec} · {model.structure.note}
                  </p>
                  {model.structure.fields.map((f) => (
                    <button
                      type='button'
                      className='diagnostic-link'
                      key={f.id}
                      onClick={() => {
                        setField(f.id);
                        if (f.range) setBytePage(Math.floor(f.range.start / 256));
                      }}
                    >
                      {f.name} ({f.type}) · {f.value}
                      {f.range ? ` · bytes ${f.range.start}..${f.range.end}` : ' · 논리 배치'}
                    </button>
                  ))}
                  <p>필드 {model.structure.totalFields}개 · 표시 최대 20개</p>
                  <label>
                    실제 byte 범위
                    <select
                      value={rangeIndex}
                      onChange={(event) => {
                        setRangeIndex(Number(event.target.value));
                        setBytePage(0);
                      }}
                    >
                      {model.structure.ranges.map((range, i) => (
                        <option
                          key={`${range.payloadId}:${range.offset}:${range.length}`}
                          value={i}
                        >
                          {range.payloadId.slice(0, 60)} · {range.offset}..
                          {range.offset + range.length}
                        </option>
                      ))}
                    </select>
                  </label>
                  {model.structure.totalRanges > 20 && <p>범위 처음 20개 표시</p>}
                  {model.structure.bytePage ? (
                    <>
                      <Pager
                        label='바이트'
                        page={model.structure.bytePage.page}
                        pages={model.structure.bytePage.pages}
                        change={setBytePage}
                      />
                      <div role='group' className='stack-byte-window' aria-label='스택 바이트 창'>
                        {model.structure.bytePage.values.map((byte, i) => {
                          const offset = (model.structure?.bytePage?.start ?? 0) + i;
                          const range = model.structure?.fields.find((f) => f.id === field)?.range;
                          return (
                            <span
                              key={offset}
                              title={`offset ${offset}`}
                              className={
                                range && offset >= range.start && offset < range.end
                                  ? 'stack-byte byte-selected'
                                  : 'stack-byte'
                              }
                            >
                              {byte.toString(16).padStart(2, '0')}
                            </span>
                          );
                        })}
                      </div>
                      <p>offset {model.structure.bytePage.start} · 최대 256 bytes</p>
                    </>
                  ) : (
                    <p>이 관찰에 기록된 원시 bytes가 없습니다.</p>
                  )}
                  {model.structure.limited && (
                    <p>분석·표시 한도입니다. 전체 artifact는 bundle에 보존합니다.</p>
                  )}
                </>
              ) : (
                <p>메시지 또는 bytes를 가진 관찰을 선택하세요.</p>
              ))}
            {detail === 'diagnosis' && (
              <>
                <label>
                  진단할 기대 조건
                  <select
                    value={expectationId}
                    onChange={(event) => setExpectationId(event.target.value)}
                  >
                    <option value=''>기대 조건 선택</option>
                    {model.expectations.map((e) => (
                      <option key={e.expectationId} value={e.expectationId}>
                        {e.expectationId} · {e.status}
                      </option>
                    ))}
                  </select>
                </label>
                {model.diagnosis && (
                  <>
                    <p>
                      {model.diagnosis.status} · {model.diagnosis.note}
                    </p>
                    <p>기대 {model.diagnosis.expected}</p>
                    <p>관찰 {model.diagnosis.observed}</p>
                    <h4>직접 판정 근거</h4>
                    <Rows rows={model.diagnosis.evidence} select={choose} />
                    <h4>관찰된 원인 경로</h4>
                    <Rows rows={model.diagnosis.ancestors} select={choose} />
                    <h4>참고 관찰</h4>
                    <Rows rows={model.diagnosis.references} select={choose} />
                    {model.diagnosis.limited && <p>탐색·표시 한도입니다.</p>}
                  </>
                )}
              </>
            )}
          </section>
        </>
      )}
    </section>
  );
}
