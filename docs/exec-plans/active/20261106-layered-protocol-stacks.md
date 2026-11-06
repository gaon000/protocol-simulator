# 계층 연결 프로토콜 스택 단계별 구현 계획

상태: In Progress
종료일: 미종료
기준일: 2026-11-06
구현 상태: S1/S2를 master에 반영했고 S3 ReliableStreamLite·실제 계층 연결 예제와 전체 로컬 검증을 완료했다. S4/S5는 미착수다.

[ExecPlan 운영 규칙](../index.md)을 따른다. 기능의 계약은 [계층 연결 설계](../../design-docs/layered-stack-v2.md), S1의 실제 JSON/API는 [모델·검사 계약](../../design-docs/s1-stack-models.md)이 소유한다. 전체 스택 실행·저장·화면 완료와 S1 완료를 구분한다.

## Purpose / Big Picture

A/B 각각의 응용·전송 인스턴스를 서비스 포트로 연결하고, 최하위 데이터그램 환경의 장애가 상위 메시지 처리에 어떤 영향을 주는지 한 실행에서 관찰한다. 대표 완료 사례는 ACK 하나가 손실돼 DATA가 재전송되지만 상대 앱에는 같은 데이터가 한 번만 전달되는 것이다.

첫 범위는 총 네 인스턴스·선형 두 계층·링크 하나·이미 준비된 양방향 사용자 정의 스트림이다. Ping/Pong 다음 제한된 HTTP/1.1 예제를 연결한다. 전체 TCP·실제 네트워크·다중 연결/세 계층 이상·라우팅/임의 그래프·윈도/혼잡 제어·half-close/재연결 협상은 제외한다.

## Progress

- [x] 2026-11-06: clean master `76194c8`에서 현재 모델·엔진·환경·저장·관찰 도구와 작업 규칙 확인. `codex/layered-stack-design`에서 문서화.
- [x] 2026-11-06: 합의한 서비스 포트/단일 scheduler/호환성 설계와 S1~S5의 범위·선행 조건·완료 기준 작성.
- [x] 2026-11-06: 설계 commit `a5925a8`을 master로 fast-forward하고 origin/master에 push 완료. `codex/s1-stack-models-validation`에서 S1 구현.
- [x] 2026-11-06 S1 — 스택/포트/바이트 모델·검사·불변 자료 계약. 별도 v2 domain 모듈·59개 신규 Node 검사와 S2 진입 API 문서.
- [x] 2026-11-06: S1 commit `1df48c7` master 병합·푸시와 [정확한 HEAD CI](https://github.com/gaon000/protocol-simulator/actions/runs/42146718353) 통과. `codex/s2-stack-runtime`에서 S2 구현 착수.
- [x] 2026-11-06 S2 — 공유 후보 검사/환경 결정·네 runtime·단일 scheduler/router·forkable codec·예약/commit·세대별 수명. 신규 35개 Node 검사와 S2 계약 문서.
- [x] 2026-11-06: S2 최종 commit `88ba047` master 반영과 [CI](https://github.com/gaon000/protocol-simulator/actions/runs/42154827680) 통과. `codex/s3-reliable-stream-lite`에서 S3 구현.
- [x] 2026-11-06 S3 — ReliableStreamLite와 실제 계층 연결·장애 검증. 신규 Node 27개·예제 5개와 전체 로컬 회귀 검사 통과.
- [ ] S4 — 저장 v2·legacy 호환·재생과 관찰/검증 도구 확장.
- [ ] S5 — 스택 구성 화면·응용 예제·전체/브라우저/응답성 검증.

각 S단계는 구현 요청 이후 시작하고 관련 source·계약 문서·의미 있는 검증을 같은 작업 단위로 완료한다. S1 이후에도 이 구현 계획은 active/In Progress로 유지한다.

## Surprises & Discoveries

- 현재 `ExperimentDefinition.protocols`와 `EngineView.participants`는 A/B 하나씩이다. 계층 이름 추가만으로 여러 독립 런타임·시나리오 타깃을 표현할 수 없다.
- 현재 필드/메시지 값은 scalar 중심이다. 상위 코덱의 실제 바이트를 전송 payload로 넘기려면 bytes 자료형·유한 연산·저장 표현이 필요하다.
- send는 환경으로 전송하고 deliver는 관찰 목록에 남긴다. deliver를 전역적으로 다시 해석하면 기존 기대 조건·예제·history가 달라지므로 별도의 서비스 효과가 필요하다.
- TCP 연결 예제는 ESTABLISHED에서 finish한다. 기존 Stop-and-wait는 문자열·단방향 예제다. 두 예제를 완성된 양방향 스트림 provider로 간주하지 않는다.
- 기존 엔진은 자원 한도로 전이 trace가 기록되기 전에 일부 view 상태가 바뀔 수 있다. 스택 모드의 예약/반영 정책을 별도 버전으로 검증하고 legacy trace 의미는 보존한다.
- 현재 저장소에는 v1 코어/브라우저/응답성 기준이 있다. 기존 완료 계획의 검사 수는 과거 증거이며 스택의 검증 실적이 아니다.
- S1 fixture에서 protocol.messages와 packet schema.messages가 같은 배열을 참조하면 structuredClone도 그 내부 alias를 유지한다. 스키마 불일치 검사는 별도 사본을 사용해 실제 JSON 입력과 같은 조건으로 검증한다.
- S1의 전체 trace 재검사를 매 append에 적용하면 10k 실행에서 이미 보존한 prefix를 계속 읽는다. S2는 신규 batch와 prefix ID/마지막 순서, 실제 직렬화 증분만 검사하고 외부 record reader의 전체 검사는 유지한다.
- 기존 코덱은 closure 상태를 소유한다. v1 push 결과를 바꾸지 않고 fork/bufferedBytes/pushTracked를 추가해 partial UTF-8/HTTP header·body를 격리하고 실제 frame 크기로 source 범위를 소비한다.
- ReliableStreamLite의 seq는 TCP 바이트 순번과 달리 DATA 조각마다 하나 증가한다. write 경계를 보존하지 않고 FIFO에 쌓인 여러 write를 한 조각으로 보낼 수 있다. pending 전체와 offset을 유지해 매 ACK마다 큰 남은 버퍼를 새 값으로 복사하지 않는다.
- 1바이트 DATA 예제는 왕복마다 가상 시간이 지나 기존 500ms 앱 기한 안에 HTTP 교환이 끝나지 않는다. 해당 새 예제 사본만 deadline 15000ms/observation 16000ms로 명시하고 기존 v1 HTTP 예제는 유지한다.

## Decision Log

- 2026-11-06: 노드·계층 역할·서비스 타입·메시지 패턴을 분리한다. stable endpoint와 정확한 정의 revision으로 모든 참조를 연결한다.
- 2026-11-06: 한 clock/queue에서 로컬 전달도 예약한다. 사용자 프로토콜 규칙 대신 router가 신뢰성을 보충하지 않는다.
- 2026-11-06: 첫 provider는 initially-ready ReliableStreamLite이며 별도 예제로 제공한다. HTTP는 이 provider의 서비스로 연결하고 전체 TCP 데이터 모델은 후속이다.
- 2026-11-06: v2 형식/엔진을 명시하고 legacy 자료와 실행 경로를 보존한다. DB 전환은 원자적 upgrade·원본 보관·구형 writer 차단·CAS와 복구를 포함한다.
- 2026-11-06: 기존 전역 10k/16 MiB 및 workspace 64 MiB 기준을 계층별 배수로 늘리지 않는다. 새 payload/버퍼 한도는 설계에 기록한 초기값으로 구현·실측한다.
- 2026-11-06 설계 단계: 문서만 작성했다. 이후 사용자 요청으로 S1 구현을 시작했다. 새 production dependency·실제 연결·배포는 포함하지 않는다.
- 2026-11-06 S1: 기존 v1 union/reader/코덱을 바꾸지 않고 별도 v2 domain 모듈을 추가했다. adapter는 source 전체를 보존하며 기존 전송 정의에 provides를 발명하지 않는다.
- 2026-11-06 S1: bytes 서비스는 원시 byte 수, 논리 packet/메시지는 base64를 포함한 JSON 크기로 메시지 예산을 검사한다. artifact 예산은 trace와 실제 직렬화 payload를 함께 센다. 0-byte 블록도 pending+trace 개수 한도로 제한한다.
- 2026-11-06 S2: v1은 공통 후보 검사·순수 datagram 결정을 공유하며 기존 큐/trace 의미를 유지한다. 변경 전 아홉 catalog의 전체 view를 보관해 변경 후 동등성을 대조했다.
- 2026-11-06 S2: runtime/codec·payload 소유권을 준비하고 한 operation의 자원 예약 뒤 반영한다. 규칙 오류는 실패한 규칙만 반영하지 않고, 같은 read에서 앞서 성공한 메시지와 원시 수신은 보존한다. 한도 실패는 전체 operation을 반영하지 않는다.
- 2026-11-06 S2: data service-indication은 코덱에 전달하며 native가 해당 raw 이벤트를 명시적으로 선언한 경우 먼저 같은 operation에서 처리한다. failed/closed는 명시적 native 서비스 이벤트 또는 connection 규약으로 처리한다.
- 2026-11-06 S2: 실제 source byte 범위는 변수/field/service-payload·slice/concat·프레임에서 전달한다. payload 내용 공유와 인과관계를 분리한다. 신뢰성은 test forward/split/merge나 router가 보충하지 않는다.
- 2026-11-06 S3: 두 provider의 tx/rx 방향·seq·cache·FIFO·timer를 독립 변수로 두고 사용자 규칙으로만 재전송/중복 억제를 구현했다. ACK는 DATA 방향/현재 seq를 대조하고 미래 DATA에는 ACK/read를 만들지 않는다.
- 2026-11-06 S3: seq 소진을 실패로 명시하고 번호를 재사용하지 않는다. 실패 때 live pending/queued/cache를 비우되 과거 read/deliver와 기록 자료는 보존한다. 빈 write는 명시적 ignore이며 큐 concat 한도는 limit-reached다.
- 2026-11-06 S3: 알려진 앱의 새 사본에 StreamFailed·terminal failed 무시, Ping 요청 deliver와 timeout 뒤 늦은 Pong 무시를 명시했다. 일반 조합 함수는 사용자 앱의 규칙을 자동 보충하지 않는다. optional origin/버전 있는 별도 catalog API를 추가했으며 v1 catalog/화면/DB는 변경하지 않았다.

## Outcomes & Retrospective

S1/S2 위에서 S3의 실제 양방향 ReliableStreamLite·JSON Lines/제한된 HTTP와 첫 ACK 손실 예제 5개를 구현했다. 신규 Node 27개와 전체 회귀 검사를 통과했다. App/workspace/DB는 변경하지 않았으며 저장/관찰/UI 통합은 S4/S5에 남아 있다.

## Context and Orientation

| 현재 경로 | 현재 책임·읽을 이유 |
| --- | --- |
| [프로토콜 모델](../../../src/domain/protocol-model.ts), [검사](../../../src/domain/model-validation.ts) | 단일 정의/참여자·scalar 값·시나리오/기대 조건·실행 자료 |
| [실행 계약](../../../src/domain/execution-contract.ts) | 버전·seed·순서·기초 한도 |
| [엔진](../../../src/engine/simulation.ts), [큐](../../../src/engine/event-queue.ts), [환경 포트](../../../src/engine/environment-port.ts) | 규칙 평가와 반영·타이머·수신/환경·가상 시계 |
| [실행 생성](../../../src/application/create-simulation.ts) | snapshot·환경 주입·session 수명 |
| [예제](../../../src/examples/catalog.ts), [HTTP](../../../src/examples/http.ts), [TCP](../../../src/examples/tcp-handshake.ts), [Stop-and-wait](../../../src/examples/stop-and-wait.ts) | 실제 지원 경계·원본/사본·호환 응용 후보 |
| [workspace 모델](../../../src/domain/workspace-model.ts), [검사](../../../src/domain/workspace-validation.ts), [저장](../../../src/persistence/indexed-db.ts) | strict 버전/참조/크기·staging·native transaction·CAS |
| [재생](../../../src/application/replay-record.ts), [설명](../../../src/application/execution-explanation.ts), [진단](../../../src/application/failure-diagnostics.ts) | frozen snapshot·prefix·원인과 저장 결과 대조 |
| [커버리지](../../../src/application/suite-coverage.ts), [비교](../../../src/application/run-comparison.ts), [중단점](../../../src/application/breakpoints.ts) | 현재 participant 타깃과 한도/버전 경계 |
| [작업 공간](../../../src/ui/App.tsx) | 편집·실행 세대·history cursor·공유 선택·모든 보기 연결 |

S1~S3의 실제 신규 경로는 [S1 계약](../../design-docs/s1-stack-models.md)·[S2 실행 계약](../../design-docs/s2-stack-runtime.md)·[S3 provider/예제](../../design-docs/s3-reliable-stream-lite.md)와 [구조 지도](../../../ARCHITECTURE.md)에 등록했다. S4/S5 경로는 아래의 구현 후보이며 아직 존재하는 모듈로 표현하지 않는다.

## Plan of Work

### S1 — 스택·포트·바이트 모델과 검사

선행 조건: 이 설계와 계획. 실행 엔진/사용자 화면을 아직 연결하지 않는다.

작업:

- 후보 `src/domain/stack-model.ts`, `stack-validation.ts`에 정의·instance·endpoint·binding·link·스택 실험/시나리오·snapshot 계약을 추가한다.
- requires/provides의 stream bytes, datagram bytes, datagram packet-schema를 구분하고 첫 범위의 인스턴스 수·선형 연결·단일 provider·양쪽 wire 호환성을 검사한다.
- bytes 필드/변수·서비스 payload 참조·길이/slice/concat의 정적 타입·동적 안전 정수/크기 검사와 tagged base64의 canonical 읽기/쓰기 계약을 구현한다.
- payload handle의 소유권·범위·직렬화·실행별 ID, global/owner별 자원 회계를 고정한다. 신규 v2 protocol/experiment/snapshot/trace 식별자와 호환 adapter 버전을 코드/fixture로 고정한다.
- v1의 strict parse/codec 동작은 유지하며 기존 앱의 요구 포트만 명시적으로 해석하는 호환 경로를 정의한다. 상위 서비스가 없는 v1 전송 정의는 provider로 거부한다.

완료 기준: 정상 네 인스턴스 구성, 잘못된 포트/타입/방향/스키마·없는/중복 ID·순환/끊긴 연결·잘못된 endpoint/기대 조건·빈/큰 bytes·범위/깊이/크기·원본 불변/복사·v1 호환 fixture가 Node에서 통과한다. S2가 소비할 JSON/API와 실패 진단 위치를 문서화한다. 아직 App과 workspace에 stack 기록을 넣지 않는다.

### S2 — 공유 규칙 런타임·스케줄러·라우터

선행 조건: S1의 모델/직렬화·검사 계약 통과.

작업:

- 후보 `src/engine/protocol-runtime.ts`, `stack-scheduler.ts`, `service-router.ts`, `src/application/create-stack-simulation.ts`를 추가한다. v1에서 공유할 규칙 평가를 분리할 때 큐/효과/기록 순서를 보존한다.
- 한 clock/queue에 input·로컬 전달·최하위 수신·서비스 통지·timer를 넣고 globalSequence·우선순위·동명 timer의 endpoint/generation을 적용한다.
- codec→service 요청→수락→대상 처리→상위 통지의 trace와 준비/failed/closed·유한 큐를 구현한다. 다른 런타임을 재귀 호출하지 않는다.
- 규칙의 동적 검사·trace/큐/payload 예산 예약·상태/효과 반영을 분리한다. 한도·프로토콜 오류·모델링한 전송 실패·엔진 내부 오류를 구분한다.
- run/step/runBatch/pause/cancel/reset과 session fence, observer 없는 실행의 의미적 동등성, 인스턴스 finish와 전체 관찰 기간을 구현한다. live 버퍼 해제 뒤에도 trace가 참조하는 RunArtifacts는 보존한다.

완료 기준: 네 런타임의 상태/codec/timer 격리, 같은 시각의 여러 로컬 전달과 deadline, 합쳐 읽기, 효과 rollback·자원 예약 실패, 0ms 무한 전달, cancel 뒤 callback, 같은 snapshot/seed의 run·step·batch 결과 동등성을 실제 코어로 확인한다. 기존 아홉 catalog와 단일 실행 관련 검사가 유지된다. 새 모드의 브라우저 노출은 아직 보류한다.

### S3 — ReliableStreamLite와 계층 연결 예제

선행 조건: S2의 실제 포트/큐·수명·자원 검증 통과.

작업:

- 후보 `src/examples/reliable-stream-lite.ts`에 이미 준비된 양방향 사용자 정의 provider를 만든다. 한 방향 한 DATA 미확인, write 간에도 이어지는 seq, 수신 기대 seq·캐시·유한 재시도·서비스 실패를 규칙으로 정의한다.
- 실제 bytes를 설정한 크기로 나누고, 기대 순서만 read로 올리며 중복은 ACK만 다시 보낸다. 미래 순번은 명시적으로 무시하고 올리지 않는다. ACK의 방향/대기 seq를 검사한다.
- 방향별 버퍼와 동시 반대 방향 송신을 검사한다. provider가 첫 ACK/전달에서 finish하지 않도록 하며 상위 앱 완료 뒤에도 전체 관찰을 유지한다.
- Ping/Pong JSON Lines와 제한된 HTTP/1.1을 실제 provider에 연결한다. 환경은 최하위 패킷에만 장애를 적용하고 source/지원/생략 항목을 예제 metadata에 기록한다.

완료 기준: 실제 정상 왕복·첫 ACK 손실·DATA 중복/지연 역전·불일치 ACK·재시도 소진·여러 write·분할된 UTF-8·프레임/HTTP 경계·두 방향 동시 전송에서 규칙/서비스 bytes/앱 판정을 확인한다. 대표 ACK 손실 사례에서 재전송이 관찰되고 상대 앱 deliver는 정확히 한 번이다. 실패 전 이미 전달된 접두부를 없애지 않는다. 전송 모듈을 TCP로 표시하거나 전체 표준 적합성을 주장하지 않는다.

### S4 — 저장 v2·재생·관찰/검증 도구

선행 조건: S3의 실제 stack trace와 provider 예제 통과. S5의 사용자 실행 공개 전 완료해야 한다.

작업:

- workspace/bundle/envelope와 DB 버전 전환, legacy reader/실행 경로·원본 보관·atomic upgrade·versionchange/blocked·구형 writer 차단·CAS·quota 복구를 구현한다. 새 모드가 미완성 도구에 들어가지 않게 mode/version 검사를 둔다.
- 정의·binding/link·입력/기대 조건·payload 참조를 포함한 staging 검사, import 사본/충돌 remap, 자기 완결 bundle과 legacy export/복구 경로를 만든다.
- endpoint/port/source 범위가 있는 v2 trace를 읽고 기록 cursor에서 네 인스턴스의 초기/전후 상태·타이머·서비스 상태를 재생한다. 후속 payload/commit을 조회하지 않는다.
- 상태도·시퀀스·연동·실행 설명·실패 진단·메시지 구조·중단점의 target을 endpoint로 확장한다. 합쳐진 원인을 하나로 추정하거나 live 원자성을 history 경계와 혼동하지 않는다.
- 반복/회귀 공통 source와 사례 조건, endpoint별 커버리지, 두 실행의 stable endpoint/서비스 대응을 확장한다. 다른 topology/legacy-stack과 원인 ID/payload ID가 같은 것만으로 동일 회차·내용을 판정하지 않는다.

완료 기준: 실제 native IndexedDB의 upgrade 성공·실패/abort/quota·두 탭 충돌·구형 writer·복구, v1/v2 import/export/ID 충돌/큰 payload/잘못된 참조·unknown 버전, snapshot 재실행·초안/원본 삭제 격리, cursor 0/중간/저장 시점·다중 원인·각 도구의 제한과 endpoint 분리가 통과한다. 취소된 부분 기록의 bytes가 reset/새 실행·저장/새로고침 뒤에도 보존된다. legacy의 의미적 기록·상태·기대 판정은 그대로다.

### S5 — 스택 화면·응용 통합과 최종 검증

선행 조건: S1~S4 완료. 이 단계에서 계층 연결 모드를 사용자에게 노출한다.

작업:

- 후보 `src/ui/StackEditor.tsx`, stack 실행 패널과 기존 App 조합 경로를 추가한다. A/B 계층 카드·포트/하위 링크·타입 오류·입력/기대 조건 endpoint를 폼으로 작성한다.
- 전체/계층별 시퀀스와 선택 인스턴스 상태도·변수·포트 상태·버퍼·실제 메시지/패킷/원인을 연결한다. 편집 초안과 실행 snapshot을 구분한다.
- 첫 예제에서 정상/ACK 손실·중복/지연·실패를 작성→실행→관찰→설명/진단→저장/재생한다. HTTP는 기존 지원 범위를 유지한다.
- Chromium/Firefox·1440/768/390px·키보드·실행 중 편집·자동 재생/중단점·새 세대·case/batch·비교/커버리지 회귀를 검사한다.
- 실제 stack 10000-event fixture, 단일 1 MiB 앱 프레임, 20사례의 저장 한도 안 대형 묶음에서 실행/조회/저장/prefix·유한 DOM을 측정한다. fixture는 실제 엔진으로 생성하고 기존 다섯 performance fixture도 유지한다.

완료 기준: 대표 왕복과 장애에서 포트 수락/하위 수신/응용 완료가 구분되고, 각 도구가 선택한 endpoint와 prefix를 따른다. `pnpm check`·공백 검사와 지원 브라우저/응답성·문서가 통과한다. 구현 상태를 현재 계약에 반영하고 전체 계획을 Completed로 이동한다. 로컬·원격 CI·실제 네트워크/배포 근거를 구분해 보고한다.

## Validation and Acceptance

도구 기준은 [Development](../../development.md), 지원/기존 정량 기준은 [P7](../../design-docs/p7-validation.md)이다. Node 24.18.0/pnpm 9.15.0을 사용한다.

| 시점 | 실행/확인 | 기대 결과 |
| --- | --- | --- |
| 오늘의 문서 변경 | `pnpm check:docs`, `git diff --check`·신규 파일 공백/링크 확인 | 문서·계획·목록·기존 구현 상태의 일관성. source 변경 없음 |
| 각 S단계 source 변경 | 관련 Node/타입/lint/format·필요한 build/E2E | 새 계약의 정상·실패·경계와 기존 의미 보존 |
| 실행/저장/공유 UI 경계 완료 | `pnpm check` | 전체 정적/Node/docs/build·두 브라우저·독립 1-worker 응답성 통과 |
| S5 정량 검사 | 실제 최대 10k 이벤트·1 MiB frame·대형 묶음 | 조회/그림 연동/비교 500ms·bounded DOM 32768자·기존 실행/저장/frame/longtask 상한 유지 |
| 원격 반영을 수행한 경우 | 전달한 정확한 HEAD의 CI·실제 branch/remote | push/merge/CI 결과를 각각 확인. 배포/실제 통신으로 표현하지 않음 |

대형 stack fixture는 전역 큐·trace·payload 예산 아래에서 구성한다. 여러 최대 크기 메시지를 반복해 전역 한도를 넘는 별도 사례는 limit-reached/미판정이어야 하며 정상 성능 fixture의 성공으로 섞지 않는다. 단계별 실패·수정/재실행·실측치·미실행 범위를 Progress/Outcomes에 기록한다.

문서 작성 검증(2026-11-06): `pnpm check:docs`에서 Markdown 41개와 내부 경로/앵커 검사가 통과했다. `git diff --check`와 신규 파일을 포함한 `git diff --cached --check`도 통과했다. 애플리케이션 source 변경이 없어 코어/E2E/응답성 검사는 실행하지 않았으며, 구현 단계의 테스트는 아직 수행하지 않았다.

S1 검증(2026-11-06, macOS·Node 24.18.0·pnpm 9.15.0):

- `pnpm check` 통과: lint/format/type, 당시 Node 402개, 문서 42개, build, Chromium/Firefox 244개, 기존 응답성 5개. UI/기존 엔진에 스택 경로를 연결하지 않았으며 이 브라우저 결과는 v1 회귀 증거다.
- 최종 domain 점검에서 guarded explicit-ignore·JSON 대입·리터럴 필드/타이머 검사와 잘못된 큰 graph의 조기 거부를 보완했다. 이후 전체 Node 403개(신규 S1 59개)와 정적/문서 검사를 다시 통과했다. App/기존 번들 경로는 변경하지 않았다.
- 신규 검사는 정상 네 endpoint/별도 client/server, strict 포트/타입/스키마·revision·중복/없는 참조·순환/끊김·기대 조건, 빈/1 MiB/잘못된 bytes·range/depth/size·낮춘 예산, 원본/snapshot/handle 격리, v1 JSON/HTTP adapter와 기존 transport 거부, 물리/논리 예산·원자적 실패·부분 trace 보존/직렬화를 포함한다.
- 첫 스키마 불일치 fixture가 내부 공유 배열을 함께 수정해 예상과 달리 일치했다. packet schema를 별도 소유 사본으로 만든 뒤 검사 의도를 확인했다. 테스트 명령을 이어 실행할 때 PATH 지정이 첫 명령에만 적용된 오류는 고정 Node 경로를 각 명령에 적용해 수정했다.
- 로컬 로그: `/private/tmp/protocol-s1-check.log`, `/private/tmp/protocol-s1-node-final.log`. 실제 스택 실행/신뢰성·DB upgrade·스택 UI·스택 최대 크기 브라우저 실측은 아직 수행하지 않았다.

S2 검증(2026-11-06, macOS·Node 24.18.0·pnpm 9.15.0):

- `pnpm check` 통과: lint/format/type·Node 437개·Markdown 43개·build·Chromium/Firefox 244개·기존 1-worker 응답성 5개. UI/DB에는 스택을 연결하지 않았으며 브라우저 검사는 공유 코덱/기존 v1의 회귀 증거다. 한도/응답성 임곗값은 변경하지 않았다.
- 신규 35개 검사는 실제 네 인스턴스의 왕복·비재귀 수락/수신·run/step/batch/observer/snapshot 동등성, endpoint/generation별 timer·같은 시각의 추가 로컬 전달과 deadline, UTF-8/JSON/HTTP 경계·합쳐 읽기의 다중 commit/source range, 규칙/한도 rollback·부분 접두부·모델링한 failed/closed·engine-error, 낮춘 global 예산·실제 10000-event 0ms 루프, cancel/reset/callback·immutable 자료·legacy byte-like JSON·native byte/packet 서비스를 포함한다.
- 변경 전 보관한 아홉 v1 catalog의 전체 view(상태·snapshot·trace·기대 판정)를 변경 후 결과와 deep-equal로 대조해 일치했다. 원본 비교 자료는 `/private/tmp/protocol-s2-v1-baseline.json`, 전체 검사 로그는 `/private/tmp/protocol-s2-check.log`에 있다. 임시 파일을 CI 필수 fixture로 사용하지 않는다.
- payload reservation rollback 때 임시 handle도 WeakSet에서 폐기하고, 기존 token의 재사용이 새 예약을 닫지 않도록 했다. 고유 ID 재사용/owner 회계 복구·정확한 쉼표/base64 직렬화 증분을 Node에서 검사했다.
- 최종 자원 점검에서 bytes 변수뿐 아니라 보관한 JSON 객체/배열·문자열도 논리 버퍼 예산에 포함했다. 원본 commit `fc9768e`의 `pnpm check` 이후 이 보완과 회계 우회/rollback 사례를 추가하고 전체 Node 438개·type/lint/format·문서 43개 검사를 다시 통과했다. 로그는 `/private/tmp/protocol-s2-final-node.log`다. 공유 v1 코덱·UI·브라우저 경로는 이 보완에서 변경하지 않았다.
- 테스트용 forward/split/merge provider와 기존 HTTP 정의를 코어 fixture로 조합했다. 사용자 catalog의 ReliableStreamLite·재전송/ACK 신뢰성, 저장 v2/upgrade·관찰 도구·스택 UI/브라우저 성능은 아직 구현·검증하지 않았다.

S3 검증(2026-11-06, macOS·Node 24.18.0·pnpm 9.15.0):

- 최종 `pnpm check` 통과: lint/format/type·Node 465개(신규 27개)·Markdown 44개·build·Chromium/Firefox 244개·기존 1-worker 응답성 5개. 한도/임곗값은 변경하지 않았다. 스택을 기존 UI/DB에 연결하지 않았으므로 브라우저 결과는 v1 회귀 증거다.
- 실제 DATA/ACK·서비스 bytes·앱 판정을 이용해 다섯 catalog 예제, 첫 ACK 손실/동일 DATA 재전송/앱 한 번 전달, DATA 중복/지연 역전·잘못된 방향/순번 ACK·미래 DATA 무시, 여러/합쳐진 write·양방향 동시 Waiting, UTF-8/JSON/HTTP 경계, 정확한 RTO, 빈 write·retry/seq 소진·안전 정수 마지막 번호·FIFO 한도·실패 전 접두부와 늦은 응답, 원본/사본/snapshot 및 run/step/batch/observer 동등성을 검사했다. 여섯 seed의 손실/중복/jitter도 순서 있는 실제 byte 접두부를 유지했다.
- 첫 FIFO overflow fixture의 legacy 기대 조건 빈 배열은 기존 계약상 유효하지 않아 실제 Idle 상태 기대 조건으로 바로잡았다. 기존 Firefox 취소 E2E는 클릭 안정성을 기다리는 사이 묶음이 모두 끝나 버튼이 사라졌다. 브라우저 시계로 실제 부분 실행을 유지한 뒤 다른 탭에서 취소하고 시계를 재개하도록 수정했다. 양 브라우저 각 3회 통과 후 전체 검사를 통과했다. 제품 실행 속도/스케줄러는 변경하지 않았다.
- 최종 로그는 `/private/tmp/protocol-s3-check-final.log`다. 실제 외부 통신·전체 TCP/HTTP 표준 적합성·스택 저장/관찰/UI·스택 1 MiB/대형 묶음의 브라우저 응답성은 이 단계에서 구현하거나 검증하지 않았다.

## Idempotence and Recovery

모든 변경은 feature branch에서 기존 사용자 변경을 보존한다. S1~S3의 미완성 모델/엔진을 App·기존 저장 형식에 노출하지 않는다. 단계별 verified commit으로 이어가며 실패한 단계에서는 이전 실행/자료를 보존하고 다음 단계를 공개하지 않는다.

실행은 snapshot 불변·session generation으로 격리한다. 취소/reset은 live 버퍼를 해제하되 보존 record가 참조하는 RunArtifacts는 유지한다. 저장은 migration/import staging과 transaction/CAS 실패 시 이전 commit을 유지한다. 성공한 DB upgrade의 복구는 새 reader가 legacy 보관본을 읽거나 명시적으로 내보내는 방식이며 자동 downgrade/삭제가 아니다. 유효하지 않은 새 초안/파일은 이미 실행 중인 snapshot·저장본을 파괴하지 않는다.

## Artifacts and Notes

- [설계 계약](../../design-docs/layered-stack-v2.md)
- [현행 v1 제품 범위](../../product-specs/protocol-simulator-v1.md)
- [기존 실행/저장 계약](../../design-docs/p2-runtime.md), [P6](../../design-docs/p6-persistence-replay.md)
- [현재 구조](../../../ARCHITECTURE.md), [문서 지도](../../index.md)

새 fixture/API/실제 측정/commit·원격 CI 링크는 해당 작업을 수행한 단계에서만 추가한다.

## Interfaces and Dependencies

전체 계획은 stack 모델/bytes/서비스·scheduler/runtime·v2 snapshot/trace/workspace/bundle/DB와 모든 endpoint 관찰 도구에 걸친다. S1~S3는 DOM 없는 실행 경로·실제 provider/응용 예제·Node 검사와 공유 가능한 코덱/순수 검사·환경 결정 경계를 구현한다. App·패키지·DB·외부 서비스는 변경하지 않는다. 신규 production dependency는 추가하지 않았으며 필요해지면 기존 승인 규칙을 적용한다.
