import { performance } from 'node:perf_hooks';
import { expect, type Page, test } from '@playwright/test';
import { createWorkspace } from '../../src/application/workspace-operations.ts';
import { createWorkspaceV2 } from '../../src/application/workspace-v2-operations.ts';
import type { WorkspaceV2 } from '../../src/domain/workspace-v2-model.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';
import { largeStackEvents, largeStackFrame, largeStackSuite } from '../fixtures/large-stacks.ts';

async function tab(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: '스택 작업' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function load(page: Page, data: WorkspaceV2) {
  await page.goto('/');
  await page.getByRole('button', { name: '계층 연결 스택', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '프로토콜 스택 작업 공간', exact: true }),
  ).toBeVisible();
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'stack.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ schemaVersion: 2, kind: 'protocol-studio-bundle', data })),
  });
  await expect(page.getByText(/검증한 bundle을 적용/)).toBeVisible({ timeout: 15000 });
}
async function probe(page: Page) {
  await page.evaluate(() => {
    const gaps: number[] = [];
    const tasks: number[] = [];
    let previous = performance.now();
    let handle = 0;
    const tick = (now: number) => {
      gaps.push(now - previous);
      previous = now;
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    const observer = new PerformanceObserver((list) =>
      tasks.push(...list.getEntries().map((e) => e.duration)),
    );
    observer.observe({ type: 'longtask' });
    Object.defineProperty(window, 'endStackProbe', {
      configurable: true,
      value: () => {
        cancelAnimationFrame(handle);
        observer.disconnect();
        gaps.sort((a, b) => a - b);
        return {
          frames: gaps.length,
          frameP95Ms: gaps[Math.floor(gaps.length * 0.95)] ?? 0,
          longTaskMaxMs: Math.max(0, ...tasks),
        };
      },
    });
  });
}
async function finish(page: Page) {
  return page.evaluate(() =>
    (
      window as unknown as {
        endStackProbe: () => { frames: number; frameP95Ms: number; longTaskMaxMs: number };
      }
    ).endStackProbe(),
  );
}
for (const fixture of ['10k', '1MiB'] as const)
  test(`native stacked ${fixture} run, prefix, diagrams and save meet P7 budgets`, async ({
    page,
  }, info) => {
    const configuration = fixture === '10k' ? largeStackEvents() : largeStackFrame();
    await load(page, createWorkspaceV2(createWorkspace(createPingPongExperiment()), configuration));
    await tab(page, '중단점');
    for (let i = 0; i < 20; i++)
      await page.getByRole('button', { name: '스택 중단점 추가', exact: true }).click();
    await expect(page.getByRole('region', { name: '스택 중단점' }).locator('fieldset')).toHaveCount(
      20,
    );
    await tab(page, '실행');
    await probe(page);
    const began = performance.now();
    await page.getByRole('button', { name: '새 스택 전체 실행', exact: true }).click();
    await expect(page.locator('.stack-run-summary')).toContainText(
      fixture === '10k' ? 'limit-reached' : 'completed',
      { timeout: 55000 },
    );
    const runMs = performance.now() - began;
    await expect(page.getByRole('region', { name: '인스턴스 상태' })).toBeVisible();
    if (fixture === '10k')
      await expect(page.locator('.stack-run-summary')).toContainText('관찰 10000개');
    const filters: number[] = [];
    for (let i = 0; i < 60; i++) {
      const started = performance.now();
      await page
        .getByLabel('관찰할 인스턴스', { exact: true })
        .selectOption(i % 2 ? 'A/app' : 'B/app');
      await expect(
        page.getByRole('region', { name: '인스턴스 상태' }).getByRole('heading'),
      ).toContainText(i % 2 ? 'A/app' : 'B/app');
      filters.push(performance.now() - started);
    }
    await page.getByLabel('관찰할 인스턴스', { exact: true }).selectOption('A/app');
    const selectBegan = performance.now();
    await page.locator('.stack-rule-list button').first().click();
    await page.locator('.stack-event-links button').first().click();
    await page.getByRole('button', { name: '규칙·변수 이유', exact: true }).click();
    await expect(page.getByRole('region', { name: '스택 관찰 상세' })).toContainText(
      '관찰된 최종 변화',
    );
    const selectionMs = performance.now() - selectBegan;
    await page.getByRole('button', { name: '저장 시점', exact: true }).click();
    await page.getByRole('button', { name: '기록 처음', exact: true }).click();
    await expect(page.getByRole('region', { name: '인스턴스 상태' })).toContainText('송신 0');
    const historyBegan = performance.now();
    await page.getByRole('button', { name: '저장 시점', exact: true }).click();
    await expect(page.getByRole('region', { name: '인스턴스 상태' })).toBeVisible();
    const historyMs = performance.now() - historyBegan;
    await page.getByRole('button', { name: '메시지 구조', exact: true }).click();
    if (fixture === '1MiB') {
      await page
        .getByRole('button', { name: /^스택 관찰 \d+ .*send/ })
        .first()
        .click();
      await expect(page.getByRole('group', { name: '스택 바이트 창' })).toBeVisible();
      await expect(page.getByRole('group', { name: '스택 바이트 창' }).locator('span')).toHaveCount(
        256,
      );
    }
    if (fixture === '1MiB')
      await page.getByRole('button', { name: '저장 시점', exact: true }).click();
    const journeyBegan = performance.now();
    await page.getByRole('button', { name: '메시지 이동 경로', exact: true }).click();
    const journey = page.getByRole('region', { name: '메시지 이동 경로', exact: true });
    await expect(journey).toHaveAttribute(
      'data-journey-status',
      fixture === '1MiB' ? 'available' : 'unavailable',
    );
    const journeyMs = performance.now() - journeyBegan;
    let journeySelectMs = 0;
    if (fixture === '1MiB') {
      const began = performance.now();
      await journey.getByLabel('원본 byte 시작', { exact: true }).fill('65535');
      await journey.getByLabel('선택 byte 길이', { exact: true }).fill('2');
      await journey.getByRole('button', { name: 'byte 범위 적용', exact: true }).click();
      await expect(journey).toContainText('선택 범위 [65535, 65537) · 2 bytes');
      journeySelectMs = performance.now() - began;
      expect(await journey.locator('[data-journey-event]').count()).toBeLessThanOrEqual(20);
      expect(await journey.locator('[data-journey-byte]').count()).toBeLessThanOrEqual(256);
    }
    const journeyChars = await journey.evaluate((element) => element.textContent?.length ?? 0);
    const saveBegan = performance.now();
    await page.getByRole('button', { name: '지금 저장', exact: true }).click();
    await expect(
      page.getByRole('region', { name: '로컬 저장과 파일' }).getByRole('status'),
    ).toHaveText('브라우저에 저장됨');
    const saveMs = performance.now() - saveBegan;
    const chars = await page
      .getByRole('region', { name: '스택 실행 관찰' })
      .evaluate((e) => e.textContent?.length ?? 0);
    const responsiveness = await finish(page);
    filters.sort((a, b) => a - b);
    const filterP95Ms = filters[57] ?? 0;
    const metrics = {
      fixture,
      runMs,
      selectionMs,
      historyMs,
      saveMs,
      filterP95Ms,
      chars,
      journeyMs,
      journeySelectMs,
      journeyChars,
      ...responsiveness,
    };
    await info.attach('stack-performance.json', {
      body: JSON.stringify(metrics, null, 2),
      contentType: 'application/json',
    });
    console.log(metrics);
    expect(runMs).toBeLessThan(10000);
    expect(selectionMs).toBeLessThan(500);
    expect(historyMs).toBeLessThan(500);
    expect(saveMs).toBeLessThan(3000);
    expect(filterP95Ms).toBeLessThan(200);
    expect(chars).toBeLessThan(32768);
    expect(journeyMs).toBeLessThan(500);
    expect(journeySelectMs).toBeLessThan(500);
    expect(journeyChars).toBeLessThan(32768);
    expect(responsiveness.frameP95Ms).toBeLessThan(100);
    expect(responsiveness.longTaskMaxMs).toBeLessThan(fixture === '10k' ? 250 : 1000);
  });
test('actual twenty-case stacked coverage and comparison stay bounded and responsive', async ({
  page,
}, info) => {
  const data = largeStackSuite();
  expect(data.stack.runs).toHaveLength(20);
  expect(data.stack.runs.reduce((n, r) => n + r.view.events.length, 0)).toBeGreaterThanOrEqual(
    12000,
  );
  await load(page, { ...data, stack: { ...data.stack, runs: [] } });
  await tab(page, '반복·회귀');
  await probe(page);
  const runBegan = performance.now();
  await page.getByRole('button', { name: '스택 회귀 검증 실행', exact: true }).click();
  await expect(page.locator('.stack-series-summary')).toContainText('묶음 종료', {
    timeout: 55000,
  });
  const runMs = performance.now() - runBegan;
  const saveBegan = performance.now();
  await page.getByRole('button', { name: '지금 저장', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '로컬 저장과 파일' }).getByRole('status'),
  ).toHaveText('브라우저에 저장됨');
  const saveMs = performance.now() - saveBegan;
  await tab(page, '실행');
  const began = performance.now();
  await tab(page, '반복·회귀');
  await expect(page.locator('.stack-coverage-item').first()).toBeVisible();
  const coverageMs = performance.now() - began;
  const selectBegan = performance.now();
  await page.locator('.stack-coverage-item button').first().click();
  await expect(page.getByLabel('스택 기록 위치 값', { exact: true })).toHaveValue('0');
  await expect(page.getByRole('region', { name: '인스턴스 상태' })).toBeVisible();
  const selectionMs = performance.now() - selectBegan;
  await tab(page, '기록·비교');
  const compareBegan = performance.now();
  await page.getByLabel('왼쪽 스택 실행', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('오른쪽 스택 실행', { exact: true }).selectOption({ index: 2 });
  await expect(
    page.getByRole('table', { name: '순서를 보존한 관찰 대응 · 공유 원인 아님' }),
  ).toBeVisible();
  const comparisonMs = performance.now() - compareBegan;
  const chars = await page
    .getByRole('region', { name: '스택 기록·비교' })
    .evaluate((e) => e.textContent?.length ?? 0);
  const responsiveness = await finish(page);
  const metrics = {
    runMs,
    saveMs,
    coverageMs,
    selectionMs,
    comparisonMs,
    chars,
    ...responsiveness,
  };
  await info.attach('stack-suite-performance.json', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  });
  console.log(metrics);
  expect(runMs).toBeLessThan(10000);
  expect(saveMs).toBeLessThan(3000);
  expect(coverageMs).toBeLessThan(500);
  expect(selectionMs).toBeLessThan(500);
  expect(comparisonMs).toBeLessThan(500);
  expect(chars).toBeLessThan(32768);
  expect(responsiveness.frameP95Ms).toBeLessThan(100);
  expect(responsiveness.longTaskMaxMs).toBeLessThan(250);
});
