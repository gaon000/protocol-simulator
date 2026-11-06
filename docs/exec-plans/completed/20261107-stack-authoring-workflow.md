# 새 스택 작성·되돌리기·설정 폼

상태: Completed
종료일: 2026-11-07

[운영 규칙](../index.md)을 따른다.

## Purpose / Big Picture

예제 사본 없이 새 응용 정의와 전송 계층을 구성하고 첫 메시지/검증을 만든다. 스택 초안 편집을 되돌리거나 다시 적용하고 포트·타이머·변수 초기값을 폼으로 작성한다. 기존 두 계층/A·B, native/legacy 문법·실행/저장 schema와 snapshot 경계를 유지한다.

## Progress

- [x] 2026-11-07: clean master `8543239`, 편집/revision·canonical 저장·규칙/raw·모델 검사 확인. `codex/stack-creation-and-editing`에서 시작.
- [x] 새 스택 생성 모델·단계별 작성과 실제 첫 실행.
- [x] 초안별 메모리 편집 이력과 UI/키보드·새 revision 복원.
- [x] 포트·타이머·초기값 폼과 기존 JSON/raw·진단 연결.
- [x] 코어·두 브라우저·native 저장·기존/추가 응답성과 문서 검증. 전체 검사와 마지막 이력 묶음 보강의 최신 빌드 재검사 통과.

## Surprises & Discoveries

- canonical controller는 mutable draft를 복제한다. 편집 결과를 먼저 소유한 불변 자료로 만들고 이력의 현재 자료와 연결해야 외부 교체와 일반 저장을 구분할 수 있다.
- 과거 정의 revision을 그대로 되살리면 이미 실행한 identity를 재사용한다. undo/redo는 관찰한 최대 revision보다 큰 새 revision으로 모든 복원 정의/참조를 함께 갱신한다.
- 같은 protocol ID의 여러 revision도 유효한 자료다. 복원은 정의별로 다른 새 revision을 배정하며 다음 편집도 같은 ID의 최대 revision보다 큰 값을 사용한다. A/B가 서로 다른 revision을 참조한 실제 구성으로 보강했다.
- 이력 조회는 순수하게 유지한다. 이전 렌더링의 조회만으로 최신 이력을 비우지 않도록 외부 교체/삭제의 무효화는 Root의 실제 canonical 갱신 구독에 연결했다. 이전 자료 조회와 실제 외부 교체를 구분해 검사했다.
- 기존 두 JSON 저장 검사는 포트 JSON이 접힌 화면 구조에 맞춰 접근성 이름/명시적 펼치기로 갱신했다. 용량 fixture의 legacy 영역은 최소 한 초안이 필요하고 현재 자료와 합쳐지므로 최종 합계 100개를 확인하도록 구성했다.
- 전달 횟수 기대 조건을 추가하는 중 입력 배열에 잘못 배치한 것을 코어 검사가 잡았다. 올바른 기대 배열로 옮기고 생성 결과를 `StackExperiment` 타입으로 먼저 구성해 strict 검사도 이 경계를 확인하도록 했다.

## Decision Log

- 2026-11-07: 생성은 이름/전송→첫 메시지/빈 규칙 또는 송신·수신 뼈대→검토의 세 단계다. native 응용 정의와 ReliableStreamLite 또는 손실/순서 보장이 없는 데이터그램 전달 뼈대를 조합한다. 자동 규칙 생성 여부를 명시하며 만들기 전까지 canonical 자료는 바꾸지 않는다.
- 2026-11-07: undo/redo는 같은 탭의 초안별 config+raw에만 적용한다. suite/실행 기록·초안 생성/삭제는 대상 밖이다. 모드 전환은 유지, 새로고침은 초기화한다. 같은 경로의 750ms 연속 편집을 묶고 구조 편집/undo/redo는 묶음을 끊는다. 초안당 50개, 전체 이력 8 MiB의 보수적 JSON 예산과 100개 owner 한도다. 한도는 오래된 이력부터 제거하고 현재 편집은 유지한다.
- 2026-11-07: 외부 복원/가져오기/충돌 병합으로 config/raw가 교체되면 그 초안의 옛 이력을 폐기한다. 복원은 현재 suite와 실행 기록을 유지하며 draft version·정의 revision을 증가시킨다. 키보드 단축키는 스택 편집 영역에서만 처리하고 텍스트/선택 컨트롤의 기본 키를 가로채지 않는다.
- 2026-11-07: 포트의 고정 역할·서비스/operation·lifecycle와 packet schema identity를 폼으로 편집한다. 다른 참조·peer 계약을 자동 수정하지 않고 기존 진단/명시적 동기화를 사용한다. 타이머/변수 구조 변경은 하위 raw index를 함께 remap한다. 초기값은 선언 타입에 맞는 scalar/hex 또는 보존된 JSON 편집을 사용한다.
- 2026-11-07: 생성은 기존 실행 취소 전에도 용량을 검사해 이미 알려진 한도 초과를 거부한다. 실제 checkpoint 뒤 canonical 추가 직전에 다시 검사한다. 일반 폼의 객체/배열 추가·삭제는 각 편집으로 남기고, JSON 연속 입력은 유효/미완성 양쪽을 같은 경로로 묶는다.

## Outcomes & Retrospective

새 native 응용/전송 스택 생성·첫 검증, 초안별 config/raw 되돌리기/다시 하기, 포트·타이머·초기값 폼을 구현했다. 실행/저장 schema·엔진 버전·production dependency는 유지했다. 로컬 검증은 아래와 같으며 정확한 전달 SHA의 원격 CI는 완료 응답에서 별도로 확인한다.

## Context and Orientation

`StackWorkspace`가 변경/worker·저장 흐름을, `StackEditor`와 규칙 폼이 canonical 경로를 소유한다. `WorkspaceRoot`가 두 모드의 수명과 단일 저장 큐를 유지한다. 새 생성과 편집 이력은 DOM 없는 application 모듈로 분리한다. 기존 raw와 draft reader·full 실행 검사를 사용한다.

## Plan of Work

1. 유효한 두 전송 선택/빈 정의·첫 메시지 모델과 검토 화면을 추가한다. 만들기/취소·한도·가져오기와 새로고침을 검사한다.
2. 이력의 그룹/분기/한도/외부 교체/단조 revision 복원을 구현하고 모든 스택 config/raw 편집에 연결한다.
3. 포트/타이머/초기값 폼을 같은 경로에 연결한다. 복잡한 JSON·unknown 자료를 보존하고 부모 raw에 가려진 폼을 잠근다.
4. 실제 작성→편집→undo/redo→실행→저장/복원을 두 브라우저/viewport에서 확인하고 기존 아홉 성능 fixture와 상한을 유지한다.

## Validation and Acceptance

[개발 기준](../../development.md)·[P7](../../design-docs/p7-validation.md)의 Node 24.18.0/pnpm 9.15.0, `pnpm check`, 공백 검사와 1440/768/390px 캡처를 따른다. 새 생성의 양쪽 전송·빈/첫 흐름 실행, 편집 이력 raw/revision/분기/한도·외부 교체와 저장 실패, 폼의 값/참조/미완성 입력과 저장 왕복을 검사한다. 대형 규칙의 편집/undo/redo 각각 500ms와 기존 응답성을 유지한다. 전달 시 정확한 최종 SHA의 원격 CI를 별도 확인한다.

최종 로컬 검증(2026-11-07, macOS·Node 24.18.0·pnpm 9.15.0):

- `/private/tmp/authoring-check.log`의 전체 `pnpm check`: lint/format/strict 타입·Node 565개(신규 13개)·문서 49개·빌드·Chromium/Firefox UI 314개(신규 18개)·native DB 14개·응답성 9개 통과.
- 코어는 두 전송의 실제 한 번 전달/값 판정·빈 응용 규칙의 저장 가능/실행 불가 구분·잘못된 ID/한도/충돌, raw+suite/snapshot 보존·같은 경로 묶음/분기·초안 격리/외부 교체·이력 예산·이름 변경/잘못된 참조/같은 ID 여러 revision·선언 리스트 raw remap과 주입한 quota 실패 뒤 복원을 검사했다.
- UI는 생성 검토/취소·첫 입력/규칙/기대 실행과 native 복원, 빈 규칙/100초안의 실제 공유 한도·거부 시 부분 실행 보존, undo/redo의 raw/분기·모드 유지·키보드 기본 키/과거 실행 격리·새로고침 이력 초기화, 포트 operation 진단/상위 JSON 복원과 선언 타입·odd hex/0/false·변수 삭제 후 raw 이동·타이머/21변수의 실제 페이지 진단을 확인했다. 1440/768/390px 넘침 검사를 통과하고 Chromium 1440/Firefox 390의 생성 검토와 포트 폼 캡처를 직접 확인했다.
- 전체 검사 후 일반 구조 편집/연속 JSON의 묶음 경계와 canonical 교체의 무효화를 보강했다. 최신 build/strict 타입·관련 코어 13개와 `/private/tmp/authoring-final-ui.log`의 새 작성/기존 규칙 폼 36개를 재통과했고 두 규칙 추가가 각각 되돌려지는 것도 확인했다. 완료 이동 뒤 최종 lint/format·문서 49개·공백 검사도 통과했다.
- 실제 605개 동작: 열기 51ms·순서 변경 48ms·undo 61ms·redo 64ms, 폼 DOM 3665자·목록 10개. 저장 원본 605개 보존. 기존 스택 1 MiB 실행 1326ms·rAF p95 16.7ms·최대 long task 0ms, 20사례 실행 876ms·저장 850ms, legacy 1 MiB 저장 1383ms와 기존 200k trace/두 기록 비교도 같은 상한을 통과했다. CPU 1배 Chromium 156.0.8078.4의 로컬 측정이며 다른 기기의 보증치가 아니다.
- 이력 자체는 저장하지 않으며 suite 자체/초안 생성·삭제/실행 기록의 undo는 제공하지 않는다. Safari·실기기 모바일·실제 네트워크·배포는 검증 범위가 아니다. 기존 큰 chunk build advisory는 유지한다.

## Idempotence and Recovery

생성 검토/취소는 저장 자료를 바꾸지 않는다. 생성 commit은 당시 공유 용량을 다시 검사한다. 이력은 config/raw만 복원하고 저장 실패에도 메모리와 내보내기를 유지한다. 외부 자료를 옛 이력으로 덮어쓰지 않는다.

## Artifacts and Notes

- [현재 구조](../../../ARCHITECTURE.md)
- [스택 작업 공간](../../design-docs/s5-stack-workspace.md)

## Interfaces and Dependencies

생성/이력/선언 폼 API를 추가하고 기존 편집 callback을 사용한다. production dependency·엔진/저장 schema는 변경하지 않는다.

## 원격 검증 후속

전달 `237492a`의 원격 CI에서 기존 성능 두 경계와 다음 실행의 기존 Firefox 가져오기 준비 대기가 실패했다. 위 로컬 결과와 구분하며 실제 실패·보완·최종 검증은 [CI 후속 계획](20261107-stack-authoring-ci-validation.md)에 기록한다.
