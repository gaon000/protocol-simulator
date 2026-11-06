/** biome-ignore-all lint/suspicious/noArrayIndexKey: Declaration rows retain their canonical JSON Pointer across controlled structural edits. */
import { useState } from 'react';
import type { JsonValue } from '../domain/execution-contract.ts';
import { valueAt } from '../domain/json-pointer.ts';
import {
  stackProtocolBody,
  type ServicePort,
  type StackProtocol,
  type StackValueType,
} from '../domain/stack-model.ts';
import type { StackListEdit } from '../application/edit-stack-list.ts';
import {
  StackFormBoundary,
  StackJsonInput,
  type StackInputProps,
  StackValueInput,
} from './StackValueInput.tsx';

const controlId = (path: string) => `stack-form-${encodeURIComponent(path)}`;
function SettingField(
  props: StackInputProps & {
    path: string;
    label: string;
    options?: readonly string[];
    check?: boolean;
  },
) {
  const { path, label, options, check, draft, edit } = props;
  const value = valueAt(draft.configuration, path);
  return (
    <label className={check ? 'check-control' : 'control'} htmlFor={controlId(path)}>
      <span>{label}</span>
      {options ? (
        <select
          id={controlId(path)}
          aria-label={label}
          data-stack-path={path}
          value={String(value ?? '')}
          onChange={(e) => edit(path, e.target.value)}
        >
          {[...new Set([String(value ?? ''), ...options])].map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={controlId(path)}
          aria-label={label}
          data-stack-path={path}
          type={check ? 'checkbox' : 'text'}
          {...(check ? { checked: value === true } : { value: String(value ?? '') })}
          onChange={(e) => edit(path, check ? e.target.checked : e.target.value)}
        />
      )}
    </label>
  );
}

/** Author one exact declared port while preserving peer/event references and its optional advanced JSON. */
export function StackPortForm(
  props: StackInputProps & { path: string; port: ServicePort; protocol: StackProtocol },
) {
  const { port, path, protocol, edit } = props;
  const schema = port.service.payload === 'bytes' ? undefined : port.service.payload;
  return (
    <section className='stack-port-form' aria-label={`${port.role} 포트 폼`}>
      <StackFormBoundary {...props}>
        <p>
          역할 {port.role} · 초기 상태 ready. ID/서비스 변경 뒤 연결과 규칙의 참조는 정의 진단에서
          확인하세요.
        </p>
        <SettingField {...props} path={`${path}/id`} label='포트 ID' />
        <StackFormBoundary {...props} path={`${path}/service`}>
          <label className='control'>
            <span>서비스 종류</span>
            <select
              id={controlId(`${path}/service/kind`)}
              aria-label='서비스 종류'
              data-stack-path={`${path}/service/kind`}
              value={port.service.kind}
              onChange={(e) => {
                const stream = e.target.value === 'stream';
                edit(path, {
                  ...port,
                  service: stream
                    ? { kind: 'stream', payload: 'bytes' }
                    : { kind: 'datagram', payload: port.service.payload },
                  request: stream ? 'write' : 'send',
                  indication: stream ? 'read' : 'receive',
                } as unknown as JsonValue);
              }}
            >
              <option value='stream'>바이트 스트림</option>
              <option value='datagram'>데이터그램</option>
            </select>
          </label>
          <StackFormBoundary {...props} path={`${path}/service/payload`}>
            <label className='control'>
              <span>서비스 데이터</span>
              <select
                aria-label='서비스 데이터'
                id={controlId(`${path}/service/payload`)}
                value={schema ? 'packet' : 'bytes'}
                disabled={port.service.kind === 'stream'}
                onChange={(e) =>
                  edit(
                    `${path}/service/payload`,
                    e.target.value === 'bytes'
                      ? 'bytes'
                      : ({
                          id: 'packet_schema',
                          revision: 1,
                          messages: stackProtocolBody(protocol).messages,
                        } as unknown as JsonValue),
                  )
                }
              >
                <option value='bytes'>바이트</option>
                <option value='packet'>선언한 메시지 패킷</option>
              </select>
            </label>
            {schema && (
              <>
                <SettingField
                  {...props}
                  path={`${path}/service/payload/id`}
                  label='패킷 스키마 ID'
                />
                <StackValueInput
                  {...props}
                  native={true}
                  path={`${path}/service/payload/revision`}
                  type='integer'
                  label='패킷 스키마 revision'
                />
                <p>
                  패킷 메시지 {schema.messages.length}개. 선언한 메시지와 다른 형식은 자동 변경하지
                  않습니다.
                </p>
                <button
                  type='button'
                  onClick={() =>
                    edit(
                      `${path}/service/payload/messages`,
                      stackProtocolBody(protocol).messages as unknown as JsonValue,
                    )
                  }
                >
                  현재 메시지로 패킷 형식 채우기
                </button>
              </>
            )}
          </StackFormBoundary>
        </StackFormBoundary>
        <SettingField
          {...props}
          path={`${path}/request`}
          label='서비스 요청 동작'
          options={['write', 'send']}
        />
        <SettingField
          {...props}
          path={`${path}/indication`}
          label='서비스 통지 동작'
          options={['read', 'receive']}
        />
        <StackFormBoundary {...props} path={`${path}/lifecycle`}>
          <StackFormBoundary {...props} path={`${path}/lifecycle/notifications`}>
            {(['failed', 'closed'] as const).map((state) => (
              <label className='check-control' key={state}>
                <input
                  type='checkbox'
                  aria-label={`${state} 통지 허용`}
                  checked={port.lifecycle.notifications.includes(state)}
                  onChange={(e) =>
                    edit(
                      `${path}/lifecycle/notifications`,
                      e.target.checked
                        ? [...port.lifecycle.notifications, state]
                        : port.lifecycle.notifications.filter((item) => item !== state),
                    )
                  }
                />
                <span>{state} 통지 허용</span>
              </label>
            ))}
          </StackFormBoundary>
        </StackFormBoundary>
      </StackFormBoundary>
      <details>
        <summary>{port.role} 포트 JSON 편집</summary>
        <StackJsonInput {...props} label={`${port.role} 포트 계약 JSON`} />
      </details>
    </section>
  );
}

/** Page declarations, remap raw values with structural edits, and use typed initial-value controls. */
export function StackDeclarations(
  props: StackInputProps & {
    path: string;
    protocol: StackProtocol;
    list: (path: string, operation: StackListEdit) => void;
    focusPath?: string;
  },
) {
  const { path, protocol, list } = props;
  const body = stackProtocolBody(protocol);
  const [pages, setPages] = useState<Record<string, number>>(() => {
    const match = props.focusPath?.match(/\/(variables|timers)\/(\d+)/);
    return match ? { [match[1] ?? '']: Math.floor(Number(match[2]) / 10) } : {};
  });
  const unique = (items: readonly { id: string }[], key: string) => {
    let i = 1;
    while (items.some((item) => item.id === `${key}_${i}`)) i++;
    return `${key}_${i}`;
  };
  function pager(kind: string, total: number, page: number) {
    return (
      <div className='stack-inline'>
        <button
          type='button'
          disabled={page === 0}
          onClick={() => setPages({ ...pages, [kind]: page - 1 })}
        >
          이전 {kind === 'variables' ? '변수' : '타이머'} 페이지
        </button>
        <span>
          {page + 1}/{Math.max(1, Math.ceil(total / 10))} · 전체 {total}개
        </span>
        <button
          type='button'
          disabled={(page + 1) * 10 >= total}
          onClick={() => setPages({ ...pages, [kind]: page + 1 })}
        >
          다음 {kind === 'variables' ? '변수' : '타이머'} 페이지
        </button>
      </div>
    );
  }
  return (
    <>
      {(['variables', 'timers'] as const).map((kind) => {
        const items = body[kind],
          where = `${path}/${kind}`;
        const page = Math.max(
          0,
          Math.min(pages[kind] ?? 0, Math.max(0, Math.ceil(items.length / 10) - 1)),
        );
        return (
          <fieldset
            key={kind}
            className='editor-group'
            aria-label={kind === 'variables' ? '변수 선언 폼' : '타이머 선언 폼'}
          >
            <legend>{kind === 'variables' ? '변수' : '타이머'}</legend>
            <StackFormBoundary {...props} path={where}>
              {pager(kind, items.length, page)}
              {items.slice(page * 10, page * 10 + 10).map((item, offset) => {
                const index = page * 10 + offset,
                  at = `${where}/${index}`;
                const variable = kind === 'variables' ? body.variables[index] : undefined;
                return (
                  <fieldset className='stack-card' key={index}>
                    <legend>
                      {kind === 'variables' ? '변수' : '타이머'} {index + 1}
                    </legend>
                    <StackFormBoundary {...props} path={at}>
                      <SettingField
                        {...props}
                        path={`${at}/id`}
                        label={`${kind === 'variables' ? '변수' : '타이머'} ${index + 1} ID`}
                      />
                      {variable && (
                        <>
                          <SettingField
                            {...props}
                            path={`${at}/type`}
                            label='변수 타입'
                            options={
                              protocol.mode === 'stack-protocol'
                                ? ['integer', 'string', 'boolean', 'json', 'bytes']
                                : ['integer', 'string', 'boolean', 'json']
                            }
                          />
                          <StackValueInput
                            {...props}
                            path={`${at}/initial`}
                            native={protocol.mode === 'stack-protocol'}
                            type={variable.type as StackValueType}
                            label={`${variable.id} 초기값`}
                          />
                        </>
                      )}
                      <button type='button' onClick={() => list(where, { kind: 'remove', index })}>
                        {kind === 'variables' ? '변수' : '타이머'} 삭제 · {item.id}
                      </button>
                    </StackFormBoundary>
                  </fieldset>
                );
              })}
              <button
                type='button'
                onClick={() => {
                  setPages({ ...pages, [kind]: Math.floor(items.length / 10) });
                  list(where, {
                    kind: 'add',
                    value:
                      kind === 'variables'
                        ? { id: unique(items, 'variable'), type: 'integer', initial: 0 }
                        : { id: unique(items, 'timer') },
                  });
                  requestAnimationFrame(() =>
                    document.getElementById(controlId(`${where}/${items.length}/id`))?.focus(),
                  );
                }}
              >
                {kind === 'variables' ? '변수' : '타이머'} 추가
              </button>
            </StackFormBoundary>
            <details>
              <summary>{kind === 'variables' ? '변수' : '타이머'} JSON 편집</summary>
              <StackJsonInput
                {...props}
                path={where}
                label={kind === 'variables' ? '변수 목록 JSON' : '타이머 ID 목록 JSON'}
              />
            </details>
          </fieldset>
        );
      })}
    </>
  );
}
