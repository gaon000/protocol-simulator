import { createContext, useContext, useId, type ReactNode } from 'react';
import { valueAt } from '../application/edit-experiment.ts';
import type { JsonValue } from '../domain/execution-contract.ts';
import type { ExperimentDefinition, ModelDiagnostic } from '../domain/protocol-model.ts';

export type EditorContextValue = {
  draft: ExperimentDefinition;
  diagnostics: readonly ModelDiagnostic[];
  raw: Readonly<Record<string, string>>;
  edit: (path: string, value: JsonValue | undefined) => void;
  editJson: (path: string, text: string) => void;
};
export const EditorContext = createContext<EditorContextValue | null>(null);

/** Read the current draft editor, independent of the captured run snapshot. */
export function useEditor(): EditorContextValue {
  const editor = useContext(EditorContext);
  if (!editor) throw new Error('EditorContext is required');
  return editor;
}

/** Provide a focusable ancestor for diagnostics pointing to a collection or model object. */
export function Group({
  path,
  title,
  children,
}: {
  path: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <fieldset
      className='editor-group'
      id={`editor-${encodeURIComponent(path)}`}
      data-path={path}
      tabIndex={-1}
    >
      <legend>{title}</legend>
      {children}
    </fieldset>
  );
}

type ControlProps = {
  path: string;
  label: string;
  options?: readonly string[];
  type?: 'text' | 'number' | 'checkbox';
  optional?: boolean;
};

/** Edit one scalar using a labelled native control and the diagnostic pointer as focus target. */
export function Control({ path, label, options, type = 'text', optional = false }: ControlProps) {
  const { draft, edit, diagnostics } = useEditor();
  const id = useId();
  const value = valueAt(draft, path);
  const invalid = diagnostics.some(
    (item) => item.path === path || item.path.startsWith(`${path}/`),
  );
  const shared = { id, 'data-path': path, 'aria-invalid': invalid || undefined };
  return (
    <label htmlFor={id} className={type === 'checkbox' ? 'check-control' : 'control'}>
      <span>{label}</span>
      {options ? (
        <select
          {...shared}
          value={String(value ?? '')}
          onChange={(event) => edit(path, event.target.value)}
        >
          {!options.includes(String(value ?? '')) && (
            <option value={String(value ?? '')}>{String(value ?? '선택')}</option>
          )}
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : type === 'checkbox' ? (
        <input
          {...shared}
          type='checkbox'
          checked={value === true}
          onChange={(event) => edit(path, event.target.checked)}
        />
      ) : (
        <input
          {...shared}
          type={type}
          value={value === undefined ? '' : String(value)}
          onChange={(event) => {
            const text = event.target.value;
            edit(
              path,
              type === 'number'
                ? text === '' && optional
                  ? undefined
                  : Number(text)
                : text === '' && optional
                  ? undefined
                  : text,
            );
          }}
        />
      )}
    </label>
  );
}

/** Keep unfinished JSON visible in the draft editor and block execution until it is valid. */
export function JsonControl({ path, label }: { path: string; label: string }) {
  const { draft, raw, editJson, diagnostics } = useEditor();
  const value = raw[path] ?? JSON.stringify(valueAt(draft, path) ?? null);
  return (
    <label className='control'>
      <span>{label} (JSON 값)</span>
      <textarea
        rows={2}
        data-path={path}
        value={value}
        aria-invalid={diagnostics.some((item) => item.path === path) || undefined}
        onChange={(event) => editJson(path, event.target.value)}
      />
    </label>
  );
}

/** Remove an object without silently removing references; validation explains any remaining links. */
export function Remove({ path, label = '삭제' }: { path: string; label?: string }) {
  const { edit } = useEditor();
  return (
    <button type='button' className='subtle danger' onClick={() => edit(path, undefined)}>
      {label}
    </button>
  );
}
