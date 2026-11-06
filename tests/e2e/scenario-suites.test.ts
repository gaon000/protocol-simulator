import { expect, type Page, test } from '@playwright/test';
import { createScenarioSuite } from '../../src/application/scenario-suites.ts';
import { createDraftRecord } from '../../src/application/workspace-operations.ts';
import type { DraftRecord, WorkspaceEnvelope } from '../../src/domain/workspace-model.ts';
import { createExampleCopy } from '../../src/examples/catalog.ts';
import { createEventLimitExperiment } from '../fixtures/large-experiments.ts';
import { createSuiteDraft } from '../fixtures/scenario-suite.ts';

async function tab(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: '작업 공간' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function load(page: Page, draft: DraftRecord) {
  await page.goto('/');
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'suite.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'protocol-studio-bundle',
        data: { schemaVersion: 1, activeDraftId: draft.id, drafts: [draft], runs: [] },
      }),
    ),
  });
  await expect(page.getByText(/검증한 bundle을 적용/)).toBeVisible();
  await tab(page, '시나리오 묶음');
}
async function run(page: Page) {
  await page.getByRole('button', { name: '전체 사례 검증 시작', exact: true }).click();
  await expect(page.getByText('회귀 검증을 완료했습니다.', { exact: true })).toBeVisible();
}
async function save(page: Page) {
  await page.getByRole('button', { name: '지금 저장', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '로컬 저장과 파일' }).getByRole('status'),
  ).toHaveText('브라우저에 저장됨');
}
async function stored(page: Page): Promise<WorkspaceEnvelope> {
  return page.evaluate(
    async () =>
      new Promise<WorkspaceEnvelope>((resolve, reject) => {
        const request = indexedDB.open('protocol-studio', 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('workspace-v2', 'readonly');
          const get = tx.objectStore('workspace-v2').get('current');
          tx.oncomplete = () => {
            db.close();
            resolve({
              schemaVersion: 1,
              revision: get.result.revision,
              data: get.result.data.legacy,
            } as WorkspaceEnvelope);
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
  );
}
const editor = (page: Page) => page.getByRole('region', { name: '선택 사례 편집', exact: true });
const table = (page: Page) =>
  page.getByRole('table', { name: '시나리오 사례별 검증 결과', exact: true });

test('authors normal and expected timeout cases, detects a protocol regression and replays its explanation', async ({
  page,
}) => {
  await page.goto('/');
  await tab(page, '시나리오 묶음');
  await page.getByRole('button', { name: '현재 설정으로 묶음 만들기', exact: true }).click();
  await page.getByLabel('시나리오 묶음 이름', { exact: true }).fill('기본 검증');
  await page.getByLabel('사례 이름', { exact: true }).fill('정상 응답');
  await page.getByRole('button', { name: '선택 사례 복제', exact: true }).click();
  await page.getByLabel('사례 이름', { exact: true }).fill('응답 없음');
  await editor(page)
    .locator('[data-path="/scenario/expectations/0/stateId"]')
    .selectOption('Failed');
  await editor(page).locator('[data-path="/scenario/expectations/1/count"]').fill('0');
  await editor(page).getByRole('button', { name: '기대 조건 삭제', exact: true }).nth(3).click();
  await editor(page).getByRole('button', { name: '기대 조건 삭제', exact: true }).nth(2).click();
  await editor(page).locator('summary').filter({ hasText: '사례 통신 환경·seed' }).click();
  await editor(page).locator('[data-path="/environment/directions/AtoB/delayMs"]').fill('2000');
  await run(page);
  await expect(table(page).getByRole('row')).toHaveCount(3);
  await expect(table(page).getByRole('row').nth(1)).toContainText('통과 · completed');
  await expect(table(page).getByRole('row').nth(2)).toContainText('통과 · completed');
  await tab(page, '프로토콜');
  await page.locator('[data-path="/definitions/0/rules/2/nextStateId"]').selectOption('Failed');
  await tab(page, '시나리오 묶음');
  await run(page);
  const regression = table(page).getByRole('row').filter({ hasText: '정상 응답' });
  await expect(regression).toContainText('새 실패');
  await expect(table(page).getByRole('row').filter({ hasText: '응답 없음' })).toContainText('동일');
  await page.getByLabel('실패·미판정 사례만 보기', { exact: true }).check();
  await expect(table(page).getByRole('row')).toHaveCount(2);
  await page.getByRole('button', { name: '비교 사례 재생 · 정상 응답', exact: true }).click();
  await expect(page.getByRole('region', { name: '참여자 A 상태' })).toContainText('Failed');
  await page
    .getByRole('region', { name: '시퀀스 기록' })
    .getByRole('button', { name: /transition Failed/ })
    .click();
  await page.locator('summary').filter({ hasText: '실행 이유 설명' }).click();
  await expect(page.getByRole('region', { name: '선택 실행의 설명' })).toHaveAttribute(
    'data-explanation-status',
    'verified',
  );
});

test('case settings survive source edits, native reload and bundle collisions while changed conditions are not regressions', async ({
  page,
}) => {
  const draft = createSuiteDraft();
  await load(page, draft);
  await run(page);
  await page.getByLabel('사례 이름', { exact: true }).fill('조건을 바꾼 정상');
  await editor(page).locator('summary').filter({ hasText: '사례 통신 환경·seed' }).click();
  await editor(page).locator('[data-path="/seed"]').fill('123');
  await run(page);
  await expect(table(page).getByRole('row').filter({ hasText: '조건을 바꾼 정상' })).toContainText(
    '조건 변경',
  );
  await save(page);
  const before = await stored(page);
  expect(before.data.runs).toHaveLength(6);
  const active = before.data.drafts.find((item) => item.id === before.data.activeDraftId);
  expect(active?.configuration.seed).not.toBe(123);
  expect(active?.suite?.cases[0]?.seed).toBe(123);
  await page.reload();
  await tab(page, '시나리오 묶음');
  await expect(page.getByLabel('사례 이름', { exact: true })).toHaveValue('조건을 바꾼 정상');
  await expect(table(page).getByRole('row')).toHaveCount(4);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const path = await (await download).path();
  if (!path) throw new Error('Missing download');
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles(path);
  await expect(page.getByText(/검증한 bundle을 적용/)).toBeVisible();
  await save(page);
  const after = await stored(page);
  expect(after.data.runs).toHaveLength(12);
  expect(after.data.runs.slice(0, 6)).toEqual(before.data.runs);
  await tab(page, '시나리오 묶음');
  await expect(page.getByLabel('사례 이름', { exact: true })).toHaveValue('조건을 바꾼 정상');
});

test('unfinished case JSON is stored and blocks only enabled cases, with an explicit recovery to the last valid value', async ({
  page,
}) => {
  const draft = createDraftRecord(createExampleCopy('http_bad_header'));
  const first = draft.configuration.scenario.inputs[0];
  if (!first) throw new Error('Missing input');
  const field = Object.keys(first.message.values)[0];
  if (!field) throw new Error('Missing raw field');
  await load(page, draft);
  await page.getByRole('button', { name: '현재 설정으로 묶음 만들기', exact: true }).click();
  const input = editor(page).locator(`[data-path="/scenario/inputs/0/message/values/${field}"]`);
  await input.fill('{');
  await expect(
    page.getByRole('button', { name: '전체 사례 검증 시작', exact: true }),
  ).toBeDisabled();
  await save(page);
  await page.reload();
  await tab(page, '시나리오 묶음');
  await expect(input).toHaveValue('{');
  await page.getByRole('button', { name: '선택 사례 복제', exact: true }).click();
  await editor(page).getByLabel('전체 검증에 포함', { exact: true }).uncheck();
  await page.getByRole('combobox', { name: '편집할 사례', exact: true }).selectOption({ index: 0 });
  await editor(page).locator('summary').filter({ hasText: '보관한 JSON 입력' }).click();
  await page.getByRole('button', { name: '보관한 JSON 입력 되돌리기', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '전체 사례 검증 시작', exact: true }),
  ).toBeEnabled();
  await save(page);
  const data = (await stored(page)).data;
  const suite = data.drafts.find((item) => item.id === data.activeDraftId)?.suite;
  expect(suite?.cases[1]?.raw[`/scenario/inputs/0/message/values/${field}`]).toBe('{');
  expect(suite?.cases[1]?.enabled).toBe(false);
});

test('one series at a time, cancellation and new generations preserve incomplete manifests without stale callbacks', async ({
  page,
}) => {
  const base = createDraftRecord(createEventLimitExperiment());
  const suite = createScenarioSuite(base);
  const first = suite.cases[0];
  if (!first) throw new Error('Missing case');
  await load(page, {
    ...base,
    suite: {
      ...suite,
      cases: [
        first,
        ...Array.from({ length: 9 }, (_, index) => ({
          ...first,
          id: `case_${index + 2}`,
          label: `사례 ${index + 2}`,
        })),
      ],
    },
  });
  await page.getByRole('button', { name: '전체 사례 검증 시작', exact: true }).click();
  await expect(page.getByRole('progressbar', { name: '회귀 검증 진행률' })).toBeVisible();
  await tab(page, '반복 실험');
  await expect(page.getByRole('button', { name: '반복 실행 시작', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '회귀 검증 중단', exact: true }).click();
  await tab(page, '시나리오 묶음');
  await save(page);
  const data = (await stored(page)).data;
  const old = data.runs.filter((item) => item.regression);
  expect(old.length).toBeGreaterThan(0);
  expect(old.length).toBeLessThan(10);
  expect(old.every((record) => ['cancelled', 'limit-reached'].includes(record.view.status))).toBe(
    true,
  );
  await expect(table(page)).toContainText('미실행·삭제');
  await page.getByRole('button', { name: '실험 시작', exact: true }).click();
  await page.getByRole('button', { name: 'Ping/Pong 새 사본', exact: true }).click();
  await tab(page, '시나리오 묶음');
  await page.getByRole('button', { name: '현재 설정으로 묶음 만들기', exact: true }).click();
  await run(page);
  await save(page);
  expect(
    (await stored(page)).data.runs.filter(
      (record) => record.regression?.id === old[0]?.regression?.id,
    ),
  ).toEqual(old);
  await expect(table(page)).toContainText('통과');
});

test('keyboard creation, diagnostics and 390px results remain usable without page overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await tab(page, '시나리오 묶음');
  await page.getByRole('button', { name: '현재 설정으로 묶음 만들기', exact: true }).focus();
  await page.keyboard.press('Enter');
  await editor(page).locator('[data-path="/scenario/observationMs"]').fill('-1');
  await expect(
    page.getByRole('button', { name: '전체 사례 검증 시작', exact: true }),
  ).toBeDisabled();
  await editor(page)
    .getByRole('region', { name: '선택 사례 진단' })
    .getByRole('button')
    .first()
    .click();
  await expect(editor(page).locator('[data-path="/scenario/observationMs"]')).toBeFocused();
  await editor(page).locator('[data-path="/scenario/observationMs"]').fill('600');
  await run(page);
  const scroll = page.getByRole('region', { name: '사례별 회귀 비교 표' });
  await scroll.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => scroll.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('suite-390.png'), fullPage: true });
});
