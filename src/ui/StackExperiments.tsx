import { useMemo, useState } from 'react';
import type { StackComparisonModel, StackCoverageModel } from '../application/stack-panel-model.ts';
import {
  prepareStackSeries,
  type StackSeriesPlan,
  summarizeStackSeries,
} from '../application/stack-series.ts';
import type { StackWorkerClient } from '../application/stack-worker-client.ts';
import { workspaceId } from '../application/workspace-operations.ts';
import type {
  StackCase,
  StackDraft,
  StackSuite,
  WorkspaceV2,
} from '../domain/workspace-v2-model.ts';
import { useStackQuery } from './useStackQuery.ts';
import type { WorkspaceHost } from './useWorkspace.ts';

type Props = {
  tab: string;
  draft: StackDraft | undefined;
  data: WorkspaceV2;
  host: WorkspaceHost;
  client: StackWorkerClient | undefined;
  ready: boolean;
  series: { id: string; finished: number; total: number; done: boolean } | undefined;
  startSeries: (plan: StackSeriesPlan) => Promise<void>;
  updateDraft: (change: (draft: StackDraft) => StackDraft) => void;
  open: (id: string, cursor?: number) => void;
  notify: (message: string) => void;
};
function Pages({
  name,
  page,
  pages,
  change,
}: {
  name: string;
  page: number;
  pages: number;
  change: (value: number) => void;
}) {
  return (
    <div className='stack-pager'>
      <button type='button' disabled={page === 0} onClick={() => change(page - 1)}>
        {name} 이전
      </button>
      <span>
        {page + 1} / {pages}
      </span>
      <button type='button' disabled={page + 1 >= pages} onClick={() => change(page + 1)}>
        {name} 다음
      </button>
    </div>
  );
}

/** Run frozen independent cases and inspect bounded coverage/comparison without sharing run-specific IDs. */
export function StackExperiments({
  tab,
  draft,
  data,
  host,
  client,
  ready,
  series,
  startSeries,
  updateDraft,
  open,
  notify,
}: Props) {
  const [seeds, setSeeds] = useState('1, 2, 3');
  const [paired, setPaired] = useState(false);
  const [label, setLabel] = useState('스택 실험');
  const [page, setPage] = useState(0);
  const [leftId, setLeftId] = useState('');
  const [rightId, setRightId] = useState('');
  const [comparePage, setComparePage] = useState(0);
  const [groupId, setGroupId] = useState('');
  const [beforeGroup, setBeforeGroup] = useState('');
  const [coverageCase, setCoverageCase] = useState('');
  const [coveragePage, setCoveragePage] = useState(0);
  const [endpoint, setEndpoint] = useState('');
  const [unobservedOnly, setUnobservedOnly] = useState(false);
  const runs = data.stack.runs;
  const left = runs.find((r) => r.id === leftId);
  const right = runs.find((r) => r.id === rightId);
  const comparisonKey = useMemo(
    () =>
      client && ready && left && right && tab === '기록·비교'
        ? { client, left, right, page: comparePage }
        : undefined,
    [client, ready, left, right, comparePage, tab],
  );
  const comparisonResult = useStackQuery<StackComparisonModel>(comparisonKey, async () => {
    if (!comparisonKey) throw new Error('비교할 기록이 없습니다.');
    const key = comparisonKey;
    await key.client.register(key.left);
    await key.client.register(key.right);
    return key.client.request({
      type: 'compare',
      left: key.left.id,
      right: key.right.id,
      page: key.page,
    });
  });
  const groups = [
    ...new Map(
      runs.flatMap((r) =>
        r.series?.kind === 'regression' ? [[r.series.id, r.series] as const] : [],
      ),
    ).values(),
  ].reverse();
  const group = groups.find((g) => g.id === groupId) ?? groups[0];
  const groupRuns = useMemo(
    () => runs.filter((r) => r.series?.id === group?.id),
    [runs, group?.id],
  );
  const coverageKey = useMemo(
    () =>
      client && ready && group && (!series || series.done) && tab === '반복·회귀'
        ? {
            client,
            records: groupRuns,
            groupId: group.id,
            page: coveragePage,
            endpoint,
            unobservedOnly,
          }
        : undefined,
    [client, ready, group, groupRuns, coveragePage, endpoint, unobservedOnly, tab, series],
  );
  const coverageResult = useStackQuery<StackCoverageModel>(coverageKey, async () => {
    if (!coverageKey) throw new Error('회귀 기록이 없습니다.');
    return coverageKey.client.request({
      type: 'coverage',
      records: coverageKey.records,
      groupId: coverageKey.groupId,
      page: coverageKey.page,
      endpoint: coverageKey.endpoint,
      unobservedOnly: coverageKey.unobservedOnly,
    });
  });
  const coverage = coverageResult ?? { value: undefined, error: undefined };
  const comparison = comparisonResult ?? { value: undefined, error: undefined };
  const previous =
    groups.find((g) => g.id === beforeGroup && g.id !== group?.id) ??
    groups.find((g) => g.id !== group?.id);
  const changesKey = useMemo(
    () =>
      client && group && previous && tab === '반복·회귀'
        ? { client, records: runs, before: previous.id, after: group.id }
        : undefined,
    [client, group, previous, runs, tab],
  );
  const changes = useStackQuery<
    readonly { id: string; label: string; status: string; leftId?: string; rightId?: string }[]
  >(changesKey, async () => {
    if (!changesKey) throw new Error('이전 묶음이 없습니다.');
    return changesKey.client.request({
      type: 'case-changes',
      records: changesKey.records,
      before: changesKey.before,
      after: changesKey.after,
    });
  });
  const suite = draft?.suite;
  function updateSuite(change: (suite: StackSuite) => StackSuite) {
    updateDraft((current) => {
      const before = current.suite ?? {
        id: workspaceId('stack_suite'),
        label: '시나리오 묶음',
        revision: 0,
        cases: [],
      };
      const next = change(before);
      return {
        ...current,
        suite: { ...next, revision: before.revision + 1 },
        version: current.version + 1,
        updatedAt: Date.now(),
      };
    });
  }
  function captureCase(previous?: StackCase) {
    if (!draft) return;
    updateSuite((current) => {
      if (!previous && current.cases.length >= 20) return current;
      const next: StackCase = {
        id: previous?.id ?? workspaceId('stack_case'),
        label: previous?.label ?? `사례 ${current.cases.length + 1}`,
        enabled: previous?.enabled ?? true,
        seed: draft.configuration.seed,
        scenario: structuredClone(draft.configuration.scenario),
        environment: structuredClone(draft.configuration.link.environment),
      };
      return {
        ...current,
        cases: previous
          ? current.cases.map((c) => (c.id === previous.id ? next : c))
          : [...current.cases, next],
      };
    });
  }
  async function launch(kind: 'batch' | 'regression') {
    if (!draft) return;
    const numbers = seeds.trim() ? seeds.split(/[\s,]+/).map(Number) : [];
    const normal = structuredClone(draft.configuration.link.environment);
    const lost = { ...normal, targetedDrops: [{ direction: 'BtoA' as const, transmission: 1 }] };
    const plan = prepareStackSeries(
      draft,
      data,
      kind === 'regression'
        ? { kind, label }
        : {
            kind,
            label,
            seeds: numbers,
            ...(paired
              ? {
                  environments: [
                    { id: 'current', label: '현재 환경', environment: normal },
                    { id: 'first_ack_lost', label: '첫 ACK 손실', environment: lost },
                  ],
                }
              : {}),
          },
    );
    if (!plan.success) {
      notify(plan.diagnostics[0]?.message ?? '묶음을 확인하세요.');
      return;
    }
    try {
      await startSeries(plan.value);
      notify(`${plan.value.cases.length}회 독립 실행을 시작했습니다.`);
    } catch (error) {
      notify(String(error));
    }
  }
  const progressRuns = series ? runs.filter((r) => r.series?.id === series.id) : [];
  const summary = series ? summarizeStackSeries(progressRuns, series.total) : undefined;
  const running = series !== undefined && !series.done;
  const pages = Math.max(1, Math.ceil(runs.length / 20));
  const selectedPage = Math.min(page, pages - 1);
  return (
    <section
      className='stack-experiments'
      aria-label={tab === '반복·회귀' ? '스택 반복·회귀' : '스택 기록·비교'}
    >
      <h2>{tab}</h2>
      {tab === '반복·회귀' && (
        <>
          <section className='stack-card'>
            <h3>동일 seed의 반복 실험</h3>
            <label className='control'>
              묶음 이름
              <input
                maxLength={80}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <label className='control'>
              seed 목록
              <input value={seeds} onChange={(event) => setSeeds(event.target.value)} />
            </label>
            <label>
              <input
                type='checkbox'
                checked={paired}
                onChange={(event) => setPaired(event.target.checked)}
              />
              현재 환경과 첫 ACK 손실 환경을 같은 seed로 비교
            </label>
            <p>
              중복 없는 uint32 seed, 환경 조합 포함 최대 100회입니다. 공통 정의·연결과 사례별 조건을
              시작 시 고정합니다.
            </p>
            <button
              type='button'
              disabled={!draft || !ready || running}
              onClick={() => {
                void launch('batch');
              }}
            >
              스택 반복 실험 실행
            </button>
          </section>
          <section className='stack-card'>
            <h3>시나리오 묶음 작성</h3>
            <p>
              입력·기대 조건과 하위 환경을 편집 화면에서 만든 뒤 사례로 추가하세요. 사례를 초안에
              불러와 수정하고 같은 사례에 다시 반영할 수 있습니다. 과거 실행 snapshot은 보존됩니다.
            </p>
            {suite && (
              <label className='control'>
                시나리오 묶음 이름
                <input
                  value={suite.label}
                  onChange={(event) => updateSuite((s) => ({ ...s, label: event.target.value }))}
                />
              </label>
            )}
            {(suite?.cases ?? []).slice(0, 20).map((item) => (
              <fieldset key={item.id} className='editor-group'>
                <legend>{item.label || item.id}</legend>
                <label className='control'>
                  사례 이름
                  <input
                    value={item.label}
                    onChange={(event) =>
                      updateSuite((s) => ({
                        ...s,
                        cases: s.cases.map((c) =>
                          c.id === item.id ? { ...c, label: event.target.value } : c,
                        ),
                      }))
                    }
                  />
                </label>
                <label>
                  <input
                    type='checkbox'
                    checked={item.enabled}
                    onChange={(event) =>
                      updateSuite((s) => ({
                        ...s,
                        cases: s.cases.map((c) =>
                          c.id === item.id ? { ...c, enabled: event.target.checked } : c,
                        ),
                      }))
                    }
                  />
                  회귀 실행에 포함
                </label>
                <p>
                  seed {item.seed} · 입력 {item.scenario.inputs.length} · 기대{' '}
                  {item.scenario.expectations.length}
                </p>
                <button
                  type='button'
                  disabled={running}
                  onClick={() =>
                    updateDraft((d) => ({
                      ...d,
                      configuration: {
                        ...d.configuration,
                        seed: item.seed,
                        scenario: structuredClone(item.scenario),
                        link: {
                          ...d.configuration.link,
                          environment: structuredClone(item.environment),
                        },
                      },
                      raw: {},
                      version: d.version + 1,
                      updatedAt: Date.now(),
                    }))
                  }
                >
                  사례를 초안에 불러오기 · {item.label}
                </button>
                <button
                  type='button'
                  disabled={!draft || running}
                  onClick={() => captureCase(item)}
                >
                  현재 초안 조건 반영 · {item.label}
                </button>
                <button
                  type='button'
                  disabled={running}
                  onClick={() =>
                    updateSuite((s) => ({ ...s, cases: s.cases.filter((c) => c.id !== item.id) }))
                  }
                >
                  사례 삭제 · {item.label}
                </button>
              </fieldset>
            ))}
            <button
              type='button'
              disabled={!draft || (suite?.cases.length ?? 0) >= 20 || running}
              onClick={() => captureCase()}
            >
              현재 조건을 스택 사례로 추가
            </button>
            <button
              type='button'
              disabled={!suite || !ready || running}
              onClick={() => {
                void launch('regression');
              }}
            >
              스택 회귀 검증 실행
            </button>
            <p>
              저장한 사례 {suite?.cases.length ?? 0} / 20 · 묶음 r{suite?.revision ?? 0}
            </p>
          </section>
          {summary && (
            <p role='status' className='stack-series-summary'>
              완료 {summary.completed} · 통과 {summary.passed} · 실패 {summary.failed} · 미판정{' '}
              {summary.undetermined} · 미실행·기록 없음 {summary.unrun} ·{' '}
              {series?.done ? '묶음 종료' : '실행 중'}
            </p>
          )}
          <section className='stack-card' aria-label='스택 검증 커버리지'>
            <h3>시나리오 묶음 검증 커버리지</h3>
            <label className='control'>
              이전 회귀 묶음과 비교
              <select
                aria-label='이전 회귀 묶음과 비교'
                value={previous?.id ?? ''}
                onChange={(event) => setBeforeGroup(event.target.value)}
              >
                {groups
                  .filter((g) => g.id !== group?.id)
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.label} · {g.id.slice(-12)}
                    </option>
                  ))}
              </select>
            </label>
            <p>같은 사례 ID·실제 조건·엔진 계약에서만 새 실패와 개선을 판단합니다.</p>
            {changes?.error && <p role='alert'>{changes.error}</p>}
            {changes?.value?.map((item) => (
              <p key={item.id}>
                {item.label} · {item.status}
                {item.leftId && (
                  <button type='button' onClick={() => open(item.leftId ?? '')}>
                    이전 사례 기록
                  </button>
                )}
                {item.rightId && (
                  <button type='button' onClick={() => open(item.rightId ?? '')}>
                    현재 사례 기록
                  </button>
                )}
              </p>
            ))}
            <label className='control'>
              회귀 실행 묶음
              <select
                value={group?.id ?? ''}
                onChange={(event) => {
                  setGroupId(event.target.value);
                  setCoveragePage(0);
                  setEndpoint('');
                }}
              >
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label} · {g.id.slice(-12)}
                  </option>
                ))}
              </select>
            </label>
            <label className='control'>
              커버리지 인스턴스
              <select
                value={endpoint}
                onChange={(event) => {
                  setEndpoint(event.target.value);
                  setCoveragePage(0);
                }}
              >
                <option value=''>모든 인스턴스</option>
                {groupRuns[0] &&
                  (['A', 'B'] as const).flatMap((participant) =>
                    groupRuns[0]?.view.snapshot.configuration.nodes[participant].instances.map(
                      (i) => (
                        <option key={`${participant}/${i.id}`}>
                          {participant}/{i.id}
                        </option>
                      ),
                    ),
                  )}
              </select>
            </label>
            <label>
              <input
                type='checkbox'
                checked={unobservedOnly}
                onChange={(event) => {
                  setUnobservedOnly(event.target.checked);
                  setCoveragePage(0);
                }}
              />
              미관찰 항목만
            </label>
            {coverage.error && <p role='alert'>{coverage.error}</p>}
            {coverage.value ? (
              <>
                <p>
                  {coverage.value.message} {coverage.value.partial ? '부분·누락 기록 포함' : ''}
                </p>
                <p>{coverage.value.cases.map((c) => `${c.label}: ${c.status}`).join(' · ')}</p>
                {coverage.value.excluded.map((e) => (
                  <p key={e.recordId}>
                    제외 {e.recordId.slice(-16)} · {e.reason}
                  </p>
                ))}
                <label className='control'>
                  커버리지 근거 사례
                  <select
                    aria-label='커버리지 근거 사례'
                    value={coverageCase || coverage.value.cases[0]?.id || ''}
                    onChange={(event) => setCoverageCase(event.target.value)}
                  >
                    {coverage.value.cases.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label.slice(0, 60)} · {c.status}
                      </option>
                    ))}
                  </select>
                </label>
                {coverage.value.items.map((item) => (
                  <article
                    key={`${item.endpoint}:${item.kind}:${item.id}`}
                    className='stack-coverage-item'
                  >
                    <strong>
                      {item.endpoint} · {item.kind} {item.id} ·{' '}
                      {item.count ? `${item.count}회 관찰` : '미관찰'}
                    </strong>
                    {item.evidence
                      .filter((e) => e.caseId === (coverageCase || coverage.value?.cases[0]?.id))
                      .map((e) => (
                        <button
                          type='button'
                          key={e.recordId}
                          onClick={() => open(e.recordId, e.cursor)}
                        >
                          {e.caseLabel} · 첫 관찰 #{e.cursor} · {e.count}회
                        </button>
                      ))}
                  </article>
                ))}
                {coverage.value.status === 'available' && (
                  <Pages
                    name='커버리지'
                    page={coverage.value.page}
                    pages={coverage.value.pages}
                    change={setCoveragePage}
                  />
                )}
              </>
            ) : (
              <p>{group ? '선택한 묶음 계산 중…' : '저장한 회귀 실행 묶음이 없습니다.'}</p>
            )}
          </section>
        </>
      )}
      {tab === '기록·비교' && (
        <>
          <section className='stack-card'>
            <h3>저장한 스택 실행</h3>
            <Pages name='저장 기록' page={selectedPage} pages={pages} change={setPage} />
            {[...runs]
              .reverse()
              .slice(selectedPage * 20, selectedPage * 20 + 20)
              .map((r) => (
                <article className='stack-library-row' key={r.id}>
                  <span className='stack-library-summary'>
                    {r.view.snapshot.configuration.label.slice(0, 70)} · {r.view.status} · seed{' '}
                    {r.view.snapshot.configuration.seed} · {r.view.events.length}개 ·{' '}
                    {r.series?.label}{' '}
                    {r.series ? `${r.series.index + 1}/${r.series.manifest.length}` : ''}
                  </span>
                  <button type='button' onClick={() => open(r.id)}>
                    스택 기록 재생 · {r.id.slice(-12)}
                  </button>
                  <button
                    type='button'
                    onClick={() => {
                      host.full.update((current) => ({
                        ...current,
                        stack: {
                          ...current.stack,
                          runs: current.stack.runs.filter((item) => item.id !== r.id),
                        },
                      }));
                      if (client) void client.forget(r).catch(() => {});
                    }}
                  >
                    스택 기록 삭제 · {r.id.slice(-12)}
                  </button>
                </article>
              ))}
            {!runs.length && <p>저장한 스택 실행이 없습니다.</p>}
          </section>
          <section className='stack-card' aria-label='두 스택 실행 비교'>
            <h3>두 실행 나란히 비교</h3>
            <div className='stack-node-grid'>
              {(
                [
                  ['왼쪽', leftId, setLeftId],
                  ['오른쪽', rightId, setRightId],
                ] as const
              ).map(([name, value, change]) => (
                <label key={name} className='control'>
                  {name} 스택 실행
                  <select
                    aria-label={`${name} 스택 실행`}
                    value={value}
                    onChange={(event) => {
                      change(event.target.value);
                      setComparePage(0);
                    }}
                  >
                    <option value=''>기록 선택</option>
                    {runs.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.view.snapshot.configuration.label.slice(0, 35)} · seed{' '}
                        {r.view.snapshot.configuration.seed} · {r.view.status} · {r.id.slice(-12)}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <button
              type='button'
              onClick={() => {
                setLeftId(rightId);
                setRightId(leftId);
                setComparePage(0);
              }}
            >
              스택 비교 좌우 바꾸기
            </button>
            {comparison.error && <p role='alert'>{comparison.error}</p>}
            {comparison.value && (
              <>
                <p role='status'>
                  비교 {comparison.value.status} · {comparison.value.message}
                </p>
                {comparison.value.limited && (
                  <p>비교 한도 또는 부분 관찰입니다. 미비교 내용을 동일하다고 판정하지 않습니다.</p>
                )}
                {comparison.value.firstDifference && (
                  <div className='stack-node-grid'>
                    {(['left', 'right'] as const).map((side) => {
                      const event = comparison.value?.firstDifference?.[side];
                      const source = side === 'left' ? left : right;
                      return (
                        <div key={side}>
                          {event && source && (
                            <button type='button' onClick={() => open(source.id, event.cursor)}>
                              {side === 'left' ? '왼쪽' : '오른쪽'} 첫 차이 #{event.cursor}로 이동
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className='stack-comparison-scroll'>
                  <table>
                    <caption>설정과 결과 차이</caption>
                    <thead>
                      <tr>
                        <th>항목·판정</th>
                        <th>왼쪽</th>
                        <th>오른쪽</th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparison.value.differences.map((d) => (
                        <tr key={d.path}>
                          <th>
                            {d.path} · {d.relation}
                          </th>
                          <td>{d.left}</td>
                          <td>{d.right}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <table>
                    <caption>순서를 보존한 관찰 대응 · 공유 원인 아님</caption>
                    <thead>
                      <tr>
                        <th>대응</th>
                        <th>왼쪽 관찰</th>
                        <th>오른쪽 관찰</th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparison.value.rows.map((row) => (
                        <tr key={`${row.left?.id ?? ''}:${row.right?.id ?? ''}`}>
                          <th>{row.relation}</th>
                          {(['left', 'right'] as const).map((side) => {
                            const event = row[side];
                            const source = side === 'left' ? left : right;
                            return (
                              <td key={side}>
                                {event && source ? (
                                  <button
                                    type='button'
                                    onClick={() => open(source.id, event.cursor)}
                                  >
                                    #{event.cursor} · {event.target} · {event.timeMs}ms ·{' '}
                                    {event.title}
                                  </button>
                                ) : (
                                  '대응 없음'
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pages
                  name='스택 비교'
                  page={comparison.value.page}
                  pages={comparison.value.pages}
                  change={setComparePage}
                />
              </>
            )}
          </section>
        </>
      )}
    </section>
  );
}
