# 초안 상태도 시각적 편집

상태: Completed
작성일: 2026-11-03
종료일: 2026-11-03

이 문서는 [ExecPlan 운영 규칙](../index.md)을 따른다.

## Purpose / Big Picture

초안 상태도에서 상태를 추가하고 두 상태와 발생 이벤트를 골라 전이를 만든다. 선택한 상태/규칙은 기존 폼을 재사용하는 옆 편집기에서 수정한다. 실제 실행/과거 snapshot 그림은 계속 읽기 전용이며 엔진·저장 schema·production dependency는 바꾸지 않는다.

## Progress

- [x] 폼·그림·revision·pending JSON·snapshot 계약 확인.
- [x] 상태/전이 생성과 안전한 endpoint 검사·초안 변경 모델.
- [x] 그래프 연결 모드·선택 편집기·단일 폼 소유·취소/키보드/페이지.
- [x] 실제 작성→실행/저장·snapshot 격리·Chromium/Firefox·390px·기존 응답성 검사.
- [x] 완료 기록·Git 전달 준비. 실제 원격/CI 상태는 최종 전달에서 별도로 확인.

## Surprises & Discoveries

기존 그림은 draft revision마다 remount되며, 폼이 `data-path`로 초점·diagnostics를 찾는다. 새 편집기는 동일 필드를 중복 렌더하지 않고 목록과 옆 편집기 중 한 곳에서만 소유해야 한다. 규칙은 다른 상태로 가는 빈 동작 전이를 허용하지만 자기 전이의 빈 동작은 명시적 무시여야 한다. 조건이 없는 같은 이벤트 규칙의 충돌은 기존 validator가 검사한다.

- 실제 브라우저 검사에서 새 항목의 외부 선택 페이지가 연결 모드 진입 시 사라지는 문제를 확인했다. 초안 선택 페이지를 유지하되 연결 중에는 수동 페이지 이동과 두 endpoint 표시를 허용한다.
- 목록으로 폼을 옮기는 동작과 그림의 선택 해제를 분리했다. 선택 ID/index와 확대를 유지하면서 같은 JSON Pointer는 한 번만 렌더한다.

## Decision Log

| 날짜 | 결정 | 이유 |
| --- | --- | --- |
| 2026-11-03 | 버튼·두 상태 선택과 기존 native 폼/SVG 사용 | 추가 dependency 없이 포인터/키보드 지원 |
| 2026-11-03 | 상태 생성은 미해결 상태 참조 ID도 예약, 연결은 유일한 ID와 index 확인 | 우연한 참조 복구·중복/삭제 이후 다른 상태 연결 방지 |
| 2026-11-03 | 전이 생성 전 이벤트 선택, 숨은 send/finish 동작 없음 | 사용자 의도를 임의로 추가하지 않음 |
| 2026-11-03 | 기존 이벤트 충돌은 안내하고 초안으로 생성해 조건 폼에서 해결 | 조건부 평행 규칙 작성 허용, 실행은 기존 진단이 차단 |
| 2026-11-03 | 선택 폼은 기존 목록에서 분리해 오른쪽에서 한 번만 렌더 | data-path 초점·invalid JSON·자동 저장 의미 유지 |

## Outcomes & Retrospective

초안의 상태 추가·두 상태/이벤트 선택·전이 생성과 기존 상태/규칙 폼의 옆 편집기를 구현했다. 자유 배치/드래그·실행 snapshot 직접 수정·새로운 모델 언어는 포함하지 않는다. 처음 범위는 상태 추가→두 상태 연결→기존 규칙 편집이며 작성한 정의가 실제 엔진에 전달되는 것을 검증한다.

## Context and Orientation

[제품 명세](../../product-specs/protocol-simulator-v1.md), [구조](../../../ARCHITECTURE.md), [개발 기준](../../development.md)을 따른다. `src/application/diagram-authoring.ts`가 생성·참조 검사, `ProtocolStateDiagrams`/`StateDiagram`이 연결·선택, `DraftDiagramEditor`와 기존 `ProtocolEditor`/`RuleEditor`가 단일 폼을 소유한다. App의 기존 edit 경로가 실행 정지·revision/참여자 참조·pending JSON·저장을 처리한다.

## Plan of Work

1. 기존 참조를 보존하는 ID 생성과 endpoint/event 검사를 순수 함수로 추가한다.
2. 상태도에 추가/연결/취소·event 선택·출발/도착 표시를 붙이고 생성 후 선택/페이지를 맞춘다.
3. 오른쪽 편집기와 목록의 단일 소유, 구조 변경 시 선택 해제, 미완성 JSON 보존과 오류 이동을 연결한다.
4. 실제 생성/편집/실행/저장·새로고침·취소·자기/평행 전이·중복/미해결 참조·정의 전환·실행 중 편집·snapshot 격리와 대형 회귀를 검사한다.

## Validation and Acceptance

source 변경 뒤 Node 테스트·strict 타입 검사, 최종 `pnpm check`와 staging 포함 공백 검사를 수행한다. Chromium/Firefox에서 pointer·Enter/Space·390px와 화면 캡처를 실제 확인한다. 기존 10k/1 MiB·연동 수치 상한을 유지한다. 실제 Git/CI·배포 상태를 구분한다.

## Idempotence and Recovery

취소는 초안을 변경하지 않는다. 연결 중 정의 revision이 바뀌면 선택을 무효화하고 다시 고른다. 생성 직후 연결 모드를 종료해 중복 제출을 피한다. 미완성 조건/동작과 오류는 기존 draft 저장·진단·내보내기 경로를 사용한다. 실행 snapshot은 수정하지 않는다.

## Artifacts and Notes

macOS·Node 24.18.0·pnpm 9.15.0에서 최종 `pnpm check` 전체를 통과했다. lint·포맷·strict 타입 검사, Node 250개·문서 31개, Chromium 156.0.8078.4/Firefox 157.0 E2E 134개와 응답성 2개다. 새 상태/전이를 실제 엔진에서 실행하고, 조건·finish 동작·저장/새로고침·invalid JSON·단일 data-path·자기/평행 전이·취소·미해결/중복 ID·페이지/확대·정의 전환·실행 중 추가 정지·snapshot 격리를 검증했다.

데스크톱 옆 편집기와 390px 아래로 쌓인 폼/그림 캡처를 실제 열어 확인했다. 선택 편집기는 native 스크롤·기존 오류/폼·전체 목록 복귀를 사용한다. 기존 실행/시퀀스/연동·IndexedDB 회귀 검사도 포함했다.

| 실제 fixture | 실행 | 입력 p95 | 그림 연동 | 상세 | 저장 | cursor 왕복 | frame p95 | 최대 long task |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10,000 이벤트 | 3464ms | 55.2ms | 76.9ms | 50.6ms | 67.3ms | 104.8ms | 16.8ms | 관찰 없음 |
| 정확히 1 MiB wire | 359ms | 35.2ms | 45.4ms | 39.6ms | 304.7ms | 59.3ms | 16.8ms | 132ms |

기존 수치 상한과 초기 자동 저장 완료 후 연동 측정·전체 프레임 관찰 범위를 유지했다. staging을 포함한 공백 검사 후 Git 전달을 준비한다. 로컬·원격 CI·배포/실제 네트워크는 별도 증거이며 원격 상태는 최종 응답에서 확인한다.

## Interfaces and Dependencies

React/SVG와 기존 선언형 모델만 사용한다. 새 production dependency, 엔진/저장 schema 변경이 없다.
