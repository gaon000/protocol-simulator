# 스택 규칙의 조건·동작 폼 편집

상태: Completed
종료일: 2026-11-06

[ExecPlan 운영 규칙](../index.md)을 따른다.

## Purpose / Big Picture

계층 연결 스택의 규칙에서 입력/수신/타이머/서비스 이벤트, 비교·AND/OR/NOT, 값 참조·계산과 동작 목록을 폼으로 작성한다. 기존 JSON과 같은 초안을 편집하며 동작 순서 변경·복제·삭제와 미완성 입력의 저장/복원을 지원한다. 기준은 [V1-021](../../product-specs/protocol-simulator-v1.md#v1-021-스택-규칙의-조건동작-폼-편집)이다.

새 엔진/표현식/저장 형식을 추가하지 않는다. 기존 응용 adapter와 네이티브 정의가 지원하는 문법을 구분하고 실행 snapshot을 수정하지 않는다. 임의 JSON 값과 큰/복잡한 하위 트리는 고급 JSON 편집으로 보존한다.

## Progress

- [x] 2026-11-06: clean master `a3bdc8d`, 모델/초안 reader·revision/raw 편집·스택 규칙 JSON 화면 확인. `codex/stack-rule-forms`에서 착수.
- [x] DOM 없는 기본값/범위·리스트 편집과 raw remap 구현. 새 코어 14개 통과.
- [x] 선택한 규칙의 이벤트·조건·표현식·동작 폼과 JSON 편집/진단 초점 연결.
- [x] 실제 규칙 편집→실행·순서/타입·JSON 왕복·저장/부분 raw·큰 트리·키보드/viewport 검증. 새 UI 18개와 대형 작성 fixture 통과.
- [x] 전체 검사·문서와 완료 기록 갱신. 로컬 전체 검사와 마지막 진단 이동 보강의 최신 빌드 재검증 통과.

## Surprises & Discoveries

- native draft reader는 일부 표현식의 의미 검사를 실행 전까지 유예한다. 폼은 잘못되거나 미래 문법인 expression을 강제로 정규화하지 않고 JSON으로 보존/수정할 수 있어야 한다.
- 기존 배열 전체 교체는 해당 하위 raw를 비운다. 리스트 구조 변경은 한 번의 draft 변경으로 config와 raw index를 함께 이동/복제/삭제해야 한다.
- Playwright의 wrapping label 텍스트에는 select/textarea 내용도 들어가므로 exact label selector가 새 검사에서 실패했다. 실제 접근성 이름의 role selector로 수정했다. 동작 이동 검사는 이동할 동작을 먼저 선택해, 비선택 동작을 옮길 때 기존 선택을 보존하는 동작과 구분했다.
- 목록 이동 후 초점 요청을 유지하면 다음 값 편집 때 초점이 다시 이동할 수 있어 성공한 요청은 한 번만 소비한다. 중첩 목록의 추가/이동도 실제 대상 페이지/초점으로 연결했다.

## Decision Log

- 2026-11-06: 기존 `editStackExperiment`의 exact revision 재연결·pause·generation과 저장 흐름을 사용한다. 리스트 변경만 raw를 함께 다루는 application helper를 추가한다.
- 2026-11-06: 현재 이벤트의 필드·서비스 payload, 선언한 변수·메시지/타이머/포트를 선택지로 제공한다. 없는 참조/다른 타입은 지우지 않고 기존 진단으로 표시한다.
- 2026-11-06: 규칙 하나·동작 하나를 선택해 편집한다. 목록 10개/참조 선택지 20개와 검색, 트리 48개 node/깊이 6, JSON 16384자·hex 8192자로 화면을 제한하고 원본은 보존한다.
- 2026-11-06: number/hex 미완성 입력은 기존 raw 경로에 `number:`/`hex:` 접두어로 보존해 다른 JSON 텍스트와 구분한다. 미완성 상위 JSON은 하위 폼/리스트 변경을 막고 해당 raw 편집을 제공한다.

## Outcomes & Retrospective

선택한 규칙/동작의 이벤트·조건·표현식·순서와 JSON 편집을 연결했다. 원래 문법과 실행 의미·snapshot을 유지하고 pending raw를 구조 변경과 함께 원자적으로 이동한다. 새 엔진 문법·저장 schema·의존성을 추가하지 않았다. 로컬 완료 증거는 아래와 같으며 원격 전달 commit의 CI 결과는 완료 응답에서 별도로 확인한다.

## Context and Orientation

`StackEditor.tsx`가 exact 정의 revision의 폼/JSON을 작성하고 `StackWorkspace.tsx`가 pause·edit/raw와 controller update를 소유한다. `stack-model.ts`와 `protocol-model.ts`는 native/legacy 문법을 구분하며 `parseStackExperiment`가 실행 가능성·타입·참조를 검사한다. v2 raw는 기존 값이 있는 JSON Pointer에 저장한다.

## Plan of Work

1. `stack-rule-authoring.ts`에 기본 expression/condition/action 생성과 리스트의 immutable 편집·raw index remap을 작성한다. 현재 unknown 데이터와 snapshot을 변형하지 않는다.
2. `StackRuleForm.tsx`와 트리 편집기를 선택 규칙에 연결한다. JSON은 동일한 경로를 편집하고 접기/보기를 바꿔도 pending raw를 보존한다. 동작 순서·값 참조의 실행 의미를 바꾸지 않는다.
3. snapshot 보존·JSON/폼 왕복·타입/참조 오류·nested raw 이동/복제/삭제·한도·키보드와 native 저장을 코어/두 브라우저에서 검사하고 기존 P7 응답성을 유지한다.

## Validation and Acceptance

환경/명령은 [Development](../../development.md), 브라우저/화면/정량 기준은 [P7](../../design-docs/p7-validation.md)을 따른다. Node 24.18.0·pnpm 9.15.0의 `pnpm check`·공백 검사와 1440/768/390px 실제 캡처를 확인한다. 원격 반영 시 정확한 전달 commit의 CI를 별도로 확인한다. 기존 여덟 성능 fixture와 상한을 유지한다. 폼의 큰 규칙 열기/리스트 변경은 500ms·DOM 32768자와 유한 트리/목록을 별도로 검사한다.

최종 로컬 검증(2026-11-06, macOS·Node 24.18.0·pnpm 9.15.0):

- `/private/tmp/rule-check.log`의 `pnpm check`가 lint/format/strict 타입·Node 552개(신규 14개)·Markdown 48개·build·Chromium/Firefox UI 296개(신규 18개)·native DB 14개·응답성 9개를 통과했다.
- 코어는 다섯 catalog의 모든 원래 규칙/표현식 보존·exact 이벤트 필드/서비스 범위·기본값과 지원 문법·동작 순서에 따른 실제 송신 값 차이·이동/복제/삭제/추가의 raw/revision 보존·부모 raw 차단·큰/unknown 트리와 진단 페이지를 확인했다.
- UI는 JSON 없는 비교/AND·변수 참조 작성→실제 실행, 동작 순서 변경의 송신 값 1→0과 frozen 기록 보존, 미완성 숫자/odd hex 저장·새로고침/수정, 상위 JSON 차단·unknown 식 보존·이벤트 변경 진단 초점, 중첩 concat 순서/raw/키보드와 slice JSON 왕복을 확인했다. 1440/768/390px의 가로 넘침 검사를 통과하고 Chromium 1440/Firefox 390 캡처를 직접 확인했다.
- 전체 검사 중 같은 진단을 반복 선택할 때 폼을 다시 열도록 요청 세대를 추가했다. 최신 build와 strict 타입 검사 후 `/private/tmp/rule-final-e2e.log`의 새 UI 18개 전체를 다시 통과했다. 완료 이동 후 최종 문서 48개·lint/format·공백 검사도 통과했다.
- 실제 605개 동작: 폼 열기 59ms, 이동 48ms, 폼 DOM 3665자·목록 10개이며 native 저장 후 전체 605개와 이동한 동작을 보존했다. 기존 스택 1 MiB 실행 1329ms·rAF p95 16.8ms·최대 task 0ms, 20사례 실행 891ms·저장 854ms, legacy 1 MiB 저장 1375ms와 기존 200k trace/두 기록 비교도 모두 같은 상한을 통과했다. Chromium 156.0.8078.4·CPU 1배의 로컬 측정이며 다른 기기의 보증치가 아니다.
- 임의 JSON/큰 트리는 고급 JSON 또는 bundle 편집으로 보존한다. Safari·실기기 모바일·실제 네트워크·배포는 이번 검증 범위가 아니다. 빌드의 기존 큰 chunk advisory는 남아 있으며 의존성/한도를 바꾸지 않았다.

## Idempotence and Recovery

한 UI 변경은 한 draft revision으로 반영한다. 이동/복제는 원본 raw를 remap하고 삭제는 선택한 항목만 제거한다. 미완성 상위 raw를 자동 폐기하지 않는다. 오류/저장 실패는 마지막 렌더링 가능한 구성·pending text와 기존 기록을 유지한다.

## Artifacts and Notes

- [스택 작업 공간](../../design-docs/s5-stack-workspace.md)
- [기존 JSON 편집](../../../src/ui/StackEditor.tsx)
- [현재 구조](../../../ARCHITECTURE.md)

## Interfaces and Dependencies

Editor의 리스트 편집 callback과 탭별 폼 상태만 추가한다. 엔진/저장 schema/production dependency는 변경하지 않는다.
