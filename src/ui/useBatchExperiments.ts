import { useEffect, useRef, useState } from 'react';
import { type BatchPlan, createBatchSession } from '../application/batch-experiments.ts';
import { createRegressionSession, type RegressionPlan } from '../application/scenario-suites.ts';
import type { createWorkspaceController } from '../application/workspace-controller.ts';
import { type SavedRun, WORKSPACE_POLICY } from '../domain/workspace-model.ts';

type Progress = {
  readonly kind: 'batch' | 'regression';
  readonly running: boolean;
  readonly finished: number;
  readonly total: number;
  readonly message: string;
};

/** Schedule bounded independent engines and commit only complete or explicitly cancelled records. */
export function useBatchExperiments(controller: ReturnType<typeof createWorkspaceController>) {
  const session = useRef<ReturnType<typeof createBatchSession> | undefined>(undefined);
  const [progress, setProgress] = useState<Progress>({
    kind: 'batch',
    running: false,
    finished: 0,
    total: 0,
    message: '',
  });
  function append(record: SavedRun) {
    const data = controller.view().data;
    if (
      data.runs.length >= WORKSPACE_POLICY.maxRuns ||
      new TextEncoder().encode(JSON.stringify({ ...data, runs: [...data.runs, record] })).length >
        WORKSPACE_POLICY.maxBytes
    )
      throw new Error(
        '저장 공간 한도입니다. 이번 실행은 기록하지 못했습니다. 기존 결과를 내보내고 불필요한 기록을 삭제하세요.',
      );
    controller.update((current) => ({ ...current, runs: [...current.runs, record] }));
  }
  function stop(
    message = '실행 묶음을 중단했습니다. 시작하지 않은 사례/실행은 미실행으로 남습니다.',
  ) {
    const current = session.current;
    if (!current) return;
    session.current = undefined;
    let detail = message;
    const record = current.cancel();
    if (record) {
      try {
        append(record);
      } catch (error) {
        detail = error instanceof Error ? error.message : '기록 실패';
      }
    }
    setProgress((previous) => ({
      ...previous,
      ...current.progress(),
      finished: controller
        .view()
        .data.runs.filter((record) => (record.batch?.id ?? record.regression?.id) === current.id)
        .length,
      running: false,
      message: detail,
    }));
  }
  useEffect(() => {
    if (!progress.running) return;
    const current = session.current;
    const timeout = window.setTimeout(() => {
      if (!current || session.current !== current) return;
      try {
        const record = current.advance();
        if (record) append(record);
        const next = current.progress();
        setProgress({
          kind: progress.kind,
          running: !next.done,
          finished: next.finished,
          total: next.total,
          message: next.done
            ? progress.kind === 'batch'
              ? '반복 실행을 완료했습니다.'
              : '회귀 검증을 완료했습니다.'
            : '',
        });
        if (next.done) session.current = undefined;
      } catch (error) {
        stop(error instanceof Error ? error.message : '반복 실행 오류');
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  });
  useEffect(
    () => () => {
      session.current?.cancel();
      session.current = undefined;
    },
    [],
  );
  return {
    ...progress,
    stop,
    start(plan: BatchPlan) {
      stop();
      session.current = createBatchSession(plan);
      setProgress({
        kind: 'batch',
        running: true,
        finished: 0,
        total: plan.totalRuns,
        message: '',
      });
    },
    startRegression(plan: RegressionPlan) {
      stop();
      session.current = createRegressionSession(plan);
      setProgress({
        kind: 'regression',
        running: true,
        finished: 0,
        total: plan.totalRuns,
        message: '',
      });
    },
  };
}
