import { performance } from 'node:perf_hooks';
import { expect, test } from '@playwright/test';
import { createStackSimulation } from '../../src/application/create-stack-simulation.ts';
import { stackProtocolBody } from '../../src/domain/stack-model.ts';
import { stackVisualWorkspace } from '../fixtures/stack-visual-authoring.ts';

test('125 states and 605 real rules keep visual authoring, selection, pages and undo/redo bounded', async ({
  page,
}, info) => {
  const data = stackVisualWorkspace(true);
  const draft = data.stack.drafts[0];
  if (!draft) throw new Error('Missing large draft');
  const execution = createStackSimulation(draft.configuration);
  expect(execution.success).toBe(true);
  if (!execution.success) throw new Error('Invalid graph fixture');
  execution.value.run();
  expect(execution.value.view().status).toBe('completed');
  expect(execution.value.view().expectations.every((e) => e.status === 'pass')).toBe(true);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '계층 연결 스택', exact: true })).toBeEnabled();
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'large-graph.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ schemaVersion: 2, kind: 'protocol-studio-bundle', data })),
  });
  await expect(page.getByText(/검증한 bundle을 적용/)).toBeVisible({ timeout: 15000 });
  await expect(page.getByLabel('bundle 가져오기', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '계층 연결 스택', exact: true }).click();
  await page
    .getByRole('navigation', { name: '스택 작업' })
    .getByRole('button', { name: '편집', exact: true })
    .click();
  await page.getByRole('tab', { name: '프로토콜 정의', exact: true }).click();
  const graph = page.getByRole('region', { name: '스택 초안 상태도', exact: true });
  const sidebar = page.getByRole('region', { name: '스택 상태도 선택 편집기', exact: true });
  let began = performance.now();
  await page.locator('.stack-visual-details > summary').click();
  await expect(graph).toContainText('전체 605개');
  const openMs = performance.now() - began;
  expect(
    await graph
      .getByRole('combobox', { name: '스택 초안 상태도 규칙 선택', exact: true })
      .getByRole('option')
      .count(),
  ).toBe(21);
  expect(await graph.locator('[data-state-index]').count()).toBeLessThanOrEqual(82);
  began = performance.now();
  await graph
    .getByRole('combobox', { name: '스택 초안 상태도 규칙 선택', exact: true })
    .selectOption('19');
  await expect(sidebar.getByRole('textbox', { name: '규칙 ID', exact: true })).toHaveValue('r_19');
  const selectionMs = performance.now() - began;
  const ruleChars = await page
    .locator('.stack-visual-authoring')
    .evaluate((e) => e.textContent?.length ?? 0);
  began = performance.now();
  await graph.getByRole('button', { name: '상태 다음 페이지', exact: true }).click();
  await expect(graph).toContainText('상태 2/4');
  const pageMs = performance.now() - began;
  const pageChars = await page
    .locator('.stack-visual-authoring')
    .evaluate((e) => e.textContent?.length ?? 0);
  began = performance.now();
  await page
    .getByRole('group', { name: '스택 상태도 작성 도구', exact: true })
    .getByRole('button', { name: '그림에 상태 추가', exact: true })
    .click();
  await expect(sidebar.getByRole('textbox', { name: '상태 이름', exact: true })).toBeFocused();
  const addMs = performance.now() - began;
  began = performance.now();
  await page.getByRole('button', { name: '편집 되돌리기', exact: true }).click();
  await expect(graph).toContainText('전체 125개');
  const undoMs = performance.now() - began;
  began = performance.now();
  await page.getByRole('button', { name: '편집 다시 하기', exact: true }).click();
  await expect(graph).toContainText('전체 126개');
  const redoMs = performance.now() - began;
  const stateChars = await page
    .locator('.stack-visual-authoring')
    .evaluate((e) => e.textContent?.length ?? 0);
  const chars = Math.max(ruleChars, pageChars, stateChars);
  await page.getByRole('button', { name: '지금 저장', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '로컬 저장과 파일' }).getByRole('status'),
  ).toHaveText('브라우저에 저장됨');
  const saved = await page.evaluate(
    () =>
      new Promise<{ states: unknown[]; rules: unknown[] }>((resolve, reject) => {
        const request = indexedDB.open('protocol-studio', 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('workspace-v2', 'readonly');
          const get = tx.objectStore('workspace-v2').get('current');
          tx.oncomplete = () => {
            db.close();
            const workspace = get.result.data.stack;
            const active = workspace.drafts.find(
              (d: { id: string }) => d.id === workspace.activeDraftId,
            );
            resolve({
              states: active.configuration.definitions[0].states,
              rules: active.configuration.definitions[0].rules,
            });
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
  );
  const original = draft.configuration.definitions[0];
  if (!original) throw new Error('Missing original definition');
  expect(saved.rules).toEqual(stackProtocolBody(original).rules);
  expect(saved.states).toHaveLength(126);
  const metrics = {
    states: 125,
    rules: saved.rules.length,
    openMs,
    selectionMs,
    pageMs,
    addMs,
    undoMs,
    redoMs,
    ruleChars,
    pageChars,
    stateChars,
    chars,
  };
  console.log(metrics);
  await info.attach('stack-visual-performance.json', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  });
  for (const value of [openMs, selectionMs, pageMs, addMs, undoMs, redoMs])
    expect(value).toBeLessThan(500);
  expect(chars).toBeLessThan(32768);
});
