# S3 ReliableStreamLite와 실제 계층 연결 예제

상태: Accepted
기준일: 2026-11-06
구현 범위: [S2 실행 코어](s2-stack-runtime.md)에서 실제 동작하는 사용자 정의 provider·Ping/Pong/제한된 HTTP 예제와 불변 원본/사본 API. [전체 설계](layered-stack-v2.md)와 [구현 계획](../exec-plans/active/20261106-layered-protocol-stacks.md)을 따른다. 저장/관찰 도구·화면 연결은 S4/S5다.

## 프로토콜 정체성과 경계

[reliable-stream-lite.ts](../../src/examples/reliable-stream-lite.ts)는 이미 준비된 양방향 stream bytes를 제공하는 v2 native 정의를 생성한다. version/revision은 1이다. DATA/ACK·버퍼·순번·타이머·상위 통지는 일반 사용자 규칙이며 router/scheduler가 재전송·순서/중복 제거를 보충하지 않는다.

TCP가 아니다. seq는 **DATA 조각 하나당 증가하는 번호**이며 ACK는 그 DATA의 번호를 그대로 돌려준다. TCP의 바이트 순번·누적 ACK·wire header·checksum·윈도/혼잡 제어·wraparound·연결 수립/FIN/RST·half-close·재연결을 구현하지 않는다. 영구적인 손실에서 전달을 보장하지 않으며 유한 재시도 뒤 failed로 끝낸다.

| 논리 패킷 | 필드 |
| --- | --- |
| DATA | direction(AtoB/BtoA), seq(0~MAX_SAFE_INTEGER-1), payload(1~65536 bytes) |
| ACK | DATA가 속한 direction, 그 DATA의 seq |

direction은 패킷이 향하는 하위 링크 방향과 구분한다. 예를 들어 AtoB DATA의 ACK는 B에서 A로 보내지만 ACK.direction은 AtoB다. 인스턴스 A/B의 txDirection/rxDirection은 서로 반대이며 자기 송신 방향과 현재 seq가 일치하는 ACK만 수락한다. packet schema는 양쪽이 같고 두 instance의 상태/변수/timer는 독립적이다. 패킷은 bytes 필드가 있는 명시적인 logical packet이며 실제 TCP/IP 바이너리 인코딩으로 표시하지 않는다.

## 상태와 규칙

Ready/Waiting은 자기 송신 방향의 상태다. 두 상태 모두 상대 방향 DATA를 받을 수 있고, Waiting에서도 상위 write를 FIFO에 보관한다. 성공한 read/ACK 하나로 provider를 finish하지 않는다. 앱의 Done 이후에도 provider는 전체 관찰 기간 동안 ACK·중복 처리를 계속한다.

| 입력 | 규칙의 실제 동작 |
| --- | --- |
| Ready의 비어 있지 않은 write | pending에 실제 bytes를 보관하고 첫 유한 조각을 cached에 넣어 DATA 송신·ACK timer 시작. Waiting |
| Waiting의 추가 write | queued 뒤에 bytes를 이어 붙임. 지금 대기하는 DATA/cache/timer는 유지 |
| Ready/Waiting의 빈 write | 명시적 ignore. DATA·ACK·seq 소비 없음 |
| 방향과 기대 seq가 맞는 DATA | payload를 read로 한 번 올리고 expectedSeq 증가·ACK 송신 |
| 이미 받은 seq의 DATA | 상위 read 없이 같은 direction/seq의 ACK만 다시 송신 |
| 미래 seq 또는 다른 방향 DATA | 명시적 ignore. ACK·상위 read 없음 |
| 현재 방향/seq가 맞는 ACK | timer 취소·txSeq 증가. pending의 다음 조각, 이어서 queued를 처리하거나 버퍼를 비우고 Ready |
| 다른 ACK / Ready의 늦은 ACK | 명시적 ignore. 현재 cache/seq/timer를 바꾸지 않음 |
| ACK timer, retries < maxRetries | 같은 cached bytes/direction/seq 재송신·retries/retransmissions 증가·timer 재시작 |
| 재시도 또는 seq 소진 | 버퍼/cache 정리·failureReason 설정·상위 failed·finish failure. Failed |
| Failed 뒤 도착한 DATA/ACK/이미 수락된 write | 명시적 ignore. 실패한 서비스를 다시 준비하거나 새 bytes를 전달하지 않음 |

txSeq는 write마다 초기화하지 않는다. 마지막 지원 번호를 ACK하면 다음 번호는 안전 정수인 소진 sentinel로만 남고 전송에 재사용하지 않는다. 더 보낼 bytes나 새 write가 있으면 sequence-exhausted다. expectedSeq도 안전 정수 경계 안에서만 증가한다. 실패 전의 read·앱 deliver·trace/artifacts는 지우지 않는다.

pending은 현재 write 묶음을 유지하고 offset으로 이미 보낸 부분을 건너뛴다. cached는 재전송할 조각 하나다. queued는 대기 중 추가 write들을 이어 붙인 bytes다. 여러 write는 한 DATA/read로 합쳐질 수 있고, write 하나도 여러 조각으로 나뉠 수 있다. 메시지 경계는 상대 앱의 JSON Lines/HTTP 코덱이 복원한다.

S1/S2 예산을 그대로 사용한다. queued concat/패킷/codec/포트/global payload·live 버퍼·trace 한도를 넘으면 limit-reached와 미판정이며 재시도 소진의 모델링한 Failed와 다르다. 실패 규칙은 pending/queued/cached를 비우되 과거 관찰 자료는 보존한다.

## API와 설정

`createReliableStreamLiteProtocol(participant, options?)`는 `reliable_stream_lite_A/B` 정의를 만든다. 아래 설정은 초기 변수로 들어가므로 사본에서 규칙과 함께 살펴볼 수 있다.

| 옵션 | 기본값·생성기 허용 범위 |
| --- | --- |
| chunkBytes | 64, 안전 정수 1~65536 |
| timeoutMs | 100, 안전 정수 1~MAX_SAFE_INTEGER-1. 실제 timer deadline도 실행 시 검사 |
| maxRetries | 3, 안전 정수 0~1000. 최초 송신 이외의 재송신 횟수 |
| maxSequence | MAX_SAFE_INTEGER-1, 안전 정수 0~MAX_SAFE_INTEGER-1. 소진 검사용으로 낮출 수 있음 |

initialSends는 원본 DATA 조각 수, retransmissions는 재전송 합계, retries는 현재 조각의 재시도 수다. deliveredChunks/receivedBytes는 실제 read 수/바이트 수, duplicateChunks는 재ACK한 중복 수다. 이 카운터가 앱 메시지 수나 전달 완료를 대신하지 않는다.

[reliable-stack-examples.ts](../../src/examples/reliable-stack-examples.ts)의 `createReliableStackExperiment(application, options?)`는 유효한 v1 stream 앱의 정의/시나리오를 명시적 adapter로 감싸고 두 provider와 데이터그램 링크를 조합한다. 원본 seed·입력/기대 조건을 endpoint로 옮기고 사용한 실제 정의 전체를 포함한다. 원래 stream 환경은 새 provider/link로 **교체**하며 기존 chunk/delay 설정을 실제 실행한 것처럼 보존하지 않는다. 예약된 close/fail이 있는 기존 환경이나 datagram/transport 앱은 거부한다. 선택 environment/observationMs도 완성된 스택 검사에 통과해야 한다.

일반 조합 함수는 앱의 실패/timeout 규칙을 자동 작성하지 않는다. 제공 예제의 알려진 Ping/Pong·HTTP **새 사용자 사본**은 별도 id/revision으로 StreamFailed 처리와 terminal 상태의 늦은 failed 무시를 명시한다. Ping/Pong 사본은 B의 request deliver와 timeout 뒤 늦은 Pong 무시도 선언한다. 기존 아홉 v1 예제·원본과 저장 자료는 수정하지 않는다.

## 버전 있는 예제와 원본/사본

| ID | 실제 구성/기대 |
| --- | --- |
| stack_ping_pong | JSON Lines · 정상 왕복 · B Ping/A Pong 각 1회 · 양 provider Ready |
| stack_first_ack_loss | BtoA 실제 첫 전송(ACK)을 손실. 같은 DATA 재전송/중복 재ACK · 앱 전달은 각 1회 |
| stack_http_get | 제한된 HTTP GET · 요청/응답 해석과 한 번 전달 |
| stack_http_post | UTF-8 POST/echo body · Content-Length를 기존 코덱이 계산/검사 |
| stack_http_split | 한 바이트 DATA/read로 CRLF/header/body/UTF-8 경계를 나누어 같은 요청/응답 복원 |

HTTP는 기존 GET/POST origin-form·명시적 Content-Length·UTF-8/선언한 헤더 범위를 유지한다. TLS·HTTP/2/3·chunked·압축·다중 교환·전체 표준 적합성을 주장하지 않는다. 1바이트 예제는 가상 RTT가 길어지므로 앱 deadline 15000ms/observation 16000ms를 사용한다. 나머지 앱 deadline은 500ms이며 전송 신뢰성과 별개다.

`STACK_EXAMPLES` metadata는 version/supported/omitted/sources를 갖는다. `getStackExampleOriginal(id)`는 불변 원본, `createStackExampleCopy(id)`는 별도 id의 수정 가능한 전체 사본이다. 스택의 optional origin에는 exampleId/version을 보존한다. 이는 출처 표시이며 실제 실행 의미는 snapshot에 들어간 정의/adapter/환경/seed가 소유한다. 기존 v2 snapshot에서 origin이 없어도 유효하다. 현재 catalog는 코드 API이며 v1 화면/IndexedDB에 새 형식을 넣지 않았다.

## 검증과 다음 경계

[실제 통합 검사](../../tests/integration/reliable-stream-lite.test.ts)는 다섯 예제의 모든 기대 조건, 실제 첫 ACK의 손실/재전송·중복 억제, 여러/동시 양방향 write·늦은 중복·잘못된 ACK/미래 DATA, seeded 손실/중복/지연의 순서 있는 접두부, 정확한 deadline·retry/seq 소진·빈 write·FIFO 한도·이후 도착·불변 replay/사본을 확인한다. 미래 DATA/다른 방향 ACK는 편집한 peer 규칙으로 보내고, planner는 실제 전송의 전달 시각/복제만 바꾼다. 환경이 packet 내용을 조용히 바꾸거나 가짜 상위 전달로 검증하지 않는다.

실제 명령·결과는 구현 계획에 기록한다. 스택 저장 v2·관찰 도구와 UI·스택 1 MiB/대형 사례의 브라우저 응답성 실측은 S4/S5이며 이 단계의 코어 검사로 대체하지 않는다.
