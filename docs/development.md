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
| Playwright | 1.64.1. 빌드된 화면의 Chromium smoke test |

현재 UI는 계층·하위 서비스 선택과 작업 공간 전환만 제공한다. P1 코어에 정의·참조·서비스 검사와 프레이밍 코덱을 추가했으며 [P1 계약](design-docs/p1-models-codecs.md)을 따른다. 전체 엔진·환경·편집·저장은 [실행 계획](exec-plans/active/20261030-1641-layered-protocol-v1.md)의 P2 이후 범위다. P0 도구·의존성은 변경하지 않았다.

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
corepack pnpm exec playwright install chromium --only-shell
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
| 브라우저 E2E | `pnpm test:e2e` — 빌드 후 Chromium 테스트 |
| 전체 검사 | `pnpm check` — lint·포맷·타입·Node 테스트·문서·빌드·E2E |
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

코어는 Node 내장 runner로 외부 연동 없이 실행한다. seed·가상 시간의 계약을 검사하며 wall-clock sleep을 사용하지 않는다. 환경 reference fixture의 산식 검증은 P4의 실제 환경 구현 검증과 구분한다.

Playwright는 기존 개발 서버를 재사용하지 않고 `127.0.0.1:4173`에 전용 Vite preview 서버를 시작·종료한다. 해당 포트가 사용 중이면 실패하며 임의의 기존 앱을 검사하지 않는다. 테스트마다 브라우저 context를 분리하고 실패 trace는 `test-results/`에 남긴다. 현재 브라우저 검증 범위는 Chromium의 P0 작업 공간·선택·탐색·390px 화면이다. 실제 프로토콜 편집·통신·저장 E2E는 아직 없다.

테스트 수집 실패·전부 skip·예상보다 줄어든 범위를 통과로 해석하지 않는다. fixture·타이머·mock·외부 자원은 테스트 종료 시 정리한다.

## CI와 릴리스

CI workflow와 배포 절차는 아직 미구성이다. 현재 결과는 로컬 검사이며 원격 CI·배포·실제 네트워크 검증을 의미하지 않는다. 이후 CI에는 같은 Node·pnpm 버전과 Chromium 준비 후 `pnpm check`를 연결한다. 브랜치 보호와 최종 브라우저 지원은 관련 단계에서 확인한다.

Git·승인 규칙은 [Workflow](workflow.md)를 따른다. React·React DOM 이외의 신규 production dependency도 추가 전에 사용자 확인을 받는다.
