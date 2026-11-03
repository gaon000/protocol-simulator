/** biome-ignore-all lint/suspicious/noArrayIndexKey: Option indices identify the exact state in an unfinished definition with potentially duplicate IDs. */
import {
  type DiagramEndpoint,
  type DraftDiagramAppend,
  newDiagramState,
  prepareDiagramTransition,
  validDiagramEndpoint,
} from '../application/diagram-authoring.ts';
import type { ProtocolDefinition, RuleEvent } from '../domain/protocol-model.ts';

export type DiagramConnection = {
  readonly revision: number;
  readonly protocolId: string;
  readonly from: DiagramEndpoint | undefined;
  readonly to: DiagramEndpoint | undefined;
  readonly event: RuleEvent | undefined;
};
/** Provide native controls for state creation and an explicit two-endpoint transition draft. */
export function DraftDiagramTools({
  protocol,
  connection,
  onChange,
  onAppend,
}: {
  protocol: ProtocolDefinition;
  connection: DiagramConnection | undefined;
  onChange: (value: DiagramConnection | undefined) => void;
  onAppend: (value: DraftDiagramAppend, revision: number) => boolean;
}) {
  const active =
    connection?.revision === protocol.revision && connection.protocolId === protocol.id
      ? connection
      : undefined;
  const prepared =
    active?.from && active.to && active.event
      ? prepareDiagramTransition(protocol, active.from, active.to, active.event)
      : undefined;
  const messages = protocol.messages.filter(
    (item) =>
      item.id.trim() && protocol.messages.filter((other) => other.id === item.id).length === 1,
  );
  const timers = protocol.timers.filter(
    (item) =>
      item.id.trim() && protocol.timers.filter((other) => other.id === item.id).length === 1,
  );
  const endpoints = protocol.states.map((state, index) => ({ index, id: state.id }));
  const chooseEndpoint = (kind: 'from' | 'to', index: number) => {
    if (active) onChange({ ...active, [kind]: endpoints[index] });
  };
  return (
    <fieldset className='draft-diagram-tools' aria-label='상태도 작성 도구'>
      <legend>초안 상태도 편집</legend>
      <div className='diagram-controls'>
        <button
          type='button'
          onClick={() => {
            if (onAppend({ kind: 'state', value: newDiagramState(protocol) }, protocol.revision))
              onChange(undefined);
          }}
        >
          그림에 상태 추가
        </button>
        <button
          type='button'
          aria-pressed={!!active}
          onClick={() =>
            onChange({
              protocolId: protocol.id,
              revision: protocol.revision,
              from: undefined,
              to: undefined,
              event: undefined,
            })
          }
        >
          전이 연결 시작
        </button>
        {!!active && (
          <button type='button' onClick={() => onChange(undefined)}>
            연결 취소
          </button>
        )}
      </div>
      {!active && (
        <p className='hint'>
          {connection
            ? '정의가 변경되어 연결 선택을 초기화했습니다. 다시 연결을 시작하세요.'
            : '상태/규칙을 선택하면 옆 편집기에서 수정합니다. 전이는 연결 시작 후 출발·도착 상태를 순서대로 고릅니다.'}
        </p>
      )}
      {active && (
        <>
          <p role='status'>
            {!active.from
              ? '출발 상태를 선택하세요.'
              : !active.to
                ? '도착 상태를 선택하세요. 같은 상태를 다시 선택하면 자기 전이를 만듭니다.'
                : '발생 이벤트를 확인하고 전이를 생성하세요.'}{' '}
            · Escape로 취소
          </p>
          <div className='form-grid'>
            {(['from', 'to'] as const).map((kind) => (
              <label className='control' key={kind}>
                <span>{kind === 'from' ? '연결 출발 상태' : '연결 도착 상태'}</span>
                <select
                  value={active[kind]?.index ?? ''}
                  onChange={(event) => chooseEndpoint(kind, Number(event.target.value))}
                >
                  <option value='' disabled>
                    상태 선택
                  </option>
                  {endpoints.map((endpoint) => (
                    <option
                      key={endpoint.index}
                      value={endpoint.index}
                      disabled={!validDiagramEndpoint(protocol, endpoint)}
                    >
                      {protocol.states[endpoint.index]?.label} · {endpoint.id || '(빈 ID)'}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <label className='control'>
              <span>연결 발생 이벤트</span>
              <select
                value={active.event?.kind ?? ''}
                onChange={(event) => {
                  const kind = event.target.value;
                  const trigger: RuleEvent =
                    kind === 'input' || kind === 'receive'
                      ? { kind, messageId: messages[0]?.id ?? '' }
                      : kind === 'timer'
                        ? { kind, timerId: timers[0]?.id ?? '' }
                        : { kind: 'connection', state: 'closed' };
                  onChange({ ...active, event: trigger });
                }}
              >
                <option value='' disabled>
                  이벤트 선택
                </option>
                <option value='input' disabled={!messages.length}>
                  시나리오 입력
                </option>
                <option value='receive' disabled={!messages.length}>
                  메시지 수신
                </option>
                <option value='timer' disabled={!timers.length}>
                  타이머 만료
                </option>
                <option value='connection' disabled={protocol.lowerService !== 'stream'}>
                  연결 종료·실패
                </option>
              </select>
            </label>
            {active.event && 'messageId' in active.event && (
              <label className='control'>
                <span>연결 이벤트 메시지</span>
                <select
                  value={active.event.messageId}
                  onChange={(event) =>
                    active.event &&
                    (active.event.kind === 'input' || active.event.kind === 'receive') &&
                    onChange({
                      ...active,
                      event: { kind: active.event.kind, messageId: event.target.value },
                    })
                  }
                >
                  {messages.map((message) => (
                    <option key={message.id} value={message.id}>
                      {message.label} · {message.id}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {active.event?.kind === 'timer' && (
              <label className='control'>
                <span>연결 이벤트 타이머</span>
                <select
                  value={active.event.timerId}
                  onChange={(event) =>
                    onChange({ ...active, event: { kind: 'timer', timerId: event.target.value } })
                  }
                >
                  {timers.map((timer) => (
                    <option key={timer.id}>{timer.id}</option>
                  ))}
                </select>
              </label>
            )}
            {active.event?.kind === 'connection' && (
              <label className='control'>
                <span>연결 종료 종류</span>
                <select
                  value={active.event.state}
                  onChange={(event) =>
                    onChange({
                      ...active,
                      event: {
                        kind: 'connection',
                        state: event.target.value === 'failed' ? 'failed' : 'closed',
                      },
                    })
                  }
                >
                  <option value='closed'>정상 종료</option>
                  <option value='failed'>연결 실패</option>
                </select>
              </label>
            )}
          </div>
          <p className='hint'>
            메시지·타이머가 없다면 기존 폼에서 먼저 추가하세요. 빈 ID·중복 ID·없는 참조는 연결할 수
            없습니다. 정의가 바뀌면 출발·도착을 다시 고릅니다.
          </p>
          {active.from?.id === active.to?.id && active.from && (
            <p>
              자기 전이는 동작 없이 명시적으로 무시하는 규칙으로 생성합니다. 동작을 추가하려면 규칙
              편집기에서 무시를 해제하세요.
            </p>
          )}
          {prepared?.success && prepared.overlaps && (
            <p className='diagram-problem'>
              같은 출발 상태·이벤트의 규칙이 있습니다. 생성 후 조건을 구분해야 할 수 있으며, 충돌을
              해결하기 전에는 실행할 수 없습니다.
            </p>
          )}
          {prepared && !prepared.success && <p role='alert'>{prepared.message}</p>}
          <button
            type='button'
            disabled={!prepared?.success}
            onClick={() => {
              if (
                prepared?.success &&
                onAppend({ kind: 'rule', value: prepared.rule }, protocol.revision)
              )
                onChange(undefined);
            }}
          >
            전이 생성하고 편집
          </button>
          <p className='hint'>
            처음에는 상태 이동만 정의합니다. send·deliver·타이머·조건은 기존 규칙 폼에서 추가합니다.
          </p>
        </>
      )}
    </fieldset>
  );
}
