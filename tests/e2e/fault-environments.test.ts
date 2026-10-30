import { expect, test, type Page } from '@playwright/test';

const field = (page: Page, path: string) => page.locator(`[data-path="${path}"]`);
async function view(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: '작업 공간' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function reliable(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '실험 시작', exact: true }).click();
  await page.getByRole('button', { name: '재전송 실험 새 사본' }).click();
}
async function run(page: Page) {
  await page.getByRole('button', { name: /^(새 설정으로 )?전체 실행$/ }).click();
  await expect(page.getByText(/관찰 완료 · 가상 시간/)).toBeVisible();
}

test('the same editable protocol survives an ACK loss and shows one upper delivery plus its cause', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await reliable(page);
  await run(page);
  await expect(page.getByRole('region', { name: '참여자 A 상태' })).toContainText(
    '최초 송신 1회 · 재시도 0회',
  );
  await view(page, '통신 환경');
  await page.getByRole('button', { name: '특정 손실 추가', exact: true }).click();
  await field(page, '/environment/targetedDrops/0/direction').selectOption('BtoA');
  await run(page);
  await expect(page.getByRole('region', { name: '참여자 A 상태' })).toContainText(
    '최초 송신 1회 · 재시도 1회',
  );
  await expect(page.getByRole('region', { name: '기대 조건 결과' })).not.toContainText('실패');
  await expect(page.getByRole('button', { name: /deliver data/ })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /send data/ })).toHaveCount(2);
  await page.getByRole('button', { name: /datagram-decision drop-targeted/ }).click();
  const inspector = page.getByRole('region', { name: '이벤트 상세' });
  await expect(inspector).toContainText('"direction": "BtoA"');
  await inspector.getByRole('button', { name: /^원인 이벤트/ }).click();
  await expect(inspector).toContainText('"messageId": "ack"');
  expect(errors).toEqual([]);
});

test('editing the retry allowance and losing all DATA ends with finite failure, not undetermined success', async ({
  page,
}) => {
  await reliable(page);
  await view(page, '프로토콜');
  await field(page, '/definitions/0/variables/6/initial').fill('1');
  await view(page, '통신 환경');
  await field(page, '/environment/directions/AtoB/lossRate').fill('1');
  await run(page);
  await expect(page.getByRole('region', { name: '참여자 A 상태' })).toContainText('A · Failed');
  await expect(page.getByRole('region', { name: '참여자 A 상태' })).toContainText(
    '최초 송신 1회 · 재시도 1회',
  );
  await expect(page.getByRole('button', { name: /send data/ })).toHaveCount(2);
  await expect(page.getByRole('button', { name: /deliver data/ })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '기대 조건 결과' })).toContainText('실패');
  await expect(page.getByRole('region', { name: '기대 조건 결과' })).not.toContainText('미판정');
});

test('seeded faults reproduce the visible sequence and invalid fault probabilities block execution', async ({
  page,
}) => {
  await reliable(page);
  await view(page, '통신 환경');
  for (const direction of ['AtoB', 'BtoA']) {
    await field(page, `/environment/directions/${direction}/delayMs`).fill('60');
    await field(page, `/environment/directions/${direction}/jitterMs`).fill('50');
    await field(page, `/environment/directions/${direction}/lossRate`).fill('0.3');
    await field(page, `/environment/directions/${direction}/duplicateRate`).fill('0.7');
  }
  await run(page);
  const sequence = await page.locator('.trace-row').allTextContents();
  await run(page);
  expect(await page.locator('.trace-row').allTextContents()).toEqual(sequence);
  await view(page, '통신 환경');
  await field(page, '/seed').fill('0');
  await run(page);
  expect(await page.locator('.trace-row').allTextContents()).not.toEqual(sequence);
  await view(page, '통신 환경');
  await field(page, '/environment/directions/AtoB/lossRate').fill('1.1');
  await expect(page.getByRole('button', { name: '새 설정으로 전체 실행' })).toBeDisabled();
  await expect(field(page, '/environment/directions/AtoB/lossRate')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
});

test('stream failure settings invoke the authored connection rule and reveal the cutoff event', async ({
  page,
}) => {
  await page.goto('/');
  await view(page, '프로토콜');
  await page.getByRole('button', { name: '규칙 추가', exact: true }).click();
  const path = '/definitions/0/rules/5';
  await field(page, `${path}/ignore`).uncheck();
  await field(page, `${path}/event`).selectOption('connection');
  await field(page, `${path}/event/state`).selectOption('failed');
  await field(page, `${path}/nextStateId`).selectOption('Failed');
  await field(page, path).getByRole('button', { name: '동작 추가', exact: true }).click();
  await field(page, `${path}/actions/0/kind`).selectOption('finish');
  await field(page, `${path}/actions/0/outcome`).selectOption('failure');
  await view(page, '통신 환경');
  await page.getByRole('button', { name: '연결 이벤트 추가' }).click();
  await field(page, '/environment/connections/0/kind').selectOption('fail');
  await field(page, '/environment/connections/0/timeMs').fill('5');
  await run(page);
  await expect(page.getByRole('region', { name: '참여자 B 상태' })).toContainText('B · Failed');
  await expect(page.getByRole('region', { name: '실행 진단' })).toHaveCount(0);
  await page.getByRole('button', { name: /stream-cutoff/ }).click();
  await expect(page.getByRole('region', { name: '이벤트 상세' })).toContainText('"cutoffMs": 5');
});

test('coalesced stream chunks link to both real sends and still decode two messages', async ({
  page,
}) => {
  await page.goto('/');
  await view(page, '프로토콜');
  await field(page, '/definitions/0/rules/0')
    .getByRole('button', { name: '동작 추가', exact: true })
    .click();
  const action = field(page, '/definitions/0/rules/0/actions/3');
  await action.getByRole('checkbox', { name: 'number 값 지정' }).check();
  await view(page, '통신 환경');
  await field(page, '/environment/directions/AtoB/chunkBytes').fill('65536');
  await field(page, '/environment/directions/BtoA/chunkBytes').fill('65536');
  await run(page);
  await expect(page.getByRole('button', { name: /parsed ping/ })).toHaveCount(2);
  await page
    .locator('.trace-row.actor-B')
    .filter({ hasText: /receive/ })
    .first()
    .click();
  const inspector = page.getByRole('region', { name: '이벤트 상세' });
  await expect(inspector.getByRole('button', { name: /^송신 이벤트/ })).toHaveCount(2);
  await inspector
    .getByRole('button', { name: /^송신 이벤트/ })
    .last()
    .click();
  await expect(inspector).toContainText('send');
  await expect(inspector).toContainText('"messageId": "ping"');
});
