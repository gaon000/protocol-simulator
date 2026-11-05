# 반복 실험과 결과 비교

상태: Completed
종료일: 2026-11-05

[ExecPlan 운영 규칙](../index.md)을 따른다.

## Purpose / Big Picture

같은 초안의 프로토콜·시나리오를 고정하고 손실률·지연의 조합마다 같은 seed 목록으로 반복 실행한다. 결과 표에서 기대 조건의 통과·실패·미판정, 가상 완료 시간·송신·타이머 만료를 비교하고 개별 기록을 기존 상태도·시퀀스로 재생한다. 수정 전후에는 별도 실행 묶음을 선택해 비교한다. 실제 네트워크 성능이나 정합성 증명은 제공하지 않는다.

## Progress

- [x] 현재 엔진·기록·저장 계약 확인 및 feature branch 생성.
- [x] 불변 실행 계획, 유한 batch runner와 결과 집계 구현.
- [x] 반복 실험 화면·기록 재생·저장/파일 호환 구현.
- [x] 코어·브라우저·응답성 검사와 문서 갱신.
- [x] 검증한 변경과 완료 문서를 Git 전달 가능한 상태로 정리. 실제 commit·master/원격 CI 상태는 최종 응답에서 별도로 확인한다.

## Surprises & Discoveries

- Workspace는 최대 기록 100개·64 MiB이며 bundle의 필드는 엄격히 검증한다. 새 결과는 SavedRun의 선택적 묶음 metadata로 저장하고 옛 기록은 그대로 허용한다.
- 최초 sandbox 브라우저 검사는 localhost bind EPERM으로 실행되지 않았으며 허용된 환경에서 실제 검사를 다시 실행했다.
- 화면 이동 시 seed 목록이 초기화되어 공통 seed 비교가 깨지는 것을 E2E에서 발견해 App이 초안별 조건 입력을 보존하도록 수정했다.
- 저장 충돌 복구에서 부모 초안이 새 사본이 되면 묶음 ID와 모든 회차를 함께 분리해야 한다. 기존 동일 기록 건너뛰기를 그대로 적용하면 공통 prefix가 빠지므로 해당 분기에서는 전체 묶음을 복사한다.
- 엔진 completed와 기대 조건 통과는 다르다. 자원 제한·취소·오류·미완료 관찰은 미판정으로 집계한다. 재전송 의도는 일반 trace에 없으므로 송신 횟수와 타이머 만료 횟수를 사용한다.

## Decision Log

- 2026-11-05: seed 목록의 길이가 조건별 반복 횟수다. 중복 seed는 거부한다. 손실률·지연 목록은 Cartesian 조합이며 빈 목록은 해당 방향의 현재 값을 보존한다. 방향은 양방향/A→B/B→A를 선택한다. 스트림에 손실률을 제공하지 않는다.
- 2026-11-05: 한 번에 최대 100회이며 남은 기록 공간을 사전 확인한다. 엔진은 64개 queue 작업마다 UI에 제어를 돌려주고 중단 시 진행 중인 실행만 cancelled로 보존한다. 대기 실행을 실패로 만들지 않는다. 다른 단일 실행·초안 교체·bundle 가져오기는 진행 중 묶음을 중단한다.
- 2026-11-05: 신규 dependency 없이 React/native DOM과 기존 엔진·IndexedDB를 사용한다. 묶음 metadata는 optional이라 이전 workspace를 migration 없이 읽는다. 새 bundle은 이전 앱에서 엄격히 거부될 수 있다.

## Outcomes & Retrospective

반복 실험 탭에서 지연·손실률 조건과 공통 seed를 설정하고 독립 엔진으로 실행한다. 두 묶음의 실제 설정·기대 조건 판정·가상 완료·송신/만료를 비교하고 기존 기록 재생으로 이동한다. 중단/미실행과 통과/실패/미판정을 분리하고 초안·단일 실행 snapshot·이전 기록을 보존한다. 새 production dependency는 없다.

`pnpm check`가 Node 260·문서 32·Chromium/Firefox E2E 146·응답성 2와 lint/format/strict type/build 검사를 통과했다. 최종 저장 병합 보강 후 관련 Node 29개, 전체 Node 260개와 반복 실험 E2E 12개를 다시 확인했다. Git 전달과 원격 CI는 로컬 검증과 구분해 최종 응답에서 실제 상태를 보고한다. 실제 네트워크·Safari/실기기·배포는 검증 범위 밖이다.

## Context and Orientation

`src/application/create-simulation.ts`가 검증·불변 snapshot·독립 엔진을 생성한다. `src/ui/App.tsx`가 단일 실행과 HistoryPanel 선택을 연결한다. `workspace-model.ts`와 `workspace-validation.ts`, `workspace-operations.ts`가 IndexedDB/bundle의 호환·병합·한도를 소유한다.

## Plan of Work

1. application의 반복 계획·runner·집계와 SavedRun metadata 검사/병합을 구현한다.
2. 별도 반복 실험 탭에서 조건 설정·진행/중단·최대 두 묶음 비교·개별 실행 선택을 연결한다. 이전 초안 버전은 항상 표시하고 묶음은 삭제하지 않는 한 보존한다.
3. seeded 재현·조건별 격리·취소/오래된 callback·미판정·한도·기록 병합을 Node에서 검증한다. Chromium/Firefox에서 실제 결과·수정 전후·재생·새로고침·390px·중단/invalid draft를 검사한다.

## Validation and Acceptance

Node 24.18.0 / pnpm 9.15.0. `pnpm check`와 `git diff --check`. 기존 10k/1 MiB 응답성 한도는 유지한다. 결과 비교는 모델의 가상 시간이며 실제 wall-clock 성능을 나타내지 않는다.

## Idempotence and Recovery

각 묶음·기록은 고유 ID를 사용한다. 완료/중단한 실행 단위로 기존 저장 controller에 추가하며 기존 기록을 덮어쓰지 않는다. bundle 충돌은 묶음 ID도 재할당한다. 저장 실패·탭 충돌은 기존 저장 복구 흐름을 따른다. ‘브라우저에 저장됨’ 이후 다시 열면 기록을 복원하며 자동 재개하지 않는다. 미저장 변경·transaction 실패는 기존 저장 안내를 따른다.

## Artifacts and Notes

macOS / Chromium 156.0.8078.4 로컬 응답성(기존 한도 유지):

| fixture | 실행 ms | 입력 p95 ms | 그림 연동 ms | 상세 ms | 저장 ms | cursor ms | frame p95 ms | max longtask ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10k | 3505.10 | 91.64 | 101.04 | 86.40 | 64.20 | 141.10 | 16.8 | 0 |
| 1 MiB | 373.33 | 71.63 | 69.07 | 93.43 | 497.51 | 112.89 | 16.8 | 168 |

390px에서 실제 native 표 스크롤·키보드 실행·내부 가로 스크롤과 배치를 screenshot으로 확인했다. 기능 검사의 마지막 저장 병합/안내 수정 뒤 관련 코어·브라우저 검사를 반복했고 응답성 fixture의 원본 trace/byte 상한은 바꾸지 않았다.

제품 계약은 [v1 제품 명세](../../product-specs/protocol-simulator-v1.md)에 추가한다. 검사 로그는 임시 디렉터리에 기록한다.

## Interfaces and Dependencies

SavedRun에 optional batch metadata를 추가한다. 엔진·기록 이벤트·기존 snapshot 버전과 dependency는 변경하지 않는다.
