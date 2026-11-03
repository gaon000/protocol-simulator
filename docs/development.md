# Development

## 환경과 도구

현재 P0 개발 기반을 구현했다. 버전의 기준은 [.nvmrc](../.nvmrc), [package.json](../package.json), [lockfile](../pnpm-lock.yaml)이다.

| 도구 | 고정 버전·용도 |
| --- | --- |
| Node.js | 24.18.0. 패키지는 24.18 이상 25 미만을 요구하며 nvm으로 맞춤 |
| pnpm | 9.15.0. Corepack의 packageManager 설정 사용 |
| TypeScript | 7.0.2. 모든 새 TS/TSX·도구·테스트에 strict 검사 |
| React / React DOM | 각각 19.3.1. 사용자가 production dependency 추가 승인 |
| Vite / React plugin | 8.3.5 / 6.1.2. 개발 서버·빌드 |
| Biome | 2.6.4. lint·포맷, JS/TS 작은따옴표·2칸 들여쓰기 |
| Node test runner | 코어·문서 검사기의 단위/통합 테스트 |
| Playwright | 1.64.1. 빌드된 화면의 실제 Chromium/Firefox E2E와 별도 Chromium 응답성 검사 |

현재 UI는 메시지·상태·규칙·시나리오 폼, 실행 제어·실제 기록·진단 이동을 제공하며 [P3 계약](design-docs/p3-workspace.md)을 따른다. P1 코어에 정의·참조·서비스 검사와 프레이밍 코덱을 추가했으며 [P1 계약](design-docs/p1-models-codecs.md)을 따른다. P2 실행 계약은 [P2 문서](design-docs/p2-runtime.md), 현재 기본 환경·재전송은 [P4 계약](design-docs/p4-environments.md)을 따른다. 현재 표준 예제·코덱·출처/사본은 [P5 계약](design-docs/p5-standard-examples.md)을 따른다. 현재 IndexedDB 저장·파일·과거 실행은 [P6 계약](design-docs/p6-persistence-replay.md)을 따른다. P0 도구·의존성은 변경하지 않았다.

## 시작하기

저장소 루트에서 실행한다. `.nvmrc`의 버전이 없으면 `nvm install`을 먼저 수행한다.

```sh
nvm use
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

개발 서버는 기본 `127.0.0.1:5173`을 사용한다. 빌드 결과를 보려면 `pnpm build` 후 `pnpm preview`를 실행한다. 외부 서버·기기·환경변수·credential은 필요하지 않다. nvm이 없는 환경은 동일한 Node 버전을 준비하고 packageManager에 맞는 pnpm을 사용한다.

최초 브라우저 테스트 전에는 다음을 실행한다. Linux CI에서는 `--with-deps` 등으로 해당 환경의 브라우저 OS 의존성도 준비해야 한다.

```sh
corepack pnpm exec playwright install chromium firefox
```

## 명령

Node 버전을 맞춘 상태에서 저장소 루트 기준이다. Corepack shim이 설정되어 있으면 `pnpm`, 그렇지 않으면 `corepack pnpm`으로 실행한다.

| 작업 | 실제 명령 |
| --- | --- |
| 고정 의존성 설치 | `pnpm install --frozen-lockfile` |
| 개발 서버 | `pnpm dev` |
| 정적 분석 | `pnpm lint` |
| 포맷 검사 / 적용 | `pnpm format:check` / `pnpm format` |
| 타입 검사 | `pnpm typecheck` |
| 단위·통합 테스트 | `pnpm test` |
| 문서 검사 | `pnpm check:docs` |
| 빌드 | `pnpm build` — 타입 검사 후 Vite 빌드 |
| 브라우저 E2E | `pnpm test:e2e` — 빌드 후 Chromium/Firefox 테스트 |
| 응답성 검사 | `pnpm test:performance` — 빌드 후 1-worker Chromium의 실제 10k/1 MiB fixture |
| 전체 검사 | `pnpm check` — lint·포맷·타입·Node 테스트·문서·빌드·E2E·응답성 |
| 추적된 변경 공백 검사 | `git diff --check` — 새 파일은 별도 검사 필요 |

`pnpm test`는 `tests/unit/*.test.ts`와 `tests/integration/*.test.ts`를 Node의 TypeScript type stripping으로 실행한다. 이 실행은 타입 검사를 대신하지 않는다. `tests/types/strictness.ts`의 음성 fixture는 strict 옵션이 완화되면 `@ts-expect-error` 불일치로 타입 검사에 실패하게 한다.

## 코드 기준

- TypeScript strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, noImplicitOverride를 사용한다.
- JS/TS 문자열에는 작은따옴표, 비동기 처리는 async/await를 우선한다.
- export하는 함수에는 JSDoc을 작성한다.
- source를 수정한 뒤 관련 테스트를 반드시 실행하고 필요한 타입·정적 검사·빌드를 수행한다.
- Node가 직접 실행하는 `.ts`는 erasable syntax를 사용하며 import 확장자를 명시한다.
- 코어는 DOM·React·브라우저 저장에 의존하지 않는다. 실제 환경·엔진이 없는 P0 fixture를 전체 통신 검증으로 설명하지 않는다.
- Markdown은 자동 포맷 대상에서 제외하고 [문서 검사기](../scripts/docs-validator.ts)로 경로·앵커·자리표시자·공백을 검증한다.

## 테스트 환경과 격리

코어는 Node 내장 runner로 외부 연동 없이 실행한다. seed·가상 시간의 계약을 검사하며 wall-clock sleep을 사용하지 않는다. P0 reference fixture의 산식과 P4 실제 adapter의 결과를 각각 검사한다. 손실·중복·재전송·전체 관찰 기간의 전달 횟수/내용도 검증한다.

Playwright는 기존 개발 서버를 재사용하지 않고 `127.0.0.1:4173`에 전용 Vite preview 서버를 시작·종료한다. 해당 포트가 사용 중이면 실패하며 임의의 기존 앱을 검사하지 않는다. 테스트마다 브라우저 context를 분리하고 실패 trace는 `test-results/`에 남긴다. 현재 브라우저 검증 범위는 Chromium 156.0.8078.4/Firefox 157.0의 실제 폼 작성·필드/조건/장애 변경·ACK 손실/유한 재시도·seed 재현·청크 원인·진단 초점·제어/상태 격리·키보드·390px 화면과 아홉 예제의 코어/화면 비교·HTTP 바이트/CL·TCP seq/ack·출처/사본이다. 실제 native IndexedDB의 새로고침 복원·invalid draft·bundle 왕복/거부·탭 충돌·quota/transaction abort·복구·snapshot 재실행도 검사한다. quota/abort는 테스트에서 API를 감싸 주입하며 실제 저장장치 고장 검증은 아니다. 통신은 가상 엔진이며 실제 네트워크 E2E는 없다.

테스트 수집 실패·전부 skip·예상보다 줄어든 범위를 통과로 해석하지 않는다. fixture·타이머·mock·외부 자원은 테스트 종료 시 정리한다.

상태도 검사는 catalog 정의·평행/자기/역방향 전이·없는/중복 ID·유한 페이지·history cursor·snapshot 편집 대상과 Chromium/Firefox의 실제 선택/키보드·초점·좁은 화면을 포함한다. `src/application/state-diagram.ts`는 DOM 없이 검사하고 SVG에서 원본 정의를 변경하지 않는다. 후속 범위는 [상태도 계획](exec-plans/completed/20261102-protocol-state-diagram.md)을 따른다.

## CI와 릴리스

초안 상태도 작성은 [V1-011](product-specs/protocol-simulator-v1.md#v1-011-초안-상태도의-시각적-작성)을 따른다. 상태/전이 생성의 ID·endpoint·이벤트·충돌·snapshot 검사를 Node에서 실행하고, 브라우저에서 실제 작성→폼 수정→실행→저장/새로고침, 단일 data-path·미완성 JSON·자기/평행 전이·취소·정의 전환·페이지/확대·390px를 검증한다. 실행 그림에는 작성 도구를 제공하지 않는다.

그림 연동은 실제 trigger별 회차·다중 parsed·반복/무시·환경 원인과 prefix를 코어에서 검사한다. 브라우저에서는 양방향 선택·전후 변수·참여자·규칙/상태 페이지·확대 유지·미실행 규칙·390px snapshot·자동 재생/선택 정지·초기화를 검사한다. 대형 fixture에서는 두 그림을 열고 규칙→시퀀스 연결 시간과 회차 20개 상한도 검사한다. 기준은 [V1-010](product-specs/protocol-simulator-v1.md#v1-010-상태도와-시퀀스-연동)을 따른다.

연동 지표는 초기 실행 체크포인트의 자동 저장 transaction이 끝난 뒤 측정한다. 저장 대기·직렬화도 전체 rAF/longtask 측정창에는 포함하며 명시적 변경 저장의 wall time도 별도로 검사한다. 설정 비교는 불변 snapshot/초안·버전이 바뀔 때만 수행한다. 저장 직렬화와 선택 작업이 겹친 시간을 순수 연동 시간으로 해석하지 않는다.

통신 시퀀스는 catalog·실제 수신과 예정 구분·ACK 손실·중복 역전·분할/합침·타이머 실패와 prefix·10k/1 MiB 참조 보존을 Node에서 검사한다. Chromium/Firefox에서는 HTTP 필드/바이트·원인 선택·TCP snapshot·390px·페이지·Enter/Space를 검사한다. 기존 응답성 fixture는 상태도와 시퀀스를 모두 연 상태에서 시퀀스 선택 상세까지 측정한다. 표시 기준은 [제품 명세](product-specs/protocol-simulator-v1.md#v1-009-통신-시퀀스-다이어그램)를 따른다.

[CI workflow](../.github/workflows/check.yml)는 Ubuntu 24.04에서 같은 Node·pnpm/frozen lockfile과 Chromium/Firefox·OS 의존성을 설치하고 `pnpm check`를 실행한다. 테스트 trace/응답성 report는 artifact로 7일 보관한다. workflow 구성과 실제 원격 실행 결과는 별도이며 최종 결과는 [실행 계획](exec-plans/completed/20261030-1641-layered-protocol-v1.md)에 기록한다. branch protection·배포는 설정하지 않았다.

응답성은 기능 검사와 겹치지 않게 1 worker·1440×900에서 실행한다. 전체 실행·상세·저장·history 이동과 rAF/longtask를 측정하고 `test-results/performance-report.json`에 기록한다. 임곗값·지원/미검증 브라우저·표시 상한은 [P7 문서](design-docs/p7-validation.md)를 따른다. macOS 로컬·Ubuntu CI 결과를 다른 기기의 보증으로 사용하지 않는다.

Git·승인 규칙은 [Workflow](workflow.md)를 따른다. React·React DOM 이외의 신규 production dependency도 추가 전에 사용자 확인을 받는다.
