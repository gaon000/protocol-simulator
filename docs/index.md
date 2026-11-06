# 문서 지도

문서는 각자 하나의 책임을 갖는다. 작업 관련 문서를 선택해서 읽고, 같은 규칙을 여러 곳에서 따로 관리하지 않는다.

| 문서 | 소유하는 내용 |
| --- | --- |
| [AGENTS](../AGENTS.md) | AI와 사람을 위한 작업 진입점 |
| [README](../README.md) | 현재 구현 범위와 로컬 시작·검사 |
| [Architecture](../ARCHITECTURE.md) | 현재 모듈 책임, 의존 방향, 시스템 경계 |
| [Development](development.md) | 환경 준비, 코드 규칙, 실제 실행 명령 |
| [Workflow](workflow.md) | 작업 시작, 계획 필요 여부, 검증과 완료 기준 |
| [Product Specs](product-specs/index.md) | 사용자 행동, 합의된 제품 정책·화면·범위 |
| [Design Docs](design-docs/index.md) | 목표 기술 구조, 계약, 대안과 실패·복구 |
| [ExecPlans](exec-plans/index.md) | 작업별 진행 상황, 결정, 검증 결과 |

## 작업별 읽기

작은 수정은 구조와 개발·작업 기준을 확인한 뒤 관련 코드를 읽는다. 큰 작업은 관련 실행 계획도 확인한다. 완료 계획은 과거 판단을 이해하는 자료로 읽고 현재 구현과 다시 대조한다.

v1은 [제품 명세](product-specs/protocol-simulator-v1.md) → [기술 설계](design-docs/layered-protocol-v1.md) → [P0 확정 계약](design-docs/p0-execution-contract.md) → [P1 모델·코덱](design-docs/p1-models-codecs.md) → [P2 엔진](design-docs/p2-runtime.md) → [P3 편집·실행](design-docs/p3-workspace.md) → [P4 환경·재전송](design-docs/p4-environments.md) → [P5 표준 예제](design-docs/p5-standard-examples.md) → [P6 저장·재생](design-docs/p6-persistence-replay.md) → [P7 검증·지원](design-docs/p7-validation.md) → [P0~P7 구현 계획](exec-plans/completed/20261030-1641-layered-protocol-v1.md) 순서로 읽는다. P0~P7의 IndexedDB 저장·파일 왕복·과거 기록/snapshot 재실행·브라우저/응답성/CI 검증을 완료했다. Accepted는 v1 전체 구현 완료를 뜻하지 않는다. 계획은 Completed이며 완료 목록에 실제 로컬·원격 검증과 한계를 기록했다. 현재 실행 명령은 Development에서 관리한다.

후속 작업: [프로토콜 상태도](exec-plans/completed/20261102-protocol-state-diagram.md). 상태/규칙 자동 그림·실행 강조·조건/동작 상세와 편집 이동의 구현·로컬 검증을 완료했다. v1의 과거 완료 기록은 유지한다.

[통신 시퀀스](exec-plans/completed/20261102-communication-sequence-diagram.md)도 완료했다. 실제 관찰 prefix의 A/B 화살표·손실/중복·타임아웃/재전송 후보와 snapshot 필드·바이트·원인/후속을 표시한다. 30행 페이지·키보드·390px·열린 그림의 10k/1 MiB 검증을 포함한다.

후속 [두 그림 연동](exec-plans/completed/20261102-linked-execution-diagrams.md)을 완료했다. 같은 snapshot/prefix의 선택 이벤트·규칙·전후 상태와 여러 실행 회차를 연결한다.

[반복 실험과 결과 비교](exec-plans/completed/20261105-batch-experiment-comparison.md)를 구현·검증했다. 조건별 공통 seed 실행·집계·로컬 기록과 기존 그림 재생을 연결한다. 현재 계약은 [V1-012](product-specs/protocol-simulator-v1.md#v1-012-반복-실험과-결과-비교)를 따른다.

[실행 이유 설명](exec-plans/completed/20261105-execution-explanations.md)을 구현·검증했다. snapshot·실제 전이의 후보 조건·생략 분기·순차 대입을 설명하고 기록과 대조한다. 현재 계약은 [V1-013](product-specs/protocol-simulator-v1.md#v1-013-규칙-선택과-변수-변경-설명)을 따른다.

[시나리오 묶음과 회귀 검증](exec-plans/completed/20261105-scenario-regression-suites.md)을 구현·검증했다. 공통 정의의 여러 사례를 저장·독립 실행하고 동일 조건의 판정 변화를 비교한다. 기준은 [V1-014](product-specs/protocol-simulator-v1.md#v1-014-시나리오-묶음과-회귀-검증)다.

[초안 상태도 작성](exec-plans/completed/20261103-visual-protocol-authoring.md)을 완료했다. 상태 추가·두 상태 연결·이벤트 선택과 기존 폼의 옆 편집기를 연결하며 실행 snapshot의 읽기 전용 경계를 유지한다.

[실패 진단과 관련 기록 이동](exec-plans/completed/20261105-failure-diagnostics.md)을 구현·검증했다. 당시 기대/실제·직접 연결과 참고 관찰을 구분하며, 현재 계약은 [V1-015](product-specs/protocol-simulator-v1.md#v1-015-실패-원인-진단과-관련-기록-이동)를 따른다.

[메시지 구조 시각화](exec-plans/completed/20261105-message-structure-visualization.md)를 구현·검증했다. 실제 전송 구획/필드 범위와 논리 구조·수신 청크를 구분하며 현재 기준은 [V1-016](product-specs/protocol-simulator-v1.md#v1-016-메시지-구조-시각화)을 따른다.

[중단점과 조건부 실행 정지](exec-plans/completed/20261105-conditional-breakpoints.md)를 구현·검증했다. 안전한 처리 경계와 실제 새 관찰에서 정지하고 기존 실행/재생과 trace 동등성을 유지한다. 현재 기준은 [V1-017](product-specs/protocol-simulator-v1.md#v1-017-중단점과-조건부-실행-정지)을 따른다.

[시나리오 묶음 검증 커버리지](exec-plans/completed/20261105-scenario-suite-coverage.md)를 구현·검증했다. 선택한 검증 snapshot의 참여자별 상태/규칙 관찰과 사례 첫 위치를 연결한다. 현재 기준은 [V1-018](product-specs/protocol-simulator-v1.md#v1-018-시나리오-묶음의-검증-커버리지)을 따른다.

[두 실행 결과 나란히 비교](exec-plans/completed/20261105-side-by-side-run-comparison.md)를 구현·검증했다. 당시 설정·결과·관찰 차이와 양쪽의 실제 기록 위치를 연결한다. 기준은 [V1-019](product-specs/protocol-simulator-v1.md#v1-019-두-실행-결과-나란히-비교)를 따른다.

후속 [계층 연결 설계](design-docs/layered-stack-v2.md)의 S1~S3 코어/provider·[S4 저장/관찰 API](design-docs/s4-stack-persistence-observation.md)를 구현했다. [S1~S5 구현 계획](exec-plans/completed/20261106-layered-protocol-stacks.md)은 Completed다. [S5 화면·기본 저장 흐름](design-docs/s5-stack-workspace.md)까지 연결했고 원격 CI의 성능 회귀 보완 후 전체 로컬 검사를 통과했다.

## 선택 문서

작성 기능의 [원격 CI 후속 검증](exec-plans/completed/20261107-stack-authoring-ci-validation.md)을 완료했다. 가져오기 준비 상태와 큰 자료의 중복 크기 계산을 보완하고 기존 기준의 전체 로컬/원격 검사를 통과했다.

[새 스택 작성·되돌리기·설정 폼](exec-plans/completed/20261107-stack-authoring-workflow.md)을 구현·검증했다. 생성 검토와 첫 메시지/검증, 초안별 유한 편집 이력과 포트/타이머/초기값 폼의 현재 계약은 [V1-022~024](product-specs/protocol-simulator-v1.md#v1-022-새-스택-만들기)를 따른다.

스택의 [규칙 폼 편집](product-specs/protocol-simulator-v1.md#v1-021-스택-규칙의-조건동작-폼-편집)을 구현·검증했다. 이벤트·조건·값 표현식·동작 목록의 작성과 JSON/저장 왕복 검증은 [작업 계획](exec-plans/completed/20261106-stack-rule-forms.md)을 따른다.

스택의 [메시지 이동 경로](product-specs/protocol-simulator-v1.md#v1-020-메시지의-계층별-이동-경로)를 구현하고 전체 로컬 검증을 통과했다. 실제 byte 출처에 따른 네 단계·필드/byte 강조·기록 연결과 검증 근거는 [작업 계획](exec-plans/completed/20261106-stack-message-journey.md)을 따른다.

v1의 제품 규칙·화면과 하위 서비스·상태·타이머·재현성 계약을 분리할 필요가 생겨 Product Specs와 Design Docs를 도입했다. 두 영역은 index와 재사용 양식을 포함한다. 독립적인 기술 결정 문서·용어 사전·skill은 현재 필요가 없어 추가하지 않았다. 실제로 추가한 문서만 이 지도에 링크한다.

## 템플릿 적용 이력

2026-10-30에 GitHub에서 새로 clone한 템플릿의 HEAD를 확인하고 처음 적용했다.

| 원본 저장소·조회 위치 | 기준 ref | 확인한 commit·버전 | 적용일 | 템플릿 경로 → 대상 경로 | 변경 요약 |
| --- | --- | --- | --- | --- | --- |
| [gaon000/ai-dev-template](https://github.com/gaon000/ai-dev-template) | master | `67abe615afa2d3c056bbf39e545b32e19753facd` | 2026-10-30 | `starter/AGENTS.md` → `AGENTS.md`; `starter/ARCHITECTURE.md` → `ARCHITECTURE.md`; `starter/docs/` → `docs/`(상대 구조 유지) | 기본 문서 11개 적용. 빈 저장소의 현황과 사용자 개발·Git 규칙을 반영하고 미확정 제품 정보·미구성 명령을 명시. |
| [gaon000/ai-dev-template](https://github.com/gaon000/ai-dev-template) 선택 문서 양식의 로컬 checkout | master | `67abe615afa2d3c056bbf39e545b32e19753facd` | 2026-10-30 | `optional/product-specs/` → `docs/product-specs/`; `optional/design-docs/` → `docs/design-docs/`; 실행 계획 양식 → `docs/exec-plans/active/20261030-1641-layered-protocol-v1.md` | 사용자와 합의한 v1 설계·화면·계약을 문서화하고 P0~P7 구현 계획을 등록. 기본 작업 규칙과 최초 적용 이력 보존. |

대상 프로젝트: `protocol-simulator`. 최초 적용 당시 애플리케이션 코드·개발 설정이 없었고 선택 문서와 계획은 만들지 않았다. 이후 사용자의 문서화 요청에 따라 위 v1 명세·설계와 실제 구현 계획을 추가했다. 이어 P0 구현 요청과 React·React DOM 승인에 따라 자체 개발·검사 기반을 구성했다. 템플릿 도입만으로 자동 설치한 것은 아니다. 이후 P7에서 CI workflow를 구성했으며 배포는 미구성이다. 기술 부채에 범위 밖 기능이나 예시 작업을 등록하지 않았다.

기존 사용자 수정과 이전 적용 이력을 보존하고 새 적용 내역을 추가한다. 재적용 시 이전 기준 버전과 현재 문서를 비교하되, 기준 버전이 없거나 접근할 수 없으면 그 한계를 기록한다. 이 기록은 문서 적용의 근거이며 애플리케이션 실행·테스트·배포 완료의 증거가 아니다.
