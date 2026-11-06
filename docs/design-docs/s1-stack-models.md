# S1 스택 모델·포트·바이트 계약

상태: Accepted
기준일: 2026-11-06
구현 범위: domain 모델·검사·소유 자료 도구. 이를 사용하는 실행기/코덱은 [S2](s2-stack-runtime.md), 별도 workspace/IndexedDB·관찰 API는 [S4](s4-stack-persistence-observation.md)에 구현했다. 화면/기본 DB 전환은 S5이며 [전체 설계](layered-stack-v2.md)와 [계획](../exec-plans/active/20261106-layered-protocol-stacks.md)을 따른다.

## JSON 형식과 버전

[stack-model.ts](../../src/domain/stack-model.ts)가 타입과 `STACK_POLICY`를 소유한다. protocol/experiment/scenario/snapshot/trace/artifacts는 `schemaVersion: 2`이며 기존 v1 reader에 섞지 않는다.

| 자료 | 식별·내용 |
| --- | --- |
| native protocol | `mode: 'stack-protocol'`, id/revision/label, layer/codec, requires/provides, 메시지·상태·변수·타이머·규칙 |
| legacy application | `mode: 'legacy-application'`, `adapterVersion: 'v1-application-ports/1'`, 정확한 v1 source 전체와 requires. id/revision은 source와 동일 |
| experiment | `mode: 'stack'`, 정의 전체, nodes.A/B.instances, bindings, 단일 link, scenario, seed, limits. S3의 optional origin(exampleId/version)은 출처이며 기존 origin 없는 자료도 유효 |
| snapshot | `mode: 'stack'`, `engineVersion: 'stack-1'`, `randomAlgorithm: 'mulberry32-v1'`, configuration 전체. S2가 별도 실행 경로에서 소비하는 계약 |
| trace | `mode: 'stack'`, run/event ID·timeMs·증가 sequence·endpoint, 선택 portId/linkId, kind·sourceEventIds·payloads·JSON data |
| artifacts | `mode: 'stack-artifacts'`, payloads의 payloadId와 실제 bytes. payload ID는 이 record 안에서만 해석 |

`StackLimits`는 정책 상한 이하의 양의 안전 정수다. 기본값은 `defaultStackLimits()`로 만든다. 낮춘 한도도 snapshot에 포함하며 message/bytes 평가·payload 도구에 실제 한도를 전달한다. 한도·기본값은 [전체 설계의 자원 표](layered-stack-v2.md#유한-자원과-관찰-종료)와 코드에서 관리한다.

## 정의·포트·연결 검사

[stack-protocol-validation.ts](../../src/domain/stack-protocol-validation.ts)와 [stack-validation.ts](../../src/domain/stack-validation.ts)는 untrusted JSON을 먼저 검사한다. plain JSON 외의 prototype·accessor·symbol·cycle·hole·nonfinite 값, 64단계/100000-node 초과를 거부한다. 정의/실험 JSON은 base64를 포함해 최대 16 MiB다. 실패는 `{ success: false, diagnostics: [{ path, code, message }] }`이며 path는 JSON Pointer다.

`ServicePort`는 stable id, role(requires/provides), service, request, indication, lifecycle을 가진다. 첫 계약은 `initial: 'ready'`이며 선언한 failed/closed 통지만 허용한다. stream bytes는 write/read, datagram bytes 또는 packet schema는 send/receive다. packet schema는 id/revision/messages 전체를 가진다. native logical-packet 코덱의 requires는 자기 메시지와 같은 packet schema를 요구한다. 기존 byte 코덱은 scalar 필드만 허용하며 bytes 필드를 암묵적으로 JSON 변환하지 않는다.

연결 검사는 A/B 각 application+transport 두 인스턴스, 정확한 정의 revision, 같은 노드의 app.requires→transport.provides, 최하위 transport.requires 사이의 데이터그램 링크 하나를 요구한다. 배열 순서는 정체성이 아니다. 중복 ID·여러 provider·fanout·끊긴 포트·잘못된 포트/방향·consumer→provider 순환을 거부한다. 제공하는 lifecycle 통지는 consumer가 모두 받을 수 있어야 한다.

양쪽 계층은 codec과 wire 메시지 계약이 같아야 한다. 프로토콜 ID·규칙·상태·label·local field ID는 달라도 된다. 메시지 ID·wire field name·type/제약/default/placement와 HTTP binding의 wire 역할을 비교한다. 필드/메시지 배열 순서는 무시한다. packet 서비스는 schema id/revision과 실제 메시지 구조가 모두 일치해야 한다. bytes와 packet 사이 변환은 없다. 정적 일치는 실제 신뢰성의 증명이 아니다.

사용자 입력은 최상위 application endpoint의 메시지다. state/completion-before 기대는 모든 인스턴스, delivery-count/delivered-values는 application deliver를 대상으로 한다. 없는 endpoint·상태·메시지·필수 값·범위 밖 입력/기한을 거부한다. 시나리오 검사에서 defaults는 값 검사에 적용하며 원본 JSON을 수정하지 않는다. 실행 시에는 값 검사 API가 반환한 정규화 값을 사용한다.

v1 앱은 `adaptLegacyApplication(source, portId?)`로 소유 사본을 만든다. JSON Lines/HTTP는 stream bytes, JSON datagram은 datagram bytes를 요구한다. wrapper reader는 source·identity·adapter version·생성된 포트 전체를 다시 대조한다. 기존 transport/논리 패킷 정의는 provider를 선언하지 않았으므로 adapter로 승격하지 않는다. v1 parse/코덱·기존 실행 경로는 변경하지 않았다.

## 바이트 값과 표현식

[stack-bytes.ts](../../src/domain/stack-bytes.ts)의 저장 표현은 다음과 같다. 빈 바이트는 길이 0, data는 빈 문자열이다.

```json
{ "kind": "bytes", "encoding": "base64", "byteLength": 3, "data": "AP+A" }
```

`parseBytesValue`는 필드·길이·canonical padding/최종 bits까지 검사한다. `serializeBytes`는 문자열을 소유하고 `deserializeBytes`는 매번 새 Uint8Array를 반환한다. `OwnedBytes`는 private 복사본만 가지며 copy/slice/toJSON으로 외부 mutable 참조를 차단한다. 호출자 typed array를 freeze하지 않는다.

bytes 필드는 minBytes/maxBytes/defaultValue, bytes 변수는 canonical 초기 값을 지원한다. [stack-expressions.ts](../../src/domain/stack-expressions.ts)는 기존 literal/variable/field/add/subtract에 service-payload, byteLength(value), slice(value, offset, length), concat(values)를 추가한다. slice는 offset/length가 음수·분수·안전 정수 밖이거나 원본 범위를 벗어나면 실패하며 clamp하지 않는다. concat은 빈 operand 목록·비바이트 operand·결과 한도 초과를 거부한다. 깊이 32·4096 노드와 JSON 직렬화 상한을 적용한다.

`checkStackExpression`은 trigger의 메시지 필드와 데이터가 있는 서비스 이벤트에만 참조를 허용한다. failed/closed/timer에는 service payload가 없다. `evaluateStackExpression`은 실제 값·정수 overflow·바이트 길이/범위를 다시 검사하고 소유 JSON 사본을 반환한다. 규칙의 상태·타이머·효과를 반영하지 않으며 S2의 임시 상태 평가에 사용한다.

no-op 규칙은 상태를 유지하고 `ignore: true`를 명시해야 하며 조건부 ignore도 허용한다. terminal 상태의 후속 처리도 ignore만 허용한다. 정적으로 알려진 field literal과 timer duration은 값/범위까지 검사한다. JSON 변수에는 JSON scalar/객체를 대입할 수 있지만 bytes는 별도 bytes 변수에만 대입한다.

메시지/논리 packet의 JSON 표현은 base64를 포함해 maxMessageBytes 이내로 검사한다. bytes 서비스 자체는 원시 바이트 길이를 검사한다. 예를 들어 1 MiB byte 값은 단독 bytes 서비스에 유효하지만 그 값을 base64로 포함한 논리 packet은 JSON 상한을 넘을 수 있으므로 provider가 유한 DATA 조각으로 나눠야 한다. 실제 앱 코덱의 최종 인코딩/수신 프레임 상한은 S2에서도 별도로 검사해야 한다.

## payload 소유권과 자원

[stack-payloads.ts](../../src/domain/stack-payloads.ts)의 `StackPayloadStore`는 run별 private 블록과 handle을 소유한다. `add`는 바이트를 복사하고 `slice`는 같은 블록의 offset/length만 참조한다. 물리 사용량은 블록 단위, 논리 live 사용량은 각 owner의 range 길이를 합산한다. 같은 바이트를 여러 owner가 참조하면 논리 예산에 각각 센다. 동일 내용의 별도 add는 별도 블록이며 내용 기반 전역 dedup은 하지 않는다. 0-byte 블록도 무한히 생기지 않도록 블록 수는 maxPendingOperations+maxTraceEvents 이내다.

handle은 store가 발급한 객체 정체성으로 확인한다. 다른 store의 동일 runId/payloadId·복사/위조한 JSON handle을 live API에서 사용할 수 없다. 저장된 range는 해당 record의 `parseRunArtifacts`/`readArtifactRange`로만 해석하며 다른 record와 공유 원인/내용이라고 판단하지 않는다.

`setOwner`는 codec/port별 한도와 전체 live 한도를 모두 확인한 후 소유 범위 전체를 원자적으로 교체한다. 실패하면 기존 소유권/회계가 유지된다. 선택 logicalBytes는 전체 range 길이를 포함한 packet 메타데이터 비용도 셀 수 있다. `appendTrace`는 전체 batch의 버전·ID·순서·이전 source ID·소유 handle·trace+실제 base64 artifacts의 직렬화 합계를 확인한 뒤 한 번에 보존한다. S2는 beginReservation의 rollback/commit을 통해 상태·효과·큐 처리 예약과 조합한다.

`capture()`는 trace와 사용된 원본 블록의 불변 자료를 반환한다. `clearLive()`는 owner와 관찰되지 않은 임시 블록만 정리하며 committed trace 블록은 남긴다. 캡처한 자료는 store/새 실행과 독립적이다. record 삭제 뒤 store/capture의 참조를 놓으면 일반 GC 대상이 된다. DB 저장은 아직 연결하지 않았다.

## S2 진입 API와 진단 위치

| API | 입력·결과·실패 위치 예 |
| --- | --- |
| parseStackProtocol | unknown→정의/진단. `/requires/service`, `/provides/role`, `/rules/0/actions/0/value` |
| adaptLegacyApplication | v1 source→불변 wrapper. `/source/layer`, `/requires/id` |
| parseStackExperiment / prepareStackSnapshot | unknown→실험/소유 snapshot. `/nodes/A/instances/0/definition`, `/bindings/0/provider/portId`, `/scenario/inputs/0/target` |
| parseStackSnapshot | 정확한 v2/engine/random 계약만 수락. `/engineVersion`, `/configuration/...` |
| validateStackMessage / validateServicePayload | trusted parsed schema·실제 값·선택 maxBytes→소유 값/defaults/진단. `/values/payload`, `/fields/payload` |
| checkStackExpression / evaluateStackExpression | 표현식·trigger scope 또는 실제 값·선택 maxBytes→타입/소유 값/진단. `/value`, `/offset`, `/values/0` |
| StackPayloadStore | add/slice/read, setOwner/releaseOwner, appendTrace/capture/clearLive. 실패는 회계/기존 trace를 보존 |
| parseRunArtifacts / parseStackTrace | 해당 record의 실제 자료와 refs/order/size 검사. `/references/0`, `/artifacts/references/0`, `/0/sourceEventIds/0` |

파서 성공 자체는 호출자 원본의 소유권 이전이 아니다. 실행 시작은 `prepareStackSnapshot`, JSON snapshot 읽기는 `parseStackSnapshot`으로 독립 사본을 확보한다. 모델 fixture는 [stack-models.ts](../../tests/fixtures/stack-models.ts)이며 신뢰성 있는 provider 구현으로 표시하지 않는다. 실제 검증 명령과 결과는 실행 계획에 기록한다.
