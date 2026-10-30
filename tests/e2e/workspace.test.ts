import { expect, test, type Page } from '@playwright/test';

async function openView(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: '작업 공간' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function runAll(page: Page) {
  await page.getByRole('button', { name: /^(새 설정으로 )?전체 실행$/ }).click();
  await expect(page.getByText(/관찰 완료 · 가상 시간/)).toBeVisible();
}
function field(page: Page, path: string) {
  return page.locator(`[data-path="${path}"]`);
}

test('runs the editable production starter and exposes real message, state, cause and rule records', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page).toHaveTitle('Protocol Studio');
  await runAll(page);
  await expect(page.getByRole('region', { name: '참여자 A 상태' })).toContainText('A · Done');
  await expect(
    page.getByRole('region', { name: '기대 조건 결과' }).getByRole('listitem'),
  ).toHaveCount(4);
  await expect(page.getByRole('region', { name: '기대 조건 결과' })).not.toContainText('실패');
  await page.getByRole('button', { name: /send ping/ }).click();
  await expect(page.getByRole('region', { name: '이벤트 상세' })).toContainText('"bytes"');
  await page.getByRole('button', { name: /^원인 이벤트/ }).click();
  await expect(page.getByRole('region', { name: '이벤트 상세' })).toContainText('input');
  await page.getByRole('button', { name: /send ping/ }).click();
  await page.getByRole('button', { name: /규칙 start 편집 위치/ }).click();
  await expect(field(page, '/definitions/0/rules/0')).toBeFocused();
  expect(errors).toEqual([]);
});

test('changing a schema default changes actual received bytes and preserves the old snapshot until rerun', async ({
  page,
}) => {
  await page.goto('/');
  await runAll(page);
  await openView(page, '프로토콜');
  await field(page, '/definitions/0/messages/0/fields/1/defaultValue').fill('수정됨');
  await expect(page.getByText(/초안 변경됨/)).toBeVisible();
  await openView(page, '실행');
  await page.getByRole('button', { name: /parsed ping/ }).click();
  await expect(page.getByRole('region', { name: '이벤트 상세' })).toContainText('안녕');
  await runAll(page);
  await page.getByRole('button', { name: /parsed ping/ }).click();
  await expect(page.getByRole('region', { name: '이벤트 상세' })).toContainText('수정됨');
  await expect(page.getByText(/동일 설정/)).toBeVisible();
});

test('editing response conditions changes rule selection and links runtime errors to the protocol', async ({
  page,
}) => {
  await page.goto('/');
  await openView(page, '프로토콜');
  await field(page, '/definitions/0/rules/2/condition/operator').selectOption('ne');
  await runAll(page);
  await expect(page.getByRole('region', { name: '실행 진단' })).toContainText('unmatched-event');
  await expect(page.getByRole('region', { name: '기대 조건 결과' })).toContainText('미판정');
  await page.getByRole('region', { name: '실행 진단' }).getByRole('button').first().click();
  await expect(page.getByRole('heading', { name: '프로토콜', exact: true })).toBeVisible();
});

test('invalid form values block execution and a diagnostic focuses the exact editor control', async ({
  page,
}) => {
  await page.goto('/');
  await openView(page, '프로토콜');
  await field(page, '/definitions/0/messages/0/fields/0/name').fill('');
  await expect(page.getByRole('button', { name: '전체 실행', exact: true })).toBeDisabled();
  await openView(page, '실험 구성');
  await page
    .getByRole('region', { name: '정의 진단' })
    .getByRole('button')
    .filter({ hasText: '/definitions/0/messages/0/fields/0/name' })
    .click();
  await expect(field(page, '/definitions/0/messages/0/fields/0/name')).toBeFocused();
  await expect(field(page, '/definitions/0/messages/0/fields/0/name')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await page.keyboard.type('serial');
  await expect(page.getByRole('button', { name: '전체 실행', exact: true })).toBeEnabled();
});

test('unfinished JSON remains visible across navigation and blocks execution until repaired', async ({
  page,
}) => {
  await page.goto('/');
  await openView(page, '프로토콜');
  await field(page, '/definitions/0/variables/0/initial').fill('{');
  await openView(page, '실험 구성');
  await expect(page.getByRole('button', { name: '전체 실행', exact: true })).toBeDisabled();
  await page
    .getByRole('region', { name: '정의 진단' })
    .getByRole('button', { name: /json-syntax/ })
    .click();
  await expect(field(page, '/definitions/0/variables/0/initial')).toHaveValue('{');
  await field(page, '/definitions/0/variables/0/initial').fill('0');
  await runAll(page);
  await expect(page.getByRole('region', { name: '기대 조건 결과' })).not.toContainText('미판정');
});

test('step, play, pause and reset fence pending callbacks and clear participant state', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-10-30T00:00:00Z') });
  await page.goto('/');
  await page.clock.pauseAt(new Date('2026-10-30T01:00:00Z'));
  await openView(page, '통신 환경');
  await field(page, '/environment/directions/AtoB/chunkBytes').fill('1');
  await field(page, '/environment/directions/BtoA/chunkBytes').fill('1');
  await page.getByRole('button', { name: '한 단계', exact: true }).click();
  await expect(page.getByText(/처리 이벤트 1$/)).toBeVisible();
  await page.getByRole('button', { name: '전체 실행', exact: true }).click();
  await page.getByRole('button', { name: '일시 정지', exact: true }).click();
  const paused = await page.getByText(/일시 정지 · 가상 시간/).textContent();
  await page.clock.runFor(130);
  await expect(page.getByText(/일시 정지 · 가상 시간/)).toHaveText(paused ?? '');
  await page.getByRole('button', { name: '전체 실행', exact: true }).click();
  await page.getByRole('button', { name: '실행 초기화', exact: true }).click();
  await page.clock.runFor(130);
  await expect(page.getByRole('heading', { name: '편집한 실험을 실행하세요' })).toBeVisible();
  await page.getByRole('button', { name: '한 단계', exact: true }).click();
  await expect(page.getByText(/처리 이벤트 1$/)).toBeVisible();
});

test('profiles and ideal environment settings drive the actual codec and timeout result', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('radio', { name: /^데이터그램/ }).check();
  await page.getByRole('radio', { name: '전송 계층', exact: false }).check();
  await expect(page.getByRole('radio', { name: '바이트 스트림', exact: false })).toBeDisabled();
  await runAll(page);
  await page.getByRole('button', { name: /send ping/ }).click();
  await expect(page.getByRole('region', { name: '이벤트 상세' })).toContainText('"packet"');
  await openView(page, '통신 환경');
  await field(page, '/environment/directions/BtoA/delayMs').fill('1000');
  await runAll(page);
  await expect(page.getByRole('region', { name: '참여자 A 상태' })).toContainText('Failed');
  await expect(page.getByRole('region', { name: '기대 조건 결과' })).toContainText('실패');
});

test('authors and runs Ping/Pong from a blank experiment using message, state, rule and scenario forms', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '실험 시작', exact: true }).click();
  await page.getByRole('button', { name: '빈 실험 만들기' }).click();
  await expect(page.getByRole('button', { name: '전체 실행', exact: true })).toBeDisabled();
  await openView(page, '프로토콜');
  for (const [index, id] of ['ping', 'pong'].entries()) {
    await page.getByRole('button', { name: '메시지 추가', exact: true }).click();
    await field(page, `/definitions/0/messages/${index}/id`).fill(id);
    await field(page, `/definitions/0/messages/${index}/label`).fill(id.toUpperCase());
  }
  for (const [index, id] of ['Waiting', 'Done'].entries()) {
    await page.getByRole('button', { name: '상태 추가', exact: true }).click();
    await field(page, `/definitions/0/states/${index + 1}/id`).fill(id);
  }
  await field(page, '/definitions/0/states/2/terminal').check();
  for (const index of [0, 1, 2]) {
    await page.getByRole('button', { name: '규칙 추가', exact: true }).click();
    const path = `/definitions/0/rules/${index}`;
    await field(page, `${path}/ignore`).uncheck();
    if (index === 0) await field(page, `${path}/nextStateId`).selectOption('Waiting');
    if (index > 0) await field(page, `${path}/event`).selectOption('receive');
    if (index === 2) {
      await field(page, `${path}/fromStateId`).selectOption('Waiting');
      await field(page, `${path}/event/messageId`).selectOption('pong');
      await field(page, `${path}/nextStateId`).selectOption('Done');
    }
    await field(page, path).getByRole('button', { name: '동작 추가', exact: true }).click();
    if (index === 2) await field(page, `${path}/actions/0/kind`).selectOption('deliver');
    if (index > 0) await field(page, `${path}/actions/0/messageId`).selectOption('pong');
  }
  await openView(page, '시나리오·검증');
  await page.getByRole('button', { name: '입력 추가', exact: true }).click();
  await page.getByRole('button', { name: '기대 조건 추가', exact: true }).click();
  await field(page, '/scenario/expectations/0/stateId').selectOption('Done');
  await runAll(page);
  await expect(page.getByRole('region', { name: '기대 조건 결과' })).toContainText(
    'expect_1 · 통과',
  );
  await expect(page.getByRole('button', { name: /send ping/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /send pong/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /deliver pong/ })).toBeVisible();
});

test('keeps editing and run controls usable on a narrow viewport with keyboard input', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('실험 이름', { exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Keyboard experiment');
  await page.keyboard.press('Tab');
  await runAll(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expect(page.getByText('Keyboard experiment', { exact: true })).toBeVisible();
  await expect(page.getByText(/이 브라우저에 자동 저장/)).toBeVisible();
});

test('editing a running draft pauses the captured run and the next step starts a fresh generation', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-10-30T00:00:00Z') });
  await page.goto('/');
  await page.clock.pauseAt(new Date('2026-10-30T01:00:00Z'));
  await openView(page, '통신 환경');
  await field(page, '/environment/directions/AtoB/chunkBytes').fill('1');
  await page.getByRole('button', { name: '전체 실행', exact: true }).click();
  await openView(page, '통신 환경');
  await field(page, '/environment/directions/AtoB/delayMs').fill('50');
  await expect(page.getByRole('button', { name: '일시 정지', exact: true })).toBeDisabled();
  await expect(page.getByText(/초안 변경됨/)).toBeVisible();
  await page.clock.runFor(130);
  await page.getByRole('button', { name: '한 단계', exact: true }).click();
  await expect(page.getByText(/처리 이벤트 1$/)).toBeVisible();
  await expect(page.getByText(/동일 설정/)).toBeVisible();
});
