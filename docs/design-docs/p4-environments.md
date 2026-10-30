# P4 장애 환경과 재전송

상태: Accepted
기준일: 2026-10-30
구현 범위: 데이터그램 장애·스트림 합쳐 읽기/종료, 순서 번호·ACK·타이머·유한 재시도를 가진 사용자 정의 예제와 환경 폼. 실제 네트워크와 TCP 구현이 아니다.

## 환경 조합과 버전

[createSimulation](../../src/application/create-simulation.ts)은 검증된 snapshot, 새 seed PRNG, snapshot의 상한을 [createEnvironment](../../src/environments/simulated-environment.ts)에 주입한다. 환경은 메시지·ACK·상위 전달 의미를 해석하지 않는다. P2의 [createIdealEnvironment](../../src/environments/ideal-environment.ts)는 명시적으로 주입할 수 있는 이전 이상적 adapter로 유지한다.

P4 단계 실행 버전은 `0.1.0-p4`였으며 현재 코덱·버전은 [P5 계약](p5-standard-examples.md)을 따른다. 정의 schemaVersion 1과 mulberry32-v1은 유지하고, 환경 동작·기록·스트림 처리 순서가 달라졌으므로 engineVersion을 올렸다. 이전 엔진의 trace와 동일하다고 주장하지 않는다. 설정은 여전히 불변 snapshot에 포함한다.

## 데이터그램

[P0 참조 계약](p0-execution-contract.md#데이터그램-환경의-참조-계약)을 실제 adapter에 적용했다.

1. 방향·원본 송신 순번의 특정 손실을 먼저 검사한다. 적용되면 난수를 소비하지 않는다. 최초 송신과 각 재전송은 다른 순번이다.
2. 그 외에는 손실·중복·원본 지연·사본 지연 순서로 항상 4회 추출한다. 손실이어도 4회 소비하며 비교는 sample < probability다.
3. 생존한 원본은 한 번 전달하고 중복이면 사본 하나만 추가한다. 사본을 다시 복제하거나 손실 판정하지 않는다.
4. 지연은 max(0, baseDelayMs + round((2 × sample - 1) × jitterMs))다. 안전한 정수 범위를 벗어나는 시각은 정상 전달로 사용하지 않는다.
5. 엔진 큐가 도착 시각·생성 순번으로 정렬한다. 사본이나 뒤의 재전송이 먼저 도착할 수 있다.

환경 판정 이벤트에 방향·송신 순번·결과·사용한 draws·예정 도착들을 기록한다. 각 수신에는 original/duplicate, 송신 순번과 원인 send ID가 남는다. 각 사본과 호출자 payload의 메모리도 분리한다. seed 42의 실제 결과는 독립적인 [P0 참조 fixture](../../tests/fixtures/datagram-reference.json)의 사본 111ms·원본 113ms와 일치한다.

## 스트림

방향별로 이미 예약한 바이트보다 앞서 도착하지 않도록 하고, 같은 방향·같은 도착 시각에 대기 중인 write들을 생성 순서대로 묶는다. 예약한 stream-read를 처리할 때 그룹을 닫고 chunkBytes 크기와 마지막 나머지로 읽는다. 다른 시각의 write를 합치려고 기다리지 않는다. 이미 읽은 뒤 동일 시각의 인과적 피드백으로 생성된 write는 새로운 그룹이다. 아직 생성되지 않은 write를 과거의 읽기에 합치지 않는다.

[환경 포트](../../src/engine/environment-port.ts)의 stream-read marker/readStream은 이 지연된 읽기를 표현한다. 하나의 읽기 그룹에서 생성한 청크는 순서대로 처리하고 각 수신 trace에 해당 청크를 구성한 sourceEventIds를 기록한다. 청크가 두 write에 걸치면 양쪽 send로 이동할 수 있다. 수신 청크·write·프레임 경계를 동일시하지 않는다.

대기 바이트는 snapshot의 maxTraceBytes 이내로 제한한다. 초과는 environment-buffer-limit와 limit-reached로 종료하며 모든 기대 조건은 미판정이다. 정상 종료·취소·상한 종료는 adapter의 dispose를 호출해 대기 그룹을 해제한다. 이미 시작한 iterator도 해제 이후 추가 청크를 만들지 않는다. 사용자 정의 환경에도 readStream/dispose를 선택적으로 주입할 수 있다.

연결 이벤트는 방향별 수신의 종료다. AtoB면 B에, BtoA면 A에 전달한다. 재연결을 모델링하지 않으므로 방향별 종료/실패는 한 번만 허용한다. 종료 시각에 도착하거나 이후 도착할 바이트는 전달하지 않고 원인 send와 cutoff를 기록한다. 그 전에 수신한 접두부는 유지된다.

close는 정상 EOF로 코덱 finish를 호출해 미완성 프레임을 진단한다. fail은 코덱 abort로 버퍼를 해제하고 별도의 failed 연결 이벤트를 프로토콜 규칙에 전달한다. 연결 실패를 정상 EOF의 미완성 프레임 오류로 바꾸지 않는다. 종료/실패를 어떻게 처리할지는 사용자가 규칙으로 정의한다.

## Stop-and-wait 예제

[stop-and-wait.ts](../../src/examples/stop-and-wait.ts)는 한 번의 A → B 상위 입력을 전달한다. 양쪽은 같은 정의를 사용하지만 상태와 변수는 독립적이다. logical-packet은 구조화한 개념 패킷이며 실제 TCP/IP 인코딩이 아니다.

| 역할 | 동작 |
| --- | --- |
| 송신자 | waitingSeq와 pending을 보관하고 DATA 송신·ACK 타이머 시작 |
| 수신자 | seq == expectedSeq일 때만 상위 전달하고 expectedSeq 증가·ACK 송신 |
| 중복 DATA | seq < expectedSeq이면 ACK만 재송신하고 다시 상위 전달하지 않음 |
| 미래 DATA | seq > expectedSeq이면 명시적으로 무시. 무조건 ACK/전달하지 않음 |
| ACK | waitingSeq와 일치해야 타이머 취소·Done. 다른 ACK는 무시 |
| timeout | retries < maxRetries면 같은 대기 데이터 재전송·타이머 재시작. 소진 시 Failed |
| 늦은 ACK | Done/Failed 뒤에는 명시적으로 무시하고 종료를 되돌리지 않음 |

initialSends와 retries를 따로 기록한다. 기본 상한은 최초 송신 1회 + 재시도 최대 3회, timeout 100ms다. 모두 유실되면 400ms에 Failed가 된다. maxRetries 0도 최초 송신은 한 번 수행한다. nextSeq·waitingSeq·expectedSeq와 대기 데이터가 실제 식·조건·동작으로 연결되며 ACK를 받았다는 사실만으로 상위 전달을 추가하지 않는다.

기본 관찰 기간 800ms 전체에서 B의 상위 DATA 전달 횟수·내용, A의 최종 상태·완료 기한을 검사한다. 정상 결과를 기대하는 실험에 손실을 설정하면 실패 판정을 볼 수 있고, 원하는 Failed/0회 기대 조건으로 편집하면 예상한 실패 자체를 검증할 수 있다. 지속적인 다중 메시지 전송·양방향 동시 전송·윈도·전체 TCP는 이 예제의 지원 범위가 아니다.

## 화면과 편집

실험 시작에서 재전송 실험 새 사본을 연다. [환경 폼](../../src/ui/EnvironmentEditor.tsx)은 방향별 지연, datagram 변동/손실/중복/특정 손실, stream 청크/연결 이벤트와 seed를 편집한다. 같은 하위 서비스 안에서 계층·코덱을 변경하면 설정한 장애를 유지한다. 서비스 종류를 바꾸면 새 서비스의 호환 설정으로 전환한다.

실행 보기는 환경 판정과 원인 send, 중복 사본, 합쳐진 청크의 각 원인과 최초 송신/재시도 횟수를 실제 기록으로 표시한다. 기존 초안/snapshot·정지/초기화 계약은 [P3](p3-workspace.md)를 따른다. 공유된 예제 필드 객체를 하나의 폼에서 편집해 다른 메시지까지 바뀌던 alias 문제를 발견해, 경로별 copy-on-write와 회귀 검사로 수정했다.

## 검증

- [환경 단위 검사](../../tests/unit/environments.test.ts): 실제 P0 벡터, 특정/확률 손실의 draws, 확률 경계·사본 격리, 합쳐 읽기·분할·방향·서로 다른 시각·인과적 새 그룹, 종료 경계·대기 바이트·해제.
- [장애·전송 통합 검사](../../tests/integration/fault-environments.test.ts): DATA/ACK 손실, 중복·두 종류의 순서 역전, 잘못된 ACK·미래 DATA, 늦은 ACK·상한/0회 재시도, 같은 seed 전체/단계/묶음 기록, 20 seed의 중복 제거, 스트림 전체 바이트·메시지 불변식, EOF/실패·자원 판정·취소·편집 격리.
- EOF/실패의 불완전 접두부 검사는 정상 adapter 앞에서 raw write를 일부러 자르는 테스트 포트를 사용한다. 이는 코덱·환경 경계 검증이며 사용자용 데이터 절단 기능이나 실제 연결 장애 재현이라고 주장하지 않는다.
- [실제 Chromium E2E](../../tests/e2e/fault-environments.test.ts): 정상/ACK 손실 비교, 최초/재시도와 1회 전달, 유한 실패, seed 재현·확률 오류 차단, 작성한 연결 규칙과 cutoff, 합쳐진 청크의 두 원인 이동.

최종 명령·수집 수·master 반영은 [실행 계획](../exec-plans/active/20261030-1641-layered-protocol-v1.md)에 기록한다. 새 production dependency·실제 소켓·원격 CI·배포는 추가하지 않았다.
