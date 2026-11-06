import { expect, test, type Page } from '@playwright/test';
import { createWorkspace } from '../../src/application/workspace-operations.ts';
import { createSimulation } from '../../src/application/create-simulation.ts';
import { createExampleCopy, getExampleOriginal } from '../../src/examples/catalog.ts';

async function view(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: '작업 공간' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function run(page: Page) {
  await page.getByRole('button', { name: /^(새 설정으로 |현재 초안 )?전체 실행$/ }).click();
  await expect(page.getByText(/관찰 완료 · 가상 시간/)).toBeVisible();
}
async function diagram(page: Page, participant: 'A' | 'B' = 'A') {
  const summary = page.locator('summary').filter({ hasText: '실행 상태도 보기' });
  if (!(await page.getByRole('group', { name: '상태도 참여자 선택', exact: true }).isVisible()))
    await summary.click();
  await page.getByRole('button', { name: `참여자 ${participant} 상태도`, exact: true }).click();
  return page.getByRole('region', { name: `참여자 ${participant} 실행 상태도`, exact: true });
}
const field = (page: Page, path: string) => page.locator(`[data-path="${path}"]`);

test('draft states and rules are generated, SVG keyboard selection exposes actions, and edit links focus real fields', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/');
  await view(page, '프로토콜');
  const graph = page.getByRole('region', { name: '프로토콜 상태도', exact: true });
  await expect(graph.getByRole('button', { name: /^상태 Idle/ })).toContainText('초기');
  await expect(graph.getByRole('button', { name: /^상태 Done/ })).toContainText('종료');
  const edge = graph.getByRole('button', { name: /^상태도 규칙 start 선택/ });
  await edge.focus();
  await page.keyboard.press('Space');
  await expect(edge).toHaveAttribute('aria-pressed', 'true');
  const detail = graph.getByRole('region', { name: '프로토콜 상태도 선택 규칙' });
  await expect(detail).toContainText('하위로 전송 · ping');
  await expect(detail).toContainText('타이머 response 시작 · 500 ms');
  await graph
    .getByRole('button', { name: /^상태도 규칙 expire 선택/ })
    .locator('rect')
    .click();
  await expect(detail).toContainText('실패로 종료');
  await edge.locator('rect').click();
  await detail.getByRole('button', { name: '규칙 편집 위치로 이동', exact: true }).click();
  await expect(field(page, '/definitions/0/rules/0')).toBeFocused();
  await field(page, '/definitions/0/states/1/label').fill('서버 응답 대기');
  await expect(graph.getByRole('button', { name: /^상태 Waiting/ })).toContainText(
    '서버 응답 대기',
  );
  await graph.getByRole('button', { name: /^상태 Waiting/ }).focus();
  await page.keyboard.press('Enter');
  await graph.getByRole('button', { name: '상태 편집 위치로 이동', exact: true }).click();
  await expect(field(page, '/definitions/0/states/1')).toBeFocused();
  await graph.scrollIntoViewIfNeeded();
  await graph.screenshot({ path: info.outputPath('draft-ping-pong.png') });
});

test('unfinished references and duplicate/empty state IDs stay visible without false arrows or crashes', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await view(page, '프로토콜');
  const graph = page.getByRole('region', { name: '프로토콜 상태도', exact: true });
  await field(page, '/definitions/0/states/1/id').fill('Renamed');
  await expect(graph.getByRole('button', { name: /^상태 Waiting.*없는 상태 참조/ })).toBeAttached();
  await expect(page.getByRole('button', { name: '전체 실행', exact: true })).toBeDisabled();
  await field(page, '/definitions/0/states/0/id').fill('Renamed');
  await expect(graph.locator('.diagram-node.is-invalid')).toHaveCount(4);
  await field(page, '/definitions/0/states/0/id').fill('');
  await expect(graph.getByRole('button', { name: /^상태 \(빈 ID\).*빈 상태 ID/ })).toBeAttached();
  expect(errors).toEqual([]);
});

test('current states and recent rules follow actual steps and the history cursor without using future transitions', async ({
  page,
}, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: '한 단계', exact: true }).click();
  const graph = await diagram(page);
  await expect(graph.locator('[data-current-participants="A"]')).toContainText('Waiting');
  await expect(graph.locator('.diagram-edge.is-applied')).toHaveAttribute(
    'aria-label',
    /start.*최근 적용 A/,
  );
  await run(page);
  await expect(graph.locator('[data-current-participants="A"]')).toContainText('Done');
  await expect(graph.locator('.diagram-edge.is-applied')).toHaveAttribute(
    'aria-label',
    /complete.*최근 적용 A/,
  );
  await page.getByRole('combobox', { name: '과거 실행 선택' }).selectOption({ index: 1 });
  const slider = page.getByRole('slider', { name: '기록 재생 위치', exact: true });
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(graph.locator('[data-current-participants="A"]')).toContainText('Idle');
  await expect(graph.locator('.diagram-edge.is-applied')).toHaveCount(0);
  const created = createSimulation(getExampleOriginal('ping_pong'));
  expect(created.success).toBe(true);
  if (!created.success) return;
  const count =
    created.value
      .run()
      .events.findIndex((event) => event.kind === 'transition' && event.participant === 'A') + 1;
  for (let index = 0; index < count; index++) await page.keyboard.press('ArrowRight');
  await expect(graph.locator('[data-current-participants="A"]')).toContainText('Waiting');
  await expect(graph.locator('.diagram-edge.is-applied')).toHaveAttribute(
    'aria-label',
    /start.*최근 적용 A/,
  );
  await page.keyboard.press('End');
  await expect(graph.locator('[data-current-participants="A"]')).toContainText('Done');
  await graph.screenshot({ path: info.outputPath('history-final.png') });
});

test('draft edits cannot change old snapshot diagrams or redirect their editor links', async ({
  page,
}) => {
  await page.goto('/');
  await run(page);
  await view(page, '프로토콜');
  await field(page, '/definitions/0/states/2/id').fill('MyDone');
  const draftGraph = page.getByRole('region', { name: '프로토콜 상태도', exact: true });
  await expect(draftGraph.locator('.diagram-node.is-current')).toHaveCount(0);
  await expect(draftGraph).toContainText('일치하는 실행 표시 없음');
  await view(page, '실행');
  const graph = await diagram(page);
  await expect(graph.locator('[data-current-participants="A"]')).toContainText('Done');
  await expect(graph.getByRole('button', { name: /^상태 MyDone/ })).toHaveCount(0);
  await expect(
    graph.getByRole('button', { name: '규칙 편집 위치로 이동', exact: true }),
  ).toBeDisabled();
  await expect(graph).toContainText('실행 당시 정의가 현재 초안과 달라');
});

test('asymmetric TCP protocols show independent A/B states and rules at narrow widths', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '실험 시작', exact: true }).click();
  await page.getByRole('button', { name: 'TCP 연결 수립 사본 만들기', exact: true }).click();
  await page.getByRole('button', { name: '한 단계', exact: true }).click();
  const a = await diagram(page);
  await expect(a.locator('[data-current-participants="A"]')).toContainText('SYN-SENT');
  await expect(a.locator('.diagram-edge.is-applied')).toHaveAttribute('aria-label', /active_open/);
  const b = await diagram(page, 'B');
  await expect(b.locator('[data-current-participants="B"]')).toContainText('LISTEN');
  await expect(b.locator('.diagram-edge.is-applied')).toHaveCount(0);
  await run(page);
  await expect(b.locator('[data-current-participants="B"]')).toContainText('ESTABLISHED');
  await expect(b.locator('.diagram-edge.is-applied')).toHaveAttribute('aria-label', /passive_ack/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await b.getByRole('button', { name: '현재 실행 위치 따라가기', exact: true }).click();
  await b.screenshot({ path: info.outputPath('tcp-390.png') });
});

test('large definition pages expose all rules and states while keeping the SVG bounded', async ({
  page,
}) => {
  const config = createExampleCopy('ping_pong');
  const original = config.definitions[0];
  const start = original?.rules[0];
  if (!original || !start) throw new Error('Missing fixture');
  const data = createWorkspace({
    ...config,
    definitions: [
      {
        ...original,
        states: [
          ...original.states,
          ...Array.from({ length: 50 }, (_, index) => ({
            id: `S${index}`,
            label: `상태 ${index}`,
          })),
        ],
        rules: Array.from({ length: 25 }, (_, index) => ({
          ...start,
          id: `r${index}`,
          nextStateId: `S${index < 5 ? 0 : index}`,
          condition: {
            kind: 'compare',
            operator: 'gte',
            left: { kind: 'literal', value: index },
            right: { kind: 'literal', value: 0 },
          },
        })),
      },
    ],
  });
  await page.goto('/');
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'large-draft.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'protocol-studio-bundle', data })),
  });
  await expect(page.getByText(/검증한 bundle을 적용/)).toBeVisible();
  await expect(page.getByLabel('bundle 가져오기', { exact: true })).toBeEnabled();
  await view(page, '프로토콜');
  const graph = page.getByRole('region', { name: '프로토콜 상태도', exact: true });
  await expect(graph).toContainText('상태 1/2 · 전체 54개');
  await graph
    .getByRole('button', { name: /^상태도 규칙 r0, r1/ })
    .locator('rect')
    .click();
  await graph.getByRole('combobox', { name: '프로토콜 상태도 규칙 선택' }).selectOption('4');
  await expect(graph.getByRole('region', { name: '프로토콜 상태도 선택 규칙' })).toContainText(
    '4 ≥ 0',
  );
  await graph.getByRole('button', { name: '규칙 다음 페이지', exact: true }).click();
  await expect(
    graph.getByRole('combobox', { name: '프로토콜 상태도 규칙 선택' }).locator('option'),
  ).toHaveCount(6);
  await graph.getByRole('combobox', { name: '프로토콜 상태도 규칙 선택' }).selectOption('24');
  await expect(graph.getByRole('region', { name: '프로토콜 상태도 선택 규칙' })).toContainText(
    '규칙 r24',
  );
  await graph.getByRole('button', { name: '상태 다음 페이지', exact: true }).click();
  await expect(graph.getByRole('button', { name: /^상태 S49/ })).toBeAttached();
  expect(await graph.locator('.diagram-node').count()).toBeLessThanOrEqual(83);
  expect(await graph.locator('.diagram-edge').count()).toBeLessThanOrEqual(20);
});

test('HTTP execution exposes the actual client and server final states as separate diagrams', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/');
  await page.getByRole('button', { name: '실험 시작', exact: true }).click();
  await page.getByRole('button', { name: 'HTTP GET 사본 만들기', exact: true }).click();
  await run(page);
  const a = await diagram(page);
  await expect(a.locator('[data-current-participants="A"]')).toContainText('Done');
  const b = await diagram(page, 'B');
  await expect(b.locator('[data-current-participants="B"]')).toContainText('Done');
  await expect(b.locator('.diagram-edge.is-applied')).toHaveCount(1);
  await b.getByRole('button', { name: '현재 실행 위치 따라가기', exact: true }).click();
  await b.screenshot({ path: info.outputPath('http-server.png') });
});
