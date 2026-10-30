/** biome-ignore-all lint/suspicious/noArrayIndexKey: Form rows are stateless and controlled by JSON Pointer; structural edits clear pending values for the affected collection. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRunSession } from '../application/create-simulation.ts';
import {
  changeProfile,
  createBlankExperiment,
  editExperiment,
  nextId,
  rebasePending,
} from '../application/edit-experiment.ts';
import type { JsonValue } from '../domain/execution-contract.ts';
import { parseExperiment, parseJsonData } from '../domain/model-validation.ts';
import type { ExperimentDefinition, ModelDiagnostic } from '../domain/protocol-model.ts';
import type { EngineView } from '../engine/simulation.ts';
import { EXAMPLES, createExampleCopy } from '../examples/catalog.ts';
import { ExampleDetails, ExampleOrigin } from './ExampleInfo.tsx';
import { EnvironmentEditor } from './EnvironmentEditor.tsx';
import { Control, EditorContext, Group } from './forms.tsx';
import { ProtocolEditor } from './ProtocolEditor.tsx';
import { EventInspector, RunView } from './RunView.tsx';
import { ScenarioEditor } from './ScenarioEditor.tsx';
import { useWorkspace } from './useWorkspace.ts';
import { HistoryPanel } from './HistoryPanel.tsx';
import { StoragePanel } from './StoragePanel.tsx';
import {
  captureRun,
  createDraftRecord,
  definitionDeletionReason,
  stageBundle,
  workspaceId,
} from '../application/workspace-operations.ts';
import { compareRecord, projectRecord } from '../application/replay-record.ts';
import { rawDiagnostics } from '../domain/workspace-validation.ts';
import { WORKSPACE_POLICY, type DraftRecord, type SavedRun } from '../domain/workspace-model.ts';

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
  const storage = useWorkspace();
  const active =
    storage.data.drafts.find((item) => item.id === storage.data.activeDraftId) ??
    storage.data.drafts[0];
  if (!active) throw new Error('Active workspace draft is missing');
  const activeId = active.id;
  const draft = active.configuration;
  const draftVersion = active.version;
  const raw = active.raw;
  const rawErrors = useMemo(
    () => Object.fromEntries(rawDiagnostics(raw).map((item) => [item.path, item.message])),
    [raw],
  );
  const [historyId, setHistoryId] = useState<string>();
  const [historyPosition, setHistoryPosition] = useState(0);
  const [historyPlaying, setHistoryPlaying] = useState(false);
  const runMeta = useRef<
    | {
        id: string;
        experimentId: string;
        draftVersion: number;
        createdAt: number;
      }
    | undefined
  >(undefined);
  const comparison = useRef<SavedRun | undefined>(undefined);
  const [runVersion, setRunVersion] = useState(0);
  const [viewId, setViewId] = useState<ViewId>('configuration');
  const [library, setLibrary] = useState(false);
  const [protocolIndex, setProtocolIndex] = useState(0);
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
  const historical = storage.data.runs.find((item) => item.id === historyId);
  const displayed = useMemo(
    () => (historical ? projectRecord(historical, historyPosition) : run),
    [historical, historyPosition, run],
  );
  const event = displayed?.events.find((item) => item.eventId === selected);
  const shownVersion = historical?.draftVersion ?? runVersion;
  const changed =
    !!displayed &&
    (shownVersion !== draftVersion ||
      JSON.stringify(displayed.snapshot.configuration) !== JSON.stringify(draft));
  const controller = storage.controller;
  const checkpoint = useCallback(
    (view: EngineView) => {
      const meta = runMeta.current;
      if (!meta) return;
      controller.update((data) => {
        const record = {
          ...captureRun(view, meta.experimentId, meta.draftVersion, meta.id),
          createdAt: meta.createdAt,
        };
        return {
          ...data,
          runs: data.runs.some((item) => item.id === meta.id)
            ? data.runs.map((item) => (item.id === meta.id ? record : item))
            : [...data.runs, record],
        };
      });
    },
    [controller],
  );

  useEffect(() => () => session.reset(), [session]);
  useEffect(() => {
    if (!playing || !run) return;
    const timeout = window.setTimeout(() => {
      session.apply(run.runId, (engine) => {
        const next = engine.runBatch(4);
        setRun(next);
        if (engine.result()) {
          setPlaying(false);
          checkpoint(next);
          if (comparison.current) {
            setNotice(compareRecord(comparison.current, next));
            comparison.current = undefined;
          }
        }
      });
    }, 40);
    return () => window.clearTimeout(timeout);
  }, [playing, run, session, checkpoint]);
  useEffect(() => {
    if (!historical || !historyPlaying) return;
    if (historyPosition >= historical.view.events.length + 1) {
      setHistoryPlaying(false);
      return;
    }
    const timeout = window.setTimeout(() => setHistoryPosition((position) => position + 1), 120);
    return () => window.clearTimeout(timeout);
  }, [historical, historyPlaying, historyPosition]);
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

  function updateActive(change: (record: DraftRecord) => DraftRecord) {
    storage.controller.update((data) => ({
      ...data,
      drafts: data.drafts.map((item) => (item.id === data.activeDraftId ? change(item) : item)),
    }));
  }
  function setDraft(
    change: ExperimentDefinition | ((current: ExperimentDefinition) => ExperimentDefinition),
  ) {
    updateActive((record) => ({
      ...record,
      configuration: typeof change === 'function' ? change(record.configuration) : change,
      updatedAt: Date.now(),
    }));
  }
  function pause() {
    setPlaying(false);
    const engine = session.current();
    if (engine) {
      const next = engine.pause();
      setRun(next);
      checkpoint(next);
    }
  }
  function changing() {
    pause();
    updateActive((record) => ({ ...record, version: record.version + 1, updatedAt: Date.now() }));
    setStartErrors([]);
    setNotice('');
  }
  function edit(path: string, value: JsonValue | undefined) {
    changing();
    updateActive((record) => ({
      ...record,
      configuration: editExperiment(record.configuration, path, value),
      raw: rebasePending(record.raw, record.configuration, path, value),
    }));
  }
  function editJson(path: string, text: string) {
    changing();
    updateActive((record) => {
      let configuration = record.configuration;
      try {
        const parsed = parseJsonData(JSON.parse(text));
        if (parsed.success) configuration = editExperiment(configuration, path, parsed.value);
      } catch {
        /* Keep the last valid value while persisting unfinished text. */
      }
      return { ...record, configuration, raw: { ...record.raw, [path]: text } };
    });
  }
  function reset() {
    setPlaying(false);
    const engine = session.current();
    if (engine && !engine.result()) checkpoint(engine.cancel());
    session.reset();
    setRun(undefined);
    setSelected(undefined);
    setRunVersion(0);
    runMeta.current = undefined;
    comparison.current = undefined;
  }
  function resetSelection() {
    setHistoryId(undefined);
    setHistoryPlaying(false);
    setHistoryPosition(0);
    setProtocolIndex(0);
    setStartErrors([]);
    setSelected(undefined);
  }
  function replace(next: ExperimentDefinition) {
    if (storage.data.drafts.length >= WORKSPACE_POLICY.maxDrafts) {
      setNotice('초안 100개 한도입니다. 먼저 불필요한 초안을 삭제하세요.');
      return;
    }
    reset();
    resetSelection();
    const record = createDraftRecord(next);
    storage.controller.update((data) => ({
      ...data,
      activeDraftId: record.id,
      drafts: [...data.drafts, record],
    }));
    setLibrary(false);
    setViewId('configuration');
    setNotice('');
  }
  function activate(id: string) {
    reset();
    resetSelection();
    storage.controller.update((data) => ({ ...data, activeDraftId: id }));
    setLibrary(false);
    setViewId('configuration');
    setNotice('');
  }
  function selectHistory(record: SavedRun) {
    pause();
    const latest =
      storage.controller.view().data.runs.find((item) => item.id === record.id) ?? record;
    setHistoryId(record.id);
    setHistoryPosition(latest.view.events.length + 1);
    setHistoryPlaying(false);
    setSelected(undefined);
    setLibrary(false);
    setViewId('run');
    setNotice('');
  }
  function removeDraft(id: string) {
    if (storage.data.drafts.length <= 1) {
      setNotice('편집할 초안을 하나 이상 유지해야 합니다.');
      return;
    }
    if (id === active?.id) {
      reset();
      resetSelection();
    }
    storage.controller.update((data) => {
      const drafts = data.drafts.filter((item) => item.id !== id);
      return {
        ...data,
        drafts,
        activeDraftId:
          data.activeDraftId === id ? (drafts[0]?.id ?? data.activeDraftId) : data.activeDraftId,
      };
    });
    setNotice('초안을 삭제했습니다. 과거 실행 기록은 유지했습니다.');
  }
  async function importBundle(text: string): Promise<string | undefined> {
    const staged = stageBundle(text, storage.controller.view().data);
    if (!staged.success) return `${staged.diagnostics[0]?.code}: ${staged.diagnostics[0]?.message}`;
    reset();
    resetSelection();
    // Cancelling an unfinished live run writes its last checkpoint. Merge against that latest data.
    const latest = stageBundle(text, storage.controller.view().data);
    if (!latest.success) return latest.diagnostics[0]?.message ?? '가져오기 실패';
    storage.controller.update(() => latest.value);
    setLibrary(false);
    setViewId('configuration');
    setNotice('검증한 bundle을 적용했습니다. 충돌한 항목은 새 사본으로 추가했습니다.');
    await storage.controller.save();
    return undefined;
  }
  function rerun(record: SavedRun) {
    if (storage.data.runs.length >= WORKSPACE_POLICY.maxRuns) {
      setNotice('기록 100개 한도입니다. 먼저 불필요한 기록을 삭제하세요.');
      return;
    }
    const previous = session.current();
    if (previous && !previous.result()) checkpoint(previous.cancel());
    const created = session.startSnapshot(record.view.snapshot);
    if (!created.success) {
      setNotice(created.diagnostics[0]?.message ?? 'snapshot 재실행 실패');
      return;
    }
    runMeta.current = {
      id: workspaceId('saved_run'),
      experimentId: record.experimentId,
      draftVersion: record.draftVersion,
      createdAt: Date.now(),
    };
    comparison.current = record;
    setHistoryId(undefined);
    setHistoryPlaying(false);
    setSelected(undefined);
    const next = created.value.view();
    setRun(next);
    checkpoint(next);
    setRunVersion(record.draftVersion);
    setPlaying(true);
    setLibrary(false);
    setViewId('run');
    setNotice('과거 snapshot 설정으로 새 실행을 시작했습니다. 현재 초안은 유지합니다.');
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
    const id = displayed?.snapshot.configuration.protocols[participant].id;
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
    if (!engine || changed || historical || engine.result()) {
      if (storage.data.runs.length >= WORKSPACE_POLICY.maxRuns) {
        setNotice('기록 100개 한도입니다. 먼저 불필요한 기록을 삭제하세요.');
        return;
      }
      if (engine && !engine.result()) checkpoint(engine.cancel());
      const created = session.start(draft);
      if (!created.success) {
        setStartErrors(created.diagnostics);
        return;
      }
      engine = created.value;
      runMeta.current = {
        id: workspaceId('saved_run'),
        experimentId: activeId,
        draftVersion,
        createdAt: Date.now(),
      };
      comparison.current = undefined;
      setHistoryId(undefined);
      setHistoryPlaying(false);
      setRunVersion(draftVersion);
      setSelected(undefined);
    }
    const next = step ? engine.step() : engine.view();
    setRun(next);
    checkpoint(next);
    setPlaying(!step && !engine.result());
  }

  if (!storage.ready)
    return (
      <main>
        <h1>Protocol Studio</h1>
        <p role='status'>브라우저 저장소를 읽는 중입니다.</p>
      </main>
    );

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
        <StoragePanel
          state={storage}
          onSave={() => {
            void storage.controller.save();
          }}
          onRetry={() => {
            void storage.controller.retry();
          }}
          onImport={importBundle}
        />
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
                <p className='lead'>
                  버전이 있는 원본 설명을 읽고 사용자 사본을 만들거나 빈 실험을 시작하세요.
                </p>
                <section aria-label='내 실험'>
                  <h2>내 실험 · {storage.data.drafts.length}개</h2>
                  {storage.data.drafts.map((item) => (
                    <div key={item.id} className='saved-draft'>
                      <strong>{item.configuration.label || '이름 없는 실험'}</strong>
                      <span>
                        초안 v{item.version} · {item.id.slice(-8)}
                      </span>
                      <button type='button' onClick={() => activate(item.id)}>
                        실험 열기 · {item.configuration.label || item.id.slice(-8)}
                      </button>
                      <button
                        type='button'
                        className='danger'
                        disabled={storage.data.drafts.length <= 1}
                        onClick={() => removeDraft(item.id)}
                      >
                        초안 삭제 · {item.configuration.label || item.id.slice(-8)}
                      </button>
                    </div>
                  ))}
                </section>
                <section aria-label='과거 실행 목록'>
                  <h2>과거 실행 · {storage.data.runs.length}개</h2>
                  {[...storage.data.runs].reverse().map((item) => (
                    <div key={item.id} className='saved-draft'>
                      <span>
                        {item.view.snapshot.configuration.label} · {item.view.status} ·{' '}
                        {item.id.slice(-8)}
                      </span>
                      <button type='button' onClick={() => selectHistory(item)}>
                        기록 열기 · {item.view.snapshot.configuration.label} · {item.id.slice(-8)}
                      </button>
                    </div>
                  ))}
                </section>
                <div className='library-grid'>
                  {EXAMPLES.map((example) => (
                    <section
                      key={example.id}
                      className='participant-card'
                      aria-label={`${example.title} 예제`}
                    >
                      <h2>{example.title}</h2>
                      <p>{example.description}</p>
                      <ExampleDetails example={example} />
                      <button type='button' onClick={() => replace(createExampleCopy(example.id))}>
                        {example.copyLabel}
                      </button>
                    </section>
                  ))}
                  <section className='participant-card'>
                    <h2>빈 실험</h2>
                    <p>메시지와 상태, 입력 규칙부터 직접 정의합니다.</p>
                    <button type='button' onClick={() => replace(createBlankExperiment())}>
                      빈 실험 만들기
                    </button>
                  </section>
                </div>
                <p className='scope-note'>
                  새 사본은 내 실험에 추가됩니다. 초안과 실행 기록을 이 브라우저에 자동 저장합니다.
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
                <ExampleOrigin experiment={draft} />
                <section className='run-toolbar' aria-label='실행 제어'>
                  <button
                    className='primary'
                    type='button'
                    disabled={diagnostics.length > 0 || playing}
                    onClick={() => start(false)}
                  >
                    {historical
                      ? '현재 초안 전체 실행'
                      : changed
                        ? '새 설정으로 전체 실행'
                        : '전체 실행'}
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
                {displayed && (
                  <p className={changed ? 'version-note changed' : 'version-note'} role='status'>
                    초안 v{draftVersion} · 실행 v{shownVersion} ({displayed.runId})
                    {changed ? ' · 초안 변경됨 — 다음 실행에 반영' : ' · 동일 설정'}
                  </p>
                )}
                {viewId === 'configuration' && (
                  <>
                    <Control path='/label' label='실험 이름' />
                    <Control path='/id' label='실험 ID' />
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
                            value={draft.definitions.findIndex(
                              (definition) =>
                                definition.id === draft.protocols[participant].id &&
                                definition.revision === draft.protocols[participant].revision,
                            )}
                            onChange={(event) => {
                              const definition = draft.definitions[Number(event.target.value)];
                              if (definition)
                                edit(`/protocols/${participant}`, {
                                  id: definition.id,
                                  revision: definition.revision,
                                });
                            }}
                          >
                            <option value={-1} disabled>
                              정의를 선택하세요
                            </option>
                            {draft.definitions.map((definition, index) => (
                              <option key={index} value={index}>
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
                    {protocol && (
                      <>
                        <button
                          type='button'
                          className='danger'
                          onClick={() => {
                            const reason = definitionDeletionReason(draft, protocolIndex);
                            if (reason) setNotice(reason);
                            else {
                              edit(`/definitions/${protocolIndex}`, undefined);
                              setProtocolIndex(0);
                            }
                          }}
                        >
                          선택한 정의 삭제
                        </button>
                        <ProtocolEditor index={protocolIndex} protocol={protocol} />
                      </>
                    )}
                  </>
                )}
                {viewId === 'environment' && <EnvironmentEditor />}
                {viewId === 'scenario' && <ScenarioEditor />}
                {viewId === 'run' && (
                  <>
                    <HistoryPanel
                      records={storage.data.runs}
                      selectedId={historyId}
                      position={historyPosition}
                      playing={historyPlaying}
                      onSelect={selectHistory}
                      onPosition={(position) => {
                        setHistoryPosition(position);
                        setHistoryPlaying(false);
                      }}
                      onPlay={() => {
                        if (historical && historyPosition >= historical.view.events.length + 1)
                          setHistoryPosition(0);
                        setHistoryPlaying((current) => !current);
                      }}
                      onRerun={rerun}
                      onRestore={(record) =>
                        replace({
                          ...structuredClone(record.view.snapshot.configuration),
                          label: `${record.view.snapshot.configuration.label} 복원 사본`,
                        })
                      }
                      onDelete={(id) => {
                        if (runMeta.current?.id === id) reset();
                        storage.controller.update((data) => ({
                          ...data,
                          runs: data.runs.filter((item) => item.id !== id),
                        }));
                        if (historyId === id) {
                          setHistoryId(undefined);
                          setHistoryPlaying(false);
                          setSelected(undefined);
                        }
                      }}
                      onLive={() => {
                        setHistoryId(undefined);
                        setHistoryPlaying(false);
                        setSelected(undefined);
                      }}
                    />
                    <RunView
                      run={displayed}
                      playing={playing && !historical}
                      selected={selected}
                      historyLabel={
                        historical
                          ? `과거 기록 · ${historyPosition >= historical.view.events.length + 1 ? '저장 시점' : `이벤트 ${historyPosition}/${historical.view.events.length}`}`
                          : undefined
                      }
                      onSelect={(id) => {
                        setSelected(id);
                        if (historical) {
                          setHistoryPosition(
                            historical.view.events.findIndex((event) => event.eventId === id) + 1,
                          );
                          setHistoryPlaying(false);
                        }
                      }}
                    />
                  </>
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
            {!!displayed?.diagnostics.length && (
              <section className='diagnostics-panel' aria-label='실행 진단'>
                <h2>실행 진단</h2>
                <ul>
                  {displayed.diagnostics.map((item, index) => (
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
                if (historical) {
                  setHistoryPosition(
                    historical.view.events.findIndex((item) => item.eventId === id) + 1,
                  );
                  setHistoryPlaying(false);
                }
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
          이 브라우저에 자동 저장 · ‘저장됨’ 표시 후 다시 열기 가능 · 실제 서버·기기 연결 없음
        </footer>
      </div>
    </EditorContext>
  );
}
