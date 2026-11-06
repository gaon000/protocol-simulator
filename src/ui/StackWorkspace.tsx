import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  editStackExperiment,
  retainedStackRaw,
  synchronizeStackMessages,
} from '../application/edit-stack.ts';
import { compileStackBreakpoints } from '../application/stack-breakpoints.ts';
import { StackWorkerClient } from '../application/stack-worker-client.ts';
import type {
  StackDebugSettings,
  StackRunMeta,
  StackWorkerReply,
} from '../application/stack-worker-protocol.ts';
import { workspaceId } from '../application/workspace-operations.ts';
import { captureStackRun, createStackDraft } from '../application/workspace-v2-operations.ts';
import type { JsonValue } from '../domain/execution-contract.ts';
import { freezeOwned } from '../domain/immutable-data.ts';
import { canonicalStackJson } from '../domain/stack-series-model.ts';
import { valueAt } from '../domain/json-pointer.ts';
import { parseJsonData } from '../domain/model-validation.ts';
import type { StackExperiment, StackSnapshot } from '../domain/stack-model.ts';
import { STACK_POLICY } from '../domain/stack-model.ts';
import { stackRecordCompatibility } from '../domain/stack-record.ts';
import { parseStackExperiment, parseStackExperimentDraft } from '../domain/stack-validation.ts';
import { WORKSPACE_POLICY } from '../domain/workspace-model.ts';
import type { SavedStackRun, StackDraft } from '../domain/workspace-v2-model.ts';
import { createStackExampleCopy, STACK_EXAMPLES } from '../examples/reliable-stack-examples.ts';
import { StackDebugger } from './StackDebugger.tsx';
import { StackEditor } from './StackEditor.tsx';
import { StackExperiments } from './StackExperiments.tsx';
import { StackRunPanel } from './StackRunPanel.tsx';
import { StoragePanel } from './StoragePanel.tsx';
import type { WorkspaceHost } from './useWorkspace.ts';

/** Compose a real stacked editor, isolated worker sessions and shared v2 persistence. */
export function StackWorkspace({
  state,
  host,
}: {
  state: ReturnType<WorkspaceHost['full']['view']>;
  host: WorkspaceHost;
}) {
  const [tab, setTab] = useState('실행');
  const [notice, setNotice] = useState('');
  const [workerReady, setWorkerReady] = useState(false);
  const client = useRef<StackWorkerClient | undefined>(undefined);
  const runMeta = useRef<StackRunMeta | undefined>(undefined);
  const generation = useRef(0);
  const [live, setLive] = useState<SavedStackRun>();
  const liveRef = useRef<SavedStackRun | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [historyId, setHistoryId] = useState<string>();
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [stop, setStop] = useState<string>();
  const [debugForms, setDebugForms] = useState<Readonly<Record<string, StackDebugSettings>>>({});
  const [series, setSeries] = useState<{
    id: string;
    finished: number;
    total: number;
    done: boolean;
  }>();
  const seriesRef = useRef<typeof series>(undefined);
  const blockedSeries = useRef<string | undefined>(undefined);
  const draft = state.data.stack.drafts.find((d) => d.id === state.data.stack.activeDraftId);
  const record = historyId ? state.data.stack.runs.find((r) => r.id === historyId) : live;
  const debugOwner = record?.experimentId ?? draft?.id ?? '';
  const settings = debugForms[debugOwner] ?? { enabled: true, points: [] };
  const snapshot =
    record?.view.snapshot ??
    (draft
      ? {
          schemaVersion: 2 as const,
          mode: 'stack' as const,
          engineVersion: STACK_POLICY.engineVersion,
          randomAlgorithm: STACK_POLICY.randomAlgorithm,
          configuration: draft.configuration,
        }
      : undefined);
  const configuration = draft?.configuration;
  const checked = useMemo(
    () => (configuration ? parseStackExperiment(configuration) : undefined),
    [configuration],
  );
  const rawErrors = useMemo(
    () =>
      Object.entries(draft?.raw ?? {}).flatMap(([path, text]) => {
        try {
          const parsed = parseJsonData(JSON.parse(text));
          return !parsed.success
            ? [{ path, code: 'raw-json', message: '유한한 JSON 값을 확인하세요.' }]
            : canonicalStackJson(parsed.value) ===
                canonicalStackJson(valueAt(draft?.configuration, path))
              ? []
              : [{ path, code: 'raw-shape', message: '편집 중인 JSON의 필수 구조를 확인하세요.' }];
        } catch {
          return [{ path, code: 'raw-json', message: 'JSON 문법을 확인하세요.' }];
        }
      }),
    [draft?.raw, draft?.configuration],
  );
  const diagnostics = [...(checked && !checked.success ? checked.diagnostics : []), ...rawErrors];
  const callbacks = useRef<(event: Exclude<StackWorkerReply, { type: 'response' }>) => void>(
    () => {},
  );
  const persist = useCallback(
    (saved: SavedStackRun) => {
      let accepted = true;
      host.full.update((data) => {
        const found = data.stack.runs.some((r) => r.id === saved.id);
        if (
          !found &&
          data.stack.runs.length + data.legacy.runs.length >= WORKSPACE_POLICY.maxRuns
        ) {
          accepted = false;
          setNotice('기록 100개 한도입니다. 현재 메모리 관찰은 유지했습니다.');
          return data;
        }
        const next = {
          ...data,
          stack: {
            ...data.stack,
            runs: found
              ? data.stack.runs.map((r) => (r.id === saved.id ? saved : r))
              : [...data.stack.runs, saved],
          },
        };
        if (new TextEncoder().encode(JSON.stringify(next)).length > WORKSPACE_POLICY.maxBytes) {
          accepted = false;
          setNotice('저장 64 MiB 한도입니다. 현재 실행 관찰은 메모리에 유지했습니다.');
          return data;
        }
        return next;
      });
      return accepted;
    },
    [host.full],
  );
  callbacks.current = (event) => {
    if (event.type === 'failure') {
      if (event.runId && event.runId !== runMeta.current?.runId) return;
      if (event.seriesId && event.seriesId !== seriesRef.current?.id) return;
      setNotice(event.message);
      setRunning(false);
    } else if (event.type === 'view') {
      if (event.meta.runId !== runMeta.current?.runId) return;
      const view = freezeOwned(event.view);
      const saved = captureStackRun(
        view,
        event.meta.experimentId,
        event.meta.draftVersion,
        event.meta.id,
      );
      const stamped = freezeOwned({ ...saved, createdAt: event.meta.createdAt });
      liveRef.current = stamped;
      setLive(stamped);
      setRunning(event.running);
      setCursor(view.events.length + 1);
      if (event.stop) {
        setSelected(event.stop.event.eventId);
        setStop(
          `${event.stop.kind === 'match' ? '중단점 정지' : '중단점 평가 오류'} · ${event.stop.hits.map((h) => h.label).join(', ')} · 같은 처리에서 뒤따른 관찰 ${event.stop.trailingEvents}개`,
        );
      }
      if (event.checkpoint) persist(stamped);
    } else if (event.type === 'series-progress') {
      if (seriesRef.current && event.id !== seriesRef.current.id) return;
      const progress = {
        id: event.id,
        finished: event.finished,
        total: event.total,
        done: event.done,
      };
      seriesRef.current = progress;
      setSeries(progress);
      if (event.record && blockedSeries.current !== event.id) {
        const saved = freezeOwned(event.record);
        if (persist(saved)) {
          if (!event.done)
            void client.current
              ?.request({ type: 'continue-series', id: event.id, finished: event.finished })
              .catch((error: unknown) => setNotice(String(error)));
        } else {
          blockedSeries.current = event.id;
          liveRef.current = saved;
          setLive(saved);
          setHistoryId(undefined);
          setCursor(saved.view.events.length + 1);
          setSelected(undefined);
          setTab('실행');
          void client.current
            ?.request({ type: 'cancel-series', id: event.id })
            .catch((error: unknown) => setNotice(String(error)));
        }
      }
    }
  };
  useEffect(() => {
    const worker = new StackWorkerClient();
    client.current = worker;
    worker.onEvent = (event) => callbacks.current(event);
    worker.onError = (message) => {
      setNotice(message);
      setRunning(false);
      if (liveRef.current) persist(liveRef.current);
    };
    setWorkerReady(true);
    return () => {
      worker.close();
      if (client.current === worker) client.current = undefined;
    };
  }, [persist]);
  async function control(action: 'pause' | 'cancel' | 'run' | 'step') {
    if (!runMeta.current || !client.current) return;
    const runId = runMeta.current.runId;
    try {
      await client.current.request({
        type: 'control',
        runId,
        action,
        ...(['run', 'step'].includes(action) ? { settings } : {}),
      });
    } catch (error) {
      if (runMeta.current?.runId !== runId) return;
      setNotice(String(error));
      setRunning(false);
    }
  }
  async function stopAll() {
    await control('cancel');
    const current = seriesRef.current;
    if (current && !current.done && client.current)
      await client.current.request({ type: 'cancel-series', id: current.id });
  }
  useEffect(() =>
    host.registerLeave(async () => {
      generation.current++;
      await stopAll();
    }),
  );
  function updateDraft(change: (draft: StackDraft) => StackDraft) {
    if (!draft) return;
    const id = draft.id;
    host.full.update((data) => ({
      ...data,
      stack: { ...data.stack, drafts: data.stack.drafts.map((d) => (d.id === id ? change(d) : d)) },
    }));
  }
  async function edit(path: string, value: JsonValue | undefined) {
    generation.current++;
    void control('pause');
    updateDraft((d) => {
      const configuration = editStackExperiment(d.configuration, path, value);
      return {
        ...d,
        configuration,
        raw: retainedStackRaw(d.raw, configuration, path, value === undefined),
        version: d.version + 1,
        updatedAt: Date.now(),
      };
    });
  }
  async function json(path: string, text: string) {
    generation.current++;
    void control('pause');
    try {
      const parsed = parseJsonData(JSON.parse(text));
      if (
        parsed.success &&
        draft &&
        parseStackExperimentDraft(editStackExperiment(draft.configuration, path, parsed.value))
          .success
      ) {
        await edit(path, parsed.value);
        return;
      }
    } catch {
      /* Preserve unfinished editor text. */
    }
    updateDraft((d) => ({
      ...d,
      raw: { ...d.raw, [path]: text },
      version: d.version + 1,
      updatedAt: Date.now(),
    }));
  }
  async function start(mode: 'run' | 'step', saved?: SavedStackRun) {
    const ticket = ++generation.current;
    if (!client.current || (!saved && (!draft || diagnostics.length))) return;
    const source: StackExperiment | StackSnapshot | undefined =
      saved?.view.snapshot ?? draft?.configuration;
    if (!source) return;
    const proposed = saved?.view.snapshot ?? {
      schemaVersion: 2 as const,
      mode: 'stack' as const,
      engineVersion: STACK_POLICY.engineVersion,
      randomAlgorithm: STACK_POLICY.randomAlgorithm,
      configuration: source as StackExperiment,
    };
    const owner = saved?.experimentId ?? draft?.id ?? '';
    const plan = compileStackBreakpoints(
      proposed,
      debugForms[owner] ?? { enabled: true, points: [] },
    );
    const incompatible = stackRecordCompatibility(proposed);
    if (!plan.success || incompatible) {
      setNotice(
        incompatible ??
          (!plan.success ? plan.diagnostics[0]?.message : '중단점을 확인하세요.') ??
          '실행할 수 없습니다.',
      );
      return;
    }
    await stopAll();
    if (ticket !== generation.current) return;
    const previous = liveRef.current;
    if (previous && !host.full.view().data.stack.runs.some((item) => item.id === previous.id))
      await client.current.forget(previous);
    if (ticket !== generation.current) return;
    const meta: StackRunMeta = {
      id: workspaceId('stack_run'),
      runId: workspaceId('stack_execution'),
      experimentId: owner,
      draftVersion: saved?.draftVersion ?? draft?.version ?? 1,
      createdAt: Date.now(),
    };
    runMeta.current = meta;
    setHistoryId(undefined);
    setSelected(undefined);
    setStop(undefined);
    setNotice('');
    try {
      await client.current.request({
        type: 'start',
        meta,
        source,
        snapshot: saved !== undefined,
        mode,
        settings: debugForms[owner] ?? { enabled: true, points: [] },
      });
    } catch (error) {
      if (ticket === generation.current) setNotice(String(error));
    }
  }
  async function addExample(id: string) {
    generation.current++;
    if (
      state.data.legacy.drafts.length + state.data.stack.drafts.length >=
      WORKSPACE_POLICY.maxDrafts
    ) {
      setNotice('공유 초안 100개 한도입니다.');
      return;
    }
    await stopAll();
    const next = createStackDraft(createStackExampleCopy(id));
    host.full.update((data) => ({
      ...data,
      stack: { ...data.stack, activeDraftId: next.id, drafts: [...data.stack.drafts, next] },
    }));
    setHistoryId(undefined);
    setLive(undefined);
    liveRef.current = undefined;
    setTab('편집');
  }
  async function openHistory(id: string, position?: number) {
    generation.current++;
    await control('pause');
    const saved = host.full.view().data.stack.runs.find((r) => r.id === id);
    if (!saved) return;
    setHistoryId(id);
    setCursor(position ?? saved.view.events.length + 1);
    setSelected(position && position > 0 ? saved.view.events[position - 1]?.eventId : undefined);
    setTab('실행');
  }
  async function importBundle(text: string) {
    generation.current++;
    const staged = host.stageImport(text);
    if (!staged.success) return staged.diagnostics[0]?.message;
    await stopAll();
    const latest = host.stageImport(text);
    if (!latest.success) return latest.diagnostics[0]?.message;
    host.applyImport(latest.value);
    setHistoryId(undefined);
    setLive(undefined);
    setNotice('검증한 bundle을 적용했습니다. 충돌한 항목은 새 사본으로 추가했습니다.');
    await host.full.save();
    return undefined;
  }
  return (
    <div className='workspace stack-workspace'>
      <header className='app-header'>
        <strong>Protocol Studio · 계층 연결</strong>
        <span className='project-name'>{draft?.configuration.label.slice(0, 80) ?? '새 스택'}</span>
        <span>
          초안 v{draft?.version ?? 0}
          {record ? ` · 실행 v${record.draftVersion}` : ''}
        </span>
      </header>
      <StoragePanel
        state={{ ...state, data: state.data.legacy }}
        onSave={() => {
          void host.full.save();
        }}
        onRetry={() => {
          void host.full.retry();
        }}
        onImport={importBundle}
        onExport={host.exportBundle}
        onLegacyExport={host.exportLegacy}
        onBackupExport={host.exportBackup}
      />
      <main id='stack-main' tabIndex={-1} className='stack-main'>
        <h1>프로토콜 스택 작업 공간</h1>
        <p>A/B의 응용·전송 인스턴스를 연결하고 하위 패킷 장애가 앱에 미치는 영향을 관찰합니다.</p>
        {notice && <p role='status'>{notice}</p>}
        <details className='stack-library' open={!draft}>
          <summary>스택 예제와 저장한 자료</summary>
          <div className='stack-example-grid'>
            {STACK_EXAMPLES.map((entry) => (
              <article className='stack-card' key={entry.id}>
                <h3>{entry.title}</h3>
                <p>{entry.description}</p>
                <button
                  type='button'
                  onClick={() => {
                    void addExample(entry.id);
                  }}
                >
                  {entry.id} 새 사본
                </button>
                <details>
                  <summary>지원 범위·출처</summary>
                  <p>
                    원본 {entry.id} · v{entry.version}
                  </p>
                  {entry.supported.map((s) => (
                    <p key={s}>{s}</p>
                  ))}
                  {entry.omitted.map((s) => (
                    <p key={s}>{s}</p>
                  ))}
                  {entry.sources.map((s) => (
                    <a key={s.url} href={s.url} target='_blank' rel='noreferrer'>
                      {s.title}
                    </a>
                  ))}
                </details>
              </article>
            ))}
          </div>
          {state.data.stack.drafts.slice(0, 100).map((d) => (
            <div className='stack-library-row' key={d.id}>
              <button
                type='button'
                onClick={async () => {
                  await stopAll();
                  host.full.update((data) => ({
                    ...data,
                    stack: { ...data.stack, activeDraftId: d.id },
                  }));
                  setTab('편집');
                }}
              >
                {d.configuration.label.slice(0, 80)} · 초안 v{d.version}
              </button>
              <button
                type='button'
                onClick={async () => {
                  if (draft?.id === d.id) await stopAll();
                  host.full.update((data) => {
                    const drafts = data.stack.drafts.filter((item) => item.id !== d.id);
                    return {
                      ...data,
                      stack: {
                        ...data.stack,
                        drafts,
                        activeDraftId:
                          data.stack.activeDraftId === d.id
                            ? (drafts[0]?.id ?? null)
                            : data.stack.activeDraftId,
                      },
                    };
                  });
                }}
              >
                스택 초안 삭제 · {d.configuration.label.slice(0, 50)}
              </button>
            </div>
          ))}
        </details>
        <nav className='stack-tabs' aria-label='스택 작업'>
          {['편집', '실행', '중단점', '반복·회귀', '기록·비교'].map((name) => (
            <button
              type='button'
              key={name}
              aria-current={tab === name ? 'page' : undefined}
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
        </nav>
        <section className='run-controls' aria-label='스택 실행 제어'>
          <button
            type='button'
            disabled={
              !workerReady ||
              !draft ||
              diagnostics.length > 0 ||
              (series !== undefined && !series.done)
            }
            onClick={() => {
              void start('run');
            }}
          >
            새 스택 전체 실행
          </button>
          <button
            type='button'
            disabled={
              !workerReady ||
              historyId !== undefined ||
              (series !== undefined && !series.done) ||
              ((!live ||
                ['completed', 'cancelled', 'limit-reached', 'engine-error'].includes(
                  live.view.status,
                )) &&
                (!draft || diagnostics.length > 0))
            }
            onClick={() => {
              if (
                !historyId &&
                live &&
                !['completed', 'cancelled', 'limit-reached', 'engine-error'].includes(
                  live.view.status,
                )
              )
                void control('step');
              else if (!historyId) void start('step');
            }}
          >
            스택 한 단계
          </button>
          <button
            type='button'
            disabled={!running}
            onClick={() => {
              void control('pause');
            }}
          >
            스택 일시 정지
          </button>
          <button
            type='button'
            disabled={
              historyId !== undefined ||
              !live ||
              running ||
              ['completed', 'cancelled', 'limit-reached', 'engine-error'].includes(live.view.status)
            }
            onClick={() => {
              setStop(undefined);
              void control('run');
            }}
          >
            스택 계속
          </button>
          <button
            type='button'
            onClick={async () => {
              await stopAll();
              setHistoryId(undefined);
              setLive(undefined);
              liveRef.current = undefined;
              setSelected(undefined);
            }}
          >
            스택 실행 초기화
          </button>
          {series && !series.done && (
            <button
              type='button'
              onClick={() => {
                if (client.current)
                  void client.current.request({ type: 'cancel-series', id: series.id });
              }}
            >
              스택 묶음 중단
            </button>
          )}
        </section>
        {stop && <p role='status'>{stop}</p>}
        {tab === '편집' && draft && (
          <StackEditor
            draft={draft}
            edit={(path, value) => {
              void edit(path, value);
            }}
            json={(path, text) => {
              void json(path, text);
            }}
            diagnostics={diagnostics}
            synchronize={async (protocol) => {
              await control('pause');
              updateDraft((d) => ({
                ...d,
                configuration: synchronizeStackMessages(d.configuration, protocol),
                version: d.version + 1,
                updatedAt: Date.now(),
              }));
            }}
          />
        )}
        {tab === '실행' && (
          <StackRunPanel
            settings={settings}
            onStop={(reason) =>
              setStop(`기록 중단점 정지 · ${reason.hits.map((h) => h.label).join(', ')}`)
            }
            stored={
              record !== undefined && state.data.stack.runs.some((item) => item.id === record.id)
            }
            saveCurrent={() => {
              if (record && persist(record)) void host.full.save();
            }}
            record={record}
            running={running}
            cursor={cursor}
            setCursor={setCursor}
            selected={selected}
            select={async (id, position) => {
              await control('pause');
              setCursor(position);
              setSelected(id);
            }}
            client={client.current}
            ready={workerReady}
            replay={() => {
              if (record) void start('run', record);
            }}
          />
        )}
        {tab === '중단점' && snapshot && (
          <StackDebugger
            snapshot={snapshot}
            settings={settings}
            change={(next) => {
              void control('pause');
              setDebugForms((forms) => ({ ...forms, [debugOwner]: next }));
            }}
          />
        )}
        {(tab === '반복·회귀' || tab === '기록·비교') && (
          <StackExperiments
            tab={tab}
            draft={draft}
            data={state.data}
            host={host}
            client={client.current}
            ready={workerReady}
            series={series}
            startSeries={async (plan) => {
              await stopAll();
              blockedSeries.current = undefined;
              seriesRef.current = {
                id: plan.id,
                finished: 0,
                total: plan.cases.length,
                done: false,
              };
              setSeries(seriesRef.current);
              if (client.current) await client.current.request({ type: 'series', plan });
            }}
            updateDraft={updateDraft}
            open={openHistory}
            notify={setNotice}
          />
        )}
      </main>
      <footer className='app-footer'>
        v2 로컬 저장 · snapshot과 초안 분리 · 실제 네트워크 연결 없음
      </footer>
    </div>
  );
}
