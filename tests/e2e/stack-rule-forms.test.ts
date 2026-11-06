import { expect, type Page, test } from '@playwright/test';
import type { WorkspaceV2Envelope } from '../../src/domain/workspace-v2-model.ts';
import { largeStackRuleWorkspace } from '../fixtures/stack-rule-authoring.ts';

const prefix = '/definitions/0/source/rules/0';
const path = (page: Page, path: string) => page.locator(`[data-rule-path="${path}"]`);
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
async function open(page: Page, target = 'A/app') {
  await page.goto('/');
  await page.getByRole('button', { name: '계층 연결 스택', exact: true }).click();
  await page.getByRole('button', { name: 'stack_ping_pong 새 사본', exact: true }).click();
  await protocol(page, target);
  await page
    .getByRole('button', { name: /^규칙 폼 열기 ·/ })
    .first()
    .click();
  return page.getByRole('region', { name: '선택 규칙 폼', exact: true });
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
for (const width of [1440, 768, 390])
  test(`rule forms compose a real condition and variable expression and retain frozen runs at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const form = await open(page);
    await form.getByRole('button', { name: '동작 편집 · 2', exact: true }).click();
    await path(page, `${prefix}/actions/1/values/sequence/kind`).selectOption('variable');
    await path(page, `${prefix}/actions/1/values/sequence/variableId`).selectOption('counter');
    await form.getByRole('button', { name: '비교 조건 추가', exact: true }).click();
    await path(page, `${prefix}/condition/left/kind`).selectOption('field');
    await path(page, `${prefix}/condition/left/fieldId`).selectOption('sequence');
    await path(page, `${prefix}/condition/right/value`).fill('1');
    await path(page, `${prefix}/condition/kind`).selectOption('all');
    await expect(path(page, `${prefix}/condition/conditions/0/right/value`)).toHaveValue('1');
    await expect(
      page.getByRole('button', { name: '새 스택 전체 실행', exact: true }),
    ).toBeEnabled();
    await form.evaluate((e) => e.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: info.outputPath('rule-form.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('button', { name: '새 스택 전체 실행', exact: true }).click();
    await tab(page, '실행');
    await expect(page.locator('.stack-run-summary')).toContainText('completed');
    await expect(page.getByRole('region', { name: '스택 기대 조건' })).not.toContainText('fail');
    await save(page);
    const before = (await stored(page)).data.stack.runs;
    await protocol(page);
    await page
      .getByRole('button', { name: /^규칙 폼 열기 ·/ })
      .first()
      .click();
    await form.getByRole('button', { name: '동작 편집 · 2', exact: true }).click();
    const move = page
      .getByRole('region', { name: '선택 규칙 폼' })
      .getByRole('button', { name: '동작 위로 · 2', exact: true });
    await move.focus();
    await move.press('Enter');
    await expect(
      page
        .getByRole('region', { name: '선택 규칙 폼' })
        .getByRole('button', { name: '동작 편집 · 1', exact: true }),
    ).toBeFocused();
    await save(page);
    expect((await stored(page)).data.stack.runs).toEqual(before);
    await page.getByRole('button', { name: '새 스택 전체 실행', exact: true }).click();
    await tab(page, '실행');
    await expect(page.locator('.stack-run-summary')).toContainText('completed');
    await save(page);
    const runs = (await stored(page)).data.stack.runs;
    expect(runs).toHaveLength(2);
    const values = (index: number) => {
      const event = runs[index]?.view.events.find(
        (e) =>
          e.kind === 'send' && e.endpoint.participant === 'A' && e.endpoint.instanceId === 'app',
      );
      if (!event) throw new Error('Missing actual app send');
      return (event.data as { message: { values: { sequence: number } } }).message.values.sequence;
    };
    expect(values(0)).toBe(1);
    expect(values(1)).toBe(0);
  });

test('unfinished integer input follows move/duplicate/delete and survives native reload for repair', async ({
  page,
}) => {
  const form = await open(page);
  await path(page, `${prefix}/actions/0/value/right/value`).fill('-');
  await form.getByRole('button', { name: '동작 아래로 · 1', exact: true }).click();
  await expect(path(page, `${prefix}/actions/1/value/right/value`)).toHaveValue('-');
  await form.getByRole('button', { name: '동작 복제 · 2', exact: true }).click();
  await expect(path(page, `${prefix}/actions/2/value/right/value`)).toHaveValue('-');
  await form.getByRole('button', { name: '동작 삭제 · 2', exact: true }).click();
  await save(page);
  const raw = (await stored(page)).data.stack.drafts[0]?.raw;
  expect(raw?.[`${prefix}/actions/1/value/right/value`]).toBe('number:-');
  expect(raw?.[`${prefix}/actions/2/value/right/value`]).toBeUndefined();
  await page.reload();
  await protocol(page);
  await page
    .getByRole('button', { name: /^규칙 폼 열기 ·/ })
    .first()
    .click();
  await page
    .getByRole('region', { name: '선택 규칙 폼' })
    .getByRole('button', { name: '동작 편집 · 2', exact: true })
    .click();
  await expect(path(page, `${prefix}/actions/1/value/right/value`)).toHaveValue('-');
  await expect(page.getByRole('button', { name: '새 스택 전체 실행', exact: true })).toBeDisabled();
  await path(page, `${prefix}/actions/1/value/right/value`).fill('1');
  await save(page);
  expect((await stored(page)).data.stack.drafts[0]?.raw).toEqual({});
  await expect(page.getByRole('button', { name: '새 스택 전체 실행', exact: true })).toBeEnabled();
});

test('native byte literals preserve odd hex across reload and repair to canonical tagged bytes without JSON', async ({
  page,
}) => {
  const form = await open(page, 'A/transport');
  await form
    .getByRole('combobox', { name: '추가할 동작 종류', exact: true })
    .selectOption('assign');
  await form.getByRole('button', { name: '선택 동작 추가', exact: true }).click();
  await form.getByRole('combobox', { name: '대입할 변수', exact: true }).selectOption('cached');
  await form.getByRole('combobox', { name: '리터럴 자료형', exact: true }).selectOption('bytes');
  const hex = form.getByRole('textbox', { name: '바이트 값 (hex · 최대 4096 bytes)', exact: true });
  await hex.fill('0f a');
  await save(page);
  await page.reload();
  await protocol(page, 'A/transport');
  await page
    .getByRole('button', { name: /^규칙 폼 열기 ·/ })
    .first()
    .click();
  await page
    .getByRole('region', { name: '선택 규칙 폼' })
    .getByRole('button', { name: '동작 편집 · 6', exact: true })
    .click();
  await expect(hex).toHaveValue('0f a');
  await hex.fill('0fa0');
  await save(page);
  const d = (await stored(page)).data.stack.drafts[0];
  expect(d?.raw).toEqual({});
  const definition = d?.configuration.definitions[1];
  expect(definition?.mode).toBe('stack-protocol');
  if (definition?.mode !== 'stack-protocol') throw new Error('Missing provider');
  expect(definition.rules[0]?.actions[5]).toEqual({
    kind: 'assign',
    variableId: 'cached',
    value: {
      kind: 'literal',
      value: { kind: 'bytes', encoding: 'base64', byteLength: 2, data: 'D6A=' },
    },
  });
});

test('unfinished parent JSON blocks structural form edits and can be repaired in the same canonical path', async ({
  page,
}) => {
  const form = await open(page);
  await page.locator('summary').filter({ hasText: '규칙 JSON 편집 · start · 1' }).click();
  const json = page.getByRole('textbox', { name: '순서대로 실행할 동작 JSON', exact: true });
  const before = await json.inputValue();
  await json.fill('{');
  await expect(form.getByRole('button', { name: '동작 위로 · 2', exact: true })).toBeDisabled();
  await save(page);
  await page.reload();
  await protocol(page);
  await page
    .getByRole('button', { name: /^규칙 폼 열기 ·/ })
    .first()
    .click();
  const pending = page
    .getByRole('region', { name: '선택 규칙 폼' })
    .getByRole('textbox', { name: '미완성 JSON 수정', exact: true });
  await expect(pending).toHaveValue('{');
  await pending.fill(before);
  await expect(form.getByRole('button', { name: '동작 위로 · 2', exact: true })).toBeEnabled();
  await save(page);
  expect((await stored(page)).data.stack.drafts[0]?.raw).toEqual({});
});

test('event scope diagnostics reveal the actual action form while legacy expression options remain restricted', async ({
  page,
}) => {
  const form = await open(page);
  await form.getByRole('button', { name: '동작 편집 · 2', exact: true }).click();
  await expect(
    path(page, `${prefix}/actions/1/values/sequence/kind`).locator('option[value="concat"]'),
  ).toHaveCount(0);
  await form.getByRole('combobox', { name: '이벤트 종류', exact: true }).selectOption('timer');
  await expect(page.getByRole('button', { name: '새 스택 전체 실행', exact: true })).toBeDisabled();
  const error = page
    .getByRole('region', { name: '스택 정의 진단' })
    .getByRole('button')
    .filter({ hasText: `${prefix}/actions/1/values/sequence/fieldId` })
    .first();
  await error.click();
  await expect(path(page, `${prefix}/actions/1/values/sequence/fieldId`)).toBeFocused();
  await form.getByRole('button', { name: '동작 편집 · 1', exact: true }).click();
  await error.click();
  await expect(path(page, `${prefix}/actions/1/values/sequence/fieldId`)).toBeFocused();
  await form.getByRole('combobox', { name: '이벤트 종류', exact: true }).selectOption('input');
  await expect(page.getByRole('button', { name: '새 스택 전체 실행', exact: true })).toBeEnabled();
});

test('unknown native expressions remain intact through bounded form and JSON views', async ({
  page,
}) => {
  const data = largeStackRuleWorkspace(0);
  const d = data.stack.drafts[0];
  if (!d) throw new Error('Missing draft');
  const configuration = {
    ...d.configuration,
    definitions: d.configuration.definitions.map((p, i) =>
      i === 1 && p.mode === 'stack-protocol'
        ? {
            ...p,
            rules: p.rules.map((r, index) =>
              index === 0
                ? {
                    ...r,
                    actions: [
                      {
                        kind: 'assign',
                        variableId: 'retries',
                        value: { kind: 'future-node', payload: { keep: false } },
                      },
                    ],
                  }
                : r,
            ),
          }
        : p,
    ),
  };
  await page.goto('/');
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'unknown.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        kind: 'protocol-studio-bundle',
        data: { ...data, stack: { ...data.stack, drafts: [{ ...d, configuration }] } },
      }),
    ),
  });
  await page.getByRole('button', { name: '계층 연결 스택', exact: true }).click();
  await protocol(page, 'A/transport');
  await page
    .getByRole('button', { name: /^규칙 폼 열기 ·/ })
    .first()
    .click();
  const form = page.getByRole('region', { name: '선택 규칙 폼' });
  await form.getByRole('button', { name: '이 부분 JSON 편집', exact: true }).click();
  const json = form.getByRole('textbox', { name: '하위 트리 JSON', exact: true });
  expect(JSON.parse(await json.inputValue())).toEqual({
    kind: 'future-node',
    payload: { keep: false },
  });
  await save(page);
  await expect(page.getByRole('button', { name: '새 스택 전체 실행', exact: true })).toBeDisabled();
});

test('nested byte expressions move pending hex atomically and round-trip advanced JSON into forms', async ({
  page,
}) => {
  const form = await open(page, 'A/transport');
  const payload = '/definitions/1/rules/0/actions/0/payload';
  await path(page, `${payload}/kind`).selectOption('concat');
  await form.getByRole('button', { name: '합칠 바이트 추가', exact: true }).click();
  const child = (index: number) =>
    form.locator(`fieldset[data-rule-focus="${payload}/values/${index}"]`);
  const hex = (index: number) => path(page, `${payload}/values/${index}/value`);
  await hex(1).fill('0f a');
  await child(1).getByRole('button', { name: '위로', exact: true }).press('Enter');
  await expect(child(0)).toBeFocused();
  await expect(hex(0)).toHaveValue('0f a');
  await child(0).getByRole('button', { name: '복제', exact: true }).click();
  await child(0).getByRole('button', { name: '삭제', exact: true }).click();
  await expect(hex(0)).toHaveValue('0f a');
  await hex(0).fill('');
  await hex(0).pressSequentially('0fa0');
  await expect(hex(0)).toBeFocused();
  await expect(hex(0)).toHaveValue('0fa0');
  await save(page);
  expect((await stored(page)).data.stack.drafts[0]?.raw).toEqual({});
  await page
    .locator('summary')
    .filter({ hasText: '규칙 JSON 편집 · accept_DATA_Ready · 1' })
    .click();
  const json = page.getByRole('textbox', { name: '순서대로 실행할 동작 JSON', exact: true });
  const actions = JSON.parse(await json.inputValue());
  actions[0].payload = {
    kind: 'slice',
    value: actions[0].payload.values[0],
    offset: { kind: 'literal', value: 0 },
    length: { kind: 'literal', value: 1 },
  };
  await json.fill(JSON.stringify(actions));
  await expect(path(page, `${payload}/kind`)).toHaveValue('slice');
  await expect(path(page, `${payload}/length/value`)).toHaveValue('1');
  await expect(page.getByRole('button', { name: '새 스택 전체 실행', exact: true })).toBeEnabled();
});
