# 시나리오 묶음과 회귀 검증

상태: Completed
종료일: 2026-11-05

[ExecPlan 운영 규칙](../index.md)을 따른다.

## Purpose / Big Picture

하나의 프로토콜 초안에 여러 입력·기대 조건·환경·seed 사례를 저장한다. 실행 시작 시 공통 프로토콜 버전과 활성 사례를 고정해 전체 검증하며 사례별 통과/실패/미판정/미실행을 표시한다. 두 실행의 동일한 사례 조건에서 새로 생긴 실패와 개선을 찾고, 기존 상태도·시퀀스·실행 설명으로 재생한다.

## Progress

- [x] 현재 실행·저장·편집 계약과 clean master 확인, feature branch 생성.
- [x] 사례 모델·편집/검증·유한 독립 실행·결과 비교와 저장 호환 구현. 관련 코어 11개와 기존 batch/저장 검사 통과.
- [x] 시나리오 묶음 화면·공유 폼·기록 재생과 새 브라우저 10개, 기존 반복 실험 포함 22개 통과.
- [x] 전체 검사·계약/완료 기록과 전달 준비. Node 284개·문서 34개·Chromium/Firefox E2E 170개·성능 2개 통과.

## Surprises & Discoveries

- 최초 새 E2E에서는 implicit label select의 옵션 텍스트 영향과 중단 시 첫 사례가 이미 완료될 수 있는 시간 가정이 드러났다. role/name selector와 충분한 대기 사례·종료 경계 검증으로 수정했다.
- 첫 전체 검사는 169개 통과 후 Firefox의 기존 99→100개 기록 검사에서 파일 가져오기/저장 상태 두 개를 하나로 선택해 실패했다. 저장 완료 문구를 명확히 기다리도록 바꾼 뒤 새/기존 기능 22개가 통과했다. 숫자 한도나 저장 결과 검증은 유지했다.
- 두 번째 전체 검사에서 기존 batch 중단 검사가 엔진 사이 중단을 cancelled로 가정해 실패했다. 완료한 limit-reached 기록과 취소 기록을 구분해 허용하고 미판정·대기 수·기록 불변 검증은 유지했다. 통신 환경 검사 한 건은 실행 중 첫 단계에서 5초 완료 대기가 초과되어 동일 테스트를 Chromium에서 3번 분리 실행해 모두 통과했으며 재현되지 않았다. 해당 timeout의 근본 원인은 확정하지 않았고, 같은 5초 기준의 최종 전체 검사에서 170개 모두 통과했다.
- 편집 시 readiness 검사와 실행 시작의 불변 snapshot 생성을 분리해 사본 생성은 시작할 때만 한다. 실행 시 긴 사례 입력 폼을 접어 결과를 표시한다.
- 기존 반복 실험은 하나의 시나리오/환경 조합을 독립 엔진으로 실행하며 64개 queue 작업마다 제어를 돌려준다. 공통 series로 추출해 회귀 검증도 같은 취소/기록/한도를 사용한다.
- 미완성 JSON은 유효한 마지막 값과 별도로 저장한다. 사례에도 raw를 보존하고 공통 정의의 미완성 값·활성 사례 오류는 실행을 막는다. 비활성 사례의 오류는 보존한다.

## Decision Log

- 2026-11-05: 초안당 묶음 하나, 최대 20사례. 사례는 scenario/environment/seed/raw만 보존하며 프로토콜은 공통 초안을 사용한다. 현재 설정 캡처·복제·수정·활성/비활성·삭제를 제공한다. 프로토콜과 사례의 revision은 구분한다.
- 2026-11-05: DraftRecord.suite와 SavedRun.regression은 optional 확장이며 이전 workspace는 migration 없이 읽는다. 실행 metadata에 사례 ID/이름 manifest를 담아 미실행·삭제/대상 제외를 구분한다. import/복구에서는 부모·묶음·실행 그룹 ID 충돌을 함께 분리한다.
- 2026-11-05: 같은 suite/case ID, scenario/environment/seed와 엔진/난수/limits가 같은 관찰만 회귀/개선으로 비교한다. 조건 변경·엔진 차이·미판정·미실행·비교 대상 없음은 별도 표시한다. 통과→실패는 새 실패, 실패→통과는 개선이다.
- 2026-11-05: 반복 실험/회귀 검증은 동시에 하나만 실행한다. 단일 실행·기록 선택·초안 교체/가져오기는 실행 묶음을 중단한다. 기록 100개·64 MiB 한도를 유지하고 자동 삭제/자동 재개하지 않는다. 신규 dependency와 엔진/trace 버전 변경은 없다.

## Outcomes & Retrospective

공통 프로토콜의 최대 20사례 작성·독립 실행·동일 조건의 새 실패/개선 비교와 과거 결과 재생을 구현했다. 기존 초안·기록의 읽기와 충돌 가져오기, 미완성 JSON 보존·실행 중단 경계를 유지했다. 신규 dependency와 실제 네트워크 연결은 추가하지 않았다.

Node 24.18.0 / pnpm 9.15.0의 최종 `pnpm check`에서 Node 284개·문서 34개·Chromium/Firefox E2E 170개·응답성 2개가 통과했다. 390px 화면과 키보드 조작·회귀 결과/기록 재생을 확인했다. 로컬 검증과 Git/원격 CI는 구분해 보고한다.

## Context and Orientation

`workspace-model/validation/operations`가 초안·bundle·병합을 소유한다. `ScenarioEditor`와 `EnvironmentEditor`는 EditorContext로 제어되므로 선택 사례의 scenario/environment/seed만 편집하도록 재사용한다. 공통 series와 기존 scheduler를 통해 독립 엔진을 실행하고 SavedRun의 snapshot을 기존 history/diagram/explanation에 연결한다.

## Plan of Work

1. 사례/실행 metadata와 엄격한 저장/불완전 초안 검증·충돌 병합을 추가한다.
2. 고정한 공통 정의로 사례들을 독립 실행하고 현재·기준 실행을 조건별로 비교한다.
3. 화면의 생성/복제/활성·기대 조건/환경 편집·전체 실행/중단·비교·재생을 연결한다.
4. 코어 계약·실제 브라우저/IndexedDB·390px·기존 응답성을 검사하고 문서를 갱신한다.

## Validation and Acceptance

Node 24.18.0 / pnpm 9.15.0. `pnpm check`, staging 포함 `git diff --check`. 독립 실행 일치·snapshot 격리·미판정·비교 gate·취소 fence·invalid/disabled/raw·저장/병합/용량과 브라우저의 수정 전후 회귀·재생·새로고침·키보드·390px를 확인한다. 기존 10k/1 MiB 수치 상한은 유지한다.

최종 로컬 응답성 결과(Chromium 156.0.8078.4, CPU rate 1): 10k 실행 3573ms·제어 80ms·그림 연동 129ms·설명 91ms·저장 90ms·cursor 145ms, frame p95 16.7ms·최대 long task 0ms. 1 MiB 실행 395ms·제어 56ms·그림 연동 56ms·설명 70ms·저장 541ms·cursor 92ms, frame p95 16.8ms·최대 long task 203ms. 기존 fixture·측정·상한을 변경하지 않았다. 실제 네트워크 성능과 배포는 검증 범위 밖이다.

## Idempotence and Recovery

기록은 기존 controller에 추가하고 시작한 실행만 취소 기록으로 보존한다. 저장 오류/탭 충돌은 기존 정책을 따른다. 사례 삭제·수정으로 과거 snapshot을 바꾸지 않는다. 같은 파일 가져오기는 별도 ID로 병합하며 ‘저장됨’ 이후 다시 열면 복원한다.

## Artifacts and Notes

[제품 명세](../../product-specs/protocol-simulator-v1.md)에 현재 계약과 실제 검증 결과를 기록한다.

## Interfaces and Dependencies

Optional suite/regression 모델만 확장한다. 기존 bundle은 계속 허용하고 새 필드가 있는 bundle은 이전 앱에서 거부될 수 있다. 실제 서버/기기·외부 서비스·신규 dependency는 포함하지 않는다.
