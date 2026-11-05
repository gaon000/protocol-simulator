import { expect, type Page, test } from '@playwright/test';
import {
  createRegressionSession,
  prepareRegression,
} from '../../src/application/scenario-suites.ts';
import type { DraftRecord, SavedRun } from '../../src/domain/workspace-model.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';
import {
  createCoverageDraft,
  createPagedCoverageDraft,
  runCoverageSuite,
} from '../fixtures/coverage-suite.ts';
import { createEventLimitExperiment } from '../fixtures/large-experiments.ts';
import { createSuiteDraft } from '../fixtures/scenario-suite.ts';

async function tab(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: '작업 공간' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function load(page: Page, draft: DraftRecord, runs: readonly SavedRun[] = []) {
  await page.goto('/');
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'coverage.json',
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
  await tab(page, '시나리오 묶음');
}
async function open(page: Page) {
  await page.locator('.suite-coverage summary').click();
  await expect(
    page.getByRole('region', { name: '검증 커버리지 결과', exact: true }),
  ).toHaveAttribute('data-coverage-status', 'ready');
}
const graph = (page: Page) =>
  page.getByRole('region', { name: '참여자 A 검증 커버리지 상태도', exact: true });
const evidence = (page: Page) =>
  page.getByRole('region', { name: '선택 항목의 실행 사례', exact: true });

test('a real suite shows actor coverage, unobserved rules and first-commit replay with verified explanations', async ({
  page,
}) => {
  await load(page, createSuiteDraft());
  await page.getByRole('button', { name: '전체 사례 검증 시작', exact: true }).click();
  await expect(page.getByText('회귀 검증을 완료했습니다.', { exact: true })).toBeVisible();
  await open(page);
  await expect(
    page.getByRole('region', { name: '참여자 A 커버리지 요약', exact: true }),
  ).toContainText('상태 관찰 3/4 (75%)');
  await expect(
    page.getByRole('region', { name: '참여자 A 커버리지 요약', exact: true }),
  ).toContainText('규칙 관찰 4/10 (40%)');
  await expect(
    page.getByRole('region', { name: '참여자 B 커버리지 요약', exact: true }),
  ).toContainText('규칙 관찰 2/10 (20%)');
  await page.getByLabel('미관찰 항목만 보기', { exact: true }).check();
  await expect(page.locator('[data-coverage-item]')).toHaveCount(6);
  await page.locator('[data-coverage-item="exhausted"]').click();
  await expect(evidence(page)).toContainText('관찰 0회 · 사례 0개');
  await expect(evidence(page)).toContainText('오류나 도달 불가능을 뜻하지 않습니다');
  await page.getByLabel('미관찰 항목만 보기', { exact: true }).uncheck();
  await page.locator('[data-coverage-item="retry"]').click();
  await expect(evidence(page)).toContainText('관찰 1회 · 사례 1개');
  await evidence(page)
    .getByRole('button', { name: '커버리지 사례 재생 · ACK 손실 · 2', exact: true })
    .click();
  await expect(page.getByRole('region', { name: '참여자 A 상태', exact: true })).toContainText(
    'Waiting',
  );
  await expect(page.getByRole('region', { name: '참여자 A 상태', exact: true })).toContainText(
    '"retries": 1',
  );
  await page.locator('summary').filter({ hasText: '실행 이유 설명' }).click();
  await expect(page.getByRole('region', { name: '선택 실행의 설명', exact: true })).toHaveAttribute(
    'data-explanation-status',
    'verified',
  );
  await expect(page.getByRole('region', { name: '선택 실행의 설명', exact: true })).toContainText(
    'retry',
  );
  await page.locator('summary').filter({ hasText: '통신 시퀀스 보기' }).click();
  await expect(page.locator('.sequence-row[aria-pressed="true"]')).toHaveCount(1);
});

test('initial-state evidence opens cursor zero without exposing future diagram observations', async ({
  page,
}) => {
  const draft = createSuiteDraft();
  await load(page, draft, runCoverageSuite(draft));
  await open(page);
  await page.getByRole('combobox', { name: '커버리지 참여자', exact: true }).selectOption('B');
  await page
    .getByRole('combobox', { name: '커버리지 항목 종류', exact: true })
    .selectOption('state');
  await page.locator('[data-coverage-item="Ready"]').click();
  await expect(evidence(page)).toContainText('관찰 8회 · 사례 3개');
  await expect(evidence(page)).toContainText('초기 상태');
  await evidence(page)
    .getByRole('button', { name: '커버리지 사례 재생 · 정상 전송 · 1', exact: true })
    .click();
  await expect(page.getByRole('region', { name: '참여자 A 상태', exact: true })).toContainText(
    'Ready',
  );
  await expect(page.getByRole('region', { name: '참여자 B 상태', exact: true })).toContainText(
    'Ready',
  );
  await expect(page.locator('[data-event-id][aria-pressed="true"]')).toHaveCount(0);
  await page.locator('summary').filter({ hasText: '통신 시퀀스 보기' }).click();
  await expect(page.locator('[data-sequence-id]')).toHaveCount(0);
});

test('group switching and native reload preserve frozen definitions instead of using the edited draft', async ({
  page,
}) => {
  const old = createSuiteDraft();
  const before = runCoverageSuite(old);
  const current: DraftRecord = {
    ...old,
    version: 2,
    configuration: {
      ...old.configuration,
      definitions: old.configuration.definitions.map((item) => ({
        ...item,
        revision: 2,
        states: [...item.states, { id: 'NewState', label: '현재만 있는 상태' }],
      })),
      protocols: {
        A: { ...old.configuration.protocols.A, revision: 2 },
        B: { ...old.configuration.protocols.B, revision: 2 },
      },
    },
  };
  const after = runCoverageSuite(current);
  await load(page, current, [...before, ...after]);
  await open(page);
  await expect(
    page.getByRole('region', { name: '참여자 A 커버리지 요약', exact: true }),
  ).toContainText('3/5');
  await page
    .getByRole('combobox', { name: '비교할 검증 실행', exact: true })
    .selectOption(before[0]?.regression?.id ?? '');
  await expect(
    page.getByRole('region', { name: '참여자 A 커버리지 요약', exact: true }),
  ).toContainText('3/4');
  await expect(graph(page)).toContainText('v1 · 관찰 합계');
  await expect(graph(page)).not.toContainText('NewState');
  await page.getByRole('button', { name: '지금 저장', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '로컬 저장과 파일' }).getByRole('status'),
  ).toHaveText('브라우저에 저장됨');
  await page.reload();
  await tab(page, '시나리오 묶음');
  await page
    .getByRole('combobox', { name: '비교할 검증 실행', exact: true })
    .selectOption(before[0]?.regression?.id ?? '');
  await open(page);
  await expect(
    page.getByRole('region', { name: '참여자 A 커버리지 요약', exact: true }),
  ).toContainText('3/4');
});

test('partial runs and missing slots remain visible and never claim completed suite coverage', async ({
  page,
}) => {
  const draft = createCoverageDraft(createEventLimitExperiment(), 3);
  const plan = prepareRegression(draft, 100);
  if (!plan.success) throw new Error('Invalid fixture');
  const session = createRegressionSession(plan.value);
  session.advance();
  const record = session.cancel();
  if (!record) throw new Error('Missing partial run');
  await load(page, draft, [record]);
  await open(page);
  const result = page.getByRole('region', { name: '검증 커버리지 결과', exact: true });
  await expect(result).toContainText(
    '집계 사례 1/3개 · 관찰 완료 0개 · 부분 관찰 1개 · 미실행·삭제 2개',
  );
  await result.locator('summary').filter({ hasText: '집계 범위와 제외 사유' }).click();
  await expect(result).toContainText('부분 관찰 · cancelled');
  await page.locator('[data-coverage-item="repeat"]').click();
  await expect(evidence(page).getByRole('button')).toHaveCount(1);
});

test('mixed parallel edges, off-page selection, keyboard controls and 390px coverage remain usable', async ({
  page,
}, info) => {
  const draft = createPagedCoverageDraft();
  await load(page, draft, runCoverageSuite(draft));
  await open(page);
  await expect(graph(page).locator('[data-coverage="partial"]')).toHaveCount(1);
  await expect(
    graph(page).getByRole('button', { name: /상태도 규칙 start, parallel_unobserved/ }),
  ).toContainText('관찰 1/2');
  await graph(page)
    .getByRole('combobox', { name: '참여자 A 검증 커버리지 상태도 규칙 선택', exact: true })
    .selectOption('5');
  await expect(evidence(page)).toContainText('parallel_unobserved · 관찰 0회');
  await expect(page.locator('[data-coverage-item]')).toHaveCount(20);
  await page.getByRole('button', { name: '커버리지 다음', exact: true }).click();
  await page.locator('[data-coverage-item="unused_24"]').click();
  await expect(
    graph(page).getByRole('combobox', {
      name: '참여자 A 검증 커버리지 상태도 규칙 선택',
      exact: true,
    }),
  ).toHaveValue('30');
  await expect(evidence(page)).toContainText('unused_24 · 관찰 0회');
  await page
    .getByRole('combobox', { name: '커버리지 항목 종류', exact: true })
    .selectOption('state');
  await page.getByRole('button', { name: '커버리지 다음', exact: true }).click();
  await page.getByRole('button', { name: '커버리지 다음', exact: true }).click();
  const state = page.locator('[data-coverage-item="extra_44"]');
  await state.focus();
  await page.keyboard.press('Enter');
  await expect(evidence(page)).toContainText('extra_44 · 관찰 0회');
  await expect(graph(page).getByRole('button', { name: /상태 extra_44/ })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await graph(page).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath('coverage-mobile.png'), fullPage: false });
});

test('unknown engine versions refuse aggregation while the original saved cases remain replayable', async ({
  page,
}) => {
  const draft = createSuiteDraft();
  const records = runCoverageSuite(draft).map((record) => ({
    ...record,
    view: { ...record.view, snapshot: { ...record.view.snapshot, engineVersion: 'future-engine' } },
  }));
  await load(page, draft, records);
  await page.locator('.suite-coverage summary').click();
  const result = page.getByRole('region', { name: '검증 커버리지 결과', exact: true });
  await expect(result).toHaveAttribute('data-coverage-status', 'unavailable');
  await expect(result).toContainText('지원하지 않는 엔진/난수 버전');
  await expect(
    page.getByRole('region', { name: '참여자 A 커버리지 요약', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '비교 사례 재생 · 정상 전송', exact: true }).click();
  await expect(page.getByRole('region', { name: '참여자 A 상태', exact: true })).toContainText(
    'Done',
  );
});

test('zero-rule definitions show an explicit non-applicable ratio with initial states still selectable', async ({
  page,
}) => {
  const config = createPingPongExperiment();
  const draft = createCoverageDraft({
    ...config,
    definitions: config.definitions.map((item) => ({ ...item, rules: [] })),
    scenario: {
      ...config.scenario,
      inputs: [],
      expectations: [{ id: 'idle', kind: 'state', participant: 'A', stateId: 'Idle' }],
    },
  });
  await load(page, draft, runCoverageSuite(draft));
  await open(page);
  await expect(
    page.getByRole('region', { name: '참여자 A 커버리지 요약', exact: true }),
  ).toContainText('규칙 관찰 0/0 (해당 없음)');
  await expect(evidence(page)).toContainText('상태 Idle · 관찰 1회 · 사례 1개');
});
