import { expect, type Page, test } from '@playwright/test';
import { createSimulation } from '../../src/application/create-simulation.ts';
import { editExperiment } from '../../src/application/edit-experiment.ts';
import { captureRun, createWorkspace } from '../../src/application/workspace-operations.ts';
import type { ExperimentDefinition } from '../../src/domain/protocol-model.ts';
import { createExampleCopy, getExampleOriginal } from '../../src/examples/catalog.ts';
import { createExplanationExperiment } from '../fixtures/explanation-experiment.ts';

const explanation = (page: Page) =>
  page.getByRole('region', { name: '선택 실행의 설명', exact: true });
async function tab(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: '작업 공간' })
    .getByRole('button', { name, exact: true })
    .click();
}
function core(config: ExperimentDefinition) {
  const created = createSimulation(config);
  if (!created.success) throw new Error('Invalid fixture');
  return created.value.run();
}
async function load(page: Page, config: ExperimentDefinition) {
  await page.goto('/');
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'explanation.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'protocol-studio-bundle',
        data: createWorkspace(config),
      }),
    ),
  });
  await expect(page.getByText(/검증한 bundle을 적용/)).toBeVisible();
  await page.getByRole('button', { name: /^(현재 초안 |새 설정으로 )?전체 실행$/ }).click();
  await expect(page.getByText(/관찰 완료 · 가상 시간/)).toBeVisible();
}
async function open(page: Page) {
  await page.locator('summary').filter({ hasText: '실행 이유 설명' }).click();
}

test('explains actual field guards and before-value assignments from trace and state selections', async ({
  page,
}) => {
  await page.goto('/');
  const view = core(getExampleOriginal('ping_pong'));
  const start = view.events.find(
    (event) => event.kind === 'transition' && event.ruleId === 'start',
  );
  const complete = view.events.find(
    (event) => event.kind === 'transition' && event.ruleId === 'complete',
  );
  if (!start || !complete) throw new Error('Missing transitions');
  await page.getByRole('button', { name: '전체 실행', exact: true }).click();
  await expect(page.getByText(/관찰 완료 · 가상 시간/)).toBeVisible();
  await page.locator(`[data-event-id="${start.eventId}"]`).click();
  await open(page);
  await expect(explanation(page)).toHaveAttribute('data-explanation-status', 'verified');
  await expect(explanation(page).locator('[data-explained-assignment="0"]')).toContainText(
    '변수 counter(0)',
  );
  await expect(explanation(page).locator('[data-explained-variable="counter"]')).toContainText(
    '전이 후: 1',
  );
  await page.locator('summary').filter({ hasText: '실행 상태도 보기' }).click();
  await page
    .getByRole('combobox', { name: '참여자 A 실행 상태도 규칙 선택', exact: true })
    .selectOption('2');
  await expect(explanation(page)).toContainText(`규칙 complete · ${complete.eventId}`);
  await expect(explanation(page).getByRole('region', { name: '후보 조건 계산' })).toContainText(
    '필드 sequence(1) = 변수 counter(1)',
  );
  await expect(explanation(page)).toContainText('이 규칙에는 변수 대입이 없습니다.');
});

test('history never explains an unobserved commit and draft edits do not rewrite saved reasons', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const config = getExampleOriginal('ping_pong');
  const view = core(config);
  const transition = view.events.find(
    (event) => event.kind === 'transition' && event.ruleId === 'start',
  );
  const send = view.events.find((event) => event.kind === 'send');
  if (!transition || !send) throw new Error('Missing trace');
  await load(page, config);
  await page.getByRole('button', { name: '지금 저장', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '로컬 저장과 파일' }).getByRole('status'),
  ).toHaveText('브라우저에 저장됨');
  await page.reload();
  await tab(page, '실행');
  await page.getByRole('combobox', { name: '과거 실행 선택' }).selectOption({ index: 1 });
  await page.locator(`[data-event-id="${send.eventId}"]`).click();
  await open(page);
  await expect(explanation(page)).toHaveCount(0);
  await expect(page.getByText(/전이 기록이 없는 송신·오류에서는/)).toBeVisible();
  await page.locator(`[data-event-id="${transition.eventId}"]`).click();
  await expect(explanation(page)).toHaveAttribute('data-explanation-status', 'verified');
  await tab(page, '프로토콜');
  await page.locator('[data-path="/definitions/0/variables/0/initial"]').fill('100');
  await tab(page, '실행');
  await open(page);
  await expect(explanation(page).locator('[data-explained-assignment="0"]')).toContainText(
    '변수 counter(0)',
  );
  await expect(explanation(page)).toHaveAttribute('data-explanation-status', 'verified');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await explanation(page).screenshot({ path: test.info().outputPath('execution-reason-390.png') });
});

test('nested short-circuit and sequential writes have readable formulas with keyboard expansion', async ({
  page,
}) => {
  const config = createExplanationExperiment();
  const transition = core(config).events.find((event) => event.kind === 'transition');
  if (!transition) throw new Error('Missing transition');
  await load(page, config);
  await page.locator(`[data-event-id="${transition.eventId}"]`).click();
  const summary = page.locator('summary').filter({ hasText: '실행 이유 설명' });
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(explanation(page)).toHaveAttribute('data-explanation-status', 'verified');
  await expect(explanation(page)).toContainText('평가 생략');
  await expect(explanation(page)).toContainText('앞 조건이 참');
  await expect(explanation(page).locator('[data-explained-assignment="1"]')).toContainText(
    '대입 전 값: 1',
  );
  await expect(explanation(page).locator('[data-explained-assignment="2"]')).toContainText(
    '변수 count(3)',
  );
  await expect(explanation(page).locator('[data-explained-variable="count"]')).toContainText(
    '관련 대입 동작: 1, 2',
  );
  await explanation(page).screenshot({
    path: test.info().outputPath('execution-reason-desktop.png'),
  });
});

test('repeated experiment replay explains retry and rejected exhausted guards for each occurrence', async ({
  page,
}) => {
  const config = editExperiment(
    createExampleCopy('stop_wait'),
    '/environment/directions/AtoB/lossRate',
    1,
  );
  const retries = core(config).events.filter(
    (event) => event.kind === 'transition' && event.ruleId === 'retry',
  );
  if (!retries[0] || !retries[2]) throw new Error('Missing retries');
  await page.goto('/');
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'repeat.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'protocol-studio-bundle',
        data: createWorkspace(config),
      }),
    ),
  });
  await expect(page.getByText(/검증한 bundle을 적용/)).toBeVisible();
  await tab(page, '반복 실험');
  await page.getByLabel('seed 목록', { exact: true }).fill('1');
  await page.getByRole('button', { name: '반복 실행 시작', exact: true }).click();
  await expect(page.getByText('반복 실행을 완료했습니다.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /조건 1 실행 목록/ }).click();
  await page.getByRole('button', { name: 'seed 1 기록 재생', exact: true }).click();
  await page.locator(`[data-event-id="${retries[0].eventId}"]`).click();
  await open(page);
  await expect(explanation(page)).toHaveAttribute('data-explanation-status', 'verified');
  await expect(
    explanation(page).getByRole('button', { name: '후보 exhausted · 거짓', exact: true }),
  ).toBeVisible();
  await explanation(page)
    .getByRole('button', { name: '후보 exhausted · 거짓', exact: true })
    .click();
  await expect(explanation(page).getByRole('region', { name: '후보 조건 계산' })).toContainText(
    '변수 retries(0) ≥ 변수 maxRetries(3)',
  );
  await page.locator(`[data-event-id="${retries[2].eventId}"]`).click();
  await expect(explanation(page).locator('[data-explained-assignment="0"]')).toContainText(
    '대입 전 값: 2',
  );
});

test('coalesced reads require one observed receiver occurrence before showing reasons', async ({
  page,
}) => {
  const base = getExampleOriginal('ping_pong');
  const actions = base.definitions[0]?.rules[0]?.actions;
  if (!actions?.[1]) throw new Error('Missing send');
  let config = editExperiment(base, '/definitions/0/rules/0/actions', [
    ...actions.slice(0, 2),
    actions[1],
    ...actions.slice(2),
  ]);
  config = editExperiment(config, '/environment/directions/AtoB/chunkBytes', 65536);
  const read = core(config).events.find(
    (event) => event.kind === 'receive' && event.participant === 'B',
  );
  if (!read) throw new Error('Missing coalesced read');
  await load(page, config);
  await page.locator(`[data-event-id="${read.eventId}"]`).click();
  await open(page);
  await expect(explanation(page)).toHaveCount(0);
  const choices = page
    .getByRole('region', { name: '설명할 실행 회차', exact: true })
    .getByRole('button');
  await expect(choices).toHaveCount(2);
  await choices.last().click();
  await expect(explanation(page)).toHaveAttribute('data-explanation-status', 'verified');
  await expect(explanation(page)).toContainText('B · 규칙 reply');
});

test('oversized values and unsupported snapshots show explicit limits without modifying old records', async ({
  page,
}) => {
  const base = createExplanationExperiment();
  const protocol = base.definitions[0];
  if (!protocol) throw new Error('Missing fixture');
  const config: ExperimentDefinition = {
    ...base,
    definitions: [
      {
        ...protocol,
        variables: [
          ...protocol.variables,
          { id: 'large', type: 'json', initial: 'a'.repeat(40_000) },
        ],
      },
    ],
  };
  await load(page, config);
  const transition = core(config).events.find((event) => event.kind === 'transition');
  if (!transition) throw new Error('Missing transition');
  await page.locator(`[data-event-id="${transition.eventId}"]`).click();
  await open(page);
  await expect(explanation(page)).toHaveAttribute('data-explanation-status', 'limited');
  expect(await explanation(page).evaluate((node) => node.textContent?.length ?? 0)).toBeLessThan(
    32_768,
  );
  const view = core(base);
  const data = createWorkspace(base);
  const record = captureRun(
    { ...view, snapshot: { ...view.snapshot, engineVersion: 'future-engine' } },
    data.activeDraftId,
    1,
  );
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'future.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'protocol-studio-bundle',
        data: { ...data, runs: [record] },
      }),
    ),
  });
  await expect(page.getByText(/검증한 bundle을 적용/)).toBeVisible();
  await tab(page, '실행');
  await page.getByRole('combobox', { name: '과거 실행 선택' }).selectOption(record.id);
  const commit = view.events.find((event) => event.kind === 'transition');
  if (!commit) throw new Error('Missing old commit');
  await page.locator(`[data-event-id="${commit.eventId}"]`).click();
  await open(page);
  await expect(explanation(page)).toHaveAttribute('data-explanation-status', 'unavailable');
});

test('long assignment programs keep twenty rows per page and preserve their original action numbers', async ({
  page,
}) => {
  let config = createExplanationExperiment();
  const first = config.definitions[0]?.rules[0]?.actions[0];
  if (!first) throw new Error('Missing assignment');
  config = editExperiment(config, '/definitions/0/rules/0/actions', [
    ...Array.from({ length: 25 }, () => first),
    { kind: 'finish', outcome: 'success' },
  ]);
  const transition = core(config).events.find((event) => event.kind === 'transition');
  if (!transition) throw new Error('Missing commit');
  await load(page, config);
  await page.locator(`[data-event-id="${transition.eventId}"]`).click();
  await open(page);
  await expect(explanation(page)).toHaveAttribute('data-explanation-status', 'verified');
  await expect(explanation(page).locator('[data-explained-assignment]')).toHaveCount(20);
  await explanation(page).getByRole('button', { name: '대입 계산 다음', exact: true }).click();
  await expect(explanation(page).locator('[data-explained-assignment]')).toHaveCount(5);
  await expect(explanation(page).locator('[data-explained-assignment="24"]')).toContainText(
    '대입 계산 결과: 25',
  );
});
