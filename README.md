# Protocol Studio

응용·전송 계층의 프로토콜을 정의하고 하위 통신 환경을 설정해 가상 참여자 사이에서 검증하는 도구다. 기존 예제에서 메시지 구조와 흐름을 살펴보고 사용자 정의 사본으로 실험하는 것을 목표로 한다.

현재 P4까지 구현했다. 화면에서 메시지·상태·규칙·시나리오를 편집하고 가상 참여자 A/B로 실행해 시퀀스·상태·기대 결과·원인을 확인할 수 있다. 실험 시작에서 Ping/Pong·Stop-and-wait 사본 또는 빈 실험을 연다. 데이터그램 손실·중복·지연 변동과 스트림 합쳐 읽기·종료를 설정하고, ACK 손실·재전송·중복 제거를 관찰할 수 있다. HTTP/TCP 예제·저장은 후속 단계다. 새로고침하면 현재 초안·실행이 사라진다. 전체 진행 상태는 [문서 지도](docs/index.md), 편집·실행 방법은 [P3 문서](docs/design-docs/p3-workspace.md)와 [P4 환경·재전송](docs/design-docs/p4-environments.md)에서 확인한다.

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
