import { performance } from 'node:perf_hooks';
import { expect, test } from '@playwright/test';
import { editExperiment } from '../../src/application/edit-experiment.ts';
import { createDraftRecord } from '../../src/application/workspace-operations.ts';
import { runComparisonRecord } from '../fixtures/comparison-runs.ts';
import {
  createEventLimitExperiment,
  createMessageLimitExperiment,
} from '../fixtures/large-experiments.ts';

for (const fixture of ['two-10k', 'two-1MiB'] as const) {
  test(`${fixture} execution comparison opens, selects differences and paginates within the UI budget`, async ({
    page,
    browser,
  }, info) => {
    const configuration =
      fixture === 'two-10k' ? createEventLimitExperiment() : createMessageLimitExperiment();
    const left = runComparisonRecord(configuration);
    const right = runComparisonRecord(
      fixture === 'two-10k'
        ? editExperiment(configuration, '/definitions/0/rules/1/actions/0/durationMs/value', 2)
        : configuration,
    );
    if (fixture === 'two-10k') {
      expect(left.view.events).toHaveLength(10_000);
      expect(right.view.events).toHaveLength(10_000);
    }
    const draft = createDraftRecord(configuration);
    const buffer = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'protocol-studio-bundle',
        data: { schemaVersion: 1, activeDraftId: draft.id, drafts: [draft], runs: [left, right] },
      }),
    );
    expect(buffer.length).toBeLessThan(67_108_864);
    await page.goto('/');
    await page
      .getByLabel('bundle 가져오기', { exact: true })
      .setInputFiles({ name: `${fixture}.json`, mimeType: 'application/json', buffer });
    await expect(page.getByText(/검증한 bundle을 적용/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: '지금 저장', exact: true }).click();
    await expect(
      page.getByRole('region', { name: '로컬 저장과 파일' }).getByRole('status'),
    ).toHaveText('브라우저에 저장됨', { timeout: 20_000 });
    const began = performance.now();
    await page
      .getByRole('navigation', { name: '작업 공간' })
      .getByRole('button', { name: '실행 비교', exact: true })
      .click();
    const result = page.getByRole('region', { name: '두 실행 비교 결과', exact: true });
    await expect(result).toHaveAttribute('data-comparison-status', 'ready');
    const openMs = performance.now() - began;
    const selectedAt = performance.now();
    await page
      .getByRole('button', {
        name: fixture === 'two-10k' ? '첫 관찰 차이' : '첫 비교 한도',
        exact: true,
      })
      .click();
    await expect(page.getByRole('region', { name: '선택한 비교 관찰', exact: true })).toBeVisible();
    const selectMs = performance.now() - selectedAt;
    const chars = await result.evaluate((element) => element.textContent?.length ?? 0);
    expect(await page.locator('[data-compare-row]').count()).toBeLessThanOrEqual(20);
    expect(await page.locator('[data-compare-value]').count()).toBeLessThanOrEqual(20);
    let pageMs = 0;
    if (fixture === 'two-10k') {
      const pageAt = performance.now();
      await page.getByRole('button', { name: '다음 관찰 페이지', exact: true }).click();
      await expect(page.locator('[data-compare-row]').first()).toHaveAttribute(
        'data-compare-row',
        '20',
      );
      pageMs = performance.now() - pageAt;
    } else
      await expect(
        page.getByRole('region', { name: '나란한 관찰 기록', exact: true }),
      ).toContainText('일부 내용은 비교 한도');
    const metrics = {
      fixture,
      browser: browser.version(),
      bytes: buffer.length,
      events: left.view.events.length + right.view.events.length,
      openMs,
      selectMs,
      pageMs,
      chars,
    };
    console.log(JSON.stringify(metrics));
    await info.attach(`${fixture}-comparison-metrics`, {
      body: JSON.stringify(metrics, null, 2),
      contentType: 'application/json',
    });
    expect(openMs).toBeLessThan(500);
    expect(selectMs).toBeLessThan(500);
    expect(pageMs).toBeLessThan(500);
    expect(chars).toBeLessThan(32_768);
  });
}
