import { expect, test } from '@playwright/test';

test('opens the built workspace without runtime errors and does not claim simulation is available', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page).toHaveTitle('Protocol Studio');
  await expect(page.getByRole('heading', { name: '실험 구성', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '실행 준비 중' })).toBeDisabled();
  await expect(page.getByText('개발 단계 P0 · 실행 결과 없음 · 로컬 저장 미지원')).toBeVisible();
  expect(errors).toEqual([]);
});

test('keeps application/datagram available and restricts the v1 transport profile to datagrams', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('radio', { name: '데이터그램' }).check();
  await expect(page.getByRole('complementary')).toContainText('손실·중복·순서 역전');
  await page.getByRole('radio', { name: '응용 계층' }).check();
  await expect(page.getByRole('radio', { name: '데이터그램' })).toBeChecked();
  await page.getByRole('radio', { name: '바이트 스트림' }).check();
  await page.getByRole('radio', { name: '전송 계층' }).check();
  await expect(page.getByRole('radio', { name: '데이터그램' })).toBeChecked();
  await expect(page.getByRole('radio', { name: '바이트 스트림' })).toBeDisabled();
});

test('navigates to pending views and retains configuration while switching back', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('radio', { name: '전송 계층' }).check();
  await page.getByRole('button', { name: '프로토콜', exact: true }).click();
  await expect(page.getByRole('heading', { name: '프로토콜', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '구현 예정 기능' })).toContainText(
    '현재 프로토콜 편집과 통신 실행은 제공하지 않습니다',
  );
  await page.getByRole('button', { name: '실험 구성', exact: true }).click();
  await expect(page.getByRole('radio', { name: '전송 계층' })).toBeChecked();
});

test('keeps required controls usable without horizontal overflow on a narrow viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('radio', { name: '전송 계층' }).check();
  await expect(page.getByRole('radio', { name: '데이터그램' })).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
