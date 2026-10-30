import type { ExperimentDefinition } from '../domain/protocol-model.ts';
import { createHttpExperiment, type HttpVariant } from './http.ts';
import { createPingPongExperiment } from './ping-pong.ts';
import { createStopAndWaitExperiment } from './stop-and-wait.ts';
import { createTcpHandshakeExperiment } from './tcp-handshake.ts';

export type Example = {
  readonly id: string;
  readonly title: string;
  readonly version: number;
  readonly copyLabel: string;
  readonly description: string;
  readonly supported: readonly string[];
  readonly omitted: readonly string[];
  readonly sources: readonly { readonly title: string; readonly url: string }[];
  readonly expected: string;
  readonly diagnosticCodes: readonly string[];
  readonly build: () => ExperimentDefinition;
};
const httpSources = [
  {
    title: 'RFC 9112 · 형식과 프레이밍',
    url: 'https://www.rfc-editor.org/rfc/rfc9112.html#section-6.3',
  },
  { title: 'RFC 9110 · HTTP 의미', url: 'https://www.rfc-editor.org/rfc/rfc9110.html' },
];
const httpOmissions = [
  '전체 HTTP 호환성, TLS·HTTP/2·3, chunked·압축',
  'HEAD·CONNECT, 1xx·204·304, pipelining·다중 교환',
  '명시하지 않은 헤더, 중복 헤더·obs-fold·비 ASCII 헤더',
  '상태별 전체 의미·필수 헤더 검증과 파싱 오류의 자동 400 응답',
];
function httpExample(
  variant: HttpVariant,
  title: string,
  description: string,
  diagnosticCodes: readonly string[] = [],
): Example {
  return {
    id: `http_${variant.replaceAll('-', '_')}`,
    title,
    version: 1,
    copyLabel: `${title} 사본 만들기`,
    description,
    supported: [
      'GET·POST origin-form, Host, CRLF와 명시적인 Content-Length',
      '본문 UTF-8 바이트 길이와 분할 수신, 선언한 헤더·필드·규칙 편집',
      '정상 전송의 Content-Length는 본문에서 자동 계산; 오류는 원시 전송으로 실험',
    ],
    omitted: httpOmissions,
    sources: httpSources,
    expected: diagnosticCodes.length
      ? `수신자 파싱 진단 ${diagnosticCodes.join(', ')} · 송신자 timeout · 수신자 검사는 미판정`
      : variant === 'delayed'
        ? '클라이언트 500ms timeout · 늦은 응답을 상위에 전달하지 않음'
        : '양쪽 Done · 응답 1회와 본문 일치',
    diagnosticCodes,
    build: () => createHttpExperiment(variant),
  };
}
const entries: readonly Example[] = [
  {
    id: 'ping_pong',
    title: 'Ping / Pong',
    version: 1,
    copyLabel: 'Ping/Pong 새 사본',
    description: '메시지·응답 조건·타이머를 편집하는 사용자 정의 출발점입니다.',
    supported: ['응용 계층의 JSON Lines·JSON datagram 변형', '독립 상태·응답 조건·500ms 타이머'],
    omitted: ['기존 표준 프로토콜이나 전체 네트워크 모델이 아님'],
    sources: [],
    expected: 'A Done · Pong 상위 전달 1회',
    diagnosticCodes: [],
    build: createPingPongExperiment,
  },
  {
    id: 'stop_wait',
    title: 'Stop-and-wait',
    version: 1,
    copyLabel: '재전송 실험 새 사본',
    description: 'DATA·ACK와 순서 번호, 타이머·중복 제거를 가진 사용자 정의 전송 모델입니다.',
    supported: [
      '한 방향 DATA 1개, 최초 송신 1회와 기본 재시도 최대 3회',
      'ACK 검사, 대기 데이터·순서 번호·중복 제거와 늦은 ACK 무시',
    ],
    omitted: ['TCP가 아님: 윈도·혼잡 제어·연속/동시 양방향 전송 제외'],
    sources: [],
    expected: 'A Done · B DATA 상위 전달 1회',
    diagnosticCodes: [],
    build: createStopAndWaitExperiment,
  },
  httpExample('get', 'HTTP GET', '비어 있는 본문의 요청과 응답, 요청 줄·헤더 종료를 살펴봅니다.'),
  httpExample(
    'post',
    'HTTP POST',
    '한글 본문을 전송하고 문자 수와 UTF-8 바이트 길이를 비교합니다.',
  ),
  httpExample(
    'split',
    'HTTP 분할 수신',
    '같은 POST를 1바이트 청크로 받아도 같은 메시지로 복원합니다.',
  ),
  httpExample(
    'bad-header',
    'HTTP 헤더 오류',
    '콜론 앞 공백을 넣은 원시 요청을 실제 수신 코덱에서 거부합니다.',
    ['http-header'],
  ),
  httpExample(
    'incomplete-body',
    'HTTP 본문 길이 오류',
    '9바이트를 선언하고 6바이트만 전송한 뒤 EOF로 불완전 본문을 확인합니다.',
    ['http-incomplete-body'],
  ),
  httpExample(
    'delayed',
    'HTTP 응답 지연',
    '서버 처리 대기 600ms와 클라이언트 응답 기한 500ms를 구분합니다.',
  ),
  {
    id: 'tcp_handshake',
    title: 'TCP 연결 수립',
    version: 1,
    copyLabel: 'TCP 연결 수립 사본 만들기',
    description: '정상 SYN → SYN-ACK → ACK와 양쪽 상태, 100/300 초기 순서 번호를 추적합니다.',
    supported: [
      '능동/수동 열기와 CLOSED/LISTEN → SYN-SENT/SYN-RECEIVED → ESTABLISHED',
      'SYN의 순서 번호 1개 소비, ACK 값·플래그 검사, ACK 자체는 순서 번호를 소비하지 않음',
      '논리 패킷과 유한 관찰용 timeout이며 실제 TCP wire bytes가 아님',
    ],
    omitted: [
      '전체 TCP: 데이터 전송·재전송·흐름/혼잡 제어·FIN/RST·동시 열기',
      '포트·체크섬·옵션·윈도·32비트 순서 번호 wraparound',
    ],
    sources: [
      {
        title: 'RFC 9293 §3.5 · Figure 6',
        url: 'https://www.rfc-editor.org/rfc/rfc9293.html#section-3.5',
      },
    ],
    expected: 'A/B ESTABLISHED · SYN 100 → SYN-ACK 300/101 → ACK 101/301',
    diagnosticCodes: [],
    build: createTcpHandshakeExperiment,
  },
];
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export const EXAMPLES: readonly Example[] = freeze(entries);
const originals = new Map(
  EXAMPLES.map((example) => [
    example.id,
    freeze({ ...example.build(), origin: { exampleId: example.id, version: example.version } }),
  ]),
);
let nextCopy = 0;

/** Read a frozen versioned original; the editor never receives this reference as a writable draft. */
export function getExampleOriginal(id: string): ExperimentDefinition {
  const original = originals.get(id);
  if (!original) throw new Error(`Unknown example ${id}`);
  return original;
}

/** Create an isolated user experiment retaining the source ID and version. */
export function createExampleCopy(id: string): ExperimentDefinition {
  const original = getExampleOriginal(id);
  return { ...structuredClone(original), id: `${original.id}_copy_${++nextCopy}` };
}
