import { createContext, useContext, useState } from 'react';
import type { JsonValue } from '../domain/execution-contract.ts';
import { valueAt } from '../domain/json-pointer.ts';
import type { ModelDiagnostic } from '../domain/protocol-model.ts';
import type { StackProtocol, StackRule } from '../domain/stack-model.ts';
import type { StackDraft } from '../domain/workspace-v2-model.ts';
import {
  blockingRuleRaw,
  RULE_FORM_POLICY,
  type RuleListEdit,
  type RuleValueContext,
} from '../application/stack-rule-authoring.ts';

export type RuleEditor = {
  draft: StackDraft;
  protocol: StackProtocol;
  rule: StackRule;
  path: string;
  context: RuleValueContext;
  allowed: ReadonlySet<string>;
  pages: Readonly<Record<string, number>>;
  setPage: (path: string, page: number) => void;
  edit: (path: string, value: JsonValue | undefined) => void;
  json: (path: string, text: string) => void;
  list: (path: string, operation: RuleListEdit) => void;
  diagnostics: readonly ModelDiagnostic[];
  jsonPath: string | undefined;
  showJson: (path: string | undefined) => void;
};
export const RuleEditorContext = createContext<RuleEditor | null>(null);
/** Bind all tree widgets to the same current draft and canonical edit boundary. */
export function useRuleEditor(): RuleEditor {
  const value = useContext(RuleEditorContext);
  if (!value) throw new Error('Rule editor is required');
  return value;
}
/** Keep form diagnostic targets distinct from the optional advanced JSON controls. */
export const ruleControlId = (path: string) => `stack-form-${encodeURIComponent(path)}`;
type Choice = { value: string; label: string };

/** Preserve missing identities and search all declarations while rendering a bounded choice list. */
export function RuleChoice({
  path,
  label,
  value,
  options,
  change,
}: {
  path: string;
  label: string;
  value: string;
  options: readonly Choice[];
  change: (value: string) => void;
}) {
  const editor = useRuleEditor();
  const [search, setSearch] = useState('');
  const filtered = options.filter(
    (o) => !search || `${o.value} ${o.label}`.toLowerCase().includes(search.toLowerCase()),
  );
  const visible = filtered.slice(0, RULE_FORM_POLICY.choices);
  const known = options.some((o) => o.value === value);
  if (!visible.some((o) => o.value === value))
    visible.unshift({
      value,
      label: known
        ? (options.find((o) => o.value === value)?.label ?? value)
        : `${value || '(없음)'} · 참조 확인`,
    });
  const invalid = editor.diagnostics.some((d) => d.path === path || d.path.startsWith(`${path}/`));
  return (
    <div className='rule-choice'>
      {(options.length > RULE_FORM_POLICY.choices || !known) && (
        <label className='control'>
          <span>{label} 검색</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={`${label} 검색`}
            maxLength={160}
          />
        </label>
      )}
      <label className='control' htmlFor={ruleControlId(path)}>
        <span>{label}</span>
        <select
          id={ruleControlId(path)}
          data-rule-path={path}
          value={value}
          aria-invalid={invalid || undefined}
          onChange={(e) => change(e.target.value)}
        >
          {visible.slice(0, RULE_FORM_POLICY.choices).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label.slice(0, 48)}
            </option>
          ))}
        </select>
      </label>
      {filtered.length > RULE_FORM_POLICY.choices && (
        <small>검색으로 나머지 항목을 찾을 수 있습니다. 후보는 최대 20개 표시합니다.</small>
      )}
    </div>
  );
}

/** Edit a declared ID in place without dropping expressions when the target declaration changes. */
export function RuleReference({
  path,
  label,
  options,
}: {
  path: string;
  label: string;
  options: readonly { id: string; type?: string; label?: string }[];
}) {
  const editor = useRuleEditor();
  return (
    <RuleChoice
      path={path}
      label={label}
      value={String(valueAt(editor.draft.configuration, path) ?? '')}
      options={options.map((o) => ({
        value: o.id,
        label: `${o.id}${o.type ? ` (${o.type})` : o.label ? ` · ${o.label}` : ''}`,
      }))}
      change={(value) => editor.edit(path, value)}
    />
  );
}

/** Keep incomplete JSON in the original raw path; never truncate a large preserved value into an editable textarea. */
export function RuleJson({ path, label }: { path: string; label: string }) {
  const editor = useRuleEditor();
  const value = valueAt(editor.draft.configuration, path);
  const text = editor.draft.raw[path] ?? JSON.stringify(value, null, 2) ?? '';
  return (
    <label className='control' htmlFor={ruleControlId(`${path}/$json`)}>
      <span>{label}</span>
      {text.length > RULE_FORM_POLICY.jsonChars ? (
        <span>큰 JSON {text.length}자 · 원본을 보존합니다. bundle에서 수정할 수 있습니다.</span>
      ) : (
        <textarea
          id={ruleControlId(`${path}/$json`)}
          data-rule-json={path}
          rows={5}
          value={text}
          aria-invalid={editor.draft.raw[path] !== undefined || undefined}
          onChange={(e) => editor.json(path, e.target.value)}
        />
      )}
    </label>
  );
}

/** Block only the boundary obscured by pending JSON, exposing its exact text outside disabled form controls. */
export function RuleBoundary({ path, children }: { path: string; children: React.ReactNode }) {
  const editor = useRuleEditor();
  const blocked = blockingRuleRaw(editor.draft.raw, path);
  return (
    <>
      {blocked === path && (
        <>
          <p role='status'>미완성 JSON을 먼저 수정하세요. 하위 폼으로 덮어쓰지 않습니다.</p>
          <RuleJson path={path} label='미완성 JSON 수정' />
        </>
      )}
      <fieldset
        id={`stack-form-group-${encodeURIComponent(path)}`}
        tabIndex={-1}
        className='rule-boundary'
        disabled={blocked !== undefined}
        aria-label='규칙 폼 편집 경계'
      >
        {children}
      </fieldset>
    </>
  );
}

/** Page a nested list without changing the stored order. */
export function RuleListPager({ path, total }: { path: string; total: number }) {
  const editor = useRuleEditor();
  const pages = Math.max(1, Math.ceil(total / 10));
  const page = Math.max(0, Math.min(editor.pages[path] ?? 0, pages - 1));
  return (
    <div className='stack-inline'>
      <button type='button' disabled={page === 0} onClick={() => editor.setPage(path, page - 1)}>
        이전 10개
      </button>
      <span>
        {page + 1}/{pages} · 전체 {total}개
      </span>
      <button
        type='button'
        disabled={page + 1 === pages}
        onClick={() => editor.setPage(path, page + 1)}
      >
        다음 10개
      </button>
    </div>
  );
}

/** Preserve complex or unknown subtrees through an explicit, bounded JSON editor. */
export function RuleTreeFallback({ path }: { path: string }) {
  const editor = useRuleEditor();
  return (
    <div className='rule-tree-fallback' id={ruleControlId(path)} tabIndex={-1}>
      <p>폼 표시 범위 밖이거나 아직 해석할 수 없는 부분입니다. 원본을 유지합니다.</p>
      <button
        type='button'
        onClick={() => editor.showJson(editor.jsonPath === path ? undefined : path)}
      >
        이 부분 JSON 편집
      </button>
      {editor.jsonPath === path && <RuleJson path={path} label='하위 트리 JSON' />}
    </div>
  );
}
