# Completed execution plans

[운영 규칙](../index.md)에 따라 상태가 Completed인 계획만 등록한다. 완료일은 본문의 종료일과 일치해야 한다. 취소된 계획은 이 목록에 등록하지 않는다.

| 계획 | 완료일 | 결과 | 검증 근거와 한계 |
| --- | --- | --- | --- |
| [계층별 프로토콜 시뮬레이터 v1](20261030-1641-layered-protocol-v1.md) | 2026-10-30 | P0~P7 계층별 정의·가상 엔진·UI·장애·예제·저장/재생과 응답성·CI 완료 | 로컬/원격 Node 215·문서 27·Chromium/Firefox E2E 78·응답성 2. 실제 네트워크·배포는 범위 밖 |
| [프로토콜 상태도 자동 생성과 실행 표시](20261102-protocol-state-diagram.md) | 2026-11-02 | 초안/실행 SVG 상태도·현재/최근 전이·조건/동작·편집 이동 | 로컬 Node 222·문서 28·Chromium/Firefox E2E 92·열린 상태도 응답성 2. 시퀀스 그림·직접 그래프 편집은 범위 밖 |
| [통신 시퀀스 다이어그램과 메시지 상세](20261102-communication-sequence-diagram.md) | 2026-11-02 | 관찰 prefix의 송신/수신·장애·재전송 후보·snapshot 필드/바이트·인과관계 | 로컬 Node 231·문서 29·Chromium/Firefox E2E 104·열린 상태도/시퀀스 응답성 2. 실제 네트워크·직접 그래프 편집은 범위 밖 |
| [상태도와 통신 시퀀스 연동](20261102-linked-execution-diagrams.md) | 2026-11-02 | 실행 회차·선택 전후와 관련 시퀀스의 양방향 탐색·자동 재생/선택 정지 | 로컬 Node 240·문서 30·Chromium/Firefox E2E 120·연동 포함 응답성 2. 초기 성능 초과와 동일 기준 재검사 기록, 실제 네트워크·배포는 범위 밖 |
| [초안 상태도 시각적 편집](20261103-visual-protocol-authoring.md) | 2026-11-03 | 상태·전이 생성과 기존 폼의 옆 편집기·단일 필드 소유 | 로컬 Node 250·문서 31·Chromium/Firefox E2E 134·응답성 2. 자유 배치/드래그·실행 snapshot 수정은 범위 밖 |
| [반복 실험과 결과 비교](20261105-batch-experiment-comparison.md) | 2026-11-05 | 공통 seed·환경 조건별 독립 실행, 두 묶음 비교·기록 재생·로컬 저장 | 로컬 Node 260·문서 32·Chromium/Firefox E2E 146·응답성 2. 최종 병합 보강 후 관련 검사 재확인. 실제 네트워크 성능은 범위 밖 |
| [규칙 선택과 변수 변경 설명](20261105-execution-explanations.md) | 2026-11-05 | snapshot·직접 trigger의 조건/단락·순차 대입과 기록 대조, 현재 prefix·회차 연동 | 로컬 Node 273·문서 33·Chromium/Firefox E2E 160·설명 포함 응답성 2. 초기 저장 복구 시험 경합과 수정/재검증 기록. 실제 네트워크·배포는 범위 밖 |
| [시나리오 묶음과 회귀 검증](20261105-scenario-regression-suites.md) | 2026-11-05 | 공통 정의의 최대 20사례 작성·독립 실행·동일 조건 판정 비교·기록 재생과 저장 | 로컬 Node 284·문서 34·Chromium/Firefox E2E 170·응답성 2. 중단 경계/저장 selector 수정과 미재현 timeout·최종 통과 기록. 실제 네트워크·배포는 범위 밖 |
| [실패 원인 진단과 관련 기록 이동](20261105-failure-diagnostics.md) | 2026-11-05 | 네 기대 조건의 기대/관찰·저장 판정 대조, 직접 연결/참고 관찰과 기존 시퀀스/설명 이동 | 로컬 Node 294·문서 35·Chromium/Firefox E2E 182·진단 포함 응답성 2. 과거 prefix 보강·미판정/한도 유지. 실제 네트워크·배포는 범위 밖 |
| [메시지 구조 시각화](20261105-message-structure-visualization.md) | 2026-11-05 | HTTP/JSON 실제 구획/필드 범위·논리 패킷/청크 구분·선택 byte 강조와 유한 hex/ASCII | 로컬 Node 305·문서 36·Chromium/Firefox E2E 196·구조 포함 응답성 2. split fixture/page 보강·507 kB build advisory 기록. 실제 네트워크/임의 binary·배포는 범위 밖 |
| [중단점과 조건부 실행 정지](20261105-conditional-breakpoints.md) | 2026-11-05 | 상태/parsed/after 변수 조건·원자적 단계 정지와 근거/계속/재생·탭별 설정 | 로컬 Node 318·문서 37·Chromium/Firefox E2E 212·20개 활성 응답성 2. revision 재검증·원본 trace 동등성·390px 확인. 일괄 실행 정지/실제 통신/배포는 범위 밖 |
| [시나리오 묶음 검증 커버리지](20261105-scenario-suite-coverage.md) | 2026-11-05 | 공통 snapshot의 A/B 관찰 횟수·미관찰/평행 전이와 사례 첫 관찰 재생 | 로컬 Node 330·문서 38·Chromium/Firefox E2E 226·응답성 3. 실제 20사례/200k trace·부분/누락/오류·390px 확인. 분기/경로 증명·실제 통신/배포는 범위 밖 |
| [두 실행 결과 나란히 비교](20261105-side-by-side-run-comparison.md) | 2026-11-05 | frozen 설정/결과·상태/변수/판정·순서 보존 관찰 차이와 각 쪽 재생/회귀 쌍 진입 | 로컬 Node 344·문서 39·Chromium/Firefox E2E 244·응답성 5. 두 10k/두 1 MiB·390px/한도 확인. 인과/최장 경로 증명·실제 통신/배포는 범위 밖 |
| [계층 연결 프로토콜 스택](20261106-layered-protocol-stacks.md) | 2026-11-06 | S1~S5 네 endpoint·ReliableStreamLite·관찰/편집/회귀/비교 화면·기본 DB2 저장 | 로컬 Node 520·문서 46·UI 270·native DB 14·응답성 8. CI 성능 실패 보완·지연 복원 경계 재검증. 실제 네트워크·배포는 범위 밖 |
| [메시지의 계층별 이동 경로](20261106-stack-message-journey.md) | 2026-11-06 | 실제 byte 출처와 구간의 네 단계 보기·필드/byte 강조·제어 후속·시퀀스/기록 연결 | 로컬 Node 538·문서 47·UI 278·native DB 14·응답성 8. 같은 내용/변수 범위의 모호함·prefix/한도 유지. 실제 통신·schema 변경 없음 |
| [스택 규칙 폼 편집](20261106-stack-rule-forms.md) | 2026-11-06 | 이벤트·조건·표현식·순차 동작 폼과 raw 원자적 이동·JSON/저장 왕복 | 로컬 Node 552·문서 48·UI 296·native DB 14·응답성 9. 605개 실제 동작·unknown/한도·snapshot 격리. 실행/저장 schema·의존성 변경 없음 |
| [새 스택 작성·되돌리기·설정 폼](20261107-stack-authoring-workflow.md) | 2026-11-07 | native 생성 검토/첫 실행·초안 config/raw 이력·포트/타이머/초기값 폼 | 로컬 Node 565·문서 49·UI 314·native DB 14·응답성 9. 공유 한도·fresh exact revision·외부 교체/저장 실패·605동작 undo/redo. 저장/엔진 계약 유지 |
| [작성 기능 CI 검증과 저장 비용](20261107-stack-authoring-ci-validation.md) | 2026-11-07 | 소유 JSON의 정확한 byte 크기 재사용·가져오기 준비 상태 대기 | 로컬/원격 Node 570·문서 50·UI 314·native DB 14·응답성 9. 기존 시간/크기/저장 계약 유지, 보완 코드 CI `42256191134` 통과 |
| [스택 상태도 시각적 편집](20261109-stack-visual-authoring.md) | 2026-11-09 | 네 endpoint의 상태/전이 작성·선언 이벤트·단일 선택 폼과 기존 이력/저장 | 로컬 Node 581·문서 51·UI 334·native DB 14·응답성 10. 125상태/605규칙·미지원 표현식/raw·live/snapshot 보존. 엔진/저장 schema 유지 |
| [스택 관찰의 증분 전달](20261109-stack-observation-transfer.md) | 2026-11-09 | 실제 불변 event/byte suffix만 전달·정확한 기준본 복원/거부 | 로컬 Node 586·문서 52·UI 334·native DB 14·응답성 10. 기존 10k 반복 수신 비용 보완, snapshot/저장·성능 상한 유지 |
| [스택 시나리오·기대 조건 폼](20261109-stack-scenario-forms.md) | 2026-11-09 | 정확한 대상의 typed 메시지/네 기대·생략/기본값·raw/이력·사례/회귀 | 로컬 Node 593·문서 53·UI 356·native DB 14·응답성 11. 입력/기대 125개·129필드/125메시지·큰 pending JSON과 원본 보존. 기존 엔진/저장 계약 유지 |
| [대용량 workspace 저장 검증](20261109-workspace-save-validation.md) | 2026-11-09 | dense bytes·Unicode 길이·normalized trace 크기의 반복 검사/직렬화 감소 | 로컬 Node 597·문서 54·UI 356·native DB 14·응답성 11. fresh DB 검사·정확한 예산/CAS와 기존 P7 상한 유지 |
