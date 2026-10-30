/** biome-ignore-all lint/suspicious/noArrayIndexKey: Form rows are stateless and controlled by JSON Pointer; structural edits clear pending values for the affected collection. */
import { useEffect, useMemo, useState } from 'react';
import { createRunSession } from '../application/create-simulation.ts';
import {
  changeProfile,
  createBlankExperiment,
  editExperiment,
  nextId,
  rebasePending,
} from '../application/edit-experiment.ts';
import type { JsonValue } from '../domain/execution-contract.ts';
import { parseExperiment } from '../domain/model-validation.ts';
import type { ExperimentDefinition, ModelDiagnostic } from '../domain/protocol-model.ts';
import type { EngineView } from '../engine/simulation.ts';
import { createStopAndWaitExperiment } from '../examples/stop-and-wait.ts';
import { EnvironmentEditor } from './EnvironmentEditor.tsx';
import { createPingPongExperiment } from '../examples/ping-pong.ts';
import { Control, EditorContext, Group } from './forms.tsx';
import { ProtocolEditor } from './ProtocolEditor.tsx';
import { EventInspector, RunView } from './RunView.tsx';
import { ScenarioEditor } from './ScenarioEditor.tsx';

const views = [
  {
    id: 'configuration',
    label: '실험 구성',
    description: '대상 계층과 하위 서비스, 참여자별 프로토콜을 선택합니다.',
  },
  {
    id: 'protocol',
    label: '프로토콜',
    description: '메시지 형식과 상태·조건·동작을 함께 정의합니다.',
  },
  {
    id: 'environment',
    label: '통신 환경',
    description: '방향별 지연·손실·중복과 스트림 청크·연결 상태를 설정합니다.',
  },
  {
    id: 'scenario',
    label: '시나리오·검증',
    description: '최초 입력과 관찰 기간, 기대 결과를 정의합니다.',
  },
  {
    id: 'run',
    label: '실행',
    description: '실행 당시 설정으로 생성한 실제 기록과 판정을 확인합니다.',
  },
] as const;
type ViewId = (typeof views)[number]['id'];

/** Connect an editable protocol workspace to isolated, bounded simulation sessions. */
export function App() {
  const [draft, setDraft] = useState<ExperimentDefinition>(createPingPongExperiment);
  const [draftVersion, setDraftVersion] = useState(1);
  const [runVersion, setRunVersion] = useState(0);
  const [viewId, setViewId] = useState<ViewId>('configuration');
  const [library, setLibrary] = useState(false);
  const [protocolIndex, setProtocolIndex] = useState(0);
  const [raw, setRaw] = useState<Record<string, string>>({});
  const [rawErrors, setRawErrors] = useState<Record<string, string>>({});
  const [startErrors, setStartErrors] = useState<readonly ModelDiagnostic[]>([]);
  const [session] = useState(() => createRunSession());
  const [run, setRun] = useState<EngineView>();
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [focusRequest, setFocusRequest] = useState<{ path: string; serial: number }>();
  const [notice, setNotice] = useState('');
  const validation = useMemo(() => parseExperiment(draft), [draft]);
  const diagnostics: readonly ModelDiagnostic[] = [
    ...(validation.success ? [] : validation.diagnostics),
    ...Object.entries(rawErrors).map(([path, message]) => ({ path, message, code: 'json-syntax' })),
    ...startErrors,
  ];
  const protocol = draft.definitions[protocolIndex] ?? draft.definitions[0];
  const view = views.find((item) => item.id === viewId) ?? views[0];
  const event = run?.events.find((item) => item.eventId === selected);
  const changed = !!run && runVersion !== draftVersion;

  useEffect(() => () => session.reset(), [session]);
  useEffect(() => {
    if (!playing || !run) return;
    const timeout = window.setTimeout(() => {
      session.apply(run.runId, (engine) => {
        const next = engine.runBatch(4);
        setRun(next);
        if (engine.result()) setPlaying(false);
      });
    }, 40);
    return () => window.clearTimeout(timeout);
  }, [playing, run, session]);
  useEffect(() => {
    if (!focusRequest) return;
    let path = focusRequest.path;
    const elements = Array.from(document.querySelectorAll<HTMLElement>('[data-path]'));
    let target: HTMLElement | undefined;
    while (path && !target) {
      target = elements.find((element) => element.dataset.path === path);
      path = path.slice(0, path.lastIndexOf('/'));
    }
    if (target) {
      for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
      }
      target.focus();
      target.scrollIntoView({ block: 'center' });
    }
  }, [focusRequest]);

  function pause() {
    setPlaying(false);
    const engine = session.current();
    if (engine) setRun(engine.pause());
  }
  function changing() {
    pause();
    setDraftVersion((version) => version + 1);
    setStartErrors([]);
    setNotice('');
  }
  function edit(path: string, value: JsonValue | undefined) {
    changing();
    setDraft((current) => editExperiment(current, path, value));
    setRaw((current) => rebasePending(current, draft, path, value));
    setRawErrors((current) => rebasePending(current, draft, path, value));
  }
  function editJson(path: string, text: string) {
    changing();
    setRaw((current) => ({ ...current, [path]: text }));
    try {
      const value = JSON.parse(text) as JsonValue;
      setDraft((current) => editExperiment(current, path, value));
      setRawErrors((current) => {
        const next = { ...current };
        delete next[path];
        return next;
      });
    } catch {
      setRawErrors((current) => ({ ...current, [path]: 'JSON 값의 문법을 확인하세요.' }));
    }
  }
  function reset() {
    setPlaying(false);
    session.reset();
    setRun(undefined);
    setSelected(undefined);
    setRunVersion(0);
  }
  function replace(next: ExperimentDefinition) {
    reset();
    setDraft(next);
    setDraftVersion((version) => version + 1);
    setProtocolIndex(0);
    setRaw({});
    setRawErrors({});
    setStartErrors([]);
    setLibrary(false);
    setViewId('configuration');
    setNotice('');
  }
  function navigate(path: string) {
    setLibrary(false);
    setNotice('');
    const definitionIndex = /^\/definitions\/(\d+)/.exec(path)?.[1];
    if (definitionIndex !== undefined) {
      setProtocolIndex(Number(definitionIndex));
      setViewId('protocol');
    } else if (path.startsWith('/environment')) setViewId('environment');
    else if (path.startsWith('/scenario')) setViewId('scenario');
    else setViewId('configuration');
    setFocusRequest((request) => ({ path, serial: (request?.serial ?? 0) + 1 }));
  }
  function navigateRule(participant: 'A' | 'B', ruleId: string | undefined) {
    const id = run?.snapshot.configuration.protocols[participant].id;
    const index = draft.definitions.findIndex((item) => item.id === id);
    const ruleIndex = draft.definitions[index]?.rules.findIndex((item) => item.id === ruleId);
    if (index < 0 || ruleIndex === undefined || ruleIndex < 0) {
      setNotice(
        '이 실행의 규칙은 현재 초안에서 찾을 수 없습니다. 이벤트 상세에는 실행 당시 값이 남아 있습니다.',
      );
      return;
    }
    navigate(`/definitions/${index}/rules/${ruleIndex}`);
  }
  function diagnosticLocation(diagnostic: ModelDiagnostic) {
    const match = /^\/participants\/([AB])(?:\/rules\/([^/]+))?/.exec(diagnostic.path);
    if (match?.[1] && match[2]) navigateRule(match[1] as 'A' | 'B', match[2]);
    else if (match?.[1])
      navigate(
        `/definitions/${Math.max(
          0,
          draft.definitions.findIndex(
            (item) => item.id === draft.protocols[match[1] as 'A' | 'B'].id,
          ),
        )}`,
      );
    else navigate(diagnostic.path);
  }
  function start(step: boolean) {
    if (diagnostics.length) return;
    setLibrary(false);
    setViewId('run');
    setNotice('');
    let engine = session.current();
    if (!engine || changed || engine.result()) {
      const created = session.start(draft);
      if (!created.success) {
        setStartErrors(created.diagnostics);
        return;
      }
      engine = created.value;
      setRunVersion(draftVersion);
      setSelected(undefined);
    }
    setRun(step ? engine.step() : engine.view());
    setPlaying(!step && !engine.result());
  }

  return (
    <EditorContext value={{ draft, diagnostics, raw, edit, editJson }}>
      <div className='workspace'>
        <a className='skip-link' href='#main-content'>
          본문으로 이동
        </a>
        <header className='app-header'>
          <button type='button' className='brand subtle' onClick={() => setLibrary(true)}>
            Protocol Studio
          </button>
          <span className='phase'>편집 · 시뮬레이션</span>
          <span className='project-name'>{draft.label}</span>
          <button type='button' onClick={() => setLibrary(true)}>
            실험 시작
          </button>
        </header>
        <div className='app-body'>
          <nav className='navigation' aria-label='작업 공간'>
            <p className='eyebrow'>작업 공간</p>
            {views.map((item) => (
              <button
                key={item.id}
                type='button'
                aria-current={!library && viewId === item.id ? 'page' : undefined}
                onClick={() => {
                  setLibrary(false);
                  setViewId(item.id);
                }}
              >
                {item.label}
              </button>
            ))}
            <p className='navigation-note'>
              가상 참여자 A · B<br />
              메모리 초안 v{draftVersion}
            </p>
          </nav>
          <main id='main-content' tabIndex={-1}>
            {library ? (
              <section aria-label='실험 시작'>
                <p className='eyebrow'>프로토콜 설계 · 이해 · 검증</p>
                <h1>실험 시작</h1>
                <p className='lead'>빈 실험을 만들거나 동작하는 Ping/Pong을 편집해 보세요.</p>
                <div className='library-grid'>
                  <section className='participant-card'>
                    <h2>Ping / Pong</h2>
                    <p>메시지·응답 조건·타이머·기대 결과가 연결된 출발점입니다.</p>
                    <button type='button' onClick={() => replace(createPingPongExperiment())}>
                      Ping/Pong 새 사본
                    </button>
                  </section>
                  <section className='participant-card'>
                    <h2>Stop-and-wait</h2>
                    <p>
                      DATA·ACK 순서 번호, 대기 데이터, 타이머와 중복 제거를 가진 한 방향 전달
                      실험입니다. 최초 송신과 재시도를 구분하며 기본 재시도 상한은 3회입니다.
                    </p>
                    <button type='button' onClick={() => replace(createStopAndWaitExperiment())}>
                      재전송 실험 새 사본
                    </button>
                  </section>
                  <section className='participant-card'>
                    <h2>빈 실험</h2>
                    <p>메시지와 상태, 입력 규칙부터 직접 정의합니다.</p>
                    <button type='button' onClick={() => replace(createBlankExperiment())}>
                      빈 실험 만들기
                    </button>
                  </section>
                </div>
                <p className='scope-note'>
                  새 실험을 열면 현재 메모리 초안을 교체합니다. 새로고침 보존은 아직 지원하지
                  않습니다.
                </p>
                <button type='button' onClick={() => setLibrary(false)}>
                  현재 초안으로 돌아가기
                </button>
              </section>
            ) : (
              <>
                <p className='eyebrow'>프로토콜 설계 · 이해 · 검증</p>
                <h1>{view.label}</h1>
                <p className='lead'>{view.description}</p>
                <section className='run-toolbar' aria-label='실행 제어'>
                  <button
                    className='primary'
                    type='button'
                    disabled={diagnostics.length > 0 || playing}
                    onClick={() => start(false)}
                  >
                    {changed ? '새 설정으로 전체 실행' : '전체 실행'}
                  </button>
                  <button
                    type='button'
                    disabled={diagnostics.length > 0 || playing}
                    onClick={() => start(true)}
                  >
                    한 단계
                  </button>
                  <button type='button' disabled={!playing} onClick={pause}>
                    일시 정지
                  </button>
                  <button type='button' disabled={!run} onClick={reset}>
                    실행 초기화
                  </button>
                </section>
                {run && (
                  <p className={changed ? 'version-note changed' : 'version-note'} role='status'>
                    초안 v{draftVersion} · 실행 v{runVersion} ({run.runId})
                    {changed ? ' · 초안 변경됨 — 다음 실행에 반영' : ' · 동일 설정'}
                  </p>
                )}
                {viewId === 'configuration' && (
                  <>
                    <Control path='/label' label='실험 이름' />
                    <Group path='/profile' title='대상 계층'>
                      {(['application', 'transport'] as const).map((layer) => (
                        <label className='choice' key={layer}>
                          <input
                            type='radio'
                            name='layer'
                            checked={protocol?.layer === layer}
                            onChange={() => {
                              changing();
                              setDraft((current) =>
                                changeProfile(current, layer, current.environment.kind),
                              );
                            }}
                          />
                          <span>
                            <strong>{layer === 'application' ? '응용 계층' : '전송 계층'}</strong>
                            <small>
                              {layer === 'application'
                                ? '메시지 의미와 통신 순서를 정의합니다.'
                                : '하위 데이터그램 위의 전달 규칙을 정의합니다.'}
                            </small>
                          </span>
                        </label>
                      ))}
                    </Group>
                    <Group path='/environment' title='하위 통신 서비스'>
                      {(['stream', 'datagram'] as const).map((service) => (
                        <label className='choice' key={service}>
                          <input
                            type='radio'
                            name='service'
                            disabled={protocol?.layer === 'transport' && service === 'stream'}
                            checked={draft.environment.kind === service}
                            onChange={() => {
                              changing();
                              setDraft((current) =>
                                changeProfile(current, protocol?.layer ?? 'application', service),
                              );
                            }}
                          />
                          <span>
                            <strong>{service === 'stream' ? '바이트 스트림' : '데이터그램'}</strong>
                            <small>
                              {service === 'stream'
                                ? '순서는 보장하지만 메시지 경계는 보존하지 않습니다.'
                                : '패킷 경계를 보존합니다. 손실·중복·지연 변동을 설정할 수 있습니다.'}
                            </small>
                          </span>
                        </label>
                      ))}
                    </Group>
                    <Group path='/protocols' title='참여자별 프로토콜'>
                      <p className='hint'>
                        같은 정의를 사용해도 A와 B의 상태·변수·타이머는 독립적입니다.
                      </p>
                      {(['A', 'B'] as const).map((participant) => (
                        <label key={participant} className='control'>
                          <span>참여자 {participant} 프로토콜</span>
                          <select
                            data-path={`/protocols/${participant}`}
                            value={draft.protocols[participant].id}
                            onChange={(event) => {
                              const definition = draft.definitions.find(
                                (item) => item.id === event.target.value,
                              );
                              if (definition)
                                edit(`/protocols/${participant}`, {
                                  id: definition.id,
                                  revision: definition.revision,
                                });
                            }}
                          >
                            {draft.definitions.map((definition) => (
                              <option key={definition.id} value={definition.id}>
                                {definition.label} · v{definition.revision}
                              </option>
                            ))}
                          </select>
                        </label>
                      ))}
                      <button
                        type='button'
                        onClick={() => {
                          if (!protocol) return;
                          const copy = {
                            ...structuredClone(protocol),
                            id: nextId(draft.definitions, 'protocol'),
                            revision: 1,
                            label: `${protocol.label} 사본`,
                          };
                          edit('/definitions', [...draft.definitions, copy]);
                          setProtocolIndex(draft.definitions.length);
                          setViewId('protocol');
                        }}
                      >
                        프로토콜 사본 추가
                      </button>
                    </Group>
                  </>
                )}
                {viewId === 'protocol' && (
                  <>
                    <label className='control'>
                      <span>편집할 정의</span>
                      <select
                        value={protocolIndex}
                        onChange={(event) => setProtocolIndex(Number(event.target.value))}
                      >
                        {draft.definitions.map((definition, index) => (
                          <option key={index} value={index}>
                            {definition.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {protocol && <ProtocolEditor index={protocolIndex} protocol={protocol} />}
                  </>
                )}
                {viewId === 'environment' && <EnvironmentEditor />}
                {viewId === 'scenario' && <ScenarioEditor />}
                {viewId === 'run' && (
                  <RunView run={run} playing={playing} selected={selected} onSelect={setSelected} />
                )}
              </>
            )}
            {notice && <p role='status'>{notice}</p>}
            <section className='diagnostics-panel' aria-label='정의 진단' aria-live='polite'>
              <h2>정의 진단 · {diagnostics.length}개</h2>
              {diagnostics.length ? (
                <ul>
                  {diagnostics.map((item, index) => (
                    <li key={`${item.path}-${item.code}-${index}`}>
                      <button type='button' onClick={() => diagnosticLocation(item)}>
                        <strong>{item.code}</strong> · {item.message}
                        <small>{item.path} · 편집 위치로 이동</small>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>
                  실행 가능한 정의입니다.
                  {rawErrors && Object.keys(rawErrors).length
                    ? ''
                    : ' 입력과 기대 조건도 실행 전에 검사합니다.'}
                </p>
              )}
            </section>
            {!!run?.diagnostics.length && (
              <section className='diagnostics-panel' aria-label='실행 진단'>
                <h2>실행 진단</h2>
                <ul>
                  {run.diagnostics.map((item, index) => (
                    <li key={index}>
                      <button type='button' onClick={() => diagnosticLocation(item)}>
                        {item.code} · {item.message}
                        <small>{item.path}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </main>
          <aside className='inspector' aria-label='실행 상세와 서비스 계약'>
            <EventInspector
              event={event}
              onCause={(id) => {
                setSelected(id);
                setLibrary(false);
                setViewId('run');
              }}
              onRule={() => event && navigateRule(event.participant, event.ruleId)}
            />
            <hr />
            <section aria-label='하위 서비스 계약'>
              <p className='eyebrow'>선택한 하위 서비스</p>
              <h2>{draft.environment.kind === 'stream' ? '바이트 스트림' : '데이터그램'}</h2>
              <p>
                {draft.environment.kind === 'stream'
                  ? '바이트 순서와 중복 없는 전달을 보장합니다. 메시지 경계는 프로토콜의 프레이밍으로 복원합니다.'
                  : '패킷 경계를 유지합니다. 설정한 손실·중복·지연 변동으로 순서 역전이 발생할 수 있으며 필요한 보장은 프로토콜이 구현합니다.'}
              </p>
            </section>
          </aside>
        </div>
        <footer>
          새로고침 보존 미지원 · 초안과 실행은 메모리에만 유지됩니다 · 실제 서버·기기 연결 없음
        </footer>
      </div>
    </EditorContext>
  );
}
