import { expect, type Page, test } from '@playwright/test';
import { createSimulation } from '../../src/application/create-simulation.ts';
import { editExperiment } from '../../src/application/edit-experiment.ts';
import { captureRun, createWorkspace } from '../../src/application/workspace-operations.ts';
import type { ExperimentDefinition } from '../../src/domain/protocol-model.ts';
import type { WorkspaceData } from '../../src/domain/workspace-model.ts';
import { createExampleCopy } from '../../src/examples/catalog.ts';

const stop = (page: Page) => page.getByRole('region', { name: '중단점 정지 근거', exact: true });
function core(config: ExperimentDefinition) {
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
async function load(page: Page, data = createWorkspace(createExampleCopy('ping_pong'))) {
  await page.goto('/');
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'breakpoints.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'protocol-studio-bundle', data })),
  });
  await expect(page.getByText(/검증한 bundle을 적용/)).toBeVisible();
  await tab(page, '실행');
}
async function open(page: Page) {
  const details = page.locator('.breakpoints-panel');
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
}
async function add(page: Page, kind: string, target: string, participant = 'A') {
  await open(page);
  await page.getByRole('button', { name: '중단점 추가', exact: true }).click();
  await page
    .getByRole('combobox', { name: '중단점 참여자', exact: true })
    .selectOption(participant);
  await page.getByRole('combobox', { name: '정지 조건 종류', exact: true }).selectOption(kind);
  await page.getByRole('combobox', { name: '중단점 대상', exact: true }).selectOption(target);
}
async function start(page: Page) {
  await page.getByRole('button', { name: /^(현재 초안 |새 설정으로 )?전체 실행$/ }).click();
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
async function stored(page: Page) {
  return page.evaluate(
    async () =>
      new Promise<WorkspaceData>((resolve, reject) => {
        const opened = indexedDB.open('protocol-studio', 2);
        opened.onerror = () => reject(opened.error);
        opened.onsuccess = () => {
          const db = opened.result;
          const tx = db.transaction('workspace-v2', 'readonly');
          const request = tx.objectStore('workspace-v2').get('current');
          tx.oncomplete = () => {
            db.close();
            resolve(request.result.data.legacy);
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
  );
}

test('a state entry pauses at the committed boundary, explains the rule and resumes to the same final trace', async ({
  page,
}) => {
  const config = createExampleCopy('ping_pong');
  await load(page, createWorkspace(config));
  await add(page, 'state', 'Waiting');
  await start(page);
  await expect(stop(page)).toHaveAttribute('data-breakpoint-kind', 'match');
  await expect(stop(page)).toContainText('상태 Idle → Waiting 진입');
  await expect(page.getByText(/일시 정지 · 가상 시간/)).toBeVisible();
  await expect(page.getByRole('region', { name: '참여자 A 상태', exact: true })).toContainText(
    'counter',
  );
  await stop(page).getByRole('button', { name: '정지 실행 설명 보기', exact: true }).click();
  await expect(page.getByRole('region', { name: '선택 실행의 설명', exact: true })).toHaveAttribute(
    'data-explanation-status',
    'verified',
  );
  await page.getByRole('button', { name: '이 실행 계속', exact: true }).click();
  await expect(page.getByText(/관찰 완료 · 가상 시간/)).toBeVisible();
  await save(page);
  const records = (await stored(page)).runs;
  expect(records).toHaveLength(1);
  const actual = records[0]?.view;
  if (!actual) throw new Error('Missing record');
  const comparable = (view: typeof actual) =>
    view.events.map(({ runId: _runId, ...event }) => event);
  expect(comparable(actual)).toEqual(comparable(core(config)));
  expect(actual.expectations.every((item) => item.status === 'pass')).toBe(true);
});

test('retry conditions stop inside a batch and continuing a true condition advances to the next transition', async ({
  page,
}) => {
  const config = editExperiment(
    createExampleCopy('stop_wait'),
    '/environment/directions/AtoB/lossRate',
    1,
  );
  await load(page, createWorkspace(config));
  await add(page, 'variable', 'retries');
  await page.getByRole('combobox', { name: '변수 비교 연산자', exact: true }).selectOption('gte');
  await page.getByRole('textbox', { name: '변수 비교 값 (JSON)', exact: true }).fill('2');
  await start(page);
  await expect(stop(page)).toContainText('retries = 2');
  const first = await stop(page).textContent();
  await page.getByRole('button', { name: '이 실행 계속', exact: true }).click();
  await expect(stop(page)).toContainText('retries = 3');
  expect(await stop(page).textContent()).not.toBe(first);
  await page.getByRole('checkbox', { name: '중단점 사용', exact: true }).uncheck();
  await page.getByRole('button', { name: '이 실행 계속', exact: true }).click();
  await expect(page.getByText(/관찰 완료 · 가상 시간/)).toBeVisible();
  await expect(page.getByRole('region', { name: '참여자 A 상태', exact: true })).toContainText(
    'Failed',
  );
});

test('message reception stops after decoding with explicit coalesced-read boundary information', async ({
  page,
}) => {
  const base = createExampleCopy('ping_pong');
  const actions = base.definitions[0]?.rules[0]?.actions;
  if (!actions?.[1]) throw new Error('Missing fixture');
  let config = editExperiment(base, '/definitions/0/rules/0/actions', [
    ...actions.slice(0, 2),
    actions[1],
    ...actions.slice(2),
  ]);
  config = editExperiment(config, '/environment/directions/AtoB/chunkBytes', 65536);
  await load(page, createWorkspace(config));
  await add(page, 'message', 'ping', 'B');
  await start(page);
  await expect(stop(page)).toContainText('수신 해석 완료');
  const text = await stop(page).textContent();
  expect(Number(/기록 (\d+)개/.exec(text ?? '')?.[1])).toBeGreaterThan(2);
  await stop(page).getByRole('button', { name: '정지 기록 보기', exact: true }).click();
  await expect(page.locator('[data-sequence-id][aria-pressed="true"]')).toHaveCount(1);
  await stop(page).getByRole('button', { name: '정지 실행 설명 보기', exact: true }).click();
  await expect(page.getByRole('region', { name: '선택 실행의 설명', exact: true })).toContainText(
    'B · 규칙 reply',
  );
});

test('history breakpoints obey the cursor and old variable values without changing the saved run', async ({
  page,
}) => {
  const config = createExampleCopy('ping_pong');
  const data = createWorkspace(editExperiment(config, '/definitions/0/variables/0/initial', 100));
  const record = captureRun(core(config), data.activeDraftId, 1);
  await load(page, { ...data, runs: [record] });
  await page.getByRole('combobox', { name: '과거 실행 선택' }).selectOption(record.id);
  await add(page, 'variable', 'counter');
  await page.getByRole('textbox', { name: '변수 비교 값 (JSON)', exact: true }).fill('1');
  await page.getByRole('button', { name: '기록 처음', exact: true }).click();
  await expect(stop(page)).toHaveCount(0);
  await page.getByRole('button', { name: '기록 자동 재생', exact: true }).click();
  await expect(stop(page)).toContainText('counter = 1');
  await expect(page.getByRole('region', { name: '참여자 A 상태', exact: true })).toContainText(
    'Waiting',
  );
  const first = await stop(page).textContent();
  await page.getByRole('button', { name: '이 기록 계속 재생', exact: true }).click();
  await expect(page.getByRole('region', { name: '참여자 A 상태', exact: true })).toContainText(
    'Done',
  );
  await expect(stop(page)).toBeVisible();
  expect(await stop(page).textContent()).not.toBe(first);
  await page.getByRole('checkbox', { name: '중단점 사용', exact: true }).uncheck();
  await page.getByRole('button', { name: '이 기록 계속 재생', exact: true }).click();
  await expect(page.getByText(/과거 기록 · 저장 시점/)).toBeVisible();
  await save(page);
  expect((await stored(page)).runs).toEqual([record]);
});

test('invalid active literals block automatic work, disabled drafts remain usable and settings reset on reload', async ({
  page,
}) => {
  await load(page);
  await add(page, 'variable', 'counter');
  await page.getByRole('textbox', { name: '변수 비교 값 (JSON)', exact: true }).fill('{');
  await expect(page.getByRole('alert', { name: '중단점 설정 진단' })).toBeVisible();
  await start(page);
  await expect(page.locator('[data-event-id]')).toHaveCount(0);
  await page.getByRole('checkbox', { name: '선택 중단점 활성화', exact: true }).uncheck();
  await start(page);
  await expect(page.getByText(/관찰 완료 · 가상 시간/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: '변수 비교 값 (JSON)', exact: true })).toHaveValue(
    '{',
  );
  await save(page);
  const before = await stored(page);
  expect(before.drafts[0]?.version).toBe(1);
  await page.reload();
  await tab(page, '실행');
  await open(page);
  await expect(page.getByRole('combobox', { name: '편집할 중단점', exact: true })).toHaveCount(0);
  expect((await stored(page)).runs.length).toBe(before.runs.length);
});

test('runtime evaluation limits pause the debugger without adding an engine error or a failed verdict', async ({
  page,
}) => {
  const config = editExperiment(
    createExampleCopy('ping_pong'),
    '/definitions/0/variables/1/initial',
    'a'.repeat(9000),
  );
  await load(page, createWorkspace(config));
  await add(page, 'variable', 'pending');
  await page.getByRole('textbox', { name: '변수 비교 값 (JSON)', exact: true }).fill('null');
  await start(page);
  await expect(stop(page)).toHaveAttribute('data-breakpoint-kind', 'evaluation-error');
  await expect(page.getByText(/일시 정지 · 가상 시간/)).toBeVisible();
  await page.getByRole('checkbox', { name: '중단점 사용', exact: true }).uncheck();
  await page.getByRole('button', { name: '이 실행 계속', exact: true }).click();
  await expect(page.getByText(/관찰 완료 · 가상 시간/)).toBeVisible();
  await save(page);
  const record = (await stored(page)).runs[0];
  expect(record?.view.diagnostics).toEqual([]);
  expect(record?.view.expectations.every((item) => item.status === 'pass')).toBe(true);
});

test('the current frozen run continues after draft edits and reset fences the next generation', async ({
  page,
}) => {
  await load(page);
  await add(page, 'state', 'Waiting');
  await start(page);
  await expect(stop(page)).toBeVisible();
  await tab(page, '프로토콜');
  await page.locator('[data-path="/definitions/0/variables/0/initial"]').fill('100');
  await tab(page, '실행');
  await open(page);
  await page.getByRole('button', { name: '이 실행 계속', exact: true }).click();
  await expect(page.getByText(/관찰 완료 · 가상 시간/)).toBeVisible();
  await start(page);
  await expect(stop(page)).toBeVisible();
  await expect(page.getByRole('region', { name: '참여자 A 상태', exact: true })).toContainText(
    '101',
  );
  await page.getByRole('button', { name: '실행 초기화', exact: true }).click();
  await expect(stop(page)).toHaveCount(0);
  await start(page);
  await expect(stop(page)).toBeVisible();
  await page.waitForTimeout(180);
  await expect(page.getByText(/일시 정지 · 가상 시간/)).toBeVisible();
  await expect(page.getByRole('region', { name: '참여자 A 상태', exact: true })).toContainText(
    'Waiting',
  );
});

test('keyboard stop inspection, duplication limits and narrow controls fit a 390px viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await load(page);
  await open(page);
  await page.getByRole('button', { name: '중단점 추가', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('combobox', { name: '중단점 대상', exact: true }).selectOption('Waiting');
  await start(page);
  await expect(stop(page)).toHaveAttribute('data-breakpoint-kind', 'match');
  await expect(page.locator('.breakpoints-panel summary')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page
    .locator('.breakpoints-panel')
    .screenshot({ path: test.info().outputPath('breakpoint-390.png') });
  await page.getByRole('button', { name: '이 실행 계속', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/관찰 완료 · 가상 시간/)).toBeVisible();
  for (let index = 1; index < 20; index++)
    await page.getByRole('button', { name: '중단점 복제', exact: true }).click();
  await expect(
    page.getByRole('combobox', { name: '편집할 중단점', exact: true }).locator('option'),
  ).toHaveCount(20);
  await expect(page.getByRole('button', { name: '중단점 추가', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '선택 중단점 삭제', exact: true }).click();
  await expect(page.getByRole('button', { name: '중단점 추가', exact: true })).toBeEnabled();
});
