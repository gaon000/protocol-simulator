import { expect, type Page, test } from '@playwright/test';
import { createBatchSession, prepareBatch } from '../../src/application/batch-experiments.ts';
import { createWorkspace } from '../../src/application/workspace-operations.ts';
import type { WorkspaceEnvelope } from '../../src/domain/workspace-model.ts';
import { createExampleCopy } from '../../src/examples/catalog.ts';
import { createEventLimitExperiment } from '../fixtures/large-experiments.ts';

async function tab(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: '작업 공간' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function setup(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '실험 시작', exact: true }).click();
  await page.getByRole('button', { name: '재전송 실험 새 사본', exact: true }).click();
  await tab(page, '반복 실험');
}
async function save(page: Page) {
  await page.getByRole('button', { name: '지금 저장', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: '로컬 저장과 파일' })
      .getByRole('status')
      .filter({ hasText: /^브라우저에 저장됨$/ }),
  ).toBeVisible();
}
async function stored(page: Page): Promise<WorkspaceEnvelope> {
  return page.evaluate(
    async () =>
      new Promise<WorkspaceEnvelope>((resolve, reject) => {
        const request = indexedDB.open('protocol-studio', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('workspace', 'readonly');
          const get = tx.objectStore('workspace').get('current');
          tx.oncomplete = () => {
            db.close();
            resolve(get.result as WorkspaceEnvelope);
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
  );
}
async function run(page: Page) {
  await page.getByRole('button', { name: '반복 실행 시작', exact: true }).click();
  await expect(page.getByText('반복 실행을 완료했습니다.', { exact: true })).toBeVisible();
}

test('paired sweeps compare real pass/fail, preserve the draft and restore replayable results', async ({
  page,
}) => {
  await setup(page);
  await page.getByLabel('실행 묶음 이름', { exact: true }).fill('손실 비교');
  await page.getByLabel('seed 목록', { exact: true }).fill('1, 2');
  await page.getByLabel('지연 목록 ms', { exact: true }).fill('20');
  await page.getByLabel('손실률 목록 %', { exact: true }).fill('0, 100');
  await run(page);
  const table = page.getByRole('table', { name: '실행 묶음·환경 조건별 집계' });
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table.getByRole('row').nth(1)).toContainText('2 / 0 / 0');
  await expect(table.getByRole('row').nth(2)).toContainText('0 / 2 / 0');
  await save(page);
  const before = await stored(page);
  expect(before.data.runs).toHaveLength(4);
  const draft = before.data.drafts.find((record) => record.id === before.data.activeDraftId);
  expect(draft?.configuration.environment.directions.AtoB.delayMs).toBe(10);
  if (draft?.configuration.environment.kind === 'datagram')
    expect(draft.configuration.environment.directions.AtoB.lossRate).toBe(0);
  await page.reload();
  await tab(page, '반복 실험');
  await expect(table.getByRole('row')).toHaveCount(3);
  await page
    .getByRole('button', { name: '비교 1 · 조건 2 실행 목록 · 손실 비교', exact: true })
    .click();
  await page.getByRole('button', { name: 'seed 1 기록 재생', exact: true }).click();
  await expect(page.getByRole('region', { name: '참여자 A 상태' })).toContainText('Failed');
  await page.getByText('통신 시퀀스 보기', { exact: true }).click();
  await expect(page.getByRole('button', { name: /시퀀스 .*송신/ }).first()).toBeVisible();
  await page.getByRole('button', { name: '기록 처음', exact: true }).click();
  await expect(page.getByRole('region', { name: '참여자 A 상태' })).toContainText('Ready');
  expect((await stored(page)).data.runs).toEqual(before.data.runs);
});

test('two source versions stay independently comparable with a common seed list', async ({
  page,
}) => {
  await setup(page);
  await page.getByLabel('실행 묶음 이름', { exact: true }).fill('변경 전');
  await page.getByLabel('seed 목록', { exact: true }).fill('7, 8');
  await run(page);
  await tab(page, '통신 환경');
  await page.locator('[data-path="/environment/directions/AtoB/delayMs"]').fill('500');
  await tab(page, '반복 실험');
  await page.getByLabel('실행 묶음 이름', { exact: true }).fill('변경 후');
  await run(page);
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(3);
  await expect(page.getByRole('table')).toContainText('변경 전');
  await expect(page.getByRole('table')).toContainText('변경 후');
  await expect(page.getByText(/변경 전 · 기록 2\/2회/)).toContainText('현재 초안과 다른 버전');
  await save(page);
  const data = (await stored(page)).data;
  const batches = new Map(data.runs.map((record) => [record.batch?.label, record]));
  expect(
    batches.get('변경 전')?.view.snapshot.configuration.environment.directions.AtoB.delayMs,
  ).toBe(10);
  expect(
    batches.get('변경 후')?.view.snapshot.configuration.environment.directions.AtoB.delayMs,
  ).toBe(500);
  expect(batches.get('변경 전')?.batch?.seeds).toEqual(batches.get('변경 후')?.batch?.seeds);
});

test('bounded slices can be cancelled from another tab and stale callbacks never append more runs', async ({
  page,
}) => {
  await page.goto('/');
  const data = createWorkspace(createEventLimitExperiment());
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'large.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'protocol-studio-bundle', data })),
  });
  await expect(
    page.getByText('검증한 bundle을 적용했습니다. 충돌한 항목은 새 사본으로 추가했습니다.'),
  ).toBeVisible();
  await tab(page, '반복 실험');
  await page.getByLabel('seed 목록', { exact: true }).fill('1,2,3,4,5');
  await page.getByRole('button', { name: '반복 실행 시작', exact: true }).click();
  await expect(page.getByRole('progressbar', { name: '반복 실행 진행률' })).toBeVisible();
  await tab(page, '통신 환경');
  await page.getByRole('button', { name: '반복 실행 중단', exact: true }).click();
  await save(page);
  const before = await stored(page);
  const runs = before.data.runs.filter((record) => record.batch);
  expect(runs.length).toBeGreaterThan(0);
  expect(runs.length).toBeLessThan(5);
  // Stopping between engines preserves the completed record without inventing a cancellation.
  expect(['cancelled', 'limit-reached']).toContain(runs.at(-1)?.view.status);
  await tab(page, '반복 실험');
  await expect(page.getByRole('table')).toContainText('0 / 0 /');
  await page.getByRole('button', { name: /조건 1 실행 목록/ }).click();
  await expect(page.getByRole('region', { name: '조건별 실행 목록' })).toContainText('미판정 ·');
  await page.getByLabel('seed 목록', { exact: true }).fill('8');
  await run(page);
  await save(page);
  const after = await stored(page);
  expect(after.data.runs.filter((record) => record.batch?.id === runs[0]?.batch?.id)).toEqual(runs);
  expect(after.data.runs.at(-1)?.view.status).toBe('limit-reached');
});

test('validation blocks invalid lists, unfinished drafts and capacity overflow without creating runs', async ({
  page,
}) => {
  await setup(page);
  const start = page.getByRole('button', { name: '반복 실행 시작', exact: true });
  await page.getByLabel('seed 목록', { exact: true }).fill('1,1');
  await expect(start).toBeDisabled();
  await expect(page.getByText('각 목록에서 중복 값을 제거하세요.')).toBeVisible();
  await page.getByLabel('seed 목록', { exact: true }).fill('0,4294967295');
  await page.getByLabel('손실률 목록 %', { exact: true }).fill('101');
  await expect(start).toBeDisabled();
  await page.getByLabel('손실률 목록 %', { exact: true }).fill('0,100');
  await page
    .getByLabel('seed 목록', { exact: true })
    .fill(Array.from({ length: 51 }, (_, index) => index).join(','));
  await expect(start).toBeDisabled();
  await expect(page.getByText(/총 102회입니다/)).toBeVisible();
  await tab(page, '프로토콜');
  await page.locator('[data-path="/definitions/0/variables/0/initial"]').fill('{');
  await tab(page, '반복 실험');
  await page.getByLabel('seed 목록', { exact: true }).fill('1');
  await expect(start).toBeDisabled();
  await expect(page.getByText('초안의 정의 진단을 해결한 뒤 반복 실행하세요.')).toBeVisible();
  await save(page);
  expect((await stored(page)).data.runs).toHaveLength(0);
});

test('stream sweeps are keyboard operable and comparison tables scroll inside a 390px viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await tab(page, '반복 실험');
  await expect(page.getByLabel('손실률 목록 %', { exact: true })).toHaveCount(0);
  await page.getByLabel('seed 목록', { exact: true }).fill('1');
  await page.getByLabel('지연 목록 ms', { exact: true }).fill('10, 600');
  const start = page.getByRole('button', { name: '반복 실행 시작', exact: true });
  await start.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('반복 실행을 완료했습니다.', { exact: true })).toBeVisible();
  const scroll = page.getByRole('region', { name: '조건별 비교 표' });
  await scroll.focus();
  expect(await scroll.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => scroll.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: test.info().outputPath('batch-comparison-390.png'),
    fullPage: true,
  });
});

test('saved groups survive bundle import and the final available record cannot overflow the workspace', async ({
  page,
}) => {
  const data = createWorkspace(createExampleCopy('stop_wait'));
  const draft = data.drafts[0];
  if (!draft) throw new Error('Missing draft');
  const prepared = prepareBatch(
    draft.configuration,
    draft.id,
    draft.version,
    {
      label: '기존 결과',
      seeds: Array.from({ length: 99 }, (_, index) => index),
      delaysMs: [],
      lossRates: [],
      direction: 'both',
    },
    100,
  );
  if (!prepared.success) throw new Error('Invalid test plan');
  const runner = createBatchSession(prepared.value);
  const records = [];
  while (!runner.progress().done) {
    const record = runner.advance();
    if (record) records.push(record);
  }
  await page.goto('/');
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'batch.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'protocol-studio-bundle',
        data: { ...data, runs: records },
      }),
    ),
  });
  await expect(
    page.getByText('검증한 bundle을 적용했습니다. 충돌한 항목은 새 사본으로 추가했습니다.'),
  ).toBeVisible();
  await tab(page, '반복 실험');
  await expect(page.getByRole('table')).toContainText('99 / 0 / 0');
  const start = page.getByRole('button', { name: '반복 실행 시작', exact: true });
  await expect(start).toBeDisabled();
  await page.getByLabel('seed 목록', { exact: true }).fill('100');
  await page.getByLabel('실행 묶음 이름', { exact: true }).fill('마지막 실행');
  await run(page);
  await expect(start).toBeDisabled();
  await save(page);
  const result = await stored(page);
  expect(result.data.runs).toHaveLength(100);
  expect(result.data.runs.slice(0, 99)).toEqual(records);
  await tab(page, '실행');
  await page.getByRole('button', { name: '전체 실행', exact: true }).click();
  await expect(
    page.getByText('기록 100개 한도입니다. 먼저 불필요한 기록을 삭제하세요.'),
  ).toBeVisible();
  await save(page);
  expect((await stored(page)).data.runs).toHaveLength(100);
});
