import { useMemo, useRef, useState } from 'react';
import {
  createNewStack,
  NEW_STACK_DEFAULTS,
  type NewStackOptions,
} from '../application/new-stack.ts';
import type { StackExperiment } from '../domain/stack-model.ts';

/** Stage a new stack locally and commit it only after the user reviews the exact generated starting flow. */
export function NewStackWizard({
  create,
  cancel,
}: {
  create: (configuration: StackExperiment) => Promise<string | undefined>;
  cancel: () => void;
}) {
  const [options, setOptions] = useState<NewStackOptions>(NEW_STACK_DEFAULTS);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const region = useRef<HTMLElement>(null);
  const staged = useMemo(() => createNewStack(options, 'new_protocol'), [options]);
  function next(value: number) {
    setStep(value);
    setError('');
    requestAnimationFrame(() => region.current?.querySelector<HTMLElement>('h2')?.focus());
  }
  const text = (key: 'name' | 'protocolId' | 'messageId' | 'fieldId' | 'value', label: string) => (
    <label className='control'>
      <span>{label}</span>
      <input
        aria-label={label}
        value={options[key]}
        maxLength={key === 'value' ? 4096 : 80}
        onChange={(e) => setOptions({ ...options, [key]: e.target.value })}
      />
    </label>
  );
  return (
    <section ref={region} className='stack-card new-stack-wizard' aria-label='새 프로토콜 만들기'>
      <h2 tabIndex={-1}>새 프로토콜 만들기 · {step + 1}/3</h2>
      <p>
        응용·전송 두 계층과 가상 참여자 A/B를 구성합니다. 만들기를 누르기 전까지 현재 초안은
        유지됩니다.
      </p>
      <fieldset disabled={busy}>
        <legend>{['이름과 전송', '첫 메시지와 규칙', '구성 검토'][step]}</legend>
        {step === 0 && (
          <>
            {text('name', '새 스택 이름')}
            {text('protocolId', '새 응용 프로토콜 ID')}
            <label className='control'>
              <span>전송 시작점</span>
              <select
                aria-label='전송 시작점'
                value={options.transport}
                onChange={(e) =>
                  setOptions({
                    ...options,
                    transport: e.target.value as NewStackOptions['transport'],
                  })
                }
              >
                <option value='reliable-stream'>바이트 스트림 · ReliableStreamLite</option>
                <option value='datagram'>데이터그램 · 전달 뼈대</option>
              </select>
            </label>
            <p>
              {options.transport === 'reliable-stream'
                ? '순서·재전송·중복 제거를 제공하는 편집 가능한 Lite 정의를 연결합니다. 실제 TCP 구현은 아닙니다.'
                : '패킷 경계를 유지하는 편집 가능한 전달 규칙을 연결합니다. 손실 복구·순서·중복 제거는 제공하지 않습니다.'}
            </p>
          </>
        )}
        {step === 1 && (
          <>
            {text('messageId', '첫 메시지 ID')}
            {text('fieldId', '문자열 필드 ID')}
            <label className='control'>
              <span>규칙 시작 방식</span>
              <select
                aria-label='규칙 시작 방식'
                value={options.flow}
                onChange={(e) =>
                  setOptions({ ...options, flow: e.target.value as NewStackOptions['flow'] })
                }
              >
                <option value='one-way'>첫 송신·수신과 검증 만들기</option>
                <option value='empty'>빈 규칙부터 직접 작성</option>
              </select>
            </label>
            {options.flow === 'one-way' ? (
              <>
                {text('value', '첫 입력 값')}
                <p>
                  A 입력 → 응용 송신 → 전송 계층 → B 응용 전달의 기본 규칙과 값 검증을 생성합니다.
                </p>
              </>
            ) : (
              <p>
                준비 상태와 메시지만 만들고 응용 규칙·입력·기대 조건은 비워 둡니다. 실행하려면
                규칙을 추가해야 합니다.
              </p>
            )}
          </>
        )}
        {step === 2 && (
          <>
            <dl>
              <dt>이름 / 응용 ID</dt>
              <dd>
                {options.name} / {options.protocolId}
              </dd>
              <dt>전송</dt>
              <dd>
                {options.transport === 'reliable-stream'
                  ? 'ReliableStreamLite'
                  : '데이터그램 전달 뼈대'}
              </dd>
              <dt>메시지 / 문자열 필드</dt>
              <dd>
                {options.messageId} / {options.fieldId}
              </dd>
              <dt>첫 흐름</dt>
              <dd>
                {options.flow === 'empty'
                  ? '빈 응용 규칙 · 실행 전 작성 필요'
                  : `A → B · ${options.value}`}
              </dd>
            </dl>
            <p>
              A/B는 같은 응용 정의를 참조하고 상태는 독립적으로 실행합니다. 하위 링크는 양방향
              10ms·손실/중복 0%로 시작하며 편집할 수 있습니다.
            </p>
            {!staged.success && (
              <ul>
                {staged.diagnostics.slice(0, 10).map((d) => (
                  <li key={`${d.path}:${d.code}`}>{d.message}</li>
                ))}
              </ul>
            )}
          </>
        )}
        <div className='stack-inline'>
          {step > 0 && (
            <button type='button' onClick={() => next(step - 1)}>
              이전 단계
            </button>
          )}
          {step < 2 ? (
            <button type='button' onClick={() => next(step + 1)}>
              다음 단계
            </button>
          ) : (
            <button
              type='button'
              disabled={!staged.success}
              onClick={async () => {
                if (!staged.success || busy) return;
                setBusy(true);
                try {
                  const message = await create(staged.value);
                  if (message) setError(message);
                } catch {
                  setError('새 스택을 만들지 못했습니다. 현재 자료는 유지됩니다.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              이 구성으로 스택 만들기
            </button>
          )}
          <button type='button' onClick={cancel}>
            만들기 취소
          </button>
        </div>
      </fieldset>
      {error && <p role='status'>{error}</p>}
    </section>
  );
}
