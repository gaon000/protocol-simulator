# 메시지 구조 시각화

상태: Completed
종료일: 2026-11-05

[ExecPlan 운영 규칙](../index.md)을 따른다.

## Purpose / Big Picture

선택한 실행 메시지의 필드 구조와 실제 전송 표현을 연결한다. HTTP 시작 줄·헤더·본문, JSON envelope/필드/구분자와 논리 패킷을 구분하고 영역/필드를 선택해 실제 바이트 범위를 강조한다. 수신 청크·해석된 값·실제 송신 바이트의 관찰 경계를 유지한다.

## Progress

- [x] clean master와 코덱·이벤트/시퀀스·snapshot/prefix 계약 확인, feature branch 생성.
- [x] DOM 없는 구조 projection·실제 byte range와 코어 11개 통과. 전체 코어 305개도 통과.
- [x] 영역/필드 선택·hex/ASCII 페이지·기존 공유 선택 연결과 새 Chromium/Firefox 14개 통과. 기존 시퀀스 12개는 앞선 실행에서 모두 통과.
- [x] 계약/구조 문서·전체 검사·응답성·완료 기록과 Git 전달 준비. 최종 `pnpm check`: Node 305·문서 36·Chromium/Firefox E2E 196·응답성 2개 통과.

## Surprises & Discoveries

- JSON 코덱은 모든 사용자 필드를 fields object에 직렬화한다. header/body/payload 배치는 논리 분류이며 실제 JSON wire 순서와 다를 수 있으므로 고정 byte header를 만들어내지 않는다.
- parsed/deliver에는 메시지 값만 있고 수신 receive는 청크 또는 논리 패킷을 보존한다. 수신 청크를 송신 원본의 완전한 메시지로 대체하지 않는다.
- HTTP raw 예제는 의도적으로 잘못된 메시지를 전송한다. 구획 표시와 코덱 유효성 판정을 구분한다.
- 첫 브라우저 검사는 24개 통과 후 HTTP split의 두 검사에서 선택 대상이 200행 기록 페이지 밖에 있어 timeout했다. 실제 기록 페이지로 이동한 뒤 선택하도록 테스트를 보강한다. 제품 pagination 한도나 timeout은 변경하지 않는다.
- 두 번째 검사는 같은 split 예제의 parsed method를 GET으로 가정해 실패했다. 실제 예제는 POST이므로 fixture와 일치시켰다. 나머지 24개는 두 실행 모두 통과했고, 새 기능 14개를 재실행해 모두 통과했다.
- Vite는 단일 JS chunk가 약 507 kB(minified, gzip 약 152 kB)로 500 kB 권고를 넘는 advisory를 출력한다. 신규 dependency는 없고 숫자 경고 기준을 변경하지 않는다. 실제 응답성은 기존 fixture와 새 열린 패널 검사로 확인한다.

## Decision Log

- 2026-11-05: read-only application projection과 lazy 실행 패널을 추가한다. 선택은 기존 event ID를 사용하고 현재 snapshot/prefix만 읽는다. engine/trace/storage 형식·dependency는 변경하지 않는다.
- 2026-11-05: HTTP 송신은 관찰 bytes의 시작 줄/헤더 경계와 본문 범위를, 작은 완전한 JSON 송신은 실제 token 범위를 표시한다. 큰 JSON/수신 청크/지원하지 않는 버전은 원시 바이트와 명시적 제한을 제공한다. 값만 있는 이벤트에는 전송 bytes를 재생성하지 않는다.
- 2026-11-05: 분석 prefix 32768 bytes·필드/영역 각 128개·목록 20개·hex/ASCII 256 bytes/page로 제한한다. 1 MiB 본문과 전체 원본은 복사하지 않고 실제 범위를 참조한다.

## Outcomes & Retrospective

HTTP 시작 줄/헤더/본문·JSON 실제 token/LF·논리 패킷의 필드 구조와 영역/필드 선택·실제 byte 강조·hex/ASCII 페이지를 구현했다. UTF-8/escape·수신 청크/값만 있는 기록·큰 JSON·raw HTTP·과거 prefix/스키마 격리를 보존한다. engine/trace/storage 형식과 dependency는 변경하지 않았다.

최종 로컬 `pnpm check`에서 Node 305개·문서 36개·Chromium/Firefox E2E 196개·열린 패널의 응답성 2개가 통과했다. 실제 HTTP와 390px screenshot의 구획·필드/byte 강조·내부 스크롤/줄바꿈을 확인했다. 원격 Git/CI 상태는 실제 전달 결과로 보고한다. 전체 HTTP/TCP·임의 binary encoding·실제 네트워크·배포는 범위 밖이다.

## Context and Orientation

`message-codecs`/`http-codec`가 실제 wire 표현을 소유한다. `sequenceProtocol`/`traceMessage`는 frozen actor schema와 메시지를 참조한다. App은 선택 event와 history cursor를 소유한다. 새 application projection은 DOM 없이 범위·필드를 제공하며 UI는 기존 선택과 병행해 유한 페이지로 보여준다.

## Plan of Work

1. HTTP/JSON/논리 packet·값 전용/청크의 구조와 실제 범위를 투영한다. 잘못된/큰 데이터와 unsupported/prefix 경계를 검사한다.
2. 실행 패널에 영역/필드 선택·범위 강조와 byte 페이지·값/배치/필수/타입을 연결한다.
3. 실제 코덱 결과·UTF-8·escape·default/false/0·header/body·기록 복원·390px/키보드·큰 fixture를 검증한다.
4. 제품/구조 문서와 전체 `pnpm check`·변경 공백 검사·최종 전달을 마무리한다.

## Validation and Acceptance

Node 24.18.0 / pnpm 9.15.0. Node 단위/통합·실제 Chromium/Firefox·기존 10k/1 MiB fixture의 열린 구조 패널·lint/format/type/build/docs·git diff 검사를 수행한다. 기존 입력/저장/프레임 상한은 유지하며 새 구조 검사에 500ms·32768자 상한을 적용한다.

최종 macOS 로컬 Chromium 156.0.8078.4 / CPU rate 1 결과: 10k 실행 3507ms·제어 54ms·연동 59ms·설명 57ms·진단 65ms·구조 64ms/403자·저장 71ms·cursor 107ms·frame p95 16.8ms·최대 long task 0ms. 1 MiB 실행 359ms·제어 36ms·연동 59ms·설명 72ms·진단 66ms·구조 67ms/1465자·저장 305ms·cursor 62ms·frame p95 16.8ms·최대 long task 133ms. 1 MiB 전체 원본과 끝 byte 접근을 유지하면서 byte DOM은 256개 이하로 제한했다. 기존 fixture·상한을 완화하지 않았다.

## Idempotence and Recovery

구조 조회·선택은 메시지를 재전송하거나 저장 기록/초안을 변경하지 않는다. 실행/이벤트 교체 시 해당 context에서 선택을 해석하며 현재 prefix 밖의 데이터를 노출하지 않는다. 기존 저장/복구 계약을 유지한다.

## Artifacts and Notes

제품 기준은 [제품 명세](../../product-specs/protocol-simulator-v1.md)에 갱신한다. 실제 결과와 한계는 이 계획에 기록한다.

## Interfaces and Dependencies

새 application API와 UI를 추가한다. 코덱·엔진·공개 저장 형식·production dependency는 유지한다. 임의 binary codec·전체 HTTP/TCP 지원은 추가하지 않는다.
