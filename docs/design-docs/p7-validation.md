# P7 v1 검증·응답성·지원 범위

상태: Accepted
기준일: 2026-10-30
구현 범위: v1 수용 행렬의 전체 흐름, Chromium/Firefox 기능 검사, 키보드·화면 크기, 실제 상한 fixture와 CI 구성. 실제 네트워크·운영 배포·모든 기기의 성능 보증은 포함하지 않는다.

## 지원·검사 환경

데스크톱 Chromium과 Firefox를 첫 버전의 검증 대상으로 정한다. Playwright 1.64.1에 고정된 Chromium 156.0.8078.4와 Firefox 157.0의 실제 브라우저에서 같은 기능 검사를 실행한다. 로컬은 macOS arm64이며 CI는 Ubuntu 24.04다. Chrome/Edge 브랜드별·Safari/WebKit·실기기 모바일·스크린리더 조합은 검사하지 않았다. 390px은 좁은 레이아웃 검증이며 모바일 브라우저 지원 완료를 뜻하지 않는다.

실제 브라우저 프로젝트·전용 preview 서버·context 격리는 [Playwright 구성](https://playwright.dev/docs/test-configuration)을 참고했다. 키보드 skip link·본문 초점·Enter 활성화·오류 위치 이동/수정·native history range, 폼의 이름, 색 외의 결과 문구와 390/768/1440px의 가로 넘침을 검사한다. 전면적인 WCAG 적합성 인증이나 보조기기 실사용 검증은 아니다.

## 실행·표시 비용

[실행 화면](../../src/ui/App.tsx)은 첫 16개 queue 처리까지 batch 1로 흐름을 보여주고 이후 batch 64를 사용한다. batch 사이 40ms를 양보한다. 큰 메시지의 송신·수신을 초기 한 batch에 몰지 않는다. 가상 시간·난수·이벤트 순서는 그대로이며 queue budget에 따른 최종 기록의 결정성을 별도 검사한다. callback은 session runId로 차단한다. 원자적 한 규칙과 개별 1 MiB 메시지 비용은 batch 중간에 분할하지 않는다.

표시하는 trace 행은 페이지당 최대 200개다. 첫/이전/다음/최근 페이지와 선택 원인의 페이지로 이동할 수 있다. 메시지 필터도 전체 기록을 대상으로 하며 제한은 DOM 행에만 적용한다. history cursor를 바꾸면 해당 이벤트 상세·페이지를 함께 선택한다.

[JSON 미리보기](../../src/application/preview-json.ts)는 nodes 256·깊이 8·배열/객체 앞 32항목·문자열 예산 4096자·최종 DOM 16,384자로 제한하고 생략을 안내한다. 바이트 미리보기는 기존 8192바이트다. 전체 값·바이트·이벤트는 bundle에 남는다. 크기를 줄이려고 snapshot이나 결과를 자르지 않는다.

[불변 데이터 경계](../../src/domain/immutable-data.ts)는 자체 WeakSet으로 전체 동결을 확인한 native EngineView만 checkpoint와 안전하게 공유한다. 외부·mutable·얕게 Object.freeze한 객체는 captureRun에서 복사한다. 임의의 얕은 freeze를 deep immutable로 신뢰하지 않는다. 엔진 의미 변경 없이 중복 structuredClone·동결을 줄이므로 engineVersion은 `0.1.0-p5`다.

## 응답성 기준과 측정 방법

아래 기준은 최초 baseline 실행 전에 테스트에 고정했다. 개선 뒤 기준을 완화하지 않았다. [성능 전용 config](../../playwright.performance.config.ts)는 1 worker·1440×900의 Chromium에서 기능 suite와 순차 실행한다. [fixture](../../tests/fixtures/large-experiments.ts)는 실제 규칙으로 trace 10,000개에 도달하는 timer 실험과 JSON Lines 프레임 정확히 1,048,576바이트의 한 방향 전송이다. 만들어 놓은 trace 배열을 UI에 끼워 넣지 않는다. 1바이트 초과 송신 차단과 batch 64/전체 실행 동등성도 Node에서 검사한다.

| 항목 | 통과 기준 |
| --- | --- |
| 전체 실행 완료/상한 도달 | 10,000ms 미만 |
| 메시지 필터 클릭·확인 | 200ms 미만 |
| 이벤트 선택→상세 표시 | 500ms 미만, 상세 DOM 32,768자 미만 |
| 기록 처음→저장 시점 이동 합계 | 500ms 미만 |
| 명시적 저장→transaction 완료 표시 | 3,000ms 미만 |
| 실행·상세·저장·기록 이동 구간 rAF frame 간격 p95 | 100ms 미만 |
| 같은 구간 최대 long task | 10k: 250ms 미만, 1 MiB: 1,000ms 미만 |

Node의 monotonic clock으로 Playwright 동작·확인까지 wall time을 재며 브라우저 rAF와 PerformanceObserver longtask를 함께 수집한다. 가상 시뮬레이션 timeMs를 성능 시간으로 사용하지 않는다. 결과는 console과 `test-results/performance-report.json` 및 attachment로 남긴다. 개발 머신/runner 부하·기기·브라우저 버전에 영향을 받으며 p95 frame과 최대 task를 함께 읽는다. 이 수치는 모든 사용자 기기의 보증치가 아니다.

최초 baseline은 10k 실행 37,513ms, 1 MiB 상세 2,436ms·DOM 11,534,460자·최대 task 1,969ms로 실패했다. 긴 실행의 인위적 batch 대기와 거대한 pretty JSON의 DOM/layout 비용을 확인했다. batch/페이지/미리보기와 불변 공유를 개선한 뒤 같은 기준으로 재검사한다. 실제 최종 수치·명령·검증 상태는 [실행 계획](../exec-plans/active/20261030-1641-layered-protocol-v1.md)의 P7 기록이 소유한다.

## CI와 증거

[GitHub Actions](../../.github/workflows/check.yml)는 master/codex branch push, master 대상 PR, 수동 실행을 받는다. contents read만 사용하고 checkout credential을 유지하지 않는다. 공식 actions의 고정 commit을 사용한다. .nvmrc의 Node와 pnpm 9.15.0, frozen lockfile, Chromium/Firefox와 OS 의존성을 설치하고 동일한 `pnpm check`를 실행한다. 실패 trace와 성능 report를 7일 보관하며 credential·실제 서버/기기 설정은 필요하지 않다. [Playwright CI 안내](https://playwright.dev/docs/ci-intro), [checkout](https://github.com/actions/checkout), [setup-node](https://github.com/actions/setup-node)를 참고했다.

workflow 파일 존재·로컬 검사·원격 job 결과는 별도 증거다. 최종 commit의 원격 CI 실행 여부/결과와 미실행 범위는 실행 계획·완료 응답에 명시한다. 배포 workflow나 실제 통신 검증은 구성하지 않는다.
