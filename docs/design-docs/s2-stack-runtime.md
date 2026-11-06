# S2 공유 규칙 런타임·스택 실행 계약

상태: Accepted
기준일: 2026-11-06
구현 범위: DOM 없는 스택 실행 코어. [S1 모델/바이트](s1-stack-models.md)와 [전체 설계](layered-stack-v2.md)를 사용한다. 실제 provider/응용 예제는 [S3](s3-reliable-stream-lite.md)에서 구현했고 저장·관찰 도구/UI는 [S4/S5 계획](../exec-plans/active/20261106-layered-protocol-stacks.md)에 남아 있다.

## 모듈과 진입점

| 실제 모듈 | 책임 |
| --- | --- |
| [create-stack-simulation.ts](../../src/application/create-stack-simulation.ts) | unknown 실험→S1 검사/소유 snapshot→실행 생성. 정확한 snapshot 재실행·세대별 session |
| [stack-scheduler.ts](../../src/engine/stack-scheduler.ts) | 한 clock/queue·전역 순번/예산·준비/반영·전체 관찰 종료·오류/기대 조건 |
| [protocol-runtime.ts](../../src/engine/protocol-runtime.ts) | endpoint별 상태/변수/타이머·codec fork·규칙 준비·독립 finish·byte 값의 관찰된 기여 범위 |
| [service-router.ts](../../src/engine/service-router.ts) | 검증된 로컬 하위/상위 binding과 물리 peer 주소만 확인 |
| [stack-codec.ts](../../src/engine/stack-codec.ts), [stack-data.ts](../../src/engine/stack-data.ts) | 기존 scalar byte 코덱의 격리 조합·native logical packet, 실제 bytes/field/source ranges·record artifacts |
| [rule-evaluation.ts](../../src/engine/rule-evaluation.ts), [datagram-policy.ts](../../src/domain/datagram-policy.ts) | v1/스택이 공유하는 선언 순서 후보 검사와 targeted drop/4-draw 전달 결정 |
| [stack-runtime-model.ts](../../src/domain/stack-runtime-model.ts) | StackView/상태·endpoint view·기대 판정과 byte origin 타입 |

`createStackSimulation(input, { runId?, datagramPlanner? })`과 `createStackSimulationFromSnapshot`은 ValidationResult를 반환한다. snapshot은 `schemaVersion: 2`, mode stack, engine stack-1, mulberry32-v1이며 모든 정의/adapter·연결·시나리오·실제 limits를 보존한다. 잘못된 새 입력은 session의 기존 실행을 취소하지 않는다. 초기 자원 확보 실패는 stack-init 진단이며 실행을 공개하지 않는다.

`datagramPlanner`는 코어 테스트/조합을 위한 동기 순수 함수 주입점이다. 기본은 공유한 planDatagram이며 사용자 JSON/화면에서 코드를 실행하는 기능이 아니다. 서버/소켓·비동기 외부 환경은 제공하지 않는다.

## 한 시계와 서비스 흐름

큐 키는 `(timeMs, 비타이머 우선, globalSequence)`다. 입력·로컬 요청/통지·물리 전달은 비타이머다. 같은 시각에 새로 예약된 로컬 전달도 만료보다 먼저 처리한다. 0ms 전달도 별도 큐 항목이며 다른 런타임을 재귀 호출하지 않는다. 정의 배열의 위치를 주소로 사용하지 않는다.

1. 사용자 input을 대상 앱의 메시지 스키마/defaults로 검사하고 규칙을 준비한다.
2. send의 실제 코덱 출력에 대해 send→service-request→service-accepted를 기록한다. 수락은 후속 큐·포트 용량을 예약했다는 뜻이다.
3. 로컬 provider는 별도 operation에서 service-received를 기록하고 제공 포트의 service-request 규칙을 실행한다.
4. 최하위 send만 링크 장애/난수를 소비한다. 환경 결정은 environment trace, 실제 도착은 receive다. 원본/복제 도착과 실제 전송 번호를 보존한다.
5. provider의 read/receive/failed/closed 효과는 service-indication이며 consumer의 service-received는 다음 operation이다. 데이터는 consumer의 점진적 코덱을 통해 parsed→receive 규칙→transition으로 이어진다.

stream은 write/read 경계를 메시지 경계로 간주하지 않는다. 한 read가 여러 메시지를 해석하면 그 operation 안에서 선언 순서로 처리하고 각 parsed에 실제 기여한 수신 범위를 담는다. datagram은 하나씩 해석하며 나뉜 잘못된 두 datagram을 합치지 않는다. packet-schema 서비스는 논리 필드로 다루며 JSON을 임의 wire bytes로 표시하지 않는다.

native 정의가 해당 data service-indication 이벤트를 명시적으로 선언했다면 raw payload 규칙을 먼저 처리한 뒤 같은 operation에서 코덱을 처리한다. 이 hook은 codec 소비를 대신하지 않는다. 선언한 hook에는 각 도달 상태의 규칙 또는 명시적 ignore가 필요하다. 선언이 없는 앱에는 추가 raw 규칙을 요구하지 않는다. failed/closed는 native의 명시적 service-indication 이벤트를 우선 사용하고, 그렇지 않으면 기존 connection 이벤트로 처리한다. legacy 앱은 원래 connection 규약을 유지한다.

## 준비·원자성·실패

실행은 각 operation에서 대상 runtime/codec/수신 source 목록을 fork한다. 규칙의 조건·순차 대입·메시지 값·코덱 출력·타이머 기한·포트 상태를 임시 값으로 계산한다. 실제 큐를 바꾸기 전에 후속 작업 수, 포트/codec/provider의 논리 버퍼, 고유 payload, trace와 실제 base64 artifacts의 직렬화 합계를 예약한다.

모든 예약이 통과하면 trace batch를 보존하고 상태/버퍼/타이머/효과/전송 번호·큐를 반영한다. 용량 실패는 operation 전체를 되돌린 limit-reached다. 수락만 기록되거나 transition 없이 상태가 바뀌는 부분 결과를 만들지 않는다. 이전 operation의 관찰/자료는 보존한다. 임시 handle도 rollback 때 폐기하므로 재사용된 payload ID가 임시 참조를 다시 유효하게 만들지 않는다.

프로토콜 오류는 실패한 규칙의 대입/송신/타이머를 반영하지 않는다. 한 read에서 앞서 성공한 다른 메시지의 규칙과 실제 원시 수신은 유지한 채 해당 endpoint를 error로 기록한다. 선언한 상위 failed 통지가 있으면 큐로 전달한다. 그 endpoint와 선언된 로컬 상위 consumer의 기대 조건은 tainted/undetermined이며 관련 없는 endpoint까지 실패로 추정하지 않는다.

사용자 규칙이 명시적으로 알린 failed와 outcome failure는 모델링한 정상 결과다. 실제 Failed 상태를 기대했다면 pass가 가능하다. 정상 closed는 불완전한 프레임의 EOF 오류를 검사한다. failed는 이전 수신 접두부를 보존하고 파서를 중단하며 불완전 프레임을 정상 메시지로 만들지 않는다.

예상하지 못한 코어/주입 planner 예외는 engine-error로 구분하고 마지막 commit을 보존한다. 미지원 버전/구성은 생성 전에 거부한다. cancelled/limit-reached/engine-error와 관찰 기간이 끝나지 않은 실행의 기대 조건은 모두 undetermined다.

## 바이트와 인과관계

런타임 입력/코덱 버퍼의 mutable Uint8Array는 fork와 store 소유권 안에 둔다. trace는 큰 bytes 값 대신 record-local range를 사용하고 실제 송신·수신 값을 artifacts에 보존한다. 같은 canonical bytes는 실행 안에서 블록을 공유할 수 있지만 원인 선택은 payload ID나 내용 일치로 하지 않는다.

native bytes 변수·field/service-payload·slice/concat은 실제 관찰 source와 offset/length를 전달한다. bytes 변수의 성공한 새 대입은 해당 transition에 연결하고, 후속 slice/concat/상위 통지는 그 commit과 실제 기여 범위를 참조한다. codec의 frame byte 수로 수신 fragment를 소비하므로 UTF-8/프레임 분할과 합쳐 읽기에 여러 sourceEventIds가 남는다. authored literal에는 존재하지 않는 수신 원인을 만들지 않는다. provenance 개수도 전역 trace 예산 안에 둔다.

물리 블록 합계와 owner별 논리 길이는 별도다. 논리 packet의 포트 대기는 base64를 포함한 JSON 크기를 센다. 변수에 보관한 문자열은 UTF-8 길이, JSON 객체/배열은 직렬화 길이로 논리 버퍼 예산에 포함해 payload를 JSON 변수에 넣어 한도를 우회하지 못하게 한다. 이를 bytes 타입이나 wire encoding으로 재해석하지는 않는다. setOwner의 선택 logicalBytes는 모든 range 길이 이상이어야 한다. trace 예약은 이미 검사한 prefix를 다시 계산하지 않고 새 이벤트/블록·쉼표의 실제 크기를 더하며, 외부 record reader는 여전히 전체 참조/순서/크기를 검사한다.

clearLive/취소/reset/완료는 pending/codec/provider의 live 소유권을 해제한다. 이미 보존한 trace/artifacts는 유지하며 새로운 실행이나 session reset의 영향을 받지 않는다. 이 자료를 IndexedDB나 v1 bundle로 저장하는 연결은 아직 없다.

## 시간·상태·수명 API

| API/필드 | 의미 |
| --- | --- |
| run / runBatch(budget, stopAfter?) / step | 전체 실행 / 유한 operation 수 / operation 하나. 여러 해석/전이가 있어도 처리 중간에 멈추지 않음 |
| pause | clock/queue/PRNG 위치를 보존하고 일시 정지 |
| cancel | cancelled로 끝내고 live 소유권 해제. 이후 진행은 inert |
| terminal / result | 캡처 비용 없는 종료 여부 / 종료 상태에서만 불변 StackView |
| view | endpoint-keyed 상태/변수/타이머/포트·trace/artifacts·예산·진단·기대 조건·고정 snapshot |
| createStackRunSession | current/start/startSnapshot/reset/apply(runId, callback). 이전/종료 run의 callback을 차단 |

timer identity는 `(participant, instanceId, timerId, generation)`다. 취소/재시작/해당 instance의 finish는 옛 만료를 무효화한다. stale 큐 항목도 유한 처리 예산 안에 있고 관찰 이벤트 없이 소비할 수 있다. 한 instance의 finish는 다른 instance나 전체 관찰 기간을 끝내지 않는다. 큐가 비거나 앱이 끝나도 정상 결과의 timeMs는 observationMs다.

stopAfter는 commit 이후 새 이벤트를 보고 정지한다. 예외가 나면 caller에 전달하고 실행은 paused로 보존해 계속할 수 있다. 실행 함수의 재진입은 거부한다. observer 유무와 run/step/batch의 최종 trace·상태·판정은 같은 snapshot/seed/run ID에서 동일하다.

## v1 보존과 검증 경계

기존 SimulationEngine은 공통 후보 검사만 사용하며 큐/반영/trace 의미를 바꾸지 않았다. 기존 JSON Lines/HTTP push 결과 형식은 유지하고 fork/bufferedBytes/pushTracked만 추가했다. 기존 datagram 환경은 같은 순수 장애 결정 함수를 사용한다. legacy JSON의 byte-like tag도 스택의 bytes로 재해석하지 않는다.

변경 전 아홉 catalog 실행의 view/snapshot/trace/기대 판정을 보관해 변경 후 전체 값과 대조했다. 기존 코어 및 브라우저/응답성 검사는 회귀 증거다. 신규 코어 fixture의 단순 forward/split/merge는 신뢰성 있는 provider가 아니며 재전송·순서/중복 제거를 보장하지 않는다. 실제 검증 결과와 원격 반영은 실행 계획에 기록한다.
