import { performance } from 'node:perf_hooks';
import { expect, test } from '@playwright/test';
import { createStackSimulation } from '../../src/application/create-stack-simulation.ts';
import { stackScenarioWorkspace } from '../fixtures/stack-scenario-forms.ts';

test('125 timed inputs and expectations keep exact-schema scenario forms, pages and undo responsive', async ({
  page,
}, info) => {
  const workspace = stackScenarioWorkspace(true);
  const draft = workspace.stack.drafts[0];
  if (!draft) throw new Error('Missing scenario fixture');
  const runtime = createStackSimulation(draft.configuration);
  expect(runtime.success).toBe(true);
  if (!runtime.success) throw new Error(JSON.stringify(runtime.diagnostics));
  expect(['completed', 'limit-reached']).toContain(runtime.value.run().status);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '계층 연결 스택', exact: true })).toBeEnabled();
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'large-scenario.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({ schemaVersion: 2, kind: 'protocol-studio-bundle', data: workspace }),
    ),
  });
  await expect(page.getByText(/검증한 bundle을 적용/)).toBeVisible();
  await expect(page.getByLabel('bundle 가져오기', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '계층 연결 스택', exact: true }).click();
  await page
    .getByRole('navigation', { name: '스택 작업' })
    .getByRole('button', { name: '편집', exact: true })
    .click();
  const form = page.getByRole('region', { name: '스택 시나리오 폼', exact: true });
  const selected = page.getByRole('region', { name: '선택 시나리오 항목', exact: true });
  const began = performance.now();
  await page.getByRole('tab', { name: '입력·기대 조건', exact: true }).click();
  await expect(form).toBeVisible();
  const openMs = performance.now() - began;
  const chars: number[] = [];
  const sample = async () => chars.push(await form.evaluate((e) => e.textContent?.length ?? 0));
  await sample();
  for (let i = 0; i < 11; i++)
    await form.getByRole('button', { name: '다음 입력 10개', exact: true }).click();
  const paged = performance.now();
  await form.getByRole('button', { name: '다음 입력 10개', exact: true }).click();
  await expect(form.getByRole('button', { name: /^입력 편집 · 125 ·/ })).toBeVisible();
  const pageMs = performance.now() - paged;
  const picked = performance.now();
  await form.getByRole('button', { name: /^입력 편집 · 125 ·/ }).click();
  await expect(selected).toContainText('입력 125');
  const selectionMs = performance.now() - picked;
  for (let i = 0; i < 12; i++)
    await selected.getByRole('button', { name: '다음 필드 10개', exact: true }).click();
  const field = performance.now();
  await selected.getByRole('button', { name: /^필드 편집 · extra_123 ·/ }).click();
  await expect(selected).toContainText('추가 123');
  const fieldMs = performance.now() - field;
  await sample();
  const added = performance.now();
  await form.getByRole('button', { name: '입력 추가', exact: true }).click();
  await expect(selected).toContainText('입력 126');
  const addMs = performance.now() - added;
  const undo = performance.now();
  await page.getByRole('button', { name: '편집 되돌리기', exact: true }).click();
  await expect(form.getByRole('heading', { name: '입력 · 125개', exact: true })).toBeVisible();
  const undoMs = performance.now() - undo;
  const redo = performance.now();
  await page.getByRole('button', { name: '편집 다시 하기', exact: true }).click();
  await expect(form.getByRole('heading', { name: '입력 · 126개', exact: true })).toBeVisible();
  const redoMs = performance.now() - redo;
  await sample();
  await page.getByRole('button', { name: '지금 저장', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '로컬 저장과 파일' }).getByRole('status'),
  ).toHaveText('브라우저에 저장됨');
  const saved = await page.evaluate(
    () =>
      new Promise<{ inputs: number; expectations: number; messages: number; fields: number }>(
        (resolve, reject) => {
          const open = indexedDB.open('protocol-studio', 2);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result,
              tx = db.transaction('workspace-v2', 'readonly');
            const get = tx.objectStore('workspace-v2').get('current');
            tx.oncomplete = () => {
              const stack = get.result.data.stack;
              const draft = stack.drafts.find((d: { id: string }) => d.id === stack.activeDraftId);
              db.close();
              resolve({
                inputs: draft.configuration.scenario.inputs.length,
                expectations: draft.configuration.scenario.expectations.length,
                messages: draft.configuration.definitions[0].messages.length,
                fields: draft.configuration.definitions[0].messages[0].fields.length,
              });
            };
          };
        },
      ),
  );
  expect(saved).toEqual({ inputs: 126, expectations: 125, messages: 125, fields: 129 });
  const choices = await selected
    .getByLabel('시나리오 메시지', { exact: true })
    .locator('option')
    .count();
  expect(choices).toBeGreaterThan(0);
  expect(choices).toBeLessThanOrEqual(20);
  const rawDraft = {
    ...draft,
    id: `${draft.id}_raw`,
    raw: {
      '/scenario/inputs/0/id': `"${'x'.repeat(16000)}`,
      '/scenario/inputs/0/message/values/text': `"${'y'.repeat(16000)}`,
    },
  };
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'large-pending-scenario.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        kind: 'protocol-studio-bundle',
        data: {
          ...workspace,
          stack: { ...workspace.stack, activeDraftId: rawDraft.id, drafts: [rawDraft] },
        },
      }),
    ),
  });
  await expect(page.getByText(/검증한 bundle을 적용/)).toBeVisible();
  await expect(page.getByLabel('bundle 가져오기', { exact: true })).toBeEnabled();
  await expect(selected.getByLabel('미완성 시나리오 JSON 수정', { exact: true })).toHaveCount(1);
  await sample();
  const metrics = {
    openMs,
    pageMs,
    selectionMs,
    fieldMs,
    addMs,
    undoMs,
    redoMs,
    chars: Math.max(...chars),
    ...saved,
  };
  console.log(metrics);
  await info.attach('scenario-forms-performance.json', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  });
  for (const ms of [openMs, pageMs, selectionMs, fieldMs, addMs, undoMs, redoMs])
    expect(ms).toBeLessThan(500);
  expect(metrics.chars).toBeLessThan(32768);
  expect(await form.getByRole('button', { name: /^입력 편집 ·/ }).count()).toBeLessThanOrEqual(10);
});
