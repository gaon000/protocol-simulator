# 두 실행 결과 나란히 비교

상태: Completed
종료일: 2026-11-05

[ExecPlan 운영 규칙](../index.md)을 따른다.

## Purpose / Big Picture

저장된 두 실행을 골라 당시 설정·결과와 참여자 상태/변수·기대 조건·시간순 관찰 차이를 나란히 살펴보고 각 기록의 실제 위치를 재생한다. 수정 전후 또는 환경/seed 차이를 구분하며 관찰 비교를 자동 회귀/원인 증명으로 표현하지 않는다.

## Progress

- [x] clean master 020103d·기록/회귀 표·snapshot/재생 계약 확인, feature branch 생성.
- [x] 유한 값 비교·설정/결과와 순서 보존 trace 정렬 코어 및 실제 엔진 검사 14개 통과. 최종 Node 전체 344개 통과.
- [x] 실행 비교 화면·첫 차이/필터/페이지·개별 재생·회귀 사례 진입과 변수 페이지/동일 기록·history 진입 포함 새 Chromium/Firefox 18개 통과.
- [x] 제품/구조 문서·전체/대형 응답성 검사·완료 기록과 Git 전달 준비. 최종 `pnpm check`: Node 344·문서 39·Chromium/Firefox 244·응답성 5개 통과.

## Surprises & Discoveries

- runId/eventId/sequence·직접 원인 ID는 실행마다 달라질 수 있다. 내용 비교는 실제 의미 데이터로 수행하며 서로 다른 실행의 ID를 같은 인과관계로 간주하지 않는다.
- history의 저장 시점은 events.length+1, 초기 상태는 0, 개별 이벤트 직후는 sequence+1이다. 비교는 전체 저장 기록을 사용하며 개별 재생은 기존 prefix 경계를 따른다.
- 첫 코어 검사에서 ruleId가 action·timer 기록에도 붙는 것을 재확인했다. 완료 전이 검사는 kind=transition을 명시하도록 fixture assertion을 수정했다. 실제 cursor를 조회해 0/1 retries와 Done을 대조했다.
- 첫 브라우저 검사 16개 중 모바일 2개가 실패했다. 중첩 grid의 최소 폭이 680px 표를 따라 늘어났으므로 minmax(0,1fr)/min-width:0을 적용했다. 같은 두 브라우저에서 390px 문서 폭과 내부 스크롤이 통과했다.
- 선택 행을 해당 페이지와 내부/문서 viewport에 드러내고 반복된 첫 차이 요청도 다시 이동한다. 비교 화면에는 현재 초안의 출처/서비스/단일 이벤트를 붙이지 않고 두 기록에 전체 폭을 사용한다.
- untrusted 환경 이벤트의 operation은 임의 JSON일 수 있다. 대상 key를 문자열/합계 1024자로 제한해 중첩 payload를 직렬화하지 않는다. 한도를 넘으면 저장 요약만 제공한다.
- 기존 Vite 단일 bundle의 500 kB advisory는 유지된다(JS 약 551 kB, gzip 약 164 kB). dependency나 경고/응답성 임계값을 변경하지 않았다.

## Decision Log

- 2026-11-05: 저장된 두 record의 frozen snapshot만 사용한다. 새 실행 비교 보기와 회귀 사례 쌍 진입을 제공하고 비교 선택은 탭 메모리로 유지한다. 원본/판정·저장/엔진 버전과 dependency는 유지한다.
- 2026-11-05: 설정 차이를 먼저 표시하고 결과·참여자별 stable 변수 ID·기대 ID의 정의와 저장 판정을 분리한다. 다른 프로토콜 ID 또는 지원하지 않는 버전은 trace 대응을 제공하지 않는다.
- 2026-11-05: trace는 참여자·종류·대상 ID 기준 최대 32개 앞보기로 순서를 보존해 정렬한다. 내용/시간·한쪽 관찰·비교 한도를 구분한다. 반복된 이벤트 대응은 원인/동일 회차 증명이 아니며 정확한 최장 공통 경로를 약속하지 않는다. 누락·순서 교환도 원본 순서와 개수를 보존한다.
- 2026-11-05: 각 실행 최대 10000이벤트·유한 JSON 비교/깊이·20행 페이지와 제한된 미리보기를 사용한다. 큰 payload가 한도를 넘으면 동일로 추정하지 않는다. 첫 차이는 비교 한도 앞에서는 확정하지 않는다.

## Outcomes & Retrospective

독립적인 실행 비교 보기에서 당시 설정·결과·A/B 상태/변수·기대 조건/저장 판정과 순서 보존 관찰을 좌우로 비교한다. 첫 차이·한쪽 관찰·비교 한도·페이지/필터와 선택 쪽의 실제 기록 재생/설명을 연결했다. 회귀 사례 쌍과 개별 history 진입·좌우 교환·동일 기록·삭제 후 재선택을 지원한다. 원본/초안·실행 판정과 저장/엔진 버전은 유지했다.

Node 24.18.0 / pnpm 9.15.0의 최종 `pnpm check`에서 Node 344개·문서 39개·Chromium/Firefox E2E 244개·응답성 5개가 통과했다. 초기 코어 assertion/모바일 폭 수정 이후 같은 기준으로 확인했으며 마지막 대상 ID 한도·실제 viewport 선택·변수 페이지를 포함해 전체 검사를 다시 통과했다. 390px/desktop screenshot에서 내부 표 스크롤·좌우 열·범례/버튼 줄바꿈을 확인했다.

최종 1-worker Chromium 측정은 두 10k 기록(20000이벤트, 약 4.83 MB bundle)의 열기 78.2ms·선택 24.5ms·페이지 36.6ms·DOM 3537자, 두 1 MiB 기록(약 24.1 MB bundle)의 열기 41.2ms·선택 34.1ms·DOM 4919자다. 각각 500ms/32768자 기준을 통과했다. 기존 10k/1 MiB 실행과 20사례/200k coverage 상한도 유지했다. 로컬 수치는 다른 기기의 보증이 아니며 Git/원격 CI 전달은 별도로 보고한다.

관찰 정렬은 유한한 가까운 대상 대응이며 반복된 회차의 동일 인과관계·최장 공통 경로를 증명하지 않는다. 큰 내용/예산 한도는 동일로 추정하지 않고 표시한다. 실제 네트워크/배포는 범위 밖이다.

## Context and Orientation

`SavedRun`의 snapshot/view가 원본이다. 새 application projector와 React 화면을 추가한다. App이 pair 선택·보기·기존 selectHistory cursor를 연결하고 ScenarioSuitePanel의 비교/기준 record를 재사용한다. 기존 단일 실행 설명/메시지/그림을 재생에서 사용한다.

## Plan of Work

1. 설정·결과·변수/기대 조건과 관찰 차이 모델, 유한 비교와 정렬을 구현한다.
2. 저장 기록 선택·나란한 요약/행·차이 필터·첫 차이/페이지·재생을 연결한다.
3. 실제 정상/손실/중복·지연·프로토콜 변경·부분·재정렬·구버전·큰 값/10k·native 복원·390px/키보드를 검사한다.
4. 기존 응답성 3개와 새 두 실행 비교 fixture를 포함한 전체 검증·문서·Git/원격 CI를 마무리한다.

## Validation and Acceptance

Node 24.18.0/pnpm 9.15.0. `pnpm check`와 `git diff --check`, Chromium/Firefox, 390px screenshot을 확인한다. 실제 두 10k 기록과 1 MiB payload의 열기/페이지·선택 500ms·유한 DOM을 별도 1-worker로 검사하며 기존 임계값은 완화하지 않는다.

## Idempotence and Recovery

원본 record를 수정하거나 재실행하지 않는다. 선택 기록이 삭제/교체되면 다른 기록으로 암묵 대체하지 않고 재선택을 요청한다. 같은 기록 양쪽 비교도 허용한다. history 재생은 현재 실행을 안전하게 정지하고 당시 기록 prefix를 사용한다.

## Artifacts and Notes

현재 계약은 [제품 명세](../../product-specs/protocol-simulator-v1.md)에 기록한다. 완료 때 검사 결과와 한계를 갱신한다.

## Interfaces and Dependencies

새 application/UI와 App pair state·suite/history 비교 callback. engine·저장 schema·production dependency 변경 없음.
