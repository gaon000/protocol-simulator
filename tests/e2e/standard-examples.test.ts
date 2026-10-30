import { expect, test, type Page } from '@playwright/test';
import { createSimulation } from '../../src/application/create-simulation.ts';
import { EXAMPLES, getExampleOriginal } from '../../src/examples/catalog.ts';

const field = (page: Page, path: string) => page.locator(`[data-path="${path}"]`);
async function view(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: '작업 공간' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function open(page: Page, id: string) {
  const example = EXAMPLES.find((item) => item.id === id);
  if (!example) throw new Error('Missing fixture');
  await page.goto('/');
  await page.getByRole('button', { name: '실험 시작', exact: true }).click();
  await page
    .getByRole('region', { name: `${example.title} 예제`, exact: true })
    .getByRole('button', { name: example.copyLabel, exact: true })
    .click();
}
async function run(page: Page) {
  await page.getByRole('button', { name: /^(새 설정으로 )?전체 실행$/ }).click();
  await expect(page.getByText(/관찰 완료 · 가상 시간/)).toBeVisible();
}

for (const example of EXAMPLES)
  test(`the browser and core fixture agree on every catalog result: ${example.id}`, async ({
    page,
  }) => {
    const created = createSimulation(getExampleOriginal(example.id));
    expect(created.success).toBe(true);
    if (!created.success) return;
    const fixture = created.value.run();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await open(page, example.id);
    const origin = page.getByRole('region', { name: '원본 예제 정보' });
    await expect(origin).toContainText(`사용자 정의 사본 · ${example.title} · 원본 v1`);
    await origin.locator('summary').click();
    for (const source of example.sources)
      await expect(origin.getByRole('link', { name: source.title })).toHaveAttribute(
        'href',
        source.url,
      );
    await expect(origin).toContainText('생략·제한');
    await run(page);
    for (const actor of ['A', 'B'] as const)
      await expect(page.getByRole('region', { name: `참여자 ${actor} 상태` })).toContainText(
        `${actor} · ${fixture.participants[actor].stateId}`,
      );
    const checks = page.getByRole('region', { name: '기대 조건 결과' }).getByRole('listitem');
    await expect(checks).toHaveCount(fixture.expectations.length);
    for (const [index, item] of fixture.expectations.entries())
      await expect(checks.nth(index)).toContainText(
        `${item.expectationId} · ${item.status === 'pass' ? '통과' : item.status === 'fail' ? '실패' : '미판정'}`,
      );
    if (fixture.diagnostics.length)
      for (const code of example.diagnosticCodes)
        await expect(page.getByRole('region', { name: '실행 진단' })).toContainText(code);
    else await expect(page.getByRole('region', { name: '실행 진단' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

test('HTTP body edits change actual Content-Length bytes and reopening the source makes a fresh original copy', async ({
  page,
}) => {
  await open(page, 'http_post');
  await run(page);
  await page.getByRole('button', { name: /send request/ }).click();
  await expect(page.getByRole('region', { name: '전송 바이트 미리보기' })).toContainText(
    'Content-Length: 15 bytes · 실제 본문 15 bytes',
  );
  await expect(page.getByRole('region', { name: '전송 바이트 미리보기' })).toContainText(
    'POST /echo HTTP/1.1',
  );
  await view(page, '시나리오·검증');
  await field(page, '/scenario/inputs/0/message/values/body').fill('한글🙂');
  await run(page);
  await page.getByRole('button', { name: /send request/ }).click();
  await expect(page.getByRole('region', { name: '전송 바이트 미리보기' })).toContainText(
    'Content-Length: 10 bytes · 실제 본문 10 bytes',
  );
  await expect(page.getByRole('region', { name: '기대 조건 결과' })).toContainText(
    'response_content · 실패',
  );
  await page.getByRole('button', { name: '실험 시작', exact: true }).click();
  await page.getByRole('button', { name: 'HTTP POST 사본 만들기', exact: true }).click();
  await view(page, '시나리오·검증');
  await expect(field(page, '/scenario/inputs/0/message/values/body')).toHaveValue('안녕하세요');
});

test('a malformed raw HTTP request can be repaired in the real form and then parses successfully', async ({
  page,
}) => {
  await open(page, 'http_bad_header');
  await run(page);
  await expect(page.getByRole('region', { name: '실행 진단' })).toContainText('http-header');
  await view(page, '시나리오·검증');
  await field(page, '/scenario/inputs/0/message/values/wire').fill(
    JSON.stringify('GET / HTTP/1.1\r\nHost: example.test\r\nContent-Length: 0\r\n\r\n'),
  );
  await run(page);
  await expect(page.getByRole('region', { name: '실행 진단' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '참여자 A 상태' })).toContainText('A · Done');
  await expect(page.getByRole('button', { name: /parsed request/ })).toBeVisible();
});

test('HTTP service mismatch is blocked and points back to the protocol rather than silently changing codecs', async ({
  page,
}) => {
  await open(page, 'http_get');
  await page.getByRole('radio', { name: /^데이터그램/ }).check();
  await expect(page.getByRole('button', { name: '전체 실행', exact: true })).toBeDisabled();
  await page
    .getByRole('region', { name: '정의 진단' })
    .getByRole('button', { name: /service-incompatible/ })
    .click();
  await expect(page.getByRole('heading', { name: '프로토콜', exact: true })).toBeVisible();
  await expect(field(page, '/definitions/0')).toBeFocused();
  await expect(page.getByText(/정의 버전.*http-1.1/)).toBeVisible();
});

test('TCP shows the intermediate state and actual seq/ack fields, including edits to the passive ISN', async ({
  page,
}) => {
  await open(page, 'tcp_handshake');
  await page.getByRole('button', { name: '한 단계', exact: true }).click();
  await expect(page.getByRole('region', { name: '참여자 A 상태' })).toContainText('A · SYN-SENT');
  await expect(page.getByRole('region', { name: '참여자 B 상태' })).toContainText('B · LISTEN');
  await run(page);
  await page.getByRole('button', { name: /send syn_ack/ }).click();
  const inspector = page.getByRole('region', { name: '이벤트 상세' });
  await expect(
    inspector.getByRole('rowheader', { name: 'ack', exact: true }).locator('..').getByRole('cell'),
  ).toHaveText('101');
  await expect(
    inspector.getByRole('rowheader', { name: 'seq', exact: true }).locator('..').getByRole('cell'),
  ).toHaveText('300');
  await view(page, '프로토콜');
  await page.getByLabel('편집할 정의').selectOption('1');
  await field(page, '/definitions/1/variables/0/initial').fill('400');
  await run(page);
  await page.getByRole('button', { name: /send ack/ }).click();
  await expect(
    inspector.getByRole('rowheader', { name: 'seq', exact: true }).locator('..').getByRole('cell'),
  ).toHaveText('101');
  await expect(
    inspector.getByRole('rowheader', { name: 'ack', exact: true }).locator('..').getByRole('cell'),
  ).toHaveText('401');
  await expect(page.getByRole('region', { name: '기대 조건 결과' })).not.toContainText('실패');
});
