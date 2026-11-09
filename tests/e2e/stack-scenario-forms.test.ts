import { expect, type Page, test } from '@playwright/test';
import type { WorkspaceV2Envelope } from '../../src/domain/workspace-v2-model.ts';
import { stackScenarioWorkspace } from '../fixtures/stack-scenario-forms.ts';
import { createStackExampleCopy } from '../../src/examples/reliable-stack-examples.ts';
import { createWorkspaceV2 } from '../../src/application/workspace-v2-operations.ts';
import { createWorkspace } from '../../src/application/workspace-operations.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';

const form = (page: Page) => page.getByRole('region', { name: '스택 시나리오 폼', exact: true });
const item = (page: Page) => page.getByRole('region', { name: '선택 시나리오 항목', exact: true });
async function tab(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: '스택 작업' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function scenario(page: Page) {
  await tab(page, '편집');
  await page.getByRole('tab', { name: '입력·기대 조건', exact: true }).click();
  await expect(form(page)).toBeVisible();
}
async function load(page: Page, data = stackScenarioWorkspace()) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '계층 연결 스택', exact: true })).toBeEnabled();
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'scenario.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ schemaVersion: 2, kind: 'protocol-studio-bundle', data })),
  });
  await expect(page.getByText(/검증한 bundle을 적용/)).toBeVisible();
  await expect(page.getByLabel('bundle 가져오기', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '계층 연결 스택', exact: true }).click();
  await scenario(page);
}
async function select(page: Page, collection: '입력' | '기대 조건', index: number) {
  await form(page)
    .getByRole('button', { name: new RegExp(`^${collection} 편집 · ${index + 1} ·`) })
    .click();
}
async function field(page: Page, id: string) {
  const button = item(page).getByRole('button', { name: new RegExp(`^필드 편집 · ${id} ·`) });
  await button.focus();
  await button.press('Enter');
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
        const open = indexedDB.open('protocol-studio', 2);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction('workspace-v2', 'readonly');
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
async function run(page: Page) {
  await expect(page.getByRole('button', { name: '새 스택 전체 실행', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '새 스택 전체 실행', exact: true }).click();
  await tab(page, '실행');
  await expect(page.locator('.stack-run-summary')).toContainText('completed');
  await save(page);
}

for (const width of [1440, 768, 390])
  test(`typed scenario authoring executes, undoes and preserves native stored snapshots at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 950 });
    await load(page);
    await field(page, 'text');
    await item(page).getByLabel('필드 값', { exact: true }).fill('폼 입력\n둘째 줄');
    await field(page, 'count');
    await item(page).getByLabel('필드 값', { exact: true }).fill('0');
    await field(page, 'flag');
    await item(page).getByLabel('필드 값', { exact: true }).selectOption('false');
    await item(page).getByLabel('필드 값 포함', { exact: true }).uncheck();
    await expect(item(page)).toContainText('생략 시 기본값: false');
    await select(page, '기대 조건', 0);
    await field(page, 'text');
    await item(page).getByLabel('필드 값', { exact: true }).fill('폼 입력\n둘째 줄');
    await item(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('scenario-form.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await run(page);
    const before = (await stored(page)).data.stack.runs;
    expect(before.at(-1)?.view.expectations.every((e) => e.status === 'pass')).toBe(true);
    await scenario(page);
    await select(page, '입력', 0);
    await field(page, 'text');
    await item(page).getByLabel('필드 값', { exact: true }).fill('기록 이후');
    await page.getByRole('button', { name: '편집 되돌리기', exact: true }).click();
    await expect(item(page).getByLabel('필드 값', { exact: true })).toHaveValue('폼 입력\n둘째 줄');
    await page.getByRole('button', { name: '편집 다시 하기', exact: true }).click();
    await save(page);
    const after = await active(page);
    expect(after.configuration.scenario.inputs[0]?.message.values.text).toBe('기록 이후');
    expect((await stored(page)).data.stack.runs).toEqual(before);
    await page.reload();
    await expect(page.getByRole('button', { name: '계층 연결 스택', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '계층 연결 스택', exact: true }).click();
    await scenario(page);
    await field(page, 'text');
    await expect(item(page).getByLabel('필드 값', { exact: true })).toHaveValue('기록 이후');
    await item(page).getByLabel('입력 ID', { exact: true }).fill('renamed');
    await expect(item(page).getByLabel('입력 ID', { exact: true })).toBeFocused();
  });

test('all four expectation kinds expose actual target-specific policies and failure verdicts', async ({
  page,
}) => {
  await load(page);
  await select(page, '기대 조건', 0);
  await item(page).getByLabel('기대 종류', { exact: true }).selectOption('delivery-count');
  await item(page).getByLabel('기대 전달 횟수', { exact: true }).fill('2');
  await run(page);
  expect((await stored(page)).data.stack.runs.at(-1)?.view.expectations[0]?.status).toBe('fail');
  await scenario(page);
  await select(page, '기대 조건', 0);
  await item(page).getByLabel('기대 종류', { exact: true }).selectOption('state');
  await item(page).getByLabel('기대 대상', { exact: true }).selectOption('B/transport');
  await item(page).getByLabel('기대 상태', { exact: true }).selectOption('Ready');
  await run(page);
  expect((await stored(page)).data.stack.runs.at(-1)?.view.expectations[0]?.status).toBe('pass');
  await scenario(page);
  await select(page, '기대 조건', 0);
  await item(page).getByLabel('기대 종류', { exact: true }).selectOption('completion-before');
  await item(page).getByLabel('기대 대상', { exact: true }).selectOption('B/app');
  await item(page).getByLabel('성공 완료 기한 ms', { exact: true }).fill('0');
  await run(page);
  expect((await stored(page)).data.stack.runs.at(-1)?.view.expectations[0]?.status).toBe('fail');
  await scenario(page);
  await select(page, '기대 조건', 0);
  await item(page).getByLabel('기대 종류', { exact: true }).selectOption('delivered-values');
  await save(page);
  expect(
    Object.keys((await active(page)).configuration.scenario.expectations[0] ?? {}).sort(),
  ).toEqual(['id', 'kind', 'message', 'target']);
});

test('pending integer and hex edits survive reload and structural raw remapping without allowing destructive kind switches', async ({
  page,
}) => {
  await load(page, stackScenarioWorkspace(false, true));
  await field(page, 'bytes');
  await item(page).getByLabel('바이트 값 (hex · 최대 4096 bytes)', { exact: true }).fill('abc');
  await form(page).getByRole('button', { name: '입력 추가', exact: true }).click();
  await select(page, '입력', 0);
  await item(page).getByRole('button', { name: '입력 아래로', exact: true }).click();
  await save(page);
  expect((await active(page)).raw['/scenario/inputs/1/message/values/bytes']).toBe('hex:abc');
  await select(page, '기대 조건', 0);
  await item(page).getByLabel('기대 종류', { exact: true }).selectOption('delivery-count');
  await item(page).getByLabel('기대 전달 횟수', { exact: true }).fill('-');
  await expect(item(page).getByLabel('기대 종류', { exact: true })).toBeDisabled();
  await save(page);
  await page.reload();
  await expect(page.getByRole('button', { name: '계층 연결 스택', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '계층 연결 스택', exact: true }).click();
  await scenario(page);
  await select(page, '기대 조건', 0);
  await expect(item(page).getByLabel('기대 전달 횟수', { exact: true })).toHaveValue('-');
  await item(page).getByLabel('기대 전달 횟수', { exact: true }).fill('1');
  await expect(item(page).getByLabel('기대 종류', { exact: true })).toBeEnabled();
  await select(page, '입력', 1);
  await field(page, 'bytes');
  await expect(
    item(page).getByLabel('바이트 값 (hex · 최대 4096 bytes)', { exact: true }),
  ).toHaveValue('abc');
  await item(page).getByLabel('바이트 값 (hex · 최대 4096 bytes)', { exact: true }).fill('00 ff');
  await save(page);
  expect((await active(page)).configuration.scenario.inputs[1]?.message.values.bytes).toEqual({
    kind: 'bytes',
    encoding: 'base64',
    byteLength: 2,
    data: 'AP8=',
  });
});

test('advanced parent JSON blocks child forms and repairs the exact original path', async ({
  page,
}) => {
  const workspace = stackScenarioWorkspace();
  const draft = workspace.stack.drafts[0];
  if (!draft) throw new Error('Missing draft');
  const raw = {
    ...draft,
    raw: { '/scenario/inputs': '[', '/scenario/expectations/0/message/values/count': 'number:-' },
  };
  await load(page, { ...workspace, stack: { ...workspace.stack, drafts: [raw] } });
  await expect(form(page).getByLabel('미완성 시나리오 JSON 수정', { exact: true })).toHaveValue(
    '[',
  );
  await expect(form(page).getByRole('button', { name: '입력 추가', exact: true })).toHaveCount(0);
  await form(page)
    .getByLabel('미완성 시나리오 JSON 수정', { exact: true })
    .fill(JSON.stringify(draft.configuration.scenario.inputs));
  await select(page, '기대 조건', 0);
  await field(page, 'count');
  await expect(item(page).getByLabel('필드 값', { exact: true })).toHaveValue('-');
  await item(page).getByLabel('필드 값', { exact: true }).fill('0');
  await item(page).getByRole('button', { name: '메시지 JSON 편집', exact: true }).click();
  await item(page).getByLabel('입력·기대 메시지 JSON', { exact: true }).fill('{');
  await expect(item(page).getByLabel('미완성 시나리오 JSON 수정', { exact: true })).toHaveValue(
    '{',
  );
  await item(page)
    .getByLabel('미완성 시나리오 JSON 수정', { exact: true })
    .fill(JSON.stringify(draft.configuration.scenario.inputs[0]?.message));
  await save(page);
  expect((await active(page)).raw).toEqual({});
});

test('pending whole declarations and target child JSON never supply stale typed field defaults', async ({
  page,
}) => {
  const data = stackScenarioWorkspace();
  const draft = data.stack.drafts[0];
  if (!draft) throw new Error('Missing draft');
  await load(page, {
    ...data,
    stack: { ...data.stack, drafts: [{ ...draft, raw: { '/definitions/0/messages/0': '{' } }] },
  });
  await expect(item(page)).toContainText('메시지 정의에 미완성 입력');
  await expect(item(page).getByRole('button', { name: /^필드 편집 ·/ })).toHaveCount(0);
  await save(page);
  expect((await active(page)).raw['/definitions/0/messages/0']).toBe('{');
  await load(page, {
    ...data,
    stack: {
      ...data.stack,
      drafts: [{ ...draft, raw: { '/scenario/inputs/0/target/instanceId': '"broken' } }],
    },
  });
  await expect(item(page).getByLabel('미완성 시나리오 JSON 수정', { exact: true })).toHaveValue(
    '"broken',
  );
  await expect(item(page).getByRole('button', { name: /^필드 편집 ·/ })).toHaveCount(0);
  await item(page).getByLabel('미완성 시나리오 JSON 수정', { exact: true }).fill('"app"');
  await expect(item(page).getByRole('button', { name: /^필드 편집 · text ·/ })).toBeVisible();
  await save(page);
  expect((await active(page)).raw).toEqual({});
});

test('late-row diagnostics reveal the selected field while pages and all message choices stay bounded', async ({
  page,
}) => {
  const workspace = stackScenarioWorkspace(true);
  const draft = workspace.stack.drafts[0];
  if (!draft) throw new Error('Missing draft');
  const expectations = draft.configuration.scenario.expectations.map((e, i) =>
    i === 124 && e.kind === 'delivered-values'
      ? { ...e, message: { ...e.message, values: { ...e.message.values, extra_123: 42 } } }
      : e,
  );
  await load(page, {
    ...workspace,
    stack: {
      ...workspace.stack,
      drafts: [
        {
          ...draft,
          configuration: {
            ...draft.configuration,
            scenario: { ...draft.configuration.scenario, expectations },
          },
        },
      ],
    },
  });
  await page
    .getByRole('region', { name: '스택 정의 진단' })
    .getByRole('button', { name: /\/scenario\/expectations\/124\/message\/values\/extra_123/ })
    .click();
  await expect(item(page)).toContainText('기대 조건 125');
  await expect(item(page).getByLabel('필드 값 JSON', { exact: true })).toHaveValue('42');
  await expect(item(page).getByLabel('필드 값 JSON', { exact: true })).toBeFocused();
  expect(
    await form(page)
      .getByRole('button', { name: /^기대 조건 편집 ·/ })
      .count(),
  ).toBeLessThanOrEqual(10);
  expect(
    await item(page)
      .getByRole('button', { name: /^필드 편집 ·/ })
      .count(),
  ).toBeLessThanOrEqual(10);
  await item(page).getByLabel('시나리오 메시지 검색', { exact: true }).fill('other_124');
  await item(page).getByLabel('시나리오 메시지', { exact: true }).selectOption('other_124');
  await save(page);
  const saved = (await active(page)).configuration.scenario.expectations[124];
  expect(saved?.kind === 'delivered-values' && saved.message.values.extra_123).toBe(42);
});

test('missing message references and unknown escaped value keys stay recoverable without automatic deletion', async ({
  page,
}) => {
  const workspace = stackScenarioWorkspace();
  const draft = workspace.stack.drafts[0];
  if (!draft) throw new Error('Missing draft');
  const inputs = draft.configuration.scenario.inputs.map((i) => ({
    ...i,
    message: { messageId: 'absent', values: { ...i.message.values, 'unknown/key~x': '보존' } },
  }));
  await load(page, {
    ...workspace,
    stack: {
      ...workspace.stack,
      drafts: [
        {
          ...draft,
          configuration: {
            ...draft.configuration,
            scenario: { ...draft.configuration.scenario, inputs },
          },
        },
      ],
    },
  });
  await expect(item(page)).toContainText('참조가 없거나 중복');
  await item(page).getByLabel('시나리오 메시지', { exact: true }).selectOption('message');
  await field(page, 'unknown/key~x');
  await expect(item(page).getByLabel('정의에 없는 필드 값 JSON', { exact: true })).toHaveValue(
    '"보존"',
  );
  await save(page);
  expect(
    (await active(page)).configuration.scenario.inputs[0]?.message.values['unknown/key~x'],
  ).toBe('보존');
  await item(page).getByRole('button', { name: '정의에 없는 값 삭제', exact: true }).click();
  await save(page);
  expect(
    (await active(page)).configuration.scenario.inputs[0]?.message.values['unknown/key~x'],
  ).toBeUndefined();
});

test('form-authored scenario conditions capture into regression cases and frozen earlier runs remain unchanged', async ({
  page,
}) => {
  await load(page);
  await tab(page, '반복·회귀');
  await page.getByRole('button', { name: '현재 조건을 스택 사례로 추가', exact: true }).click();
  await page.getByRole('button', { name: '스택 회귀 검증 실행', exact: true }).click();
  await expect(page.locator('.stack-series-summary')).toContainText('묶음 종료');
  await expect(
    page.getByRole('button', { name: '스택 회귀 검증 실행', exact: true }),
  ).toBeEnabled();
  await save(page);
  const before = (await stored(page)).data.stack.runs;
  expect(before.length).toBeGreaterThan(0);
  await scenario(page);
  await select(page, '기대 조건', 0);
  await field(page, 'text');
  await item(page).getByLabel('필드 값', { exact: true }).fill('다른 기대');
  await tab(page, '반복·회귀');
  await page.getByRole('button', { name: '현재 조건을 스택 사례로 추가', exact: true }).click();
  await page.getByRole('button', { name: '스택 회귀 검증 실행', exact: true }).click();
  await expect(page.locator('.stack-series-summary')).toContainText('묶음 종료');
  await expect(
    page.getByRole('button', { name: '스택 회귀 검증 실행', exact: true }),
  ).toBeEnabled();
  await save(page);
  const data = (await stored(page)).data.stack;
  expect(data.runs.slice(0, before.length)).toEqual(before);
  expect(data.runs.some((r) => r.view.expectations.some((e) => e.status === 'fail'))).toBe(true);
});

test('legacy and raw CRLF strings preserve the original wire text through JSON and other form edits', async ({
  page,
}) => {
  const configuration = createStackExampleCopy('stack_http_post');
  await load(page, createWorkspaceV2(createWorkspace(createPingPongExperiment()), configuration));
  await expect(form(page)).toBeVisible();
  await save(page);
  const before = (await active(page)).configuration.scenario.inputs;
  await item(page).getByLabel('입력 시각 ms', { exact: true }).fill('1');
  await save(page);
  expect((await active(page)).configuration.scenario.inputs[0]?.message).toEqual(
    before[0]?.message,
  );
  const original = stackScenarioWorkspace();
  const draft = original.stack.drafts[0];
  if (!draft) throw new Error('Missing draft');
  const inputs = draft.configuration.scenario.inputs.map((i) => ({
    ...i,
    message: { ...i.message, values: { ...i.message.values, text: 'line\r\nnext\r\n' } },
  }));
  await load(page, {
    ...original,
    stack: {
      ...original.stack,
      drafts: [
        {
          ...draft,
          configuration: {
            ...draft.configuration,
            scenario: { ...draft.configuration.scenario, inputs },
          },
        },
      ],
    },
  });
  await expect(item(page).getByLabel('필드 값 JSON (CRLF는 \\r\\n)', { exact: true })).toHaveValue(
    '"line\\r\\nnext\\r\\n"',
  );
  await field(page, 'count');
  await item(page).getByLabel('필드 값', { exact: true }).fill('1');
  await save(page);
  expect((await active(page)).configuration.scenario.inputs[0]?.message.values.text).toBe(
    'line\r\nnext\r\n',
  );
});
