import { useState } from 'react';
import {
  BREAKPOINT_OPERATORS,
  BREAKPOINT_POLICY,
  type Breakpoint,
  type BreakpointSettings,
  type BreakpointStop,
} from '../application/breakpoints.ts';
import { workspaceId } from '../application/workspace-operations.ts';
import type { ExperimentDefinition, ModelDiagnostic } from '../domain/protocol-model.ts';
import { useDiagramPanel } from './useDiagramPanel.ts';

const operators = { eq: '=', ne: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥' };
/** Configure tab-local debugger points using the current execution source, independently of protocol edits. */
export function BreakpointsPanel({
  configuration,
  settings,
  diagnostics,
  onChange,
  stop,
  historical,
  running,
  canContinue,
  onContinue,
  onInspect,
  revealRequest,
  canExplain,
}: {
  configuration: ExperimentDefinition;
  settings: BreakpointSettings;
  diagnostics: readonly ModelDiagnostic[];
  onChange: (settings: BreakpointSettings) => void;
  stop: BreakpointStop | undefined;
  historical: boolean;
  running: boolean;
  canContinue: boolean;
  onContinue: () => void;
  onInspect: (id: string, explain: boolean) => void;
  revealRequest: number;
  canExplain: boolean;
}) {
  const panel = useDiagramPanel(revealRequest);
  const [selectedId, setSelectedId] = useState<string>();
  const selected = settings.points.find((item) => item.id === selectedId) ?? settings.points[0];
  function protocol(participant: 'A' | 'B') {
    const ref = configuration.protocols[participant];
    return configuration.definitions.find(
      (item) => item.id === ref.id && item.revision === ref.revision,
    );
  }
  const source = selected ? protocol(selected.participant) : protocol('A');
  const options =
    selected?.kind === 'message'
      ? source?.messages
      : selected?.kind === 'variable'
        ? source?.variables
        : source?.states;
  function update(change: Partial<Breakpoint>) {
    if (selected)
      onChange({
        ...settings,
        points: settings.points.map((item) =>
          item.id === selected.id ? { ...item, ...change } : item,
        ),
      });
  }
  function retarget(participant: 'A' | 'B', kind: Breakpoint['kind']) {
    const definition = protocol(participant);
    update({
      participant,
      kind,
      protocolId: definition?.id ?? '',
      protocolRevision: definition?.revision ?? 1,
      targetId:
        (kind === 'state'
          ? definition?.states
          : kind === 'message'
            ? definition?.messages
            : definition?.variables)?.[0]?.id ?? '',
      operator: 'eq',
      literal: '0',
    });
  }
  function add(copy = false) {
    if (settings.points.length >= BREAKPOINT_POLICY.points) return;
    const definition = protocol('A');
    const point: Breakpoint = {
      id: workspaceId('breakpoint'),
      label: `중단점 ${settings.points.length + 1}`,
      enabled: true,
      participant: 'A',
      protocolId: definition?.id ?? '',
      protocolRevision: definition?.revision ?? 1,
      kind: 'state',
      targetId: definition?.states[0]?.id ?? '',
      operator: 'eq',
      literal: '0',
    };
    const next =
      copy && selected
        ? { ...selected, id: point.id, label: `${selected.label.slice(0, 72)} 사본` }
        : point;
    onChange({ ...settings, points: [...settings.points, next] });
    setSelectedId(next.id);
  }
  return (
    <details
      ref={panel.ref}
      className='breakpoints-panel'
      open={panel.expanded}
      onToggle={(event) => panel.onToggle(event.currentTarget.open)}
    >
      <summary>중단점과 조건부 정지</summary>
      {panel.expanded && (
        <>
          <p className='hint'>
            중단점은 이 탭에서 실험별로 유지하며 새로고침하면 초기화됩니다. 프로토콜·결과에는
            저장하지 않습니다. 반복/회귀 일괄 실행에는 적용하지 않고 개별 기록 재생에서 사용합니다.
          </p>
          <label className='breakpoint-toggle'>
            <input
              type='checkbox'
              checked={settings.enabled}
              onChange={(event) => onChange({ ...settings, enabled: event.target.checked })}
            />
            중단점 사용
          </label>
          <div className='sequence-controls'>
            <button type='button' disabled={settings.points.length >= 20} onClick={() => add()}>
              중단점 추가
            </button>
            <button
              type='button'
              disabled={!selected || settings.points.length >= 20}
              onClick={() => add(true)}
            >
              중단점 복제
            </button>
            <button
              type='button'
              disabled={!selected}
              onClick={() =>
                onChange({
                  ...settings,
                  points: settings.points.filter((item) => item.id !== selected?.id),
                })
              }
            >
              선택 중단점 삭제
            </button>
          </div>
          {selected && (
            <fieldset>
              <legend>중단점 편집 · {settings.points.length}/20</legend>
              <label>
                편집할 중단점
                <select
                  aria-label='편집할 중단점'
                  value={selected.id}
                  onChange={(event) => setSelectedId(event.target.value)}
                >
                  {settings.points.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label.slice(0, 80)} · {item.enabled ? '활성' : '비활성'}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                중단점 이름
                <input
                  aria-label='중단점 이름'
                  maxLength={80}
                  value={selected.label}
                  onChange={(event) => update({ label: event.target.value })}
                />
              </label>
              <label className='breakpoint-toggle'>
                <input
                  type='checkbox'
                  checked={selected.enabled}
                  onChange={(event) => update({ enabled: event.target.checked })}
                />
                선택 중단점 활성화
              </label>
              <label>
                중단점 참여자
                <select
                  aria-label='중단점 참여자'
                  value={selected.participant}
                  onChange={(event) => retarget(event.target.value as 'A' | 'B', selected.kind)}
                >
                  <option>A</option>
                  <option>B</option>
                </select>
              </label>
              <label>
                정지 조건 종류
                <select
                  aria-label='정지 조건 종류'
                  value={selected.kind}
                  onChange={(event) =>
                    retarget(selected.participant, event.target.value as Breakpoint['kind'])
                  }
                >
                  <option value='state'>상태 진입</option>
                  <option value='message'>메시지 수신 (해석 완료)</option>
                  <option value='variable'>전이 후 변수 조건</option>
                </select>
              </label>
              <label>
                중단점 대상
                <select
                  aria-label='중단점 대상'
                  value={selected.targetId}
                  onChange={(event) =>
                    update({
                      targetId: event.target.value,
                      protocolId: source?.id ?? '',
                      protocolRevision: source?.revision ?? 1,
                    })
                  }
                >
                  {!options?.some((item) => item.id === selected.targetId) && (
                    <option value={selected.targetId}>대상을 다시 선택하세요</option>
                  )}
                  {options?.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.id}
                    </option>
                  ))}
                </select>
              </label>
              {selected.kind === 'variable' && (
                <>
                  <label>
                    변수 비교 연산자
                    <select
                      aria-label='변수 비교 연산자'
                      value={selected.operator}
                      onChange={(event) =>
                        update({ operator: event.target.value as Breakpoint['operator'] })
                      }
                    >
                      {BREAKPOINT_OPERATORS.map((operator) => (
                        <option key={operator} value={operator}>
                          {operators[operator]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    변수 비교 값 (JSON)
                    <textarea
                      aria-label='변수 비교 값 (JSON)'
                      rows={3}
                      value={selected.literal}
                      onChange={(event) => update({ literal: event.target.value })}
                    />
                  </label>
                </>
              )}
              <p>
                참조: {selected.protocolId} · 설정 당시 revision {selected.protocolRevision} · 현재
                대상 revision {source?.revision}. 같은 프로토콜의 새 revision은 대상 ID/타입을 다시
                검사합니다. 대상 선택은 위 실행/재생의 snapshot을 사용합니다.
              </p>
            </fieldset>
          )}
          {diagnostics.length > 0 && (
            <section aria-label='중단점 설정 진단' role='alert'>
              {diagnostics.slice(0, 20).map((item) => (
                <p key={`${item.path}-${item.message}`}>{item.message}</p>
              ))}
              <p>
                자동 실행/재생을 시작하려면 수정하거나 비활성화하세요. 수동 한 단계·기록 이동은
                가능합니다.
              </p>
            </section>
          )}
          <p className='hint'>
            {historical
              ? '과거 재생은 기록 이벤트 하나마다 검사합니다.'
              : '실행은 처리 한 단계를 완료한 뒤 정지합니다. 합쳐 읽기에서는 일치 뒤의 메시지/규칙도 같은 단계 안에서 처리될 수 있습니다.'}{' '}
            상태 자기 전이는 진입으로 세지 않으며 변수 조건은 매 실제 전이 후에 검사합니다.
          </p>
          <button
            type='button'
            disabled={!canContinue || running || diagnostics.length > 0}
            onClick={onContinue}
          >
            {historical ? '이 기록 계속 재생' : '이 실행 계속'}
          </button>
          {stop && (
            <section aria-label='중단점 정지 근거' data-breakpoint-kind={stop.kind}>
              <h3>
                {stop.kind === 'match' ? '중단점 정지' : '중단점 평가 중 정지'} ·{' '}
                {stop.event.participant} · {stop.event.eventId} · {stop.event.timeMs} ms
              </h3>
              {stop.hits.map((hit) => (
                <p key={hit.id}>
                  <strong>{hit.label}</strong> · {hit.detail}
                </p>
              ))}
              <p>
                일치 이벤트 뒤 같은 처리 단계에서 기록 {stop.trailingEvents}개를 더 관찰했습니다.
                실행 오류나 기대 조건 실패를 추가하지 않습니다.
              </p>
              <div className='sequence-controls'>
                <button type='button' onClick={() => onInspect(stop.event.eventId, false)}>
                  정지 기록 보기
                </button>
                <button
                  type='button'
                  disabled={!canExplain}
                  onClick={() => onInspect(stop.event.eventId, true)}
                >
                  정지 실행 설명 보기
                </button>
              </div>
              {!canExplain && (
                <p>
                  현재 구간에 실제 전이가 없습니다. 수동으로 다음 기록을 관찰한 뒤 실행 설명을
                  확인하세요.
                </p>
              )}
            </section>
          )}
        </>
      )}
    </details>
  );
}
