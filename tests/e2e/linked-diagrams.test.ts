import { expect, type Page, test } from '@playwright/test';
import { createSimulation } from '../../src/application/create-simulation.ts';
import { editExperiment } from '../../src/application/edit-experiment.ts';
import { createWorkspace } from '../../src/application/workspace-operations.ts';
import type { ExperimentDefinition } from '../../src/domain/protocol-model.ts';
import { getExampleOriginal } from '../../src/examples/catalog.ts';
import { createStopAndWaitExperiment } from '../../src/examples/stop-and-wait.ts';

const sequence = (page: Page) =>
  page.getByRole('region', { name: '통신 시퀀스 다이어그램', exact: true });
const graph = (page: Page, actor = 'A') =>
  page.getByRole('region', { name: `참여자 ${actor} 실행 상태도`, exact: true });
const occurrences = (page: Page) =>
  page.getByRole('region', { name: '연결된 실행 회차', exact: true });
function core(config: ExperimentDefinition) {
  const created = createSimulation(config);
  if (!created.success) throw new Error('Invalid fixture');
  return created.value.run();
}
async function load(page: Page, config: ExperimentDefinition) {
  await page.goto('/');
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'linked.json',
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
  await expect(page.getByText(/관찰 완료 · 가상 시간/)).toBeVisible({ timeout: 10_000 });
  await page.locator('summary').filter({ hasText: '통신 시퀀스 보기' }).click();
}
async function selectEvent(page: Page, id: string) {
  const first = sequence(page).getByRole('button', { name: '시퀀스 처음', exact: true });
  if (await first.isEnabled()) await first.click();
  const row = sequence(page).locator(`[data-sequence-id="${id}"]`);
  while (!(await row.count()))
    await sequence(page).getByRole('button', { name: '시퀀스 다음', exact: true }).click();
  await row.click();
}
test('sequence selection links exact before/after states while graph selection reveals the matching event and focus', async ({
  page,
}, info) => {
  const config = getExampleOriginal('ping_pong');
  const view = core(config);
  const sent = view.events.find((event) => event.kind === 'send' && event.participant === 'A');
  const completed = view.events.find(
    (event) => event.kind === 'transition' && event.ruleId === 'complete',
  );
  if (!sent || !completed) throw new Error('Missing trace');
  await load(page, config);
  await selectEvent(page, sent.eventId);
  await sequence(page).getByRole('button', { name: '연결된 상태도 보기', exact: true }).click();
  await expect(page.locator('summary').filter({ hasText: '실행 상태도 보기' })).toBeFocused();
  await expect(graph(page).locator('.diagram-edge.is-selected')).toHaveAccessibleName(/start/);
  await expect(graph(page).locator('.diagram-node.is-before')).toHaveAccessibleName(/^상태 Idle/);
  await expect(graph(page).locator('.diagram-node.is-after')).toHaveAccessibleName(/^상태 Waiting/);
  await expect(graph(page).locator('.diagram-node.is-current')).toHaveAccessibleName(/^상태 Done/);
  await expect(
    occurrences(page).getByRole('region', { name: '선택 후 상태와 변수' }),
  ).toContainText('Waiting');
  await graph(page)
    .getByRole('button', { name: /^상태도 규칙 complete 선택/ })
    .focus();
  await page.keyboard.press('Enter');
  await occurrences(page)
    .getByRole('button', { name: '시퀀스에서 관련 기록 보기', exact: true })
    .click();
  await expect(page.locator('summary').filter({ hasText: '통신 시퀀스 보기' })).toBeFocused();
  await expect(sequence(page).locator(`[data-sequence-id="${completed.eventId}"]`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(sequence(page).locator('.is-related').first()).toBeAttached();
  await expect(sequence(page).getByLabel('연결된 기록만 보기')).toBeChecked();
  await expect(
    sequence(page).getByRole('button', { name: /통신 시퀀스 .*상위 전달 pong/ }),
  ).toBeAttached();
  await sequence(page).getByLabel('연결된 기록만 보기').uncheck();
  await expect(sequence(page).locator('.sequence-row[aria-pressed="true"]')).toHaveAttribute(
    'data-sequence-id',
    completed.eventId,
  );
  await sequence(page).getByLabel('연결된 기록만 보기').check();
  await sequence(page)
    .getByRole('region', { name: 'A B 통신 화살표' })
    .screenshot({ path: info.outputPath('linked-sequence.png') });
  await graph(page).screenshot({ path: info.outputPath('linked-state.png') });
});
test('retry occurrence selection changes actual variables without conflating repeated rules', async ({
  page,
}) => {
  const config = editExperiment(
    createStopAndWaitExperiment(),
    '/environment/directions/AtoB/lossRate',
    1,
  );
  const view = core(config);
  const retries = view.events.filter(
    (event) => event.kind === 'transition' && event.ruleId === 'retry',
  );
  const ruleIndex = config.definitions[0]?.rules.findIndex((rule) => rule.id === 'retry');
  if (!retries[0] || !retries[1] || ruleIndex === undefined) throw new Error('Missing retries');
  await load(page, config);
  await page.locator('summary').filter({ hasText: '실행 상태도 보기' }).click();
  await graph(page)
    .getByRole('combobox', { name: '참여자 A 실행 상태도 규칙 선택', exact: true })
    .selectOption(String(ruleIndex));
  await expect(occurrences(page).locator('[data-linked-transition]')).toHaveCount(3);
  await expect(
    occurrences(page).getByRole('region', { name: '선택 후 상태와 변수' }),
  ).toContainText('"retries": 3');
  await occurrences(page).locator(`[data-linked-transition="${retries[0].eventId}"]`).click();
  await expect(
    occurrences(page).getByRole('region', { name: '선택 후 상태와 변수' }),
  ).toContainText('"retries": 1');
  const send = view.events.find(
    (event) => event.kind === 'send' && event.causeEventId === retries[1]?.causeEventId,
  );
  if (!send) throw new Error('Missing send');
  await selectEvent(page, send.eventId);
  await expect(occurrences(page).locator('[data-linked-transition]')).toHaveCount(1);
  await expect(occurrences(page)).toContainText(retries[1].eventId);
  await expect(
    occurrences(page).getByRole('region', { name: '선택 후 상태와 변수' }),
  ).toContainText('"retries": 2');
});
test('state nodes query real entries and exits and an unexecuted rule clears old sequence highlights', async ({
  page,
}) => {
  const config = getExampleOriginal('ping_pong');
  await load(page, config);
  await page.locator('summary').filter({ hasText: '실행 상태도 보기' }).click();
  await graph(page)
    .getByRole('button', { name: /^상태 Waiting/ })
    .focus();
  await page.keyboard.press('Space');
  await expect(occurrences(page).locator('[data-linked-transition]')).toHaveCount(2);
  await expect(graph(page).getByRole('button', { name: /^상태 Waiting/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const index = config.definitions[0]?.rules.findIndex((rule) => rule.id === 'expire');
  await graph(page)
    .getByRole('combobox', { name: '참여자 A 실행 상태도 규칙 선택', exact: true })
    .selectOption(String(index));
  await expect(occurrences(page)).toContainText('이 규칙의 상태 전이 기록이 없습니다');
  await expect(occurrences(page).locator('[data-linked-transition]')).toHaveCount(0);
  await expect(sequence(page).locator('.is-related')).toHaveCount(0);
});
test('one coalesced read exposes both receiver transitions and never selects the sender rule', async ({
  page,
}) => {
  const base = getExampleOriginal('ping_pong');
  const actions = base.definitions[0]?.rules[0]?.actions;
  if (!actions?.[1]) throw new Error('Missing actions');
  let config = editExperiment(base, '/definitions/0/rules/0/actions', [
    ...actions.slice(0, 2),
    actions[1],
    ...actions.slice(2),
  ]);
  config = editExperiment(config, '/environment/directions/AtoB/chunkBytes', 65536);
  const read = core(config).events.find(
    (event) => event.kind === 'receive' && event.participant === 'B',
  );
  if (!read) throw new Error('Missing read');
  await load(page, config);
  await selectEvent(page, read.eventId);
  await sequence(page).getByRole('button', { name: '연결된 상태도 보기', exact: true }).click();
  await expect(graph(page, 'B')).toBeVisible();
  await expect(graph(page, 'B').locator('.diagram-edge.is-selected')).toHaveCount(0);
  await expect(occurrences(page).locator('[data-linked-transition]')).toHaveCount(2);
  await expect(occurrences(page)).toContainText('여러 전이가 연결');
  await occurrences(page).locator('[data-linked-transition]').last().click();
  await expect(occurrences(page)).toContainText('reply');
  await expect(graph(page, 'B').locator('.diagram-node.is-before.is-after')).toHaveCount(1);
});
test('history selection cannot reveal a future commit and snapshot links survive draft edits at 390px', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const config = getExampleOriginal('tcp_handshake');
  const sent = core(config).events.find(
    (event) => event.kind === 'send' && event.participant === 'A',
  );
  if (!sent) throw new Error('Missing send');
  await load(page, config);
  await page.getByRole('combobox', { name: '과거 실행 선택' }).selectOption({ index: 1 });
  await selectEvent(page, sent.eventId);
  await sequence(page).getByRole('button', { name: '연결된 상태도 보기', exact: true }).click();
  await expect(occurrences(page)).toContainText('상태 전이 기록이 없습니다');
  await expect(graph(page).locator('.diagram-node.is-before, .diagram-node.is-after')).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: '기록 처음', exact: true }).click();
  await expect(occurrences(page)).toHaveCount(0);
  await expect(sequence(page).locator('.sequence-row')).toHaveCount(0);
  await page.getByRole('button', { name: '저장 시점', exact: true }).click();
  await page
    .getByRole('navigation', { name: '작업 공간' })
    .getByRole('button', { name: '프로토콜', exact: true })
    .click();
  await page.locator('[data-path="/definitions/0/states/0/label"]').fill('변경한 초안 상태');
  await page
    .getByRole('navigation', { name: '작업 공간' })
    .getByRole('button', { name: '실행', exact: true })
    .click();
  await page.locator('summary').filter({ hasText: '실행 상태도 보기' }).click();
  await graph(page)
    .getByRole('combobox', { name: '참여자 A 실행 상태도 규칙 선택', exact: true })
    .selectOption('0');
  await expect(graph(page)).not.toContainText('변경한 초안 상태');
  await expect(
    graph(page).getByRole('button', { name: '규칙 편집 위치로 이동', exact: true }),
  ).toBeDisabled();
  await occurrences(page)
    .getByRole('button', { name: '시퀀스에서 관련 기록 보기', exact: true })
    .click();
  await expect(sequence(page).locator('.sequence-row[aria-pressed="true"]')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await sequence(page).screenshot({ path: info.outputPath('linked-tcp-390.png') });
});
test('inspecting a live event pauses automatic progress and reset removes all stale links', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-11-02T00:00:00Z') });
  await page.goto('/');
  await page.clock.pauseAt(new Date('2026-11-02T01:00:00Z'));
  await page.getByRole('button', { name: '한 단계', exact: true }).click();
  await page.getByRole('button', { name: '전체 실행', exact: true }).click();
  await page.locator('summary').filter({ hasText: '통신 시퀀스 보기' }).click();
  await sequence(page)
    .getByRole('button', { name: /통신 시퀀스 .*송신 ping/ })
    .click();
  await expect(page.getByRole('button', { name: '일시 정지', exact: true })).toBeDisabled();
  const status = await page.getByText(/일시 정지 · 가상 시간/).textContent();
  await page.clock.runFor(240);
  await expect(page.getByText(/일시 정지 · 가상 시간/)).toHaveText(status ?? '');
  await page.getByRole('button', { name: '실행 초기화', exact: true }).click();
  await expect(sequence(page)).toHaveCount(0);
  await expect(occurrences(page)).toHaveCount(0);
  await page.getByRole('button', { name: '한 단계', exact: true }).click();
  await expect(page.locator('summary').filter({ hasText: '실행 상태도 보기' })).toHaveCount(1);
  await page.locator('summary').filter({ hasText: '실행 상태도 보기' }).click();
  await expect(occurrences(page)).toHaveCount(0);
});

test('external event and state selections reveal off-page rules and states without changing zoom', async ({
  page,
}) => {
  const base = getExampleOriginal('ping_pong');
  const protocol = base.definitions[0];
  if (!protocol) throw new Error('Missing protocol');
  const config: ExperimentDefinition = {
    ...base,
    definitions: [
      {
        ...protocol,
        states: [
          ...Array.from({ length: 50 }, (_, index) => ({
            id: `spare${index}`,
            label: `사용하지 않는 상태 ${index}`,
          })),
          ...protocol.states,
        ],
        rules: [
          ...Array.from({ length: 25 }, (_, index) => ({
            id: `spare_rule${index}`,
            fromStateId: `spare${index}`,
            nextStateId: `spare${index}`,
            event: { kind: 'input' as const, messageId: 'ping' },
            actions: [],
            ignore: true,
          })),
          ...protocol.rules,
        ],
      },
    ],
  };
  const send = core(config).events.find(
    (event) => event.kind === 'send' && event.participant === 'A',
  );
  if (!send) throw new Error('Missing send');
  await load(page, config);
  await selectEvent(page, send.eventId);
  await sequence(page).getByRole('button', { name: '연결된 상태도 보기', exact: true }).click();
  await expect(graph(page)).toContainText('규칙 2/2');
  await expect(graph(page).locator('.diagram-edge.is-selected')).toHaveAccessibleName(/start/);
  await expect(graph(page).locator('.diagram-node.is-after')).toHaveAccessibleName(/^상태 Waiting/);
  await graph(page)
    .getByRole('combobox', { name: '참여자 A 실행 상태도 크기', exact: true })
    .selectOption('1.25');
  await graph(page)
    .getByRole('button', { name: /^상태 Done/ })
    .focus();
  await page.keyboard.press('Enter');
  await expect(graph(page)).toContainText('상태 2/2');
  await expect(
    graph(page).getByRole('combobox', { name: '참여자 A 실행 상태도 크기', exact: true }),
  ).toHaveValue('1.25');
  await expect(occurrences(page).locator('[data-linked-transition]')).toHaveCount(1);
});

test('automatic history playback advances the selected sequence event and graph participant together and selection pauses it', async ({
  page,
}) => {
  await load(page, getExampleOriginal('ping_pong'));
  await page.getByRole('combobox', { name: '과거 실행 선택' }).selectOption({ index: 1 });
  await page.clock.install({ time: new Date('2026-11-02T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-02T01:00:00Z'));
  await page.getByRole('button', { name: '기록 처음', exact: true }).click();
  await page.getByRole('button', { name: '기록 자동 재생', exact: true }).click();
  await page.clock.runFor(125);
  await expect(sequence(page).locator('.sequence-row[aria-pressed="true"]')).toHaveAttribute(
    'data-sequence-id',
    'e-1',
  );
  await page.clock.runFor(120);
  await expect(sequence(page).locator('.sequence-row[aria-pressed="true"]')).toHaveAttribute(
    'data-sequence-id',
    'e-2',
  );
  await sequence(page).locator('[data-sequence-id="e-2"]').click();
  await expect(page.getByRole('button', { name: '기록 자동 재생', exact: true })).toBeVisible();
  await sequence(page).getByRole('button', { name: '연결된 상태도 보기', exact: true }).click();
  await expect(graph(page).locator('.diagram-edge.is-selected')).toHaveAccessibleName(/start/);
  const cursor = await page
    .getByRole('slider', { name: '기록 재생 위치', exact: true })
    .inputValue();
  await page.clock.runFor(240);
  await expect(page.getByRole('slider', { name: '기록 재생 위치', exact: true })).toHaveValue(
    cursor,
  );
});
