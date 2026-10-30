# Protocol Studio

응용·전송 계층의 프로토콜을 정의하고 하위 통신 환경을 설정해 가상 참여자 사이에서 검증하는 도구다. 기존 예제에서 메시지 구조와 흐름을 살펴보고 사용자 정의 사본으로 실험하는 것을 목표로 한다.

현재 P6까지 구현했다. 화면에서 메시지·상태·규칙·시나리오를 편집하고 가상 참여자 A/B로 실행해 시퀀스·상태·기대 결과·원인을 확인할 수 있다. 실험 시작에서 출처·버전·지원 범위가 있는 아홉 예제의 사용자 사본 또는 빈 실험을 연다. 데이터그램 손실·중복·지연 변동과 스트림 합쳐 읽기·종료를 설정하고, ACK 손실·재전송·중복 제거를 관찰할 수 있다. HTTP GET·POST·분할/오류/지연 시나리오와 TCP 정상 연결 수립을 실제 바이트·필드·상태로 관찰한다. 초안·미완성 JSON·실행 snapshot과 결과는 이 브라우저에 자동 저장하며 파일로 가져오고 내보낼 수 있다. 과거 기록 탐색과 당시 snapshot 재실행을 구분한다. 저장 오류 때 메모리 작업을 유지하고 재시도·내보내기를 제공한다. 전체 HTTP/TCP 구현은 아니다. 전체 진행 상태는 [문서 지도](docs/index.md), 편집·실행 방법은 [P3 문서](docs/design-docs/p3-workspace.md)와 [P4 환경·재전송](docs/design-docs/p4-environments.md), 표준 지원 경계는 [P5 문서](docs/design-docs/p5-standard-examples.md), 저장·복구 경계는 [P6 문서](docs/design-docs/p6-persistence-replay.md)에서 확인한다.

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
corepack pnpm exec playwright install chromium firefox
corepack pnpm check
```

`pnpm check`는 lint·포맷·strict 타입 검사·Node 단위/통합 테스트·문서 검사·빌드·Chromium/Firefox E2E와 전용 Chromium 응답성 검사를 순서대로 수행한다. 최초 Playwright 브라우저 설치에는 네트워크가 필요하다. Linux CI에서는 해당 환경의 브라우저 OS 의존성도 준비해야 한다. E2E는 빌드된 결과를 고정 포트 4173의 전용 preview 서버에서 검사하며 기존 서버를 재사용하지 않는다.

데스크톱 Chromium/Firefox, 390/768/1440px의 배치·키보드를 검사한다. Safari·실기기 모바일은 미검증이다. 대형 trace는 200행씩 탐색하고 이벤트 상세는 미리보기로 표시하며 전체 데이터는 bundle에 보존한다. 응답성 기준과 한계는 [P7 문서](docs/design-docs/p7-validation.md)를 따른다.

세부 명령과 로컬/CI 검증 범위는 [개발 기준](docs/development.md), v1 단계별 목표는 [실행 계획](docs/exec-plans/active/20261030-1641-layered-protocol-v1.md)을 따른다.
