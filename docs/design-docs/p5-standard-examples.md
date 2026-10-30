# P5 HTTP/1.1·TCP 연결 예제

상태: Accepted
기준일: 2026-10-30
구현 범위: 제한된 HTTP 텍스트 코덱·여섯 시나리오와 정상 TCP 연결 수립 개념 모델, 버전 있는 예제 원본과 사용자 사본. 전체 표준 호환성·실제 네트워크·저장을 의미하지 않는다.

## 표준 근거와 지원 경계

HTTP의 시작 줄·CRLF 헤더 종료와 Content-Length에 의한 바이트 프레이밍은 [RFC 9112 §2](https://www.rfc-editor.org/rfc/rfc9112.html#section-2), [§6.3](https://www.rfc-editor.org/rfc/rfc9112.html#section-6.3)을 기준으로 검토했다. GET·POST origin-form, Host와 명시적인 길이에 범위를 한정한다. 정상 송신의 Content-Length는 UTF-8 본문 바이트 수에서 생성한다. 수신은 선언한 길이만큼 모은 뒤 본문을 해석한다.

TCP는 [RFC 9293 §3.5 Figure 6](https://www.rfc-editor.org/rfc/rfc9293.html#section-3.5)의 정상 능동·수동 연결을 기준으로 검토했다. SYN은 순서 번호 하나를 소비하고 ACK 자체는 소비하지 않는다. 100/300 초기값의 교환은 SYN seq100, SYN-ACK seq300/ack101, ACK seq101/ack301이다.

| 예제 | 실제 지원 | 생략·제한 |
| --- | --- | --- |
| HTTP | GET/POST origin-form, HTTP/1.1 시작 줄, ASCII 헤더·필수 Host, 명시적 Content-Length, UTF-8 본문, 선언한 추가 헤더, 분할 수신 | HEAD·CONNECT·1xx·204·304, chunked·압축·upgrade·TLS·HTTP/2·3, 미선언/중복/접힌 헤더, 단일 교환 모델에서 pipelining·다중 동시 요청 |
| TCP 연결 수립 | CLOSED/LISTEN → SYN-SENT/SYN-RECEIVED → ESTABLISHED, SYN/ACK 플래그·seq/ack 검사, 독립 양쪽 상태 | 실제 바이너리 TCP/IP, 데이터 전송·재전송·흐름/혼잡 제어, 포트/체크섬/옵션/윈도·FIN/RST·동시 열기·32비트 순서 번호 wraparound |

HTTP 응답은 200~599 중 204·304를 제외한 명시적 길이의 응답을 지원하며 205의 본문은 비어 있어야 한다. 관련 의미는 [RFC 9110 §15.3.6](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.3.6)을 참고했다. 상태별 전체 의미·필수 헤더 검증과 파싱 오류에 대한 자동 400 응답은 구현하지 않는다. 일부 유효한 일반 HTTP 형식도 이 코덱의 지원 범위 밖이면 명시적으로 거부한다. 이 결과를 일반 HTTP 전체의 유효성 판정으로 표현하지 않는다.

## 모델과 코덱

정의 schemaVersion 1에 codec `http-1.1`, 메시지의 선택적 http mapping과 실험의 선택적 origin(exampleId/version)을 추가했다. 기존 세 코덱·origin 없는 실험은 계속 유효하다. 새 동작의 engineVersion은 `0.1.0-p5`다. 이전 엔진으로 새 코덱을 실행할 수 있다고 주장하지 않는다.

[HTTP mapping](../../src/domain/http-schema.ts)은 고정 필드명을 강요하지 않고 메시지의 stable ID를 시작 줄·본문에 연결한다. request는 methodFieldId/targetFieldId/bodyFieldId, response는 statusFieldId/reasonFieldId/bodyFieldId를 사용한다. 나머지 header 필드는 HTTP 이름으로 직렬화한다. raw mapping은 wireFieldId 하나의 UTF-8 문자열을 그대로 송신해 오류 실험에 사용한다.

HTTP mapping은 정확히 하나의 request와 response를 요구한다. 참조·타입·필수/기본값·배치와 case-insensitive 헤더 이름을 검사한다. Content-Length는 자동 생성하므로 일반 헤더 필드로 중복 선언하지 않는다. 명시적 raw 송신에서는 길이·헤더 오류를 직접 만들 수 있지만 임의 JavaScript나 바이너리 코덱은 실행하지 않는다. HTTP는 stream과 응용 계층만 허용하며 서비스 변경으로 JSON으로 조용히 치환하지 않는다.

[createHttpCodec](../../src/codecs/http-codec.ts)은 설정·상한을 캡처한 encode/push/finish/abort API를 제공한다. 시작 줄·헤더는 ASCII, 본문은 완전한 UTF-8을 사용하며 보존할 수 없는 고립 UTF-16 surrogate 입력도 거부한다. 헤더는 CRLF 종료를 읽고 길이를 파싱한 뒤 바이트 단위로 누적한다. 본문 내부의 CRLF를 새 헤더로 해석하지 않는다. Host·필드 구문·길이·중복·지원하지 않는 형식과 선언한 필드 값을 검사한다.

단일 프레임과 수신 버퍼 기본 상한은 각각 1 MiB, 헤더 상한은 64 KiB다. 선언 길이가 상한을 넘으면 큰 버퍼를 할당하기 전에 중단한다. 여러 정상 프레임이 한 청크에 들어와도 각 프레임에 상한을 적용한다. 이는 바이트 프레이밍 지원이며 단일 교환 예제의 pipelining 지원을 뜻하지 않는다. 파싱 오류는 이전에 완성한 메시지를 보존하고 decoder를 닫는다. EOF의 미완성 헤더와 본문, 연결 실패의 abort를 구분한다.

Content-Length가 실제보다 작으면 수신자는 선언한 접두부를 한 본문으로 해석한다. 남은 바이트가 다음 유효 프레임인지 판단해야 하므로 의도한 본문 길이를 임의로 추정하지 않는다. UTF-8 중간에서 잘리면 본문 오류, 뒤에 불완전한 헤더가 남으면 EOF 오류가 된다. 테스트가 이 구분도 검사한다.

## 예제 시나리오와 판정

[HTTP 정의](../../src/examples/http.ts)는 클라이언트 입력 → 요청 송신 → 서버 해석/상위 전달 → 별도 처리 대기 타이머 → 응답 송신 → 클라이언트 상위 전달을 실제 규칙으로 실행한다. 서버 처리 대기와 하위 전달 지연은 다른 설정이다.

| 라이브러리 ID | 관찰할 결과 |
| --- | --- |
| http_get | 빈 본문의 요청/응답, 양쪽 Done·응답 1회 |
| http_post | 한글 본문과 자동 Content-Length, 응답 내용 일치 |
| http_split | 같은 POST를 1바이트 청크로 받아 같은 메시지·최종 결과 |
| http_bad_header | 콜론 앞 공백의 raw 요청 → 실제 수신 코덱의 http-header |
| http_incomplete_body | 9바이트 선언/6바이트 전송 후 EOF → http-incomplete-body |
| http_delayed | 처리 대기 600ms로 클라이언트가 500ms에 TimedOut, 620ms의 늦은 응답은 상위 미전달 |
| tcp_handshake | 양쪽 ESTABLISHED와 실제 100/300 seq/ack 동기화 |

오류 예제에서 수신자는 파싱 오류로 정지한다. 그 수신자의 기대 조건은 미판정이며 예상한 오류라는 이유로 통과로 바꾸지 않는다. 송신자의 timeout·응답 0회는 독립적으로 검사한다. 라이브러리 설명에 예상 진단과 미판정을 표시한다.

[TCP 정의](../../src/examples/tcp-handshake.ts)는 능동·수동 정의를 각각 A/B에 연결한다. ISS에서 sndNxt를, 수신 SYN에서 rcvNxt를 계산하고 SYN-ACK/최종 ACK의 값·플래그를 검사한다. 잘못된 ACK나 플래그는 ESTABLISHED로 전이하지 않는다. 관찰용 500ms timeout은 이 제한된 예제의 종료 정책이며 TCP 재전송 구현이 아니다. 손실된 SYN을 자동으로 재전송한다고 표시하지 않는다.

## 원본·사본과 화면

[예제 catalog](../../src/examples/catalog.ts)의 아홉 항목은 위 일곱 시나리오와 기존 Ping/Pong·Stop-and-wait다. 각 항목은 원본 버전·출처·지원·생략·예상 결과를 가진다. 깊게 동결한 원본을 보관하고 createExampleCopy로 새 실험 ID와 원본 참조를 가진 사용자 사본을 만든다. 원본을 편집기에 직접 전달하지 않는다. 필드·규칙 편집은 원본과 다른 사본을 바꾸지 않는다.

라이브러리와 사본의 모든 작업 공간에서 출처·지원 범위를 열람할 수 있다. 현재 catalog에 없는 원본 버전이면 설명이 없음을 표시한다. origin 참조를 표준 적합성 보증으로 사용하지 않는다. P5 당시 영속 저장은 없었으며 현재 새로고침 보존·파일·과거 기록은 [P6 계약](p6-persistence-replay.md)을 따른다.

[HTTP mapping 폼](../../src/ui/HttpMappingEditor.tsx)에서 ID 연결을 편집하고, 시나리오의 일반 본문은 textarea로, raw wire는 CRLF를 보존하는 JSON 문자열로 편집한다. [전송 상세](../../src/ui/WireInspector.tsx)는 바이트 수·CRLF·Content-Length와 본문 바이트 수를 미리 보고, TCP 등 논리 패킷은 필드 표로 표시한다. 미리보기는 8192바이트로 제한하며 전체 이벤트는 별도로 남는다.

## 검증

- [HTTP 단위 검사](../../tests/unit/http-codec.test.ts): 모든 바이트 분할, UTF-8·CL·CRLF, 잘못된 Host/헤더/길이/중복·지원 밖 형식, EOF·선언보다 짧은 길이의 의미, 원시 오류 송신, 1 MiB 정확 경계·버퍼/헤더 상한, 사용자 ID mapping·surrogate·schema 캡처.
- [표준 예제 통합 검사](../../tests/integration/standard-examples.test.ts): 모든 catalog 원본/사본의 실제 결과·진단·판정, 원본 동결·사본 격리·origin 왕복, 서비스 불일치, 처리 대기·단일 교환, binding 오류 위치, TCP의 100/300 및 편집한 ISS·잘못된 ACK/seq/플래그·손실 종료.
- [Chromium E2E](../../tests/e2e/standard-examples.test.ts): 아홉 예제 각각의 화면과 코어 결과 비교, 출처·버전·제한, 본문 편집에 따른 실제 CL, 원본 재복사, raw 요청 수정 후 정상 파싱, HTTP 서비스 오류와 편집 위치, TCP 중간 상태·실제 필드·수동 ISS 변경.

실제 명령·결과는 [실행 계획](../exec-plans/active/20261030-1641-layered-protocol-v1.md)에 기록한다. production dependency 추가, 실제 서버/기기 연결·원격 CI·배포는 수행하지 않았다.
