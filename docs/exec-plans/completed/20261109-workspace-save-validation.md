# 대용량 workspace 저장 검증 비용

상태: Completed
종료일: 2026-11-09

[운영 규칙](../index.md)을 따른다.

## Purpose / Big Picture

[시나리오 폼](../completed/20261109-stack-scenario-forms.md)의 최종 CI에서 반복 관찰된 기존 legacy 1 MiB 저장 비용을 줄이고 동일 P7 기준을 통과한다. 기능·저장 schema·fresh DB 검증·CAS·한도/재시도 정책을 유지한다.

## Progress

- [x] 2026-11-09: CI 로그·trace/보고서 보존과 실제 fixture의 fresh validation CPU 프로파일 확인.
- [x] dense byte 배열·Unicode 길이·정규화 trace 크기의 반복 비용 보완. 관련 코어 35개 통과.
- [x] 전체 `pnpm check`·문서/공백 검사 완료. 최종 전달 SHA의 원격 CI는 완료 응답에서 별도로 확인한다.

## Surprises & Discoveries

`d43c420`의 [첫 CI](https://github.com/gaon000/protocol-simulator/actions/runs/42566715527)는 Node 593·문서 53·UI 356·native DB 14·성능 10개를 통과했다. 기존 legacy 1 MiB 명시 저장 한 건만 3002.921ms/3000ms로 실패했다. 새로운 시나리오 성능 검사는 통과했다. 같은 SHA 재실행 없이 전체 artifact를 `/private/tmp/stack-scenario-first-ci-artifacts`에 보존했다.

실제 1 MiB simulation 기록을 만든 뒤 새 `structuredClone` 자료의 validation을 Node CPU profiler로 세 번 측정했다. shape 검사 379/369/372ms, 의미 검사 106/107/105ms였다. `/private/tmp/save-validation-baseline.cpuprofile`의 주 비용은 `inspectJson.visit`의 배열 own-property-name 열거/검사와 descriptor loop였다. 이는 브라우저 전체 저장 시간과 구분한다.

이벤트 크기는 `runId`를 빈 문자열로 바꾼 뒤 매번 큰 wire 배열까지 직렬화하고 있었다. 또한 field 문자열의 Unicode 길이를 `Array.from`으로 두 번 계산했다. 정확한 immutable 크기의 runId 차이만 계산하고 code point 길이는 큰 배열 없이 한 번 구하도록 보완했다. `/private/tmp/save-validation-after.cpuprofile`의 shape 345/330/320ms·의미 검사 23/21/21ms를 관찰했다. profiler 자체 비용을 포함한 해당 Node 진단이며 브라우저/CI 수치와 구분한다.

## Decision Log

- 2026-11-09: fresh DB 자료를 계속 새로 검사한다. 검사를 통과한 깊은 불변 객체만 기존 cache를 사용하며 ownership이나 record ID만으로 새 자료를 신뢰하지 않는다.
- 2026-11-09: 완전한 dense 인덱스 목록·own data descriptor와 실제 0..255 정수를 확인한 배열만 반복 visit 없이 정확한 nodes/depth/UTF-8 JSON bytes를 합산한다. 그 외 자료/더 작은 예산은 기존 검사로 동일 진단을 계산한다. getter 실행·hole/extra/symbol·비유한 값·실패 자료 동결을 허용하지 않는다.
- 2026-11-09: 검사된 immutable 이벤트의 전체 JSON UTF-8 크기에서 실제 문자열 runId의 직렬화 차이만 뺀다. unowned·없는/다른 runId는 기존 직렬화 경로를 사용한다. Unicode 길이는 JS 문자열 iterator와 같은 surrogate pair/lone surrogate의 code point 수를 유지한다.

## Outcomes & Retrospective

새 자료의 JSON/의미 검증과 저장 CAS를 유지하면서 큰 배열의 반복 visit·이벤트 재직렬화·문자열 길이 배열 할당을 줄였다. 전체 로컬 검사와 같은 실제 1 MiB 저장 예산을 통과했다. 최종 전달 SHA의 원격 결과는 완료 응답에서 확인한다. 새 API/저장 schema·한도·fixture·timeout/retry 정책은 추가하지 않았다.

## Context and Orientation

`model-validation.ts`의 `inspectJson`이 새 외부 자료의 JSON shape와 optional byte metadata를 검사한다. `parseOwnedJsonData`는 검증 성공 후에만 freeze/cache한다. 문자열 필드 길이도 이 모듈이 검사한다. `workspace-validation.ts`는 기록의 정규화 trace 크기를 검사한다. 저장 worker·native DB adapter는 이 검사와 기존 workspace/view의 의미 검사를 수행한다. DB transaction·CAS와 schema는 변경하지 않는다.

## Plan of Work

1. 유효한 dense byte 배열만 빠르게 검사하고 기존 진단의 정확한 fallback을 유지한다.
2. 실제 작은 예산·alias·UTF-8 byte 길이·hidden property/accessor/hole/비유한 값·잘못된 인덱스·실패 미동결과 실제 저장/재읽기를 검사한다.
3. 같은 실제 fixture의 fresh validation 프로파일과 전체 `pnpm check`를 수행하고 최종 전달 SHA의 CI를 따로 확인한다.

## Validation and Acceptance

Node 24.18.0·pnpm 9.15.0. 관련/전체 Node·strict 타입·lint/format·문서와 `pnpm check`·공백 검사. 기존 legacy 1 MiB 저장 3000ms·모든 P7 fixture/시간/표시 상한과 native DB 실패/충돌 계약을 유지한다.

2026-11-09 macOS의 `/private/tmp/workspace-save-check.log`:

- 최종 `pnpm check`: lint/format·strict 타입·Node 597개·문서 54개·Chromium/Firefox UI 356개·native DB 14개·응답성 11개 통과.
- 새 코어 네 개는 256종 byte와 alias의 nodes/depth/정확한 UTF-8 크기·작은 예산의 실제 진단 경로, hole/hidden/extra/symbol/accessor/위조 own-key 순서·비유한 값의 실패와 getter 미실행/실패 미동결, 64개 조합·pair/lone surrogate/큰 ASCII의 Unicode 길이 경계, 두 runId 길이와 Unicode/escape payload의 normalized trace 예산에서 정확한 경계와 1 byte 초과 거부를 확인했다. 관련 Node 35개도 별도 통과했다(`/private/tmp/save-validation-core.log`).
- 기존 실제 legacy 1 MiB fixture: 실행 970ms·명시 저장 866ms/3000ms·최대 long task 139ms/1000ms. 이전 시나리오 전체 로컬 검사에서 같은 fixture의 저장은 1377ms였다. 기존 legacy 10k 저장 215ms와 native 10k/1 MiB·20사례/200k 관찰·큰 상태도/시나리오 편집도 기존 상한을 통과했다.
- 같은 실제 DB API 검사에서 원본 upgrade·quota/abort·충돌·native 저장/새로고침·부분 기록/1 MiB bytes를 다시 확인했다. fresh DB read를 cache로 건너뛰지 않는다. CPU 1배·Chromium 156.0.8078.4의 해당 실측이며 다른 기기의 보증은 아니다.
- 실제 네트워크·배포·Safari/실기기 조합은 검사하지 않았다. 기존 큰 chunk build advisory는 남는다.

## Idempotence and Recovery

새 validation은 순수 읽기이며 성공 후의 기존 freeze/cache 수명만 사용한다. 검사 실패 시 자료를 동결하거나 저장하지 않는다. 새 DB read는 항상 다시 검사하고 기존 quota/abort/conflict 원본 보존을 유지한다.

## Artifacts and Notes

원격 로그 `/private/tmp/stack-scenario-first-ci.log`, 보존 zip `/private/tmp/stack-scenario-first-ci.zip`, 실제 fixture 진단 스크립트 `/private/tmp/profile-save-validation.mjs`.

## Interfaces and Dependencies

JSON 검사 내부 구현만 보완한다. 공개 API·engine/storage version·schema·production dependency는 유지한다.
