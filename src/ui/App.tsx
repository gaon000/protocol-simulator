import { useState } from 'react';
import type { ProtocolLayer, ServiceKind } from '../domain/execution-contract.ts';

const views = [
  {
    id: 'configuration',
    label: '실험 구성',
    description: '대상 계층과 하위 서비스의 계약을 선택합니다.',
  },
  {
    id: 'protocol',
    label: '프로토콜',
    description: '메시지·상태·규칙 편집은 P1–P3에서 연결합니다.',
  },
  {
    id: 'environment',
    label: '통신 환경',
    description: '지연·손실·청크 설정은 P4에서 연결합니다.',
  },
  {
    id: 'scenario',
    label: '시나리오·검증',
    description: '입력과 기대 조건 편집은 P3에서 연결합니다.',
  },
  {
    id: 'run',
    label: '실행',
    description: '시뮬레이션 엔진과 이벤트 기록은 P2–P3에서 연결합니다.',
  },
] as const;

type ViewId = (typeof views)[number]['id'];

/** Render the P0 workspace shell without presenting a simulated result as implemented. */
export function App() {
  const [viewId, setViewId] = useState<ViewId>('configuration');
  const [layer, setLayer] = useState<ProtocolLayer>('application');
  const [service, setService] = useState<ServiceKind>('stream');
  const view = views.find((item) => item.id === viewId) ?? views[0];

  function changeLayer(next: ProtocolLayer) {
    setLayer(next);
    if (next === 'transport') setService('datagram');
  }

  return (
    <div className='workspace'>
      <header className='app-header'>
        <a className='brand' href='/'>
          Protocol Studio
        </a>
        <span className='phase'>P0 · 개발 기반</span>
        <span className='project-name'>새 실험</span>
      </header>
      <div className='app-body'>
        <nav className='navigation' aria-label='작업 공간'>
          <p className='eyebrow'>작업 공간</p>
          {views.map((item) => (
            <button
              key={item.id}
              type='button'
              aria-current={viewId === item.id ? 'page' : undefined}
              onClick={() => setViewId(item.id)}
            >
              {item.label}
            </button>
          ))}
          <p className='navigation-note'>가상 참여자 A · B</p>
        </nav>
        <main id='main-content'>
          <p className='eyebrow'>프로토콜 설계 · 이해 · 검증</p>
          <h1>{view.label}</h1>
          <p className='lead'>{view.description}</p>
          {viewId === 'configuration' ? (
            <>
              <fieldset>
                <legend>대상 계층</legend>
                <label className='choice'>
                  <input
                    type='radio'
                    name='layer'
                    checked={layer === 'application'}
                    onChange={() => changeLayer('application')}
                  />
                  <span>
                    <strong>응용 계층</strong>
                    <small>메시지의 의미와 통신 순서를 정의합니다.</small>
                  </span>
                </label>
                <label className='choice'>
                  <input
                    type='radio'
                    name='layer'
                    checked={layer === 'transport'}
                    onChange={() => changeLayer('transport')}
                  />
                  <span>
                    <strong>전송 계층</strong>
                    <small>연결과 데이터 전달 규칙을 정의합니다.</small>
                  </span>
                </label>
              </fieldset>
              <fieldset>
                <legend>하위 통신 서비스</legend>
                <label className='choice'>
                  <input
                    type='radio'
                    name='service'
                    checked={service === 'stream'}
                    disabled={layer === 'transport'}
                    onChange={() => setService('stream')}
                  />
                  <span>
                    <strong>바이트 스트림</strong>
                    <small>순서와 중복 없는 전달을 제공합니다.</small>
                  </span>
                </label>
                <label className='choice'>
                  <input
                    type='radio'
                    name='service'
                    checked={service === 'datagram'}
                    onChange={() => setService('datagram')}
                  />
                  <span>
                    <strong>데이터그램</strong>
                    <small>패킷 경계를 유지하며 전달 성공·순서는 보장하지 않습니다.</small>
                  </span>
                </label>
              </fieldset>
              <p className='scope-note'>
                v1의 전송 계층 실험은 하위 데이터그램 환경을 사용합니다. 선택 내용은 아직 저장하지
                않습니다.
              </p>
            </>
          ) : (
            <section className='upcoming' aria-label='구현 예정 기능'>
              <h2>개발 기반을 준비했습니다</h2>
              <p>
                이 보기는 이후 구현을 위한 진입점입니다. 현재 프로토콜 편집과 통신 실행은 제공하지
                않습니다.
              </p>
            </section>
          )}
          <button className='run-button' type='button' disabled>
            실행 준비 중
          </button>
        </main>
        <aside className='inspector' aria-label='하위 서비스 계약'>
          <p className='eyebrow'>선택한 하위 서비스</p>
          <h2>{service === 'stream' ? '바이트 스트림' : '데이터그램'}</h2>
          <div aria-live='polite'>
            {service === 'stream' ? (
              <>
                <p>바이트의 순서와 중복 없는 전달을 보장합니다.</p>
                <p>메시지 경계는 보존하지 않으므로 프로토콜의 프레이밍 규칙이 필요합니다.</p>
              </>
            ) : (
              <>
                <p>패킷 경계를 유지합니다.</p>
                <p>손실·중복·순서 역전을 가정하며 필요한 보장은 프로토콜이 구현합니다.</p>
              </>
            )}
          </div>
          <hr />
          <h3>참여자</h3>
          <p>A와 B는 각각 독립적인 상태와 타이머를 갖습니다.</p>
        </aside>
      </div>
      <footer>개발 단계 P0 · 실행 결과 없음 · 로컬 저장 미지원</footer>
    </div>
  );
}
