import { useMemo, useState } from 'react';
import type { DiagramEndpoint, DraftDiagramSelection } from '../application/diagram-authoring.ts';
import { validDiagramEndpoint } from '../application/diagram-authoring.ts';
import { blockingStackRaw } from '../application/edit-stack-list.ts';
import {
  captureStackDiagramSource,
  pendingStackDiagramCommand,
  prepareStackDiagramTransition,
  stackDiagramEvents,
  type StackDiagramAppend,
  type StackDiagramCommand,
  type StackDiagramSource,
} from '../application/stack-diagram-authoring.ts';
import type { StackEndpoint, StackProtocol, StackRuleEvent } from '../domain/stack-model.ts';
import { stackProtocolBody } from '../domain/stack-model.ts';
import { stackTarget } from '../domain/stack-record.ts';
import type { StackDraft } from '../domain/workspace-v2-model.ts';
import { StateDiagram } from './StateDiagram.tsx';

type Connection = {
  readonly source: StackDiagramSource;
  readonly from?: DiagramEndpoint;
  readonly to?: DiagramEndpoint;
  readonly event?: StackRuleEvent;
};
type Choice = { readonly value: string; readonly label: string; readonly disabled?: boolean };
function ChoiceControl({
  label,
  value,
  options,
  change,
}: {
  label: string;
  value: string;
  options: readonly Choice[];
  change: (value: string) => void;
}) {
  const [search, setSearch] = useState('');
  const filtered = options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()));
  const visible = filtered.slice(0, 20);
  const selected = options.find((o) => o.value === value);
  if (selected && !visible.some((o) => o.value === value)) visible.splice(19, 1, selected);
  return (
    <div>
      {options.length > 20 && (
        <label className='control'>
          <span>{label} 검색</span>
          <input value={search} maxLength={160} onChange={(e) => setSearch(e.target.value)} />
        </label>
      )}
      <label className='control'>
        <span>{label}</span>
        <select value={value} onChange={(e) => change(e.target.value)}>
          <option value='' disabled>
            선택하세요
          </option>
          {visible.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label.slice(0, 100)}
            </option>
          ))}
        </select>
      </label>
      {filtered.length > 20 && (
        <small>검색으로 나머지를 찾을 수 있습니다. 최대 20개를 표시합니다.</small>
      )}
    </div>
  );
}

/** Draw the current stack definition and stage connections without modifying a run or inventing effects. */
export function StackDraftDiagram({
  draft,
  endpoint,
  protocol,
  definition,
  selection,
  onSelect,
  append,
}: {
  draft: StackDraft;
  endpoint: StackEndpoint;
  protocol: StackProtocol;
  definition: number;
  selection: DraftDiagramSelection | undefined;
  onSelect: (selection: DraftDiagramSelection, updated?: StackDraft) => void;
  append: (
    source: StackDiagramSource,
    command: StackDiagramCommand,
  ) => StackDiagramAppend | undefined;
}) {
  const [connection, setConnection] = useState<Connection>();
  const [error, setError] = useState('');
  const body = stackProtocolBody(protocol);
  const graphic = useMemo(
    () => ({
      ...body,
      label: protocol.mode === 'legacy-application' ? protocol.source.label : protocol.label,
    }),
    [body, protocol],
  );
  const source = useMemo(() => captureStackDiagramSource(draft, endpoint), [draft, endpoint]);
  const active =
    connection &&
    source &&
    connection.source.configuration === source.configuration &&
    connection.source.raw === source.raw &&
    connection.source.version === source.version &&
    connection.source.draftId === source.draftId &&
    connection.source.definition === source.definition &&
    stackTarget(connection.source.endpoint) === stackTarget(endpoint)
      ? connection
      : undefined;
  const path = `/definitions/${definition}${protocol.mode === 'legacy-application' ? '/source' : ''}`;
  const statesBlocked = blockingStackRaw(draft.raw, `${path}/states`);
  const rulesBlocked = blockingStackRaw(draft.raw, `${path}/rules`);
  const blocked = [
    ...new Set([statesBlocked, rulesBlocked].filter((p): p is string => p !== undefined)),
  ];
  const choices = useMemo(() => stackDiagramEvents(protocol), [protocol]);
  const endpoints = body.states.map((state, index) => ({ index, id: state.id }));
  const stateCounts = new Map<string, number>();
  for (const state of body.states) stateCounts.set(state.id, (stateCounts.get(state.id) ?? 0) + 1);
  const endpointOptions = endpoints.map((e) => ({
    value: String(e.index),
    label: `${body.states[e.index]?.label} · ${e.id || '(빈 ID)'}`,
    disabled: !e.id.trim() || stateCounts.get(e.id) !== 1,
  }));
  const prepared =
    active?.from && active.to && active.event
      ? prepareStackDiagramTransition(protocol, active.from, active.to, active.event)
      : undefined;
  const pending =
    active?.from && active.to && active.event && source
      ? pendingStackDiagramCommand(draft, source, {
          kind: 'rule',
          from: active.from,
          to: active.to,
          event: active.event,
        })
      : undefined;
  function create(command: StackDiagramCommand) {
    const captured = command.kind === 'rule' ? active?.source : source;
    const result = captured && append(captured, command);
    if (!result) {
      setError('초안이나 미완성 입력이 바뀌었습니다. 현재 정의를 확인하고 다시 선택하세요.');
      return;
    }
    setConnection(undefined);
    setError('');
    onSelect(result.selection, result.draft);
  }
  function inspect(kind: 'state' | 'rule', index: number) {
    if (!active) {
      onSelect({ kind, index });
      return;
    }
    const state = body.states[index];
    if (kind !== 'state' || !state || !validDiagramEndpoint(body, { index, id: state.id })) {
      setError('연결에는 유일한 ID를 가진 상태를 선택하세요. 규칙 편집은 연결 취소 후 가능합니다.');
      return;
    }
    const selected = { index, id: state.id };
    setConnection({ ...active, ...(!active.from ? { from: selected } : { to: selected }) });
    setError('');
  }
  return (
    <section
      aria-label='스택 초안 상태도 작성'
      onKeyDown={(e) => {
        if (e.key === 'Escape' && connection) {
          e.stopPropagation();
          setConnection(undefined);
          setError('');
        }
      }}
    >
      <fieldset className='draft-diagram-tools' aria-label='스택 상태도 작성 도구'>
        <legend>현재 인스턴스의 상태·전이 작성</legend>
        <div className='diagram-controls'>
          <button
            type='button'
            disabled={!source || !!statesBlocked}
            onClick={() => create({ kind: 'state' })}
          >
            그림에 상태 추가
          </button>
          <button
            type='button'
            disabled={!source || !!statesBlocked || !!rulesBlocked}
            aria-pressed={!!active}
            onClick={() => {
              if (source) setConnection({ source });
              setError('');
            }}
          >
            전이 연결 시작
          </button>
          {connection && (
            <button
              type='button'
              onClick={() => {
                setConnection(undefined);
                setError('');
              }}
            >
              연결 취소
            </button>
          )}
        </div>
        <p className='hint'>
          현재 초안 · {stackTarget(endpoint)} · {protocol.id} r{protocol.revision}. 같은 정의를
          참조하는 인스턴스는 함께 바뀌며 실행 snapshot은 유지합니다.
        </p>
        {!source && <p role='alert'>중복 인스턴스 또는 정의 참조를 먼저 수정하세요.</p>}
        {connection && !active && (
          <p role='status'>초안이 변경되어 연결 선택을 초기화했습니다. 다시 연결을 시작하세요.</p>
        )}
        {!!blocked.length && (
          <p role='status'>
            미완성 JSON을 먼저 수정하세요. 상태도에서 하위 자료를 덮어쓰지 않습니다.
          </p>
        )}
        {active && (
          <>
            <p role='status'>
              {!active.from
                ? '출발 상태를 선택하세요.'
                : !active.to
                  ? '도착 상태를 선택하세요. 같은 상태를 고르면 자기 전이입니다.'
                  : '발생 이벤트를 확인하고 전이를 생성하세요.'}{' '}
              · Escape로 취소
            </p>
            <div className='form-grid'>
              {(['from', 'to'] as const).map((kind) => (
                <ChoiceControl
                  key={kind}
                  label={kind === 'from' ? '연결 출발 상태' : '연결 도착 상태'}
                  value={active[kind] ? String(active[kind].index) : ''}
                  options={endpointOptions}
                  change={(value) => {
                    const chosen = endpoints[Number(value)];
                    if (chosen) setConnection({ ...active, [kind]: chosen });
                  }}
                />
              ))}
              <label className='control'>
                <span>연결 발생 이벤트</span>
                <select
                  value={active.event?.kind ?? ''}
                  onChange={(e) => {
                    const choice = choices.find((c) => c.event.kind === e.target.value);
                    if (choice) setConnection({ ...active, event: choice.event });
                  }}
                >
                  <option value='' disabled>
                    이벤트 선택
                  </option>
                  {(
                    [
                      ['input', '시나리오 입력'],
                      ['receive', '메시지 수신'],
                      ['timer', '타이머 만료'],
                      ['connection', '연결 종료·실패'],
                      ['service-request', '상위 포트 요청'],
                      ['service-indication', '하위 포트 통지'],
                    ] as const
                  ).map(([kind, label]) => (
                    <option
                      key={kind}
                      value={kind}
                      disabled={!choices.some((c) => c.event.kind === kind)}
                    >
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {active.event && (
                <ChoiceControl
                  label='연결 이벤트 참조'
                  value={JSON.stringify(active.event)}
                  options={choices
                    .filter((c) => c.event.kind === active.event?.kind)
                    .map((c) => ({ value: JSON.stringify(c.event), label: c.label }))}
                  change={(value) => {
                    const choice = choices.find((c) => JSON.stringify(c.event) === value);
                    if (choice) setConnection({ ...active, event: choice.event });
                  }}
                />
              )}
            </div>
            {active.from && active.to && active.from.id === active.to.id && (
              <p>
                자기 전이는 동작 없이 명시적으로 무시하는 규칙으로 만듭니다. 동작을 추가하려면 선택
                편집기에서 무시를 해제하세요.
              </p>
            )}
            {prepared?.success && prepared.overlaps && (
              <p className='diagram-problem'>
                같은 출발 상태·이벤트의 규칙이 있습니다. 조건을 구분해 충돌을 해결해야 실행할 수
                있습니다.
              </p>
            )}
            {prepared && !prepared.success && <p role='alert'>{prepared.message}</p>}
            {pending && (
              <p role='status'>선택한 선언의 미완성 입력을 먼저 수정하세요. · {pending}</p>
            )}
            <button
              type='button'
              disabled={!prepared?.success || !!pending}
              onClick={() => {
                if (active.from && active.to && active.event)
                  create({ kind: 'rule', from: active.from, to: active.to, event: active.event });
              }}
            >
              전이 생성하고 편집
            </button>
            <p className='hint'>
              처음에는 상태 이동만 정의합니다. 조건·전송·타이머·완료 동작은 선택한 규칙의 폼에서
              추가하세요.
            </p>
          </>
        )}
        {error && <p role='alert'>{error}</p>}
      </fieldset>
      <StateDiagram
        protocol={graphic}
        title='스택 초안 상태도'
        source={`현재 초안 · ${stackTarget(endpoint)} · r${protocol.revision}`}
        draft={{ selection: active ? undefined : selection, revision: protocol.revision }}
        connection={active ? { from: active.from?.index, to: active.to?.index } : undefined}
        onInspect={inspect}
        onEdit={(kind, index) => {
          setConnection(undefined);
          onSelect({ kind, index });
        }}
      />
    </section>
  );
}
