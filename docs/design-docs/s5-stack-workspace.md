# S5 스택 작업 공간과 기본 저장 흐름

상태: Accepted
기준일: 2026-11-06

[계층 연결 설계](layered-stack-v2.md)의 두 계층·네 인스턴스와 [S4 저장/관찰 API](s4-stack-persistence-observation.md)를 실제 편집·실행 화면에 연결한다. 최종 수치와 완료 여부는 [실행 계획](../exec-plans/completed/20261106-layered-protocol-stacks.md)이 소유한다.

## 진입과 편집

상단의 단일 계층/계층 연결 스택 전환은 하나의 v2 workspace를 공유한다. 모드를 떠날 때 진행 중인 실행과 묶음을 중단하고 실제 부분 checkpoint를 보존한 뒤 저장한다. 가상 실행의 코어·snapshot은 단일 계층과 스택 사이에 변환하지 않는다. 선택 모드는 sessionStorage에 보관하며 사용할 수 없으면 메모리에서 동작한다.

초기 저장 자료를 읽는 동안 로딩 상태를 표시하고 두 모드의 작업 영역을 잠근다. 복원으로 예제 목록과 초안이 바뀌는 사이의 입력·클릭은 받지 않는다. 로딩 실패 후에는 보존한 메모리 자료로 편집과 복구를 제공한다.

스택 예제는 Ping/Pong, 첫 ACK 손실, 제한된 HTTP GET/POST, 1바이트 분할의 버전 있는 사용자 사본이다. 원본 출처·지원/생략 범위를 함께 표시한다. A/B의 응용·전송 카드, exact 정의 revision, 로컬 서비스 binding과 하위 패킷 링크를 편집한다. 메시지·상태·규칙·변수·타이머·포트 계약과 입력/기대 조건의 endpoint, seed·양방향 지연/손실/중복을 작성할 수 있다. JSON 규칙은 해석할 자료이며 코드를 실행하지 않는다.

정의 편집은 revision을 증가시키고 정확히 이전 정의를 참조한 인스턴스만 다시 연결한다. 한 인스턴스의 ID 변경은 그 참여자의 binding/link/scenario 참조를 함께 변경한다. 메시지와 패킷 스키마는 별개의 계약이다. 양쪽 패킷 형식 맞추기는 같은 서비스 identity를 가진 두 peer에 대한 명시적 편집이다. 잘못된 참조를 다른 정의로 추정해 편집하지 않는다.

문법·유한 값·필수 구조가 미완성인 JSON은 마지막으로 렌더링 가능한 값과 별도의 raw에 남기고 실행을 막는다. 정상 형태의 다른 유효 JSON은 config와 raw가 어긋나도록 가져올 수 없다. 16,384자를 넘는 JSON 편집 값은 입력창에 펼치지 않고 전체 bundle에 보존한다. 진단은 해당 입력 또는 가장 가까운 그룹으로 초점을 이동한다. 대형 상태/규칙 목록은 유한 페이지로 표시한다.

규칙의 이벤트·조건·동작은 [V1-021](../product-specs/protocol-simulator-v1.md#v1-021-스택-규칙의-조건동작-폼-편집)의 선택 폼으로 작성한다. 기존 JSON과 같은 경로를 편집하고, 동작/하위 분기의 순서 변경은 pending raw까지 함께 이동한다. 현재 이벤트의 값 범위와 native/기존 응용 문법을 구분하며 미완성 상위 JSON을 폼으로 덮어쓰지 않는다. 상세 표시 한도와 검증 근거는 [작성 계획](../exec-plans/completed/20261106-stack-rule-forms.md)을 따른다.

후속 [새 작성 흐름](../product-specs/protocol-simulator-v1.md#v1-022-새-스택-만들기)은 별도 검토 후 native 응용 정의와 명시적 전송 시작점을 추가한다. `WorkspaceRoot`의 탭별 이력은 config/raw만 보관하고 canonical controller에 소유한 불변 draft를 전달한다. 복원은 같은 ID의 여러 revision을 구분하는 새 identity로 참조를 함께 갱신한다. 일반 편집도 같은 ID의 최대 revision을 넘어 증가한다. 포트·변수/타이머·scalar/byte 초기값 폼은 기존 JSON/raw와 같은 경로를 사용한다. 저장 schema와 worker 실행 계약은 유지하며 상세 정책·검증은 [작성 계획](../exec-plans/completed/20261107-stack-authoring-workflow.md)이 소유한다.

[스택 초안 상태도](../product-specs/protocol-simulator-v1.md#v1-025-스택-초안-상태도의-시각적-작성)는 정의 편집 안에서 지연 렌더한다. application의 생성 경계가 현재 자료·pending raw와 endpoint/exact 정의를 대조한 뒤 기존 canonical 업데이트로 추가한다. 상태/규칙의 상위 리스트도 공통 raw remap을 사용한다. 공통 `StateDiagram`은 구조 배치와 native/v1의 유한 표현을 제공하고, `StackEditor`가 선택 항목의 폼을 목록 또는 옆 편집기 한 곳에 렌더한다. 스택 실행 그림/worker·저장 schema는 바뀌지 않는다.

## 실행과 관찰

스택 시나리오의 선택 폼은 `StackScenarioForm`·`StackScenarioMessage`가 소유하고 순수 `stack-scenario-authoring` helper가 현재 endpoint/exact revision과 유일한 선언을 찾는다. 시나리오 리스트도 기존 `editStackList`의 raw remap을 사용하며 모든 설정은 canonical 편집/이력을 거친다. 제품 계약은 [V1-026](../product-specs/protocol-simulator-v1.md#v1-026-스택-시나리오기대-조건의-폼-편집)을 따른다.

`StackWorkerClient`와 module worker가 실제 네 runtime을 소유한다. 전체/한 단계/정지/계속/취소는 runId로 격리한다. 새 실행은 정의·환경·입력/기대 조건을 고정하고 history 재실행은 선택한 저장 snapshot을 사용한다. worker가 실패하면 마지막 수신 관찰과 저장 자료를 유지한다. 실행 worker와 저장 worker는 다른 수명을 가진다.

worker가 이미 발행한 불변 관찰은 전체 자료를 다시 보내지 않고 관찰 버전 key로 조회한다. 같은 저장 ID의 이전 checkpoint와 새 checkpoint는 별도 key다. worker는 최근 64개만 보관하며, 폐기된 관찰 조회는 보유한 실제 원본을 다시 등록해 한 번 재시도한다. 이 내부 key는 실행 사이 인과관계를 나타내지 않는다.

live 관찰 발행도 한 ordered 채널의 증분 전송을 사용한다. 이전 runId·불변 snapshot과 실제 event 행/직렬화된 byte 객체 참조가 같은 prefix만 재사용한다. 새 header·event/payload suffix를 보내고 main은 새 자료만 동결해 완전한 readonly view를 복원한다. prefix 수정·축소·snapshot 교체는 전체 전송하며 serial·기준본이 다른 증분은 적용하지 않고 마지막 완전한 관찰을 보존한다. 이는 내부 전송 최적화이며 저장 snapshot·원본 bytes·worker 조회 key나 실행 인과관계는 바꾸지 않는다.

기록 위치는 0=초기 상태, 1..N=해당 이벤트까지, N+1=실제 저장 checkpoint다. 상태도·변수·기대 조건·시퀀스·원인·설명·구조·진단은 이 prefix를 따른다. 다른 위치의 늦은 응답은 적용하지 않는다. 중간 위치의 최종 판정과 기록되지 않은 버퍼 값을 추정하지 않는다.

전체/계층/인스턴스 시퀀스는 페이지당 30개 실제 관찰과 네 lifeline을 표시한다. 서비스 요청은 점선, 실제 수신은 실선이며 하위 송신·수락과 상대 앱 완료를 구분한다. 상태와 규칙 선택은 정확한 endpoint의 실제 관찰 회차로 연결한다. 이벤트의 직접 원인/후속 관찰과 관찰된 committed 전이는 별개다.

선택한 전이의 조건·순차 대입·관찰된 최종 변화를 대조한다. 메시지의 논리 필드, 실제 바이트 범위와 수신 청크/해석 값은 서로 다른 보기다. 원은 한 인스턴스의 관찰이며 실제 byte 창은 256 bytes, 필드/범위/근거는 유한 개수만 표시하며 큰 artifact의 나머지는 bundle에 남긴다. 진단은 직접 판정 근거·원인 경로·참고 관찰을 구분하고 각 실행의 실제 cursor로 이동한다.

endpoint별 포트 상태·상태/변수/타이머와 송신·해석·앱 전달 횟수를 보여준다. optional `instances[*].buffers`는 실제 codec/변수/포트 소유량이다. 저장 시점에만 전체 live bytes를 표시한다. 옛 기록이나 중간 prefix에 없는 버퍼는 기록되지 않음으로 표시한다. 옛 기록 재실행 비교는 옛 기록에 없던 optional 버퍼를 새 실패로 판정하지 않는다.

중단점은 탭의 메모리 설정 최대 20개이며 정확한 정의 revision에 연결한다. live는 원자적 operation 이후, 기록 자동 재생은 한 관찰 경계에서 조건을 검사한다. 같은 이벤트를 재평가해 계속 정지하지 않는다. debugger 계산 오류는 실행 실패가 아니다.

후속 [메시지 이동 경로](../product-specs/protocol-simulator-v1.md#v1-020-메시지의-계층별-이동-경로)는 응용 송신 wire를 기준으로 byte 출처를 네 단계에 연결한다. 필드/구간 강조와 기존 관찰 선택은 prefix를 유지하고, 명시적 재생만 해당 기록 위치로 이동한다. 분석/표시 예산과 실제 검증은 [해당 계획](../exec-plans/completed/20261106-stack-message-journey.md)이 소유한다.

## 묶음과 비교

반복 실험은 중복 없는 uint32 seed와 현재/첫 ACK 손실 환경을 같은 목록으로 실행한다. 조합은 최대 100회이며 저장 용량을 먼저 확인한다. 시나리오 묶음은 현재 환경·seed·입력/기대 조건을 사례로 보관한다. 사례를 초안에 불러와 수정한 뒤 같은 사례에 반영할 수 있다. 공통 프로토콜을 복제해 사례별로 다른 정의를 암묵 사용하지 않는다. 활성 사례는 최대 20개다. 각 실제 기록을 화면의 저장 목록에 반영한 뒤 다음 사례를 진행한다. 공유 한도를 넘으면 묶음을 중단하고 첫 미저장 관찰을 메모리에 남긴다. 기존 기록을 정리한 뒤 해당 실행을 저장 목록에 추가할 수 있다.

완료·통과·실패·미판정·미실행은 별도 집계다. 회귀 커버리지는 선택한 공통 source와 실제 초기/committed 상태·규칙만 집계한다. 각 사례의 첫 관찰 cursor로 재생한다. 사례/endpoint/미관찰 필터와 부분·누락·제외를 표시하며 미관찰을 실패나 도달 불가능으로 판단하지 않는다. 이전 회귀 묶음과의 새 실패/개선은 동일한 실제 사례 조건과 엔진 계약에서만 비교한다.

두 실행의 요약/설정·유한 순서 대응은 나란한 독립 열로 표시한다. 실행별 ID를 공유 원인으로 보지 않는다. 한도/다른 topology·버전/부분 관찰은 제한 또는 unavailable로 표시하고 각 쪽의 실제 cursor로 이동한다. 표와 그림은 390px에서도 내부로 스크롤한다.

## 기본 IndexedDB 전환과 복구

기본 진입은 `WorkspaceRoot`다. `legacy-workspace-facade`가 기존 App의 동작을 canonical v2 controller로 투영한다. DB 이름은 `protocol-studio`, 버전 2, 쓰기 store는 `workspace-v2/current`다. v1의 `workspace/current`는 S4의 원자적 upgrade에서 그대로 보관하고 이후 수정하지 않는다. 구형 writer는 VersionError로 차단된다.

기본 저장 adapter와 전체 자료 검사는 `workspace-storage-worker`에서 실제 native IndexedDB를 사용한다. controller는 async 검사를 기다리며 하나의 serial/CAS 저장 큐를 유지한다. 검사에 통과한 정확한 불변 자료는 worker 소유의 일회용 token으로 같은 저장 요청에 재사용한다. mutable 외부 자료와 매번 DB에서 읽은 자료는 이 cache로 건너뛰지 않는다. 검사/트랜잭션 성공 전에 저장됨을 표시하지 않는다. quota/abort/blocked/conflict/unknown 오류는 typed 실패로 돌아오며 메모리 자료를 보존한다. 명시적 재시도는 현재 canonical 데이터와 충돌한 항목을 사본으로 병합한다. 저장 불가 시에도 두 모드 편집과 내보내기는 가능하다.

저장 worker의 최근 두 검증본과 동일한 불변 실행 행은 위치 참조로 전송한다. 바뀐 행과 초안은 실제 값을 보내며, worker가 소유한 정확한 행을 복원한 뒤 전체 workspace 계약을 검사한다. 기준본이 없으면 전체 전송으로 재시도한다. 검증한 불변 JSON만 정확한 노드 수·상대 깊이를 재사용하며 더 작은 예산은 다시 검사한다. 같은 불변 legacy 관찰의 자체 의미 검사만 재사용하고 행 ID·묶음·용량·revision과 DB에서 새로 읽은 자료는 계속 검사한다. 저장 형식과 CAS 경계는 바뀌지 않는다.

소유 JSON 검사 때 정확한 compact JSON의 UTF-8 길이도 수집한다. 동결한 자료만 이 길이를 재사용하며 workspace root/legacy 영역의 64 MiB 검사는 같은 실제 크기를 사용한다. mutable/shallow freeze는 native 직렬화로 계산하고 더 작은 node/depth·fresh DB 검사와 실패 시 원본 미동결을 유지한다. 세부 실패/재검증은 [CI 후속 계획](../exec-plans/completed/20261107-stack-authoring-ci-validation.md)을 따른다.

내보내기는 기본으로 두 모드를 포함한 v2 bundle이다. v1 자료만 내보내기와 이전 v1 원본 복구 파일은 별도 명시적 동작이다. 가져오기는 전체 검사·충돌 remap을 staging한 뒤 적용한다. 초안 삭제는 과거 실행 snapshot을 지우지 않는다. 두 모드의 100개 초안/100개 기록/64 MiB 한도를 공유하고 자동 삭제하지 않는다.

## 검증 경계

실제 서버/기기, 전체 TCP/HTTP 표준 적합성이나 배포를 포함하지 않는다. [P7 기준](p7-validation.md)의 지원 브라우저·키보드·화면 폭과 기존 다섯 성능 fixture를 유지한다. 스택의 실제 10,000개 관찰·한 MiB 프레임·20사례 자료는 별도 검사하고, 최종 통과 근거는 실행 계획에 기록한다.
