/** biome-ignore-all lint/a11y/useSemanticElements: Interactive SVG groups need button/group roles; HTML button/fieldset elements cannot be direct SVG children. */
/** biome-ignore-all lint/suspicious/noArrayIndexKey: Read-only action rows have no state and are replaced with their protocol revision. */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type FocusEvent,
} from 'react';
import {
  buildStateDiagram,
  DIAGRAM_NODE_SIZE,
  DIAGRAM_POLICY,
} from '../application/state-diagram.ts';
import { previewJson } from '../application/preview-json.ts';
import type { JsonValue, ParticipantId } from '../domain/execution-contract.ts';
import type {
  Action,
  Condition,
  ProtocolDefinition,
  RuleEvent,
  ValueExpression,
} from '../domain/protocol-model.ts';

export type DiagramActor = {
  readonly participant: ParticipantId;
  readonly stateId: string;
  readonly outcome: string;
  readonly ruleIndex: number | undefined;
};
const EMPTY_ACTORS: readonly DiagramActor[] = [];
const short = (text: string, size = 24) => (text.length > size ? `${text.slice(0, size)}…` : text);
function expression(value: ValueExpression, depth = 0): string {
  if (depth > 6) return '…';
  if (value.kind === 'literal') return short(previewJson(value.value).text, 80);
  if (value.kind === 'field') return `필드 ${short(value.fieldId)}`;
  if (value.kind === 'variable') return `변수 ${short(value.variableId)}`;
  return short(
    `(${expression(value.left, depth + 1)} ${value.kind === 'add' ? '+' : '−'} ${expression(value.right, depth + 1)})`,
    160,
  );
}
function conditionText(condition: Condition | undefined, depth = 0): string {
  if (!condition) return '추가 조건 없음';
  if (depth > 6) return '…';
  if (condition.kind === 'compare') {
    const operators = { eq: '=', ne: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥' };
    return short(
      `${expression(condition.left)} ${operators[condition.operator]} ${expression(condition.right)}`,
      180,
    );
  }
  if (condition.kind === 'not')
    return short(`아님 (${conditionText(condition.condition, depth + 1)})`, 180);
  return short(
    condition.conditions
      .slice(0, 8)
      .map((item) => conditionText(item, depth + 1))
      .join(condition.kind === 'all' ? ' 그리고 ' : ' 또는 ') +
      (condition.conditions.length > 8 ? '…' : ''),
    180,
  );
}
function eventText(event: RuleEvent): string {
  if (event.kind === 'input') return `입력 ${short(event.messageId)}`;
  if (event.kind === 'receive') return `수신 ${short(event.messageId)}`;
  if (event.kind === 'timer') return `만료 ${short(event.timerId)}`;
  if (event.kind === 'connection') return `연결 ${event.state === 'closed' ? '종료' : '실패'}`;
  return '';
}
function actionText(action: Action): string {
  if (action.kind === 'send' || action.kind === 'deliver')
    return `${action.kind === 'send' ? '하위로 전송' : '상위로 전달'} · ${short(action.messageId)}`;
  if (action.kind === 'assign')
    return short(`${action.variableId} ← ${expression(action.value)}`, 180);
  if (action.kind === 'start-timer')
    return short(`타이머 ${action.timerId} 시작 · ${expression(action.durationMs)} ms`, 180);
  if (action.kind === 'cancel-timer') return `타이머 ${short(action.timerId)} 취소`;
  if (action.kind === 'finish') return `${action.outcome === 'success' ? '성공' : '실패'}로 종료`;
  return '';
}
function activate(event: KeyboardEvent<SVGGElement>, callback: () => void) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    callback();
  }
}

function revealKeyboardFocus(event: FocusEvent<SVGGElement>) {
  if (event.currentTarget.matches(':focus-visible'))
    event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** Render an authored or frozen protocol as an accessible, paginated, read-only state diagram. */
export function StateDiagram({
  protocol,
  title,
  source,
  actors = EMPTY_ACTORS,
  onEdit,
}: {
  protocol: ProtocolDefinition;
  title: string;
  source: string;
  actors?: readonly DiagramActor[];
  onEdit?: ((kind: 'state' | 'rule', index: number) => void) | undefined;
}) {
  const marker = `diagram-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [statePage, setStatePage] = useState(0);
  const [rulePage, setRulePage] = useState(0);
  const [zoom, setZoom] = useState(0.75);
  const [followFocus, setFollowFocus] = useState(0);
  const selectedGraphic = useRef<SVGGElement | null>(null);
  const [selection, setSelection] = useState<
    { kind: 'state'; key: string } | { kind: 'rule'; index: number }
  >();
  const followRule = actors.find((actor) => actor.ruleIndex !== undefined)?.ruleIndex;
  const requestedRulePage =
    !selection && followRule !== undefined
      ? Math.floor(followRule / DIAGRAM_POLICY.rulesPerPage)
      : rulePage;
  const currentKey = JSON.stringify(actors.map((actor) => actor.stateId));
  const graph = useMemo(
    () =>
      buildStateDiagram(protocol, {
        statePage,
        rulePage: requestedRulePage,
        currentStateIds: JSON.parse(currentKey) as string[],
      }),
    [protocol, statePage, requestedRulePage, currentKey],
  );
  const selectedRuleIndex =
    selection?.kind === 'rule'
      ? selection.index
      : selection?.kind === 'state'
        ? undefined
        : (followRule ?? graph.visibleRules[0]);
  const rule = selectedRuleIndex === undefined ? undefined : protocol.rules[selectedRuleIndex];
  const node =
    selection?.kind === 'state'
      ? graph.nodes.find((item) => item.key === selection.key)
      : undefined;
  useEffect(() => {
    if (graph.nodes.length && (selection || followFocus > 0))
      selectedGraphic.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selection, followFocus, graph]);
  function selectRule(index: number) {
    setFollowFocus(0);
    setSelection({ kind: 'rule', index });
    setRulePage(Math.floor(index / DIAGRAM_POLICY.rulesPerPage));
  }
  const size = DIAGRAM_NODE_SIZE;
  return (
    <section className='state-diagram' aria-label={title}>
      <div className='section-heading'>
        <h2>{title}</h2>
        <span className='diagram-source'>{source}</span>
      </div>
      <p className='hint'>
        초기·종료 상태와 규칙을 자동으로 그립니다. 화살표 또는 규칙 라벨을 선택하면 조건·동작을
        확인합니다. 같은 두 상태를 잇는 규칙은 한 화살표에 묶습니다.
      </p>
      <div className='diagram-legend'>
        <span>→ 초기</span>
        <span>이중 테두리: 종료</span>
        <span>현재 A/B: 실행 위치</span>
        <span>굵은 화살표: 최근 적용</span>
        <span>점선: 선택</span>
      </div>
      {!!actors.length && (
        <p className='diagram-runtime'>
          {actors
            .map(
              (actor) =>
                `${actor.participant}: ${short(actor.stateId)} (${actor.outcome}) · 최근 규칙 ${actor.ruleIndex === undefined ? '없음' : short(protocol.rules[actor.ruleIndex]?.id ?? '')}`,
            )
            .join(' / ')}
        </p>
      )}
      <nav className='diagram-controls' aria-label={`${title} 페이지 이동`}>
        <button
          type='button'
          disabled={graph.statePage === 0}
          onClick={() => {
            setStatePage(graph.statePage - 1);
            setSelection({
              kind: 'state',
              key: `state-${(graph.statePage - 1) * DIAGRAM_POLICY.statesPerPage}`,
            });
          }}
        >
          상태 이전 페이지
        </button>
        <span>
          상태 {graph.statePage + 1}/{graph.statePages} · 전체 {protocol.states.length}개
        </span>
        <button
          type='button'
          disabled={graph.statePage + 1 >= graph.statePages}
          onClick={() => {
            setStatePage(graph.statePage + 1);
            setSelection({
              kind: 'state',
              key: `state-${(graph.statePage + 1) * DIAGRAM_POLICY.statesPerPage}`,
            });
          }}
        >
          상태 다음 페이지
        </button>
        <button
          type='button'
          disabled={graph.rulePage === 0}
          onClick={() => selectRule((graph.rulePage - 1) * DIAGRAM_POLICY.rulesPerPage)}
        >
          규칙 이전 페이지
        </button>
        <span>
          규칙 {graph.rulePage + 1}/{graph.rulePages} · 전체 {protocol.rules.length}개
        </span>
        <button
          type='button'
          disabled={graph.rulePage + 1 >= graph.rulePages}
          onClick={() => selectRule((graph.rulePage + 1) * DIAGRAM_POLICY.rulesPerPage)}
        >
          규칙 다음 페이지
        </button>
        <label>
          크기{' '}
          <select
            aria-label={`${title} 크기`}
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
          >
            <option value={0.75}>75%</option>
            <option value={1}>100%</option>
            <option value={1.25}>125%</option>
          </select>
        </label>
        {!!actors.length && (
          <button
            type='button'
            onClick={() => {
              setSelection(undefined);
              setFollowFocus((value) => value + 1);
              setStatePage(0);
            }}
          >
            현재 실행 위치 따라가기
          </button>
        )}
      </nav>
      {(graph.statePages > 1 || graph.rulePages > 1) && (
        <p className='hint'>
          페이지의 상태에 더해 현재 규칙의 양 끝·초기·현재 상태를 함께 표시합니다. 나머지
          상태·규칙은 페이지를 이동해 확인하세요.
        </p>
      )}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: A scrollable canvas needs a keyboard target for native arrow-key panning. */}
      <section className='diagram-canvas' tabIndex={0} aria-label={`${title} 그림 영역`}>
        <svg
          width={graph.width * zoom}
          height={graph.height * zoom}
          viewBox={`0 0 ${graph.width} ${graph.height}`}
          role='group'
          aria-label={`${title} 상태와 전이`}
        >
          <title>
            {title} · {short(protocol.label, 80)}
          </title>
          <defs>
            <marker
              id={marker}
              viewBox='0 0 10 10'
              refX={9}
              refY={5}
              markerWidth={7}
              markerHeight={7}
              orient='auto-start-reverse'
            >
              <path d='M 0 0 L 10 5 L 0 10 z' fill='context-stroke' />
            </marker>
          </defs>
          {graph.nodes
            .filter((item) => item.initial)
            .map((item) => (
              <g key={`initial-${item.key}`}>
                <circle cx={item.x - 34} cy={item.y + size.height / 2} r={4} fill='#536c8c' />
                <path
                  d={`M ${item.x - 28} ${item.y + size.height / 2} L ${item.x - 4} ${item.y + size.height / 2}`}
                  fill='none'
                  stroke='#536c8c'
                  strokeWidth={1.8}
                  markerEnd={`url(#${marker})`}
                />
              </g>
            ))}
          {graph.edges.map((edge) => {
            const applied = actors.filter(
              (actor) =>
                actor.ruleIndex !== undefined && edge.ruleIndices.includes(actor.ruleIndex),
            );
            const selected =
              selectedRuleIndex !== undefined && edge.ruleIndices.includes(selectedRuleIndex);
            const first = protocol.rules[edge.ruleIndices[0] ?? -1];
            const label =
              edge.ruleIndices.length === 1
                ? short(first?.id || '(빈 규칙 ID)', 16)
                : `${edge.ruleIndices.length}개 규칙`;
            const choose = () => selectRule(applied[0]?.ruleIndex ?? edge.ruleIndices[0] ?? 0);
            return (
              <g
                key={edge.key}
                ref={selected && !followFocus ? selectedGraphic : undefined}
                className={`diagram-edge ${applied.length ? 'is-applied' : ''} ${selected ? 'is-selected' : ''}`}
                role='button'
                tabIndex={0}
                aria-pressed={selected}
                aria-label={`상태도 규칙 ${edge.ruleIndices.map((index) => short(protocol.rules[index]?.id || '(빈 ID)')).join(', ')} 선택${applied.length ? ` · 최근 적용 ${applied.map((actor) => actor.participant).join(',')}` : ''}`}
                onClick={choose}
                onKeyDown={(event) => activate(event, choose)}
                onFocus={revealKeyboardFocus}
              >
                <path className='diagram-edge-hit' d={edge.path} />
                <path className='diagram-edge-line' d={edge.path} markerEnd={`url(#${marker})`} />
                {(edge.anchorX !== edge.labelX || edge.anchorY !== edge.labelY) && (
                  <path
                    className='diagram-edge-connector'
                    d={`M ${edge.anchorX} ${edge.anchorY} L ${edge.labelX} ${edge.labelY}`}
                  />
                )}
                <rect x={edge.labelX - 54} y={edge.labelY - 22} width={108} height={44} rx={7} />
                <text x={edge.labelX} y={edge.labelY - 4}>
                  {label}
                </text>
                <text x={edge.labelX} y={edge.labelY + 12} className='diagram-event-label'>
                  {edge.ruleIndices.length > 1
                    ? '개별 규칙 선택'
                    : short(first ? eventText(first.event) : '', 14)}
                </text>
              </g>
            );
          })}
          {graph.nodes.map((item) => {
            const current = actors.filter((actor) => actor.stateId === item.id && !item.problem);
            const selected = selection?.kind === 'state' && selection.key === item.key;
            const choose = () => {
              setFollowFocus(0);
              setSelection({ kind: 'state', key: item.key });
            };
            const badges = [
              item.initial ? '초기' : '',
              item.terminal ? '종료' : '',
              current.length ? `현재 ${current.map((actor) => actor.participant).join('·')}` : '',
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <g
                key={item.key}
                ref={
                  selected ||
                  (!selection &&
                    followFocus > 0 &&
                    current.some((actor) => actor.participant === actors[0]?.participant))
                    ? selectedGraphic
                    : undefined
                }
                className={`diagram-node ${item.problem ? 'is-invalid' : ''} ${current.length ? 'is-current' : ''} ${selected ? 'is-selected' : ''}`}
                role='button'
                tabIndex={0}
                aria-pressed={selected}
                aria-label={`상태 ${short(item.id || '(빈 ID)', 80)} · ${short(item.label, 80)}${badges ? ` · ${badges}` : ''}${item.problem ? ` · ${item.problem}` : ''}`}
                data-state-index={item.stateIndex}
                data-current-participants={current.map((actor) => actor.participant).join(',')}
                onClick={choose}
                onKeyDown={(event) => activate(event, choose)}
                onFocus={revealKeyboardFocus}
              >
                <rect x={item.x} y={item.y} width={size.width} height={size.height} rx={14} />
                {item.terminal && (
                  <rect
                    className='diagram-terminal-ring'
                    x={item.x + 5}
                    y={item.y + 5}
                    width={size.width - 10}
                    height={size.height - 10}
                    rx={10}
                  />
                )}
                <text x={item.x + size.width / 2} y={item.y + 27} className='diagram-node-title'>
                  {short(item.label || item.id || '이름 없는 상태', 14)}
                </text>
                <text x={item.x + size.width / 2} y={item.y + 49}>
                  {short(item.id || '(빈 ID)', 22)}
                </text>
                <text x={item.x + size.width / 2} y={item.y + 73} className='diagram-node-badge'>
                  {item.problem || badges}
                </text>
              </g>
            );
          })}
        </svg>
      </section>
      <label className='control'>
        <span>페이지의 개별 규칙 선택</span>
        <select
          aria-label={`${title} 규칙 선택`}
          value={rule ? selectedRuleIndex : ''}
          onChange={(event) => selectRule(Number(event.target.value))}
        >
          <option value='' disabled>
            규칙을 선택하세요
          </option>
          {graph.visibleRules.map((index) => (
            <option key={index} value={index}>
              {short(protocol.rules[index]?.id || '(빈 ID)', 80)} ·{' '}
              {protocol.rules[index] ? eventText(protocol.rules[index].event) : ''}
            </option>
          ))}
        </select>
      </label>
      {rule && (
        <section className='diagram-detail' aria-label={`${title} 선택 규칙`}>
          <h3>규칙 {short(rule.id || '(빈 ID)', 80)}</h3>
          <p>
            {short(rule.fromStateId)} → {short(rule.nextStateId)} · {eventText(rule.event)}
            {rule.ignore ? ' · 명시적 무시' : ''}
          </p>
          <p>
            <strong>조건:</strong> {conditionText(rule.condition)}
          </p>
          <strong>동작</strong>
          {rule.actions.length ? (
            <ol>
              {rule.actions.slice(0, 32).map((action, index) => (
                <li key={`${index}-${action.kind}`}>{actionText(action)}</li>
              ))}
            </ol>
          ) : (
            <p>추가 동작 없음</p>
          )}
          {rule.actions.length > 32 && (
            <p>앞 32개만 표시합니다. 전체 내용은 편집 위치에서 확인하세요.</p>
          )}
          <details>
            <summary>규칙 값 자세히 보기</summary>
            <pre>{previewJson(rule as unknown as JsonValue).text}</pre>
          </details>
          <button
            type='button'
            disabled={!onEdit}
            onClick={() => selectedRuleIndex !== undefined && onEdit?.('rule', selectedRuleIndex)}
          >
            규칙 편집 위치로 이동
          </button>
        </section>
      )}
      {node && (
        <section className='diagram-detail' aria-label={`${title} 선택 상태`}>
          <h3>상태 {short(node.id || '(빈 ID)', 80)}</h3>
          <p>
            {short(node.label, 120)} · {node.initial ? '초기 상태' : '일반 상태'}
            {node.terminal ? ' · 종료 상태' : ''}
          </p>
          {node.problem && (
            <p className='diagram-problem'>
              {node.problem}입니다. 정의 진단에서 참조를 수정하세요.
            </p>
          )}
          <button
            type='button'
            disabled={!onEdit || node.stateIndex === undefined}
            onClick={() => node.stateIndex !== undefined && onEdit?.('state', node.stateIndex)}
          >
            상태 편집 위치로 이동
          </button>
        </section>
      )}
      {!protocol.rules.length && <p>규칙을 추가하면 상태 사이의 화살표를 표시합니다.</p>}
      {!onEdit && (
        <p className='hint'>
          실행 당시 정의가 현재 초안과 달라 편집 이동을 사용할 수 없습니다. 기록의 ‘이 설정을 새
          초안으로’에서 복원 사본을 만들 수 있습니다.
        </p>
      )}
    </section>
  );
}
