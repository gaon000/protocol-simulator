# P2 결정적 실행 엔진

상태: Accepted
기준일: 2026-10-30
구현 범위: 가상 시간·큐·규칙·타이머·결과 판정·격리된 실행과 손실 없는 환경. 화면 연결은 P3, 실제 장애·합쳐 읽기 환경은 P4다.

## 진입점과 의존 방향

[create-simulation.ts](../../src/application/create-simulation.ts)의 `createSimulation(input, options)`가 P1 실험을 검증하고 불변 snapshot을 만든다. 환경 factory에 snapshot 환경과 새로운 seed PRNG를 주입하고 [SimulationEngine](../../src/engine/simulation.ts)을 생성한다. 실패 시 ValidationResult 진단을 반환한다. UI·저장·실제 네트워크는 참조하지 않는다.

실행 버전은 `0.1.0-p2`다. P0의 정렬·난수 계약은 유지하며 새 엔진 동작의 버전을 snapshot에 기록한다. `options.limits`는 기본 상한 이하의 양의 정수만 허용하고 snapshot에 포함한다. runId는 메타데이터이며 의미적 trace와 자원 판정의 재현성에 영향을 주지 않는다.

| API | 동작 |
| --- | --- |
| `view()` | 상태·가상 시각·처리 개수, 참여자 상태·변수·타이머·결과, trace·진단·기대 조건과 snapshot의 읽기 전용 사본 |
| `step()` | 실제로 관찰되는 큐 이벤트 하나 처리. 무효화된 타이머 항목은 건너뜀 |
| `runBatch(n)` | 유한 개수의 큐 처리를 수행한 후 paused로 반환. 이후 같은 인스턴스로 재개 |
| `run()` | 관찰 종료 또는 유한 상한까지 실행 |
| `pause()` / `cancel()` | 큐를 유지한 정지 / 큐·타이머·수신 버퍼를 해제한 취소 |
| `result()` | terminal 이후에만 schemaVersion·snapshot·trace·진단·기대 조건 결과 반환 |

`createRunSession()`은 현재 실행을 보관한다. 유효한 새 실행이 만들어져야 이전 실행을 취소하고 교체한다. 잘못된 새 초안은 기존 실행을 파괴하지 않는다. `apply(runId, callback)`은 현재 runId가 일치할 때만 실행하고 reset 또는 교체된 실행의 callback은 무시한다. 직접 보관한 이전 엔진도 취소 이후에는 재개할 수 없다.

## 실행과 원자성

[EventQueue](../../src/engine/event-queue.ts)는 `(timeMs, priority, sequence)`의 binary min-heap이다. 같은 시각의 입력·전달·연결을 생성 순번대로 처리한 후 timer를 처리한다. 시각 합계가 안전한 정수 범위를 벗어나면 정상 시각으로 간주하지 않는다.

각 참여자는 별도 변수·수신 코덱·타이머·전송 순번·상위 전달 목록을 소유한다. 규칙의 조건은 실행 시 평가하며 실제로 둘 이상 일치하면 해당 참여자를 오류로 정지한다. 변수·필드 누락, 정수 overflow, 동적 필드 범위, 타이머 duration도 실행 시 확인한다.

동작은 임시 변수·타이머 사본으로 먼저 평가한다. 뒤 동작의 값 오류 때문에 앞선 assign이나 send가 부분 적용되지 않게 한다. 모든 동적 검사가 끝나야 상태·변수·타이머를 반영하고 send/deliver 등의 효과를 수행한다. 효과 적용 중에는 다른 큐 이벤트가 끼어들지 않는다. 자원 한도나 adapter 내부 오류로 종료하면 일부 trace가 남을 수 있지만 결과는 성공으로 판정하지 않는다.

타이머는 `(participant, name, generation)`으로 식별한다. 취소·재시작·참여자 종료는 generation을 무효화한다. 큐에 남은 이전 만료는 trace나 프로토콜 전이를 만들지 않는다. terminal 상태에 진입하면 finish가 없을 때 success를, 명시한 finish가 있으면 해당 success/failure를 기록한다. 이후 메시지는 명시적 ignore 규칙으로만 처리할 수 있다.

## 환경 포트

[EnvironmentFactory/Adapter](../../src/engine/environment-port.ts)는 `initialEvents`와 `transmit`의 Iterable로 전달·연결·환경 알림을 생성한다. 전송에는 방향·가상 시각·원본 전송 순번·원인 이벤트 ID·바이트 또는 논리 패킷이 들어간다. 환경은 메시지나 ACK의 의미를 해석하지 않는다. 엔진은 주입된 포트에만 의존하고 application이 구체적인 factory를 선택한다.

현재 기본 [ideal environment](../../src/environments/ideal-environment.ts)는 방향별 고정 지연과 stream의 청크 분할을 지원한다. datagram은 손실·중복 없이 한 묶음을 전달한다. jitter·손실·중복·특정 패킷 손실·연결 종료/실패 설정을 넣으면 명시적으로 environment-not-supported를 반환한다. 아직 구현하지 않은 설정을 조용히 무시하지 않는다.

다른 factory를 주입하면 seed·전달·연결 포트를 엔진 테스트에 사용할 수 있다. 테스트 adapter는 P4의 사용자용 장애 환경 구현 완료를 의미하지 않는다. 여러 write의 합치기와 확률·연결 장애의 실제 구현은 P4에서 이 포트로 연결한다.

## 기록·오류·판정

기록은 input → send → receive → parsed → transition/deliver처럼 구분한다. trace의 causeEventId와 ruleId로 원인과 규칙을 연결하며 전이에는 상태·변수의 전후 값과 outcome을 남긴다. ACK나 하위 수신을 상위 전달 완료로 취급하지 않는다.

프로토콜의 규칙·값·파싱 오류는 해당 참여자를 outcome error로 정지하고 다른 참여자의 관찰은 계속한다. 해당 참여자의 기대 조건은 미판정이다. adapter의 예기치 않은 내부 예외는 실행 전체를 engine-error로 종료한다. 초기 정의 오류는 실행 생성 전에 반환한다.

실행 상태는 idle/running/paused, terminal은 completed/cancelled/limit-reached/engine-error다. RunResult 타입의 invalid는 생성 전 실패를 다룰 향후 import/UI 경계를 위한 값이며 잘못된 정의로 실제 엔진을 시작하지 않는다. completed는 관찰 완료를 뜻하며 모든 기대 조건의 통과를 뜻하지 않는다.

관찰은 scenario.observationMs까지 유지한다. 큐가 비거나 다음 이벤트가 기간 밖이면 그 시각까지 추가 이벤트가 없음을 판정하고 종료한다. 상태 도달만으로 조기 성공 처리하지 않는다. state, delivery-count, delivered-values와 completion-before 조건을 전체 관찰 기준으로 평가하며 메시지 기대 값도 기본값을 채운 뒤 비교한다. 예상한 timeout으로 Failed에 도달한 시나리오는 해당 기대 조건을 통과할 수 있다.

수동 취소·상한 초과·엔진 내부 오류는 모든 기대 조건을 미판정으로 남긴다. 기본 상한은 큐 항목·처리 개수·trace 이벤트 각각 10,000, 메시지·수신 버퍼 각각 1 MiB, 의미적 trace bytes 16 MiB다. trace bytes 계산은 runId를 제외한다. 임시 rule 효과의 개수와 바이트도 같은 상한으로 제한한다. P7에서 응답성 측정 후 조정할 수 있으며 실제 설정은 snapshot에 보존한다.

## 검증

- [큐·표현식 단위 검사](../../tests/unit/event-queue.test.ts): heap/reference 정렬 비교, 안전한 정수·JSON 동등성·short-circuit.
- [엔진 통합 검사](../../tests/integration/simulation.test.ts): 세 코덱의 실제 Ping/Pong, 전체/단계/묶음 trace 동등성, 정확한 deadline, 취소/재시작 timer generation, 복잡한 동시 조건, 동적 오류 rollback, 관찰·상한·zero-delay 반복, session fencing, snapshot/뷰 격리와 주입된 seed 재현.

P2 완료 당시 화면은 P0 골격이었다. P2 코어 검증은 DOM 없이 실행했으며 이후 실제 화면의 재생·편집 연결은 [P3](p3-workspace.md)에서 별도 브라우저 검증했다. 전체 로컬 검사 결과와 master 병합은 [실행 계획](../exec-plans/active/20261030-1641-layered-protocol-v1.md)을 따른다.
