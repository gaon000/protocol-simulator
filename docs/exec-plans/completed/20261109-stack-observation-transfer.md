# 스택 관찰의 증분 전달

상태: Completed
종료일: 2026-11-09

[운영 규칙](../index.md)을 따른다.

## Purpose / Big Picture

스택 상태도 작성의 최종 검증에서 반복된 기존 native 10k 화면 응답성 실패를 보완한다. 실행 중 이미 받은 불변 관찰을 다시 복사·동결하지 않고 새 관찰/실제 payload만 전달한다. 저장 schema·실행 결과·중단점·성능 기준은 유지한다.

## Progress

- [x] 2026-11-09: 원격 두 번의 실패와 로컬 CPU 프로파일 확인.
- [x] 정확한 불변 기준본의 증분 전달과 client 복원 구현. 새 코어 5개·관련 26개에서 실제 실행/10k·순서/참조/누락/과거 snapshot·client 종료와 재등록 생략을 확인했다.
- [x] 전체 로컬 `pnpm check`와 공백 검사 통과. 최종 전달 SHA의 원격 CI는 완료 응답에서 별도로 확인한다.

## Surprises & Discoveries

`d5f520b`의 [CI](https://github.com/gaon000/protocol-simulator/actions/runs/42554775379)는 UI 334개와 native DB 14개를 통과했지만 첫 시도에서 기존 legacy 1 MiB 저장 3005ms/3000ms·native 10k 최대 task 270ms/250ms가 실패했다. 같은 SHA 재검증에서는 저장이 2990ms로 통과하고 native 10k task가 301ms로 다시 실패했다. 두 번째 trace/보고서를 `/private/tmp/stack-visual-ci-repeat-artifacts`에 보존했다. 소스 변경 없는 재검증은 한 번만 수행했다.

같은 실제 10k fixture/20중단점의 로컬 Chromium CPU 3배 진단(`/private/tmp/stack-main-before.cpuprofile`)에서 전체 관찰 수신 callback·반복 `freezeOwned`와 GC가 주 비용이었다. 최대 task 398ms를 관찰했다. 이는 정규 수락 측정과 구분한다. worker는 매 64회 실행 뒤 커진 전체 prefix를 보내고 main은 매번 새로운 object graph 전체를 동결하고 있었다. 보완 후 같은 조건의 `/private/tmp/stack-main.cpuprofile`에서는 50ms 이상 long task가 관찰되지 않았고 probe 구간이 약 4.12초에서 1.97초로 줄었다. 보조 프로파일 스크립트에는 실제 스택 화면 진입 완료 대기도 추가했다. 초기 모드 전환 직후 다른 입력을 잡은 진단 준비 실패는 앱/성능 검사의 실패와 구분한다.

## Decision Log

- 2026-11-09: 한 ordered worker 채널의 정확한 serial·runId·불변 snapshot/event 행 참조와 payloadId/직렬화된 byte 객체 참조만 재사용한다. payload wrapper는 capture 때 새로 만들어지지만 실제 byte 객체는 같다. ID/길이만 같다는 이유로 내용을 같다고 추정하지 않는다. 수정/축소/다른 snapshot은 전체 전송하며 receiver는 누락/오래된/다른 run 기준본을 거부하고 마지막 관찰을 보존한다.
- 2026-11-09: UI callback에는 기존 완전한 `StackView` 계약을 유지한다. 관찰 조회 cache와 저장 validation/CAS는 변경하지 않는다. 성능 예산·fixture·timeout·skip/retry를 완화하지 않는다.

## Outcomes & Retrospective

기존 화면 callback에는 완전한 readonly view를 유지하면서 실제 새 event/payload만 전송하도록 보완했다. 이전 snapshot·checkpoint와 worker 조회를 보존하고 잘못된 기준본은 부분 적용하지 않는다. 상태도 기능 구현/기존 로컬 전체 검증은 [완료 계획](20261109-stack-visual-authoring.md)에 남겼다. 이번 전체 로컬 검사도 기존 성능 기준으로 통과했다. 최종 전달 SHA의 원격 결과는 완료 응답에서 확인한다.

## Context and Orientation

`stack-ui-worker.ts`는 engine view를 발행하고 관찰 registry를 소유한다. `stack-worker-client.ts`가 복원한 view를 `StackWorkspace`의 runId fence와 canonical 저장에 전달한다. `stack-view-transfer.ts`는 private 전송만 다룬다. engine의 trace/payload는 append-only 불변 자료다.

## Plan of Work

publisher는 이전 소유 view 하나를 보관하고 prefix 행의 실제 동일성을 확인한다. 새 header와 event/payload suffix만 보낸다. receiver는 serial과 runId를 대조해 새 suffix만 동결하고 snapshot/행을 재사용한다. 이전 view는 수정하지 않는다. 실제 실행/부분 checkpoint/새 실행·worker 실패/record 조회를 검사한다.

## Validation and Acceptance

Node 24.18.0·pnpm 9.15.0의 관련 Node 검사, strict 타입·lint/format, `pnpm check`·공백 검사를 실행한다. 기존 P7의 native 10k 최대 task 250ms와 기존 모든 fixture/상한을 유지한다. 최종 전달 SHA의 CI를 따로 확인한다.

2026-11-09 macOS의 최종 `/private/tmp/stack-transfer-check.log`:

- `pnpm check`: lint/format·strict 타입·Node 586개·문서 52개·Chromium/Firefox UI 334개·native DB 14개·성능 10개 통과.
- 새 Node 5개는 실제 first-ack-loss의 모든 checkpoint/원본 bytes·이전 view 유지와 최종 strict 검증, 동일 ID/길이의 다른 event/byte 객체·snapshot 교체/축소·mutable 자료의 full fallback, 누락/오래된/다른 run 기준본 거부, 실제 10k의 각 행 1회 전달·최종 view 완전 일치, client 조회 재전송 생략/실패 후 종료 fence를 확인했다. 관련 기존 모듈을 포함한 26개도 별도 통과했다(`/private/tmp/stack-transfer-core.log`).
- native 10k: 실행 1827ms·선택 226ms·저장 28ms·필터 p95 35ms·rAF p95 17ms. native 1 MiB: 실행 1327ms·선택 219ms. 두 fixture 모두 측정 중 50ms 이상 long task가 없었다. legacy 1 MiB 저장 1384ms/3000ms, 20사례 저장 853ms와 200k 관찰 커버리지도 통과했다.
- 새 125상태/605규칙 작성·페이지/선택/undo/redo와 최대 DOM 3209자 검사를 유지했다. 정규 CPU 1배·Chromium 156.0.8078.4의 실측이며 앞의 CPU 3배 진단과 구분한다. 기존 chunk 크기 advisory는 남는다. 실제 네트워크·배포·Safari/실기기는 검사하지 않았다.

## Idempotence and Recovery

잘못된 기준본은 worker를 닫고 마지막 완전한 관찰/저장 자료를 보존한다. 새 worker에는 새 full view가 필요하다. snapshot/저장 자료는 변경하지 않는다.

## Artifacts and Notes

원격 실패 로그 `/private/tmp/stack-visual-ci-second-full.log`·`/private/tmp/stack-visual-ci-repeat.log`, 보존 trace와 로컬 CPU 프로파일은 위 경로에 있다.

## Interfaces and Dependencies

실행 worker와 client 사이의 내부 전송만 확장한다. 공개 저장/실행 schema·engine version·production dependency는 바꾸지 않는다.
