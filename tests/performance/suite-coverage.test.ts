import { performance } from 'node:perf_hooks';
import { expect, test } from '@playwright/test';
import { createCoverageDraft, runCoverageSuite } from '../fixtures/coverage-suite.ts';
import { createEventLimitExperiment } from '../fixtures/large-experiments.ts';

test('20 actual 10k-event cases keep coverage opening and selection within the bounded UI budget', async ({
  page,
  browser,
}, info) => {
  const draft = createCoverageDraft(createEventLimitExperiment(), 20);
  const runs = runCoverageSuite(draft);
  expect(runs).toHaveLength(20);
  expect(runs.reduce((sum, record) => sum + record.view.events.length, 0)).toBe(200_000);
  const buffer = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      kind: 'protocol-studio-bundle',
      data: { schemaVersion: 1, activeDraftId: draft.id, drafts: [draft], runs },
    }),
  );
  expect(buffer.length).toBeLessThan(67_108_864);
  await page.goto('/');
  await page
    .getByLabel('bundle 가져오기', { exact: true })
    .setInputFiles({ name: 'coverage-200k.json', mimeType: 'application/json', buffer });
  await expect(page.getByText(/검증한 bundle을 적용/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: '지금 저장', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '로컬 저장과 파일' }).getByRole('status'),
  ).toHaveText('브라우저에 저장됨', { timeout: 20_000 });
  await page
    .getByRole('navigation', { name: '작업 공간' })
    .getByRole('button', { name: '시나리오 묶음', exact: true })
    .click();
  const began = performance.now();
  await page.locator('.suite-coverage summary').click();
  const result = page.getByRole('region', { name: '검증 커버리지 결과', exact: true });
  await expect(result).toHaveAttribute('data-coverage-status', 'ready');
  const openMs = performance.now() - began;
  await expect(result).toContainText('집계 사례 20/20개 · 관찰 완료 0개 · 부분 관찰 20개');
  const selectionBegan = performance.now();
  await page.locator('[data-coverage-item="repeat"]').click();
  const evidence = page.getByRole('region', { name: '선택 항목의 실행 사례', exact: true });
  await expect(evidence.getByRole('button')).toHaveCount(20);
  const selectionMs = performance.now() - selectionBegan;
  const chars = await result.evaluate((element) => element.textContent?.length ?? 0);
  expect(await result.locator('[data-coverage-item]').count()).toBeLessThanOrEqual(20);
  expect(await result.locator('svg g.diagram-node').count()).toBeLessThanOrEqual(40);
  const persisted = await page.evaluate(
    async () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open('protocol-studio', 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('workspace-v2', 'readonly');
          const get = tx.objectStore('workspace-v2').get('current');
          tx.oncomplete = () => {
            db.close();
            resolve(
              get.result.data.legacy.runs.reduce(
                (sum: number, record: { view: { events: unknown[] } }) =>
                  sum + record.view.events.length,
                0,
              ),
            );
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
  );
  expect(persisted).toBe(200_000);
  const metrics = {
    fixture: '20x10k-coverage',
    browser: browser.version(),
    events: persisted,
    bytes: buffer.length,
    openMs,
    selectionMs,
    chars,
  };
  console.log(JSON.stringify(metrics));
  await info.attach('suite-coverage-metrics', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  });
  expect(openMs).toBeLessThan(500);
  expect(selectionMs).toBeLessThan(500);
  expect(chars).toBeLessThan(32_768);
});
