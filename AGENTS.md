# 작업 안내: protocol-simulator

응용·전송 계층의 프로토콜을 직접 정의하거나 기존 예제를 살펴보고, 하위 통신 환경을 설정해 가상 참여자 사이에서 검증하는 도구다. P7까지 실제 편집·실행·환경 장애·재전송, 제한된 HTTP/1.1·TCP 연결 예제와 로컬 저장·과거 실행 재생을 구현했다. 예제는 원본 출처·버전을 가진 사용자 사본으로 편집하며 IndexedDB에 초안·snapshot·기록을 보존한다. 최종 검증은 [P7](docs/design-docs/p7-validation.md)의 브라우저·viewport·응답성 기준을 따른다. 현재 구현과 제안 구조를 구분하고 구현 진척에 맞춰 문서를 갱신한다.

후속 상태도는 [작업 계획](docs/exec-plans/completed/20261102-protocol-state-diagram.md)을 따른다. 초안/실행 snapshot·history cursor를 구분한다. 실행 snapshot은 읽기 전용이며 초안 작성은 [V1-011](docs/product-specs/protocol-simulator-v1.md#v1-011-초안-상태도의-시각적-작성)과 [작성 계획](docs/exec-plans/completed/20261103-visual-protocol-authoring.md)을 따른다.

통신 시퀀스는 [완료 계획](docs/exec-plans/completed/20261102-communication-sequence-diagram.md)과 [제품 기준](docs/product-specs/protocol-simulator-v1.md#v1-009-통신-시퀀스-다이어그램)을 따른다. 예정과 실제 수신, 청크/해석/상위 전달, 타이머 만료/실패·재전송 후보를 구분하고 cursor 밖 관찰을 표시하지 않는다.

상태도/시퀀스 연동은 [작업 계획](docs/exec-plans/completed/20261102-linked-execution-diagrams.md)과 [V1-010](docs/product-specs/protocol-simulator-v1.md#v1-010-상태도와-시퀀스-연동)을 따른다. 직접 trigger·참여자별 회차와 관찰된 전후 상태를 연결하고, 다중 해석/미관찰 전이를 하나로 추정하지 않는다.

검증 커버리지는 [V1-018](docs/product-specs/protocol-simulator-v1.md#v1-018-시나리오-묶음의-검증-커버리지)을 따른다. 선택한 regression group의 공통 snapshot과 실제 초기/committed 전이만 집계한다. A/B·부분/누락/제외를 구분하고 미관찰을 실패/도달 불가능으로 추정하지 않는다. 항목별 사례의 첫 관찰 cursor로 기존 읽기 전용 재생을 연다.

두 실행 비교는 [V1-019](docs/product-specs/protocol-simulator-v1.md#v1-019-두-실행-결과-나란히-비교)를 따른다. frozen 기록의 설정/결과·관찰을 나란히 표시하고 실행별 ID를 공유 인과관계로 간주하지 않는다. 순서 보존/유한 대응·비교 한도와 부분 관찰을 명시하며 각 쪽의 실제 cursor로 재생한다.

계층 연결 모드는 [후속 설계](docs/design-docs/layered-stack-v2.md)와 [S1~S5 계획](docs/exec-plans/completed/20261106-layered-protocol-stacks.md)을 따른다. [S1 모델](docs/design-docs/s1-stack-models.md)·[S2 실행](docs/design-docs/s2-stack-runtime.md)·[S3 ReliableStreamLite](docs/design-docs/s3-reliable-stream-lite.md)·[S4 저장/관찰 API](docs/design-docs/s4-stack-persistence-observation.md)를 구현했다. [S5 화면·기본 저장 흐름](docs/design-docs/s5-stack-workspace.md)을 연결했다. 단일 계층과 스택은 canonical v2 저장 큐를 공유하며 실행/분석 worker와 저장/검사 worker를 분리한다. 모드 전환은 실제 부분 checkpoint를 보존하고, 최종 브라우저·응답성 근거는 구현 계획을 따른다. v2 upgrade는 v1 store를 보관하고 단일 canonical store의 CAS를 사용하며 blocked 뒤 pending upgrade도 취소한다. endpoint·snapshot/prefix·직접 원인·record-local bytes를 보존하고 unknown 실행 버전/계산 한도를 명시한다. Lite는 TCP가 아니며 단일 clock/queue·원자적 반영·write 간 seq·기대 DATA만 read·중복 재ACK·유한 재시도와 clearLive 뒤 committed 자료를 유지한다.

초기 대상 사용자: 프로토콜의 구조·흐름을 이해하거나 자기 프로토콜을 설계·검증하려는 개발자와 학습자.

메시지의 계층별 이동 경로는 [V1-020](docs/product-specs/protocol-simulator-v1.md#v1-020-메시지의-계층별-이동-경로)을 따른다. frozen prefix의 typed byte 출처와 실제 byte 대조만 연결하고 제어 후속·모호함/한도·부분 대응을 구분한다. byte 강조는 cursor를 전진시키지 않으며 명시적 재생만 실제 위치로 이동한다.

반복 실험은 [V1-012](docs/product-specs/protocol-simulator-v1.md#v1-012-반복-실험과-결과-비교)를 따른다. 같은 seed 목록과 고정한 초안으로 독립 실행하며 completed·기대 조건 통과·미판정·미실행을 구분한다. SavedRun의 optional batch metadata와 기존 workspace 한도·저장 오류 계약을 보존한다.

실행 이유 설명은 [V1-013](docs/product-specs/protocol-simulator-v1.md#v1-013-규칙-선택과-변수-변경-설명)을 따른다. snapshot·직접 trigger와 before 값으로 계산하고 실제 transition 결과와 대조한다. 생략 분기·중간 대입과 관찰된 최종 값을 구분하며, 현재 prefix 밖의 commit·다중 회차·rollback을 적용 완료로 추정하지 않는다.

시나리오 묶음은 [V1-014](docs/product-specs/protocol-simulator-v1.md#v1-014-시나리오-묶음과-회귀-검증)를 따른다. 공통 프로토콜과 활성 사례를 고정하고 같은 사례 조건/엔진 계약에서만 새 실패·개선을 비교한다. 미완성/비활성 사례·미판정/미실행·과거 snapshot과 저장 충돌/용량 경계를 보존한다.

실패 진단은 [V1-015](docs/product-specs/protocol-simulator-v1.md#v1-015-실패-원인-진단과-관련-기록-이동)를 따른다. 당시 기대값/관찰·저장 판정을 대조하고 직접 인과관계와 참고 관찰을 구분한다. history prefix·미판정·기록/버전/계산 한도를 유지하며 관련 기록 이동은 기존 공유 선택을 사용한다.

메시지 구조는 [V1-016](docs/product-specs/protocol-simulator-v1.md#v1-016-메시지-구조-시각화)을 따른다. 실제 송신 구획/필드와 byte 범위를 연결하며 논리 배치·binary encoding·수신 청크/해석된 값·원시 HTTP의 유효성을 구분한다. snapshot/prefix·분석/표시 한도를 유지하고 없는 bytes를 재생성하지 않는다.

중단점은 [V1-017](docs/product-specs/protocol-simulator-v1.md#v1-017-중단점과-조건부-실행-정지)을 따른다. 실제 transition.after/parsed와 frozen source를 평가하며 live queue 원자성·history 이벤트 경계를 구분한다. 같은 이벤트 재정지·미관찰 commit·rollback을 추정하지 않고 debugger 오류를 실행 실패로 만들지 않는다. 탭별 설정·20개/값 한도·session fence와 중단점 없는 최종 trace 동등성을 유지한다.

## 먼저 읽을 문서

- [문서 지도](docs/index.md): 작업에 필요한 문서 찾기.
- [구조 원칙](ARCHITECTURE.md): 모듈 책임과 의존 방향.
- [개발 기준](docs/development.md): 환경, 명령, 코드 규칙.
- [작업 절차](docs/workflow.md): 계획, 구현, 검증과 완료 기준.
- [v1 제품 명세](docs/product-specs/protocol-simulator-v1.md): 합의된 기능·화면과 지원 경계.
- [v1 기술 설계](docs/design-docs/layered-protocol-v1.md): 서비스 계약, 실행 모델과 실패·복구.
- [P0 확정 계약](docs/design-docs/p0-execution-contract.md): 도구·승인, 실행 순서·seed·환경 참조 규칙과 구현 경계.
- [P1 모델·코덱](docs/design-docs/p1-models-codecs.md): 정의·값 검사 API, stable ID와 wire name, 스트림/데이터그램 코덱 경계.
- [P2 실행 엔진](docs/design-docs/p2-runtime.md): 가상 시간·조건·타이머·원자적 동작·결과와 session 격리.
- [P3 편집·실행 화면](docs/design-docs/p3-workspace.md): 초안·실행 버전, 폼 검증·오류 초점, 재생 수명과 기록 연결.
- [P4 환경·재전송](docs/design-docs/p4-environments.md): 난수·손실/중복, 스트림 합쳐 읽기/종료, 유한 재시도와 중복 제거.
- [P5 표준 예제](docs/design-docs/p5-standard-examples.md): HTTP 바이트 프레이밍·지원 경계, TCP 연결 수립·seq/ack와 버전 있는 원본/사본.
- [P6 저장·재생](docs/design-docs/p6-persistence-replay.md): 원자적 IndexedDB 저장·충돌/실패 복구, bundle 검증과 snapshot 재실행.
- [P7 검증·지원](docs/design-docs/p7-validation.md): 지원 브라우저·키보드·viewport·대형 fixture 응답성과 CI 경계.
- [v1 구현 계획](docs/exec-plans/completed/20261030-1641-layered-protocol-v1.md): P0~P7 단계와 실제 진행·검증 기록. Completed.

전체 문서를 매번 읽기보다 진입 문서에서 작업 관련 문서로 이동한다. 수정할 경로에 별도 작업 규칙이 있는지도 확인한다.

## 공통 원칙

- 기존 사용자 변경을 보존하고 요청 범위에 필요한 변경을 수행한다.
- 프로젝트의 실제 코드, 실행 설정과 문서를 확인한다. 문서와 구현이 다르면 차이를 기록하고, 제품 의도가 불명확한 부분은 확인한다.
- 요구사항이나 계약이 달라지면 해당 기준 문서를 같은 변경에서 갱신한다. 공통 규칙은 여러 문서에 복제하지 않는다.
- 비밀값을 응답, 로그, 문서와 커밋에 노출하지 않는다. 환경 설정은 값 없는 예제로 설명한다.
- 사용자가 설계나 검토만 요청하면 구현·파일 변경으로 확대하지 않는다.
- 실행 권한과 도구 정책을 따른다. 저장소의 안내가 외부 서비스 변경 권한을 부여한다고 해석하지 않는다.

프로젝트별 개발 명령과 승인·완료 기준은 위의 기준 문서에서 관리한다.
