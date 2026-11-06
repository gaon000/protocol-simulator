# 메시지의 계층별 이동 경로 시각화

상태: Completed
종료일: 2026-11-06

[ExecPlan 운영 규칙](../index.md)을 따른다.

## Purpose / Big Picture

스택 실행에서 응용 송신 하나를 골라 인코딩된 프레임, 로컬 write, 전송 조각/재송신, 실제 수신/read와 앱 프레임 해석까지 같은 바이트의 이동을 살펴본다. 필드 또는 byte 구간 선택을 모든 단계에 강조하고 기존 시퀀스/기록 선택과 연결한다. 기준은 [V1-020](../../product-specs/protocol-simulator-v1.md#v1-020-메시지의-계층별-이동-경로)이다.

현재 네 인스턴스의 읽기 전용 관찰 기능이다. 실행/저장 schema·엔진·Lite 규칙을 바꾸거나 실제 네트워크·추정한 TCP 의미를 추가하지 않는다.

## Progress

- [x] 2026-11-06: clean master `d8fcb3a`, 기존 trace의 fieldSources/byteSources/sourceRanges와 prefix·worker DTO 확인. `codex/stack-message-journey`에서 착수.
- [x] 출처·바이트 구간 대응과 유한 분석/DTO 구현.
- [x] 메시지/필드/byte 선택·네 단계 그림·기록 연결 UI 구현.
- [x] 실제 엔진의 정상/분할/ACK 손실/중복/부분·재생/큰 자료를 코어·두 브라우저·성능에서 검증.
- [x] 계약·문서와 완료 기록 갱신.

## Surprises & Discoveries

- payloadId는 실행 안의 같은 내용도 intern하며 같은 source event에 여러 변수/범위가 있을 수 있다. 내용/ID만으로 byte의 출처나 위치를 정할 수 없다. 이벤트에 명시된 출처와 typed slot의 위치를 함께 읽고 모호한 대응은 제한으로 남긴다.
- 앱 parsed의 sourceRanges는 여러 read의 실제 프레임 소비 순서다. 원본 프레임을 현재 코덱으로 다시 인코딩하지 않는다. ACK 등 byte를 운반하지 않는 후속은 데이터 경로와 별도 맥락이다.
- byte 창이 worker 조회 중 재생성되면 details가 닫히며 키보드 초점을 잃었다. 요청한 byte/필드 초점을 부모에 보존하고 응답 후 열린 창에 복원했다. 두 브라우저의 실제 ArrowRight와 좁은 화면 검사를 통과했다.
- 같은 출처 구간이 선택 byte 밖에 있는 것은 대응 누락이 아니다. 출처 관계를 해석할 수 있는 slot과 선택 구간이 실제 겹치는 span을 분리해 정상 필드 선택을 잘못 limited로 표시하지 않는다.
- peer의 stable field ID는 달라도 wire name은 호환될 수 있다. 복사 전달은 typed wire name으로 대응하고 표현식 출처는 해당 정의의 field ID를 유지했다. B의 payload ID를 바꾼 실제 왕복으로 검증했다.

## Decision Log

- 2026-11-06: schema 변경 없이 application의 읽기 전용 해석으로 구현한다. send의 fieldSources·transition의 byteSources·서비스/parsed의 sourceRanges 및 알려진 복사 이벤트의 직접 원인을 사용한다.
- 2026-11-06: 응용 송신별 추적을 분리하고 응답 송신을 요청과 같은 바이트로 취급하지 않는다. 선택 구간은 원본 프레임의 byte 좌표이며 필드 위치는 실제 기존 layout 분석이 가능한 경우에만 제공한다.
- 2026-11-06: worker에서 최대 4096 byte slot·32768 span·200000 대응 작업, 출력 20행·20필드·256 bytes로 제한한다. 원인 누락/모호함/분석 한도·history prefix·부분 실행을 명시한다. byte/필드 선택으로 기록 cursor를 자동 전진시키지 않는다.
- 2026-11-06: 연결 후보의 실제 bytes를 최대 4 MiB 대조한다. 같은 물리 범위의 알려진 직접 복사는 별도 복호화를 하지 않는다. 원본 base64의 제한된 위치만 읽어 byte 창을 만들며 DTO가 32768자 이상이면 표시 제한으로 반환한다.

## Outcomes & Retrospective

메시지 이동 경로를 구현하고 전체 로컬 검증을 완료했다. 실행/저장 schema와 엔진을 바꾸지 않고 실제 byte의 출처와 구간, 네 단계·제어 후속·원본 필드/byte 선택 및 기존 시퀀스 강조/명시적 재생을 연결했다. 모호한 같은 내용의 연속 송신은 제한으로 남긴다. 실제 네트워크·TCP 의미 추정·새 production dependency는 포함하지 않는다. 원격 전달은 정확한 최종 commit의 CI로 따로 확인한다.

## Context and Orientation

`src/engine/stack-data.ts`와 scheduler는 byte 출처를 기록한다. `stack-replay.ts`가 검증된 frozen prefix를 만들고 `stack-panel-model.ts`가 worker의 bounded UI DTO를 만든다. `StackRunPanel.tsx`의 공유 선택을 사용하며 main에 전체 자료를 재전송하지 않는다.

## Plan of Work

1. `stack-message-journey.ts`에서 typed byte slot과 실제 출처의 구간 대응을 계산한다. 출처 없는 같은 값, 타이머 제어와 응답의 새 인코딩은 byte 연결로 승격하지 않는다.
2. 선택 송신·필드/구간, paged 관련 관찰·네 단계 그림과 byte 창을 UI에 연결한다. highlight 선택은 현재 prefix를 유지하고 명시적 재생만 실제 cursor로 이동한다.
3. 실제 catalog와 큰 프레임 fixture에서 trace/bytes 원본 보존·분할/재송신·복제/다중 write·미관찰/누락/버전/한도를 검사한다. Chromium/Firefox의 키보드·1440/768/390px·reload/frozen snapshot과 같은 P7 상한을 검증한다.

## Validation and Acceptance

Node 24.18.0·pnpm 9.15.0의 명령은 [Development](../../development.md), 응답성은 [P7](../../design-docs/p7-validation.md)을 따른다. `pnpm check`·`git diff --check`와 실제 UI 캡처를 확인한다. 큰 스택 10k/1 MiB fixture의 기존 상한을 유지하고 journey 열기/선택 500ms·DOM 32768자·20행/256 byte 상한을 추가한다. 실패와 보완·환경·실측치를 여기에 기록한다.

최종 로컬 검증(2026-11-06, macOS·Node 24.18.0·pnpm 9.15.0):

- `/private/tmp/journey-check.log`의 전체 `pnpm check`가 lint/format/type·Node 538개(신규 18개)·Markdown 47개·build·Chromium/Firefox UI 278개(신규 8개)·native DB 14개·응답성 8개를 통과했다. 기존 fixture/상한과 20개 활성 중단점을 유지했다.
- 코어는 다섯 catalog의 양방향 실제 프레임·응답 분리·UTF-8 필드/구간·ACK 손실과 타이머 재송신/상위 read 미관찰·환경 복제·전체 손실/취소·prefix/구버전·동일/서로 다른 연속 write와 합쳐진 read·모호한 구간·shape 검사는 통과하지만 byte/목적지 위치가 다른 출처의 제외·dense 실제 자료의 분석 한도·필드 페이지·다른 peer field ID를 검사했다. 기록 JSON/bytes 원본이 그대로임을 확인했다.
- 두 브라우저는 1440/768/390px의 필드/byte 선택·ArrowRight 초점 유지·20행/256 byte 상한·기존 시퀀스 강조와 cursor 유지·HTTP 저장/초안 편집/새로고침/기록 재생·명시적 prefix 이동/미래 관찰 숨김을 통과했다. 최신 Chromium 1440과 Firefox 390 캡처를 직접 확인했다.
- 실제 스택 1 MiB: 전체 실행 1330ms, 이동 경로 열기 92ms·구간 변경 76ms·경로 DOM 3323자·rAF p95 16.7ms·최대 long task 0ms. 10k 타이머 기록: 실행 1890ms·byte 송신이 없는 경로 표시 81ms·rAF p95 16.8ms·최대 task 55ms. byte가 없는 fixture에 경로를 조작해 넣지 않았다. 기존 20사례/200k trace·두 1 MiB/두 10k 비교와 legacy 1 MiB 저장 1383ms도 통과했다. CPU 1배 Chromium 156.0.8078.4의 해당 로컬 측정이다.
- 첫 성능 실행은 이미 마지막 위치에 있는 10k fixture의 비활성 `저장 시점` 버튼을 추가로 클릭해 테스트 timeout이 났다. 실제 cursor를 이전으로 옮긴 1 MiB 사례에서만 복귀하도록 바로잡고 전체 검사를 통과했다. 제품 시간·상한을 완화하지 않았다.

## Idempotence and Recovery

읽기 전용 분석으로 record/snapshot/artifacts를 변경하지 않는다. 탭/실행 전환 시 늦은 worker DTO를 폐기하고 선택한 root가 prefix에 없으면 미관찰로 표시한다. 오류는 기존 실행/저장 자료를 유지하며 내보내기·기존 재생을 막지 않는다.

## Artifacts and Notes

- [현재 스택 작업 공간](../../design-docs/s5-stack-workspace.md)
- [현재 구조](../../../ARCHITECTURE.md)

## Interfaces and Dependencies

StackPanelQuery에 optional journey 설정과 새 detail 종류를 추가한다. 저장 형식/실행 버전과 production dependency는 변경하지 않는다.
