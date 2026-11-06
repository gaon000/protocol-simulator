# Architecture: protocol-simulator

## 목적과 범위

제품은 응용·전송 계층별로 프로토콜을 정의하고 하위 서비스 환경을 설정해 가상 참여자 A·B 사이에서 실행·관찰·검증하는 도구로 설계했다. 첫 버전은 데스크톱 웹을 기준으로 하며 한 번의 실행은 한 계층과 하위 서비스 모델을 사용한다.

현재 P0~P7 v1을 구현하고 로컬·원격 CI 검증을 완료했다. 코어는 가상 시간·규칙·타이머·정상 전달·관찰 판정을 제공하고 React 화면에서 폼 편집·실행·진단·원인 규칙을 연결한다. 데이터그램 장애·스트림 합쳐 읽기/종료, Stop-and-wait와 제한된 HTTP/1.1·TCP 연결 예제·원본/사본과 IndexedDB 로컬 저장·기록 재생을 구현했다.

[제품 명세](docs/product-specs/protocol-simulator-v1.md)는 기능·화면·범위를, [기술 설계](docs/design-docs/layered-protocol-v1.md)는 목표 구조·계약·실패 경계를 소유한다. Accepted는 v1 전체 구현 완료를 뜻하지 않는다. [P0 계약](docs/design-docs/p0-execution-contract.md)과 [P1 계약](docs/design-docs/p1-models-codecs.md)이 구현한 단계의 세부 기준이다. [구현 계획](docs/exec-plans/completed/20261030-1641-layered-protocol-v1.md)은 Completed이며 단계별 실제 증거와 검증 범위 밖 항목을 기록했다.

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
| [src/application/state-diagram.ts](src/application/state-diagram.ts) | 상태/규칙 페이지·그룹 전이·유한 배치, cursor 내 적용 규칙·정확한 snapshot/초안 대응 |
| [src/application/diagram-authoring.ts](src/application/diagram-authoring.ts), [src/ui/DraftDiagramTools.tsx](src/ui/DraftDiagramTools.tsx), [DraftDiagramEditor.tsx](src/ui/DraftDiagramEditor.tsx) | 참조를 보존하는 상태/전이 생성·연결 모드와 옆 편집기. 기존 edit/revision·단일 폼 소유를 사용 |
| [src/application/sequence-diagram.ts](src/application/sequence-diagram.ts), [src/ui/SequenceDiagram.tsx](src/ui/SequenceDiagram.tsx) | 관찰 prefix의 통신/장애·반복 송신 추정·원인/직접 후속과 30행 SVG·필드/바이트 상세 |
| [src/application/diagram-links.ts](src/application/diagram-links.ts), [src/ui/DiagramLinkDetails.tsx](src/ui/DiagramLinkDetails.tsx), [useDiagramPanel.ts](src/ui/useDiagramPanel.ts) | prefix 인과 인덱스·규칙/상태의 회차·선택 전후와 두 그림의 명시적 이동/초점. App이 선택·재생 정지를 조정 |
| [src/ui/StateDiagram.tsx](src/ui/StateDiagram.tsx), [ProtocolStateDiagrams.tsx](src/ui/ProtocolStateDiagrams.tsx) | SVG 선택·조건/동작 상세·폼 이동, 초안 및 참여자별 실행 상태도 |
| [src/ui/App.tsx](src/ui/App.tsx) | 초안·실행 수명과 작업 공간 연결 |
| [src/application/execution-explanation.ts](src/application/execution-explanation.ts), [src/ui/ExecutionExplanation.tsx](src/ui/ExecutionExplanation.tsx) | prefix의 관찰된 transition/snapshot으로 후보 조건·short-circuit·순차 대입을 재구성해 실제 전후 값과 대조. 유한 계산/페이지·명시적 제한, 패널 확장 시에만 조회 |
| [src/application/failure-diagnostics.ts](src/application/failure-diagnostics.ts), [src/ui/FailureDiagnostics.tsx](src/ui/FailureDiagnostics.tsx) | 당시 기대/관찰과 판정 대조·prefix 내 직접 원인/타이머 수명과 참고 관찰 분리. 유한 탐색·페이지와 공유 선택의 시퀀스/설명 이동 |
| [src/application/message-structure.ts](src/application/message-structure.ts), [src/ui/MessageStructure.tsx](src/ui/MessageStructure.tsx) | 선택 snapshot/prefix의 HTTP/JSON 실제 범위와 논리 필드·수신 청크 구분. 유한 분석·영역/필드 선택·256-byte hex/ASCII 페이지 |
| [src/application/breakpoints.ts](src/application/breakpoints.ts), [src/ui/BreakpointsPanel.tsx](src/ui/BreakpointsPanel.tsx) | 탭별 debugger 설정·snapshot 대상/유한 조건 검증과 새 관찰 matcher. App의 자동 진행/재생·계속·선택에 연결하고 engine은 queue 처리 사이 optional predicate만 호출 |
| [src/application/batch-experiments.ts](src/application/batch-experiments.ts), [src/ui/BatchExperiments.tsx](src/ui/BatchExperiments.tsx), [useBatchExperiments.ts](src/ui/useBatchExperiments.ts) | 같은 seed 목록의 조건 조합·독립 엔진/유한 scheduler·실제 결과 집계와 기존 history 연결. SavedRun의 optional batch metadata로 보존 |
| [src/domain/execution-contract.ts](src/domain/execution-contract.ts) | 서비스 포트, 버전·상한, 이벤트 정렬·난수·snapshot 기초 계약 |
| [src/domain/protocol-model.ts](src/domain/protocol-model.ts), [model-validation.ts](src/domain/model-validation.ts) | 전체 정의·기록·결과 타입과 JSON/구조/의미·참조 검사 |
| [src/domain/model-validation.ts](src/domain/model-validation.ts)의 소유 JSON metadata | 검증 후 깊게 동결한 자료의 정확한 node/depth·compact UTF-8 길이. 일반 mutable 자료의 검사/크기 계산과 fresh DB 검사를 생략하지 않음 |
| [src/domain/stack-model.ts](src/domain/stack-model.ts), [stack-validation.ts](src/domain/stack-validation.ts), [stack-protocol-validation.ts](src/domain/stack-protocol-validation.ts) | S1 v2 정의·서비스 포트·네 인스턴스/참조·wire 호환성·시나리오·불변 snapshot과 draft reader, 명시적 v1 앱 adapter. 별도 실행/저장 API와 S5 작업 공간에 연결 |
| [src/domain/stack-bytes.ts](src/domain/stack-bytes.ts), [stack-expressions.ts](src/domain/stack-expressions.ts), [stack-payloads.ts](src/domain/stack-payloads.ts) | canonical 바이트·유한 표현식, run별 private payload/handle·global/owner 예산·불변 trace artifacts |
| [src/application/create-stack-simulation.ts](src/application/create-stack-simulation.ts), [src/domain/stack-runtime-model.ts](src/domain/stack-runtime-model.ts) | 독립 스택 생성/snapshot 재실행·session fence와 endpoint별 view/기대 판정 |
| [src/engine/protocol-runtime.ts](src/engine/protocol-runtime.ts), [stack-scheduler.ts](src/engine/stack-scheduler.ts), [service-router.ts](src/engine/service-router.ts) | 네 독립 runtime·한 clock/queue·로컬 요청/통지·예약/commit·오류/전체 관찰 수명 |
| [src/engine/stack-codec.ts](src/engine/stack-codec.ts), [stack-data.ts](src/engine/stack-data.ts) | fork 가능한 기존 byte 코덱/native 논리 packet 조합, actual frame/bytes·변수/slice/concat의 기여 범위 |
| [src/engine/rule-evaluation.ts](src/engine/rule-evaluation.ts), [src/domain/datagram-policy.ts](src/domain/datagram-policy.ts) | v1/스택 공통 후보 검사·targeted drop/4-draw 순수 결정. v1의 기존 큐/trace 의미는 보존 |
| [src/examples/reliable-stream-lite.ts](src/examples/reliable-stream-lite.ts), [reliable-stack-examples.ts](src/examples/reliable-stack-examples.ts) | S3의 양방향 DATA/ACK·분할/유한 재전송/중복 제거 규칙과 실제 JSON Lines·제한된 HTTP 스택. 별도 버전 있는 원본/사본 metadata/API |
| [src/domain/workspace-v2-model.ts](src/domain/workspace-v2-model.ts), [workspace-v2-validation.ts](src/domain/workspace-v2-validation.ts), [stack-record.ts](src/domain/stack-record.ts) | S4의 legacy/stack 구분·공유 workspace 예산·unfinished draft와 strict 실행 기록/직접 원인·범위/연속성 검사 |
| [src/persistence/indexed-db-v2.ts](src/persistence/indexed-db-v2.ts), [src/application/workspace-v2-controller.ts](src/application/workspace-v2-controller.ts), [workspace-v2-operations.ts](src/application/workspace-v2-operations.ts) | 기본 DB2 atomic upgrade·원본 보관·CAS/실패 복구와 모든 mode bundle/import/remap. S5 기본 adapter는 worker에서 호출 |
| [src/ui/WorkspaceRoot.tsx](src/ui/WorkspaceRoot.tsx), [StackWorkspace.tsx](src/ui/StackWorkspace.tsx), [StackEditor.tsx](src/ui/StackEditor.tsx), [StackRunPanel.tsx](src/ui/StackRunPanel.tsx) | 기본 두 모드 진입·checkpoint 전환, exact revision 편집과 endpoint/prefix 공유 선택·그림/설명/구조/진단 |
| [src/application/stack-rule-authoring.ts](src/application/stack-rule-authoring.ts), [src/ui/StackRuleForm.tsx](src/ui/StackRuleForm.tsx), [StackRuleTree.tsx](src/ui/StackRuleTree.tsx), [StackRuleControls.tsx](src/ui/StackRuleControls.tsx) | exact 정의/이벤트 범위의 규칙 폼·유한 트리/목록과 JSON 왕복, 리스트와 pending raw의 원자적 index 이동. 기존 draft revision과 실행 검사 사용 |
| [src/application/new-stack.ts](src/application/new-stack.ts), [src/ui/NewStackWizard.tsx](src/ui/NewStackWizard.tsx) | 예제 사본 없는 native 응용 정의·명시적 전송 시작점과 빈/첫 흐름의 검토·원자적 생성. 당시 공유 용량과 기존 실행/초안 검사 사용 |
| [src/application/stack-edit-history.ts](src/application/stack-edit-history.ts), [edit-stack-list.ts](src/application/edit-stack-list.ts), [src/ui/StackDefinitionForms.tsx](src/ui/StackDefinitionForms.tsx), [StackValueInput.tsx](src/ui/StackValueInput.tsx) | Root 수명의 탭별 config/raw 이력·fresh exact revision 복원, 선언/규칙 리스트의 원자적 raw remap과 포트/타이머/초기값 폼. 현재 초안만 저장하고 외부 교체를 fence |
| [src/ui/StackDebugger.tsx](src/ui/StackDebugger.tsx), [StackExperiments.tsx](src/ui/StackExperiments.tsx), [src/application/legacy-workspace-facade.ts](src/application/legacy-workspace-facade.ts) | 탭 중단점·사례/반복/회귀·커버리지·독립 실행 비교와 v1 UI의 canonical 투영 |
| [src/application/stack-worker-client.ts](src/application/stack-worker-client.ts), [stack-ui-worker.ts](src/application/stack-ui-worker.ts), [stack-panel-model.ts](src/application/stack-panel-model.ts), [src/persistence/worker-storage.ts](src/persistence/worker-storage.ts), [workspace-storage-worker.ts](src/persistence/workspace-storage-worker.ts), [workspace-transfer.ts](src/persistence/workspace-transfer.ts) | typed RPC·관찰 버전/세대/늦은 응답 격리, 실제 실행과 bounded 관찰 DTO, 불변 행의 증분 전송·비동기 전체 검사·native DB/CAS와 typed 실패 |
| [src/application/stack-replay.ts](src/application/stack-replay.ts), [stack-diagrams.ts](src/application/stack-diagrams.ts), [stack-explanation.ts](src/application/stack-explanation.ts), [stack-diagnostics.ts](src/application/stack-diagnostics.ts) | 네 endpoint의 frozen prefix 재생·유한 그림/구조/실제 source 연결·규칙 계산 대조·기대/관찰 진단 API |
| [src/application/stack-message-journey.ts](src/application/stack-message-journey.ts), [src/ui/StackMessageJourney.tsx](src/ui/StackMessageJourney.tsx) | 응용 송신의 실제 byte 출처/typed slot 구간 대조·네 단계/필드·byte 강조·제어 후속 분리·유한 worker DTO. 기존 공유 선택과 명시적 history 이동 |
| [src/application/stack-breakpoints.ts](src/application/stack-breakpoints.ts), [stack-series.ts](src/application/stack-series.ts), [stack-coverage.ts](src/application/stack-coverage.ts), [stack-comparison.ts](src/application/stack-comparison.ts) | endpoint 중단점·고정 common source/case 실행·관찰 커버리지·두 기록의 유한 대응. 실제 내용은 [semantic 변환](src/application/stack-semantic-event.ts)으로 비교 |
| [playwright.stack.config.ts](playwright.stack.config.ts), [tests/stack-e2e/](tests/stack-e2e/persistence-v2.test.ts) | 두 브라우저의 실제 native IndexedDB v2 API 검증. 사용자 UI는 기본 E2E, 스택 정량 검증은 performance suite에서 별도 검사 |
| [src/codecs/message-codecs.ts](src/codecs/message-codecs.ts), [http-codec.ts](src/codecs/http-codec.ts) | JSON Lines·JSON datagram·논리 패킷·제한된 HTTP/1.1과 바이트 상한 |
| [src/domain/http-schema.ts](src/domain/http-schema.ts) | HTTP 필드 binding·헤더·서비스 요구 검사 |
| [src/engine/simulation.ts](src/engine/simulation.ts), [event-queue.ts](src/engine/event-queue.ts) | 가상 실행·규칙·타이머·기록·결과와 유한 이벤트 큐 |
| [src/application/create-simulation.ts](src/application/create-simulation.ts) | 검증·snapshot·환경 조합과 실행 session fencing |
| [src/environments/simulated-environment.ts](src/environments/simulated-environment.ts), [ideal-environment.ts](src/environments/ideal-environment.ts) | P4 기본 장애/스트림 환경과 선택적 P2 이상적 adapter |
| [src/domain/workspace-model.ts](src/domain/workspace-model.ts), [workspace-validation.ts](src/domain/workspace-validation.ts) | 초안·기록·bundle 모델과 untrusted JSON·참조·상한 검사 |
| [src/application/workspace-controller.ts](src/application/workspace-controller.ts), [workspace-operations.ts](src/application/workspace-operations.ts), [replay-record.ts](src/application/replay-record.ts) | 저장 serial·실패/충돌·파일 merge와 읽기 전용 projection |
| [src/persistence/indexed-db.ts](src/persistence/indexed-db.ts) | native transaction 원자성·revision CAS·브라우저 오류 경계 |
| [src/ui/StoragePanel.tsx](src/ui/StoragePanel.tsx), [HistoryPanel.tsx](src/ui/HistoryPanel.tsx) | 저장 상태·파일과 기록 탐색/명시적 snapshot 재실행 |
| [.github/workflows/check.yml](.github/workflows/check.yml), [playwright.performance.config.ts](playwright.performance.config.ts) | 고정 도구의 CI 검사와 독립 1-worker 응답성 측정 |
| [scripts/](scripts/check-docs.ts) | Markdown 링크·앵커·양식 검증 |
| [src/application/edit-experiment.ts](src/application/edit-experiment.ts), [src/ui/forms.tsx](src/ui/forms.tsx) | 초안 복사·revision·JSON Pointer와 폼·오류 초점 |
| [src/examples/catalog.ts](src/examples/catalog.ts), [http.ts](src/examples/http.ts), [tcp-handshake.ts](src/examples/tcp-handshake.ts) | 버전 있는 아홉 원본/사본, Ping/Pong·재전송·HTTP·TCP 연결 정의 |
| [tests/unit/](tests/unit/execution-contract.test.ts), [tests/integration/](tests/integration/run-snapshot.test.ts), [tests/e2e/](tests/e2e/workspace.test.ts) | 계약·문서 검사와 실제 브라우저의 편집·실행 흐름 |
| [src/domain/suite-validation.ts](src/domain/suite-validation.ts), [src/application/scenario-suites.ts](src/application/scenario-suites.ts), [src/ui/ScenarioSuitePanel.tsx](src/ui/ScenarioSuitePanel.tsx) | 공통 정의/사례 분리·미완성 저장·전체 검증·동일 조건의 판정 비교와 history 연결 |
| [src/application/run-series.ts](src/application/run-series.ts), [src/ui/useBatchExperiments.ts](src/ui/useBatchExperiments.ts) | 반복/회귀 실행의 공통 64작업 slice·취소 fence·단일 scheduler와 용량 정책 |
| [src/application/suite-coverage.ts](src/application/suite-coverage.ts), [src/ui/SuiteCoverage.tsx](src/ui/SuiteCoverage.tsx) | 한 regression group의 공통 snapshot/manifest 검증·관찰 counts와 사례별 첫 위치. 기존 상태도에 readonly coverage를 주입하고 history cursor로 연결 |
| [src/application/run-comparison.ts](src/application/run-comparison.ts), [src/ui/RunComparison.tsx](src/ui/RunComparison.tsx) | 두 frozen record의 설정/결과·stable 값과 유한 순서 보존 관찰 대응. App pair 선택과 회귀 사례/개별 history 진입·실제 cursor 재생 |

공개 서버 API·CLI는 미구성이며 로컬 저장은 native IndexedDB를 사용한다. 실제 개발 도구·명령은 [Development](docs/development.md)를 따른다.

## 의존 방향

UI → application → domain·engine·codecs·environments 의존 방향을 사용한다. examples는 DOM 없는 정의를 제공하며 UI와 application에서 참조한다. P1 codecs → domain 방향을 유지하며 모델·코덱 테스트는 DOM 없이 실행한다. 목표는 UI → application → 도메인·엔진·코덱·환경·저장 경계다. 엔진은 주입된 하위 서비스 계약으로 실행한다. 제안된 `src/` 경로별 책임은 [기술 설계](docs/design-docs/layered-protocol-v1.md#제안-모듈과-의존-방향)를 따른다. domain·ui·codecs·engine·application·실제 장애 environments를 구현했다. examples의 원본·출처·사본과 HTTP binding·바이트/패킷 상세를 구현했고 persistence는 브라우저 transaction adapter를 제공한다.

공유 코드는 실제 재사용이 생길 때 분리하며, 순환 의존을 피한다. 모듈 사이 데이터 변경은 소유 모듈의 명시적인 계약을 통한다.

## 시스템과 데이터 경계

외부 서비스 연동, 인증, 네트워크 입출력은 미구성이다. v1은 실제 기기·서버 연결을 포함하지 않는다. 초안·실험 사본·실행 당시 snapshot과 결과를 IndexedDB에 저장하며 오류·다른 탭 충돌 시 메모리와 마지막 commit을 보존한다. 파일은 staging 검증 후 사본으로 합친다. [P6 저장 계약](docs/design-docs/p6-persistence-replay.md)을 따른다.

설계는 바이트 스트림과 데이터그램 서비스를 구분한다. P1은 실행 정의의 환경 호환성·참조와 개별 메시지의 프레이밍·값·바이트 상한을 검사한다. 전체 엔진은 P2에서 구현했고 장애·합쳐 읽기·종료 환경은 P4에서 구현했다. 참여자 상태·타이머를 실행별로 격리하고 전송·수신·해석·상위 처리 완료와 환경 원인을 각각 기록한다. 상한을 강제하고 긴 실행은 batch 64·trace 200행 페이지·유한 JSON 미리보기로 표시한다. [P7 검증 계약](docs/design-docs/p7-validation.md)의 실제 10k/1 MiB 응답성 기준과 별도 CI를 사용한다.

## 계층 연결 후속 설계

단일 계층 모드와 [S5 스택 작업 공간](docs/design-docs/s5-stack-workspace.md)이 하나의 canonical v2 저장 큐를 공유한다. 스택은 A/B의 응용·전송 네 인스턴스, 포트 binding과 하위 링크를 작성하고 worker에서 실제로 실행한다. 기존 v1 실행 의미는 legacy facade를 통해 보존한다. 최종 검증 상태는 구현 계획을 따른다.

[구현 계획](docs/exec-plans/completed/20261106-layered-protocol-stacks.md)은 S1 모델/검사, S2 실행 코어, S3 사용자 정의 provider, S4 저장/관찰, S5 화면/검증 순서다. 기존 v1 자료·실행 의미와 source/snapshot/prefix 경계를 보존하며 실제 구현이 진행될 때 모듈 지도와 기준 문서를 갱신한다.

## 변경 관리

공통 책임이나 의존 방향이 바뀌면 이 문서를 갱신한다. 중요한 선택의 대안과 이유는 필요할 때 결정 기록으로 남긴다. 완료된 실행 계획은 과거 근거이며 현재 계약은 이 문서와 현재 기능 문서를 기준으로 확인한다.
