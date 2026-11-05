import { useMemo, useState } from 'react';
import {
  type BatchPlan,
  batchRunMetrics,
  parseBatchNumbers,
  prepareBatch,
  summarizeBatch,
} from '../application/batch-experiments.ts';
import type { ExperimentDefinition } from '../domain/protocol-model.ts';
import { type BatchRunInfo, type SavedRun, WORKSPACE_POLICY } from '../domain/workspace-model.ts';

const verdictLabels = { pass: '통과', fail: '실패', undetermined: '미판정' };
const directions = { both: '양방향', AtoB: 'A → B', BtoA: 'B → A' };
const number = (value: number | null) =>
  value === null ? '—' : Number(value.toFixed(2)).toLocaleString();
function environmentLabel(record: SavedRun | undefined): string {
  if (!record) return '';
  const environment = record.view.snapshot.configuration.environment;
  return (['AtoB', 'BtoA'] as const)
    .map((direction) => {
      const settings = environment.directions[direction];
      return `${directions[direction]} ${settings.delayMs} ms${'lossRate' in settings ? ` / 손실 ${number(settings.lossRate * 100)}%` : ''}`;
    })
    .join(' · ');
}
export type BatchForm = {
  readonly label: string;
  readonly seedsText: string;
  readonly delaysText: string;
  readonly lossText: string;
  readonly direction: BatchRunInfo['direction'];
};
export const DEFAULT_BATCH_FORM: BatchForm = {
  label: '비교 실험',
  seedsText: '1, 2, 3, 4, 5',
  delaysText: '',
  lossText: '',
  direction: 'both',
};

/** Configure paired-seed sweeps and compare saved observations from up to two source versions. */
export function BatchExperiments({
  draft,
  experimentId,
  draftVersion,
  records,
  invalid,
  running,
  busy = running,
  finished,
  total,
  message,
  form,
  onForm,
  onStart,
  onStop,
  onInspect,
}: {
  draft: ExperimentDefinition;
  experimentId: string;
  draftVersion: number;
  records: readonly SavedRun[];
  invalid: boolean;
  running: boolean;
  busy?: boolean;
  finished: number;
  total: number;
  message: string;
  form: BatchForm;
  onForm: (form: BatchForm) => void;
  onStart: (plan: BatchPlan) => void;
  onStop: () => void;
  onInspect: (record: SavedRun) => void;
}) {
  const { label, seedsText, delaysText, lossText, direction } = form;
  const update = (patch: Partial<BatchForm>) => onForm({ ...form, ...patch });
  const [choices, setChoices] = useState<readonly [string, string]>(['', '']);
  const [detailKey, setDetailKey] = useState('');
  const [page, setPage] = useState(0);
  const localRecords = useMemo(
    () => records.filter((record) => record.experimentId === experimentId && record.batch),
    [records, experimentId],
  );
  const batches = useMemo(
    () =>
      [
        ...new Map(localRecords.map((record) => [record.batch?.id ?? '', record])).values(),
      ].reverse(),
    [localRecords],
  );
  const firstId =
    choices[0] && batches.some((record) => record.batch?.id === choices[0])
      ? choices[0]
      : (batches[0]?.batch?.id ?? '');
  const secondId =
    choices[1] &&
    choices[1] !== firstId &&
    batches.some((record) => record.batch?.id === choices[1])
      ? choices[1]
      : '';
  const pairedSeeds =
    JSON.stringify(batches.find((record) => record.batch?.id === firstId)?.batch?.seeds) ===
    JSON.stringify(batches.find((record) => record.batch?.id === secondId)?.batch?.seeds);
  const visible = useMemo(
    () =>
      localRecords.filter(
        (record) => record.batch?.id === firstId || record.batch?.id === secondId,
      ),
    [localRecords, firstId, secondId],
  );
  const summaries = useMemo(() => summarizeBatch(visible), [visible]);
  const selected = summaries.find((row) => `${row.info.id}:${row.info.variantIndex}` === detailKey);
  const pages = Math.max(1, Math.ceil(summaries.length / 20));
  const currentPage = Math.min(page, pages - 1);
  const settings = useMemo(
    () =>
      prepareBatch(
        draft,
        experimentId,
        draftVersion,
        {
          label,
          seeds: parseBatchNumbers(seedsText),
          delaysMs: parseBatchNumbers(delaysText),
          lossRates:
            draft.environment.kind === 'stream'
              ? []
              : parseBatchNumbers(lossText).map((value) => value / 100),
          direction,
        },
        WORKSPACE_POLICY.maxRuns - records.length,
      ),
    [
      draft,
      experimentId,
      draftVersion,
      label,
      seedsText,
      delaysText,
      lossText,
      direction,
      records.length,
    ],
  );
  return (
    <section className='batch-experiments' aria-label='반복 실험과 결과 비교'>
      <fieldset disabled={busy} className='batch-settings'>
        <legend>반복 실행 조건</legend>
        <label className='control'>
          <span>실행 묶음 이름</span>
          <input
            value={label}
            maxLength={80}
            onChange={(event) => update({ label: event.target.value })}
          />
        </label>
        <label className='control'>
          <span>seed 목록</span>
          <input
            value={seedsText}
            onChange={(event) => update({ seedsText: event.target.value })}
            placeholder='1, 2, 3, 4, 5'
          />
        </label>
        <label className='control'>
          <span>지연 목록 ms</span>
          <input
            value={delaysText}
            onChange={(event) => update({ delaysText: event.target.value })}
            placeholder='현재 값 유지 또는 0, 20, 100'
          />
        </label>
        {draft.environment.kind === 'datagram' && (
          <label className='control'>
            <span>손실률 목록 %</span>
            <input
              value={lossText}
              onChange={(event) => update({ lossText: event.target.value })}
              placeholder='현재 값 유지 또는 0, 10, 30'
            />
          </label>
        )}
        <label className='control'>
          <span>변경 적용 방향</span>
          <select
            value={direction}
            onChange={(event) =>
              update({ direction: event.target.value as BatchRunInfo['direction'] })
            }
          >
            {(['both', 'AtoB', 'BtoA'] as const).map((item) => (
              <option key={item} value={item}>
                {directions[item]}
              </option>
            ))}
          </select>
        </label>
      </fieldset>
      <p className='hint'>
        쉼표로 값을 구분합니다. 각 조건에 같은 seed 목록을 사용하며 seed 개수가 반복 횟수입니다. 빈
        지연·손실 목록은 현재 값을 유지합니다. 지연 변동·중복·특정 손실·청크·연결 설정은 초안 값을
        유지합니다.
      </p>
      {settings.success ? (
        <p>
          조건 {settings.value.variants.length}개 × {settings.value.options.seeds.length}회 = 총{' '}
          {settings.value.totalRuns}회 · 초안 v{draftVersion}
        </p>
      ) : (
        <p role='status'>{settings.diagnostics[0]?.message}</p>
      )}
      {invalid && <p role='status'>초안의 정의 진단을 해결한 뒤 반복 실행하세요.</p>}
      <div className='run-toolbar'>
        <button
          type='button'
          className='primary'
          disabled={invalid || busy || !settings.success}
          onClick={() => {
            if (settings.success) {
              setChoices([settings.value.id, firstId]);
              setPage(0);
              setDetailKey('');
              onStart(settings.value);
            }
          }}
        >
          반복 실행 시작
        </button>
        <button type='button' disabled={!running} onClick={onStop}>
          반복 실행 중단
        </button>
      </div>
      <p role='status' aria-live='polite'>
        {running ? `반복 실행 중 · ${finished}/${total}회 기록` : message}
      </p>
      {running && <progress aria-label='반복 실행 진행률' value={finished} max={total} />}
      <p className='scope-note'>
        실행 시작 시 설정을 고정합니다. 초안 수정은 다음 묶음에 반영됩니다. 기록은 총 100개·작업
        공간 64 MiB 한도이며 자동 삭제하지 않습니다. ‘브라우저에 저장됨’을 확인한 뒤 다시 열어
        결과를 비교할 수 있습니다. 미완료 묶음은 자동 재개하지 않습니다.
      </p>
      <h2>결과 비교</h2>
      {!batches.length ? (
        <p>반복 실행을 시작하면 조건별 결과가 여기에 나타납니다.</p>
      ) : (
        <>
          <div className='form-grid'>
            {([0, 1] as const).map((index) => (
              <label className='control' key={index}>
                <span>{index === 0 ? '비교 묶음 1' : '비교 묶음 2'}</span>
                <select
                  value={index === 0 ? firstId : secondId}
                  onChange={(event) => {
                    const value = event.target.value;
                    setChoices(
                      index === 0 ? [value, secondId === value ? '' : secondId] : [firstId, value],
                    );
                    setPage(0);
                    setDetailKey('');
                  }}
                >
                  {index === 1 && <option value=''>추가 비교 없음</option>}
                  {batches
                    .filter((record) => index === 0 || record.batch?.id !== firstId)
                    .map((record) => (
                      <option key={record.batch?.id} value={record.batch?.id}>
                        {record.batch?.label} · 초안 v{record.draftVersion} ·{' '}
                        {new Date(record.createdAt).toLocaleString()} · {record.batch?.id.slice(-6)}
                      </option>
                    ))}
                </select>
              </label>
            ))}
          </div>
          <p className='hint'>
            통과율 = 통과 실행 / 저장된 실행. 미판정도 분모에 포함하며 미실행·삭제된 실행은 별도로
            표시합니다. 가상 완료 시간은 통과 실행의 성공 종료 참여자 중 마지막 종료 시각입니다.
            계속 대기하는 참여자는 제외하며 표에 평균의 표본 수를 함께 표시합니다.
          </p>
          {secondId && !pairedSeeds && (
            <p role='status'>
              두 묶음의 seed 목록이 다릅니다. 동일한 난수 조건을 비교하려면 같은 seed 목록으로
              실행하세요.
            </p>
          )}
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Native horizontal table scrolling must be keyboard accessible. */}
          <section className='batch-table-scroll' aria-label='조건별 비교 표' tabIndex={0}>
            <table className='batch-table'>
              <caption>실행 묶음·환경 조건별 집계</caption>
              <thead>
                <tr>
                  <th scope='col'>묶음 / 조건</th>
                  <th scope='col'>통과 / 실패 / 미판정</th>
                  <th scope='col'>통과율</th>
                  <th scope='col'>미실행·삭제</th>
                  <th scope='col'>가상 완료 평균 ms</th>
                  <th scope='col'>송신 평균</th>
                  <th scope='col'>타이머 만료 평균</th>
                  <th scope='col'>기록</th>
                </tr>
              </thead>
              <tbody>
                {summaries.slice(currentPage * 20, currentPage * 20 + 20).map((row) => (
                  <tr key={`${row.info.id}:${row.info.variantIndex}`}>
                    <th scope='row'>
                      비교 {row.info.id === firstId ? 1 : 2}
                      <br />
                      {row.info.label} · 초안 v{row.records[0]?.draftVersion}
                      <br />
                      조건 {row.info.variantIndex + 1} · {directions[row.info.direction]}
                      <br />
                      지연 {row.info.delayMs === null ? '초안 값' : `${row.info.delayMs} ms`} · 손실{' '}
                      {row.info.lossRate === null
                        ? '초안 값'
                        : `${number(row.info.lossRate * 100)}%`}
                      <br />
                      <small>{environmentLabel(row.records[0])}</small>
                    </th>
                    <td>
                      {row.pass} / {row.fail} / {row.undetermined}
                      <br />
                      기록 {row.records.length}/{row.info.seeds.length}회
                    </td>
                    <td>{number((row.pass / row.records.length) * 100)}%</td>
                    <td>{row.missing}</td>
                    <td>
                      {number(row.meanCompletionMs)} ({row.completionSamples}개)
                    </td>
                    <td>{number(row.meanSends)}</td>
                    <td>{number(row.meanExpiries)}</td>
                    <td>
                      <button
                        type='button'
                        aria-label={`비교 ${row.info.id === firstId ? 1 : 2} · 조건 ${row.info.variantIndex + 1} 실행 목록 · ${row.info.label}`}
                        onClick={() => setDetailKey(`${row.info.id}:${row.info.variantIndex}`)}
                      >
                        조건 {row.info.variantIndex + 1} 실행 목록 · {row.info.label}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <div className='run-toolbar'>
            <button
              type='button'
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              이전 비교 조건
            </button>
            <span>
              조건 페이지 {currentPage + 1}/{pages}
            </span>
            <button
              type='button'
              disabled={currentPage + 1 >= pages}
              onClick={() => setPage(currentPage + 1)}
            >
              다음 비교 조건
            </button>
          </div>
          {[firstId, secondId].filter(Boolean).map((id) => {
            const group = localRecords.filter((record) => record.batch?.id === id);
            const info = group[0]?.batch;
            return info ? (
              <p key={id}>
                {info.label} · 기록 {group.length}/{info.totalRuns}회 · seed [
                {info.seeds.join(', ')}]
                {group[0]?.draftVersion !== draftVersion ? ' · 현재 초안과 다른 버전' : ''} ·{' '}
                {info.variantCount -
                  new Set(group.map((record) => record.batch?.variantIndex)).size}
                개 조건 미실행·전체 삭제
              </p>
            ) : null;
          })}
          {selected && (
            <section aria-label='조건별 실행 목록'>
              <h3>
                {selected.info.label} · 조건 {selected.info.variantIndex + 1} 실행 목록
              </h3>
              <p>
                기대 조건 판정과 엔진 종료 상태는 별개입니다. 취소·자원 제한·미완료 관찰을 실패로
                합치지 않습니다.
              </p>
              <ul className='batch-records'>
                {selected.records.map((record) => {
                  const metrics = batchRunMetrics(record.view);
                  return (
                    <li key={record.id}>
                      <span>
                        seed {record.view.snapshot.seed} · {verdictLabels[metrics.verdict]} ·{' '}
                        {record.view.status} · 송신 {metrics.sends}회 · 만료 {metrics.expiries}회
                      </span>
                      <button type='button' onClick={() => onInspect(record)}>
                        seed {record.view.snapshot.seed} 기록 재생
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      )}
    </section>
  );
}
