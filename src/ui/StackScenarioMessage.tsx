import { useState } from 'react';
import { pointerToken, valueAt } from '../domain/json-pointer.ts';
import type { ModelDiagnostic } from '../domain/protocol-model.ts';
import type { StackEndpoint } from '../domain/stack-model.ts';
import { stackObject } from '../domain/stack-record.ts';
import { blockingStackRaw } from '../application/edit-stack-list.ts';
import {
  SCENARIO_FORM_POLICY,
  stackScenarioFieldValue,
  stackScenarioMessage,
  uniqueScenarioDeclarations,
} from '../application/stack-scenario-authoring.ts';
import { StackJsonInput, StackValueInput, type StackInputProps } from './StackValueInput.tsx';

/** Search all candidates, retaining unavailable identities and a bounded native select. */
export function ScenarioChoice({
  path,
  label,
  value,
  options,
  change,
  diagnostics = [],
}: {
  path: string;
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  change: (value: string) => void;
  diagnostics?: readonly ModelDiagnostic[];
}) {
  const [search, setSearch] = useState('');
  const filtered = options.filter((o) =>
    `${o.value} ${o.label}`.toLowerCase().includes(search.toLowerCase()),
  );
  const visible = filtered.slice(0, SCENARIO_FORM_POLICY.choices);
  if (!visible.some((o) => o.value === value))
    visible.unshift(
      options.find((o) => o.value === value) ?? {
        value,
        label: `${value || '(없음)'} · 참조 확인`,
      },
    );
  return (
    <div className='rule-choice'>
      {(options.length > SCENARIO_FORM_POLICY.choices ||
        !options.some((o) => o.value === value)) && (
        <label className='control'>
          <span>{label} 검색</span>
          <input
            aria-label={`${label} 검색`}
            value={search}
            maxLength={160}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      )}
      <label className='control' htmlFor={`stack-form-${encodeURIComponent(path)}`}>
        <span>{label}</span>
        <select
          id={`stack-form-${encodeURIComponent(path)}`}
          aria-label={label}
          data-stack-path={path}
          value={value}
          aria-invalid={
            diagnostics.some((d) => d.path === path || d.path.startsWith(`${path}/`)) || undefined
          }
          onChange={(e) => change(e.target.value)}
        >
          {visible.slice(0, SCENARIO_FORM_POLICY.choices).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label.slice(0, 64)}
            </option>
          ))}
        </select>
      </label>
      {filtered.length > SCENARIO_FORM_POLICY.choices && (
        <small>후보는 최대 20개 표시합니다. 검색으로 나머지를 찾으세요.</small>
      )}
    </div>
  );
}

/** Render the original pending ancestor once instead of exposing descendant controls that could overwrite it. */
export function ScenarioBoundary(
  props: StackInputProps & { path: string; children: React.ReactNode; identity?: boolean },
) {
  const blocked =
    blockingStackRaw(props.draft.raw, props.path) ??
    (props.identity
      ? Object.keys(props.draft.raw).find((p) => p.startsWith(`${props.path}/`))
      : undefined);
  if (blocked)
    return (
      <div id={`stack-form-group-${encodeURIComponent(blocked)}`} tabIndex={-1}>
        <p role='status'>미완성 JSON을 먼저 수정하세요. 경로 {blocked}</p>
        <StackJsonInput {...props} path={blocked} label='미완성 시나리오 JSON 수정' />
      </div>
    );
  return props.children;
}

function short(value: unknown): string {
  if (typeof value === 'string')
    return JSON.stringify(value.slice(0, 64)) + (value.length > 64 ? '…' : '');
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const bytes = stackObject(value);
  return bytes.kind === 'bytes' ? `${bytes.byteLength} bytes` : '구조형 값';
}

/** Edit one exact message's values, preserving omission, unavailable fields and every unsupported original value. */
export function StackScenarioMessage(
  props: StackInputProps & {
    path: string;
    target: StackEndpoint;
    diagnostics: readonly ModelDiagnostic[];
    focusPath?: string;
  },
) {
  const { draft, path, edit, target, diagnostics } = props;
  const message = stackObject(valueAt(draft.configuration, path));
  const source = stackScenarioMessage(draft, target, String(message.messageId ?? ''));
  const definition = source?.message;
  const values = stackObject(message.values);
  const validShape =
    typeof message.messageId === 'string' &&
    message.values !== null &&
    typeof message.values === 'object' &&
    !Array.isArray(message.values);
  const declared = uniqueScenarioDeclarations(definition?.fields ?? []);
  const declaredIds = new Set(declared.map((field) => field.id));
  const duplicateFields = declared.length !== (definition?.fields.length ?? 0);
  const targetPath = `${path.slice(0, path.lastIndexOf('/'))}/target`;
  const pendingIdentity =
    blockingStackRaw(draft.raw, `${path}/messageId`) ??
    blockingStackRaw(draft.raw, targetPath) ??
    Object.keys(draft.raw).find((p) => p.startsWith(`${targetPath}/`));
  const keys = [
    ...declared.map((f) => f.id),
    ...Object.keys(values).filter((id) => !declaredIds.has(id)),
  ];
  const focusToken = props.focusPath?.startsWith(`${path}/values/`)
    ? props.focusPath.slice(`${path}/values/`.length).split('/')[0]
    : undefined;
  const focused =
    focusToken === undefined ? undefined : focusToken.replace(/~1/g, '/').replace(/~0/g, '~');
  const [fieldId, setFieldId] = useState(focused ?? keys[0] ?? '');
  const [page, setPage] = useState(
    focused ? Math.max(0, Math.floor(keys.indexOf(focused) / 10)) : 0,
  );
  const [jsonOpen, setJsonOpen] = useState(false);
  const selected = keys.includes(fieldId) ? fieldId : keys[0];
  const pages = Math.max(1, Math.ceil(keys.length / 10));
  const shown = Math.min(page, pages - 1);
  const field = declared.find((f) => f.id === selected);
  const at = `${path}/values/${pointerToken(selected ?? '')}`;
  const present = selected !== undefined && Object.hasOwn(values, selected);
  return (
    <section
      className='stack-scenario-message'
      aria-label='시나리오 메시지 값'
      id={`stack-group-${encodeURIComponent(path)}`}
      tabIndex={-1}
    >
      <ScenarioBoundary {...props}>
        <button type='button' onClick={() => setJsonOpen(!jsonOpen)}>
          {jsonOpen ? '메시지 폼으로 돌아가기' : '메시지 JSON 편집'}
        </button>
        {jsonOpen || !validShape ? (
          <>
            {!validShape && <p>메시지 구조를 해석할 수 없습니다. 원본 JSON에서 수정하세요.</p>}
            <StackJsonInput {...props} label='입력·기대 메시지 JSON' />
          </>
        ) : (
          <>
            <ScenarioBoundary {...props} path={`${path}/messageId`} identity>
              <ScenarioChoice
                path={`${path}/messageId`}
                label='시나리오 메시지'
                value={message.messageId as string}
                diagnostics={diagnostics}
                options={uniqueScenarioDeclarations(source?.body.messages ?? []).map((m) => ({
                  value: m.id,
                  label: `${m.label} (${m.id})`,
                }))}
                change={(id) => edit(`${path}/messageId`, id)}
              />
            </ScenarioBoundary>
            <p>
              메시지나 대상을 바꾸어도 기존 값은 보존됩니다. 생략한 필드의 기본값은 실제 실행에서
              적용합니다.
            </p>
            {pendingIdentity ? (
              <p>메시지/대상의 미완성 참조를 먼저 수정하세요.</p>
            ) : !source || !definition || source.blocked || duplicateFields ? (
              <>
                <p role='status'>
                  {source?.blocked
                    ? `메시지 정의에 미완성 입력이 있습니다: ${source.blocked}`
                    : '메시지/필드의 참조가 없거나 중복됩니다. 정의 진단에서 확인하세요.'}
                </p>
                <StackJsonInput {...props} label='참조 확인 메시지 JSON' />
              </>
            ) : (
              <ScenarioBoundary {...props} path={`${path}/values`}>
                <nav aria-label='메시지 필드 페이지' className='stack-inline'>
                  <button
                    type='button'
                    disabled={shown === 0}
                    onClick={() => {
                      setPage(shown - 1);
                      setFieldId(keys[(shown - 1) * 10] ?? '');
                    }}
                  >
                    이전 필드 10개
                  </button>
                  <span>
                    {shown + 1}/{pages} · 전체 {keys.length}개
                  </span>
                  <button
                    type='button'
                    disabled={shown + 1 >= pages}
                    onClick={() => {
                      setPage(shown + 1);
                      setFieldId(keys[(shown + 1) * 10] ?? '');
                    }}
                  >
                    다음 필드 10개
                  </button>
                </nav>
                <div className='stack-scenario-fields'>
                  {keys.slice(shown * 10, shown * 10 + 10).map((id) => (
                    <button
                      type='button'
                      key={id}
                      aria-pressed={id === selected}
                      onClick={() => setFieldId(id)}
                    >
                      필드 편집 · {id.slice(0, 48)} · {Object.hasOwn(values, id) ? '포함' : '생략'}
                    </button>
                  ))}
                </div>
                {selected !== undefined && (
                  <fieldset
                    className='stack-card'
                    tabIndex={-1}
                    id={`stack-form-group-${encodeURIComponent(at)}`}
                  >
                    <legend>
                      {field
                        ? `${field.name.slice(0, 64)} · ${field.type}`
                        : `${selected.slice(0, 64)} · 정의에 없는 값`}
                    </legend>
                    {!field && (
                      <p>
                        정의에 없는 값을 보존했습니다. JSON에서 수정하거나 명시적으로 삭제하세요.
                      </p>
                    )}
                    {field ? (
                      <label className='check-control'>
                        <input
                          type='checkbox'
                          aria-label='필드 값 포함'
                          id={`stack-form-${encodeURIComponent(`${at}/$present`)}`}
                          checked={present}
                          onChange={(e) =>
                            edit(
                              at,
                              e.target.checked && field
                                ? stackScenarioFieldValue(field)
                                : undefined,
                            )
                          }
                        />
                        <span>필드 값 포함{field?.required ? ' · 필수' : ''}</span>
                      </label>
                    ) : (
                      <button
                        type='button'
                        onClick={() => {
                          setFieldId(declared[0]?.id ?? '');
                          setPage(0);
                          edit(at, undefined);
                        }}
                      >
                        정의에 없는 값 삭제
                      </button>
                    )}
                    {!present ? (
                      <p>
                        생략 시 기본값:{' '}
                        {field && Object.hasOwn(field, 'defaultValue')
                          ? short(field.defaultValue)
                          : '없음'}
                      </p>
                    ) : !field ? (
                      <StackJsonInput {...props} path={at} label='정의에 없는 필드 값 JSON' />
                    ) : field.type === 'enum' &&
                      typeof values[selected] === 'string' &&
                      draft.raw[at] === undefined ? (
                      <ScenarioChoice
                        path={at}
                        label='필드 값'
                        value={String(values[selected])}
                        diagnostics={diagnostics}
                        options={[...new Set(field.options)].map((v) => ({ value: v, label: v }))}
                        change={(value) => edit(at, value)}
                      />
                    ) : (
                      <StackValueInput
                        {...props}
                        path={at}
                        native={source.protocol.mode === 'stack-protocol'}
                        type={field.type === 'enum' ? 'string' : field.type}
                        label='필드 값'
                        multiline
                      />
                    )}
                    {field && (
                      <small>
                        {field.required ? '필수' : '선택'} 필드 · ID {field.id.slice(0, 64)} · 구획{' '}
                        {field.placement}
                      </small>
                    )}
                  </fieldset>
                )}
                {keys.length === 0 && <p>선택한 메시지에 선언한 필드가 없습니다.</p>}
              </ScenarioBoundary>
            )}
          </>
        )}
      </ScenarioBoundary>
    </section>
  );
}
