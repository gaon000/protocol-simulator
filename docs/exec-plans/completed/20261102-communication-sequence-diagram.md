# 통신 시퀀스 다이어그램과 메시지 상세

상태: Completed
작성일: 2026-11-02
종료일: 2026-11-02

이 문서는 [ExecPlan 운영 규칙](../index.md)을 따른다.

## Purpose / Big Picture

실제 가상 실행 기록을 A/B lifeline과 시간순 화살표로 읽고, 손실·중복·재전송의 관찰 근거·타이머 만료/실패를 확인한다. 선택한 기록의 메시지 필드·바이트·원인/직접 후속 이벤트를 조회한다. 사용자가 요청한 다음 작업 2번이며, 상태도와의 전체 선택 연동/직접 편집과 실제 네트워크는 포함하지 않는다.

## Progress

- [x] 실행·환경 기록, snapshot/history cursor와 기존 상세 UI·검증 계약 확인.
- [x] prefix만 읽는 순수 시퀀스 모델·인과관계·장애/반복 송신 분류.
- [x] 유한 페이지·A/B 화살표·키보드 선택·필드/바이트/원인 상세 연결.
- [x] Node·Chromium/Firefox·기존 응답성·화면 검증과 문서 갱신.
- [x] 완료 문서와 Git 전달 준비. 실제 master/CI 상태는 최종 전달 시 확인.

## Surprises & Discoveries

- 환경의 deliveries는 도착 예정이며 실제 receive가 아니다. send만 있는 경우 수신 미관찰로 표시하고 원격 도착을 그리지 않는다.
- 스트림은 분할/합쳐 읽기 때문에 한 receive가 여러 sourceEventIds를 참조한다. 이를 하나의 완성 메시지로 오해하지 않게 바이트 수신과 parsed/deliver를 분리한다.
- 범용 trace에는 재전송 의도 필드가 없다. 타이머 만료를 원인으로 동일 participant/message ID/값을 반복 송신한 경우만 ‘재전송 후보’라고 표시한다. 만료가 실패 전이로 이어진 관찰이 있어야 ‘타임아웃 실패’를 표시한다.
- 실제 캡처에서 선택 행의 스크롤 좌표가 다른 offset parent 기준으로 계산되는 문제를 발견했다. canvas와 행의 viewport 좌표 차이로 고치고 선택 재전송 행의 가시 범위를 브라우저에서 검사한다.
- 최초 응답성 실행의 10k fixture는 숫자 상한 측정 전에 테스트의 ‘마지막 페이지도 30행’ 가정에서 실패했다. 통신 필터의 마지막 페이지는 7행이므로 처음 페이지로 이동한 뒤 30행을 검사하도록 수정했다. 성능 임곗값은 변경하지 않았다.

## Decision Log

| 날짜 | 결정 | 이유 |
| --- | --- | --- |
| 2026-11-02 | 추가 dependency 없이 native button·SVG 행·기존 snapshot 기록 사용 | 접근성과 결정적 순서, 기존 승인/저장 계약 유지 |
| 2026-11-02 | 실제 receive 행에 도착 화살표, send 행은 중앙까지의 송신 화살표 | 도착 예정/손실·분할을 실제 수신과 혼동하지 않도록 함 |
| 2026-11-02 | 한 페이지 30행, 관계 20개·필드 32개 단위 제한 | 10k 기록·1 MiB 값의 DOM/직렬화 비용 제한 |
| 2026-11-02 | 행 간격 고정·가상 시각/sequence 표시, history prefix 밖 숨김 | 같은 시각의 여러 이벤트와 미래 참조를 정확하게 구분 |

## Outcomes & Retrospective

실제 trace prefix의 A/B 송신·하위 수신·손실/차단·중복·타이머/재전송 후보, snapshot 필드·바이트·원인/직접 후속을 구현했다. 엔진 의미·schemaVersion·저장 포맷·production dependency는 변경하지 않았다. 기존 상태도와 raw 이벤트 목록/상세를 유지한다. 표시가 잘린 관계는 페이지로, 전체 값·기록은 bundle로 확인한다.

## Context and Orientation

[구조](../../../ARCHITECTURE.md)·[개발 기준](../../development.md)·[제품 명세](../../product-specs/protocol-simulator-v1.md)를 따른다. `src/application/sequence-diagram.ts`가 DOM 없는 요약/인과 모델, `src/ui/SequenceDiagram.tsx`가 읽기 전용 보기를 소유한다. App의 displayed snapshot·diagramEventCount·selected와 동일한 기록을 사용한다. `RunView.tsx`의 EventInspector/WireInspector를 상세에 재사용한다.

## Plan of Work

1. 실제 trace prefix를 1회 읽어 원인/수신·직접 후속과 반복 송신·타이머 실패 근거를 정리한다. JSON 전체 직렬화나 바이트 복사를 피한다.
2. 송신/실제 수신 화살표와 participant 내부 이벤트를 구분해 그린다. 필터·페이지·현재 끝·선택 상세 이동을 제공한다.
3. 실제 message/parsed 또는 명시적인 원인 송신 필드와 byte preview·원인/직접 후속 페이지를 표시한다. UI에서 원본 기록을 변경하지 않는다.
4. catalog·장애·분할/합침·역전·미수신·history prefix·불완전 관찰과 큰 데이터, 포인터/키보드·390px·snapshot 보존을 검증한다.

## Validation and Acceptance

`pnpm check`와 staging 포함 `git diff --check`를 실행한다. 실제 수집/통과 수와 실패 보완을 기록한다. 기존 10k/1 MiB 응답성 fixture는 시퀀스 그림을 연 상태로 검사하고 기존 수치 상한을 유지한다. HTTP/TCP·ACK 손실/중복 화면과 좁은 화면 캡처를 열어 확인한다. 로컬·CI·배포/실제 기기는 별도 증거다.

## Idempotence and Recovery

표시 전용 모델이며 저장/실행 계약을 바꾸지 않는다. snapshot과 cursor prefix만 사용하고 필터나 페이지가 데이터/판정을 수정하지 않는다. 큰 값과 관계는 부분 표시·전체 bundle 보존을 명시한다. 기존 raw 기록/정의 진단을 복구 경로로 유지한다.

## Artifacts and Notes

macOS·Node 24.18.0·pnpm 9.15.0에서 lint·포맷·strict 타입 검사, Node 231개, 문서 29개, Chromium 156.0.8078.4/Firefox 157.0 E2E 104개를 통과했다. 별도 Chromium 응답성 2개도 통과했다. HTTP·ACK 손실·390px TCP 캡처를 실제 열어 검토했으며 선택 행의 스크롤 수정을 재검증했다.

| 실제 fixture | 실행 | 입력 p95 | 시퀀스 상세 | 저장 | cursor 왕복 | frame p95 | 최대 long task |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10,000 이벤트 | 3456ms | 55.7ms | 47.4ms | 66.1ms | 112.7ms | 16.7ms | 관찰 없음 |
| 정확히 1 MiB wire | 362ms | 35.2ms | 39.1ms | 298.9ms | 62.7ms | 16.8ms | 131ms |

시퀀스 상세 DOM은 각각 183/11,305자였다. 원본 trace 10k·wire 1,048,576 bytes의 IndexedDB 저장도 확인했다. 기존 숫자 상한을 유지한다. 최초 전체 검사에서 마지막 페이지 행 수 가정으로 실패한 검사를 수정한 뒤 응답성 2개를 재실행했다. 최종 `pnpm check` 전체와 staging을 포함한 `git diff --cached --check`를 통과했다. 로컬 결과이며 원격 master/CI 상태는 최종 전달에서 별도로 보고한다. 실제 네트워크·배포·모든 기기의 성능은 검증 범위가 아니다.

## Interfaces and Dependencies

새 순수 TS 모델과 React/SVG 보기만 추가한다. EventInspector는 기본값을 유지하는 상세 영역 label 옵션과 원인 목록 제한을 지원한다. 신규 production dependency가 없다.
