# P1 정의 모델·검사·프레이밍 코덱

상태: Accepted
기준일: 2026-10-30
구현 범위: DOM 없는 타입·정의 검사·snapshot 준비와 세 가지 코덱. 실제 이벤트 큐·규칙 실행은 P2, 화면 편집 연결은 P3다.

이 문서는 P1 완료 당시의 API·검증 경계다. 이후 구현한 큐·규칙·타이머·결과 생성은 [P2 계약](p2-runtime.md)을 따른다. 아래에서 P2에 남겨 둔 동적 검사 역시 해당 문서와 실제 엔진 테스트를 기준으로 확인한다.

## 모델과 버전

[protocol-model.ts](../../src/domain/protocol-model.ts)는 ProtocolDefinition, EnvironmentDefinition, ScenarioDefinition, ExperimentDefinition, ExperimentSnapshot, EventTrace, RunResult를 정의한다. 정의의 schemaVersion은 1이며 JSON 형태는 [완전한 fixture](../../tests/fixtures/protocol-models.ts)와 [snapshot 통합 테스트](../../tests/integration/protocol-codec-contract.test.ts)에서 검증한다. P1 당시 EventTrace·RunResult는 타입만 제공했고 P2에서 실제 생성 경로를 추가했다. 저장 결과 import는 P6 범위다.

프로토콜 revision은 1 이상의 안전한 정수다. 실험은 A·B의 정확한 ID/revision 참조와 실제 정의 전체, 하위 환경, 시나리오·기대 조건, seed를 포함한다. ID는 ASCII 영문자/밑줄로 시작하는 영문·숫자·밑줄·하이픈이며 이름·label은 Unicode를 허용한다. 메시지·상태·변수·타이머·규칙 ID는 해당 정의 목록 안에서 유일하다. 필드 ID와 wire name은 메시지 안에서 각각 유일하다. 두 참여자는 같은 계층을 실험하며 하위 서비스가 환경과 일치해야 한다.

## 정의 검사 API

[model-validation.ts](../../src/domain/model-validation.ts)의 공개 함수는 성공 시 `{ success: true, value }`, 실패 시 `{ success: false, diagnostics }`를 반환한다. 진단은 JSON Pointer `path`, 기계적으로 구분할 `code`, 설명 `message`를 포함한다.

| API | 역할 |
| --- | --- |
| `parseJsonData(unknown)` | 유한 JSON·평범한 객체, 깊이 64·노드 100,000 제한 검사. 순환·접근자·비정상 값 거부 |
| `parseProtocolDefinition(unknown)` | 구조·필드 제약·기본값·초기값·참조·코덱/서비스·조건/동작 타입과 알려진 규칙 충돌 검사 |
| `parseExperiment(unknown)` | 전체 자급적 실험의 구조·revision·참여자 계층·서비스·시나리오 값·기대 조건·관찰 기간 검사 |
| `validateProtocolMessage(protocol, unknown)` | 이미 검증된 프로토콜의 안정적인 필드 ID별 값 검사와 기본값 채우기 |
| `prepareExperimentSnapshot(unknown)` | 실험 전체를 검증한 뒤 설정·정의를 복사하고 P0 버전/seed/상한과 함께 깊은 readonly snapshot 생성 |

parse 함수는 초안 자체를 수정하거나 동결하지 않는다. 따라서 사용자가 이후 초안을 편집하면 실행 직전에 다시 검사한다. `prepareExperimentSnapshot`과 코덱 생성 함수는 당시 설정·스키마를 별도로 복사해 이후 편집으로부터 격리한다. P0의 일반 `createRunSnapshot`은 JSON 복사 기초 함수이며 전체 실험 실행의 유효성 검사를 대신하지 않는다.

필드는 string/integer/boolean/enum을 지원한다. 정수는 안전한 정수 범위, 문자열 길이는 Unicode code point 개수로 검사하며 바이트 상한과 구분한다. 기본값과 명시한 false·0·빈 문자열을 누락과 구분한다. required 필드에 기본값이 있으면 누락 시 채우고, 기본값 없는 required 필드는 거부한다. 알려지지 않은 속성·필드와 지원하지 않는 버전은 조용히 무시하지 않는다.

## 규칙·참조 계약

이벤트는 input/receive와 messageId, timer와 timerId, stream의 connection 종료/실패를 지원한다. 데이터그램에는 하위 connection 이벤트를 선언하지 않는다. field 표현식은 해당 input/receive 메시지의 필드만 참조한다. 타이머 이벤트에서 메시지 필드를 읽을 수 없다.

값 표현식은 literal, variable, field, 정수 add/subtract다. 조건은 비교(eq/ne/lt/lte/gt/gte), all/any/not이며 순서 비교는 같은 타입의 문자열·정수만 허용한다. 변수는 string/integer/boolean/json으로 초기값을 검사한다. send/deliver는 대상 메시지와 필드 ID별 표현식을 가지며 assign은 대상 변수, 타이머 동작은 선언한 timerId를 참조한다. finish는 마지막 동작이어야 하고 다음 상태가 terminal이어야 한다.

같은 상태·이벤트에 무조건 규칙이 겹치거나 정규화한 조건이 동일하면 정적으로 충돌을 보고한다. 모든 조건의 논리적 중첩을 증명하지 않으므로 복잡한 조건의 실제 동시 일치는 P2가 실행 시 검사한다. 같은 상태로 돌아오는 빈 동작 규칙은 명시적 `ignore: true`가 필요하다. ignore는 동작을 수행하거나 상태를 바꿀 수 없다. 동적 값의 범위 초과·누락된 선택 필드·정수 연산 overflow는 P2에서 실제 값으로 검사해야 한다.

## 메시지 표현과 코덱

내부 메시지는 다음처럼 stable ID를 사용한다.

```json
{"messageId":"ping","values":{"sequence":1}}
```

v1 JSON wire envelope는 `messageId`와 `fields` 두 속성을 사용한다. `fields`는 정의의 wire name으로 변환하며 encode 시 기본값을 채운다. 예를 들어 fixture의 `sequence` ID는 `number` wire name으로 표현한다.

```json
{"messageId":"ping","fields":{"number":1,"text":"안녕","mode":"safe","urgent":false}}
```

header/body/payload 배치는 v1 논리 메타데이터다. 자유로운 텍스트 문법이나 바이너리 레이아웃을 자동 생성하지 않는다. HTTP/1.1 전용 문법은 P5에서 별도 코덱으로 도입한다.

[message-codecs.ts](../../src/codecs/message-codecs.ts)의 생성 함수는 프로토콜 전체·서비스·코덱을 확인하고 해당 스키마 사본을 보관한다. 잘못된 설정은 ValidationResult로 반환하며 UI·엔진에 의존하지 않는다.

| 코덱 | 전달 경계·오류 처리 |
| --- | --- |
| `createJsonLinesCodec` | UTF-8 JSON 뒤 LF를 붙인다. `push`는 0개 이상의 메시지와 진단을 반환하고 `finish`는 EOF 처리. LF 전까지 바이트를 누적하므로 UTF-8 문자가 청크 사이에서 나뉘어도 안전함 |
| `createJsonDatagramCodec` | encode/decode마다 하나의 완전한 envelope. 부분 패킷을 다음 호출과 이어 붙이지 않음 |
| `createLogicalPacketCodec` | 같은 envelope를 구조화된 JSON 패킷으로 검증·복사. 실제 TCP/IP 바이너리 패킷이라고 표현하지 않음 |

JSON은 엄격한 UTF-8로 디코딩한다. BOM을 자동 제거하지 않으므로 BOM·빈 줄·잘못된 JSON·필드 값·알려지지 않은 필드는 오류다. JSON Lines는 JSON 내부의 정상 whitespace와 CRLF 끝맺음을 허용하지만 LF 없는 EOF는 완전한 JSON이어도 incomplete-frame이다. datagram의 불완전 JSON은 그 패킷만 실패하고 다음 패킷 검사는 계속할 수 있다.

JSON Lines가 중간 프레임에서 실패하면 해당 decoder를 닫고 나머지는 처리하지 않는다. 같은 push에서 먼저 완성한 메시지는 반환하며 오류 경로는 `/frames/프레임번호/...`로 표시한다. 닫힌 decoder에 다시 push하면 codec-closed다. 정상 finish는 반복 호출해도 새 오류를 만들지 않는다.

바이트 상한은 envelope 전체에 적용하며 JSON Lines는 마지막 LF도 포함한다. byte limit과 pending buffer limit을 각각 검사한다. 여러 작은 프레임을 합친 큰 청크는 각 프레임이 제한 안이면 처리한다. pending 버퍼는 작게 시작해 상한 안에서 성장하며 수신 청크 참조를 보관하지 않아 호출자가 청크를 재사용해도 내용이 바뀌지 않는다. 논리 패킷은 JSON 표현의 UTF-8 크기로 자원 사용을 제한하며 실제 네트워크 패킷 크기 계산이 아니다.

## 검증 범위

- [모델 검사 테스트](../../tests/unit/protocol-model.test.ts): 모든 codec profile, 필드·기본값·제약·참조·조건·동작·호환성·scenario·snapshot, 중첩 속성의 누락/null 변형에서 예외 없이 진단.
- [코덱 테스트](../../tests/unit/message-codecs.test.ts): 모든 바이트 분할 위치, 한 바이트 읽기, 합쳐 읽기, UTF-8와 escaped newline, caller buffer 재사용, EOF·잘못된 데이터·상한·버퍼 성장과 스키마 격리.
- [모델/코덱 통합 테스트](../../tests/integration/protocol-codec-contract.test.ts): 검증 → 불변 snapshot → JSON 왕복 → 재검증 → byte encode/decode.

전체 검사와 단계별 실제 결과는 [구현 계획](../exec-plans/completed/20261030-1641-layered-protocol-v1.md)에 기록한다. P1은 P0 화면을 유지하며 새 API를 아직 편집 화면에 연결하지 않는다. 이벤트 큐·규칙 실행·타이머·실제 환경은 P2 이후다. production dependency나 개발 도구 버전은 변경하지 않았다.
