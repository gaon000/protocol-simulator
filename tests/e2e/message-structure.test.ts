import { expect, type Page, test } from '@playwright/test';
import { createSimulation } from '../../src/application/create-simulation.ts';
import { editExperiment } from '../../src/application/edit-experiment.ts';
import { captureRun, createWorkspace } from '../../src/application/workspace-operations.ts';
import type { ExperimentDefinition } from '../../src/domain/protocol-model.ts';
import type { WorkspaceData } from '../../src/domain/workspace-model.ts';
import { createExampleCopy } from '../../src/examples/catalog.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';
import { createMessageLimitExperiment } from '../fixtures/large-experiments.ts';

const structure = (page: Page) =>
  page.getByRole('region', { name: '선택 메시지 구조', exact: true });
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
async function load(page: Page, data: WorkspaceData) {
  await page.goto('/');
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'structure.json',
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
async function open(page: Page, id: string) {
  await selectEvent(page, id);
  await page.locator('summary').filter({ hasText: '메시지 구조 보기' }).click();
}
async function selectEvent(page: Page, id: string) {
  const first = page.getByRole('button', { name: '기록 첫 페이지', exact: true });
  if (await first.isEnabled()) await first.click();
  const targetPage = Math.floor((Number(id.slice(2)) - 1) / 200);
  for (let index = 0; index < targetPage; index++)
    await page.getByRole('button', { name: '기록 다음 페이지', exact: true }).click();
  await page.locator(`[data-event-id="${id}"]`).click();
}
function firstSend(config: ExperimentDefinition) {
  const event = core(config).events.find((item) => item.kind === 'send');
  if (!event) throw new Error('Missing send');
  return event;
}

test('HTTP areas and mapped fields select exact UTF-8 body and start-line bytes', async ({
  page,
}) => {
  const config = editExperiment(
    createExampleCopy('http_post'),
    '/scenario/inputs/0/message/values/body',
    '한글😀',
  );
  await start(page, config);
  await open(page, firstSend(config).eventId);
  await expect(structure(page)).toHaveAttribute('data-structure-status', 'mapped');
  await expect(structure(page)).toContainText('Content-Length: 10 bytes');
  await structure(page).locator('[data-structure-field="body"]').click();
  await expect(structure(page).locator('[data-byte-selected="true"]')).toHaveCount(10);
  await expect(structure(page).locator('.structure-selection')).toContainText('10 bytes');
  await structure(page).locator('[data-structure-field="method"]').click();
  await expect(structure(page).locator('[data-byte-selected="true"]')).toHaveCount(4);
  await expect(structure(page).locator('[data-byte-offset="0"]')).toHaveText('50');
  await structure(page).locator('.structure-region-body').click();
  await expect(structure(page).locator('.structure-region-body')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await structure(page).screenshot({ path: test.info().outputPath('http-structure.png') });
});

test('JSON highlights actual escaped wire tokens while keeping logical placement and false/zero values', async ({
  page,
}) => {
  const base = createPingPongExperiment('json-datagram');
  let config = editExperiment(base, '/scenario/inputs/0/message/values/text', '한😀"\\');
  config = editExperiment(config, '/definitions/0/rules/0/actions/1/values', {
    sequence: { kind: 'literal', value: 0 },
    text: { kind: 'field', fieldId: 'text' },
    urgent: { kind: 'literal', value: false },
  });
  await start(page, config);
  await open(page, firstSend(config).eventId);
  await expect(structure(page)).toHaveAttribute('data-structure-status', 'mapped');
  await expect(structure(page).locator('[data-structure-field="sequence"]')).toContainText(
    '기록 값: 0',
  );
  await expect(structure(page).locator('[data-structure-field="urgent"]')).toContainText(
    '기록 값: false',
  );
  await structure(page).locator('[data-structure-field="text"]').click();
  const bytes = new TextEncoder().encode(JSON.stringify('한😀"\\')).length;
  await expect(structure(page).locator('[data-byte-selected="true"]')).toHaveCount(bytes);
  await expect(structure(page)).toContainText('논리 배치');
  await expect(structure(page).getByRole('button', { name: /메시지 구분자 LF/ })).toHaveCount(0);
});

test('a receive chunk does not expose future decoded fields and parsed values do not fabricate wire bytes', async ({
  page,
}) => {
  const config = createExampleCopy('http_split');
  const view = core(config);
  const read = view.events.find((item) => item.kind === 'receive');
  const parsed = view.events.find((item) => item.kind === 'parsed');
  if (!read || !parsed) throw new Error('Missing fixture');
  await start(page, config);
  await open(page, read.eventId);
  await expect(structure(page)).toHaveAttribute('data-structure-status', 'chunk');
  await expect(structure(page).locator('[data-structure-field]')).toHaveCount(0);
  await expect(structure(page)).toContainText('다른 청크나 원인 송신을 합쳐');
  await selectEvent(page, parsed.eventId);
  await expect(structure(page)).toHaveAttribute('data-structure-status', 'logical');
  await expect(structure(page).getByRole('region', { name: '실제 바이트 탐색' })).toHaveCount(0);
  await expect(structure(page).locator('[data-structure-field="method"]')).toContainText('POST');
});

test('history reload and draft wire-name changes retain frozen structure and hide cursor-future bytes', async ({
  page,
}) => {
  const config = createExampleCopy('ping_pong');
  const data = createWorkspace(config);
  const record = captureRun(core(config), data.activeDraftId, 1);
  const event = firstSend(config);
  await load(page, { ...data, runs: [record] });
  await tab(page, '실행');
  await page.getByRole('combobox', { name: '과거 실행 선택' }).selectOption(record.id);
  await open(page, event.eventId);
  await expect(structure(page).locator('[data-structure-field="sequence"]')).toContainText(
    'number',
  );
  await page.getByRole('button', { name: '기록 처음', exact: true }).click();
  await expect(structure(page)).toHaveAttribute('data-structure-status', 'unavailable');
  await expect(structure(page).locator('[data-byte-offset]')).toHaveCount(0);
  await tab(page, '프로토콜');
  await page
    .locator('[data-path="/definitions/0/messages/0/fields/0/name"]')
    .fill('editedWireName');
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
  await open(page, event.eventId);
  await expect(structure(page).locator('[data-structure-field="sequence"]')).toContainText(
    'number',
  );
  await expect(structure(page)).not.toContainText('editedWireName');
  await expect(structure(page)).toHaveAttribute('data-structure-status', 'mapped');
});

test('logical transport packets show fields without binary offsets or generated byte tables', async ({
  page,
}) => {
  const config = createPingPongExperiment('logical-packet');
  await start(page, config);
  await open(page, firstSend(config).eventId);
  await expect(structure(page)).toHaveAttribute('data-structure-status', 'logical');
  await expect(structure(page)).toContainText('바이너리 TCP/IP encoding');
  await expect(structure(page).locator('[data-structure-field="sequence"]')).toContainText(
    '기록 값: 1',
  );
  await expect(structure(page).locator('[data-byte-offset]')).toHaveCount(0);
});

test('one MiB wire payload stays bounded and the last byte is reachable without replacing the trace', async ({
  page,
}) => {
  const config = createMessageLimitExperiment();
  await start(page, config);
  await open(page, firstSend(config).eventId);
  await expect(structure(page)).toHaveAttribute('data-structure-status', 'limited');
  await expect(structure(page).locator('[data-byte-offset]')).toHaveCount(256);
  await structure(page).getByRole('button', { name: '끝 바이트', exact: true }).click();
  await expect(
    structure(page).getByRole('spinbutton', { name: '바이트 페이지', exact: true }),
  ).toHaveValue('4096');
  await expect(structure(page).locator('[data-byte-offset="1048575"]')).toHaveText('0a');
  expect(await structure(page).evaluate((node) => node.textContent?.length ?? 0)).toBeLessThan(
    32768,
  );
});

test('field pagination, keyboard selection and native hex scrolling fit a 390px viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const base = createExampleCopy('ping_pong');
  const protocol = base.definitions[0];
  if (!protocol) throw new Error('Missing protocol');
  const config = {
    ...base,
    definitions: [
      {
        ...protocol,
        messages: protocol.messages.map((message) => ({
          ...message,
          fields: [
            ...message.fields,
            ...Array.from({ length: 25 }, (_, index) => ({
              id: `f${index}`,
              name: `wire${index}`,
              type: 'integer' as const,
              placement: 'payload' as const,
              required: false,
              defaultValue: index,
            })),
          ],
        })),
      },
    ],
  };
  await start(page, config);
  await page.locator(`[data-event-id="${firstSend(config).eventId}"]`).click();
  await page.locator('summary').filter({ hasText: '메시지 구조 보기' }).focus();
  await page.keyboard.press('Enter');
  await expect(structure(page).locator('[data-structure-field]')).toHaveCount(20);
  await structure(page).getByRole('button', { name: '필드 다음', exact: true }).click();
  await expect(structure(page).locator('[data-structure-field]')).toHaveCount(9);
  const field = structure(page).locator('[data-structure-field="f20"]');
  await field.focus();
  await page.keyboard.press('Enter');
  await expect(field).toHaveAttribute('aria-pressed', 'true');
  await expect(structure(page).locator('[data-byte-selected="true"]')).toHaveCount(2);
  const scroll = structure(page).getByRole('region', { name: 'hex ASCII 바이트 표' });
  expect(await scroll.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  await scroll.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => scroll.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await structure(page).screenshot({ path: test.info().outputPath('message-structure-390.png') });
});
