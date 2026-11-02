# 상태도와 통신 시퀀스 연동

상태: Completed
작성일: 2026-11-02
종료일: 2026-11-02

이 문서는 [ExecPlan 운영 규칙](../index.md)을 따른다.

## Purpose / Big Picture

시퀀스 이벤트 선택에서 해당 참여자의 실행 규칙·관찰된 전후 상태를 확인하고, 상태도 규칙/상태에서 관련 실행 회차와 시퀀스로 이동한다. 실행 snapshot과 관찰 prefix를 기준으로 연결하며 엔진·저장 schema·production dependency를 변경하지 않는다.

## Progress

- [x] 현재 선택·history projection·상태도/시퀀스 페이지와 실행 trace 확인.
- [x] DOM 없는 인과 연결·규칙/상태별 회차 모델 구현.
- [x] 양방향 강조·선택 회차·패널 이동·일시정지와 페이지/초점 연결.
- [x] 코어·Chromium/Firefox·390px·대형 fixture 응답성과 문서 검증.
- [x] 완료 문서·커밋 준비. 실제 Git/CI 상태는 최종 전달에서 별도로 확인.

## Surprises & Discoveries

`projectRecord`는 events 전체를 보존하므로 연결 모델도 eventCount prefix를 명시적으로 적용해야 한다. 하나의 receive가 여러 parsed/transition으로 이어질 수 있고, 동일한 규칙도 재전송/반복으로 여러 번 실행된다. trace의 transition은 동작 뒤에 기록되므로 관찰된 ruleId만으로 전후 상태의 commit을 추정하면 안 된다.

- 초기화/재실행 브라우저 검사에서 두 sibling 패널의 동일한 React key 때문에 상태도 DOM이 중복되는 기존 문제를 발견했다. key에 패널 종류를 포함했다. 같은 실행의 history 전환은 패널 열림을 유지하고 내부 그림/context와 선택을 구분한다.
- 선택된 transition이 시퀀스 페이지의 마지막 한 행일 수 있다. 상태도→시퀀스 이동은 관련 기록 필터를 켜서 직접 trigger·동작·수신과 함께 확인하게 했고, 전체 보기 전환 시 선택 위치를 유지한다.
- 병렬 기능 검사 중 Firefox의 완료 대기 5초를 넘긴 한 사례는 실패 snapshot에서 completed로 확인했다. 이 신규 helper의 기능 대기는 10초로 두며, 별도 1-worker의 실제 실행/선택/연동 시간 상한은 유지한다.

## Decision Log

| 날짜 | 결정 | 이유 |
| --- | --- | --- |
| 2026-11-02 | 같은 참여자·규칙·직접 trigger로 실행 회차를 식별 | 반복 규칙과 A/B, 다른 receive/타이머 회차 혼동 방지 |
| 2026-11-02 | 청크는 실제 parsed와 그 transition만 연결, 환경 장애는 원인 송신의 회차에 연결 | 반대 참여자의 상태나 아직 해석되지 않은 바이트에서 전이를 만들지 않음 |
| 2026-11-02 | 관찰 prefix 안의 회차를 20개씩 선택, 시퀀스는 30행 상한 유지 | 미래 관찰 누출과 대형 기록 DOM 증가 방지 |
| 2026-11-02 | 그림 선택은 실행을 일시정지하고 기록을 읽기만 함 | 검사 중 자동 진행/재실행·snapshot 변경 방지 |
| 2026-11-02 | 명시적 패널 이동 버튼으로 펼치기·초점 이동 | 선택마다 화면이 튀는 현상 방지, 키보드/390px 동선 제공 |

## Outcomes & Retrospective

실행 이벤트→해당 참여자·규칙·관찰된 전후 상태/변수, 상태도 규칙/상태→관련 시퀀스·실행 회차를 구현했다. 초안 상태도는 기존 편집 보기를 유지하고 연동은 실행 snapshot 그림을 대상으로 한다. 현재 cursor 상태와 선택한 회차의 전후 상태를 구분한다. 실행되지 않은 규칙은 가능한 정의로만 보여주며 연결된 실행 없음으로 안내한다.

## Context and Orientation

[제품 명세](../../product-specs/protocol-simulator-v1.md)·[구조](../../../ARCHITECTURE.md)·[개발 기준](../../development.md)을 따른다. `src/application/diagram-links.ts`는 prefix 인과 인덱스·선택 모델을 소유하고 App이 이벤트 선택과 그림의 규칙/상태 선택을 공유한다. `StateDiagram`, `ProtocolStateDiagrams`, `SequenceDiagram`은 같은 모델을 읽으며 현재 raw 이벤트/상세·history 경계를 보존한다.

## Plan of Work

1. 실제 trigger·rule 동작·transition·receive/parsed·environment를 연결하고 참가자별 규칙/상태 회차를 조회한다. 바이트·큰 JSON 복사는 하지 않는다.
2. 상태도 선택 규칙·전후 상태와 시퀀스 관련 행을 표시한다. 동일 규칙의 회차와 다중 해석은 목록에서 명시적으로 고른다.
3. 외부 선택에 따라 참여자·규칙/상태 페이지·시퀀스 페이지를 맞추고 상대 패널 이동을 제공한다. history 선택은 기존 cursor 의미를 유지한다.
4. 실제 catalog/재전송/무시·분할/합침·환경 손실·prefix·실행/기록 전환·초안 변경, 키보드/좁은 화면·10k/1 MiB를 검증한다.

## Validation and Acceptance

source 변경 뒤 관련 Node 테스트와 strict 타입 검사를 실행한다. 최종 `pnpm check`로 lint·포맷·코어·문서·Chromium/Firefox·기존 응답성 상한을 확인한다. 연동 UI의 실제 화면 캡처를 열어 검토하고 staging 포함 공백 검사와 실제 Git/CI 결과를 구분해 보고한다.

## Idempotence and Recovery

선택은 읽기 전용이다. 실행/기록·prefix가 바뀌면 오래된 그림 선택은 무효화하고, 실제 관찰이 없는 연결은 강조하지 않는다. 기존 raw 기록·상세·snapshot 복원 경로를 보존한다.

## Artifacts and Notes

macOS·Node 24.18.0·pnpm 9.15.0에서 lint·포맷·strict 타입 검사, 코어 240개, 문서 30개, Chromium 156.0.8078.4/Firefox 157.0의 브라우저 검사 120개를 통과했다. 기존 그림·폼·저장/복원·history 검사도 포함한다. 연동 화면과 390px TCP snapshot 캡처를 열어 전후 상태/현재 상태와 관련 기록 표시를 확인했다.

최초 전체 검사에서는 10k 입력 p95 306.5ms가 기존 200ms 상한을 초과했다. trace에서 클릭 재시도/가로막힘과 브라우저 long task는 관찰되지 않았다. 원인을 확정하지 않았으며 같은 1-worker·60회 조작·수치 기준으로 재검사해 통과했다. 성능 수치 상한은 유지했다. 최종 묶음 `pnpm check` 전체도 통과했으며 아래는 그 수치다.

| 실제 fixture | 실행 | 입력 p95 | 상태도→시퀀스 | 상세 | 저장 | cursor 왕복 | frame p95 | 최대 long task |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10,000 이벤트 | 3803ms | 186.1ms | 106.2ms | 67.0ms | 80.7ms | 155.6ms | 16.8ms | 53ms |
| 정확히 1 MiB wire | 378ms | 51.3ms | 53.9ms | 68.0ms | 318.9ms | 76.9ms | 16.8ms | 135ms |

회차 20개·시퀀스 30행 상한과 실제 전체 trace/wire의 IndexedDB 보존을 검사했다. staging 포함 공백 검사 후 Git 전달을 준비하며 원격 master/CI 상태는 최종 응답에서 별도로 보고한다. 실제 네트워크·배포·모든 기기의 성능은 검증 범위 밖이다.

## Interfaces and Dependencies

순수 TypeScript 인과 인덱스와 React 상태/콜백·기존 SVG를 사용한다. 신규 production dependency와 네트워크 입출력이 없다.
