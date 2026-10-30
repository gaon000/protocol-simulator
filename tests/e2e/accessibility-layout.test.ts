import { expect, test, type Page } from '@playwright/test';

async function keyboardOpen(page: Page, name: string) {
  const button = page
    .getByRole('navigation', { name: '작업 공간' })
    .getByRole('button', { name, exact: true });
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-current', 'page');
}

for (const width of [390, 768, 1440]) {
  test(`keyboard, named controls, errors, history and panel layout work at ${width}px`, async ({
    page,
    browserName,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: '실험 구성', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: '본문으로 이동' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();
    for (const name of ['실험 구성', '프로토콜', '통신 환경', '시나리오·검증', '실행']) {
      await keyboardOpen(page, name);
      const unnamed = await page.locator('button,input,select,textarea').evaluateAll((elements) =>
        elements
          .filter((element) => {
            if (
              !(element instanceof HTMLElement) ||
              element.getClientRects().length === 0 ||
              element.closest('[hidden]')
            )
              return false;
            const labelledBy = element
              .getAttribute('aria-labelledby')
              ?.split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent ?? '')
              .join('');
            const labels =
              element instanceof HTMLInputElement ||
              element instanceof HTMLSelectElement ||
              element instanceof HTMLTextAreaElement
                ? Array.from(element.labels ?? [])
                    .map((label) => label.textContent ?? '')
                    .join('')
                : '';
            const name =
              element.getAttribute('aria-label') ||
              labelledBy ||
              labels ||
              (element.tagName === 'BUTTON' ? element.textContent : '');
            return !name?.trim();
          })
          .map((element) => element.outerHTML.slice(0, 150)),
      );
      expect(unnamed).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    await keyboardOpen(page, '프로토콜');
    const input = page.locator('[data-path="/definitions/0/messages/0/fields/0/name"]');
    await input.focus();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('button', { name: '전체 실행', exact: true })).toBeDisabled();
    await keyboardOpen(page, '실험 구성');
    const diagnostic = page
      .getByRole('region', { name: '정의 진단' })
      .getByRole('button')
      .filter({ hasText: '/definitions/0/messages/0/fields/0/name' });
    await diagnostic.focus();
    await page.keyboard.press('Enter');
    await expect(input).toBeFocused();
    await page.keyboard.type('number');
    const run = page.getByRole('button', { name: '전체 실행', exact: true });
    await run.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText(/관찰 완료 · 가상 시간/)).toBeVisible();
    await page.getByRole('combobox', { name: '과거 실행 선택' }).selectOption({ index: 1 });
    const slider = page.getByRole('slider', { name: '기록 재생 위치', exact: true });
    await slider.focus();
    await page.keyboard.press('Home');
    await expect(slider).toHaveValue('0');
    await expect(page.getByRole('region', { name: '참여자 A 상태' })).toContainText('Idle');
    await page.keyboard.press('End');
    await expect(page.getByRole('region', { name: '기대 조건 결과' })).toContainText('통과');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (browserName === 'chromium' && width !== 768)
      await page.screenshot({ path: info.outputPath(`run-${width}.png`) });
    await page.getByRole('button', { name: '실험 시작', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: '내 실험' })).toBeVisible();
    if (browserName === 'chromium' && width !== 768)
      await page.screenshot({ path: info.outputPath(`library-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
