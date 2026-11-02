# 프로토콜 상태도 자동 생성과 실행 표시

상태: Completed
작성일: 2026-11-02
종료일: 2026-11-02

이 문서는 [ExecPlan 운영 규칙](../index.md)을 따른다.

## Purpose / Big Picture

사용자가 정의한 상태·규칙을 상태도로 읽고, 실행 위치의 상태와 최근 적용된 규칙을 확인하며 규칙의 조건·동작과 편집 위치로 이동한다. 요청한 다음 작업의 1번만 구현한다. 시퀀스 다이어그램·양쪽 다이어그램의 전체 선택 연동·그래프 직접 편집은 포함하지 않는다.

## Progress

- [x] 현재 모델·snapshot·history cursor·폼 초점·개발/작업 규칙 확인.
- [x] 순수 상태도 모델/배치와 참조·페이지·실행 위치 처리.
- [x] SVG 보기·선택 상세·편집 이동과 초안/실행 화면 연결.
- [x] Node·브라우저·기존 응답성 검사와 화면 확인, 문서 갱신.
- [x] 최종 수용 검사·문서 종료와 전달 준비. 실제 commit/master/CI는 Git 기록·최종 응답에서 확인.

## Surprises & Discoveries

- history projection은 전체 events를 유지한다. 최근 적용 규칙을 찾을 때 history cursor 이후의 전이를 사용하면 미래 규칙이 강조되므로 표시 구간 끝을 별도로 전달해야 한다.
- 같은 ID/revision이 다른 실험에 있을 수 있다. snapshot에서 현재 초안의 편집 위치로 이동할 때 정의 내용까지 일치하는지 확인한다.

- 실제 포인터 검사에서 Chromium의 mousedown 초점 이동이 SVG를 스크롤해 click 대상을 옮겼다. focus-visible인 키보드 초점에서만 즉시 스크롤하고, 마우스 선택은 click 이후 표시 위치를 맞추도록 수정했다. 포인터/Enter/Space를 양쪽 브라우저에서 검사했다.
- 화면 캡처에서 자기 전이와 교차 전이의 라벨 겹침을 확인했다. 자기 전이를 노드 위에 배치하고 라벨을 곡선의 다른 지점이나 안내선으로 이동시켰다. 전체 catalog에서 라벨끼리/노드와 겹치지 않는 회귀 검사를 추가했다.

## Decision Log

| 날짜 | 결정 | 이유 |
| --- | --- | --- |
| 2026-11-02 | 추가 dependency 없이 React·SVG와 순수 TS 배치 사용 | 자동 생성·선택 보기 범위에 충분하며 기존 승인 범위 안에서 진행 |
| 2026-11-02 | 초안 상태도와 실행 snapshot 상태도 구분 | 수정된 초안이 과거 결과의 상태/규칙을 잘못 표시하지 않도록 함 |
| 2026-11-02 | 상태 40개·규칙 20개씩 페이지, 같은 출발/도착 규칙은 한 화살표에 묶고 개별 선택 제공 | DOM/배치 비용을 제한하면서 전체 정의를 탐색 가능하게 유지 |
| 2026-11-02 | 없는/중복 상태 참조는 별도 표시, 원본 ID 대신 행 index를 보기 키로 사용 | invalid draft에서도 깨지거나 잘못 연결되지 않도록 함 |

## Outcomes & Retrospective

읽기 전용 자동 상태도·초기/종료/현재 상태·최근 적용 규칙·개별 조건/동작·편집 위치 이동을 구현했다. 초안과 참여자별 snapshot을 구분하며 과거 cursor 밖의 전이를 사용하지 않는다. 상태/규칙 페이지·크기·키보드·현재 위치 이동을 제공한다. 신규 production dependency·저장 포맷·엔진 의미 변경은 없다. 아래 로컬 수용 검사를 완료했으며 Git 전달과 최종 commit의 CI는 별도로 확인한다.

## Context and Orientation

- [현재 구조](../../../ARCHITECTURE.md), [개발 기준](../../development.md), [제품 명세](../../product-specs/protocol-simulator-v1.md).
- [모델](../../../src/domain/protocol-model.ts)의 states/rules를 읽고 application에서 보기 모델을 만든다. engine이 UI/SVG를 참조하지 않는다.
- [App](../../../src/ui/App.tsx)의 draft/displayed/historyPosition과 기존 navigate/focus를 사용한다.
- [기록 projection](../../../src/application/replay-record.ts)은 전이 기록 기준의 현재 상태를 제공한다.

## Plan of Work

1. `src/application/state-diagram.ts`에 페이지별 상태/묶인 전이·유한 배치, 현재 위치까지의 최근 전이와 정확한 초안 편집 대상 조회를 구현한다.
2. `src/ui/StateDiagram.tsx`에 초기/종료·없는 참조·현재 참여자·최근 적용 규칙·선택을 텍스트와 스타일로 구분한다. 키보드 Enter/Space, 스크롤/크기 조절·페이지와 개별 규칙 선택·조건/동작 상세를 제공한다.
3. 프로토콜 편집에는 초안, 실행에는 참여자별 snapshot을 연결한다. 다른 초안/수정본으로의 편집 이동은 막고 이유를 설명한다. 상태도 선택은 정의/저장 기록/가상 실행을 변경하지 않는다.
4. 단위/통합·Chromium/Firefox E2E와 전체 회귀·응답성을 검사하고 문서를 실제 구현에 맞춘다.

## Validation and Acceptance

- Node: 실제 catalog의 상태/규칙 대응, 자기 전이·반대/평행 전이·독립 상태·없는/중복 ID, 페이지 경계/상한, cursor 전/후·A/B·snapshot 일치/불일치와 비변경성.
- 브라우저: 초안 자동 갱신·선택 상세/편집 초점, 단계 실행의 현재 상태/최근 규칙, history 초기/중간/끝·초안 변경 후 snapshot 유지, 서로 다른 A/B 정의, 키보드/390px, 많은 상태·규칙의 페이지.
- 필수 명령: `pnpm check`와 `git diff --check`. 실행 후 실제 수집/통과 수와 실패 보완을 기록한다. 기존 10k/1 MiB 응답성 기준을 유지한다.
- 화면 캡처로 Ping/Pong·HTTP·TCP의 노드/화살표/라벨과 좁은 화면을 확인한다.

## Idempotence and Recovery

읽기 전용 보기이며 저장 모델·schema/engineVersion은 변경하지 않는다. graph key/선택은 schema ID와 분리한다. 부정확한 snapshot→초안 이동은 비활성화하고 기존 폼·정의 진단을 복구 경로로 남긴다. 기존 사용자 변경을 되돌리지 않는다.

## Artifacts and Notes

2026-11-02 로컬 최종 `pnpm check` 전체 통과:

- lint·포맷·strict TypeScript, Node 222개(skip 없음), 문서 28개, production build, Chromium/Firefox E2E 92개, 독립 1-worker Chromium 응답성 2개.
- 신규 Node 7개: 아홉 catalog의 모든 정의/규칙과 라벨 배치·평행/자기/역방향·독립 상태·잘못된 참조·유한 페이지·cursor/참여자·내용까지 정확한 편집 대상과 원본 비변경성을 검사했다.
- 신규 기능 E2E 7개 × 2 browsers: SVG 포인터/키보드·초점 이동·초안 자동 갱신, invalid draft, 실제 단계/과거 cursor, 수정 초안과 snapshot 분리, TCP A/B·390px, 많은 상태·규칙과 그룹 내 개별 조건, HTTP 양쪽 상태를 검사했다.
- Ping/Pong·HTTP 서버와 TCP 390px 캡처를 직접 열어 확인했다. 원격 배포/실제 기기/새 시퀀스 다이어그램 검증은 아니다.
- 기존 10k/1 MiB 응답성 검사는 실행 상태도를 펼친 상태와 history 이동을 포함하도록 보강했고 수치 상한은 유지했다. 10k 실행 3,465.3ms·입력 p95 54.8ms·cursor 93.3ms·frame p95 16.7ms. 1 MiB 실행 359.2ms·입력 p95 34.5ms·cursor 63.4ms·frame p95 16.8ms·최대 longtask 126ms. 기기별 성능 보증은 아니다.
- `git diff --check` 통과. 신규 파일까지 staging 후 공백 검사를 추가 확인한다. 실제 commit·원격 master SHA·해당 CI 결과는 최종 Git 전달 시 확인하며 로컬 결과를 원격 통과로 대체하지 않는다.

## Interfaces and Dependencies

새 순수 TS 보기 모델과 React SVG 컴포넌트만 추가한다. 프로토콜 정의·snapshot·bundle 공개 계약은 유지하며 추가 production dependency가 없다.
