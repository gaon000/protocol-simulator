import type { StackCondition, StackExpression, StackValueType } from '../domain/stack-model.ts';
import { valueAt } from '../domain/json-pointer.ts';
import { stackObject } from '../domain/stack-record.ts';
import { deserializeBytes, parseBytesValue, serializeBytes } from '../domain/stack-bytes.ts';
import {
  ruleCondition,
  ruleExpression,
  ruleLiteral,
  RULE_FORM_POLICY,
} from '../application/stack-rule-authoring.ts';
import {
  RuleBoundary,
  RuleChoice,
  ruleControlId,
  RuleJson,
  RuleListPager,
  RuleReference,
  RuleTreeFallback,
  useRuleEditor,
} from './StackRuleControls.tsx';

function Literal({ path }: { path: string }) {
  const editor = useRuleEditor();
  const value = valueAt(editor.draft.configuration, path);
  const raw = editor.draft.raw[path];
  const byteValue = editor.context.native && parseBytesValue(value).success;
  const type =
    value === null
      ? 'null'
      : byteValue
        ? 'bytes'
        : typeof value === 'string'
          ? 'string'
          : typeof value === 'boolean'
            ? 'boolean'
            : typeof value === 'number' && Number.isSafeInteger(value)
              ? 'integer'
              : 'json';
  return (
    <div className='rule-literal'>
      <RuleChoice
        path={`${path}/$type`}
        label='리터럴 자료형'
        value={type}
        options={[
          'string',
          'integer',
          'boolean',
          'null',
          'json',
          ...(editor.context.native ? ['bytes'] : []),
        ].map((value) => ({
          value,
          label:
            {
              string: '문자열',
              integer: '정수',
              boolean: '참/거짓',
              null: 'null',
              json: 'JSON 값',
              bytes: '바이트 (hex)',
            }[value] ?? value,
        }))}
        change={(kind) =>
          editor.edit(path, kind === 'null' ? null : ruleLiteral(kind as StackValueType))
        }
      />
      {raw &&
      !(type === 'integer' && raw.startsWith('number:')) &&
      !(type === 'bytes' && raw.startsWith('hex:')) ? (
        <RuleJson path={path} label='미완성 리터럴 JSON' />
      ) : type === 'string' ? (
        typeof value === 'string' && value.length <= RULE_FORM_POLICY.jsonChars ? (
          <label className='control' htmlFor={ruleControlId(path)}>
            <span>문자열 값</span>
            <input
              id={ruleControlId(path)}
              data-rule-path={path}
              value={String(value)}
              onChange={(e) => editor.edit(path, e.target.value)}
            />
          </label>
        ) : (
          <RuleTreeFallback path={path} />
        )
      ) : type === 'integer' ? (
        <label className='control' htmlFor={ruleControlId(path)}>
          <span>정수 값</span>
          <input
            id={ruleControlId(path)}
            data-rule-path={path}
            inputMode='numeric'
            value={raw?.startsWith('number:') ? raw.slice(7) : String(value)}
            aria-invalid={raw !== undefined || undefined}
            maxLength={128}
            onChange={(e) => {
              const text = e.target.value;
              if (/^-?(0|[1-9]\d*)$/.test(text) && Number.isSafeInteger(Number(text)))
                editor.edit(path, Number(text));
              else editor.json(path, `number:${text}`);
            }}
          />
        </label>
      ) : type === 'boolean' ? (
        <RuleChoice
          path={path}
          label='참/거짓 값'
          value={String(value)}
          options={[
            { value: 'true', label: '참 (true)' },
            { value: 'false', label: '거짓 (false)' },
          ]}
          change={(next) => editor.edit(path, next === 'true')}
        />
      ) : type === 'bytes' ? (
        <HexLiteral path={path} />
      ) : type === 'null' ? (
        <RuleJson path={path} label='JSON 리터럴 값' />
      ) : value === undefined ? (
        <button type='button' onClick={() => editor.edit(path, null)}>
          JSON 값 추가
        </button>
      ) : (
        <RuleJson path={path} label='JSON 리터럴 값' />
      )}
    </div>
  );
}
function HexLiteral({ path }: { path: string }) {
  const editor = useRuleEditor();
  const value = valueAt(editor.draft.configuration, path);
  const raw = editor.draft.raw[path];
  const bytes = deserializeBytes(value, RULE_FORM_POLICY.hexChars / 2);
  if (!bytes.success)
    return (
      <>
        <p>큰 byte 값 또는 잘못된 byte 태그입니다. 원본을 유지합니다.</p>
        <RuleTreeFallback path={path} />
      </>
    );
  const text = raw?.startsWith('hex:')
    ? raw.slice(4)
    : Array.from(bytes.value, (b) => b.toString(16).padStart(2, '0')).join('');
  return (
    <label className='control' htmlFor={ruleControlId(path)}>
      <span>바이트 값 (hex · 최대 4096 bytes)</span>
      <textarea
        id={ruleControlId(path)}
        data-rule-path={path}
        rows={3}
        value={text}
        maxLength={RULE_FORM_POLICY.hexChars}
        aria-invalid={raw !== undefined || undefined}
        onChange={(e) => {
          const text = e.target.value;
          const hex = text.replace(/\s/g, '');
          if (/^(?:[0-9a-fA-F]{2})*$/.test(hex)) {
            const result = new Uint8Array(hex.length / 2);
            for (let i = 0; i < result.length; i++)
              result[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
            editor.edit(path, serializeBytes(result));
          } else editor.json(path, `hex:${text}`);
        }}
      />
    </label>
  );
}

/** Render only supported expression nodes inside the shared deterministic tree budget, retaining all other JSON. */
export function StackRuleExpression({
  path,
  expected = 'integer',
  label = '값 표현식',
}: {
  path: string;
  expected?: StackValueType;
  label?: string;
}) {
  const editor = useRuleEditor();
  const value = valueAt(editor.draft.configuration, path);
  const node = stackObject(value);
  if (!editor.allowed.has(path)) return <RuleTreeFallback path={path} />;
  if (value === undefined)
    return (
      <button
        type='button'
        onClick={() =>
          editor.edit(
            path,
            ruleExpression(
              'literal',
              editor.context,
              expected,
            ) as unknown as import('../domain/execution-contract.ts').JsonValue,
          )
        }
      >
        표현식 추가 · {label}
      </button>
    );
  const kinds = [
    'literal',
    'variable',
    'field',
    'add',
    'subtract',
    ...(editor.context.native
      ? ['byteLength', 'slice', 'concat', ...(editor.context.payload ? ['service-payload'] : [])]
      : []),
  ];
  const labels: Record<string, string> = {
    literal: '직접 값',
    variable: '변수 참조',
    field: '이벤트 필드 참조',
    add: '정수 더하기',
    subtract: '정수 빼기',
    byteLength: '바이트 길이',
    slice: '바이트 자르기',
    concat: '바이트 합치기',
    'service-payload': '현재 서비스 payload',
  };
  return (
    <fieldset className='rule-tree' aria-label={label}>
      <legend>{label}</legend>
      <RuleBoundary path={path}>
        <RuleChoice
          path={`${path}/kind`}
          label='표현식 종류'
          value={String(node.kind ?? '')}
          options={kinds.map((value) => ({ value, label: labels[value] ?? value }))}
          change={(kind) =>
            editor.edit(
              path,
              ruleExpression(
                kind as StackExpression['kind'],
                editor.context,
                expected,
                node as unknown as StackExpression,
              ) as unknown as import('../domain/execution-contract.ts').JsonValue,
            )
          }
        />
        {node.kind === 'literal' ? (
          <Literal path={`${path}/value`} />
        ) : node.kind === 'variable' ? (
          <RuleReference
            path={`${path}/variableId`}
            label='참조 변수'
            options={editor.context.variables}
          />
        ) : node.kind === 'field' ? (
          <RuleReference
            path={`${path}/fieldId`}
            label='현재 이벤트 필드'
            options={editor.context.fields}
          />
        ) : node.kind === 'service-payload' ? (
          <p>
            이벤트가 실제 제공하는 payload를 참조합니다. 현재 유형:{' '}
            {editor.context.payload ?? '없음 · 이벤트 확인'}
          </p>
        ) : node.kind === 'add' || node.kind === 'subtract' ? (
          <>
            <StackRuleExpression path={`${path}/left`} label='왼쪽 정수' />
            <StackRuleExpression path={`${path}/right`} label='오른쪽 정수' />
          </>
        ) : node.kind === 'byteLength' ? (
          <StackRuleExpression path={`${path}/value`} expected='bytes' label='길이를 읽을 바이트' />
        ) : node.kind === 'slice' ? (
          <>
            <StackRuleExpression path={`${path}/value`} expected='bytes' label='자를 바이트' />
            <StackRuleExpression path={`${path}/offset`} label='시작 위치' />
            <StackRuleExpression path={`${path}/length`} label='자를 길이' />
          </>
        ) : node.kind === 'concat' && Array.isArray(node.values) ? (
          <NestedRuleList path={`${path}/values`} values={node.values} condition={false} />
        ) : (
          <RuleTreeFallback path={path} />
        )}
      </RuleBoundary>
    </fieldset>
  );
}

/** Compose comparisons and boolean groups without turning unsupported/hidden descendants into defaults. */
export function StackRuleCondition({ path }: { path: string }) {
  const editor = useRuleEditor();
  const value = valueAt(editor.draft.configuration, path);
  const node = stackObject(value);
  if (!editor.allowed.has(path)) return <RuleTreeFallback path={path} />;
  return (
    <fieldset className='rule-tree' aria-label='조건식'>
      <legend>조건식</legend>
      <RuleBoundary path={path}>
        <RuleChoice
          path={`${path}/kind`}
          label='조건 종류'
          value={String(node.kind ?? '')}
          options={[
            { value: 'compare', label: '값 비교' },
            { value: 'all', label: '모든 조건 (AND)' },
            { value: 'any', label: '하나 이상 (OR)' },
            { value: 'not', label: '조건 반전 (NOT)' },
          ]}
          change={(kind) =>
            editor.edit(
              path,
              ruleCondition(
                kind as StackCondition['kind'],
                node as unknown as StackCondition,
              ) as unknown as import('../domain/execution-contract.ts').JsonValue,
            )
          }
        />
        {node.kind === 'compare' ? (
          <>
            <RuleChoice
              path={`${path}/operator`}
              label='비교 연산자'
              value={String(node.operator ?? 'eq')}
              options={[
                ['eq', '같음 (=)'],
                ['ne', '다름 (≠)'],
                ['lt', '작음 (<)'],
                ['lte', '이하 (≤)'],
                ['gt', '큼 (>)'],
                ['gte', '이상 (≥)'],
              ].map(([value, label]) => ({ value: value ?? '', label: label ?? '' }))}
              change={(value) => editor.edit(`${path}/operator`, value)}
            />
            <StackRuleExpression path={`${path}/left`} label='비교 왼쪽 값' />
            <StackRuleExpression path={`${path}/right`} label='비교 오른쪽 값' />
          </>
        ) : node.kind === 'not' ? (
          <StackRuleCondition path={`${path}/condition`} />
        ) : (node.kind === 'all' || node.kind === 'any') && Array.isArray(node.conditions) ? (
          <NestedRuleList path={`${path}/conditions`} values={node.conditions} condition />
        ) : (
          <RuleTreeFallback path={path} />
        )}
      </RuleBoundary>
    </fieldset>
  );
}
function NestedRuleList({
  path,
  values,
  condition,
}: {
  path: string;
  values: readonly unknown[];
  condition: boolean;
}) {
  const editor = useRuleEditor();
  const pages = Math.max(1, Math.ceil(values.length / 10));
  const page = Math.max(0, Math.min(editor.pages[path] ?? 0, pages - 1));
  return (
    <RuleBoundary path={path}>
      <RuleListPager path={path} total={values.length} />
      {values.slice(page * 10, page * 10 + 10).map((_, index) => {
        const at = page * 10 + index;
        const child = `${path}/${at}`;
        return (
          <fieldset key={child} className='rule-list-item' tabIndex={-1} data-rule-focus={child}>
            <legend>
              {condition ? '하위 조건' : '바이트'} {at + 1}
            </legend>
            <div className='stack-inline'>
              <button
                type='button'
                disabled={at === 0}
                onClick={() => editor.list(path, { kind: 'move', from: at, to: at - 1 })}
              >
                위로
              </button>
              <button
                type='button'
                disabled={at + 1 === values.length}
                onClick={() => editor.list(path, { kind: 'move', from: at, to: at + 1 })}
              >
                아래로
              </button>
              <button
                type='button'
                onClick={() => editor.list(path, { kind: 'duplicate', index: at })}
              >
                복제
              </button>
              <button
                type='button'
                onClick={() => editor.list(path, { kind: 'remove', index: at })}
              >
                삭제
              </button>
            </div>
            {condition ? (
              <StackRuleCondition path={child} />
            ) : (
              <StackRuleExpression path={child} expected='bytes' label='합칠 바이트' />
            )}
          </fieldset>
        );
      })}
      <button
        type='button'
        onClick={() =>
          editor.list(path, {
            kind: 'add',
            value: (condition
              ? ruleCondition('compare')
              : ruleExpression(
                  'literal',
                  editor.context,
                  'bytes',
                )) as unknown as import('../domain/execution-contract.ts').JsonValue,
          })
        }
      >
        {condition ? '하위 조건 추가' : '합칠 바이트 추가'}
      </button>
    </RuleBoundary>
  );
}
