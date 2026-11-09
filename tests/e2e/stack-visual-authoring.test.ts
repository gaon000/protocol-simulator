import { expect, type Page, test } from '@playwright/test';
import type { WorkspaceV2, WorkspaceV2Envelope } from '../../src/domain/workspace-v2-model.ts';
import { createWorkspace } from '../../src/application/workspace-operations.ts';
import { createWorkspaceV2 } from '../../src/application/workspace-v2-operations.ts';
import { createStackExampleCopy } from '../../src/examples/reliable-stack-examples.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';
import { stackProtocolBody } from '../../src/domain/stack-model.ts';
import { stackVisualWorkspace } from '../fixtures/stack-visual-authoring.ts';
import { largeStackEvents } from '../fixtures/large-stacks.ts';

function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture value');
  return value;
}
const graph = (page: Page) => page.getByRole('region', { name: '스택 초안 상태도', exact: true });
const tools = (page: Page) =>
  page.getByRole('group', { name: '스택 상태도 작성 도구', exact: true });
const sidebar = (page: Page) =>
  page.getByRole('region', { name: '스택 상태도 선택 편집기', exact: true });
const setting = (page: Page, path: string) => page.locator(`[data-stack-path="${path}"]`);
async function tab(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: '스택 작업' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function protocol(page: Page, target = 'A/app') {
  await tab(page, '편집');
  await page.getByRole('tab', { name: '프로토콜 정의', exact: true }).click();
  await page.getByRole('combobox', { name: '편집할 인스턴스', exact: true }).selectOption(target);
}
async function openGraph(page: Page) {
  const details = page.locator('.stack-visual-details');
  if (!(await details.evaluate((e) => (e as HTMLDetailsElement).open)))
    await details.locator('summary').first().click();
  await expect(graph(page)).toBeVisible();
}
async function load(page: Page, data: unknown = stackVisualWorkspace()) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '계층 연결 스택', exact: true })).toBeEnabled();
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'visual.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ schemaVersion: 2, kind: 'protocol-studio-bundle', data })),
  });
  await expect(page.getByText(/검증한 bundle을 적용/)).toBeVisible();
  await expect(page.getByLabel('bundle 가져오기', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '계층 연결 스택', exact: true }).click();
  await protocol(page);
  await openGraph(page);
}
async function save(page: Page) {
  await page.getByRole('button', { name: '지금 저장', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '로컬 저장과 파일' }).getByRole('status'),
  ).toHaveText('브라우저에 저장됨');
}
async function stored(page: Page): Promise<WorkspaceV2Envelope> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('protocol-studio', 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('workspace-v2', 'readonly');
          const get = tx.objectStore('workspace-v2').get('current');
          tx.oncomplete = () => {
            db.close();
            resolve(get.result);
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
  );
}
async function active(page: Page) {
  const data = (await stored(page)).data.stack;
  const draft = data.drafts.find((d) => d.id === data.activeDraftId);
  if (!draft) throw new Error('Missing active draft');
  return draft;
}
async function node(page: Page, id: string, key?: 'Enter' | 'Space') {
  const button = graph(page).getByRole('button', { name: new RegExp(`^상태 ${id} ·`) });
  if (key) {
    await button.focus();
    await button.press(key);
  } else await button.locator('rect').first().click();
}
async function connect(page: Page, from: string, to: string, kind = 'input') {
  await tools(page).getByRole('button', { name: '전이 연결 시작', exact: true }).click();
  await node(page, from, 'Enter');
  await node(page, to, 'Space');
  await tools(page)
    .getByRole('combobox', { name: '연결 발생 이벤트', exact: true })
    .selectOption(kind);
}

for (const width of [1440, 768, 390])
  test(`draws and edits a real native transition, undoes it and restores frozen history at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await load(page);
    await graph(page)
      .getByRole('combobox', { name: '스택 초안 상태도 크기', exact: true })
      .selectOption('1');
    await tools(page).getByRole('button', { name: '그림에 상태 추가', exact: true }).click();
    await expect(
      sidebar(page).getByRole('textbox', { name: '상태 이름', exact: true }),
    ).toBeFocused();
    await sidebar(page).getByRole('textbox', { name: '상태 이름', exact: true }).fill('도착 상태');
    await sidebar(page).getByRole('checkbox', { name: '종료 상태', exact: true }).check();
    await expect(setting(page, '/definitions/0/states/1/label')).toHaveCount(1);
    await expect(
      graph(page).getByRole('combobox', { name: '스택 초안 상태도 크기', exact: true }),
    ).toHaveValue('1');
    await connect(page, 'Ready', 'state_1');
    await expect(
      tools(page).getByRole('button', { name: '전이 생성하고 편집', exact: true }),
    ).toBeEnabled();
    await tools(page).getByRole('button', { name: '전이 생성하고 편집', exact: true }).click();
    await expect(setting(page, '/definitions/0/rules/0/id')).toHaveCount(1);
    const form = sidebar(page).getByRole('region', { name: '선택 규칙 폼', exact: true });
    await form.getByRole('button', { name: '비교 조건 추가', exact: true }).click();
    await form
      .getByRole('combobox', { name: '추가할 동작 종류', exact: true })
      .selectOption('finish');
    await form.getByRole('button', { name: '선택 동작 추가', exact: true }).click();
    await expect(sidebar(page)).toContainText('인스턴스 완료');
    await graph(page).evaluate((e) => e.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: info.outputPath('stack-visual-graph.png') });
    await sidebar(page).evaluate((e) => {
      e.scrollTop = 0;
      e.scrollIntoView({ block: 'start' });
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath('stack-visual-editor.png') });
    await page.getByRole('button', { name: '새 스택 전체 실행', exact: true }).click();
    await tab(page, '실행');
    await expect(page.locator('.stack-run-summary')).toContainText('completed');
    await expect(page.getByRole('region', { name: '스택 기대 조건', exact: true })).toContainText(
      'pass',
    );
    await expect(page.getByRole('button', { name: '그림에 상태 추가', exact: true })).toHaveCount(
      0,
    );
    await save(page);
    const runs = (await stored(page)).data.stack.runs;
    expect(
      runs
        .at(-1)
        ?.view.events.some((e) => e.kind === 'transition' && e.endpoint.instanceId === 'app'),
    ).toBe(true);
    await protocol(page);
    await openGraph(page);
    await graph(page)
      .getByRole('combobox', { name: '스택 초안 상태도 규칙 선택', exact: true })
      .selectOption('0');
    await sidebar(page).locator('summary').filter({ hasText: '규칙 JSON 편집' }).click();
    const json = sidebar(page).getByRole('textbox', {
      name: '입력·수신·타이머·포트 이벤트 JSON',
      exact: true,
    });
    const original = await json.inputValue();
    await json.fill('{');
    await page.getByRole('button', { name: '편집 되돌리기', exact: true }).click();
    await expect(json).toHaveValue(original);
    await save(page);
    expect((await stored(page)).data.stack.runs).toEqual(runs);
    await page.reload();
    await protocol(page);
    await openGraph(page);
    await expect(
      graph(page).getByRole('button', { name: /^상태 state_1 · 도착 상태/ }),
    ).toBeVisible();
    await save(page);
    expect((await stored(page)).data.stack.runs).toEqual(runs);
  });

test('cancel, stale revision and endpoint switching never commit a staged connection; shared native definitions stay exact', async ({
  page,
}) => {
  await load(page);
  await tools(page).getByRole('button', { name: '그림에 상태 추가', exact: true }).click();
  await connect(page, 'Ready', 'state_1');
  await graph(page).getByRole('combobox', { name: '스택 초안 상태도 크기', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(
    tools(page).getByRole('button', { name: '전이 생성하고 편집', exact: true }),
  ).toHaveCount(0);
  await connect(page, 'Ready', 'state_1');
  await setting(page, '/definitions/0/label').fill('편집으로 연결 취소');
  await expect(tools(page)).toContainText('초안이 변경되어 연결 선택을 초기화');
  await expect(
    tools(page).getByRole('button', { name: '전이 생성하고 편집', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('combobox', { name: '편집할 인스턴스', exact: true }).selectOption('B/app');
  await expect(graph(page).getByRole('button', { name: /^상태 state_1 ·/ })).toBeVisible();
  await expect(sidebar(page)).toHaveCount(0);
  await node(page, 'state_1');
  await sidebar(page).getByRole('textbox', { name: '상태 이름', exact: true }).fill('공유 상태');
  await save(page);
  const draft = await active(page);
  expect(draft.configuration.nodes.A.instances[0]?.definition).toEqual(
    draft.configuration.nodes.B.instances[0]?.definition,
  );
  expect(stackProtocolBody(need(draft.configuration.definitions[0])).rules).toHaveLength(0);
  await page.getByRole('button', { name: '편집 되돌리기', exact: true }).click();
  await page.getByRole('button', { name: '편집 되돌리기', exact: true }).click();
  await page.getByRole('button', { name: '편집 되돌리기', exact: true }).click();
  await expect(graph(page).getByRole('button', { name: /^상태 state_1 ·/ })).toHaveCount(0);
  await page.getByRole('button', { name: '편집 다시 하기', exact: true }).click();
  await expect(graph(page).getByRole('button', { name: /^상태 state_1 ·/ })).toBeVisible();
});

test('native service events, self loops and parallel triggers retain their actual contract and selected rule form', async ({
  page,
}) => {
  await load(page);
  await page
    .getByRole('combobox', { name: '편집할 인스턴스', exact: true })
    .selectOption('A/transport');
  const states = graph(page).locator('[data-state-index]');
  const id = await states.first().getAttribute('data-state-index');
  expect(id).toBe('0');
  await tools(page).getByRole('button', { name: '전이 연결 시작', exact: true }).click();
  await tools(page)
    .getByRole('combobox', { name: '연결 출발 상태', exact: true })
    .selectOption('0');
  await tools(page)
    .getByRole('combobox', { name: '연결 도착 상태', exact: true })
    .selectOption('0');
  await tools(page)
    .getByRole('combobox', { name: '연결 발생 이벤트', exact: true })
    .selectOption('service-request');
  await expect(
    tools(page).getByRole('combobox', { name: '연결 이벤트 참조', exact: true }),
  ).toContainText('상위 요청 upper · write');
  await expect(tools(page)).toContainText('자기 전이');
  await expect(tools(page)).toContainText('같은 출발 상태·이벤트');
  await tools(page).getByRole('button', { name: '전이 생성하고 편집', exact: true }).click();
  await expect(
    sidebar(page).getByRole('checkbox', { name: '명시적 무시', exact: true }),
  ).toBeChecked();
  await expect(
    sidebar(page).getByRole('combobox', { name: '서비스 이벤트 동작', exact: true }),
  ).toHaveValue('write');
  await expect(page.getByRole('button', { name: '새 스택 전체 실행', exact: true })).toBeDisabled();
  await sidebar(page).getByRole('button', { name: '전체 목록에서 편집', exact: true }).click();
  await expect(sidebar(page)).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '서비스 이벤트 동작', exact: true })).toHaveValue(
    'write',
  );
  await save(page);
  const draft = await active(page);
  const last = stackProtocolBody(need(draft.configuration.definitions[1])).rules.at(-1);
  expect(last?.event).toEqual({ kind: 'service-request', portId: 'upper', operation: 'write' });
  expect(last?.actions).toEqual([]);
});

test('pending parent JSON blocks creation, survives reload, and is repaired only through the original path', async ({
  page,
}) => {
  const data = stackVisualWorkspace();
  const draft = need(data.stack.drafts[0]);
  const input: WorkspaceV2 = {
    ...data,
    stack: { ...data.stack, drafts: [{ ...draft, raw: { '/definitions/0/rules': '{pending' } }] },
  };
  await load(page, input);
  const raw = page.getByRole('textbox', {
    name: '상태도 미완성 JSON 수정 · /definitions/0/rules',
    exact: true,
  });
  await expect(raw).toHaveValue('{pending');
  await expect(
    tools(page).getByRole('button', { name: '전이 연결 시작', exact: true }),
  ).toBeDisabled();
  await tools(page).getByRole('button', { name: '그림에 상태 추가', exact: true }).click();
  await save(page);
  expect((await active(page)).raw['/definitions/0/rules']).toBe('{pending');
  await page.reload();
  await protocol(page);
  await openGraph(page);
  await expect(raw).toHaveValue('{pending');
  await raw.fill('[]');
  await expect(
    tools(page).getByRole('button', { name: '전이 연결 시작', exact: true }),
  ).toBeEnabled();
  await save(page);
  expect((await active(page)).raw['/definitions/0/rules']).toBeUndefined();
});

test('legacy source forms and late graph pages preserve one editor, zoom and declared trigger language', async ({
  page,
}) => {
  const data = createWorkspaceV2(
    createWorkspace(createPingPongExperiment()),
    createStackExampleCopy('stack_ping_pong'),
  );
  await load(page, data);
  await tools(page).getByRole('button', { name: '그림에 상태 추가', exact: true }).click();
  await expect(setting(page, '/definitions/0/source/states/3/label')).toHaveCount(1);
  await tools(page).getByRole('button', { name: '전이 연결 시작', exact: true }).click();
  await expect(
    tools(page)
      .getByRole('combobox', { name: '연결 발생 이벤트', exact: true })
      .getByRole('option', { name: '상위 포트 요청', exact: true }),
  ).toHaveAttribute('disabled', '');
  await tools(page).getByRole('button', { name: '연결 취소', exact: true }).click();
  await save(page);
  const legacy = (await active(page)).configuration.definitions[0];
  expect(legacy?.mode).toBe('legacy-application');
  if (legacy?.mode === 'legacy-application') expect(legacy.revision).toBe(legacy.source.revision);
  await load(page, stackVisualWorkspace(true));
  await tools(page).getByRole('button', { name: '그림에 상태 추가', exact: true }).click();
  await expect(graph(page)).toContainText('상태 4/4');
  await sidebar(page)
    .getByRole('textbox', { name: '상태 이름', exact: true })
    .fill('마지막 페이지');
  await tools(page).getByRole('button', { name: '전이 연결 시작', exact: true }).click();
  await graph(page).getByRole('button', { name: '상태 이전 페이지', exact: true }).click();
  await expect(tools(page)).toContainText('출발 상태를 선택하세요.');
  await tools(page)
    .getByRole('textbox', { name: '연결 출발 상태 검색', exact: true })
    .fill('s_124');
  await tools(page)
    .getByRole('combobox', { name: '연결 출발 상태', exact: true })
    .selectOption('124');
  await tools(page)
    .getByRole('textbox', { name: '연결 도착 상태 검색', exact: true })
    .fill('state_1');
  await tools(page)
    .getByRole('combobox', { name: '연결 도착 상태', exact: true })
    .selectOption('125');
  await tools(page)
    .getByRole('combobox', { name: '연결 발생 이벤트', exact: true })
    .selectOption('input');
  await tools(page).getByRole('button', { name: '전이 생성하고 편집', exact: true }).click();
  await expect(graph(page)).toContainText('규칙 31/31');
  await expect(setting(page, '/definitions/0/rules/605/id')).toHaveCount(1);
  await sidebar(page).getByRole('textbox', { name: '규칙 ID', exact: true }).fill('late_rule');
  await expect(sidebar(page)).toBeVisible();
  await save(page);
  expect(
    stackProtocolBody(need((await active(page)).configuration.definitions[0])).rules.at(-1)?.id,
  ).toBe('late_rule');
});

test('pending state text is repaired in its real selected form before it can become an endpoint', async ({
  page,
}) => {
  const data = stackVisualWorkspace();
  const draft = need(data.stack.drafts[0]);
  const state = stackProtocolBody(need(draft.configuration.definitions[0])).states[0];
  await load(page, {
    ...data,
    stack: {
      ...data.stack,
      drafts: [{ ...draft, raw: { '/definitions/0/states/0': '{pending state' } }],
    },
  });
  await node(page, 'Ready');
  const raw = sidebar(page).getByRole('textbox', { name: '미완성 상태 JSON 수정', exact: true });
  await expect(raw).toHaveValue('{pending state');
  await expect(sidebar(page).getByRole('textbox', { name: '상태 ID', exact: true })).toBeDisabled();
  await tools(page).getByRole('button', { name: '전이 연결 시작', exact: true }).click();
  await node(page, 'Ready');
  await node(page, 'Ready');
  await tools(page)
    .getByRole('combobox', { name: '연결 발생 이벤트', exact: true })
    .selectOption('input');
  await expect(
    tools(page).getByRole('button', { name: '전이 생성하고 편집', exact: true }),
  ).toBeDisabled();
  await expect(tools(page)).toContainText('선택한 선언의 미완성 입력');
  await tools(page).getByRole('button', { name: '연결 취소', exact: true }).click();
  await raw.fill(JSON.stringify(state));
  await expect(sidebar(page)).toHaveCount(0);
  await node(page, 'Ready');
  await expect(sidebar(page).getByRole('textbox', { name: '상태 ID', exact: true })).toBeEnabled();
  await connect(page, 'Ready', 'Ready');
  await expect(
    tools(page).getByRole('button', { name: '전이 생성하고 편집', exact: true }),
  ).toBeEnabled();
  await save(page);
  expect((await active(page)).raw['/definitions/0/states/0']).toBeUndefined();
});

test('adding a drawn state pauses a live run and checkpoints its original frozen definition', async ({
  page,
}) => {
  await load(
    page,
    createWorkspaceV2(createWorkspace(createPingPongExperiment()), largeStackEvents()),
  );
  await page.getByRole('button', { name: '새 스택 전체 실행', exact: true }).click();
  await expect(page.getByRole('button', { name: '스택 일시 정지', exact: true })).toBeEnabled();
  await tools(page).getByRole('button', { name: '그림에 상태 추가', exact: true }).click();
  await expect(page.getByRole('button', { name: '스택 계속', exact: true })).toBeEnabled();
  await expect(sidebar(page).getByRole('textbox', { name: '상태 이름', exact: true })).toHaveValue(
    '새 상태',
  );
  await page.getByRole('button', { name: '단일 계층', exact: true }).click();
  await save(page);
  const saved = (await stored(page)).data.stack;
  const run = saved.runs.at(-1);
  expect(run?.view.status).toBe('cancelled');
  const current = need(saved.drafts.find((d) => d.id === saved.activeDraftId));
  const before = need(run?.view.snapshot.configuration.definitions[0]);
  const after = need(current.configuration.definitions[0]);
  expect(stackProtocolBody(after).states.length).toBe(stackProtocolBody(before).states.length + 1);
  expect(after.revision).toBeGreaterThan(before.revision);
  expect(run?.view.events.length).toBeGreaterThan(0);
  expect(run?.view.events.length).toBeLessThan(10000);
});

test('unknown and malformed native expressions remain readable and unchanged in the diagram and selected form', async ({
  page,
}) => {
  const data = stackVisualWorkspace();
  const draft = need(data.stack.drafts[0]);
  const p = need(draft.configuration.definitions[0]);
  if (p.mode !== 'stack-protocol') throw new Error('Missing native application');
  const unknown = { kind: 'future-node', payload: { keep: false } };
  const actions = [{ kind: 'assign', variableId: 'unknown_variable', value: unknown }];
  const condition = {
    kind: 'compare',
    operator: 'eq',
    left: null,
    right: { kind: 'concat', values: [unknown, 0, false] },
  };
  // Native draft storage preserves unvalidated expression JSON for later repair.
  const configuration = {
    ...draft.configuration,
    definitions: [
      {
        ...p,
        rules: [
          {
            id: 'unknown_rule',
            fromStateId: 'Ready',
            nextStateId: 'Ready',
            event: { kind: 'input', messageId: 'message' },
            condition,
            actions,
          },
        ],
      },
      ...draft.configuration.definitions.slice(1),
    ],
  };
  await load(page, { ...data, stack: { ...data.stack, drafts: [{ ...draft, configuration }] } });
  await expect(graph(page)).toContainText('미지원 식');
  await graph(page)
    .getByRole('combobox', { name: '스택 초안 상태도 규칙 선택', exact: true })
    .selectOption('0');
  await expect(sidebar(page)).toBeVisible();
  await setting(page, '/definitions/0/label').fill('원본 표현식 보존');
  await expect(graph(page)).toContainText('미지원 식');
  await expect(page.getByRole('button', { name: '새 스택 전체 실행', exact: true })).toBeDisabled();
  await save(page);
  const saved = stackProtocolBody(need((await active(page)).configuration.definitions[0]));
  expect(saved.rules[0]?.actions).toEqual(actions);
  expect(saved.rules[0]?.condition).toEqual(condition);
});
