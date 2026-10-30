import { performance } from 'node:perf_hooks';
import { expect, test, type Page } from '@playwright/test';
import { createWorkspace } from '../../src/application/workspace-operations.ts';
import {
  createEventLimitExperiment,
  createMessageLimitExperiment,
} from '../fixtures/large-experiments.ts';
import type { ExperimentDefinition } from '../../src/domain/protocol-model.ts';

async function startProbe(page: Page) {
  await page.evaluate(() => {
    const gaps: number[] = [];
    const tasks: number[] = [];
    let previous = performance.now();
    let handle = 0;
    const frame = (time: number) => {
      gaps.push(time - previous);
      previous = time;
      handle = requestAnimationFrame(frame);
    };
    handle = requestAnimationFrame(frame);
    const observer = new PerformanceObserver((list) =>
      tasks.push(...list.getEntries().map((entry) => entry.duration)),
    );
    observer.observe({ type: 'longtask', buffered: false });
    Object.defineProperty(window, 'finishPerformanceProbe', {
      configurable: true,
      value: () => {
        cancelAnimationFrame(handle);
        observer.disconnect();
        gaps.sort((a, b) => a - b);
        return {
          frames: gaps.length,
          frameP95Ms: gaps[Math.floor(gaps.length * 0.95)] ?? 0,
          frameMaxMs: Math.max(0, ...gaps),
          longTaskMaxMs: Math.max(0, ...tasks),
        };
      },
    });
  });
}
async function finishProbe(page: Page) {
  return page.evaluate(() =>
    (
      window as unknown as {
        finishPerformanceProbe: () => {
          frames: number;
          frameP95Ms: number;
          frameMaxMs: number;
          longTaskMaxMs: number;
        };
      }
    ).finishPerformanceProbe(),
  );
}
async function load(page: Page, configuration: ExperimentDefinition) {
  await page.goto('/');
  const data = createWorkspace(configuration);
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'fixture.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'protocol-studio-bundle', data })),
  });
  await expect(page.getByText(/검증한 bundle을 적용/)).toBeVisible();
}

for (const fixture of ['10k', '1MiB'] as const) {
  test(`actual ${fixture} execution, inspection, persistence and history stay within the declared UI budget`, async ({
    page,
    browser,
  }, info) => {
    await load(
      page,
      fixture === '10k' ? createEventLimitExperiment() : createMessageLimitExperiment(),
    );
    await startProbe(page);
    const began = performance.now();
    await page.getByRole('button', { name: '전체 실행', exact: true }).click();
    await expect(
      page.getByText(fixture === '10k' ? /실행 한도 도달 · 가상 시간/ : /관찰 완료 · 가상 시간/),
    ).toBeVisible({ timeout: 55_000 });
    const runMs = performance.now() - began;
    if (fixture === '10k') {
      await expect(page.locator('[data-event-id]')).toHaveCount(200);
      await expect(page.getByRole('navigation', { name: '기록 페이지 이동' })).toContainText(
        '10000개 이벤트',
      );
      await page.getByRole('button', { name: '기록 첫 페이지', exact: true }).click();
      await expect(page.locator('[data-event-id]').first()).toHaveAttribute('data-event-id', 'e-1');
      await page.getByRole('button', { name: '기록 다음 페이지', exact: true }).click();
      await expect(page.locator('[data-event-id]').first()).toHaveAttribute(
        'data-event-id',
        'e-201',
      );
      await page.getByRole('button', { name: '기록 최근 페이지', exact: true }).click();
      await expect(page.locator('[data-event-id]').last()).toHaveAttribute(
        'data-event-id',
        'e-10000',
      );
    }
    const controlBegan = performance.now();
    await page.getByLabel('메시지 중심으로 보기').check();
    await expect(page.getByLabel('메시지 중심으로 보기')).toBeChecked();
    const controlMs = performance.now() - controlBegan;
    await page.getByLabel('메시지 중심으로 보기').uncheck();
    const detailBegan = performance.now();
    if (fixture === '1MiB') await page.getByRole('button', { name: /send blob/ }).click();
    else await page.locator('[data-event-id]').first().click();
    await expect(
      page.getByRole('region', { name: '이벤트 상세' }).locator('pre').last(),
    ).toBeVisible();
    const detailMs = performance.now() - detailBegan;
    const detailChars = await page
      .getByRole('region', { name: '이벤트 상세' })
      .locator('pre')
      .last()
      .evaluate((element) => element.textContent?.length ?? 0);
    const saveBegan = performance.now();
    await page.getByRole('button', { name: '지금 저장', exact: true }).click();
    await expect(
      page.getByRole('region', { name: '로컬 저장과 파일' }).getByRole('status'),
    ).toHaveText('브라우저에 저장됨');
    const saveMs = performance.now() - saveBegan;
    const persisted = await page.evaluate(
      async () =>
        new Promise<{ events: number; bytes: number }>((resolve, reject) => {
          const opened = indexedDB.open('protocol-studio', 1);
          opened.onerror = () => reject(opened.error);
          opened.onsuccess = () => {
            const db = opened.result;
            const tx = db.transaction('workspace', 'readonly');
            const request = tx.objectStore('workspace').get('current');
            tx.oncomplete = () => {
              const view = request.result.data.runs.at(-1).view;
              const send = view.events.find((event: { kind: string }) => event.kind === 'send');
              db.close();
              resolve({ events: view.events.length, bytes: send?.data.wire.bytes.length ?? 0 });
            };
            tx.onabort = () => {
              db.close();
              reject(tx.error);
            };
          };
        }),
    );
    if (fixture === '10k') expect(persisted.events).toBe(10_000);
    else expect(persisted.bytes).toBe(1_048_576);
    const selection = page.getByRole('combobox', { name: '과거 실행 선택' });
    await selection.selectOption({ index: 1 });
    const cursorBegan = performance.now();
    await page.getByRole('button', { name: '기록 처음', exact: true }).click();
    await expect(page.getByRole('region', { name: '참여자 A 상태' })).toContainText('Idle');
    await page.getByRole('button', { name: '저장 시점', exact: true }).click();
    const cursorMs = performance.now() - cursorBegan;
    const probe = await finishProbe(page);
    const metrics = {
      fixture,
      browser: browser.version(),
      runMs,
      controlMs,
      detailMs,
      detailChars,
      saveMs,
      cursorMs,
      ...probe,
    };
    console.log(JSON.stringify(metrics));
    await info.attach(`${fixture}-metrics`, {
      body: JSON.stringify(metrics, null, 2),
      contentType: 'application/json',
    });
    expect(runMs).toBeLessThan(10_000);
    expect(controlMs).toBeLessThan(200);
    expect(detailMs).toBeLessThan(500);
    expect(detailChars).toBeLessThan(32_768);
    expect(cursorMs).toBeLessThan(500);
    expect(saveMs).toBeLessThan(3000);
    expect(probe.frameP95Ms).toBeLessThan(100);
    expect(probe.longTaskMaxMs).toBeLessThan(fixture === '10k' ? 250 : 1000);
  });
}
