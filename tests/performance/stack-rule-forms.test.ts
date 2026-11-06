import { performance } from 'node:perf_hooks';
import { expect, test } from '@playwright/test';
import { parseStackExperiment } from '../../src/domain/stack-validation.ts';
import { largeStackRuleWorkspace } from '../fixtures/stack-rule-authoring.ts';

test('605 actual actions keep selected-rule authoring bounded and responsive', async ({
  page,
}, info) => {
  const data = largeStackRuleWorkspace();
  expect(parseStackExperiment(data.stack.drafts[0]?.configuration).success).toBe(true);
  await page.goto('/');
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'large-rules.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ schemaVersion: 2, kind: 'protocol-studio-bundle', data })),
  });
  await expect(page.getByText(/검증한 bundle을 적용/)).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: '계층 연결 스택', exact: true }).click();
  await page
    .getByRole('navigation', { name: '스택 작업' })
    .getByRole('button', { name: '편집', exact: true })
    .click();
  await page.getByRole('tab', { name: '프로토콜 정의', exact: true }).click();
  await page
    .getByRole('combobox', { name: '편집할 인스턴스', exact: true })
    .selectOption('A/transport');
  const began = performance.now();
  await page
    .getByRole('button', { name: /^규칙 폼 열기 ·/ })
    .first()
    .click();
  const form = page.getByRole('region', { name: '선택 규칙 폼', exact: true });
  await expect(form.getByRole('button', { name: '동작 편집 · 1', exact: true })).toBeVisible();
  const openMs = performance.now() - began;
  expect(await form.getByRole('button', { name: /^동작 편집 ·/ }).count()).toBe(10);
  const moveBegan = performance.now();
  await form.getByRole('button', { name: '동작 아래로 · 1', exact: true }).click();
  await expect(form.getByRole('button', { name: '동작 편집 · 2', exact: true })).toBeFocused();
  const moveMs = performance.now() - moveBegan;
  const chars = await form.evaluate((e) => e.textContent?.length ?? 0);
  await page.getByRole('button', { name: '지금 저장', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '로컬 저장과 파일' }).getByRole('status'),
  ).toHaveText('브라우저에 저장됨');
  const actions = await page.evaluate(
    () =>
      new Promise<unknown[]>((resolve, reject) => {
        const request = indexedDB.open('protocol-studio', 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('workspace-v2', 'readonly');
          const get = tx.objectStore('workspace-v2').get('current');
          tx.oncomplete = () => {
            db.close();
            resolve(get.result.data.stack.drafts[0].configuration.definitions[1].rules[0].actions);
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
  );
  expect(actions).toHaveLength(605);
  expect(actions[1]).toMatchObject({ kind: 'service-indicate' });
  const metrics = { actions: actions.length, openMs, moveMs, chars };
  console.log(metrics);
  await info.attach('rule-form-performance.json', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  });
  expect(openMs).toBeLessThan(500);
  expect(moveMs).toBeLessThan(500);
  expect(chars).toBeLessThan(32768);
});
