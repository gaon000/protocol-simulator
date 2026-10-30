# Architecture: protocol-simulator

## 목적과 범위

제품은 응용·전송 계층별로 프로토콜을 정의하고 하위 서비스 환경을 설정해 가상 참여자 A·B 사이에서 실행·관찰·검증하는 도구로 설계했다. 첫 버전은 데스크톱 웹을 기준으로 하며 한 번의 실행은 한 계층과 하위 서비스 모델을 사용한다.

현재 P6까지 구현했다. 코어는 가상 시간·규칙·타이머·정상 전달·관찰 판정을 제공하고 React 화면에서 폼 편집·실행·진단·원인 규칙을 연결한다. 데이터그램 장애·스트림 합쳐 읽기/종료, Stop-and-wait와 제한된 HTTP/1.1·TCP 연결 예제·원본/사본과 IndexedDB 로컬 저장·기록 재생을 구현했다.

[제품 명세](docs/product-specs/protocol-simulator-v1.md)는 기능·화면·범위를, [기술 설계](docs/design-docs/layered-protocol-v1.md)는 목표 구조·계약·실패 경계를 소유한다. Accepted는 v1 전체 구현 완료를 뜻하지 않는다. [P0 계약](docs/design-docs/p0-execution-contract.md)과 [P1 계약](docs/design-docs/p1-models-codecs.md)이 구현한 단계의 세부 기준이다. [구현 계획](docs/exec-plans/active/20261030-1641-layered-protocol-v1.md)은 In Progress이며 다음 단계는 P7이다.

## 모듈 지도

| 실제 경로 | 책임 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | 작업 진입점과 공통 원칙 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 현재 구조와 미확정 경계 |
| [docs/index.md](docs/index.md) | 문서 지도와 템플릿 적용 이력 |
| [docs/development.md](docs/development.md) | 개발 환경 현황, 명령과 코드 기준 |
| [docs/workflow.md](docs/workflow.md) | 작업 절차와 승인·완료 기준 |
| [docs/product-specs/](docs/product-specs/index.md) | v1 제품 요구사항과 재사용 양식 |
| [docs/design-docs/](docs/design-docs/index.md) | v1 기술 설계와 재사용 양식 |
| [docs/exec-plans/](docs/exec-plans/index.md) | 실행 계획 양식, 상태별 목록과 기술 부채 |
| [index.html](index.html), [src/main.tsx](src/main.tsx) | Vite·React 웹 진입점 |
| [src/ui/App.tsx](src/ui/App.tsx) | 초안·실행 수명과 작업 공간 연결 |
| [src/domain/execution-contract.ts](src/domain/execution-contract.ts) | 서비스 포트, 버전·상한, 이벤트 정렬·난수·snapshot 기초 계약 |
| [src/domain/protocol-model.ts](src/domain/protocol-model.ts), [model-validation.ts](src/domain/model-validation.ts) | 전체 정의·기록·결과 타입과 JSON/구조/의미·참조 검사 |
| [src/codecs/message-codecs.ts](src/codecs/message-codecs.ts), [http-codec.ts](src/codecs/http-codec.ts) | JSON Lines·JSON datagram·논리 패킷·제한된 HTTP/1.1과 바이트 상한 |
| [src/domain/http-schema.ts](src/domain/http-schema.ts) | HTTP 필드 binding·헤더·서비스 요구 검사 |
| [src/engine/simulation.ts](src/engine/simulation.ts), [event-queue.ts](src/engine/event-queue.ts) | 가상 실행·규칙·타이머·기록·결과와 유한 이벤트 큐 |
| [src/application/create-simulation.ts](src/application/create-simulation.ts) | 검증·snapshot·환경 조합과 실행 session fencing |
| [src/environments/simulated-environment.ts](src/environments/simulated-environment.ts), [ideal-environment.ts](src/environments/ideal-environment.ts) | P4 기본 장애/스트림 환경과 선택적 P2 이상적 adapter |
| [src/domain/workspace-model.ts](src/domain/workspace-model.ts), [workspace-validation.ts](src/domain/workspace-validation.ts) | 초안·기록·bundle 모델과 untrusted JSON·참조·상한 검사 |
| [src/application/workspace-controller.ts](src/application/workspace-controller.ts), [workspace-operations.ts](src/application/workspace-operations.ts), [replay-record.ts](src/application/replay-record.ts) | 저장 serial·실패/충돌·파일 merge와 읽기 전용 projection |
| [src/persistence/indexed-db.ts](src/persistence/indexed-db.ts) | native transaction 원자성·revision CAS·브라우저 오류 경계 |
| [src/ui/StoragePanel.tsx](src/ui/StoragePanel.tsx), [HistoryPanel.tsx](src/ui/HistoryPanel.tsx) | 저장 상태·파일과 기록 탐색/명시적 snapshot 재실행 |
| [scripts/](scripts/check-docs.ts) | Markdown 링크·앵커·양식 검증 |
| [src/application/edit-experiment.ts](src/application/edit-experiment.ts), [src/ui/forms.tsx](src/ui/forms.tsx) | 초안 복사·revision·JSON Pointer와 폼·오류 초점 |
| [src/examples/catalog.ts](src/examples/catalog.ts), [http.ts](src/examples/http.ts), [tcp-handshake.ts](src/examples/tcp-handshake.ts) | 버전 있는 아홉 원본/사본, Ping/Pong·재전송·HTTP·TCP 연결 정의 |
| [tests/unit/](tests/unit/execution-contract.test.ts), [tests/integration/](tests/integration/run-snapshot.test.ts), [tests/e2e/](tests/e2e/workspace.test.ts) | 계약·문서 검사와 실제 브라우저의 편집·실행 흐름 |

공개 서버 API·CLI는 미구성이며 로컬 저장은 native IndexedDB를 사용한다. 실제 개발 도구·명령은 [Development](docs/development.md)를 따른다.

## 의존 방향

UI → application → domain·engine·codecs·environments 의존 방향을 사용한다. examples는 DOM 없는 정의를 제공하며 UI와 application에서 참조한다. P1 codecs → domain 방향을 유지하며 모델·코덱 테스트는 DOM 없이 실행한다. 목표는 UI → application → 도메인·엔진·코덱·환경·저장 경계다. 엔진은 주입된 하위 서비스 계약으로 실행한다. 제안된 `src/` 경로별 책임은 [기술 설계](docs/design-docs/layered-protocol-v1.md#제안-모듈과-의존-방향)를 따른다. domain·ui·codecs·engine·application·실제 장애 environments를 구현했다. examples의 원본·출처·사본과 HTTP binding·바이트/패킷 상세를 구현했고 persistence는 브라우저 transaction adapter를 제공한다.

공유 코드는 실제 재사용이 생길 때 분리하며, 순환 의존을 피한다. 모듈 사이 데이터 변경은 소유 모듈의 명시적인 계약을 통한다.

## 시스템과 데이터 경계

외부 서비스 연동, 인증, 네트워크 입출력은 미구성이다. v1은 실제 기기·서버 연결을 포함하지 않는다. 초안·실험 사본·실행 당시 snapshot과 결과를 IndexedDB에 저장하며 오류·다른 탭 충돌 시 메모리와 마지막 commit을 보존한다. 파일은 staging 검증 후 사본으로 합친다. [P6 저장 계약](docs/design-docs/p6-persistence-replay.md)을 따른다.

설계는 바이트 스트림과 데이터그램 서비스를 구분한다. P1은 실행 정의의 환경 호환성·참조와 개별 메시지의 프레이밍·값·바이트 상한을 검사한다. 전체 엔진은 P2에서 구현했고 장애·합쳐 읽기·종료 환경은 P4에서 구현했다. 참여자 상태·타이머를 실행별로 격리하고 전송·수신·해석·상위 처리 완료와 환경 원인을 각각 기록한다. 상한은 강제하며 브라우저 응답성 측정은 P7에서 수행한다.

## 변경 관리

공통 책임이나 의존 방향이 바뀌면 이 문서를 갱신한다. 중요한 선택의 대안과 이유는 필요할 때 결정 기록으로 남긴다. 완료된 실행 계획은 과거 근거이며 현재 계약은 이 문서와 현재 기능 문서를 기준으로 확인한다.
