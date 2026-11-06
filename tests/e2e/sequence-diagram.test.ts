import { expect, type Page, test } from '@playwright/test';
import { createSimulation } from '../../src/application/create-simulation.ts';
import { editExperiment } from '../../src/application/edit-experiment.ts';
import { createWorkspace } from '../../src/application/workspace-operations.ts';
import type { ExperimentDefinition } from '../../src/domain/protocol-model.ts';
import { getExampleOriginal } from '../../src/examples/catalog.ts';
import { createStopAndWaitExperiment } from '../../src/examples/stop-and-wait.ts';

async function load(page: Page, config: ExperimentDefinition) {
  await page.goto('/');
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'sequence.json',
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
  await expect(page.getByLabel('bundle 가져오기', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: /^(현재 초안 |새 설정으로 )?전체 실행$/ }).click();
  await expect(page.getByText(/관찰 완료 · 가상 시간/)).toBeVisible();
  await page.locator('summary').filter({ hasText: '통신 시퀀스 보기' }).click();
  return page.getByRole('region', { name: '통신 시퀀스 다이어그램', exact: true });
}
async function select(page: Page, id: string) {
  const diagram = page.getByRole('region', { name: '통신 시퀀스 다이어그램', exact: true });
  const first = diagram.getByRole('button', { name: '시퀀스 처음', exact: true });
  if (await first.isEnabled()) await first.click();
  const row = diagram.locator(`[data-sequence-id="${id}"]`);
  while (!(await row.count()))
    await diagram.getByRole('button', { name: '시퀀스 다음', exact: true }).click();
  await row.click();
  return diagram;
}
function result(config: ExperimentDefinition) {
  const created = createSimulation(config);
  if (!created.success) throw new Error('Invalid fixture');
  return created.value.run();
}
test('HTTP sequence selection exposes snapshot fields, bytes, causes and keyboard-operable parsed events', async ({
  page,
}, info) => {
  const config = getExampleOriginal('http_post');
  const core = result(config);
  const sent = core.events.find((event) => event.kind === 'send' && event.participant === 'A');
  const parsed = core.events.find((event) => event.kind === 'parsed' && event.participant === 'B');
  if (!sent || !parsed) throw new Error('Missing events');
  await load(page, config);
  const diagram = await select(page, sent.eventId);
  const detail = diagram.getByRole('region', { name: '시퀀스 선택 상세', exact: true });
  await expect(detail.getByRole('region', { name: '전송 바이트 미리보기' })).toContainText(
    'POST /echo HTTP/1.1',
  );
  await expect(diagram.locator('.sequence-fields')).toContainText('안녕하세요');
  await diagram
    .getByRole('region', { name: '시퀀스 인과관계' })
    .getByRole('button', { name: new RegExp(`원인·합쳐진 송신 ${sent.causeEventId} ·`) })
    .click();
  await expect(detail).toContainText(`${sent.causeEventId} · input`);
  const parsedRow = diagram.locator(`[data-sequence-id="${parsed.eventId}"]`);
  await parsedRow.focus();
  await page.keyboard.press('Enter');
  await expect(parsedRow).toHaveAttribute('aria-pressed', 'true');
  await expect(detail).toContainText(`${parsed.eventId} · parsed`);
  await diagram.getByRole('button', { name: '시퀀스 선택 상세로 이동', exact: true }).click();
  await expect(diagram.locator('.sequence-detail')).toBeFocused();
  await diagram.screenshot({ path: info.outputPath('http-sequence.png') });
});
test('ACK loss and timer-driven retry are visible separately from duplicate upper delivery', async ({
  page,
}, info) => {
  const config = editExperiment(createStopAndWaitExperiment(), '/environment/targetedDrops', [
    { direction: 'BtoA', transmission: 1 },
  ]);
  const diagram = await load(page, config);
  await expect(
    diagram.getByRole('button', { name: /통신 시퀀스 .*데이터그램 지정 손실/ }),
  ).toBeAttached();
  await expect(diagram.getByRole('button', { name: /통신 시퀀스 .*재전송 후보/ })).toHaveCount(1);
  await expect(diagram.getByRole('button', { name: /통신 시퀀스 .*상위 전달 data/ })).toHaveCount(
    1,
  );
  await diagram.getByRole('button', { name: /통신 시퀀스 .*재전송 후보/ }).click();
  await expect(diagram.locator('.sequence-fields')).toContainText('payload');
  const canvas = diagram.getByRole('region', { name: 'A B 통신 화살표', exact: true });
  const selectedRow = diagram.locator('.sequence-row[aria-pressed="true"]');
  const scrollPosition = await selectedRow.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const parent = element.parentElement?.getBoundingClientRect();
    return parent ? bounds.top >= parent.top + 60 && bounds.bottom <= parent.bottom : false;
  });
  expect(scrollPosition).toBe(true);
  await canvas.scrollIntoViewIfNeeded();
  await canvas.screenshot({ path: info.outputPath('ack-loss-sequence.png') });
});
test('duplicate before original is labeled from actual arrival and full-event filtering preserves selection', async ({
  page,
}) => {
  let config = editExperiment(
    createStopAndWaitExperiment(),
    '/environment/directions/AtoB/jitterMs',
    4,
  );
  config = editExperiment(config, '/environment/directions/AtoB/duplicateRate', 1);
  const diagram = await load(page, config);
  const arrivals = diagram.locator('.sequence-receive');
  await expect(arrivals.first()).toHaveAccessibleName(/중복 복사본 도착/);
  await arrivals.first().focus();
  await page.keyboard.press('Space');
  await expect(arrivals.first()).toHaveAttribute('aria-pressed', 'true');
  await diagram.getByLabel('전체 이벤트 표시').check();
  await expect(diagram.locator('[aria-pressed="true"]')).toHaveCount(1);
  await expect(
    diagram.getByRole('region', { name: '시퀀스 선택 상세', exact: true }),
  ).toContainText('receive');
});
test('history cursor hides future arrows and a changed draft cannot alter old TCP fields at 390px', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const diagram = await load(page, getExampleOriginal('tcp_handshake'));
  await expect(diagram.locator('.sequence-receive')).toHaveCount(3);
  const canvas = diagram.getByRole('region', { name: 'A B 통신 화살표', exact: true });
  await canvas.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await canvas.scrollIntoViewIfNeeded();
  await canvas.screenshot({ path: info.outputPath('tcp-full-sequence-390.png') });
  await page.getByRole('combobox', { name: '과거 실행 선택' }).selectOption({ index: 1 });
  await page.getByRole('button', { name: '기록 처음', exact: true }).click();
  await expect(diagram.locator('.sequence-row')).toHaveCount(0);
  await page.getByRole('button', { name: '저장 시점', exact: true }).click();
  const receive = diagram.locator('.sequence-receive').first();
  await receive.click();
  await expect(
    diagram.getByRole('region', { name: '시퀀스 선택 상세', exact: true }),
  ).toContainText('receive');
  await expect(diagram.locator('.sequence-fields')).toContainText('수신 해석 결과 아님');
  const visible = await diagram.locator('.sequence-row').count();
  expect(visible).toBeLessThan(30);
  await page.getByRole('button', { name: '저장 시점', exact: true }).click();
  await page
    .getByRole('navigation', { name: '작업 공간' })
    .getByRole('button', { name: '프로토콜', exact: true })
    .click();
  await page.locator('[data-path="/definitions/0/messages/1/fields/0/name"]').fill('changed_wire');
  await page
    .getByRole('navigation', { name: '작업 공간' })
    .getByRole('button', { name: '실행', exact: true })
    .click();
  await page.locator('summary').filter({ hasText: '통신 시퀀스 보기' }).click();
  const core = result(getExampleOriginal('tcp_handshake'));
  const sent = core.events.find((event) => event.kind === 'send' && event.participant === 'A');
  if (!sent) throw new Error('Missing send');
  await select(page, sent.eventId);
  await expect(diagram.locator('.sequence-fields')).not.toContainText('changed_wire');
  await expect(diagram.locator('.sequence-fields')).toContainText('seq');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await diagram.screenshot({ path: info.outputPath('tcp-sequence-390.png') });
});
test('split HTTP byte rows paginate independently and source navigation selects the exact sender', async ({
  page,
}) => {
  const diagram = await load(page, getExampleOriginal('http_split'));
  await expect(diagram.locator('.sequence-row')).not.toHaveCount(0);
  await diagram.getByRole('button', { name: '시퀀스 처음', exact: true }).click();
  await expect(diagram.locator('.sequence-row').first()).toHaveAttribute('data-sequence-id', 'e-1');
  await diagram.locator('.sequence-receive').first().click();
  await expect(diagram).toContainText('청크 수신은 완성 메시지 수신을 뜻하지 않습니다');
  await diagram
    .getByRole('region', { name: '시퀀스 인과관계' })
    .getByRole('button', { name: /원인·합쳐진 송신 .*송신/ })
    .click();
  await expect(
    diagram.getByRole('region', { name: '시퀀스 선택 상세', exact: true }),
  ).toContainText('send');
  const relations = diagram.getByRole('region', { name: '시퀀스 인과관계' });
  await expect(relations.getByRole('button', { name: /원인·합쳐진 송신|직접 후속/ })).toHaveCount(
    20,
  );
  const firstRelation = await relations
    .getByRole('button', { name: /원인·합쳐진 송신|직접 후속/ })
    .first()
    .textContent();
  await relations.getByRole('button', { name: '관계 다음 페이지', exact: true }).click();
  await expect(
    relations.getByRole('button', { name: /원인·합쳐진 송신|직접 후속/ }).first(),
  ).not.toHaveText(firstRelation ?? '');
  await diagram.getByRole('button', { name: '시퀀스 다음', exact: true }).click();
  await expect(diagram.locator('.sequence-row')).toHaveCount(30);
  await expect(diagram.locator('.sequence-row').first()).not.toHaveAttribute(
    'data-sequence-id',
    'e-1',
  );
});

test('total datagram loss exposes bounded retries and an observed timeout failure without receipt arrows', async ({
  page,
}) => {
  const config = editExperiment(
    createStopAndWaitExperiment(),
    '/environment/directions/AtoB/lossRate',
    1,
  );
  const diagram = await load(page, config);
  await expect(diagram.locator('.sequence-receive')).toHaveCount(0);
  await expect(diagram.getByRole('button', { name: /통신 시퀀스 .*재전송 후보/ })).toHaveCount(3);
  await expect(
    diagram.getByRole('button', { name: /통신 시퀀스 .*데이터그램 확률 손실/ }),
  ).toHaveCount(4);
  await expect(diagram.getByRole('button', { name: /통신 시퀀스 .*타임아웃 실패/ })).toHaveCount(1);
});
