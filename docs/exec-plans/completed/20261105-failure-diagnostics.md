# 실패 원인 진단과 관련 기록 이동

상태: Completed
종료일: 2026-11-05

[ExecPlan 운영 규칙](../index.md)을 따른다.

## Purpose / Big Picture

실패한 기대 조건의 기대값·실제값·관찰 근거를 확인하고 관련 기록에서 기존 시퀀스·상태도·실행 이유 설명으로 이동한다. 기록으로 확인한 직접 인과관계와 같은 실행의 참고 관찰을 구분한다. 미완료·오류·기록 부족을 실패 원인으로 단정하지 않는다.

## Progress

- [x] clean master와 기대 조건 판정·snapshot·history prefix 계약 확인, feature branch 생성.
- [x] DOM 없는 진단 projection과 근거 탐색·한도·코어 10개, 기존 설명 포함 23개 통과. 전체 Node 294개 통과.
- [x] 기대 조건 선택·근거 이동·그림/설명 연동과 새 Chromium/Firefox 12개, 기존 설명 포함 26개 통과. 390px screenshot에서 줄바꿈/유한 페이지 확인.
- [x] 제품/구조 문서·전체 검증·완료 기록과 Git 전달 준비. `pnpm check`: Node 294·문서 35·Chromium/Firefox E2E 182·응답성 2개 통과.

## Surprises & Discoveries

- 엔진은 네 종류의 기대 조건을 판정하지만 detail은 일반 문구다. 상위 전달 배열은 EngineView에 없으므로 완료한 실행의 deliver trace로 재구성하고 저장 판정과 대조한다.
- history cursor 이전에서는 기대 조건이 미판정이며 당시 prefix의 참여자 상태와 이벤트만 제공한다. 최종 실행을 우회 조회하지 않는다.
- 첫 코어 검사에서 projectRecord.events가 전체 원본 배열을 유지한다는 점을 확인했다. 기존 그림처럼 명시적인 eventCount를 전달하고, 잘린 prefix의 상태/최초 종료/판정도 재구성해 미래 관찰을 제외했다. 해당 경계 검사를 보강한 뒤 통과했다.
- 타이머 만료에는 직접 cause ID가 없다. 손실→타이머 만료를 단일 확정 원인 사슬로 만들지 않고, 직접 연결과 참고 관찰을 구분한다.

## Decision Log

- 2026-11-05: 기존 snapshot/trace에서 읽기 전용으로 진단한다. engine/trace/storage 버전과 판정 자체는 변경하지 않으며 신규 dependency가 없다.
- 2026-11-05: 상태·전달 횟수·전달 값·성공 완료 기한의 기대/관찰을 표시하고 저장 판정과 재구성이 다르면 기록 불일치로 표시한다. 미완료/오류·지원하지 않는 버전·계산 상한/근거 부족을 명시한다.
- 2026-11-05: 패널을 명시적으로 열 때 계산하고 선택한 조건만 자세히 표시한다. 근거는 유한 페이지로 탐색하며 값은 유한 미리보기다. 관련 기록 이동은 자동 진행을 멈추고 공유 선택·시퀀스·기존 설명으로 연결한다.
- 2026-11-05: 유한 탐색은 10k 이벤트·값 4096 node/32768 character/깊이 32·연결 기록 64개·페이지 20개다. 상세 값은 기존 이벤트 inspector로 이동한다. 기존 10k/1 MiB fixture에 열린 진단의 500ms/32768자 검사를 추가하며 기존 수치 기준을 완화하지 않는다.

## Outcomes & Retrospective

네 기대 조건의 기대/관찰·저장 판정 대조, 직접 연결/타이머 수명·참고 관찰 분리와 기존 시퀀스/관찰된 규칙 설명 이동을 구현했다. 과거 cursor·초안 격리·미판정/지원 버전·기록 모순·계산 상한을 보존한다. engine/trace/storage 형식과 dependency는 변경하지 않았다.

최종 로컬 `pnpm check`의 Node 294개·문서 35개·Chromium/Firefox E2E 182개·응답성 2개가 통과했다. 390px screenshot에서 근거 버튼의 줄바꿈·20개 페이지와 내부 배치를 확인했다. 로컬·원격 CI와 실제 네트워크 검증은 구분한다. 원격 전달 상태는 실제 push/CI 결과로 보고한다.

전체 검사 후 완료 시각이 없는 경우와 초기 상태가 이미 terminal인 경우의 코어 assertion을 보강하고 관련 10개·타입 검사를 다시 통과했다. 실행 source는 추가 변경하지 않았다.

## Context and Orientation

`simulation.expectations()`가 네 기대 조건의 authoritative 판정을 소유한다. `projectRecord`가 과거 prefix를 투영한다. App의 공유 선택은 기존 `diagram-links`, 시퀀스·상태도·`ExecutionExplanation`을 연결한다. 새 application projection과 UI는 이 데이터를 읽기만 한다.

## Plan of Work

1. 기대/관찰 요약과 저장 판정 대조, 조건별 근거·진단·환경 관찰 및 직접 cause 탐색을 구현한다.
2. 기대 조건 결과에서 진단을 열고 관련 이벤트를 선택·설명으로 이동하게 연결한다. 과거/반복/회귀 기록도 동일하게 사용한다.
3. 실제 엔진 fixture·prefix·큰 값·없는/모순된 기록과 실제 브라우저의 실패→진단→근거 이동·새로고침·390px·키보드를 검증한다.
4. 기존 `pnpm check`와 10k/1 MiB 상한을 유지해 회귀 검사하고 문서를 완료한다.

## Validation and Acceptance

Node 24.18.0 / pnpm 9.15.0. 코어 단위/통합·Chromium/Firefox E2E·응답성·문서·lint/format/type/build, `git diff --check`를 수행한다. 원격 CI는 push한 commit으로 확인한다.

최종 macOS 로컬 Chromium 156.0.8078.4 / CPU rate 1 결과: 10k 실행 3459ms·제어 59ms·연동 74ms·설명 58ms·진단 67ms/1790자·저장 69ms·cursor 119ms·frame p95 16.8ms·최대 long task 0ms. 1 MiB 실행 358ms·제어 34ms·연동 48ms·설명 59ms·진단 70ms/307자·저장 289ms·cursor 63ms·frame p95 16.8ms·최대 long task 124ms. 기존 fixture와 입력/실행/저장/프레임 상한은 변경하지 않았다. 실제 서버/기기·네트워크 성능·배포는 범위 밖이다.

## Idempotence and Recovery

진단/선택은 실행·초안·저장 기록을 수정하거나 재실행하지 않는다. 과거 cursor/실행 교체 시 선택을 현재 context 안에서만 사용한다. 기존 저장/복구 계약을 유지한다.

## Artifacts and Notes

현재 제품 계약은 [제품 명세](../../product-specs/protocol-simulator-v1.md)에 갱신한다. 실제 검사 결과와 발견한 한계는 이 계획에 기록한다.

## Interfaces and Dependencies

새 application 진단 API와 UI만 추가한다. 기존 기대 조건 판정·snapshot·workspace 형식·실제 통신 모델·production dependency는 변경하지 않는다.
