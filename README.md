# Protocol Studio

응용·전송 계층의 프로토콜을 정의하고 하위 통신 환경을 설정해 가상 참여자 사이에서 검증하는 도구다. 기존 예제에서 메시지 구조와 흐름을 살펴보고 사용자 정의 사본으로 실험하는 것을 목표로 한다.

현재 P0 개발 기반과 P1 정의 모델·검사·프레이밍 코덱을 구현했다. 화면은 계층·하위 서비스 선택과 작업 공간 전환을 제공하며 새 모델·코덱 API의 화면 연결은 후속 단계다. 실제 프로토콜 편집·통신 실행·저장은 아직 구현하지 않았다. 전체 범위와 진행 상태는 [문서 지도](docs/index.md), 모델·코덱 계약은 [P1 문서](docs/design-docs/p1-models-codecs.md)에서 확인한다.

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
