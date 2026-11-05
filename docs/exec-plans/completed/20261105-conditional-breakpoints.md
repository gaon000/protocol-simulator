# 중단점과 조건부 실행 정지

상태: Completed
종료일: 2026-11-05

[ExecPlan 운영 규칙](../index.md)을 따른다.

## Purpose / Big Picture

상태 진입·해석된 메시지 수신·전이 후 변수 조건에서 자동 실행/과거 재생을 멈추고 해당 이벤트·조건·실행 설명으로 이동한다. 같은 실행을 계속하거나 한 단계 진행하며 중단점이 없는 실행과 동일한 최종 결과를 보존한다.

## Progress

- [x] clean master와 엔진 batch/원자성·실행 session·history cursor 확인, feature branch 생성.
- [x] 중단점 검증/유한 평가·안전한 batch 정지와 관련 코어 13개 통과.
- [x] 편집/활성/계속/한 단계·정지 근거·재생과 새 Chromium/Firefox 16개 통과. 390px screenshot에서 입력·정지 근거·버튼 줄바꿈 확인.
- [x] 제품/구조·전체/응답성 검사·완료 기록과 Git 전달 준비. 최종 `pnpm check`: Node 318·문서 37·Chromium/Firefox E2E 212·응답성 2개 통과.

## Surprises & Discoveries

- 하나의 하위 수신이 여러 parsed/transition을 생성할 수 있다. live는 queue 처리 하나를 끝낸 뒤 멈추며 일치 이벤트 이후 같은 처리 단계의 관찰이 더 있을 수 있음을 표시한다. history는 기록 이벤트 하나씩 이동하므로 정지 위치가 더 이르다.
- 기존 runBatch는 64 queue 작업을 한꺼번에 처리한다. optional stop predicate를 작업 사이에 호출해 batch 내부의 첫 일치를 놓치지 않으며 기존 호출은 같은 경로를 유지한다.
- 첫 브라우저 검사 16개 중 14개가 통과했고 수정 후 새 실행 두 건이 revision 불일치로 차단됐다. 초안 수정은 protocol revision을 올리므로 동일 protocol ID의 stable 대상은 실행/재생마다 당시 revision에서 ID/타입을 다시 검사해 연결하도록 보강했다. 다른 protocol ID·없는 대상·바뀐 변수 타입은 계속 거부한다.
- revision 보강 뒤 브라우저 16개를 재실행해 모두 통과했다. formatter의 check/format 출력 차이는 format 명령으로 정리하고 동일 check가 통과함을 확인했다.
- 기존 단일 bundle의 Vite 500 kB advisory는 유지된다(이번 build JS 약 520 kB, gzip 약 156 kB). 경고 기준을 변경하지 않았고 신규 dependency 없이 실제 runtime 응답성 기준을 확인했다.

## Decision Log

- 2026-11-05: 최대 20개의 상태 진입/parsed 수신/변수 비교 중단점을 제공한다. 실제 transition의 before/after·parsed와 frozen protocol ref를 사용한다. 변수 비교는 전이 후 값에 대해 eq/ne/lt/lte/gt/gte와 JSON literal을 사용하고 타입/참조/크기를 검사한다.
- 2026-11-05: debugger 설정은 실험별 현재 탭 메모리이며 protocol/snapshot/bundle/판정에 넣지 않는다. 설정 변경은 진행을 일시 정지한다. disable·중복/삭제·전체 사용 토글을 제공한다. 반복/회귀 일괄 실행은 중단하지 않고 개별 기록 재생에서 사용한다.
- 2026-11-05: 같은 이벤트는 계속 실행 시 재평가하지 않는다. 다음 실제 전이에서 조건이 계속 참이면 다시 멈출 수 있다. 수동 한 단계와 cursor 이동은 자동 중단과 별개로 허용한다. 평가 오류/한도는 debugger 정지로 표시하며 engine 오류나 기대 조건 실패를 만들지 않는다.
- 2026-11-05: 설정 당시 revision은 표시하되 같은 protocol ID의 새 revision은 stable 대상과 literal 타입을 재검증해 해당 frozen revision으로 compile한다. 초안의 새 값을 이전 실행/재생 조건 평가에 섞지 않는다.

## Outcomes & Retrospective

상태 진입·해석된 수신·전이 후 변수 조건의 편집/활성·안전한 정지와 근거/설명·계속/수동 단계·과거 재생을 구현했다. 중단점 이후 같은 queue 처리의 추가 관찰을 명시하며 최종 trace/상태/판정 동등성을 검증했다. debugger 오류는 engine 결과와 분리하며 기존 session fence·snapshot·history prefix를 유지한다.

Node 24.18.0 / pnpm 9.15.0의 최종 `pnpm check`에서 Node 318개·문서 37개·Chromium/Firefox E2E 212개·20개 활성 중단점의 응답성 2개가 통과했다. 390px screenshot의 정지 근거/폼/버튼 줄바꿈과 키보드 선택을 확인했다. 설정은 탭 메모리이고 새로고침 시 초기화한다. 반복/회귀 일괄 실행 정지는 범위 밖이며 개별 기록 재생에서 사용한다. 실제 Git/원격 CI 전달 상태는 별도로 보고한다.

## Context and Orientation

`SimulationEngine.runBatch/step`는 queue·난수·trace와 원자적 규칙을 소유한다. application matcher가 debugger 규칙을 해석하고 App의 기존 session fencing/playing/history cursor가 자동 진행과 공유 선택을 소유한다. UI는 당시 설정의 상태/메시지/변수 ID를 선택한다.

## Plan of Work

1. debugger 모델/검증과 현재 이벤트의 유한 matcher를 구현한다. 엔진 optional predicate는 각 queue 처리 끝의 새 trace만 전달한다.
2. 단일 실행·단계·기록 자동 재생과 계속/설명/시퀀스 이동을 연결하고 설정별 오류를 표시한다.
3. 실제 엔진의 최종 기록 동등성·재시도·합쳐 읽기·rollback/한도·세대 fence·snapshot/과거 prefix·브라우저/390px/키보드를 검사한다.
4. 기존 10k/1 MiB 응답성 기준을 유지하고 전체 `pnpm check`·공백·문서·Git/CI를 마무리한다.

## Validation and Acceptance

Node 24.18.0 / pnpm 9.15.0. strict/lint/format/build·Node·Chromium/Firefox·기존 응답성·docs·git diff를 수행한다. 실행 후 중단점 유무의 trace·결과·난수 순서가 같아야 한다. 실제 네트워크/배포는 범위 밖이다.

최종 macOS Chromium 156.0.8078.4 / CPU rate 1 / 활성 중단점 20개 결과: 10k 실행 3467ms·제어 77ms·연동 74ms·설명 59ms·진단 69ms·구조 61ms·저장 65ms·cursor 113ms·frame p95 16.8ms·최대 long task 0ms. 1 MiB 실행 415ms·제어 54ms·연동 50ms·설명 68ms·진단 67ms·구조 63ms·저장 303ms·cursor 62ms·frame p95 16.8ms·최대 long task 128ms. 기본 Idle 상태 중단점 20개는 실제 진입이 없으므로 정지하지 않음을 확인했으며 기존 fixture/상한을 완화하지 않았다.

## Idempotence and Recovery

정지해도 큐·타이머·난수를 유지하며 reset/교체는 기존 session generation으로 오래된 callback을 막는다. 재생은 저장 기록을 수정하지 않는다. debugger 설정은 새로고침 시 초기화하며 저장된 protocol과 기록은 기존 정책으로 복원한다.

## Artifacts and Notes

현재 제품 기준은 [제품 명세](../../product-specs/protocol-simulator-v1.md)에 갱신한다. 실제 검사 결과와 한계는 이 계획에 기록한다.

## Interfaces and Dependencies

runBatch에 optional stop predicate를 추가한다. engine 의미·trace/storage 버전·production dependency는 변경하지 않는다. 임의 사용자 JavaScript 실행은 제공하지 않는다.
