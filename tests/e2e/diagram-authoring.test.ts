import { expect, type Page, test } from '@playwright/test';
import { createBlankExperiment } from '../../src/application/edit-experiment.ts';
import { createWorkspace } from '../../src/application/workspace-operations.ts';
import type { ExperimentDefinition } from '../../src/domain/protocol-model.ts';
import { getExampleOriginal } from '../../src/examples/catalog.ts';

const graph = (page: Page) => page.getByRole('region', { name: '프로토콜 상태도', exact: true });
const tools = (page: Page) => page.getByRole('group', { name: '상태도 작성 도구', exact: true });
const sidebar = (page: Page) =>
  page.getByRole('region', { name: '상태도 선택 편집기', exact: true });
const field = (page: Page, path: string) => page.locator(`[data-path="${path}"]`);
async function view(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: '작업 공간' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function load(page: Page, configuration?: ExperimentDefinition) {
  await page.goto('/');
  if (configuration) {
    await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
      name: 'authoring.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          kind: 'protocol-studio-bundle',
          data: createWorkspace(configuration),
        }),
      ),
    });
    await expect(page.getByText(/검증한 bundle을 적용/)).toBeVisible();
  }
  await view(page, '프로토콜');
}
async function chooseState(page: Page, id: string, key?: 'Enter' | 'Space') {
  const node = graph(page).getByRole('button', { name: new RegExp(`^상태 ${id} ·`) });
  if (key) {
    await node.focus();
    await page.keyboard.press(key);
  } else await node.locator('rect').first().click();
}
async function connect(page: Page, from: string, to: string) {
  await tools(page).getByRole('button', { name: '전이 연결 시작', exact: true }).click();
  await chooseState(page, from);
  await chooseState(page, to);
}

test('authors a real runnable transition on a narrow canvas, edits the single sidebar form, saves and restores it', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const blank = createBlankExperiment();
  const protocol = blank.definitions[0];
  if (!protocol) throw new Error('Missing blank protocol');
  await load(page, {
    ...blank,
    definitions: [{ ...protocol, messages: [{ id: 'go', label: 'Go', fields: [] }] }],
    scenario: {
      ...blank.scenario,
      inputs: [
        { id: 'start', participant: 'A', timeMs: 0, message: { messageId: 'go', values: {} } },
      ],
      expectations: [{ id: 'goal', participant: 'A', kind: 'state', stateId: 'state_1' }],
    },
  });
  await tools(page).getByRole('button', { name: '그림에 상태 추가', exact: true }).click();
  await expect(sidebar(page)).toContainText('선택한 상태 편집');
  await expect(field(page, '/definitions/0/states/1/label')).toHaveCount(1);
  await field(page, '/definitions/0/states/1/label').fill('완료 지점');
  await field(page, '/definitions/0/states/1/terminal').check();
  await connect(page, 'Idle', 'state_1');
  await expect(
    tools(page).getByRole('button', { name: '전이 생성하고 편집', exact: true }),
  ).toBeDisabled();
  await tools(page)
    .getByRole('combobox', { name: '연결 발생 이벤트', exact: true })
    .selectOption('input');
  await tools(page).getByRole('button', { name: '전이 생성하고 편집', exact: true }).click();
  await expect(sidebar(page)).toContainText('선택한 규칙 편집');
  await expect(field(page, '/definitions/0/rules/0')).toHaveCount(1);
  await expect(field(page, '/definitions/0/rules/0/fromStateId')).toHaveValue('Idle');
  await expect(field(page, '/definitions/0/rules/0/nextStateId')).toHaveValue('state_1');
  await sidebar(page).getByRole('button', { name: '조건 추가', exact: true }).click();
  await sidebar(page).getByRole('button', { name: '동작 추가', exact: true }).click();
  await field(page, '/definitions/0/rules/0/actions/0/kind').selectOption('finish');
  await expect(
    graph(page).getByRole('region', { name: '프로토콜 상태도 선택 규칙' }),
  ).toContainText('성공으로 종료');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await sidebar(page).screenshot({ path: info.outputPath('authoring-sidebar-390.png') });
  await graph(page).screenshot({ path: info.outputPath('authoring-graph-390.png') });
  await page.getByRole('button', { name: '전체 실행', exact: true }).click();
  await expect(page.getByText(/관찰 완료 · 가상 시간/)).toBeVisible();
  await expect(page.getByRole('region', { name: '참여자 A 상태' })).toContainText('state_1');
  await expect(page.getByRole('region', { name: '기대 조건 결과' })).toContainText('통과');
  await expect(tools(page)).toHaveCount(0);
  await page.getByRole('button', { name: '지금 저장', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '로컬 저장과 파일' }).getByRole('status'),
  ).toHaveText('브라우저에 저장됨');
  await page.reload();
  await view(page, '프로토콜');
  await expect(graph(page).getByRole('button', { name: /^상태 state_1/ })).toContainText(
    '완료 지점',
  );
  await expect(field(page, '/definitions/0/rules/0/actions/0/kind')).toHaveValue('finish');
});

test('keyboard selection supports explicit self loops and Escape/cancel never change the draft', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await load(page);
  await tools(page).getByRole('button', { name: '전이 연결 시작', exact: true }).click();
  await chooseState(page, 'Idle', 'Enter');
  await chooseState(page, 'Idle', 'Space');
  await expect(graph(page).locator('.is-connection-from.is-connection-to')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(
    tools(page).getByRole('button', { name: '전이 생성하고 편집', exact: true }),
  ).toHaveCount(0);
  await expect(graph(page)).toContainText('정의 v1');
  await connect(page, 'Idle', 'Idle');
  await tools(page)
    .getByRole('combobox', { name: '연결 발생 이벤트', exact: true })
    .selectOption('receive');
  await tools(page)
    .getByRole('combobox', { name: '연결 이벤트 메시지', exact: true })
    .selectOption('pong');
  await expect(tools(page)).toContainText('명시적으로 무시');
  await tools(page).getByRole('button', { name: '전이 생성하고 편집', exact: true }).click();
  await expect(field(page, '/definitions/0/rules/5/ignore')).toBeChecked();
  await expect(
    graph(page).getByRole('region', { name: '프로토콜 상태도 선택 규칙' }),
  ).toContainText('명시적 무시');
  await expect(field(page, '/definitions/0/rules/5')).toHaveCount(1);
  await sidebar(page).screenshot({ path: info.outputPath('authoring-sidebar-desktop.png') });
  await sidebar(page).getByRole('button', { name: '전체 목록에서 편집', exact: true }).click();
  await expect(sidebar(page)).toHaveCount(0);
  await expect(field(page, '/definitions/0/rules/5')).toBeFocused();
  await expect(field(page, '/definitions/0/rules/5/ignore')).toHaveCount(1);
  await graph(page).screenshot({ path: info.outputPath('authoring-self-loop.png') });
});

test('creating a state while a live run is pending pauses it and preserves its captured definition', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-11-03T00:00:00Z') });
  await page.goto('/');
  await page.clock.pauseAt(new Date('2026-11-03T01:00:00Z'));
  await page.getByRole('button', { name: '한 단계', exact: true }).click();
  await page.getByRole('button', { name: '전체 실행', exact: true }).click();
  await view(page, '프로토콜');
  await tools(page).getByRole('button', { name: '그림에 상태 추가', exact: true }).click();
  await expect(page.getByRole('button', { name: '일시 정지', exact: true })).toBeDisabled();
  await view(page, '실행');
  const paused = await page.getByText(/일시 정지 · 가상 시간/).textContent();
  await page.clock.runFor(200);
  await expect(page.getByText(/일시 정지 · 가상 시간/)).toHaveText(paused ?? '');
  await expect(page.getByText(/초안 변경됨/)).toBeVisible();
  await page.locator('summary').filter({ hasText: '실행 상태도 보기' }).click();
  const captured = page.getByRole('region', { name: '참여자 A 실행 상태도', exact: true });
  await expect(captured.getByRole('button', { name: /^상태 state_1/ })).toHaveCount(0);
  await expect(captured.locator('.diagram-node.is-current')).toContainText('Waiting');
});

test('parallel trigger conflicts are visible editable drafts and incomplete JSON survives form relocation and appends', async ({
  page,
}) => {
  await load(page);
  await connect(page, 'Idle', 'Done');
  await tools(page)
    .getByRole('combobox', { name: '연결 발생 이벤트', exact: true })
    .selectOption('input');
  await expect(tools(page)).toContainText('같은 출발 상태·이벤트');
  await tools(page).getByRole('button', { name: '전이 생성하고 편집', exact: true }).click();
  await expect(sidebar(page).getByRole('region', { name: '선택 항목 진단' })).toContainText(
    'rule-conflict',
  );
  await expect(page.getByRole('button', { name: '전체 실행', exact: true })).toBeDisabled();
  await field(page, '/definitions/0/rules/5/event/messageId').selectOption('pong');
  await expect(page.getByRole('button', { name: '전체 실행', exact: true })).toBeEnabled();
  await graph(page)
    .getByRole('combobox', { name: '프로토콜 상태도 규칙 선택', exact: true })
    .selectOption('0');
  await sidebar(page).getByRole('button', { name: '조건 추가', exact: true }).click();
  const path = '/definitions/0/rules/0/condition/left/value';
  await field(page, path).fill('{unfinished');
  await tools(page).getByRole('button', { name: '그림에 상태 추가', exact: true }).click();
  await expect(field(page, path)).toHaveCount(1);
  await expect(field(page, path)).toHaveValue('{unfinished');
  await graph(page)
    .getByRole('combobox', { name: '프로토콜 상태도 규칙 선택', exact: true })
    .selectOption('0');
  await expect(sidebar(page).locator(`[data-path="${path}"]`)).toHaveValue('{unfinished');
  await expect(page.getByRole('button', { name: '전체 실행', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '지금 저장', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '로컬 저장과 파일' }).getByRole('status'),
  ).toHaveText('브라우저에 저장됨');
  await page.reload();
  await view(page, '프로토콜');
  await expect(field(page, path)).toHaveValue('{unfinished');
  await expect(graph(page).getByRole('button', { name: /^상태 state_1/ })).toBeAttached();
});

test('duplicate or dangling state IDs cannot be endpoints and editing during connection invalidates the selection', async ({
  page,
}) => {
  await load(page);
  await field(page, '/definitions/0/states/1/id').fill('Idle');
  await tools(page).getByRole('button', { name: '전이 연결 시작', exact: true }).click();
  await graph(page).locator('[data-state-index="0"]').locator('rect').first().click();
  await expect(page.getByRole('alert')).toContainText('유일한 ID');
  await expect(
    tools(page).getByRole('combobox', { name: '연결 출발 상태', exact: true }),
  ).toHaveValue('');
  await expect(
    tools(page).getByRole('button', { name: '전이 생성하고 편집', exact: true }),
  ).toBeDisabled();
  await field(page, '/definitions/0/states/1/id').fill('Renamed');
  await expect(tools(page)).toContainText('정의가 변경되어');
  await expect(
    tools(page).getByRole('button', { name: '전이 생성하고 편집', exact: true }),
  ).toHaveCount(0);
  await tools(page).getByRole('button', { name: '전이 연결 시작', exact: true }).click();
  await graph(page)
    .getByRole('button', { name: /^상태 Waiting.*없는 상태 참조/ })
    .locator('rect')
    .first()
    .click();
  await expect(
    tools(page).getByRole('combobox', { name: '연결 출발 상태', exact: true }),
  ).toHaveValue('');
  await tools(page).getByRole('button', { name: '연결 취소', exact: true }).click();
});

test('new states and transitions open the right pages while maintaining graph zoom', async ({
  page,
}) => {
  const base = getExampleOriginal('ping_pong');
  const protocol = base.definitions[0];
  if (!protocol) throw new Error('Missing protocol');
  await load(page, {
    ...base,
    definitions: [
      {
        ...protocol,
        states: [
          ...protocol.states,
          ...Array.from({ length: 50 }, (_, index) => ({
            id: `spare_${index}`,
            label: `추가 ${index}`,
          })),
        ],
        rules: [
          ...protocol.rules,
          ...Array.from({ length: 25 }, (_, index) => ({
            id: `unused_${index}`,
            fromStateId: `spare_${index}`,
            nextStateId: `spare_${index}`,
            event: { kind: 'input' as const, messageId: 'ping' },
            actions: [],
            ignore: true,
          })),
        ],
      },
    ],
  });
  await graph(page)
    .getByRole('combobox', { name: '프로토콜 상태도 크기', exact: true })
    .selectOption('1.25');
  await tools(page).getByRole('button', { name: '그림에 상태 추가', exact: true }).click();
  await expect(graph(page)).toContainText('상태 2/2');
  await expect(graph(page).getByRole('button', { name: /^상태 state_1/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    graph(page).getByRole('combobox', { name: '프로토콜 상태도 크기', exact: true }),
  ).toHaveValue('1.25');
  await connect(page, 'Idle', 'state_1');
  await tools(page)
    .getByRole('combobox', { name: '연결 발생 이벤트', exact: true })
    .selectOption('timer');
  await tools(page).getByRole('button', { name: '전이 생성하고 편집', exact: true }).click();
  await expect(graph(page)).toContainText('규칙 2/2');
  await expect(
    graph(page).getByRole('combobox', { name: '프로토콜 상태도 규칙 선택', exact: true }),
  ).toHaveValue('30');
  await expect(field(page, '/definitions/0/rules/30/event/timerId')).toHaveValue('response');
  expect(await graph(page).locator('.diagram-node').count()).toBeLessThanOrEqual(85);
  expect(await graph(page).locator('.diagram-edge').count()).toBeLessThanOrEqual(20);
});

test('definition changes reset connection mode and diagram edits preserve the frozen TCP execution', async ({
  page,
}) => {
  await load(page, getExampleOriginal('tcp_handshake'));
  await page.getByRole('button', { name: '전체 실행', exact: true }).click();
  await expect(page.getByText(/관찰 완료 · 가상 시간/)).toBeVisible();
  await view(page, '프로토콜');
  await tools(page).getByRole('button', { name: '전이 연결 시작', exact: true }).click();
  await page.getByRole('combobox', { name: '편집할 정의', exact: true }).selectOption('1');
  await expect(
    tools(page).getByRole('button', { name: '전이 연결 시작', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await tools(page).getByRole('button', { name: '그림에 상태 추가', exact: true }).click();
  await expect(sidebar(page)).toContainText('state_1');
  await expect(graph(page)).toContainText('일치하는 실행 표시 없음');
  await view(page, '실행');
  await page.locator('summary').filter({ hasText: '실행 상태도 보기' }).click();
  await page.getByRole('button', { name: '참여자 B 상태도', exact: true }).click();
  const captured = page.getByRole('region', { name: '참여자 B 실행 상태도', exact: true });
  await expect(captured.locator('.diagram-node.is-current')).toContainText('ESTABLISHED');
  await expect(captured.getByRole('button', { name: /^상태 state_1/ })).toHaveCount(0);
  await expect(
    captured.getByRole('button', { name: '규칙 편집 위치로 이동', exact: true }),
  ).toBeDisabled();
  await expect(tools(page)).toHaveCount(0);
  await expect(sidebar(page)).toHaveCount(0);
});
