import { expect, type Page, test } from '@playwright/test';

async function tab(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: '스택 작업' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function open(page: Page, example = 'stack_first_ack_loss') {
  await page.goto('/');
  await page.getByRole('button', { name: '계층 연결 스택', exact: true }).click();
  await page.getByRole('button', { name: `${example} 새 사본`, exact: true }).click();
  await page.getByRole('button', { name: '새 스택 전체 실행', exact: true }).click();
  await tab(page, '실행');
  await expect(page.locator('.stack-run-summary')).toContainText('completed');
  await page.getByRole('button', { name: '메시지 이동 경로', exact: true }).click();
  await expect(page.getByRole('region', { name: '메시지 이동 경로', exact: true })).toHaveAttribute(
    'data-journey-status',
    'available',
  );
}
for (const width of [1440, 768, 390])
  test(`message journey links fields, real retransmission and keyboard byte selection at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const panel = page.getByRole('region', { name: '메시지 이동 경로', exact: true });
    await expect(panel.getByRole('img', { name: '메시지의 네 계층 이동' })).toBeVisible();
    const cursor = page.getByLabel('스택 기록 위치 값', { exact: true });
    const saved = await cursor.inputValue();
    await expect(panel).toContainText('drop-targeted');
    await expect(panel).toContainText('선택 바이트 재송신 · 타이머');
    await panel.getByRole('button', { name: /^필드 text ·/ }).click();
    await expect(panel).toContainText('선택 범위 [48, 56) · 8 bytes');
    await expect(cursor).toHaveValue(saved);
    await expect(panel.locator('[data-journey-event]')).toHaveCount(20);
    const highlight = panel.getByRole('button', { name: '시퀀스에서 강조 · #2', exact: true });
    await highlight.click();
    await expect(highlight).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('region', { name: '스택 관찰 상세', exact: true })).toContainText(
      '선택 관찰 #2 · A/app',
    );
    await expect(cursor).toHaveValue(saved);
    await expect(
      page.getByRole('button', { name: /^스택 관찰 2 / }).locator('rect'),
    ).toHaveAttribute('fill', '#e4edf7');
    await panel.locator('summary').filter({ hasText: '원본 byte 창' }).click();
    await panel.getByRole('button', { name: '원본 byte 48 · 22', exact: true }).click();
    await expect(panel).toContainText('선택 범위 [48, 49) · 1 bytes');
    const selected = panel.locator('[data-journey-byte="48"]');
    await expect(selected).toBeFocused();
    await selected.press('ArrowRight');
    await expect(panel).toContainText('선택 범위 [49, 50) · 1 bytes');
    await expect(panel.locator('[data-journey-byte="49"]')).toBeFocused();
    await expect(cursor).toHaveValue(saved);
    expect(await panel.locator('[data-journey-byte]').count()).toBeLessThanOrEqual(256);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await panel.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: info.outputPath('message-journey.png') });
  });

test('saved HTTP journey uses its frozen source after draft edits and reload and replay hides future observations', async ({
  page,
}) => {
  await open(page, 'stack_http_post');
  const panel = page.getByRole('region', { name: '메시지 이동 경로', exact: true });
  await expect(panel).toContainText('연결된 앱 해석 1회');
  await page.getByRole('button', { name: '지금 저장', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '로컬 저장과 파일' }).getByRole('status'),
  ).toHaveText('브라우저에 저장됨');
  await tab(page, '편집');
  await page.getByLabel('스택 실험 이름', { exact: true }).fill('새 초안 이름');
  await page.getByRole('button', { name: '지금 저장', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '로컬 저장과 파일' }).getByRole('status'),
  ).toHaveText('브라우저에 저장됨');
  await page.reload();
  await tab(page, '기록·비교');
  await page
    .getByRole('button', { name: /^스택 기록 재생 ·/ })
    .first()
    .click();
  await page.getByRole('button', { name: '메시지 이동 경로', exact: true }).click();
  await expect(panel).toHaveAttribute('data-journey-status', 'available');
  await expect(panel).toContainText('송신 request');
  await panel.getByLabel('추적할 응용 송신', { exact: true }).selectOption({ index: 1 });
  await expect(panel.locator('.journey-summary')).toContainText('B/app · 송신 response');
  const first = panel.locator('[data-journey-event]').first();
  const replay = first.getByRole('button', { name: /^이 기록까지 재생/ });
  const number = (await replay.textContent())?.split('#').at(-1)?.trim();
  await replay.click();
  await expect(page.getByLabel('스택 기록 위치 값', { exact: true })).toHaveValue(number ?? '');
  await expect(panel).toContainText('현재 기록 위치까지의 관찰');
  await expect(panel).toContainText('연결된 앱 해석 0회');
  await page.getByRole('button', { name: '기록 처음', exact: true }).click();
  await expect(panel).toHaveAttribute('data-journey-status', 'unavailable');
  await expect(panel.locator('[data-journey-byte]')).toHaveCount(0);
  await page.getByRole('button', { name: '저장 시점', exact: true }).click();
  await expect(panel).toContainText('연결된 앱 해석 1회');
  await expect(panel.locator('.journey-summary')).toContainText('B/app · 송신 response');
});
