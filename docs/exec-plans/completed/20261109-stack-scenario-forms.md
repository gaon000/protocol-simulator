# 스택 시나리오·기대 조건 폼 편집

상태: Completed
종료일: 2026-11-09

[운영 규칙](../index.md)을 따른다.

## Purpose / Big Picture

스택 작성의 입력 메시지·네 기대 조건을 폼으로 설정해 상태도 작성→입력/기대 설정→실행/회귀 검증을 연결한다. 기존 JSON·미완성 raw·undo/redo·canonical 저장과 실행 snapshot을 보존한다. 엔진/저장 schema·새 기대 종류·새 의존성은 추가하지 않는다.

## Progress

- [x] 2026-11-09: clean master `28588b4`, 기존 입력/기대 JSON·typed 값·exact 정의·편집/이력·회귀 사례 capture/복원을 확인했다.
- [x] 순수 작성 helper·리스트 raw 원자적 이동과 실제 엔진/저장/이력 경계. 새 코어 7개 통과.
- [x] 유한 목록/선택 폼·생략/기본값·자료형·진단/JSON 복구·키보드 연결. 새 UI 20개와 큰 작성 응답성 별도 검사 통과.
- [x] Chromium/Firefox·native 저장/회귀·대형 작성 응답성과 전체 `pnpm check`·문서/공백 검사 완료. 최종 전달 SHA의 원격 CI는 완료 응답에서 별도로 확인한다.

## Surprises & Discoveries

기존 UI는 입력/기대를 처음 20개까지만 표시하고 메시지/기대 내용은 JSON이다. 입력/전달 기대는 상위 application만 대상으로 하며 상태/완료 기한은 전송 인스턴스에도 적용된다. 값은 실제 engine의 기본값을 반영하므로 생략과 명시적 0/false/빈 문자열/빈 bytes를 구분해야 한다. 회귀 사례는 초안의 scenario/environment/seed를 고정해 capture하고 사례 조건을 초안으로 복원한다.

- 브라우저 첫 검사에서 select의 label에 option 문구가 섞여 exact 이름으로 찾지 못했다. 명시적인 접근성 이름을 붙였다. 메시지 JSON을 미완성으로 만들면 즉시 원래 경로의 복구 편집기로 교체되므로 검사도 사라진 보기 전환 버튼 대신 복구 컨트롤을 사용한다. 회귀 완료는 실제 `묶음 종료` 상태로 기다린다.
- 정의에 없는 값은 보존/JSON 편집과 별도 명시적 삭제 버튼을 사용한다. checkbox로 값이 사라지며 다른 선택으로 교체되는 혼동을 없앴다. 보완 후 두 브라우저 새 UI 20개가 통과했다.
- fixture의 shared message alias는 `structuredClone` 후에도 공유되므로 입력/기대를 독립 객체로 구성했다. 식별자는 기존 ASCII 계약을 유지하고 escaped key는 정의에 없는 실제 값의 복구 검사에서 사용한다. 기존 scalar byte codec은 bytes 필드 전송을 지원하지 않는다. typed hex의 저장/복구는 native 미완성 초안에서 검사하고, 실제 실행·회귀는 지원되는 scalar 모델로 검사한다. 엔진의 지원 범위/진단을 바꾸지 않았다.
- 로컬 큰 실제 모델(입력/기대 125개·메시지 125개·필드 129개)의 열기 41ms·페이지 37ms·항목 34ms·필드 37ms·추가 59ms·undo/redo 59/51ms, 최대 DOM 1638자와 저장 원본 보존을 확인했다. 이는 CPU 1배·Chromium의 해당 실측이며 최종 전체 검사와 구분한다.
- Chromium 1440px의 나란한 목록/선택 폼과 Firefox 390px의 세로 배치를 캡처로 직접 열어 확인했다. 문서 가로 넘침 없이 textarea의 LF와 값 포함/생략 상태를 표시한다. CR 문자가 있는 문자열은 HTML 정규화로 소실되지 않도록 escaped JSON 편집을 사용한다.
- 첫 전체 검사의 기존 선언 리스트 테스트는 이제 지원하는 `/scenario/inputs`를 거부하도록 작성돼 실패했다. 새 시나리오의 실제 raw 이동 검사를 유지하고 기존 부정 경계는 여전히 지원하지 않는 실제 배열 `/bindings`로 갱신했다. 이후 전체 Node 593개가 통과했다.
- 선택 메시지 전체 경로의 pending raw도 하위 필드 경로와 같이 차단하도록 리뷰에서 보강했다. exact 선언/대상 child raw를 검사하는 UI 두 건을 추가해 새 UI 22개를 통과했다. 여러 일반 JSON raw는 선택한 행의 짧은 경로부터 하나씩 복구하며, 숫자/hex의 직접 입력은 유지한다. 16001자 raw 두 개도 동시에 펼치지 않고 원본을 보존한다.

## Decision Log

- 2026-11-09: 입력/기대를 10개씩 탐색하고 선택 항목 하나만 편집한다. 필드도 페이지/선택 편집과 선언 후보 검색을 사용해 큰 값·많은 행의 DOM을 제한한다. 정확한 endpoint/정의 revision·유일한 메시지/필드만 폼의 선언으로 사용한다.
- 2026-11-09: 대상/메시지 선택은 기존 값을 자동 삭제하거나 재매핑하지 않는다. 생략 값과 기본값을 표시하고 포함을 명시적으로 선택한다. 기대 종류 변경은 필요한 값만 새 구조로 만들되 미완성 하위 raw가 있으면 먼저 복구한다.
- 2026-11-09: 부모 raw는 해당 원래 경로에서 복구하며 하위 폼을 대신 렌더하지 않는다. 리스트 추가/삭제/이동은 기존 atomic raw remap과 이력을 사용한다. 일반 시나리오 편집은 정의 revision과 frozen 실행/사례를 바꾸지 않는다. undo/redo의 fresh exact revision 정책은 유지하며 같은 필드 ID의 선택은 보존한다.

## Outcomes & Retrospective

스택 입력 메시지의 typed 값·포함/생략과 네 기대 종류의 폼을 구현했다. 정확한 참조·기존 실행 검사·JSON/raw 복구·리스트 이동/페이지·undo/redo·native 저장·기존 사례/회귀 흐름을 연결했다. 전체 로컬 검사와 직접 화면 확인을 완료했다. 최종 전달 SHA의 원격 CI는 완료 응답에서 별도로 확인한다. 엔진/저장 schema·의존성·실제 네트워크는 변경하지 않았다.

## Context and Orientation

`StackEditor.tsx`의 입력·기대 탭을 새 `StackScenarioForm.tsx`로 분리한다. 값 입력은 `StackValueInput.tsx`, 순수 선언/생성 정책은 `stack-scenario-authoring.ts`, 구조 변경은 `edit-stack-list.ts`를 사용한다. 모든 변경은 `StackWorkspace`의 canonical update/세대 fence/이력과 저장 큐를 거친다.

## Plan of Work

1. 정확한 선언·고유 ID·필드 초기값·네 기대 구조와 pending raw guard를 구현하고 실제 엔진/이력/저장 회귀를 검사한다.
2. 대상·메시지/필드·네 기대 폼, 선택/페이지/진단 이동과 명시적 JSON 복구를 연결한다. 문자열은 CRLF를 보존하며 integer/bytes 미완성 입력은 기존 raw를 사용한다.
3. 두 브라우저에서 작성→실행→사례 capture/회귀→수정/과거 기록 격리·undo/redo·저장/새로고침·큰 페이지/검색·390px 키보드를 검사한다. 기존 P7 예산을 유지한다.

## Validation and Acceptance

Node 24.18.0·pnpm 9.15.0으로 관련 코어·UI, strict 타입·lint/format·문서, 최종 `pnpm check`·공백 검사를 수행한다. 큰 시나리오/필드에서도 열기/선택/페이지/추가/undo/redo 500ms·DOM 32768자를 유지하며 저장 원본을 대조한다. 최종 전달 SHA의 원격 CI와 로컬 결과를 구분한다.

2026-11-09 macOS의 실제 결과:

- `/private/tmp/stack-scenario-check.log`: 최종 `pnpm check` 통과. lint/format·strict 타입·Node 593개·문서 53개·Chromium/Firefox UI 356개·native DB 14개·응답성 11개.
- 새 코어 7개는 exact/중복/없는 endpoint·정의 revision/native/legacy, 선언 raw의 root/child·무관 raw, default/0/false/빈 값/bytes seed, 네 기대 shape/종류 교체 raw guard, 리스트 추가/삭제/이동의 integer/hex/escaped raw·정의 revision 유지와 실제 실행의 pass→fail·undo/redo·v2 저장/frozen 기록을 검사했다. 별도 전체 Node도 593개 통과했다(`/private/tmp/stack-scenario-node.log`).
- 새 UI 22개는 1440/768/390px의 작성→실제 실행→undo/redo→native 저장/새로고침·snapshot 격리, 네 기대 종류와 실제 실패/전송 상태 대상, 숫자/hex pending·raw 재배치/복구·부모 JSON·미완성 선언 전체/대상 child 경계, 125번째 항목/필드 진단과 검색, 없는 메시지/escaped 남은 값의 명시적 삭제, 사례 capture/회귀와 CRLF 원본 보존을 검사했다(`/private/tmp/stack-scenario-ui.log`).
- 큰 실제 모델(입력/기대 125개·메시지 125개·필드 129개)을 실제 scheduler로 실행한 뒤 작성 화면을 측정했다. 전체 검사에서 열기/페이지/항목/필드 40/36/37/35ms·추가/undo/redo 59/61/53ms, 큰 pending raw를 포함한 최대 DOM 16877자와 원본 전체 저장을 통과했다. 이후 typed 폼이 실제 열린 시점에 후보가 1~20개인지 검사하도록 보강했고 별도 응답성도 통과했다(`/private/tmp/stack-scenario-performance-final.log`: 40/36/35/36/55/62/51ms·16877자). 보강한 테스트의 strict 타입·포맷·공백 검사도 수행했다.
- 기존 native 10k: 실행 1838ms·선택 230ms·50ms 이상 long task 없음. legacy 1 MiB 저장 1377ms/3000ms, native 1 MiB와 20사례/200k 관찰·기존 상태도/규칙 작성 성능도 동일 상한으로 통과했다. CPU 1배·Chromium 156.0.8078.4의 해당 실측이며 다른 기기의 보증은 아니다.
- Safari·실기기·스크린리더 조합·실제 네트워크·배포는 검사하지 않았다. 기존 큰 chunk build advisory는 유지했다.

## Idempotence and Recovery

없는/중복 참조·타입 불일치·미완성 값은 보존하고 기존 진단으로 수정한다. 선택/검색은 초안을 바꾸지 않는다. 구조 편집은 raw와 함께 이동하며 raw 복구·undo/redo·새로고침 뒤에도 원래 값을 유지한다. 저장 실패/충돌은 기존 controller 정책을 따른다.

## Artifacts and Notes

주요 로그는 위 경로에 기록했다. Playwright의 새 시나리오 검사 output에 1440/768/390px `scenario-form.png`를 보관했다. 기준은 [제품 명세](../../product-specs/protocol-simulator-v1.md)·[S5](../../design-docs/s5-stack-workspace.md)·[P7](../../design-docs/p7-validation.md)다.

## Interfaces and Dependencies

작성 화면과 순수 작성 API만 확장한다. 기존 네 기대 종류·engine/storage version·schema·의존성은 유지한다.

## 원격 검증 후속

`d43c420`의 [첫 CI](https://github.com/gaon000/protocol-simulator/actions/runs/42566715527)는 새 UI 22개를 포함한 UI 356개·Node 593개·문서 53개·native DB 14개와 새 시나리오 성능 검사를 통과했다. 기존 legacy 1 MiB 저장 한 건이 3002.921ms/3000ms로 실패했다. 자료를 보존하고 [저장 검증 비용](20261109-workspace-save-validation.md)을 보완했다. 이후 전체 로컬 Node 597·문서 54·UI 356·native DB 14·성능 11개와 같은 3초 저장 기준을 통과했으며, 최종 전달 SHA의 원격 결과는 완료 응답에서 따로 확인한다.
