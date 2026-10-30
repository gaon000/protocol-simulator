import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { WorkspaceEnvelope } from '../../src/domain/workspace-model.ts';

function field(page: Page, path: string) {
  return page.locator(`[data-path="${path}"]`);
}
async function open(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: '작업 공간' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function save(page: Page) {
  await page.getByRole('button', { name: '지금 저장', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '로컬 저장과 파일' }).getByRole('status'),
  ).toHaveText('브라우저에 저장됨');
}
async function stored(page: Page): Promise<WorkspaceEnvelope> {
  return page.evaluate(
    async () =>
      new Promise<WorkspaceEnvelope>((resolve, reject) => {
        const request = indexedDB.open('protocol-studio', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction('workspace', 'readonly');
          const get = transaction.objectStore('workspace').get('current');
          transaction.oncomplete = () => {
            database.close();
            resolve(get.result as WorkspaceEnvelope);
          };
          transaction.onabort = () => {
            database.close();
            reject(transaction.error);
          };
        };
      }),
  );
}
async function run(page: Page) {
  await page.getByRole('button', { name: /^(새 설정으로 |현재 초안 )?전체 실행$/ }).click();
  await expect(page.getByText(/관찰 완료 · 가상 시간/)).toBeVisible();
}

test('native IndexedDB restores authored drafts, unfinished JSON and frozen run history after reload', async ({
  page,
}) => {
  await page.goto('/');
  await field(page, '/label').fill('새로고침 실험');
  await run(page);
  await open(page, '프로토콜');
  await field(page, '/definitions/0/variables/0/initial').fill('{');
  await field(page, '/definitions/0/messages/0/fields/0/name').fill('');
  await save(page);
  const before = await stored(page);
  expect(before.data.runs).toHaveLength(1);
  await page.reload();
  await expect(field(page, '/label')).toHaveValue('새로고침 실험');
  await expect(page.getByRole('button', { name: '전체 실행', exact: true })).toBeDisabled();
  await open(page, '프로토콜');
  await expect(field(page, '/definitions/0/variables/0/initial')).toHaveValue('{');
  await expect(field(page, '/definitions/0/messages/0/fields/0/name')).toHaveValue('');
  await open(page, '실행');
  await page.getByLabel('과거 실행 선택').selectOption(before.data.runs[0]?.id ?? '');
  await expect(page.getByRole('region', { name: '참여자 A 상태' })).toContainText('Done');
  await expect(page.getByRole('region', { name: '기대 조건 결과' })).not.toContainText('미판정');
  expect((await stored(page)).data.runs).toEqual(before.data.runs);
  await page.getByRole('button', { name: '이 snapshot으로 재실행', exact: true }).click();
  await expect(
    page.getByText('snapshot 재실행의 의미적 기록·상태·판정이 일치합니다.'),
  ).toBeVisible();
  await open(page, '프로토콜');
  await expect(field(page, '/definitions/0/variables/0/initial')).toHaveValue('{');
  await field(page, '/definitions/0/variables/0/initial').fill('0');
  await field(page, '/definitions/0/messages/0/fields/0/name').fill('number');
  await expect(page.getByRole('button', { name: /전체 실행$/ })).toBeEnabled();
});

test('read-only replay changes cursor state, survives draft deletion and reexecutes the original snapshot', async ({
  page,
}) => {
  await page.goto('/');
  await field(page, '/label').fill('보존할 실행');
  await run(page);
  await save(page);
  const before = await stored(page);
  const record = before.data.runs[0];
  expect(record).toBeDefined();
  await page.getByLabel('과거 실행 선택').selectOption(record?.id ?? '');
  await page.getByRole('button', { name: '기록 처음', exact: true }).click();
  await expect(page.getByRole('region', { name: '참여자 A 상태' })).toContainText('Idle');
  await expect(page.getByRole('region', { name: '기대 조건 결과' })).toContainText('미판정');
  await page.getByRole('button', { name: '다음 이벤트', exact: true }).click();
  await expect(page.getByLabel('기록 재생 위치', { exact: true })).toHaveValue('1');
  await page.getByRole('button', { name: '저장 시점', exact: true }).click();
  await expect(page.getByRole('region', { name: '참여자 A 상태' })).toContainText('Done');
  await page.getByRole('button', { name: '실험 시작', exact: true }).click();
  await page.getByRole('button', { name: 'TCP 연결 수립 사본 만들기', exact: true }).click();
  await field(page, '/label').fill('남길 초안');
  await page.getByRole('button', { name: '실험 시작', exact: true }).click();
  await page.getByRole('button', { name: '초안 삭제 · 보존할 실행', exact: true }).click();
  await page.getByRole('button', { name: /기록 열기 · 보존할 실행/ }).click();
  await page.getByRole('button', { name: '이 snapshot으로 재실행', exact: true }).click();
  await expect(
    page.getByText('snapshot 재실행의 의미적 기록·상태·판정이 일치합니다.'),
  ).toBeVisible();
  await save(page);
  const after = await stored(page);
  expect(after.data.drafts.map((item) => item.configuration.label)).toEqual(['남길 초안']);
  expect(after.data.runs.find((item) => item.id === record?.id)?.view).toEqual(record?.view);
  expect(after.data.runs).toHaveLength(2);
  await page.reload();
  await expect(field(page, '/label')).toHaveValue('남길 초안');
  await open(page, '실행');
  await page.getByLabel('과거 실행 선택').selectOption(record?.id ?? '');
  await expect(page.getByRole('region', { name: '참여자 A 상태' })).toContainText('Done');
});

test('exported bundle imports as a new copy on ID collision; corrupt and oversized files leave memory unchanged', async ({
  page,
}) => {
  await page.goto('/');
  await field(page, '/label').fill('파일 왕복');
  await run(page);
  await save(page);
  const before = await stored(page);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles(path ?? '');
  await expect(page.getByText(/검증한 bundle을 적용/)).toBeVisible();
  await save(page);
  const merged = await stored(page);
  expect(merged.data.drafts).toHaveLength(2);
  expect(merged.data.runs).toHaveLength(2);
  expect(new Set(merged.data.drafts.map((item) => item.id)).size).toBe(2);
  expect(merged.data.runs[0]).toEqual(before.data.runs[0]);
  expect(merged.data.runs[1]?.view).toEqual(before.data.runs[0]?.view);
  for (const contents of [
    '{',
    JSON.stringify({ schemaVersion: 999, kind: 'protocol-studio-bundle', data: before.data }),
  ]) {
    await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
      name: 'corrupt.json',
      mimeType: 'application/json',
      buffer: Buffer.from(contents),
    });
    await expect(
      page.getByRole('region', { name: '로컬 저장과 파일' }).getByRole('alert'),
    ).toBeVisible();
    await expect(field(page, '/label')).toHaveValue('파일 왕복');
    expect((await stored(page)).data).toEqual(merged.data);
  }
  const directory = await mkdtemp(join(tmpdir(), 'protocol-large-'));
  try {
    const oversized = join(directory, 'oversized.json');
    await writeFile(oversized, '');
    await truncate(oversized, 64 * 1024 * 1024 + 1);
    await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles(oversized);
    await expect(page.getByRole('alert')).toContainText('파일이 64 MiB 한도를 넘습니다.');
    expect((await stored(page)).data).toEqual(merged.data);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const mode of ['quota', 'abort-after-request-success']) {
  test(`IndexedDB ${mode} keeps the last committed workspace and retries without losing edits`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
        const mode = sessionStorage.getItem('storage-test-failure');
        if (mode === 'quota')
          throw new DOMException('Simulated quota exhaustion', 'QuotaExceededError');
        const request = put.call(this, value, key);
        if (mode === 'abort-after-request-success')
          request.addEventListener('success', () => this.transaction.abort());
        return request;
      };
    });
    await page.goto('/');
    await field(page, '/label').fill('마지막 저장본');
    await save(page);
    const before = await stored(page);
    await page.evaluate((mode) => sessionStorage.setItem('storage-test-failure', mode), mode);
    await field(page, '/label').fill('실패 후 메모리');
    await page.getByRole('button', { name: '지금 저장', exact: true }).click();
    await expect(
      page.getByRole('region', { name: '로컬 저장과 파일' }).getByRole('status'),
    ).toHaveText('저장 실패 · 메모리 초안 유지');
    await expect(field(page, '/label')).toHaveValue('실패 후 메모리');
    expect(await stored(page)).toEqual(before);
    await page.evaluate(() => sessionStorage.removeItem('storage-test-failure'));
    await page.getByRole('button', { name: '저장 다시 시도', exact: true }).click();
    await expect(
      page.getByRole('region', { name: '로컬 저장과 파일' }).getByRole('status'),
    ).toHaveText('브라우저에 저장됨');
    await page.reload();
    await expect(field(page, '/label')).toHaveValue('실패 후 메모리');
  });
}

test('two real browser tabs detect revision conflicts and merge both versions on explicit retry', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await save(page);
  const second = await context.newPage();
  await second.goto('/');
  await expect(field(second, '/label')).toBeVisible();
  await field(page, '/label').fill('첫 번째 탭');
  await save(page);
  await field(second, '/label').fill('두 번째 탭');
  await second.getByRole('button', { name: '지금 저장', exact: true }).click();
  await expect(
    second.getByRole('region', { name: '로컬 저장과 파일' }).getByRole('status'),
  ).toHaveText('다른 탭과 저장 충돌 · 메모리 초안 유지');
  expect((await stored(second)).data.drafts[0]?.configuration.label).toBe('첫 번째 탭');
  await second.getByRole('button', { name: '저장 다시 시도', exact: true }).click();
  await expect(
    second.getByRole('region', { name: '로컬 저장과 파일' }).getByRole('status'),
  ).toHaveText('브라우저에 저장됨');
  expect((await stored(second)).data.drafts.map((item) => item.configuration.label).sort()).toEqual(
    ['두 번째 탭', '첫 번째 탭'],
  );
  await second.reload();
  await expect(field(second, '/label')).toHaveValue('두 번째 탭');
  await second.getByRole('button', { name: '실험 시작', exact: true }).click();
  await expect(
    second.getByRole('region', { name: '내 실험' }).getByRole('button', { name: /실험 열기/ }),
  ).toHaveCount(2);
});

test('referenced definition deletion is blocked; unused definition deletion preserves old snapshots', async ({
  page,
}) => {
  await page.goto('/');
  await run(page);
  await save(page);
  const record = (await stored(page)).data.runs[0];
  await open(page, '실험 구성');
  await page.getByRole('button', { name: '프로토콜 사본 추가', exact: true }).click();
  await page.getByRole('combobox', { name: '편집할 정의', exact: true }).selectOption('0');
  await page.getByRole('button', { name: '선택한 정의 삭제', exact: true }).click();
  await expect(
    page.getByText('참여자가 참조 중인 정의입니다. 참여자의 프로토콜을 먼저 변경하세요.'),
  ).toBeVisible();
  await open(page, '실험 구성');
  await page.getByRole('combobox', { name: '참여자 A 프로토콜', exact: true }).selectOption('1');
  await page.getByRole('combobox', { name: '참여자 B 프로토콜', exact: true }).selectOption('1');
  await open(page, '프로토콜');
  await page.getByRole('combobox', { name: '편집할 정의', exact: true }).selectOption('0');
  await page.getByRole('button', { name: '선택한 정의 삭제', exact: true }).click();
  await expect(
    page.getByRole('combobox', { name: '편집할 정의', exact: true }).locator('option'),
  ).toHaveCount(1);
  await save(page);
  expect((await stored(page)).data.runs[0]?.view).toEqual(record?.view);
  await open(page, '실행');
  await page.getByLabel('과거 실행 선택').selectOption(record?.id ?? '');
  await page.getByRole('button', { name: '이 snapshot으로 재실행', exact: true }).click();
  await expect(
    page.getByText('snapshot 재실행의 의미적 기록·상태·판정이 일치합니다.'),
  ).toBeVisible();
});

test('import captures cancellation of an unfinished live run, and deleting its record cannot resurrect it', async ({
  page,
}) => {
  await page.goto('/');
  await save(page);
  const base = (await stored(page)).data;
  await page.getByRole('button', { name: '한 단계', exact: true }).click();
  await expect(page.getByText(/일시 정지 · 가상 시간/)).toBeVisible();
  await save(page);
  const current = (await stored(page)).data.runs[0];
  expect(current?.view.status).toBe('paused');
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'valid.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({ schemaVersion: 1, kind: 'protocol-studio-bundle', data: base }),
    ),
  });
  await expect(page.getByText(/검증한 bundle을 적용/)).toBeVisible();
  await save(page);
  expect((await stored(page)).data.runs.find((item) => item.id === current?.id)?.view.status).toBe(
    'cancelled',
  );
  await run(page);
  await save(page);
  const completed = (await stored(page)).data.runs.at(-1);
  await page.getByLabel('과거 실행 선택').selectOption(completed?.id ?? '');
  await page.getByRole('button', { name: '이 기록 삭제', exact: true }).click();
  await open(page, '실험 구성');
  await field(page, '/label').fill('삭제 후 편집');
  await save(page);
  expect((await stored(page)).data.runs.map((item) => item.id)).toEqual([current?.id]);
});
