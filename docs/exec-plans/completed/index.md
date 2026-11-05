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
