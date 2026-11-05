import { expect, type Page, test } from '@playwright/test';
import { editExperiment } from '../../src/application/edit-experiment.ts';
import { createDraftRecord } from '../../src/application/workspace-operations.ts';
import type { DraftRecord, SavedRun } from '../../src/domain/workspace-model.ts';
import { createExampleCopy } from '../../src/examples/catalog.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';
import { runComparisonRecord } from '../fixtures/comparison-runs.ts';
import { runCoverageSuite } from '../fixtures/coverage-suite.ts';
import { createEventLimitExperiment } from '../fixtures/large-experiments.ts';
import { createSuiteDraft } from '../fixtures/scenario-suite.ts';

async function tab(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: '작업 공간' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function load(page: Page, draft: DraftRecord, runs: readonly SavedRun[]) {
  await page.goto('/');
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'run-comparison.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'protocol-studio-bundle',
        data: { schemaVersion: 1, activeDraftId: draft.id, drafts: [draft], runs },
      }),
    ),
  });
  await expect(page.getByText(/검증한 bundle을 적용/)).toBeVisible();
  await tab(page, '실행 비교');
}
async function choose(page: Page, left: SavedRun, right: SavedRun) {
  await page.getByRole('combobox', { name: '왼쪽 비교 실행', exact: true }).selectOption(left.id);
  await page
    .getByRole('combobox', { name: '오른쪽 비교 실행', exact: true })
    .selectOption(right.id);
  await expect(
    page.getByRole('region', { name: '두 실행 비교 결과', exact: true }),
  ).toHaveAttribute('data-comparison-status', 'ready');
}
const observations = (page: Page) =>
  page.getByRole('region', { name: '나란한 관찰 기록', exact: true });

test('normal and ACK-loss observations show variable differences, keep later transitions aligned and replay the selected side', async ({
  page,
}) => {
  const draft = createSuiteDraft();
  const records = runCoverageSuite(draft);
  const left = records[0];
  const right = records[1];
  if (!left || !right) throw new Error('Missing cases');
  await load(page, draft, records);
  await choose(page, left, right);
  await page.getByRole('combobox', { name: '비교 항목 종류', exact: true }).selectOption('A');
  const retries = page.locator('[data-compare-value="A:variable:retries"]');
  await expect(retries).toHaveAttribute('data-relation', 'different');
  await expect(retries.locator('td').nth(0)).toContainText('0');
  await expect(retries.locator('td').nth(1)).toContainText('1');
  await page.getByRole('button', { name: '첫 관찰 차이', exact: true }).click();
  await expect(page.locator('[data-compare-row][aria-selected="true"]')).toHaveCount(1);
  const visibleSelection = await page
    .locator('[data-compare-row][aria-selected="true"]')
    .evaluate((element) => {
      const row = element.getBoundingClientRect();
      const container = element.closest('.comparison-scroll')?.getBoundingClientRect();
      return (
        !!container &&
        row.top >= container.top - 1 &&
        row.bottom <= container.bottom + 1 &&
        row.top >= 0 &&
        row.bottom <= window.innerHeight + 1
      );
    });
  expect(visibleSelection).toBe(true);
  await page.getByRole('button', { name: '다음 관찰 페이지', exact: true }).click();
  const completion = observations(page)
    .getByRole('row')
    .filter({ hasText: 'A · transition · matching_ack' });
  await completion.getByRole('button').click();
  await expect(page.getByRole('region', { name: '왼쪽 선택 관찰', exact: true })).toContainText(
    'matching_ack',
  );
  await expect(page.getByRole('region', { name: '오른쪽 선택 관찰', exact: true })).toContainText(
    'matching_ack',
  );
  await page.getByRole('button', { name: '오른쪽 관련 기록 재생', exact: true }).click();
  await expect(page.getByRole('region', { name: '참여자 A 상태', exact: true })).toContainText(
    'Done',
  );
  await expect(page.getByRole('region', { name: '참여자 A 상태', exact: true })).toContainText(
    '"retries": 1',
  );
  await page.locator('summary').filter({ hasText: '실행 이유 설명' }).click();
  await expect(page.getByRole('region', { name: '선택 실행의 설명', exact: true })).toHaveAttribute(
    'data-explanation-status',
    'verified',
  );
  await tab(page, '실행 비교');
  await expect(page.getByRole('combobox', { name: '오른쪽 비교 실행', exact: true })).toHaveValue(
    right.id,
  );
});

test('variable pages stay bounded and saved history can reopen a pair or compare the same record', async ({
  page,
}) => {
  const base = createPingPongExperiment();
  const config = {
    ...base,
    definitions: base.definitions.map((protocol) => ({
      ...protocol,
      variables: [
        ...protocol.variables,
        ...Array.from({ length: 45 }, (_, index) => ({
          id: `extra_${index}`,
          type: 'integer' as const,
          initial: index,
        })),
      ],
    })),
  };
  const left = runComparisonRecord(config);
  const right = runComparisonRecord(config);
  await load(page, createDraftRecord(config), [left, right]);
  await choose(page, left, right);
  await page.getByRole('combobox', { name: '비교 항목 종류', exact: true }).selectOption('A');
  await expect(page.locator('[data-compare-value]')).toHaveCount(20);
  await page.getByRole('button', { name: '다음 비교 항목', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-compare-value]')).toHaveCount(20);
  await page.getByRole('button', { name: '다음 비교 항목', exact: true }).click();
  await expect(page.locator('[data-compare-value="A:variable:extra_44"]')).toContainText('44');
  await page.getByRole('button', { name: '왼쪽 저장 시점 재생', exact: true }).click();
  await page.getByRole('button', { name: '이 기록을 나란히 비교', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '왼쪽 비교 실행', exact: true })).toHaveValue(
    left.id,
  );
  await page.getByRole('combobox', { name: '오른쪽 비교 실행', exact: true }).selectOption(left.id);
  await expect(page.getByRole('button', { name: '첫 관찰 차이', exact: true })).toBeDisabled();
  await expect(observations(page)).toContainText('관찰 기록에서 차이를 찾지 못했습니다.');
});

test('delay-only differences and swapping sides expose signed time deltas rather than invented payload changes', async ({
  page,
}, info) => {
  const config = createPingPongExperiment();
  const left = runComparisonRecord(config);
  const right = runComparisonRecord(
    editExperiment(config, '/environment/directions/AtoB/delayMs', 20),
  );
  await load(page, createDraftRecord(config), [left, right]);
  await choose(page, left, right);
  await page.getByRole('button', { name: '첫 관찰 차이', exact: true }).click();
  await expect(page.locator('[data-compare-row][aria-selected="true"]')).toContainText('시각 차이');
  await expect(page.locator('[data-compare-row][aria-selected="true"]')).toContainText(
    '오른쪽 − 왼쪽: 10 ms',
  );
  await observations(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('comparison-desktop.png'), fullPage: false });
  await page.getByRole('button', { name: '왼쪽·오른쪽 바꾸기', exact: true }).click();
  await page.getByRole('button', { name: '첫 관찰 차이', exact: true }).click();
  await expect(page.locator('[data-compare-row][aria-selected="true"]')).toContainText(
    '오른쪽 − 왼쪽: -10 ms',
  );
});

test('a regression case opens the exact baseline/current pair and shows frozen expectation verdict changes', async ({
  page,
}) => {
  const draft = createSuiteDraft();
  const before = runCoverageSuite(draft);
  const current = {
    ...draft,
    version: 2,
    configuration: editExperiment(
      draft.configuration,
      '/definitions/0/rules/4/nextStateId',
      'Failed',
    ),
  };
  const after = runCoverageSuite(current);
  await load(page, current, [...before, ...after]);
  await tab(page, '시나리오 묶음');
  await page
    .getByRole('combobox', { name: '기준 검증 실행', exact: true })
    .selectOption(before[0]?.regression?.id ?? '');
  await page.getByRole('button', { name: '두 사례 나란히 비교 · 정상 전송', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '왼쪽 비교 실행', exact: true })).toHaveValue(
    before[0]?.id ?? '',
  );
  await expect(page.getByRole('combobox', { name: '오른쪽 비교 실행', exact: true })).toHaveValue(
    after[0]?.id ?? '',
  );
  await expect(page.getByRole('region', { name: '왼쪽 실행 요약', exact: true })).toContainText(
    '통과',
  );
  await expect(page.getByRole('region', { name: '오른쪽 실행 요약', exact: true })).toContainText(
    '실패',
  );
  await page
    .getByRole('combobox', { name: '비교 항목 종류', exact: true })
    .selectOption('expectation');
  await expect(page.getByRole('region', { name: '설정과 결과 차이', exact: true })).toContainText(
    '"status": "fail"',
  );
});

test('limited observations stay undetermined and one-sided rows show their absence explicitly', async ({
  page,
}) => {
  const config = createPingPongExperiment();
  const left = runComparisonRecord(config, { limits: { maxEvents: 2 } });
  const right = runComparisonRecord(config);
  await load(page, createDraftRecord(config), [left, right]);
  await choose(page, left, right);
  await expect(page.getByRole('region', { name: '왼쪽 실행 요약', exact: true })).toContainText(
    '미판정 · limit-reached',
  );
  await page.getByRole('checkbox', { name: '차이·한도 항목만 보기', exact: true }).check();
  await expect(page.locator('[data-compare-row][data-relation="same"]')).toHaveCount(0);
  await page.getByRole('button', { name: '첫 관찰 차이', exact: true }).click();
  await expect(page.getByRole('region', { name: '왼쪽 선택 관찰', exact: true })).toContainText(
    '대응 관찰 없음',
  );
  await expect(page.getByRole('button', { name: '왼쪽 관련 기록 재생', exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('button', { name: '오른쪽 관련 기록 재생', exact: true }),
  ).toBeVisible();
});

test('native save/reload and editing the current draft preserve captured comparison values', async ({
  page,
}) => {
  const config = createPingPongExperiment();
  const draft = { ...createDraftRecord(config), id: 'comparison_experiment' };
  const left = runComparisonRecord(config);
  const right = runComparisonRecord(config);
  await load(page, draft, [left, right]);
  await choose(page, left, right);
  await tab(page, '프로토콜');
  await page.locator('[data-path="/definitions/0/variables/0/initial"]').fill('999');
  await page.getByRole('button', { name: '지금 저장', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '로컬 저장과 파일' }).getByRole('status'),
  ).toHaveText('브라우저에 저장됨');
  await page.reload();
  await tab(page, '실행 비교');
  await choose(page, left, right);
  await page.getByRole('combobox', { name: '비교 항목 종류', exact: true }).selectOption('A');
  const counter = page.locator('[data-compare-value="A:variable:counter"]');
  await expect(counter).toHaveAttribute('data-relation', 'same');
  await expect(counter).not.toContainText('999');
  await expect(counter.locator('td').nth(0)).toContainText('1');
  await expect(page.getByRole('button', { name: '첫 관찰 차이', exact: true })).toBeDisabled();
});

test('two 10k traces paginate and support keyboard scrolling at 390px without document overflow', async ({
  page,
}, info) => {
  const config = createEventLimitExperiment();
  const left = runComparisonRecord(config);
  const right = runComparisonRecord(config);
  await load(page, createDraftRecord(config), [left, right]);
  await choose(page, left, right);
  await expect(page.locator('[data-compare-row]')).toHaveCount(20);
  await expect(page.locator('[data-compare-row]').first()).toHaveAttribute('data-compare-row', '0');
  await page.getByRole('button', { name: '다음 관찰 페이지', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-compare-row]').first()).toHaveAttribute(
    'data-compare-row',
    '20',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const scroll = page.getByRole('region', { name: '관찰 비교 표 스크롤', exact: true });
  await scroll.focus();
  await page.keyboard.press('ArrowRight');
  await expect(scroll).toBeFocused();
  expect(await scroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath('comparison-mobile.png'), fullPage: false });
});

test('unsupported versions and unrelated protocols keep independent saved summaries without invented trace matches', async ({
  page,
}) => {
  const config = createPingPongExperiment();
  const left = runComparisonRecord(config);
  const base = runComparisonRecord(config);
  const right = {
    ...base,
    view: { ...base.view, snapshot: { ...base.view.snapshot, engineVersion: 'future' } },
  };
  const other = runComparisonRecord(createExampleCopy('stop_wait'));
  await load(page, createDraftRecord(config), [left, right, other]);
  await page.getByRole('combobox', { name: '왼쪽 비교 실행', exact: true }).selectOption(left.id);
  await page
    .getByRole('combobox', { name: '오른쪽 비교 실행', exact: true })
    .selectOption(right.id);
  await expect(
    page.getByRole('region', { name: '두 실행 비교 결과', exact: true }),
  ).toHaveAttribute('data-comparison-status', 'unavailable');
  await expect(observations(page)).toContainText('지원하지 않는 엔진/난수 버전');
  await expect(page.locator('[data-compare-row]')).toHaveCount(0);
  await page
    .getByRole('combobox', { name: '오른쪽 비교 실행', exact: true })
    .selectOption(other.id);
  await expect(observations(page)).toContainText('서로 다른 프로토콜 ID');
  await page.getByRole('button', { name: '왼쪽 저장 시점 재생', exact: true }).click();
  await expect(page.getByRole('region', { name: '참여자 A 상태', exact: true })).toContainText(
    'Done',
  );
});

test('deleting a selected comparison record requests reselection and preserves the other side', async ({
  page,
}) => {
  const config = createPingPongExperiment();
  const left = runComparisonRecord(config);
  const right = runComparisonRecord(config);
  await load(page, createDraftRecord(config), [left, right]);
  await choose(page, left, right);
  await page.getByRole('button', { name: '왼쪽 저장 시점 재생', exact: true }).click();
  await page.getByRole('button', { name: '이 기록 삭제', exact: true }).click();
  await tab(page, '실행 비교');
  await expect(
    page.getByRole('region', { name: '두 실행 나란히 비교', exact: true }),
  ).toContainText('삭제되거나 없는 기록');
  await expect(page.getByRole('region', { name: '두 실행 비교 결과', exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '오른쪽 비교 실행', exact: true })).toHaveValue(
    right.id,
  );
});
