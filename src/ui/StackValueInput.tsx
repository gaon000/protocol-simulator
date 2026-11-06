import type { JsonValue } from '../domain/execution-contract.ts';
import { valueAt } from '../domain/json-pointer.ts';
import { deserializeBytes, parseBytesValue, serializeBytes } from '../domain/stack-bytes.ts';
import type { StackValueType } from '../domain/stack-model.ts';
import type { StackDraft } from '../domain/workspace-v2-model.ts';
import { blockingStackRaw } from '../application/edit-stack-list.ts';
import { ruleLiteral, RULE_FORM_POLICY } from '../application/stack-rule-authoring.ts';

export type StackInputProps = {
  draft: StackDraft;
  edit: (path: string, value: JsonValue | undefined) => void;
  json: (path: string, text: string) => void;
};
const idFor = (path: string) => `stack-form-${encodeURIComponent(path)}`;

/** Preserve large/incomplete JSON at its canonical path without truncating it into an editable control. */
export function StackJsonInput({
  draft,
  json,
  path,
  label,
}: StackInputProps & { path: string; label: string }) {
  const text = draft.raw[path] ?? JSON.stringify(valueAt(draft.configuration, path), null, 2) ?? '';
  return (
    <label className='control' htmlFor={idFor(`${path}/$json`)}>
      <span>{label}</span>
      {text.length > RULE_FORM_POLICY.jsonChars ? (
        <span>큰 JSON {text.length}자 · 원본은 bundle에 보존합니다.</span>
      ) : (
        <textarea
          id={idFor(`${path}/$json`)}
          aria-label={label}
          data-stack-path={path}
          rows={4}
          value={text}
          aria-invalid={draft.raw[path] !== undefined || undefined}
          onChange={(e) => json(path, e.target.value)}
        />
      )}
    </label>
  );
}

/** Block only a pending JSON ancestor; expose its exact text outside the disabled descendant form. */
export function StackFormBoundary(
  props: StackInputProps & { path: string; children: React.ReactNode },
) {
  const blocked = blockingStackRaw(props.draft.raw, props.path);
  return (
    <>
      {blocked === props.path && (
        <>
          <p role='status'>미완성 JSON을 먼저 수정하세요.</p>
          <StackJsonInput {...props} path={blocked} label='미완성 설정 JSON 수정' />
        </>
      )}
      <fieldset
        id={`stack-form-group-${encodeURIComponent(props.path)}`}
        tabIndex={-1}
        className='rule-boundary'
        disabled={blocked !== undefined}
      >
        {props.children}
      </fieldset>
    </>
  );
}

/** Edit literal or declared initial values with the same integer/hex raw contract as rule expressions. */
export function StackValueInput(
  props: StackInputProps & { path: string; native: boolean; type?: StackValueType; label?: string },
) {
  const { draft, path, native, edit, json, type: declared, label = '값' } = props;
  const value = valueAt(draft.configuration, path),
    raw = draft.raw[path];
  const bytes = native && parseBytesValue(value).success;
  const actual =
    value === null
      ? 'null'
      : bytes
        ? 'bytes'
        : typeof value === 'string'
          ? 'string'
          : typeof value === 'boolean'
            ? 'boolean'
            : typeof value === 'number' && Number.isSafeInteger(value)
              ? 'integer'
              : 'json';
  const type = declared ?? actual;
  const compatible = declared === undefined || declared === 'json' || declared === actual;
  const blocked = blockingStackRaw(draft.raw, path);
  if (blocked && blocked !== path) return <p>상위 미완성 JSON을 먼저 수정하세요.</p>;
  const pending =
    raw !== undefined &&
    !(type === 'integer' && raw.startsWith('number:')) &&
    !(type === 'bytes' && raw.startsWith('hex:'));
  const common = {
    id: idFor(path),
    'data-rule-path': path,
    'data-stack-path': path,
    'aria-invalid': raw !== undefined || undefined,
  };
  return (
    <div className='rule-literal'>
      {declared === undefined && (
        <label className='control'>
          <span>리터럴 자료형</span>
          <select
            aria-label='리터럴 자료형'
            id={idFor(`${path}/$type`)}
            value={actual}
            onChange={(e) =>
              edit(
                path,
                e.target.value === 'null' ? null : ruleLiteral(e.target.value as StackValueType),
              )
            }
          >
            {['string', 'integer', 'boolean', 'null', 'json', ...(native ? ['bytes'] : [])].map(
              (kind) => (
                <option key={kind} value={kind}>
                  {
                    (
                      {
                        string: '문자열',
                        integer: '정수',
                        boolean: '참/거짓',
                        null: 'null',
                        json: 'JSON 값',
                        bytes: '바이트 (hex)',
                      } as Record<string, string>
                    )[kind]
                  }
                </option>
              ),
            )}
          </select>
        </label>
      )}
      {!compatible || pending ? (
        <>
          <StackJsonInput {...props} label={pending ? '미완성 리터럴 JSON' : `${label} JSON`} />
          {!compatible && declared && (
            <>
              <p>선언 타입 {declared}와 값의 자료형이 다릅니다. 값을 보존했습니다.</p>
              <button type='button' onClick={() => edit(path, ruleLiteral(declared))}>
                선언 타입으로 초기값 만들기
              </button>
            </>
          )}
        </>
      ) : type === 'integer' ? (
        <label className='control'>
          <span>{declared ? label : '정수 값'}</span>
          <input
            {...common}
            aria-label={declared ? label : '정수 값'}
            inputMode='numeric'
            maxLength={128}
            value={raw?.startsWith('number:') ? raw.slice(7) : String(value)}
            onChange={(e) => {
              const text = e.target.value;
              if (/^-?(0|[1-9]\d*)$/.test(text) && Number.isSafeInteger(Number(text)))
                edit(path, Number(text));
              else json(path, `number:${text}`);
            }}
          />
        </label>
      ) : type === 'string' &&
        typeof value === 'string' &&
        value.length <= RULE_FORM_POLICY.jsonChars ? (
        <label className='control'>
          <span>{declared ? label : '문자열 값'}</span>
          <input
            {...common}
            aria-label={declared ? label : '문자열 값'}
            value={value}
            maxLength={RULE_FORM_POLICY.jsonChars}
            onChange={(e) => edit(path, e.target.value)}
          />
        </label>
      ) : type === 'boolean' ? (
        <label className='control'>
          <span>{declared ? label : '참/거짓 값'}</span>
          <select
            {...common}
            aria-label={declared ? label : '참/거짓 값'}
            value={String(value)}
            onChange={(e) => edit(path, e.target.value === 'true')}
          >
            <option value='true'>참 (true)</option>
            <option value='false'>거짓 (false)</option>
          </select>
        </label>
      ) : type === 'bytes' ? (
        <StackHexInput {...props} />
      ) : (
        <StackJsonInput {...props} label={declared ? `${label} JSON` : 'JSON 리터럴 값'} />
      )}
    </div>
  );
}
function StackHexInput(props: StackInputProps & { path: string }) {
  const { draft, path, edit, json } = props;
  const bytes = deserializeBytes(valueAt(draft.configuration, path), RULE_FORM_POLICY.hexChars / 2);
  if (!bytes.success)
    return (
      <>
        <p>4096 bytes를 넘거나 잘못된 값입니다. 원본을 유지합니다.</p>
        <StackJsonInput {...props} label='바이트 값 JSON' />
      </>
    );
  const raw = draft.raw[path];
  const text = raw?.startsWith('hex:')
    ? raw.slice(4)
    : Array.from(bytes.value, (b) => b.toString(16).padStart(2, '0')).join('');
  return (
    <label className='control'>
      <span>바이트 값 (hex · 최대 4096 bytes)</span>
      <textarea
        id={idFor(path)}
        data-rule-path={path}
        data-stack-path={path}
        aria-label='바이트 값 (hex · 최대 4096 bytes)'
        rows={3}
        maxLength={RULE_FORM_POLICY.hexChars}
        value={text}
        aria-invalid={raw !== undefined || undefined}
        onChange={(e) => {
          const hex = e.target.value.replace(/\s/g, '');
          if (/^(?:[0-9a-fA-F]{2})*$/.test(hex)) {
            const result = new Uint8Array(hex.length / 2);
            for (let i = 0; i < result.length; i++)
              result[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
            edit(path, serializeBytes(result));
          } else json(path, `hex:${e.target.value}`);
        }}
      />
    </label>
  );
}
