import { BREAKPOINT_OPERATORS } from '../application/breakpoints.ts';
import { compileStackBreakpoints, type StackBreakpoint } from '../application/stack-breakpoints.ts';
import type { StackDebugSettings } from '../application/stack-worker-protocol.ts';
import { workspaceId } from '../application/workspace-operations.ts';
import { type StackSnapshot, stackProtocolBody } from '../domain/stack-model.ts';
import { stackProtocolAt, stackTarget } from '../domain/stack-record.ts';

/** Keep bounded breakpoint forms local to this tab and bind every target to its exact frozen definition. */
export function StackDebugger({
  snapshot,
  settings,
  change,
}: {
  snapshot: StackSnapshot;
  settings: StackDebugSettings;
  change: (value: StackDebugSettings) => void;
}) {
  const endpoints = (['A', 'B'] as const).flatMap((participant) =>
    snapshot.configuration.nodes[participant].instances.map((instance) => ({
      participant,
      instanceId: instance.id,
    })),
  );
  const checked = compileStackBreakpoints(snapshot, settings);
  function update(point: StackBreakpoint, patch: Partial<StackBreakpoint>) {
    change({
      ...settings,
      points: settings.points.map((p) => (p.id === point.id ? { ...p, ...patch } : p)),
    });
  }
  function retarget(
    point: StackBreakpoint,
    endpoint: StackBreakpoint['endpoint'],
    kind = point.kind,
  ) {
    try {
      const protocol = stackProtocolAt(snapshot, endpoint);
      const body = stackProtocolBody(protocol);
      const items =
        kind === 'state' ? body.states : kind === 'message' ? body.messages : body.variables;
      update(point, {
        endpoint,
        kind,
        protocolId: protocol.id,
        protocolRevision: protocol.revision,
        targetId: items[0]?.id ?? '',
      });
    } catch {
      update(point, { endpoint, kind, targetId: '' });
    }
  }
  return (
    <section className='stack-debugger' aria-label='스택 중단점'>
      <h2>중단점과 조건부 정지</h2>
      <p>
        현재 표시된 실행 snapshot 또는 실행 전 초안에 연결합니다. 편집으로 revision이 바뀌면 대상을
        다시 선택하세요. 설정은 이 탭에서만 유지합니다.
      </p>
      <label>
        <input
          type='checkbox'
          checked={settings.enabled}
          onChange={(event) => change({ ...settings, enabled: event.target.checked })}
        />
        스택 중단점 사용
      </label>
      {settings.points.slice(0, 20).map((point) => {
        let items: readonly { id: string }[] = [];
        try {
          const body = stackProtocolBody(stackProtocolAt(snapshot, point.endpoint));
          items =
            point.kind === 'state'
              ? body.states
              : point.kind === 'message'
                ? body.messages
                : body.variables;
        } catch {
          /* Keep unresolved forms visible. */
        }
        return (
          <fieldset className='editor-group' key={point.id}>
            <legend>{point.label || '중단점'}</legend>
            <label className='control'>
              중단점 이름
              <input
                maxLength={80}
                value={point.label}
                onChange={(event) => update(point, { label: event.target.value })}
              />
            </label>
            <label>
              <input
                type='checkbox'
                checked={point.enabled}
                onChange={(event) => update(point, { enabled: event.target.checked })}
              />
              이 중단점 활성
            </label>
            <label className='control'>
              중단점 인스턴스
              <select
                aria-label='중단점 인스턴스'
                value={stackTarget(point.endpoint)}
                onChange={(event) => {
                  const endpoint = endpoints.find((e) => stackTarget(e) === event.target.value);
                  if (endpoint) retarget(point, endpoint);
                }}
              >
                {!endpoints.some((e) => stackTarget(e) === stackTarget(point.endpoint)) && (
                  <option>{stackTarget(point.endpoint)}</option>
                )}
                {endpoints.map((e) => (
                  <option key={stackTarget(e)}>{stackTarget(e)}</option>
                ))}
              </select>
            </label>
            <label className='control'>
              정지 조건 종류
              <select
                aria-label='정지 조건 종류'
                value={point.kind}
                onChange={(event) =>
                  retarget(point, point.endpoint, event.target.value as StackBreakpoint['kind'])
                }
              >
                <option value='state'>전이 후 상태</option>
                <option value='message'>메시지 해석</option>
                <option value='variable'>전이 후 변수</option>
              </select>
            </label>
            <label className='control'>
              정지 대상
              <select
                aria-label='정지 대상'
                value={point.targetId}
                onChange={(event) => {
                  try {
                    const protocol = stackProtocolAt(snapshot, point.endpoint);
                    update(point, {
                      targetId: event.target.value,
                      protocolId: protocol.id,
                      protocolRevision: protocol.revision,
                    });
                  } catch {
                    /* Missing endpoints stay invalid. */
                  }
                }}
              >
                {!items.some((item) => item.id === point.targetId) && (
                  <option value={point.targetId}>{point.targetId || '대상 없음'}</option>
                )}
                {items.slice(0, 100).map((item) => (
                  <option key={item.id}>{item.id}</option>
                ))}
              </select>
            </label>
            {point.kind === 'variable' && (
              <>
                <label className='control'>
                  비교 연산자
                  <select
                    value={point.operator}
                    onChange={(event) =>
                      update(point, { operator: event.target.value as StackBreakpoint['operator'] })
                    }
                  >
                    {BREAKPOINT_OPERATORS.map((op) => (
                      <option key={op}>{op}</option>
                    ))}
                  </select>
                </label>
                <label className='control'>
                  비교 값 JSON
                  <textarea
                    maxLength={8192}
                    value={point.literal}
                    onChange={(event) => update(point, { literal: event.target.value })}
                  />
                </label>
              </>
            )}
            <p>
              {point.protocolId} · r{point.protocolRevision}
            </p>
            <button
              type='button'
              onClick={() =>
                change({ ...settings, points: settings.points.filter((p) => p.id !== point.id) })
              }
            >
              중단점 삭제 · {point.label}
            </button>
          </fieldset>
        );
      })}
      <button
        type='button'
        disabled={settings.points.length >= 20 || !endpoints[0]}
        onClick={() => {
          const endpoint = endpoints[0];
          if (!endpoint) return;
          try {
            const protocol = stackProtocolAt(snapshot, endpoint);
            const body = stackProtocolBody(protocol);
            change({
              ...settings,
              points: [
                ...settings.points,
                {
                  id: workspaceId('stack_breakpoint'),
                  label: `중단점 ${settings.points.length + 1}`,
                  enabled: true,
                  endpoint,
                  protocolId: protocol.id,
                  protocolRevision: protocol.revision,
                  kind: 'state',
                  targetId: body.states[0]?.id ?? '',
                  operator: 'eq',
                  literal: '0',
                },
              ],
            });
          } catch {
            /* Fix the definition reference before adding a point. */
          }
        }}
      >
        스택 중단점 추가
      </button>
      <p>
        {settings.points.length} / 20개 · 실제 처리 단위가 끝난 뒤 정지하므로 같은 처리의 후속
        관찰이 함께 남을 수 있습니다.
      </p>
      {!checked.success && (
        <div role='alert'>
          {checked.diagnostics.slice(0, 20).map((d) => (
            <p key={d.path}>{d.message}</p>
          ))}
        </div>
      )}
    </section>
  );
}
