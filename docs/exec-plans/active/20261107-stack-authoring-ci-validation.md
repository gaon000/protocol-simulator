# 작성 기능의 CI 검증과 저장 비용 보완

상태: In Progress
종료일: 미종료

[운영 규칙](../index.md)을 따른다.

## Purpose / Big Picture

[작성 기능](../completed/20261107-stack-authoring-workflow.md)의 전달 SHA `237492a`에서 발견한 원격 검증 실패를 확인하고 기존 시간/크기 기준으로 최종 CI를 통과한다. 기능·저장/엔진 schema·지원 경계는 유지한다.

## Progress

- [x] CI 두 실행의 실제 로그/trace와 동일 소스 로컬 성능 재검사 확인.
- [x] 파일 가져오기 종료의 실제 준비 상태 대기와 소유 JSON의 정확한 byte 크기 재사용 구현.
- [x] 새 코어·브라우저/저장·성능 전체 검사.
- [ ] 최신 전달 SHA의 원격 CI 확인.

## Surprises & Discoveries

- [첫 CI](https://github.com/gaon000/protocol-simulator/actions/runs/42250604374/attempts/1): Node 565·UI 314·native DB 14 통과, legacy 1 MiB 저장 3001ms/3000ms와 stack 10k 최대 task 322ms/250ms 초과. 새 605동작 편집/undo/redo는 129/113/118/111ms로 통과했다. 동일 소스 로컬 재검사는 아홉 fixture 모두 통과(해당 저장 1376ms·10k task 52ms)했다. 첫 trace만으로 긴 task의 단일 원인을 확정하지 않는다.
- [두 번째 CI](https://github.com/gaon000/protocol-simulator/actions/runs/42250604374/attempts/2): 성능 단계 전 기존 Firefox 그림 연동 검사 한 곳 실패. 가져오기 적용 안내 뒤 저장/파일 busy 정리가 남아 있고, 실행 버튼 click 도중 busy 행 제거로 배치가 바뀌었다. 원래 완료 시간 10초는 유지하고 file input이 다시 활성화되는 실제 가져오기 종료를 기다린다.
- 1 MiB 자료를 fresh clone→소유 JSON 검사→v2 envelope 검사로 측정한 Node 소규모 실험에서 구조 검사 약 227ms·schema 검사 210ms였다. root와 legacy 영역의 크기를 반복 직렬화하는 경로를 확인했다. 정확한 byte metadata를 재사용한 뒤 구조 약 241ms·schema 94ms로 줄었다. 브라우저/다른 플랫폼의 결과와 구분한다.

## Decision Log

- 2026-11-07: `parseOwnedJsonData`가 검증한 소유 자료를 동결할 때 기존 nodes/depth와 정확한 JSON UTF-8 byte 길이를 함께 보관한다. 유한 primitive·키/구분자/escaping·중복 alias를 모두 센다. 일반 mutable/shallow frozen 자료는 native JSON 직렬화로 계산한다. 외부 DB 자료의 fresh 검사, 실패 시 미동결, 접근자 거부와 더 작은 node/depth 예산을 유지한다.
- 2026-11-07: 한 구조 검사 안에서 반복 문자열의 인코딩 길이만 최대 1024개 재사용하고 검사 후 보관하지 않는다. workspace의 root/legacy byte 한도는 새 크기 함수로 같은 정확한 길이를 검사한다. 시간·fixture·byte 한도와 실제 IndexedDB/CAS는 바꾸지 않는다.
- 2026-11-07: 배열은 표준 prototype과 실제 index/length만 허용해 숨겨진 `toJSON`이나 subclass 직렬화가 정확한 byte 계산을 바꾸지 않도록 한다. 접근자를 실행하지 않고 거부한다.

## Outcomes & Retrospective

로컬 전체 검사를 통과했다. Node 570·문서 50·Chromium/Firefox UI 314·native DB 14·응답성 9다. 최종 전체 검사에서 legacy 1 MiB 저장 1377ms/3000ms, native 10k 최대 task 66ms/250ms였다. 기존 605동작 편집과 undo/redo도 같은 500ms 기준을 유지했다. 정확한 전달 SHA의 원격 CI를 확인한 뒤 완료한다.

## Context and Orientation

`model-validation.ts`의 소유 JSON shape cache와 `workspace-v2-validation.ts`/`workspace-validation.ts`의 실제 byte 상한을 사용한다. 저장 worker는 fresh DB 자료를 계속 검사한다. `linked-diagrams.test.ts`는 가져오기 완료 후 실행을 검사한다.

## Plan of Work

1. 정확한 byte metadata/불변 경계를 Node에서 검증하고 대형 저장 재직렬화 비용을 줄인다.
2. 파일 가져오기 준비 상태를 명시적으로 기다려 실제 실행을 시작한다.
3. 기존 전체 검사와 정확한 전달 SHA의 CI를 완료한다.

## Validation and Acceptance

Node 24.18.0·pnpm 9.15.0, `pnpm check`·공백 검사와 [P7](../../design-docs/p7-validation.md)의 기존 아홉 fixture/상한을 유지한다. 새 검사는 UTF-8·escape/lone surrogate·숫자/byte 배열·cached subtree/alias·mutable/shallow freeze·작은 예산·accessor/hole/비유한 값과 실패 미동결을 확인한다. 실제 원격 결과를 별도로 기록한다.

## Idempotence and Recovery

캐시는 검증된 깊은 불변 자료에만 연결한다. 기존 자료·저장 형식·CAS 복구와 오류 계약을 바꾸지 않는다. 가져오기 검사는 고정 sleep이나 timeout 증가를 사용하지 않는다.

## Artifacts and Notes

로그: 최종 로컬 `/private/tmp/authoring-ci-fix-check.log`, `/private/tmp/authoring-ci-failed.log`, `/private/tmp/authoring-ci-second.log`, `/private/tmp/authoring-performance-repeat.log`. 원격 trace는 해당 Actions artifact에 남는다.

## Interfaces and Dependencies

검증 이후 호출하는 `jsonByteLength`만 추가한다. 신규 production dependency와 저장 migration은 없다.
