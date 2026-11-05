/** biome-ignore-all lint/suspicious/noArrayIndexKey: Diagnostic rows are stateless and paths/codes can repeat. */
import { useMemo, useRef, useState } from 'react';
import { batchRunMetrics } from '../application/batch-experiments.ts';
import {
  captureScenarioCase,
  checkRegression,
  compareRegressionRuns,
  createScenarioSuite,
  editScenarioCase,
  editScenarioCaseJson,
  prepareRegression,
  type RegressionPlan,
  scenarioCaseDiagnostics,
} from '../application/scenario-suites.ts';
import { workspaceId } from '../application/workspace-operations.ts';
import { caseConfiguration } from '../domain/suite-validation.ts';
import {
  type DraftRecord,
  type SavedRun,
  type ScenarioCase,
  type ScenarioSuite,
  WORKSPACE_POLICY,
} from '../domain/workspace-model.ts';
import { EnvironmentEditor } from './EnvironmentEditor.tsx';
import { EditorContext } from './forms.tsx';
import { ScenarioEditor } from './ScenarioEditor.tsx';

const verdicts = { pass: '통과', fail: '실패', undetermined: '미판정' };
function verdict(record: SavedRun | undefined) {
  return record
    ? `${verdicts[batchRunMetrics(record.view).verdict]} · ${record.view.status}`
    : '미실행·삭제';
}

/** Author case-owned settings and compare immutable suite executions using existing form and replay tools. */
export function ScenarioSuitePanel({
  draft,
  records,
  busy,
  running,
  finished,
  total,
  message,
  onSuite,
  onStart,
  onStop,
  onInspect,
  onSharedEdit,
}: {
  draft: DraftRecord;
  records: readonly SavedRun[];
  busy: boolean;
  running: boolean;
  finished: number;
  total: number;
  message: string;
  onSuite: (suite: ScenarioSuite | undefined) => void;
  onStart: (plan: RegressionPlan) => void;
  onStop: () => void;
  onInspect: (record: SavedRun) => void;
  onSharedEdit: (path: string) => void;
}) {
  const suite = draft.suite;
  const editor = useRef<HTMLElement>(null);
  const [selectedId, setSelectedId] = useState('');
  const [choices, setChoices] = useState<readonly [string, string]>(['', '']);
  const [filter, setFilter] = useState(false);
  const [editingInputs, setEditingInputs] = useState(true);
  const [page, setPage] = useState(0);
  const item = suite?.cases.find((entry) => entry.id === selectedId) ?? suite?.cases[0];
  const diagnostics = useMemo(
    () => (item ? scenarioCaseDiagnostics(draft, item) : []),
    [draft, item],
  );
  const preparation = useMemo(
    () => checkRegression(draft, WORKSPACE_POLICY.maxRuns - records.length),
    [draft, records.length],
  );
  const local = useMemo(
    () => records.filter((record) => record.experimentId === draft.id && record.regression),
    [records, draft.id],
  );
  const groups = useMemo(
    () => [...new Map(local.map((record) => [record.regression?.id, record])).values()].reverse(),
    [local],
  );
  const currentId = groups.some((record) => record.regression?.id === choices[0])
    ? choices[0]
    : (groups[0]?.regression?.id ?? '');
  const baselineId =
    choices[1] !== currentId && groups.some((record) => record.regression?.id === choices[1])
      ? choices[1]
      : '';
  const rows = useMemo(
    () => compareRegressionRuns(local, currentId, baselineId),
    [local, currentId, baselineId],
  );
  const shown = filter
    ? rows.filter(
        (row) =>
          row.change === '새 실패' ||
          (row.current && batchRunMetrics(row.current.view).verdict !== 'pass'),
      )
    : rows;
  const pages = Math.max(1, Math.ceil(shown.length / 20));
  const currentPage = Math.min(page, pages - 1);
  function update(next: ScenarioCase) {
    if (suite)
      onSuite({
        ...suite,
        cases: suite.cases.map((entry) => (entry.id === next.id ? next : entry)),
      });
  }
  function focus(path: string) {
    if (!path.startsWith('/scenario') && !path.startsWith('/environment') && path !== '/seed') {
      onSharedEdit(path);
      return;
    }
    const elements = [...(editor.current?.querySelectorAll<HTMLElement>('[data-path]') ?? [])];
    let location = path;
    let target: HTMLElement | undefined;
    while (location && !target) {
      target = elements.find((element) => element.dataset.path === location);
      location = location.slice(0, location.lastIndexOf('/'));
    }
    if (!target) return;
    for (let parent = target.parentElement; parent; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    target.focus();
    target.scrollIntoView({ block: 'center' });
  }
  return (
    <section className='scenario-suite' aria-label='시나리오 묶음과 회귀 검증'>
      <p className='hint'>
        프로토콜은 현재 초안을 공유하고, 사례별 입력·기대 조건·통신 환경·seed는 따로 보존합니다.
        실행 시작 시 공통 프로토콜과 활성 사례를 고정합니다.
      </p>
      {!suite ? (
        <button type='button' disabled={busy} onClick={() => onSuite(createScenarioSuite(draft))}>
          현재 설정으로 묶음 만들기
        </button>
      ) : (
        <>
          <fieldset disabled={busy} className='batch-settings'>
            <legend>검증 사례 편집</legend>
            <label className='control'>
              <span>시나리오 묶음 이름</span>
              <input
                maxLength={80}
                value={suite.label}
                onChange={(event) => onSuite({ ...suite, label: event.target.value })}
              />
            </label>
            <p>
              공통 프로토콜 초안 v{draft.version} · 사례 묶음 v{suite.revision} ·{' '}
              {suite.cases.filter((entry) => entry.enabled).length}/{suite.cases.length}개 활성
            </p>
            <label className='control'>
              <span>편집할 사례</span>
              <select
                value={item?.id ?? ''}
                onChange={(event) => {
                  setSelectedId(event.target.value);
                  setEditingInputs(true);
                }}
              >
                {!suite.cases.length && <option value=''>사례 없음</option>}
                {suite.cases.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label || '이름 없는 사례'} · {entry.enabled ? '활성' : '제외'} ·{' '}
                    {entry.id.slice(-6)}
                  </option>
                ))}
              </select>
            </label>
            <div className='run-toolbar'>
              <button
                type='button'
                disabled={suite.cases.length >= WORKSPACE_POLICY.maxCases}
                onClick={() => {
                  const entry = captureScenarioCase(draft, `사례 ${suite.cases.length + 1}`);
                  onSuite({ ...suite, cases: [...suite.cases, entry] });
                  setSelectedId(entry.id);
                  setEditingInputs(true);
                }}
              >
                현재 설정을 사례로 추가
              </button>
              <button
                type='button'
                disabled={!item || suite.cases.length >= WORKSPACE_POLICY.maxCases}
                onClick={() => {
                  if (!item) return;
                  const copy = {
                    ...structuredClone(item),
                    id: workspaceId('case'),
                    label: `${item.label} 사본`.slice(0, 80),
                  };
                  onSuite({ ...suite, cases: [...suite.cases, copy] });
                  setSelectedId(copy.id);
                  setEditingInputs(true);
                }}
              >
                선택 사례 복제
              </button>
              <button
                type='button'
                disabled={!item}
                onClick={() => {
                  onSuite({
                    ...suite,
                    cases: suite.cases.filter((entry) => entry.id !== item?.id),
                  });
                  setSelectedId('');
                }}
              >
                선택 사례 삭제
              </button>
              <button type='button' className='danger' onClick={() => onSuite(undefined)}>
                시나리오 묶음 삭제
              </button>
            </div>
            {item && (
              <section aria-label='선택 사례 편집' ref={editor}>
                <label className='control'>
                  <span>사례 이름</span>
                  <input
                    value={item.label}
                    maxLength={80}
                    onChange={(event) => update({ ...item, label: event.target.value })}
                  />
                </label>
                <label className='check-control'>
                  <span>전체 검증에 포함</span>
                  <input
                    type='checkbox'
                    checked={item.enabled}
                    onChange={(event) => update({ ...item, enabled: event.target.checked })}
                  />
                </label>
                <EditorContext
                  value={{
                    draft: caseConfiguration(draft.configuration, item),
                    raw: item.raw,
                    diagnostics,
                    edit: (path, value) =>
                      update(editScenarioCase(draft.configuration, item, path, value)),
                    editJson: (path, text) =>
                      update(editScenarioCaseJson(draft.configuration, item, path, text)),
                  }}
                >
                  <details
                    open={editingInputs}
                    onToggle={(event) => setEditingInputs(event.currentTarget.open)}
                  >
                    <summary>사례 입력·기대 조건</summary>
                    <ScenarioEditor />
                  </details>
                  <details>
                    <summary>사례 통신 환경·seed</summary>
                    <button
                      type='button'
                      onClick={() =>
                        update({
                          ...item,
                          environment: structuredClone(draft.configuration.environment),
                        })
                      }
                    >
                      현재 초안의 환경 적용
                    </button>
                    <EnvironmentEditor />
                  </details>
                </EditorContext>
                {!!Object.keys(item.raw).length && (
                  <details>
                    <summary>보관한 JSON 입력</summary>
                    {Object.entries(item.raw)
                      .slice(0, 20)
                      .map(([path, text]) => (
                        <div key={path}>
                          <p>{path.slice(0, 240)}</p>
                          <pre>{text.slice(0, 1000)}</pre>
                        </div>
                      ))}
                    <button type='button' onClick={() => update({ ...item, raw: {} })}>
                      보관한 JSON 입력 되돌리기
                    </button>
                    <p>마지막 유효한 값으로 돌아갑니다.</p>
                  </details>
                )}
                <section aria-label='선택 사례 진단'>
                  <h3>사례 진단 · {diagnostics.length}개</h3>
                  {diagnostics.slice(0, 20).map((diagnostic, index) => (
                    <p key={`${diagnostic.path}-${diagnostic.code}-${index}`}>
                      <button type='button' onClick={() => focus(diagnostic.path)}>
                        {diagnostic.code} · {diagnostic.message.slice(0, 240)} · 편집 위치
                      </button>
                    </p>
                  ))}
                </section>
              </section>
            )}
          </fieldset>
          <h2>전체 사례 검증</h2>
          {!preparation.success && <p role='status'>{preparation.diagnostics[0]?.message}</p>}
          <div className='run-toolbar'>
            <button
              type='button'
              className='primary'
              disabled={busy || !preparation.success}
              onClick={() => {
                const prepared = prepareRegression(
                  draft,
                  WORKSPACE_POLICY.maxRuns - records.length,
                );
                if (!prepared.success) return;
                setChoices([prepared.value.id, currentId]);
                setFilter(false);
                setPage(0);
                setEditingInputs(false);
                onStart(prepared.value);
              }}
            >
              전체 사례 검증 시작
            </button>
            <button type='button' disabled={!running} onClick={onStop}>
              회귀 검증 중단
            </button>
          </div>
        </>
      )}
      <p role='status'>{running ? `회귀 검증 중 · ${finished}/${total}개 기록` : message}</p>
      {running && <progress aria-label='회귀 검증 진행률' value={finished} max={total} />}
      <p className='scope-note'>
        최대 20사례이며 실행 기록은 다른 실행과 합쳐 100개·작업 공간 64 MiB 한도입니다.
        중단/오류/한도는 미판정으로 남기고 미실행·삭제된 기록을 실패로 만들지 않습니다. ‘브라우저에
        저장됨’ 이후 다시 열면 복원하며 자동 재개하지 않습니다.
      </p>
      <h2>사례별 결과와 수정 전후 비교</h2>
      {!groups.length ? (
        <p>전체 사례 검증을 실행하면 결과가 나타납니다.</p>
      ) : (
        <>
          <div className='form-grid'>
            {([0, 1] as const).map((index) => (
              <label className='control' key={index}>
                <span>{index === 0 ? '비교할 검증 실행' : '기준 검증 실행'}</span>
                <select
                  value={index === 0 ? currentId : baselineId}
                  onChange={(event) =>
                    setChoices(
                      index === 0
                        ? [event.target.value, event.target.value === baselineId ? '' : baselineId]
                        : [currentId, event.target.value],
                    )
                  }
                >
                  {index === 1 && <option value=''>기준 없음</option>}
                  {groups
                    .filter((record) => index === 0 || record.regression?.id !== currentId)
                    .map((record) => (
                      <option value={record.regression?.id} key={record.regression?.id}>
                        {record.regression?.label} · 초안 v{record.draftVersion} / 사례 v
                        {record.regression?.suiteRevision} ·{' '}
                        {new Date(record.createdAt).toLocaleString()} ·{' '}
                        {record.regression?.id.slice(-6)}
                      </option>
                    ))}
                </select>
              </label>
            ))}
          </div>
          <p className='hint'>
            동일한 묶음·사례의 입력/기대 조건·환경·seed와 엔진 계약이 같을 때만 통과→실패를 ‘새
            실패’, 실패→통과를 ‘개선’으로 표시합니다. 조건 변경과 미판정·미실행·비교 대상 제외는
            구분합니다.
          </p>
          {[currentId, baselineId].filter(Boolean).map((id) => {
            const group = local.filter((record) => record.regression?.id === id);
            const record = group[0];
            return record?.regression ? (
              <p key={id}>
                {id === currentId ? '비교' : '기준'} · 공통 초안 v{record.draftVersion} / 사례 v
                {record.regression.suiteRevision} · 기록 {group.length}/
                {record.regression.cases.length}개
                {record.draftVersion !== draft.version ||
                record.regression.suiteRevision !== suite?.revision
                  ? ' · 현재 편집본과 다른 버전'
                  : ''}
              </p>
            ) : null;
          })}
          <label className='check-control'>
            <span>실패·미판정 사례만 보기</span>
            <input
              type='checkbox'
              checked={filter}
              onChange={(event) => {
                setFilter(event.target.checked);
                setPage(0);
              }}
            />
          </label>
          <p>
            사례 {rows.length}개 · 새 실패 {rows.filter((row) => row.change === '새 실패').length}개
            · 개선 {rows.filter((row) => row.change === '개선').length}개
          </p>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Native horizontal scrolling is a keyboard operation. */}
          <section className='batch-table-scroll' aria-label='사례별 회귀 비교 표' tabIndex={0}>
            <table className='batch-table'>
              <caption>시나리오 사례별 검증 결과</caption>
              <thead>
                <tr>
                  <th scope='col'>사례</th>
                  <th scope='col'>기준 결과</th>
                  <th scope='col'>비교 결과</th>
                  <th scope='col'>변화</th>
                  <th scope='col'>상태도·설명 재생</th>
                </tr>
              </thead>
              <tbody>
                {shown.slice(currentPage * 20, currentPage * 20 + 20).map((row) => (
                  <tr key={row.id} data-regression-case={row.id}>
                    <th scope='row'>
                      {row.label.slice(0, 80)} · {row.id.slice(-6)}
                    </th>
                    <td>
                      {!baselineId
                        ? '기준 없음'
                        : row.baselineIncluded
                          ? verdict(row.baseline)
                          : '대상 없음'}
                    </td>
                    <td>{row.currentIncluded ? verdict(row.current) : '대상 없음'}</td>
                    <td>{row.change}</td>
                    <td>
                      {row.current && (
                        <button type='button' onClick={() => onInspect(row.current as SavedRun)}>
                          비교 사례 재생 · {row.label.slice(0, 80)}
                        </button>
                      )}
                      {row.baseline && (
                        <button type='button' onClick={() => onInspect(row.baseline as SavedRun)}>
                          기준 사례 재생 · {row.label.slice(0, 80)}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!shown.length && <p>필터에 맞는 사례가 없습니다.</p>}
          </section>
          {pages > 1 && (
            <nav className='run-toolbar' aria-label='사례 결과 페이지'>
              <button
                type='button'
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                이전 사례 결과
              </button>
              <span>
                {currentPage + 1}/{pages} · 최대 20개
              </span>
              <button
                type='button'
                disabled={currentPage + 1 >= pages}
                onClick={() => setPage(currentPage + 1)}
              >
                다음 사례 결과
              </button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}
