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

v1은 [제품 명세](product-specs/protocol-simulator-v1.md) → [기술 설계](design-docs/layered-protocol-v1.md) → [P0 확정 계약](design-docs/p0-execution-contract.md) → [P1 모델·코덱](design-docs/p1-models-codecs.md) → [P0~P7 구현 계획](exec-plans/active/20261030-1641-layered-protocol-v1.md) 순서로 읽는다. 현재 P0 기반과 P1 코어를 구현했고 화면은 P0 골격이다. Accepted는 v1 전체 구현 완료를 뜻하지 않는다. 계획은 In Progress이며 P2~P7은 미시작이다. 현재 실행 명령은 Development에서 관리한다.

## 선택 문서

v1의 제품 규칙·화면과 하위 서비스·상태·타이머·재현성 계약을 분리할 필요가 생겨 Product Specs와 Design Docs를 도입했다. 두 영역은 index와 재사용 양식을 포함한다. 독립적인 기술 결정 문서·용어 사전·skill은 현재 필요가 없어 추가하지 않았다. 실제로 추가한 문서만 이 지도에 링크한다.

## 템플릿 적용 이력

2026-10-30에 GitHub에서 새로 clone한 템플릿의 HEAD를 확인하고 처음 적용했다.

| 원본 저장소·조회 위치 | 기준 ref | 확인한 commit·버전 | 적용일 | 템플릿 경로 → 대상 경로 | 변경 요약 |
| --- | --- | --- | --- | --- | --- |
| [gaon000/ai-dev-template](https://github.com/gaon000/ai-dev-template) | master | `67abe615afa2d3c056bbf39e545b32e19753facd` | 2026-10-30 | `starter/AGENTS.md` → `AGENTS.md`; `starter/ARCHITECTURE.md` → `ARCHITECTURE.md`; `starter/docs/` → `docs/`(상대 구조 유지) | 기본 문서 11개 적용. 빈 저장소의 현황과 사용자 개발·Git 규칙을 반영하고 미확정 제품 정보·미구성 명령을 명시. |
| [gaon000/ai-dev-template](https://github.com/gaon000/ai-dev-template) 선택 문서 양식의 로컬 checkout | master | `67abe615afa2d3c056bbf39e545b32e19753facd` | 2026-10-30 | `optional/product-specs/` → `docs/product-specs/`; `optional/design-docs/` → `docs/design-docs/`; 실행 계획 양식 → `docs/exec-plans/active/20261030-1641-layered-protocol-v1.md` | 사용자와 합의한 v1 설계·화면·계약을 문서화하고 P0~P7 구현 계획을 등록. 기본 작업 규칙과 최초 적용 이력 보존. |

대상 프로젝트: `protocol-simulator`. 최초 적용 당시 애플리케이션 코드·개발 설정이 없었고 선택 문서와 계획은 만들지 않았다. 이후 사용자의 문서화 요청에 따라 위 v1 명세·설계와 실제 구현 계획을 추가했다. 이어 P0 구현 요청과 React·React DOM 승인에 따라 자체 개발·검사 기반을 구성했다. 템플릿 도입만으로 자동 설치한 것은 아니다. CI·배포는 여전히 미구성이며 기술 부채에 범위 밖 기능이나 예시 작업을 등록하지 않았다.

기존 사용자 수정과 이전 적용 이력을 보존하고 새 적용 내역을 추가한다. 재적용 시 이전 기준 버전과 현재 문서를 비교하되, 기준 버전이 없거나 접근할 수 없으면 그 한계를 기록한다. 이 기록은 문서 적용의 근거이며 애플리케이션 실행·테스트·배포 완료의 증거가 아니다.
