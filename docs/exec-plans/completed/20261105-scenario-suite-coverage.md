# 시나리오 묶음 검증 커버리지

상태: Completed
종료일: 2026-11-05

[ExecPlan 운영 규칙](../index.md)을 따른다.

## Purpose / Big Picture

선택한 검증 실행 묶음에서 참여자별 방문 상태·실행 규칙·관찰 횟수를 집계한다. 당시 상태도에 관찰/미관찰과 평행 규칙의 부분 관찰을 표시하고, 항목에서 실행한 사례의 첫 관찰 위치로 이동한다. 미관찰은 오류/도달 불가 판정과 구분한다.

## Progress

- [x] clean master와 suite manifest·frozen 공통 정의·상태도/기록 재생 확인, feature branch 생성.
- [x] 공통 기준/trace 검증·관찰 집계와 코어 검사(추가 12개, 전체 Node 330개 통과).
- [x] 상태도/목록·필터/페이지·사례별 첫 관찰 재생과 새 Chromium/Firefox 14개 통과. 초기 cursor의 목록 검사를 실제 탐색 계약에 맞춰 보강.
- [x] 제품/구조 문서·전체/응답성 검사·완료 기록과 Git 전달 준비. `pnpm check`: Node 330·문서 38·Chromium/Firefox E2E 226·응답성 3개 통과. 최종 오류 표시 보강 뒤 관련 Node 12개와 lint/format/type 재확인.

## Surprises & Discoveries

- 한 묶음은 사례별 scenario/environment/seed가 다르고 공통 정의/actor ref·엔진 계약은 같아야 한다. 여러 실행 묶음을 암묵적으로 합치지 않는다.
- trace에 commit이 없을 수 있는 한도/오류 기록은 최종 참여자 값으로 전이를 추정하지 않는다. 상태 관찰 횟수는 생성된 사례마다 초기 상태 1회와 각 실제 transition.after 1회(자기 전이 포함)로 정의한다.
- 그림은 평행 규칙을 한 화살표로 묶는다. 일부 규칙만 관찰된 화살표는 전체 관찰과 구분하고 개별 규칙 목록/횟수를 유지한다.
- maxEvents=2의 실제 Ping/Pong 실행은 A 상태가 Waiting이지만 transition은 아직 기록되지 않는다. 초기 Idle만 관찰로 집계하는 것을 확인했다. maxEvents=1이면 아직 Idle이다.
- 초기 테스트 fixture의 빈 기대 조건·음수 literal·무조건/조건 평행 규칙·명시하지 않은 ignore는 기존 모델 검증이 거부했다. 유효한 기대·계산식·서로 다른 조건·explicit ignore로 고쳐 실제 엔진을 사용했다.
- 브라우저 select는 option 텍스트를 포함하는 label 전체 일치 대신 정확한 accessible combobox 이름으로 선택한다. history의 전체 이벤트 목록은 이동용으로 유지되며 초기 cursor에서 선택·상태도/시퀀스 관찰이 없는지를 검사한다.
- 실제 A 오류/B timer loop의 10k 한도 기록으로 부분 관찰과 참여자 오류가 함께 표시되는 것을 보강했다. 초기/rollback 관찰만 포함하는 경계는 유지한다.
- 상태도의 관찰 색이 선택 테두리/종료 이중 테두리를 가리지 않도록 CSS 범위를 한정했다. 커버리지에는 실행 위치/최근 적용 범례를 표시하지 않는다.
- 기존 단일 bundle의 Vite 500 kB advisory는 유지된다(JS 약 533 kB, gzip 약 160 kB). 임계값이나 dependency를 변경하지 않았다.

## Decision Log

- 2026-11-05: 선택한 current regression group의 frozen source만 사용하며 A/B를 분리한다. 선언한 actor별 상태/규칙이 분모이고 사용하지 않는 definition은 포함하지 않는다. 조건 분기/전체 경로/도달 가능성은 판정하지 않는다.
- 2026-11-05: 부분 기록도 실제 관찰만 집계하며 완료/부분·미실행/삭제·제외 수를 함께 표시한다. 공통 정의/metadata/엔진/manifest가 다르거나 중복 slot이면 집계 불가, trace가 모순인 사례는 제외하고 이유를 표시한다.
- 2026-11-05: read-only projection과 lazy panel을 추가하고 기존 SVG 상태도를 coverage prop으로 꾸민다. 사례별 첫 관찰 위치(초기는 cursor 0)로 기존 history를 연다. 형식/engine/trace 버전·dependency·실행 판정은 변경하지 않는다.

## Outcomes & Retrospective

선택한 실행 묶음의 frozen 공통 정의로 A/B별 초기/실제 전이 관찰을 집계하고 상태도·미관찰 목록·사례별 첫 관찰 재생을 구현했다. 공통 기준 불일치는 집계를 거부하고 trace 모순은 사례 전체를 제외한다. 미관찰을 실패/도달 불가능 판정으로 바꾸지 않는다. 원본 저장/실행 의미·버전은 유지한다.

Node 24.18.0 / pnpm 9.15.0의 `pnpm check`에서 Node 330개·문서 38개·Chromium/Firefox E2E 226개·응답성 3개가 통과했다. 이후 부분 오류 표시 보강의 Node 12개와 lint/format/type도 통과했다. 390px screenshot에서 내부 스크롤·페이지/크기 조절·상태도 범례와 줄바꿈을 확인했다.

실제 20사례/200000 이벤트를 48,424,053-byte bundle로 가져와 native IndexedDB에 원본 200000개를 보존했다. 최종 1-worker Chromium 측정은 커버리지 열기 86.6ms, 선택 43.0ms, DOM 3094자로 500ms·32768자 기준을 통과했다. 첫 별도 측정은 114.6/45.6ms였다. 기존 10k/1 MiB fixture도 모든 입력/실행/저장/cursor/frame/longtask 상한을 유지했다. 로컬 측정은 다른 기기의 보증이 아니며 Git/원격 CI 전달 상태는 별도로 보고한다. 실제 통신/배포는 범위 밖이다.

## Context and Orientation

`ScenarioSuitePanel`이 비교할 실행 그룹을 선택하고 `SavedRun.regression`이 실행 당시 manifest/source를 보존한다. 새 application projector가 actor별 counts/사례 근거를 제공한다. `StateDiagram`의 기존 유한 SVG/선택/확대/페이지를 재사용하고 App.selectHistory의 optional cursor로 첫 관찰을 재생한다.

## Plan of Work

1. 묶음 공통 기준과 기록을 검사하고 초기/committed transition을 집계한다. 임의 값/bytes를 복사하지 않고 유한 범위를 유지한다.
2. 두 참여자의 비율·빈도·관찰/미관찰 상태도·항목 목록·관련 사례와 첫 관찰 재생을 연결한다.
3. 정상/손실/중복·부분/누락/버전/모순·자기/평행 전이·이전 snapshot·초기 cursor·native 저장·390px/키보드를 검사한다.
4. 기존 전체 검사와 20사례/200k trace의 커버리지 응답성을 검사하고 문서·Git/CI로 전달한다.

## Validation and Acceptance

Node 24.18.0 / pnpm 9.15.0. strict/lint/format/build·Node·실제 Chromium/Firefox·docs·git diff를 검사한다. 기존 10k/1 MiB 상한과 새 대형 묶음의 커버리지 열기/선택 500ms·유한 DOM을 검증한다. 실제 네트워크/배포는 범위 밖이다.

## Idempotence and Recovery

기존 저장 record/판정과 초안은 수정하지 않는다. 전체 기록을 삭제하면 당시 manifest/source도 없으므로 새 기준을 만들지 않는다. 선택 그룹/참여자 교체 시 항목 선택을 새 snapshot 안에서 해석한다. 재생은 기존 snapshot/prefix·읽기 전용 저장 정책을 따른다.

## Artifacts and Notes

현재 계약은 [제품 명세](../../product-specs/protocol-simulator-v1.md)에 갱신한다. 검사 결과·발견/한계는 이 계획에 기록한다.

## Interfaces and Dependencies

새 application/UI, SVG optional coverage와 history optional position만 추가한다. 저장/엔진·코덱·production dependency는 변경하지 않는다.
