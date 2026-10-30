# Protocol Studio

응용·전송 계층의 프로토콜을 정의하고 하위 통신 환경을 설정해 가상 참여자 사이에서 검증하는 도구다. 기존 예제에서 메시지 구조와 흐름을 살펴보고 사용자 정의 사본으로 실험하는 것을 목표로 한다.

현재 P0 개발 기반, P1 모델·코덱, P2 가상 실행 엔진과 손실 없는 환경을 구현했다. 코어 API에서 규칙·타이머·관찰과 결과 판정이 가능하며 화면은 아직 P0 골격이다. 화면의 편집·재생 연결, 장애 환경·기존 표준 예제·저장은 후속 단계다. 전체 진행 상태는 [문서 지도](docs/index.md), 실행 API는 [P2 문서](docs/design-docs/p2-runtime.md)에서 확인한다.

## 로컬 개발

Node.js 버전은 [.nvmrc](.nvmrc), pnpm 버전은 [package.json](package.json)의 `packageManager`를 따른다. 설치된 nvm을 사용해 다음 명령을 저장소 루트에서 실행한다.

```sh
nvm use
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

개발 서버는 기본적으로 `127.0.0.1:5173`에서 시작한다. 포트가 사용 중이면 Vite가 안내하는 주소를 확인한다. 외부 서버·기기나 credential은 필요하지 않다. Node.js가 없다면 먼저 `nvm install`을 실행한다.

## 검사

```sh
corepack pnpm exec playwright install chromium --only-shell
corepack pnpm check
```

`pnpm check`는 lint·포맷·strict 타입 검사·Node 단위/통합 테스트·문서 검사·빌드·Chromium E2E를 순서대로 수행한다. 최초 Playwright 브라우저 설치에는 네트워크가 필요하다. Linux CI에서는 해당 환경의 브라우저 OS 의존성도 준비해야 한다. E2E는 빌드된 결과를 고정 포트 4173의 전용 preview 서버에서 검사하며 기존 서버를 재사용하지 않는다.

세부 명령과 로컬/CI 검증 범위는 [개발 기준](docs/development.md), v1 단계별 목표는 [실행 계획](docs/exec-plans/active/20261030-1641-layered-protocol-v1.md)을 따른다.
