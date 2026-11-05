# 규칙 선택과 변수 변경의 실행 설명

상태: Completed
종료일: 2026-11-05

[ExecPlan 운영 규칙](../index.md)을 따른다.

## Purpose / Big Picture

선택한 실행 회차에서 어떤 상태·이벤트·조건 때문에 규칙이 선택됐고, 각 assign이 어떤 값을 읽어 변수를 바꿨는지 확인한다. 현재 초안이 아니라 frozen snapshot·직접 trigger·기록한 before/after를 사용한다. 같은 상태/이벤트 후보의 조건 결과와 short-circuit, 순차 대입을 보여주고 실제 전후 값과 대조한다. 기존 저장 기록과 반복 실험 결과에서도 같은 설명을 제공한다.

## Progress

- [x] 엔진 조건/동작 순서·기록·diagram prefix 계약과 현재 master 확인.
- [x] DOM 없는 설명 모델·계산 상한·기록 대조와 코어 검사 13개. 모든 catalog 전이·short-circuit·대입·prefix·큰 값/깊이/연산/10k 경계 확인.
- [x] 선택 이벤트/회차와 연결한 설명 화면·브라우저 검사 14개. 실제 snapshot/반복 실험·다중 해석·390px·키보드·20행 확인.
- [x] 계약/완료 기록·전체 회귀/응답성 검사와 전달 준비. `pnpm check` 통과, 실제 commit·master/원격 CI 상태는 최종 응답에서 별도로 확인한다.

## Surprises & Discoveries

- 엔진은 조건을 기존 변수로 평가하고 actions를 임시 변수에 순서대로 평가한다. 뒤 assign은 앞 assign 결과를 읽으며 동적 오류는 전체 staging을 rollback한다.
- 첫 전체 검사에서 Firefox의 기존 저장 복구 검사 하나가 timeout으로 실패했다(159개 통과). 오류 주입을 해제한 뒤 pending 자동 저장이 먼저 성공해 재시도 버튼이 사라진 경합이었다. 오류 해제는 실제 재시도 클릭의 document capture listener에서 수행하도록 시험 fixture를 수정했다. 처음 버튼 자체에 붙인 listener는 저장 중 버튼이 교체되며 사라져 quota 재검사가 실패했고, 안정적인 document listener로 바꾼 뒤 저장/파일 회귀 16개를 통과했다. production 저장 코드는 변경하지 않는다.
- transition은 send/timer 등의 효과 trace 뒤에 기록된다. 송신만 보이는 prefix에서 전이나 적용 완료를 추정하면 안 된다. 합쳐 읽기의 여러 parsed/transition도 하나로 합치지 않는다.

## Decision Log

- 2026-11-05: 기존 before/after·snapshot·직접 trigger에서 설명을 재구성하고 실제 결과와 대조한다. 엔진·trace·저장 버전이나 dependency를 바꾸지 않는다. 지원하는 snapshot 버전만 계산한다.
- 2026-11-05: 현재 관찰 prefix 안의 실제 transition이 설명 단위다. 여러 전이가 연결되면 사용자가 회차를 선택한다. 전이 없는 오류·아직 기록하지 않은 commit은 설명 불가를 표시하고 assign 적용을 주장하지 않는다.
- 2026-11-05: 연산/값 탐색 상한과 조건/대입 페이지를 적용한다. 너무 큰 값이나 복잡한 정의는 제한 표시를 하고, 기록과 불일치하면 검증된 설명으로 표시하지 않는다. 설명 패널을 열었을 때만 계산한다.

## Outcomes & Retrospective

실행 보기에서 선택 회차의 출발 상태·발생 이벤트·후보 조건과 실제 피연산자, 단락 평가 생략, 동작 순서대로 복원한 대입과 기록의 최종 변수 변경을 확인한다. 단일 실행·과거 기록·반복 실험의 재생에서 같은 기능을 사용한다. 여러 전이는 회차를 선택하며 부족한 기록·구버전·상한·불일치를 명시한다. 초안·실행·저장 데이터는 수정하지 않는다.

최종 `pnpm check`는 Node 273·문서 33·Chromium/Firefox E2E 160·응답성 2와 lint/format/strict type/build를 모두 통과했다. 초기 전체 검사 실패와 저장 복구 fixture 수정 후 회귀 16개 통과, 전체 동일 기준 재검사를 위 발견에 기록했다. Git/원격 CI는 로컬 검증과 구분해 최종 응답에서 실제 상태를 확인한다. 실제 네트워크·배포·Safari/실기기는 검증 범위 밖이다.

## Context and Orientation

`src/engine/expressions.ts`가 선언형 조건/값을 평가하고 `simulation.ts`가 실제 규칙 선택과 atomic actions를 소유한다. `diagram-links.ts`는 participant·직접 trigger별 관찰된 전이를 묶고 `App.tsx`가 선택과 history prefix를 관리한다. 설명은 application에서 계산하고 UI는 유한 문자열/페이지로 표시한다.

## Plan of Work

1. snapshot 규칙·trigger와 before 값을 검증하고 후보 조건의 참/거짓·생략 분기와 순차 assign을 재구성한다. 최종 변수/상태를 기록과 대조한다.
2. 실행 보기에서 접을 수 있는 ‘실행 이유 설명’을 제공한다. 기존 trace·시퀀스·상태도의 선택 회차를 공유하며 여러 전이는 선택한다.
3. 실제 코어 fixture로 단락 평가·조건 후보·순차/반복 대입·원자성·오류·과거 버전·미관찰 commit·다중 해석·큰 값·snapshot 격리를 검사한다. Chromium/Firefox·390px·기록 복원·반복 실험 재생과 기존 응답성도 확인한다.

## Validation and Acceptance

Node 24.18.0 / pnpm 9.15.0. `pnpm check`와 staging 포함 `git diff --check`. 10k/1 MiB 원본 fixture와 기존 숫자 상한을 유지한다. 설명은 선택적으로 열고 큰 입력의 계산/DOM을 제한한다.

## Idempotence and Recovery

읽기 전용 파생 모델이며 저장 데이터·초안·실행 큐를 수정하지 않는다. 구버전/부족한 기록/상한/불일치는 해당 사실을 표시한다. 계산을 위해 실행을 재개하거나 사용자 코드를 실행하지 않는다.

## Artifacts and Notes

현재 제품 계약은 [v1 명세](../../product-specs/protocol-simulator-v1.md)에 추가한다. macOS arm64 / Chromium 156.0.8078.4, 1 worker, 원본 10k/정확한 1 MiB fixture의 기존 상한을 유지했다.

| fixture | 실행 ms | 입력 p95 ms | 그림 연동 ms | 설명 표시 ms / 문자 | 상세 ms | 저장 ms | cursor ms | frame p95 ms | max longtask ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10k | 3513.47 | 54.39 | 66.72 | 55.14 / 593 | 59.60 | 63.91 | 138.17 | 16.8 | 0 |
| 1 MiB | 370.63 | 35.01 | 39.89 | 59.65 / 567 | 39.07 | 298.82 | 62.41 | 16.8 | 128 |

실행 설명을 열어 실제 계산/기록 일치 표시를 확인하고 추가 지표는 500ms·DOM 32768자 미만으로 검사했다. native IndexedDB의 원본 이벤트/bytes 보존 확인은 기존과 동일하다. `test-results/performance-report.json`에 지표를 남겼다. 데스크톱의 단락/순차 대입과 390px의 snapshot 설명 screenshot을 열어 배치·값 표시를 확인했다. 실제 명령은 `pnpm check`, 관련 코어·새 E2E 및 저장 회귀 검사, `git diff --check`다.

## Interfaces and Dependencies

application의 설명 조회와 UI만 추가한다. 신규 production dependency는 없다. 기존 기록/bundle과 엔진 버전·의미적 trace는 유지한다.
