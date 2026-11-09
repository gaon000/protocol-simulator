# 스택 상태도 시각적 편집

상태: Completed
종료일: 2026-11-09

[운영 규칙](../index.md)을 따른다.

## Purpose / Big Picture

계층 연결 스택의 편집 화면에서 A/B의 응용·전송 인스턴스를 선택하고 상태를 추가하거나 두 상태를 연결해 규칙을 만든다. 선택 항목은 기존 상태/규칙 폼 한 곳에서 편집하며 config/raw·undo/redo·저장 흐름을 공유한다. 실제 실행/과거 snapshot은 읽기 전용이다. 자유 배치·드래그, 실행/저장 schema 변경과 새 의존성은 포함하지 않는다.

## Progress

- [x] 2026-11-09: clean master `33ff10a`, 기존 SVG 배치·단일 계층 작성·스택 exact revision·raw·편집 이력 확인.
- [x] DOM 없는 생성/참조 검사와 원자적 작성 경계. 현재 자료/owner·유일 선언·pending raw·동일 ID 여러 revision·실제 실행/이력의 새 코어 11개 통과.
- [x] 계층별 상태도·연결/취소·선택 폼·진단/키보드/페이지 연결. 새 UI 20개와 큰 상태도 별도 응답성 통과. 선택 상태 raw 복구·live 생성 정지·미지원 표현식을 포함해 전체 검증한다.
- [x] 코어·두 브라우저·저장/undo/snapshot·대형 응답성 전체 검증과 문서 완료. 최종 로컬 `pnpm check` 통과, 전달 SHA 원격 CI는 완료 응답에서 별도로 확인.

## Surprises & Discoveries

기존 `buildStateDiagram`은 스택의 상태/규칙 배치를 지원하지만 `StateDiagram`의 요약은 v1 이벤트/표현식만 지원한다. native 서비스 요청/통지와 byte 식을 실제 문법으로 표시하도록 확장하고 기존 v1 동작을 회귀 검사한다. `StackEditor`는 canonical JSON 경로를 소유하고 `StackWorkspace`의 변경 경계가 이력과 live 일시 정지를 관리한다.

- 새 UI 검사에서 finish는 종료 상태로 가야 한다는 기존 실행 진단을 확인했다. 사용자가 종료 상태를 명시적으로 선택하도록 실제 작성 검사를 보강했으며, 생성 시 종료/finish를 자동 추가하지 않는다.
- 같은 브라우저에서 두 번째 bundle을 가져오는 검사는 이전 IndexedDB 복원이 끝난 뒤 시작해야 한다. 초기 모드 버튼 활성화를 기다리고, 성공 안내 뒤에도 file input 재활성화를 기다린다. 고정 sleep/timeout 증가를 사용하지 않는다.
- 125상태/605규칙의 유효한 실제 모델을 엔진에서도 실행한 뒤 화면을 측정했다. 로컬 열기 68ms·선택 53ms·페이지 67ms·상태 추가 95ms·undo 73ms·redo 64ms, 마지막 상태 선택 DOM 1427자와 저장 전체 규칙 보존으로 기존 500ms/32768자 기준을 통과했다.

- native draft는 미지원/잘못된 표현식 JSON도 보존한다. 공통 SVG 요약은 unknown 값을 안전하게 읽고 64노드·깊이 6/유한 분기 예산과 명시적 미지원 표시를 사용한다. 원본 표현식/실행 검사는 바꾸지 않는다.
- 전체 상태 JSON 교체는 이전 선택을 해제한다. 복구 검사도 새 상태를 다시 선택해 현재 폼이 활성화됐는지 확인한다. 첫 전체 검사의 기존 UI 314개와 신규 16개는 통과했고 이 재선택 누락 두 브라우저 검사만 실패했다. 보강 후 새 UI 20개를 통과했다.

## Decision Log

- 2026-11-09: 기존 React/SVG 배치·규칙 폼을 재사용한다. 생성은 현재 draft/endpoint/정의 index·ID·revision/자료 참조를 확인한 뒤 상태 또는 전이 하나를 원자적으로 추가한다.
- 2026-11-09: 발생 이벤트는 유일한 메시지/타이머와 선언된 하위 lifecycle·native provides 요청/requires 통지만 선택한다. 빈/중복 상태와 오래된 연결을 거부한다. 상태 ID 생성은 미해결 참조도 예약한다. 자기 전이는 명시적 무시로 만들고 평행 후보는 안내하되 기존 실행 검사로 충돌을 판정한다.
- 2026-11-09: 상태/규칙 폼은 목록과 선택 편집기 중 한 곳에만 렌더한다. 구조 변경·대상 전환의 오래된 선택은 사용하지 않는다. 미완성 부모 raw를 덮어쓰지 않고 복구 입력을 노출한다. 새 생성/리스트 변경은 기존 이력과 raw remap을 사용한다.

## Outcomes & Retrospective

계층별 native/기존 응용 정의의 상태 추가·전이 연결/취소·선택 폼을 구현했다. 기존 exact revision·config/raw 이력·자동 저장과 live 일시 정지를 공유하며 실행 snapshot을 유지한다. 전체 로컬 검사와 직접 화면 확인을 완료했다. 실제 전달 SHA의 원격 CI는 완료 응답에서 별도로 확인한다. 자유 배치/드래그·새 문법·실제 네트워크와 배포는 범위 밖이다.

## Context and Orientation

`src/application/diagram-authoring.ts`의 상태 ID/endpoint 규칙과 `state-diagram.ts`의 유한 배치를 사용한다. 스택 전용 생성 검사는 application 모듈로 분리한다. `StackEditor`가 선택 폼과 진단을, `StackWorkspace`가 canonical 작성과 이력/실행 수명을 연결한다. 현재 [제품 명세](../../product-specs/protocol-simulator-v1.md)·[S5](../../design-docs/s5-stack-workspace.md)·[개발 기준](../../development.md)을 따른다.

## Plan of Work

1. exact source와 선언 이벤트 검사·참조 보존 ID·원자적 추가를 구현하고 native/legacy·raw·실제 실행·snapshot/undo를 검사한다.
2. 기존 SVG에 스택 문법을 표시하고 추가/연결 도구·옆 편집기·단일 폼 소유·진단·확대/페이지·Escape/Enter/Space를 연결한다.
3. Chromium/Firefox의 실제 작성→폼 수정→undo/redo→실행→native 저장/새로고침과 네 endpoint/미완성 raw·오래된 연결·390px를 확인한다. 대형 fixture에서 열린 작성 상태도의 응답성과 원본 보존을 확인한다.

## Validation and Acceptance

Node 24.18.0·pnpm 9.15.0에서 source 변경 뒤 관련 Node 테스트, 최종 `pnpm check`와 공백 검사를 수행한다. 기존 [P7](../../design-docs/p7-validation.md)의 10k/1 MiB/605동작 fixture·500ms 선택/편집·페이지/DOM 한도를 유지한다. 브라우저 화면 캡처를 직접 확인한다. 실제 원격 CI·배포/실제 통신을 구분한다.

최종 로컬 검사(2026-11-09, macOS·Node 24.18.0·pnpm 9.15.0):

- `/private/tmp/stack-visual-check-final.log`의 `pnpm check`: lint/format·strict 타입·Node 581개(신규 11개)·문서 51개·빌드·Chromium/Firefox UI 334개(신규 20개)·native DB 14개·응답성 10개 통과.
- 새 코어는 dangling 상태 ID·native/legacy 이벤트/포트 선언·빈/중복/오래된 endpoint·자료/정의/owner fence·동일 ID 여러 revision·parent/선택 선언 raw·자기/평행 전이·실제 엔진·undo/redo와 snapshot·상위 리스트 raw remap·125상태/605규칙 배치를 확인했다.
- 새 UI는 1440/768/390px의 직접 생성→조건/완료 동작→실제 실행/판정→raw undo→native 저장/새로고침, 공유/독립 정의와 대상 전환·Escape/Enter/Space·선택 폼 단일 소유·큰 페이지/검색·부모/상태 raw 복구·live 정지와 원래 snapshot checkpoint·미지원 표현식 원본 보존을 확인했다. Chromium 1440px의 나란한 그림/폼과 Firefox 390px의 내부 그림 스크롤/아래 폼 캡처를 직접 열어 확인했다.
- 이전 전체 검사에서 기존 UI 314개와 새 UI 16개는 통과했으며 전체 상태 JSON 교체 뒤의 재선택이 빠진 새 검사 두 곳만 실패했다. 복구 후 현재 상태를 다시 선택하는 실제 흐름으로 바로잡았다. 이후 미지원 식 표시도 보강하고 새 UI 20개와 위 전체 검사를 통과했다.
- 기존 native 10k: 실행 1894ms·선택 229ms·최대 long task 84ms, native 1 MiB: 실행 1323ms·선택 224ms·최대 task 0ms, 20사례 실행 878ms·저장 840ms와 기존 두 기록/200k trace 비교·legacy fixture 모두 같은 상한을 통과했다. 최종 전체 검사의 새 큰 상태도는 열기 66ms·규칙 선택 46ms·페이지 93ms·추가 96ms·undo/redo 72/64ms였다. 이후 규칙 폼/페이지/상태 선택의 DOM 최대값을 함께 재검사해 3209/1713/1427자(최대 3209자), 열기/선택/페이지/추가/undo/redo 66/50/64/79/74/65ms를 통과했다(`/private/tmp/stack-visual-performance-final.log`). 새 측정 보강 뒤 strict 타입·lint/format·문서와 공백 검사도 통과했다. CPU 1배·Chromium 156.0.8078.4의 관찰이며 다른 기기의 보증치가 아니다.
- Safari·실기기 모바일·스크린리더 조합·실제 네트워크·배포는 검사하지 않았다. 기존 큰 chunk build advisory와 저장/실행 버전은 유지했다.

## Idempotence and Recovery

취소는 초안을 수정하지 않는다. 현재 자료/정의가 바뀐 생성 요청은 거부하고 다시 선택한다. 부모 raw는 폼으로 삭제하지 않으며 추가/삭제의 하위 raw와 정확한 revision을 함께 갱신한다. 저장 실패에도 메모리·내보내기와 과거 실행을 유지한다.

## Artifacts and Notes

최종 로그 `/private/tmp/stack-visual-check-final.log`, 관련 UI `/private/tmp/stack-visual-ui-complete.log`, 코어 `/private/tmp/stack-visual-core-final.log`. 화면 캡처와 성능 attachment는 Playwright의 해당 test-results/CI artifact에 남긴다.

- [기존 단일 계층 작성](../completed/20261103-visual-protocol-authoring.md)
- [스택 작성/이력](../completed/20261107-stack-authoring-workflow.md)

## Interfaces and Dependencies

스택 초안 작성 API와 화면만 추가한다. 엔진/저장 버전·schema·production dependency는 변경하지 않는다.

## 원격 검증 후속

`dd3a259`의 [첫 원격 CI](https://github.com/gaon000/protocol-simulator/actions/runs/42553970900)는 새 상태도 UI 20개를 포함한 UI 333개를 통과했고 기존 Firefox 반복 실험의 99기록 가져오기 검사 한 곳에서 실패했다. trace의 가져오기 처리 행이 사라지며 탭 위치가 이동했고, 클릭 뒤 실험 구성에 남았다. 적용 안내는 메모리 적용 시점이며 파일 처리/저장 정리 종료와 구분해야 한다. native DB/성능 단계는 시작되지 않았다.

해당 파일에서 완전한 성공 문구를 기다리던 두 곳에도 file input 재활성화 대기를 추가했다. 같은 규칙의 기존 regex 대기들과 일치시키며 앱 source·100기록 fixture/시계·timeout/재시도/성능 상한은 바꾸지 않았다. 로컬 Chromium/Firefox 반복 실험 12개와 strict 타입·lint/format·문서/공백 검사를 다시 확인했다(`/private/tmp/stack-visual-ci-batch-check.log`). 최종 전달 SHA의 전체 원격 결과는 완료 응답에서 별도로 확인한다.
