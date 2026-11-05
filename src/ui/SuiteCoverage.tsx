import { useMemo, useState } from 'react';
import type { DraftDiagramSelection } from '../application/diagram-authoring.ts';
import {
  buildSuiteCoverage,
  COVERAGE_POLICY,
  type CoverageItem,
} from '../application/suite-coverage.ts';
import type { SavedRun } from '../domain/workspace-model.ts';
import { StateDiagram } from './StateDiagram.tsx';

function ratio(items: readonly CoverageItem[]) {
  const covered = items.filter((item) => item.count > 0).length;
  return `${covered}/${items.length}${items.length ? ` (${Math.round((covered / items.length) * 100)}%)` : ' (해당 없음)'}`;
}
function CoverageContent({
  records,
  groupId,
  onInspect,
}: {
  records: readonly SavedRun[];
  groupId: string;
  onInspect: (record: SavedRun, position?: number) => void;
}) {
  const model = useMemo(() => buildSuiteCoverage(records, groupId), [records, groupId]);
  const [participant, setParticipant] = useState<'A' | 'B'>('A');
  const [selection, setSelection] = useState<DraftDiagramSelection>();
  const [kind, setKind] = useState<'state' | 'rule'>('rule');
  const [unobserved, setUnobserved] = useState(false);
  const [page, setPage] = useState(0);
  const actor = model.actors.find((item) => item.participant === participant);
  const chosen =
    selection ??
    (actor?.rules.length
      ? { kind: 'rule' as const, index: 0 }
      : { kind: 'state' as const, index: 0 });
  const metric = (chosen.kind === 'state' ? actor?.states : actor?.rules)?.[chosen.index];
  const items = ((kind === 'state' ? actor?.states : actor?.rules) ?? []).filter(
    (item) => !unobserved || item.count === 0,
  );
  const pages = Math.max(1, Math.ceil(items.length / COVERAGE_POLICY.pageSize));
  const current = Math.min(page, pages - 1);
  const counts = useMemo(
    () => ({
      states: new Map(actor?.states.map((item) => [item.id, item.count]) ?? []),
      rules: new Map(actor?.rules.map((item) => [item.id, item.count]) ?? []),
    }),
    [actor],
  );
  return (
    <section
      className='suite-coverage-content'
      aria-label='검증 커버리지 결과'
      data-coverage-status={model.status}
    >
      <p role='status'>{model.message}</p>
      {model.basis && (
        <p>
          검증 당시 공통 초안 v{model.basis.draftVersion} · 사례 묶음 v
          {model.basis.regression?.suiteRevision}
        </p>
      )}
      {model.status === 'ready' && (
        <>
          <p>
            집계 사례 {model.cases.filter((item) => item.status === 'included').length}/
            {model.cases.length}개 · 관찰 완료{' '}
            {model.cases.filter((item) => item.status === 'included' && !item.partial).length}개 ·
            부분 관찰 {model.cases.filter((item) => item.partial).length}개 · 미실행·삭제{' '}
            {model.cases.filter((item) => item.status === 'missing').length}개 · 제외{' '}
            {model.cases.filter((item) => item.status === 'excluded').length}개{' · 참여자 오류 '}
            {model.cases.filter((item) => item.reason.includes('오류')).length}개
          </p>
          <div className='coverage-summary'>
            {model.actors.map((item) => (
              <section
                key={item.participant}
                aria-label={`참여자 ${item.participant} 커버리지 요약`}
              >
                <h3>참여자 {item.participant}</h3>
                <p>상태 관찰 {ratio(item.states)}</p>
                <p>규칙 관찰 {ratio(item.rules)}</p>
              </section>
            ))}
          </div>
          <p className='hint'>
            상태 관찰 횟수는 사례의 초기 상태 1회와 실제 전이 후 상태를 셉니다. 자기 전이도
            포함합니다. 규칙 횟수는 실제 전이 기록만 셉니다. 중단/한도의 미관찰과 기대 조건 실패를
            혼동하지 마세요.
          </p>
          <label className='control'>
            <span>커버리지 참여자</span>
            <select
              value={participant}
              onChange={(event) => {
                setParticipant(event.target.value as 'A' | 'B');
                setSelection(undefined);
                setPage(0);
              }}
            >
              <option>A</option>
              <option>B</option>
            </select>
          </label>
          {actor && (
            <StateDiagram
              key={participant}
              protocol={actor.protocol}
              title={`참여자 ${participant} 검증 커버리지 상태도`}
              source={`검증 당시 ${actor.protocol.id} v${actor.protocol.revision} · 관찰 합계`}
              coverage={{ ...counts, selection: chosen }}
              readOnlyMessage='검증 당시 정의의 관찰 커버리지입니다. 조건 분기·경로 전체·도달 불가능을 판정하지 않습니다.'
              onInspect={(kind, index) => setSelection({ kind, index })}
            />
          )}
          <section aria-label='선택 항목의 실행 사례'>
            <h3>
              {chosen.kind === 'state' ? '상태' : '규칙'} {metric?.id.slice(0, 120)} · 관찰{' '}
              {metric?.count ?? 0}회 · 사례 {metric?.cases.length ?? 0}개
            </h3>
            {metric?.cases.map((item) => (
              <div className='coverage-case' key={item.record.id}>
                <p>
                  {item.label.slice(0, 80)} · {item.count}회 · 최초 관찰:{' '}
                  {item.position === 0
                    ? '초기 상태'
                    : item.record.view.events[item.position - 1]?.eventId}
                </p>
                <button type='button' onClick={() => onInspect(item.record, item.position)}>
                  커버리지 사례 재생 · {item.label.slice(0, 80)} · {item.caseIndex + 1}
                </button>
              </div>
            ))}
            {!metric?.cases.length && (
              <p>집계한 사례에서 관찰하지 않았습니다. 오류나 도달 불가능을 뜻하지 않습니다.</p>
            )}
          </section>
          <section aria-label='커버리지 항목 목록'>
            <div className='form-grid'>
              <label className='control'>
                <span>커버리지 항목 종류</span>
                <select
                  value={kind}
                  onChange={(event) => {
                    setKind(event.target.value as 'state' | 'rule');
                    setPage(0);
                  }}
                >
                  <option value='rule'>규칙</option>
                  <option value='state'>상태</option>
                </select>
              </label>
              <label className='check-control'>
                <span>미관찰 항목만 보기</span>
                <input
                  type='checkbox'
                  checked={unobserved}
                  onChange={(event) => {
                    setUnobserved(event.target.checked);
                    setPage(0);
                  }}
                />
              </label>
            </div>
            <div className='coverage-items'>
              {items
                .slice(current * COVERAGE_POLICY.pageSize, (current + 1) * COVERAGE_POLICY.pageSize)
                .map((item) => (
                  <button
                    key={item.id}
                    type='button'
                    data-coverage-item={item.id}
                    aria-pressed={chosen.kind === kind && chosen.index === item.index}
                    onClick={() => setSelection({ kind, index: item.index })}
                  >
                    {kind === 'rule' ? '규칙' : '상태'} {item.id.slice(0, 100)} · 관찰 {item.count}
                    회 · 사례 {item.cases.length}개
                  </button>
                ))}
            </div>
            {!items.length && <p>필터에 맞는 항목이 없습니다.</p>}
            {pages > 1 && (
              <nav className='sequence-controls' aria-label='커버리지 항목 페이지'>
                <button type='button' disabled={!current} onClick={() => setPage(current - 1)}>
                  커버리지 이전
                </button>
                <span>
                  {current + 1}/{pages} · 최대 20개
                </span>
                <button
                  type='button'
                  disabled={current + 1 >= pages}
                  onClick={() => setPage(current + 1)}
                >
                  커버리지 다음
                </button>
              </nav>
            )}
          </section>
        </>
      )}
      {model.cases.some(
        (item) => item.status !== 'included' || item.partial || item.reason.includes('오류'),
      ) && (
        <details>
          <summary>집계 범위와 제외 사유</summary>
          {model.cases.map((item) => (
            <p key={item.id}>
              {item.label.slice(0, 80)} · {item.reason}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}

/** Lazily summarize the selected suite execution; group changes reset selection to that frozen source. */
export function SuiteCoveragePanel({
  records,
  groupId,
  onInspect,
}: {
  records: readonly SavedRun[];
  groupId: string;
  onInspect: (record: SavedRun, position?: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      className='suite-coverage'
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>검증 커버리지 보기</summary>
      {expanded && (
        <CoverageContent key={groupId} records={records} groupId={groupId} onInspect={onInspect} />
      )}
    </details>
  );
}
