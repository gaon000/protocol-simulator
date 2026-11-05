import { expect, type Page, test } from '@playwright/test';
import { createSimulation } from '../../src/application/create-simulation.ts';
import { editExperiment } from '../../src/application/edit-experiment.ts';
import { createScenarioSuite } from '../../src/application/scenario-suites.ts';
import { captureRun, createWorkspace } from '../../src/application/workspace-operations.ts';
import type { ExperimentDefinition } from '../../src/domain/protocol-model.ts';
import type { WorkspaceData } from '../../src/domain/workspace-model.ts';
import { createExampleCopy } from '../../src/examples/catalog.ts';

const diagnosis = (page: Page) =>
  page.getByRole('region', { name: '선택 기대 조건 진단', exact: true });
const evidence = (page: Page) =>
  diagnosis(page).getByRole('region', { name: '판정 근거', exact: true });
function run(config: ExperimentDefinition) {
  const created = createSimulation(config);
  if (!created.success) throw new Error('Invalid fixture');
  return created.value.run();
}
async function tab(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: '작업 공간' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function load(page: Page, data: WorkspaceData) {
  await page.goto('/');
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'diagnostics.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'protocol-studio-bundle', data })),
  });
  await expect(page.getByText(/검증한 bundle을 적용/)).toBeVisible();
}
async function start(page: Page, config: ExperimentDefinition) {
  await load(page, createWorkspace(config));
  await page.getByRole('button', { name: /^(현재 초안 |새 설정으로 )?전체 실행$/ }).click();
  await expect(page.getByText(/관찰 완료 · 가상 시간/)).toBeVisible();
}
const timeoutConfig = () =>
  editExperiment(createExampleCopy('ping_pong'), '/environment/directions/AtoB/delayMs', 2000);

test('failed state opens expected/actual values, timer ancestry, sequence and the observed rule explanation', async ({
  page,
}) => {
  const config = timeoutConfig();
  const commit = run(config).events.find(
    (event) => event.ruleId === 'expire' && event.kind === 'transition',
  );
  if (!commit) throw new Error('Missing timeout');
  await start(page, config);
  await page.getByRole('button', { name: '기대 조건 진단 finished', exact: true }).click();
  await expect(diagnosis(page)).toHaveAttribute('data-diagnosis-status', 'verified');
  await expect(diagnosis(page)).toContainText('기대값상태 Done');
  await expect(diagnosis(page)).toContainText('현재 상태 Failed');
  await evidence(page)
    .getByRole('button', { name: `연결 근거 ${commit.eventId}`, exact: true })
    .click();
  await expect(page.getByRole('region', { name: '선택 근거의 연결 기록' })).toContainText(
    '같은 타이머 세대',
  );
  await evidence(page)
    .getByRole('button', { name: `기록 보기 ${commit.eventId}`, exact: true })
    .click();
  await expect(page.locator(`[data-sequence-id="${commit.eventId}"]`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await evidence(page)
    .getByRole('button', { name: `실행 설명 보기 ${commit.eventId}`, exact: true })
    .click();
  await expect(page.getByRole('region', { name: '선택 실행의 설명', exact: true })).toHaveAttribute(
    'data-explanation-status',
    'verified',
  );
  await expect(page.getByRole('region', { name: '선택 실행의 설명', exact: true })).toContainText(
    '규칙 expire',
  );
  await expect(page.getByRole('region', { name: '참여자 A 상태', exact: true })).toContainText(
    'Failed',
  );
});

test('delivery counts, normalized message values and completion deadlines show concrete mismatches', async ({
  page,
}) => {
  const config = editExperiment(createExampleCopy('ping_pong'), '/scenario/expectations', [
    { id: 'count', kind: 'delivery-count', participant: 'A', messageId: 'pong', count: 2 },
    {
      id: 'content',
      kind: 'delivered-values',
      participant: 'A',
      message: { messageId: 'pong', values: { sequence: 2 } },
    },
    { id: 'deadline', kind: 'completion-before', participant: 'A', timeMs: 1 },
  ]);
  await start(page, config);
  await page.getByRole('button', { name: '기대 조건 진단 count', exact: true }).click();
  await expect(diagnosis(page)).toContainText('관찰한 상위 전달 1회');
  await expect(evidence(page).locator('[data-diagnosis-event]')).toHaveCount(1);
  await page
    .getByRole('combobox', { name: '진단할 기대 조건', exact: true })
    .selectOption('content');
  await expect(diagnosis(page)).toContainText('"sequence": 2');
  await expect(diagnosis(page)).toContainText('"sequence": 1');
  await expect(diagnosis(page)).toContainText('일치 0회');
  await expect(diagnosis(page)).toContainText('safe');
  await page
    .getByRole('combobox', { name: '진단할 기대 조건', exact: true })
    .selectOption('deadline');
  await expect(diagnosis(page)).toContainText('1 ms 이내 성공 완료');
  await expect(diagnosis(page)).toContainText('결과 success');
});

test('saved diagnoses obey the history cursor and retain the old expectation after draft edits and reload', async ({
  page,
}) => {
  const config = timeoutConfig();
  const data = createWorkspace(config);
  const record = captureRun(run(config), data.activeDraftId, 1);
  await load(page, { ...data, runs: [record] });
  await tab(page, '실행');
  await page.getByRole('combobox', { name: '과거 실행 선택' }).selectOption(record.id);
  await page.getByRole('button', { name: '기대 조건 진단 finished', exact: true }).click();
  await expect(diagnosis(page)).toHaveAttribute('data-diagnosis-status', 'verified');
  await evidence(page)
    .getByRole('button', { name: /^실행 설명 보기/ })
    .click();
  await expect(diagnosis(page)).toHaveAttribute('data-diagnosis-status', 'incomplete');
  await page.getByRole('button', { name: '기록 처음', exact: true }).click();
  await expect(diagnosis(page)).toContainText('현재 상태 Idle');
  await expect(diagnosis(page).locator('[data-diagnosis-event]')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '선택 근거의 연결 기록' })).toHaveCount(0);
  await page.getByRole('button', { name: '저장 시점', exact: true }).click();
  await expect(diagnosis(page)).toHaveAttribute('data-diagnosis-status', 'verified');
  await tab(page, '시나리오·검증');
  await page.locator('[data-path="/scenario/expectations/0/stateId"]').selectOption('Failed');
  await page.getByRole('button', { name: '지금 저장', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: '로컬 저장과 파일' })
      .getByRole('status')
      .filter({ hasText: /^브라우저에 저장됨$/ }),
  ).toBeVisible();
  await page.reload();
  await tab(page, '실행');
  await page.getByRole('combobox', { name: '과거 실행 선택' }).selectOption(record.id);
  await page.getByRole('button', { name: '기대 조건 진단 finished', exact: true }).click();
  await expect(diagnosis(page)).toContainText('상태 Done');
  await expect(diagnosis(page)).toHaveAttribute('data-diagnosis-status', 'verified');
});

test('unmatched events remain undetermined and unsupported snapshots cannot claim a verified cause', async ({
  page,
}) => {
  const config = editExperiment(
    createExampleCopy('ping_pong'),
    '/definitions/0/rules/0/condition',
    {
      kind: 'compare',
      operator: 'eq',
      left: { kind: 'literal', value: 0 },
      right: { kind: 'literal', value: 1 },
    },
  );
  await start(page, config);
  await page.getByRole('button', { name: '기대 조건 진단 finished', exact: true }).click();
  await expect(diagnosis(page)).toHaveAttribute('data-diagnosis-status', 'incomplete');
  await expect(diagnosis(page)).toContainText('finished · 미판정');
  await expect(diagnosis(page)).toContainText('unmatched-event');
  await expect(diagnosis(page).getByRole('button', { name: /^실행 설명 보기/ })).toHaveCount(0);
  const data = createWorkspace(config);
  const view = run(config);
  const record = captureRun(
    { ...view, snapshot: { ...view.snapshot, engineVersion: 'future' } },
    data.activeDraftId,
    1,
  );
  await load(page, { ...data, runs: [record] });
  await tab(page, '실행');
  await page.getByRole('combobox', { name: '과거 실행 선택' }).selectOption(record.id);
  await page.getByRole('button', { name: '기대 조건 진단 finished', exact: true }).click();
  await expect(diagnosis(page)).toHaveAttribute('data-diagnosis-status', 'unavailable');
});

test('regression case replay uses the captured case settings and contextual ACK loss', async ({
  page,
}) => {
  const data = createWorkspace(
    editExperiment(createExampleCopy('stop_wait'), '/environment/directions/BtoA/lossRate', 1),
  );
  const first = data.drafts[0];
  if (!first) throw new Error('Missing draft');
  const suite = createScenarioSuite(first);
  await load(page, { ...data, drafts: [{ ...first, suite }] });
  await tab(page, '시나리오 묶음');
  await page.getByRole('button', { name: '전체 사례 검증 시작', exact: true }).click();
  await expect(page.getByText('회귀 검증을 완료했습니다.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '비교 사례 재생 · 기본 사례', exact: true }).click();
  await page.getByRole('button', { name: '기대 조건 진단 sender_done', exact: true }).click();
  await expect(diagnosis(page)).toHaveAttribute('data-diagnosis-status', 'verified');
  await expect(diagnosis(page)).toContainText('현재 상태 Failed');
  await expect(
    diagnosis(page).getByRole('region', { name: '참고 관찰', exact: true }),
  ).toContainText('drop');
  await expect(page.getByText(/회귀 검증 ·/).first()).toBeVisible();
});

test('keyboard diagnostics and twenty-row evidence pages fit a 390px viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let config = createExampleCopy('ping_pong');
  const complete = config.definitions[0]?.rules[2];
  const deliver = complete?.actions.find((action) => action.kind === 'deliver');
  if (!complete || !deliver) throw new Error('Missing fixture');
  config = editExperiment(config, '/definitions/0/rules/2/actions', [
    ...Array.from({ length: 25 }, () => deliver),
    { kind: 'finish', outcome: 'success' },
  ]);
  await start(page, config);
  await page.getByRole('button', { name: '기대 조건 진단 once', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(diagnosis(page)).toHaveAttribute('data-diagnosis-status', 'verified');
  await expect(page.locator('summary').filter({ hasText: '실패 진단과 관련 기록' })).toBeFocused();
  await expect(diagnosis(page)).toContainText('관찰한 상위 전달 25회');
  await expect(evidence(page).locator('[data-diagnosis-event]')).toHaveCount(20);
  await evidence(page).getByRole('button', { name: '판정 근거 다음', exact: true }).click();
  await expect(evidence(page).locator('[data-diagnosis-event]')).toHaveCount(5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await diagnosis(page).screenshot({ path: test.info().outputPath('failure-diagnosis-390.png') });
});
