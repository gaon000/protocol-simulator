import { expect, type Page, test } from '@playwright/test';
import type { WorkspaceV2Envelope } from '../../src/domain/workspace-v2-model.ts';

async function stack(page: Page, example = 'stack_first_ack_loss') {
  await page.goto('/');
  await page.getByRole('button', { name: '계층 연결 스택', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '프로토콜 스택 작업 공간', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: `${example} 새 사본`, exact: true }).click();
}
async function tab(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: '스택 작업' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function run(page: Page) {
  await page.getByRole('button', { name: '새 스택 전체 실행', exact: true }).click();
  await tab(page, '실행');
  await expect(page.locator('.stack-run-summary')).toContainText('completed');
  await expect(page.getByRole('region', { name: '스택 기대 조건' })).not.toContainText('fail');
  await expect(page.getByRole('region', { name: '스택 기대 조건' })).toContainText('pass');
}
async function save(page: Page) {
  await page.getByRole('button', { name: '지금 저장', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '로컬 저장과 파일' }).getByRole('status'),
  ).toHaveText('브라우저에 저장됨');
}
async function stored(page: Page): Promise<WorkspaceV2Envelope> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('protocol-studio', 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('workspace-v2', 'readonly');
          const get = tx.objectStore('workspace-v2').get('current');
          tx.oncomplete = () => {
            db.close();
            resolve(get.result);
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
  );
}

for (const width of [1440, 768, 390])
  test(`stack ACK-loss editing, actual diagrams and cursor fences at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await stack(page);
    await page.getByLabel('스택 실험 이름', { exact: true }).fill(`ACK 손실 ${width}`);
    await run(page);
    await expect(page.getByRole('img', { name: '스택 통신 시퀀스 그림' })).toBeVisible();
    await page.getByLabel('관찰할 인스턴스', { exact: true }).selectOption('B/app');
    await expect(page.getByRole('region', { name: '인스턴스 상태' })).toContainText('앱 전달 1');
    await page.getByRole('button', { name: '기록 처음', exact: true }).click();
    await expect(page.getByRole('region', { name: '인스턴스 상태' })).toContainText('앱 전달 0');
    await expect(page.getByRole('region', { name: '스택 기대 조건' })).toContainText(
      'undetermined',
    );
    await expect(page.getByRole('button', { name: /^스택 관찰 / })).toHaveCount(0);
    await page.getByRole('button', { name: '저장 시점', exact: true }).click();
    await expect(page.getByRole('region', { name: '인스턴스 상태' })).toContainText('앱 전달 1');
    const rule = page.locator('.stack-rule-list button').filter({ hasText: /^reply ·/ });
    await rule.click();
    await page.locator('.stack-event-links button').first().click();
    await page.getByRole('button', { name: '규칙·변수 이유', exact: true }).click();
    await expect(page.getByRole('region', { name: '스택 관찰 상세' })).toContainText(
      '관찰된 최종 변화',
    );
    await expect(page.getByRole('region', { name: '스택 관찰 상세' })).not.toContainText(
      'unavailable',
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath('stack-workspace.png'), fullPage: true });
  });

test('v2 default storage retains both modes, unfinished JSON, original snapshots and bundle imports', async ({
  page,
}) => {
  await stack(page, 'stack_http_post');
  await run(page);
  await save(page);
  const before = await stored(page);
  await tab(page, '편집');
  await page.getByRole('tab', { name: '프로토콜 정의', exact: true }).click();
  await page.locator('summary').filter({ hasText: 'requires 포트 JSON 편집' }).click();
  const firstJson = page.getByRole('textbox', { name: 'requires 포트 계약 JSON', exact: true });
  await firstJson.fill('{');
  await save(page);
  let releaseRead = () => {};
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  await page.route('**/workspace-storage-worker-*.js', async (route) => {
    await readGate;
    await route.continue();
  });
  await page.reload();
  try {
    await expect(page.getByText('로컬 작업 공간을 불러오는 중…', { exact: true })).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: '스택 작업' })
        .getByRole('button', { name: '편집', exact: true }),
    ).toBeDisabled();
  } finally {
    releaseRead();
  }
  await expect(page.getByRole('heading', { name: '프로토콜 스택 작업 공간' })).toBeVisible();
  await tab(page, '편집');
  await page.getByRole('tab', { name: '프로토콜 정의', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: '미완성 설정 JSON 수정', exact: true }),
  ).toHaveValue('{');
  await expect(page.getByRole('button', { name: '새 스택 전체 실행', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '단일 계층', exact: true }).click();
  await page.locator('[data-path="/label"]').fill('함께 저장한 단일 계층');
  await save(page);
  const after = await stored(page);
  expect(
    after.data.legacy.drafts.some((d) => d.configuration.label === '함께 저장한 단일 계층'),
  ).toBe(true);
  expect(after.data.stack.runs).toEqual(before.data.stack.runs);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const file = await (await download).path();
  expect(file).toBeTruthy();
  if (!file) throw new Error('Missing downloaded bundle');
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles(file);
  await save(page);
  const imported = await stored(page);
  expect(imported.data.stack.runs).toHaveLength(2);
  expect(imported.data.stack.runs[1]?.view).toEqual(before.data.stack.runs[0]?.view);
});

test('native stack suite, coverage links, paired batches and independent comparison survive reload', async ({
  page,
}) => {
  await stack(page);
  await tab(page, '반복·회귀');
  await page.getByRole('button', { name: '현재 조건을 스택 사례로 추가', exact: true }).click();
  await page.getByRole('button', { name: '스택 회귀 검증 실행', exact: true }).click();
  await expect(page.locator('.stack-series-summary')).toContainText('묶음 종료');
  await expect(page.locator('.stack-coverage-item').first()).toBeVisible();
  await page.locator('.stack-coverage-item button').first().click();
  await expect(page.getByLabel('스택 기록 위치 값', { exact: true })).toHaveValue('0');
  await tab(page, '반복·회귀');
  await page.getByLabel('seed 목록', { exact: true }).fill('3, 4');
  await page.getByRole('button', { name: '스택 반복 실험 실행', exact: true }).click();
  await expect(page.locator('.stack-series-summary')).toContainText('완료 2');
  await save(page);
  await page.reload();
  await tab(page, '기록·비교');
  const data = (await stored(page)).data.stack;
  expect(data.runs).toHaveLength(3);
  const left = data.runs[1];
  const right = data.runs[2];
  if (!left || !right) throw new Error('Missing comparison runs');
  await page.getByLabel('왼쪽 스택 실행', { exact: true }).selectOption(left.id);
  await page.getByLabel('오른쪽 스택 실행', { exact: true }).selectOption(right.id);
  await expect(page.getByRole('region', { name: '두 스택 실행 비교' })).toContainText(
    '실행별 ID는 공유 원인이 아닙니다.',
  );
  await expect(page.getByRole('table', { name: '설정과 결과 차이' })).toBeVisible();
  await page.getByRole('button', { name: '스택 비교 좌우 바꾸기', exact: true }).click();
  await expect(page.getByLabel('왼쪽 스택 실행', { exact: true })).toHaveValue(right.id);
});

test('stack breakpoint pauses an actual transition, then continues without re-stopping on that event', async ({
  page,
}) => {
  await stack(page, 'stack_ping_pong');
  await tab(page, '중단점');
  await page.getByRole('button', { name: '스택 중단점 추가', exact: true }).click();
  await page.getByLabel('정지 대상', { exact: true }).selectOption('Done');
  await page.getByRole('button', { name: '새 스택 전체 실행', exact: true }).click();
  await expect(page.getByText(/중단점 정지 · 중단점 1/)).toBeVisible();
  await expect(page.getByRole('button', { name: '스택 계속', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '스택 계속', exact: true }).click();
  await tab(page, '실행');
  await expect(page.locator('.stack-run-summary')).toContainText('completed');
});

test('default DB2 migration preserves the actual v1 recovery copy and fences the old writer', async ({
  page,
}) => {
  const { createWorkspace } = await import('../../src/application/workspace-operations.ts');
  const { createPingPongExperiment } = await import('../../src/examples/ping-pong.ts');
  await page.goto('/');
  await save(page);
  const original = {
    schemaVersion: 1,
    revision: 7,
    data: createWorkspace(createPingPongExperiment()),
  };
  await page.evaluate(async (value) => {
    await new Promise<void>((resolve, reject) => {
      const drop = indexedDB.deleteDatabase('protocol-studio');
      drop.onsuccess = () => resolve();
      drop.onerror = () => reject(drop.error);
    });
    await new Promise<void>((resolve, reject) => {
      const opened = indexedDB.open('protocol-studio', 1);
      opened.onupgradeneeded = () => opened.result.createObjectStore('workspace');
      opened.onsuccess = () => {
        const db = opened.result;
        const tx = db.transaction('workspace', 'readwrite');
        tx.objectStore('workspace').put(value, 'current');
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
  }, original as unknown);
  await page.reload();
  await expect(page.locator('[data-path="/label"]')).toHaveValue(
    original.data.drafts[0]?.configuration.label ?? '',
  );
  await page.locator('[data-path="/label"]').fill('DB2만 변경');
  await save(page);
  const backup = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const opened = indexedDB.open('protocol-studio', 2);
        opened.onerror = () => reject(opened.error);
        opened.onsuccess = () => {
          const db = opened.result;
          const tx = db.transaction('workspace', 'readonly');
          const request = tx.objectStore('workspace').get('current');
          tx.oncomplete = () => {
            db.close();
            resolve(request.result);
          };
        };
      }),
  );
  expect(backup).toEqual(original);
  expect(
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const old = indexedDB.open('protocol-studio', 1);
          old.onerror = () => resolve(old.error?.name);
          old.onsuccess = () => {
            old.result.close();
            resolve('unexpected');
          };
        }),
    ),
  ).toBe('VersionError');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '이전 v1 원본 복구 파일', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('protocol-studio.bundle.json');
  await page.getByRole('button', { name: '계층 연결 스택', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '프로토콜 스택 작업 공간', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'stack_ping_pong 새 사본', exact: true }).click();
  await run(page);
  await save(page);
  expect((await stored(page)).data.legacy.drafts[0]?.configuration.label).toBe('DB2만 변경');
});

test('stack history keyboard playback stops at its own breakpoint and keeps frozen snapshots after editing', async ({
  page,
}) => {
  await stack(page, 'stack_ping_pong');
  await run(page);
  await save(page);
  const before = (await stored(page)).data.stack.runs[0];
  expect(before).toBeDefined();
  if (!before) throw new Error('Missing saved history');
  await tab(page, '중단점');
  await page.getByRole('button', { name: '스택 중단점 추가', exact: true }).click();
  await page.getByRole('combobox', { name: '정지 대상', exact: true }).selectOption('Done');
  await tab(page, '기록·비교');
  await page.getByRole('button', { name: /^스택 기록 재생 ·/ }).click();
  await page.getByRole('button', { name: '기록 처음', exact: true }).click();
  const play = page.getByRole('button', { name: '스택 기록 자동 재생', exact: true });
  await play.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('기록 중단점 정지 · 중단점 1', { exact: true })).toBeVisible({
    timeout: 15000,
  });
  const cursor = Number(await page.getByLabel('스택 기록 위치 값', { exact: true }).inputValue());
  expect(cursor).toBeGreaterThan(0);
  expect(cursor).toBeLessThan(before.view.events.length + 1);
  await expect(
    page.getByRole('button', { name: '스택 기록 재생 정지', exact: true }),
  ).toBeDisabled();
  await tab(page, '편집');
  await page.getByLabel('스택 실험 이름', { exact: true }).fill('다음 초안');
  await save(page);
  expect((await stored(page)).data.stack.runs[0]?.view).toEqual(before?.view);
  await tab(page, '실행');
  await page.getByRole('button', { name: '저장 시점', exact: true }).click();
  await expect(page.getByRole('region', { name: '스택 기대 조건' })).toContainText('pass');
});

test('editing during a real stack run checkpoints a partial run and mode switching fences old callbacks', async ({
  page,
}) => {
  const { largeStackEvents } = await import('../fixtures/large-stacks.ts');
  const { createWorkspaceV2 } = await import('../../src/application/workspace-v2-operations.ts');
  const { createWorkspace } = await import('../../src/application/workspace-operations.ts');
  const { createPingPongExperiment } = await import('../../src/examples/ping-pong.ts');
  await page.goto('/');
  await page.getByRole('button', { name: '계층 연결 스택', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '프로토콜 스택 작업 공간', exact: true }),
  ).toBeVisible();
  const data = createWorkspaceV2(createWorkspace(createPingPongExperiment()), largeStackEvents());
  await page.getByLabel('bundle 가져오기', { exact: true }).setInputFiles({
    name: 'long.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ schemaVersion: 2, kind: 'protocol-studio-bundle', data })),
  });
  await expect(page.getByText(/검증한 bundle을 적용/)).toBeVisible();
  await page.getByRole('button', { name: '새 스택 전체 실행', exact: true }).click();
  await expect(page.getByRole('button', { name: '스택 일시 정지', exact: true })).toBeEnabled();
  await tab(page, '편집');
  await page.getByLabel('스택 실험 이름', { exact: true }).fill('실행 중 편집');
  await expect(page.getByRole('button', { name: '스택 계속', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '단일 계층', exact: true }).click();
  await save(page);
  const saved = await stored(page);
  const record = saved.data.stack.runs[0];
  expect(record?.view.status).toBe('cancelled');
  expect(record?.view.snapshot.configuration.label).not.toBe('실행 중 편집');
  expect(saved.data.stack.drafts[0]?.configuration.label).toBe('실행 중 편집');
  await page.getByRole('button', { name: '계층 연결 스택', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '프로토콜 스택 작업 공간', exact: true }),
  ).toBeVisible();
  await tab(page, '기록·비교');
  await page.getByRole('button', { name: /^스택 기록 재생 ·/ }).click();
  await expect(page.locator('.stack-run-summary')).toContainText('cancelled');
});

for (const example of ['stack_http_get', 'stack_http_split'])
  test(`${example} runs through actual stream ports and preserves support boundaries`, async ({
    page,
  }) => {
    await stack(page, example);
    await run(page);
    await save(page);
    const record = (await stored(page)).data.stack.runs[0];
    expect(record?.view.events.some((e) => e.kind === 'service-request')).toBe(true);
    expect(
      record?.view.events.some((e) => e.kind === 'parsed' && e.endpoint.instanceId === 'app'),
    ).toBe(true);
    await page.getByRole('button', { name: '이 snapshot으로 새 스택 실행', exact: true }).click();
    await expect(page.locator('.stack-run-summary')).toContainText('completed');
  });

test('stack link errors focus their fields and authored complete loss yields diagnosed failure without fake delivery', async ({
  page,
}) => {
  await stack(page, 'stack_ping_pong');
  await page.locator('[data-stack-path="/nodes/A/instances/0/id"]').fill('');
  await expect(page.getByRole('button', { name: '새 스택 전체 실행', exact: true })).toBeDisabled();
  await page.getByRole('region', { name: '스택 정의 진단' }).getByRole('button').first().click();
  await expect(page.locator('[data-stack-path="/nodes/A/instances/0/id"]')).toBeFocused();
  await page.locator('[data-stack-path="/nodes/A/instances/0/id"]').fill('app');
  await page.getByRole('tab', { name: '하위 환경', exact: true }).click();
  await page.locator('[data-stack-path="/link/environment/directions/AtoB/lossRate"]').fill('100');
  await page.getByRole('button', { name: '새 스택 전체 실행', exact: true }).click();
  await tab(page, '실행');
  await expect(page.locator('.stack-run-summary')).toContainText('completed');
  await expect(page.getByRole('region', { name: '스택 기대 조건' })).toContainText('fail');
  await page
    .getByRole('region', { name: '스택 기대 조건' })
    .getByRole('button')
    .filter({ hasText: 'fail' })
    .first()
    .click();
  await expect(page.getByRole('region', { name: '스택 관찰 상세' })).toContainText(
    '직접 판정 근거',
  );
  await page.getByLabel('관찰할 인스턴스', { exact: true }).selectOption('B/app');
  await expect(page.getByRole('region', { name: '인스턴스 상태' })).toContainText('앱 전달 0');
});

test('shape-invalid JSON keeps the last renderable configuration and survives native reload for repair', async ({
  page,
}) => {
  await stack(page, 'stack_ping_pong');
  await page.getByRole('tab', { name: '프로토콜 정의', exact: true }).click();
  await page.locator('summary').filter({ hasText: 'requires 포트 JSON 편집' }).click();
  const input = page.getByRole('textbox', { name: 'requires 포트 계약 JSON', exact: true });
  await input.fill('{}');
  await expect(
    page.getByRole('textbox', { name: '미완성 설정 JSON 수정', exact: true }),
  ).toHaveValue('{}');
  await expect(page.getByRole('button', { name: '새 스택 전체 실행', exact: true })).toBeDisabled();
  await save(page);
  const data = (await stored(page)).data.stack.drafts[0];
  expect(data?.configuration.definitions[0]?.requires.service.kind).toBe('stream');
  await page.reload();
  await tab(page, '편집');
  await page.getByRole('tab', { name: '프로토콜 정의', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: '미완성 설정 JSON 수정', exact: true }),
  ).toHaveValue('{}');
  if (!data?.configuration.definitions[0]) throw new Error('Missing definition');
  await page
    .getByRole('textbox', { name: '미완성 설정 JSON 수정', exact: true })
    .fill(JSON.stringify(data.configuration.definitions[0].requires));
  await expect(page.getByRole('button', { name: '새 스택 전체 실행', exact: true })).toBeEnabled();
  await run(page);
});
