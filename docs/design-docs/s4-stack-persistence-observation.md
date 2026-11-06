# S4 스택 저장·재생·관찰 API

상태: Accepted
기준일: 2026-11-06
구현 범위: [S3](s3-reliable-stream-lite.md)의 실제 stack view/trace/artifacts를 보존하는 v2 저장·복구·관찰 API. [전체 설계](layered-stack-v2.md)와 [단계별 계획](../exec-plans/completed/20261106-layered-protocol-stacks.md)을 따른다. S4 단계에서 보류한 사용자 화면·기본 DB 전환과 정량 실측은 [S5](s5-stack-workspace.md)에서 완료했다.

## 저장 형식과 소유권

[workspace-v2-model.ts](../../src/domain/workspace-v2-model.ts)의 WorkspaceV2는 schemaVersion 2, mode workspace, legacy(v1 WorkspaceData 전체), stack(activeDraftId 또는 null, drafts, runs)으로 구성한다. envelope는 schemaVersion/revision/data, bundle은 schemaVersion/kind/data다. kind는 기존 protocol-studio-bundle이다. 두 영역을 합쳐 초안/기록 각각 100개·workspace/bundle 64 MiB 한도를 적용한다. legacy 항목을 네 인스턴스 실행으로 변환하지 않는다.

StackDraft는 mode stack, 독립 id, configuration 전체, raw 편집 문자열, version/updatedAt, optional suite를 갖는다. 구조 검사와 실행 검사를 분리해 아직 연결되지 않은 포트·정의/규칙 참조·불완전한 JSON 편집을 보관한다. 정상 형태의 유효한 raw JSON은 configuration의 해당 값과 같아야 하며, raw는 실제 JSON Pointer를 가리킨다. [S5](s5-stack-workspace.md)는 문법이 맞아도 필수 구조가 깨진 입력을 적용하지 않고 raw에 보관하며 실행을 차단한다. 실행은 완전한 모델 검사와 raw 대조를 다시 통과해야 한다.

SavedStackRun은 mode stack, id/experimentId/createdAt/draftVersion과 **실제 StackView 전체**를 담는다. snapshot·네 인스턴스·trace·record-local artifacts·상태/판정을 함께 capture한다. 취소/reset·초안 삭제 뒤에도 실제 payload를 유지한다. snapshot에 없는 bytes를 재생성하지 않는다.

[검사](../../src/domain/workspace-v2-validation.ts)와 [기록 reader](../../src/domain/stack-record.ts)는 JSON/버전·정의 revision·endpoint/port/route·event 순서/직접 trigger·상태/변수 연속성·실제 메시지/typed byte 범위·이전 source 범위·최종 상태·판정·series 공통 source/소유권을 staging 검사한다. byte-like 사용자 JSON은 선언된 bytes와 구분한다. dense 10000-event 기록의 node 예산은 직렬화 바이트 상한에서 유도하며 기존 16 MiB trace/artifact와 8 MiB payload 상한은 유지한다.

unknown engine/random 버전은 알려진 v2 저장 구조의 요약·원본/내보내기를 보존한다. 실행·재생 계산·설명·중단점·커버리지·관찰 대응은 unavailable로 차단한다. unknown schema/adapter 버전은 임의 변환하지 않는다.

## IndexedDB 전환과 복구

[indexed-db-v2.ts](../../src/persistence/indexed-db-v2.ts)의 createIndexedDbV2Storage는 DB protocol-studio **version 2**를 명시적으로 연다.

| 영역 | 실제 책임 |
| --- | --- |
| workspace/current | upgrade 이전 v1 envelope 원본. upgrade 후 새 adapter가 쓰지 않는 복구 보관본 |
| workspace-v2/current | 유일한 canonical v2 envelope와 공유 revision CAS |

upgrade transaction에서 v1 envelope를 검사하고 revision/legacy 내용 그대로 v2에 담는다. 검증·put·quota·transaction abort는 갱신 전체를 취소하며 이전 버전과 원본 store를 보존한다. 비어 있던 새 DB에는 보관할 원본이 없고 첫 canonical write가 별도 CAS transaction에서 반영된다. write 성공은 transaction complete 뒤에만 반환한다.

blocked는 실패를 안내하고 뒤늦게 풀리는 pending upgrade도 abort한다. 사용자의 명시적 재시도 없이 뒤에서 갱신하지 않는다. versionchange는 열린 연결을 닫는다. 갱신 뒤 v1의 open(name, 1)은 VersionError로 차단되며, 더 새로운 DB 버전에도 이 adapter가 쓰지 않는다. 두 탭 write는 같은 revision에서 하나만 반영한다. replaceLegacy도 같은 CAS/전체 검사 아래 stack 영역을 보존한다.

S4 구현 시점의 App은 기존 v1 adapter를 유지했다. 현재 [S5 진입](s5-stack-workspace.md)은 v2 controller와 저장 worker를 기본으로 사용한다. 이미 v2로 갱신한 DB를 이전 버전 앱에서 열면 기존 오류/메모리 보존 경로로 처리하며 조용히 새 v1 DB를 만들거나 자료를 삭제하지 않는다.

[workspace-v2-operations.ts](../../src/application/workspace-v2-operations.ts)의 exportWorkspaceV2는 전체 자료를 내보낸다. v1 내보내기는 stack 항목이 있을 때 명시적 legacy 선택을 요구한다. readLegacyBackup과 exportLegacyBackup은 보관한 v1 원본을 읽고 v1 bundle로 내보내며 DB downgrade/자동 삭제를 수행하지 않는다.

import/충돌 복구는 parent/draft/run/suite/series의 workspace 소유 ID만 새 사본으로 remap한다. 실제 정의/endpoint·snapshot/event/payload 참조는 각 record 안에서 유지한다. 동일한 고아 기록의 retry는 중복 사본을 만들지 않는다. [v2 controller](../../src/application/workspace-v2-controller.ts)는 불변 메모리·직렬 save·in-flight 변경·CAS/용량 실패·원본 읽기 실패와 명시적 retry를 관리한다.

## 재생과 관찰 API

[stack-replay.ts](../../src/application/stack-replay.ts)의 readStackRecord는 외부 입력을 검사하고 owned immutable 기록만 캐시한다. projectStackRecord의 cursor는 0=초기, 1~n=해당 이벤트까지의 접두부, n+1=저장 시점이다. 중간 cursor는 네 인스턴스의 관찰된 상태/변수·timer generation·포트 상태, 해당 접두부 events/artifacts만 반환하며 최종 판정을 undetermined로 표시한다. 관찰되지 않은 queue/live 사용량은 중간 재생에서 복원했다고 주장하지 않는다.

| API | 실제 경계 |
| --- | --- |
| buildStackStateDiagram | endpoint의 frozen 정의와 현재 관찰 상태. 기존 유한 그래프 배치 재사용 |
| buildStackSequence | 서비스 요청/수락/수신·wire/codec·commit을 구분. 전체/endpoint/layer 필터, 30행과 원본 cursor |
| stackEventLinks / stackRuleOccurrences | 직접 source와 관찰된 후속 commit·endpoint별 회차. 256-event 인과 탐색·20행, 한도 표시 |
| buildStackMessageStructure | 해당 이벤트의 실제 범위와 256-byte 창, 20개 필드. 논리 packet/수신 chunk/parsed 구분. 실제 legacy HTTP/JSON 송신만 기존 byte 구획 분석, 분석 상한 64 KiB |
| explainStackExecution | 직접 trigger·before 값의 조건/단락·순차 대입을 재구성해 실제 commit 및 runtime prepare와 대조. verified/limited/inconsistent/unavailable, 1024연산·32 Ki 문자·32깊이·20행 |
| diagnoseStackExpectation | 당시 기대/판정과 현재 실제 관찰 대조. 직접 근거/조상과 참고 환경/타이머 구분, 256 탐색·20행. 부분 관찰에서 실패 원인을 확정하지 않음 |

해당 구현은 [그림/구조](../../src/application/stack-diagrams.ts)·[설명](../../src/application/stack-explanation.ts)·[진단](../../src/application/stack-diagnostics.ts)이다. current draft나 다른 실행의 ID로 재생 원인/byte를 보충하지 않는다.

## 중단점·반복/회귀·커버리지·비교

[stack-breakpoints.ts](../../src/application/stack-breakpoints.ts)는 snapshot/endpoint/정의 revision에 탭별 최대 20개를 compile한다. state 진입·실제 parsed 메시지·transition.after 변수만 평가한다. 값은 1024node·8192문자·16깊이이며 bytes는 실제 값으로 읽는다. runtime 값/reader 오류는 debugger evaluation-error이며 엔진 실패로 만들지 않는다. live는 queue operation의 전체 commit 뒤 첫 관찰과 trailingEvents를 반환하고, history는 제공한 한 이벤트만 평가한다. 계속 실행은 이전 이벤트를 다시 평가하지 않으며 빈 plan은 observer 없이 진행한다.

[stack-series.ts](../../src/application/stack-series.ts)는 모든 정의·nodes/bindings/link endpoint·limits를 공통 source로 고정한다. batch는 환경 조합마다 같은 seed 목록을 사용하며 총 100회 이하, regression은 활성 사례 20개 이하다. 시나리오/환경/seed는 실제 case condition으로 보존한다. 저장된 series는 kind/id/label·manifest/index·source/condition과 회귀 suite id/revision을 갖는다. 64작업 slice·취소 fence·이미 완료한 회차와 취소한 부분 기록·미실행을 구분한다.

[stack-coverage.ts](../../src/application/stack-coverage.ts)는 한 regression group의 공통 source/manifest/suite·owner와 유효한 기록만 포함한다. endpoint별 초기/실제 committed 전이와 사례 첫 cursor를 집계하며 부분/누락/제외·미관찰을 구분하고 20행씩 반환한다. 회귀 판정 변화는 같은 suite/case·실제 조건·engine/random/limits에서만 new-failure/improved를 판정한다.

[stack-comparison.ts](../../src/application/stack-comparison.ts)는 frozen 두 실행의 설정/인스턴스/판정과 stable endpoint의 관찰을 나란히 비교한다. 동일 토폴로지/지원 버전만 16개 lookahead의 순서 보존 대응을 수행하며 각 쪽의 실제 cursor를 제공한다. 행 2000개·실제 bytes 512 KiB·10000 event 계산·설정 256 Ki 문자/일반 값 32 Ki 문자 한도를 적용하며 limited와 부분 관찰을 same으로 바꾸지 않는다. [semantic 변환](../../src/application/stack-semantic-event.ts)은 schema 소유 range/source만 비교하고 사용자 JSON의 payloadId/sourceEventId를 지우지 않는다. 같은 bytes라도 원본 source 안의 상대 위치가 다르면 다른 관찰이다. 가능한 source 창을 모두 유지하고 event당 source 범위 4096개 계산 한도를 표시하며, 하나를 추정해 고르거나 같은 ID를 실행 사이 공유 원인으로 해석하지 않는다.

compareStackReplay는 같은 snapshot에서 실제 접두부/전체 기록·상태/판정을 대조한다. 부분 실행/취소는 접두부, limit-reached/engine-error는 terminal 결과를 대조하며 byte 계산 32 MiB/event 20000개 한도에서는 limited다. engine 생성은 기존 createStackSimulationFromSnapshot의 정확한 실행 버전 검사를 통과해야 한다. 기록/자료를 지우거나 실시간 엔진을 다시 시작하지 않고 당시 record를 보존한다.

## 검증 경계

Node는 실제 다섯 예제·부분/실패/동시 source·미완성 저장·변조/unknown 버전·serial/CAS·byte-like JSON·10k 기록과 각 도구/회귀의 endpoint/prefix/한도를 검사한다. [native 브라우저 검사](../../tests/stack-e2e/persistence-v2.test.ts)는 Chromium/Firefox에서 upgrade 성공/invalid/quota/abort/blocked·실제 versionchange·구형 writer·두 탭 CAS·오류 복구·cancelled artifacts와 실제 1 MiB 프레임의 저장/새로고침 복원을 검사한다. quota/abort는 native API를 감싸 주입하며 실제 저장장치 고장/실제 여유 공간 소진의 증거가 아니다.

pnpm test:stack:e2e는 전용 Vite 개발 서버 4174에서 실제 TS 저장/관찰 모듈을 검사한다. 이는 사용자 스택 화면 E2E나 대형 스택 UI 성능 검증이 아니다. 기존 v1 빌드 E2E·응답성 상한은 그대로 유지하며, 전체 명령·실제 결과는 구현 계획에 기록한다. S5 전에는 새 형식을 기존 App/도구에 임의 주입하지 않는다.
