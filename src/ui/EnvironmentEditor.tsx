/** biome-ignore-all lint/suspicious/noArrayIndexKey: Environment rows are fully controlled by JSON Pointer and pending values move with row deletion. */
import { Control, Group, Remove, useEditor } from './forms.tsx';

/** Configure lower-service faults independently of protocol meaning and application expectations. */
export function EnvironmentEditor() {
  const { draft, edit } = useEditor();
  const environment = draft.environment;
  return (
    <div data-path='/environment' tabIndex={-1}>
      <p className='scope-note'>
        {environment.kind === 'stream'
          ? '스트림은 바이트 순서를 유지합니다. 같은 시각에 도착하는 전송은 합친 뒤 청크 크기로 나눕니다.'
          : '데이터그램은 손실·중복·순서 역전이 가능합니다. 같은 seed와 설정은 같은 환경 판정을 재현합니다.'}
      </p>
      <Control path='/seed' label='난수 seed' type='number' />
      {(['AtoB', 'BtoA'] as const).map((direction) => (
        <Group
          key={direction}
          path={`/environment/directions/${direction}`}
          title={direction === 'AtoB' ? 'A → B' : 'B → A'}
        >
          <Control
            path={`/environment/directions/${direction}/delayMs`}
            label='전달 지연 ms'
            type='number'
          />
          {environment.kind === 'stream' ? (
            <Control
              path={`/environment/directions/${direction}/chunkBytes`}
              label='수신 청크 크기 bytes'
              type='number'
            />
          ) : (
            <div className='form-grid'>
              <Control
                path={`/environment/directions/${direction}/jitterMs`}
                label='지연 변동 ±ms'
                type='number'
              />
              <Control
                path={`/environment/directions/${direction}/lossRate`}
                label='손실 확률 (0~1)'
                type='number'
              />
              <Control
                path={`/environment/directions/${direction}/duplicateRate`}
                label='중복 확률 (0~1)'
                type='number'
              />
            </div>
          )}
        </Group>
      ))}
      {environment.kind === 'datagram' ? (
        <Group path='/environment/targetedDrops' title='특정 전송 손실'>
          <p className='hint'>
            방향별 송신 순번은 1부터 시작합니다. 재전송은 새 순번입니다. 특정 손실은 확률보다 먼저
            적용합니다.
          </p>
          {environment.targetedDrops.map((_drop, index) => (
            <Group
              key={index}
              path={`/environment/targetedDrops/${index}`}
              title={`특정 손실 ${index + 1}`}
            >
              <Control
                path={`/environment/targetedDrops/${index}/direction`}
                label='손실 방향'
                options={['AtoB', 'BtoA']}
              />
              <Control
                path={`/environment/targetedDrops/${index}/transmission`}
                label='손실시킬 송신 순번'
                type='number'
              />
              <Remove path={`/environment/targetedDrops/${index}`} label='특정 손실 삭제' />
            </Group>
          ))}
          <button
            type='button'
            onClick={() =>
              edit('/environment/targetedDrops', [
                ...environment.targetedDrops,
                { direction: 'AtoB', transmission: 1 },
              ])
            }
          >
            특정 손실 추가
          </button>
        </Group>
      ) : (
        <Group path='/environment/connections' title='연결 종료·실패'>
          <p className='hint'>
            방향별로 한 번 설정합니다. 지정 시각부터 해당 방향의 수신이 중단됩니다. close는 정상
            EOF, fail은 연결 실패이며 대응 규칙을 프로토콜에 정의합니다.
          </p>
          {environment.connections.map((_connection, index) => (
            <Group
              key={index}
              path={`/environment/connections/${index}`}
              title={`연결 이벤트 ${index + 1}`}
            >
              <div className='form-grid'>
                <Control
                  path={`/environment/connections/${index}/direction`}
                  label='종료 방향'
                  options={['AtoB', 'BtoA']}
                />
                <Control
                  path={`/environment/connections/${index}/kind`}
                  label='종료 종류'
                  options={['close', 'fail']}
                />
                <Control
                  path={`/environment/connections/${index}/timeMs`}
                  label='종료 시각 ms'
                  type='number'
                />
              </div>
              <Remove path={`/environment/connections/${index}`} label='연결 이벤트 삭제' />
            </Group>
          ))}
          <button
            type='button'
            disabled={environment.connections.length >= 2}
            onClick={() =>
              edit('/environment/connections', [
                ...environment.connections,
                {
                  direction: environment.connections.some((item) => item.direction === 'AtoB')
                    ? 'BtoA'
                    : 'AtoB',
                  kind: 'close',
                  timeMs: Math.min(100, draft.scenario.observationMs),
                },
              ])
            }
          >
            연결 이벤트 추가
          </button>
        </Group>
      )}
    </div>
  );
}
