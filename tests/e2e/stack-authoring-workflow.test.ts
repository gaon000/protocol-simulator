import { expect, type Page, test } from '@playwright/test';
import { createNewStack, NEW_STACK_DEFAULTS } from '../../src/application/new-stack.ts';
import { createWorkspace } from '../../src/application/workspace-operations.ts';
import {
  createStackDraft,
  createWorkspaceV2,
} from '../../src/application/workspace-v2-operations.ts';
import type { WorkspaceV2, WorkspaceV2Envelope } from '../../src/domain/workspace-v2-model.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';

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
          const db = request.result,
            tx = db.transaction('workspace-v2', 'readonly'),
            get = tx.objectStore('workspace-v2').get('current');
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
async function stack(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '계층 연결 스택', exact: true }).click();
}
async function wizard(page: Page, transport = 'datagram', flow = 'one-way') {
  await page.getByRole('button', { name: '새 프로토콜 만들기', exact: true }).click();
  const form = page.getByRole('region', { name: '새 프로토콜 만들기', exact: true });
  await form.getByRole('combobox', { name: '전송 시작점', exact: true }).selectOption(transport);
  await form.getByRole('button', { name: '다음 단계', exact: true }).click();
  await form.getByRole('combobox', { name: '규칙 시작 방식', exact: true }).selectOption(flow);
  return form;
}
async function create(page: Page, transport = 'datagram', flow = 'one-way') {
  const form = await wizard(page, transport, flow);
  await form.getByRole('button', { name: '다음 단계', exact: true }).click();
  await form.getByRole('button', { name: '이 구성으로 스택 만들기', exact: true }).click();
  await expect(form).toHaveCount(0);
}
async function load(page: Page, data: WorkspaceV2) {
  await page.goto('/');
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'authoring.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ schemaVersion: 2, kind: 'protocol-studio-bundle', data })),
  });
  await expect(page.getByText(/검증한 bundle을 적용/)).toBeVisible();
  await page.getByRole('button', { name: '계층 연결 스택', exact: true }).click();
}
for (const width of [1440, 768, 390])
  test(`new stack authoring, review, actual delivery and native restore at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await stack(page);
    const form = await wizard(page, width === 768 ? 'datagram' : 'reliable-stream');
    await form.getByRole('textbox', { name: '첫 메시지 ID', exact: true }).fill('notice');
    await form.getByRole('textbox', { name: '문자열 필드 ID', exact: true }).fill('body');
    await form
      .getByRole('textbox', { name: '첫 입력 값', exact: true })
      .fill('직접 만든 메시지 📨');
    await form.getByRole('button', { name: '다음 단계', exact: true }).click();
    await expect(form).toContainText('notice / body');
    await form.evaluate((e) => e.scrollIntoView({ block: 'start' }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath('new-stack-review.png') });
    await form.getByRole('button', { name: '이 구성으로 스택 만들기', exact: true }).click();
    await expect(form).toHaveCount(0);
    await page.getByRole('button', { name: '새 스택 전체 실행', exact: true }).click();
    await tab(page, '실행');
    await expect(page.locator('.stack-run-summary')).toContainText('completed');
    await expect(page.getByRole('region', { name: '스택 기대 조건' })).toContainText('pass');
    await save(page);
    const before = (await stored(page)).data.stack;
    expect(
      before.runs
        .at(-1)
        ?.view.events.filter((e) => e.kind === 'deliver' && e.endpoint.participant === 'B'),
    ).toHaveLength(1);
    await page.reload();
    await protocol(page);
    const port = page.getByRole('region', { name: 'requires 포트 폼', exact: true });
    await port.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath('definition-forms.png') });
    expect((await active(page)).configuration.origin).toBeUndefined();
    expect((await stored(page)).data.stack.runs).toEqual(before.runs);
    await expect(page.getByRole('button', { name: '편집 되돌리기', exact: true })).toBeDisabled();
  });

test('invalid review and cancel preserve the current draft while empty rules create a saveable incomplete start', async ({
  page,
}) => {
  await stack(page);
  await create(page);
  await save(page);
  const before = (await stored(page)).data;
  await page.getByRole('button', { name: '새 프로토콜 만들기', exact: true }).click();
  const form = page.getByRole('region', { name: '새 프로토콜 만들기', exact: true });
  await form.getByRole('textbox', { name: '새 응용 프로토콜 ID', exact: true }).fill('bad/id');
  await form.getByRole('button', { name: '다음 단계', exact: true }).click();
  await form.getByRole('button', { name: '다음 단계', exact: true }).click();
  await expect(
    form.getByRole('button', { name: '이 구성으로 스택 만들기', exact: true }),
  ).toBeDisabled();
  await form.getByRole('button', { name: '만들기 취소', exact: true }).click();
  await save(page);
  expect((await stored(page)).data).toEqual(before);
  await create(page, 'datagram', 'empty');
  await protocol(page);
  await save(page);
  const blank = await active(page);
  expect(blank.configuration.scenario.inputs).toEqual([]);
  expect(blank.configuration.scenario.expectations).toEqual([]);
  await expect(page.getByRole('button', { name: '새 스택 전체 실행', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '규칙 추가', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '규칙 추가', exact: true }).click();
  await page.getByRole('button', { name: '규칙 추가', exact: true }).click();
  await expect(page.getByRole('region', { name: '스택 편집 이력' })).toContainText(
    '되돌리기 2개 · 다시 하기 0개',
  );
  await page.getByRole('button', { name: '편집 되돌리기', exact: true }).click();
  await save(page);
  const restored = (await active(page)).configuration.definitions[0];
  expect(restored?.mode === 'stack-protocol' && restored.rules.length).toBe(1);
});

test('undo/redo restores raw and structural edits, survives mode switches, forks and preserves frozen runs', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await stack(page);
  await page.getByRole('button', { name: 'stack_ping_pong 새 사본', exact: true }).click();
  await page.getByRole('button', { name: '새 스택 전체 실행', exact: true }).click();
  await tab(page, '실행');
  await expect(page.locator('.stack-run-summary')).toContainText('completed');
  await save(page);
  const runs = (await stored(page)).data.stack.runs;
  await protocol(page);
  const initial = '/definitions/0/source/variables/0/initial';
  await setting(page, initial).fill('-');
  await page.getByRole('button', { name: '타이머 추가', exact: true }).click();
  const undo = page.getByRole('button', { name: '편집 되돌리기', exact: true }),
    redo = page.getByRole('button', { name: '편집 다시 하기', exact: true });
  await undo.click();
  await expect(setting(page, initial)).toHaveValue('-');
  await undo.click();
  await expect(setting(page, initial)).toHaveValue('0');
  await redo.click();
  await expect(setting(page, initial)).toHaveValue('-');
  await page.getByRole('button', { name: '단일 계층', exact: true }).click();
  await page.getByRole('button', { name: '계층 연결 스택', exact: true }).click();
  await protocol(page);
  await expect(redo).toBeEnabled();
  await redo.click();
  await save(page);
  expect((await active(page)).raw[initial]).toBe('number:-');
  expect((await stored(page)).data.stack.runs).toEqual(runs);
  await setting(page, initial).fill('7');
  await expect(redo).toBeDisabled();
  await page.locator('#stack-main').focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(setting(page, initial)).toHaveValue('-');
  await redo.click();
  await expect(setting(page, initial)).toHaveValue('7');
  await setting(page, initial).focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(redo).toBeDisabled();
  await setting(page, initial).fill('7');
  await save(page);
  await page.reload();
  await protocol(page);
  await expect(setting(page, initial)).toHaveValue('7');
  await expect(undo).toBeDisabled();
  expect((await stored(page)).data.stack.runs).toEqual(runs);
});

test('port forms preserve references, diagnose incompatible operations, undo and retain parent JSON across reload', async ({
  page,
}) => {
  await stack(page);
  await page.getByRole('button', { name: 'stack_ping_pong 새 사본', exact: true }).click();
  await protocol(page, 'A/transport');
  const port = page.getByRole('region', { name: 'requires 포트 폼', exact: true });
  await port.getByRole('combobox', { name: '서비스 요청 동작', exact: true }).selectOption('write');
  await expect(page.getByRole('button', { name: '새 스택 전체 실행', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '편집 되돌리기', exact: true }).click();
  await expect(port.getByRole('combobox', { name: '서비스 요청 동작', exact: true })).toHaveValue(
    'send',
  );
  await port.locator('summary').click();
  const json = port.getByRole('textbox', { name: 'requires 포트 계약 JSON', exact: true });
  const original = await json.inputValue();
  await json.fill('{');
  await expect(port.getByRole('textbox', { name: '포트 ID', exact: true })).toBeDisabled();
  await save(page);
  await page.reload();
  await protocol(page);
  const error = page
    .getByRole('region', { name: '스택 정의 진단' })
    .getByRole('button')
    .filter({ hasText: '/definitions/1/requires' })
    .first();
  await error.click();
  await expect(page.getByRole('combobox', { name: '편집할 인스턴스', exact: true })).toHaveValue(
    'A/transport',
  );
  const pending = port.getByRole('textbox', { name: '미완성 설정 JSON 수정', exact: true });
  await expect(pending).toHaveValue('{');
  await pending.fill(original);
  await expect(page.getByRole('button', { name: '새 스택 전체 실행', exact: true })).toBeEnabled();
  await port.getByRole('checkbox', { name: 'closed 통지 허용', exact: true }).check();
  await save(page);
  const provider = (await active(page)).configuration.definitions[1];
  expect(provider?.requires.lifecycle.notifications).toContain('closed');
  expect(provider?.requires.service.payload).not.toBe('bytes');
});

test('typed initial values and timer declarations preserve pending bytes, zero, false and raw after deleting an earlier variable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await stack(page);
  await create(page);
  await protocol(page);
  const vars = page.getByRole('group', { name: '변수 선언 폼', exact: true });
  await vars.getByRole('button', { name: '변수 추가', exact: true }).click();
  await setting(page, '/definitions/0/variables/0/type').selectOption('boolean');
  await vars.getByRole('button', { name: '선언 타입으로 초기값 만들기', exact: true }).click();
  await expect(setting(page, '/definitions/0/variables/0/initial')).toHaveValue('false');
  await vars.getByRole('button', { name: '변수 추가', exact: true }).click();
  await setting(page, '/definitions/0/variables/1/initial').fill('-');
  await vars.getByRole('button', { name: '변수 삭제 · variable_1', exact: true }).click();
  await expect(setting(page, '/definitions/0/variables/0/initial')).toHaveValue('-');
  await save(page);
  expect((await active(page)).raw['/definitions/0/variables/0/initial']).toBe('number:-');
  await setting(page, '/definitions/0/variables/0/type').selectOption('bytes');
  await vars.getByRole('button', { name: '선언 타입으로 초기값 만들기', exact: true }).click();
  await setting(page, '/definitions/0/variables/0/initial').fill('0f a');
  const timers = page.getByRole('group', { name: '타이머 선언 폼', exact: true });
  await timers.getByRole('button', { name: '타이머 추가', exact: true }).click();
  await setting(page, '/definitions/0/timers/0/id').fill('retry');
  await timers.getByRole('button', { name: '타이머 추가', exact: true }).click();
  await timers.getByRole('button', { name: '타이머 삭제 · retry', exact: true }).click();
  await save(page);
  await page.reload();
  await protocol(page);
  await expect(setting(page, '/definitions/0/variables/0/initial')).toHaveValue('0f a');
  await setting(page, '/definitions/0/variables/0/initial').fill('0fa0');
  await vars.getByRole('button', { name: '변수 추가', exact: true }).click();
  await setting(page, '/definitions/0/variables/1/type').selectOption('json');
  await setting(page, '/definitions/0/variables/1/initial').fill('{"enabled":false,"count":0}');
  await save(page);
  const protocolModel = (await active(page)).configuration.definitions[0];
  if (protocolModel?.mode !== 'stack-protocol') throw new Error('Missing native app');
  expect(protocolModel.variables[0]?.initial).toEqual({
    kind: 'bytes',
    encoding: 'base64',
    byteLength: 2,
    data: 'D6A=',
  });
  expect(protocolModel.variables[1]?.initial).toEqual({ enabled: false, count: 0 });
  expect(protocolModel.timers).toEqual([{ id: 'timer_1' }]);
  expect((await active(page)).raw).toEqual({});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('large declaration pages and diagnostics reveal the actual variable without dropping other source values', async ({
  page,
}) => {
  const source = createNewStack({ ...NEW_STACK_DEFAULTS, transport: 'datagram' }, 'declared');
  if (!source.success) throw new Error('Bad source');
  const configuration = {
    ...source.value,
    definitions: source.value.definitions.map((p, i) =>
      i === 0 && p.mode === 'stack-protocol'
        ? {
            ...p,
            variables: Array.from({ length: 21 }, (_, index) => ({
              id: `value_${index}`,
              type: 'integer' as const,
              initial: index === 20 ? 'wrong' : index,
            })),
          }
        : p,
    ),
  };
  await load(page, createWorkspaceV2(createWorkspace(createPingPongExperiment()), configuration));
  await protocol(page);
  const vars = page.getByRole('group', { name: '변수 선언 폼', exact: true });
  await expect(vars.getByRole('button', { name: /^변수 삭제 ·/ })).toHaveCount(10);
  await page
    .getByRole('region', { name: '스택 정의 진단' })
    .getByRole('button')
    .filter({ hasText: '/definitions/0/variables/20/initial' })
    .first()
    .click();
  await expect(setting(page, '/definitions/0/variables/20/initial')).toHaveCount(1);
  await vars.getByRole('button', { name: '선언 타입으로 초기값 만들기', exact: true }).click();
  await expect(setting(page, '/definitions/0/variables/20/initial')).toHaveValue('0');
  await save(page);
  const app = (await active(page)).configuration.definitions[0];
  expect(app?.mode === 'stack-protocol' && app.variables.length).toBe(21);
});

test('new stack creation rechecks the shared draft capacity and preserves existing data on rejection', async ({
  page,
}) => {
  const source = createNewStack({ ...NEW_STACK_DEFAULTS, transport: 'datagram' }, 'capacity');
  if (!source.success) throw new Error('Bad source');
  const data = createWorkspaceV2(createWorkspace(createPingPongExperiment()));
  const drafts = Array.from({ length: 98 }, (_, i) =>
    createStackDraft({ ...source.value, id: `capacity_${i}` }),
  );
  await load(page, {
    ...data,
    stack: { ...data.stack, drafts, activeDraftId: drafts[0]?.id ?? null },
  });
  await page.getByRole('button', { name: '스택 한 단계', exact: true }).click();
  await expect(page.locator('.stack-run-summary')).toContainText('paused');
  await save(page);
  const before = (await stored(page)).data;
  expect(before.legacy.drafts.length + before.stack.drafts.length).toBe(100);
  const form = await wizard(page);
  await form.getByRole('button', { name: '다음 단계', exact: true }).click();
  await form.getByRole('button', { name: '이 구성으로 스택 만들기', exact: true }).click();
  await expect(form.getByRole('status')).toContainText('100개 한도');
  await save(page);
  expect((await stored(page)).data).toEqual(before);
});
