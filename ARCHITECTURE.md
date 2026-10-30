# Architecture: protocol-simulator

## 목적과 범위

현재는 문서와 Git 메타데이터만 존재한다. 제품은 응용·전송 계층별로 프로토콜을 정의하고 하위 서비스 환경을 설정해 가상 참여자 A·B 사이에서 실행·관찰·검증하는 도구로 설계했다. 첫 버전은 데스크톱 웹을 기준으로 하며 한 번의 실행은 한 계층과 하위 서비스 모델을 사용한다.

[제품 명세](docs/product-specs/protocol-simulator-v1.md)는 기능·화면·범위를, [기술 설계](docs/design-docs/layered-protocol-v1.md)는 목표 구조·계약·실패 경계를 소유한다. 두 문서의 Accepted는 설계 합의를 뜻하며 구현 완료를 뜻하지 않는다. [구현 계획](docs/exec-plans/active/20261030-1641-layered-protocol-v1.md)은 Draft로 P0~P7의 구현·검증을 아직 시작하지 않았다.

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

애플리케이션 모듈, 공개 API·CLI·UI 진입점과 데이터 저장소는 미구성이다.

## 의존 방향

현재 실행 코드와 모듈 의존 관계는 없다. 목표는 UI → application → 도메인·엔진·코덱·환경·저장 경계다. 코어는 DOM·브라우저 저장 API와 독립적으로 검증하고, 엔진은 주입된 하위 서비스 계약으로 실행한다. 제안된 `src/` 경로별 책임은 [기술 설계](docs/design-docs/layered-protocol-v1.md#제안-모듈과-의존-방향)를 따른다. 해당 디렉터리들은 아직 만들지 않았다.

공유 코드는 실제 재사용이 생길 때 분리하며, 순환 의존을 피한다. 모듈 사이 데이터 변경은 소유 모듈의 명시적인 계약을 통한다.

## 시스템과 데이터 경계

외부 서비스 연동, 영속 데이터, 인증, 네트워크 입출력은 미구성이다. v1은 실제 기기·서버 연결을 포함하지 않는다. 목표는 로컬 초안·실험 저장과 실행 당시 snapshot 보존이며, 저장 구현은 계획 P6에서 정한다.

설계는 바이트 스트림과 데이터그램 서비스를 구분한다. 프로토콜의 요구사항과 환경의 보장을 실행 전에 검사하고, 가상 시계·seed·엔진 버전과 불변 snapshot으로 결과를 재현한다. 참여자 상태·타이머는 실행별로 격리하며 전송·수신·해석·상위 처리 완료를 각각 기록한다. 구체적인 세부 기본안과 상한은 P0/P7에서 검증한다.

## 변경 관리

공통 책임이나 의존 방향이 바뀌면 이 문서를 갱신한다. 중요한 선택의 대안과 이유는 필요할 때 결정 기록으로 남긴다. 완료된 실행 계획은 과거 근거이며 현재 계약은 이 문서와 현재 기능 문서를 기준으로 확인한다.
