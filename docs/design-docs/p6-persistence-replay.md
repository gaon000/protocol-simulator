# P6 로컬 저장·파일·과거 실행

상태: Accepted
기준일: 2026-10-30
구현 범위: 같은 브라우저 origin의 초안·실험 사본·실행 기록 저장, 자급적인 JSON bundle, 읽기 전용 기록 탐색과 명시적 snapshot 재실행. 서버 저장·계정·동기화·실제 통신은 포함하지 않는다.

## 저장 선택과 성공 경계

native IndexedDB를 사용한다. localStorage의 동기식 문자열 쓰기 대신 비동기 구조화 데이터와 원자적 readwrite transaction이 필요하고, 별도 라이브러리가 요구되지 않는다. 신규 production dependency는 없다. IndexedDB의 transaction 원자성은 [W3C IndexedDB](https://www.w3.org/TR/IndexedDB/)와 [MDN transaction](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction)을 기준으로 검토했다.

[저장 adapter](../../src/persistence/indexed-db.ts)는 database `protocol-studio` v1, object store `workspace`, key `current`에 전체 workspace envelope를 쓴다. 동일 transaction 안에서 기존 revision을 읽고 기대 revision과 비교한 후 증가시킨다. 다른 탭이 먼저 썼으면 conflict로 abort한다. put request의 success가 아니라 transaction complete 후에만 저장 성공을 반환한다. 실패·abort 시 마지막 commit은 유지한다. versionchange 때 연결을 닫고 blocked·unavailable·quota를 화면에 전달한다. 실제 API 사용은 [MDN 사용 안내](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB)를 참고했다.

[controller](../../src/application/workspace-controller.ts)는 불변 메모리 상태와 저장 serial/revision을 분리한다. UI는 편집 후 300ms debounce하며 저장 중 편집이 들어오면 commit 후 최신 serial을 이어 쓴다. 초기 읽기 실패나 알 수 없는 저장 형식은 기존 DB를 덮어쓰지 않는다. 오류가 나도 메모리 편집·파일 내보내기는 가능하다. 재시도는 DB를 다시 읽고 다른 revision이면 양쪽 변경을 사본으로 합친 뒤 CAS transaction으로 저장한다. 자동 충돌 덮어쓰기나 자동 항목 제거는 없다.

`저장됨`은 해당 transaction의 완료다. 즉시 앱/탭 종료 전 debounce 대기 중 변경의 저장이나 브라우저 데이터 삭제·eviction 이후 보존을 보장하지 않는다. 브라우저 quota는 환경에 따라 다르고 저장소는 기본적으로 best effort다([MDN quota·eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)). 필요할 때 `지금 저장` 후 상태를 확인하고 내보내기로 파일을 보관한다. 보존은 origin별이므로 개발/preview 주소·포트가 다르면 저장소도 다르다.

## 데이터와 초안

[workspace 모델](../../src/domain/workspace-model.ts)은 schemaVersion 1이며 최대 64 MiB, 초안 100개·기록 100개다. 초과하면 메모리 작업을 남기고 저장 실패를 표시한다. 필요한 항목을 내보내거나 삭제한 뒤 재시도한다. 엔진의 10,000 trace 이벤트·16 MiB trace 및 메시지/버퍼 1 MiB 상한은 별도다.

- DraftRecord: 안정적인 workspace ID, configuration, 미완성 JSON raw 텍스트, 편집 version, updatedAt.
- SavedRun: 기록 ID, 원래 실험의 workspace ID, 생성 시각·초안 version, snapshot을 포함한 EngineView 전체.
- envelope: 저장 revision과 WorkspaceData. bundle: kind `protocol-studio-bundle`과 WorkspaceData. 모두 schemaVersion을 가진다.

실험/기록 키는 UUID이며 configuration.id나 프로토콜·필드·규칙 ID와 분리한다. 선언 ID는 각 configuration 안에서 해석한다. 초기 example 사본·새 실험은 `내 실험`에 추가하고 기존 초안을 남긴다. activeDraftId도 저장한다. 실행 큐·브라우저 callback은 저장하지 않는다.

[초안 검사](../../src/domain/model-validation.ts)는 편집 가능한 구조·JSON 타입을 요구하되 빈 이름·잘못된 범위·dangling reference 등 의미 오류를 허용한다. 실행 전에는 기존의 엄격한 전체 검사를 한다. 문법이 미완성인 JSON은 마지막 유효한 유한 JSON 모델과 raw를 따로 보존하며 reload 후에도 오류·텍스트를 복원한다. raw는 알려진 JSON 편집 경로에만 허용하고 유효한 raw 값은 모델과 일치해야 한다.

현재 참여자가 참조 중인 정확한 프로토콜 ID/revision은 삭제를 막고 참조 변경을 안내한다. 마지막 정의도 편집을 위해 유지한다. 사용하지 않는 정의·전체 초안을 삭제해도 과거 기록은 별도로 보존하며 snapshot은 현재 정의를 다시 조회하지 않는다.

## 파일 검증과 충돌

[workspace 검증기](../../src/domain/workspace-validation.ts)는 크기 → JSON → 버전/구조 → 초안·raw → 실행 snapshot/참조/상한 → 기록의 상태·타이머·바이트·메시지·인과 ID·sequence·기대 결과 순으로 검사한다. 실행 snapshot은 초안과 달리 유효한 실행 정의여야 한다. 미완료 관찰의 기대 조건이 pass/fail로 위장된 파일도 거부한다. 알 수 없는 구조/추가 필드·버전·손상·용량 초과는 기존 작업에 적용하지 않는다.

전체 검증 후 [merge](../../src/application/workspace-operations.ts)한다. workspace 실험/기록 ID가 충돌하면 새 키로 사본을 만들고 새 사본의 부모 참조를 맞춘다. 내부 선언 ID와 과거 snapshot·runId·eventId는 바꾸지 않는다. 원본 초안이 삭제된 orphan 기록도 자기 snapshot으로 유효하다. 합친 결과의 개수·용량도 적용 전에 검사한다. 저장 중 live run을 취소할 때 생기는 최종 checkpoint까지 유지한 후 import를 합친다.

내보내기는 출처 origin·invalid draft·raw·모든 과거 snapshot/결과를 포함한다. 파일은 현재 메모리를 반영하므로 DB 저장 실패 시에도 구조/용량 한도 내에서 복구 수단으로 사용할 수 있다. migration은 아직 없다. 알 수 없는 schema는 거부하고 기존 데이터를 보존한다.

## 기록 탐색과 새 실행

시작·단계·일시 정지·종료에서 같은 기록 ID의 checkpoint를 갱신한다. 애니메이션의 매 batch마다 쓰지 않는다. 재시작 이후에는 저장된 checkpoint를 열며 멈췄던 큐를 이어 실행하지 않는다. 새로 실행하면 새 기록 ID를 만든다. 기록 삭제는 명시적인 사용자 작업이며 계속된 callback으로 다시 생성되지 않게 session을 정리한다.

[읽기 전용 projection](../../src/application/replay-record.ts)은 위치 0의 초기 상태, 선택 이벤트까지의 기록된 전이/타이머, 마지막 저장 시점의 원래 상태·판정을 보여준다. event 위치 이동·자동 재생·원인 이벤트 선택은 live engine을 실행하지 않는다. 중간 위치 판정은 미판정으로 표시하고, 마지막 저장 시점에서만 당시 판정을 표시한다. 각 동작 중간의 queue 전체를 복원하는 디버거는 아니다.

`이 snapshot으로 재실행`은 저장된 configuration·seed·engine/random version·limits로 새 session을 만든다. 현재 초안이 invalid이거나 원본이 없어도 가능하다. 현재 초안·이전 기록은 보존한다. `이 설정을 새 초안으로`는 별도 복원 사본을 만든다. 전체 관찰은 임의 runId를 제외한 이벤트·최종 상태·진단·판정을 비교하고, 부분 checkpoint는 저장 구간의 이벤트 접두부를 비교한다. 다른 결과도 원래 기록을 덮어쓰지 않는다.

P6는 실행 의미를 변경하지 않아 engineVersion은 `0.1.0-p5`를 유지한다. 다른 engine/random version의 기록은 구조가 유효하면 조회할 수 있지만 재실행은 이유와 함께 막는다. 버전이 다른 엔진의 의미적 동일성을 가정하지 않는다.

## 검증 경계

실제 명령·결과는 [구현 계획](../exec-plans/completed/20261030-1641-layered-protocol-v1.md)의 P6 검증 기록을 따른다. Node에서 모델·파일·동시 저장 controller·snapshot 재실행을, 실제 Chromium IndexedDB에서 reload·quota·request 성공 뒤 transaction abort·다른 탭 CAS 충돌을 검사한다. 실패 주입은 테스트에서 native API를 감싼 것으로 실제 디스크 고장/전원 장애나 OS fsync 검증은 아니다. 최종 브라우저 지원·대형 fixture 응답성·원격 CI는 P7 범위다.
