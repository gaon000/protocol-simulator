/** biome-ignore-all lint/suspicious/noArrayIndexKey: Controlled form rows are keyed by their stable JSON Pointer within each structural generation. */
import { createContext, useContext, useEffect, useState } from 'react';
import type { JsonValue } from '../domain/execution-contract.ts';
import { valueAt } from '../domain/json-pointer.ts';
import type { ModelDiagnostic } from '../domain/protocol-model.ts';
import { type StackProtocol, stackProtocolBody } from '../domain/stack-model.ts';
import { stackObject, stackProtocolAt, stackTarget } from '../domain/stack-record.ts';
import type { StackDraft } from '../domain/workspace-v2-model.ts';
import type { RuleListEdit } from '../application/stack-rule-authoring.ts';
import { StackRuleForm } from './StackRuleForm.tsx';
import { StackPortForm, StackDeclarations } from './StackDefinitionForms.tsx';
import {
  newDiagramState,
  validDiagramEndpoint,
  type DraftDiagramSelection,
} from '../application/diagram-authoring.ts';
import type {
  StackDiagramAppend,
  StackDiagramCommand,
  StackDiagramSource,
} from '../application/stack-diagram-authoring.ts';
import { blockingStackRaw } from '../application/edit-stack-list.ts';
import { StackDraftDiagram } from './StackDraftDiagram.tsx';
import { StackScenarioForm } from './StackScenarioForm.tsx';

type Editor = {
  draft: StackDraft;
  edit: (path: string, value: JsonValue | undefined) => void;
  json: (path: string, text: string) => void;
  diagnostics: readonly ModelDiagnostic[];
  list: (path: string, operation: RuleListEdit) => void;
};
const Context = createContext<Editor | null>(null);
function useStackEditor() {
  const value = useContext(Context);
  if (!value) throw new Error('Stack editor is required');
  return value;
}
function Field({
  path,
  label,
  options,
  number = false,
  check = false,
  fraction = false,
}: {
  path: string;
  label: string;
  options?: readonly string[];
  number?: boolean;
  check?: boolean;
  fraction?: boolean;
}) {
  const editor = useStackEditor();
  const value = valueAt(editor.draft.configuration, path);
  const id = `stack-${encodeURIComponent(path)}`;
  const invalid = editor.diagnostics.some((d) => d.path === path || d.path.startsWith(`${path}/`));
  return (
    <label htmlFor={id} className={check ? 'check-control' : 'control'}>
      <span>{label}</span>
      {options ? (
        <select
          id={id}
          data-stack-path={path}
          aria-invalid={invalid || undefined}
          value={String(value ?? '')}
          onChange={(event) => editor.edit(path, event.target.value)}
        >
          {!options.includes(String(value ?? '')) && (
            <option value={String(value ?? '')}>{String(value ?? '선택')}</option>
          )}
          {options.slice(0, 80).map((option) => (
            <option key={option} value={option}>
              {option.slice(0, 80)}
            </option>
          ))}
        </select>
      ) : check ? (
        <input
          id={id}
          type='checkbox'
          data-stack-path={path}
          checked={value === true}
          onChange={(event) => editor.edit(path, event.target.checked)}
        />
      ) : (
        <input
          id={id}
          data-stack-path={path}
          aria-invalid={invalid || undefined}
          type={number ? 'number' : 'text'}
          step={fraction ? 'any' : undefined}
          value={number ? Number(value ?? 0) * (fraction ? 100 : 1) : String(value ?? '')}
          onChange={(event) => {
            const next = number
              ? Number(event.target.value) / (fraction ? 100 : 1)
              : event.target.value;
            if (typeof next !== 'number' || Number.isFinite(next)) editor.edit(path, next);
          }}
        />
      )}
    </label>
  );
}
function Json({
  path,
  label,
  optional = false,
}: {
  path: string;
  label: string;
  optional?: boolean;
}) {
  const editor = useStackEditor();
  const value = valueAt(editor.draft.configuration, path);
  const text = editor.draft.raw[path] ?? JSON.stringify(value, null, 2) ?? '';
  return (
    <label className='control' htmlFor={`stack-${encodeURIComponent(path)}`}>
      <span>{label}</span>
      {text.length > 16384 ? (
        <span>큰 값 {text.length.toLocaleString()}자 · 전체 값은 bundle로 보관합니다.</span>
      ) : (
        <textarea
          id={`stack-${encodeURIComponent(path)}`}
          data-stack-path={path}
          rows={Math.min(7, Math.max(2, text.split('\n').length))}
          aria-invalid={editor.draft.raw[path] !== undefined || undefined}
          value={text}
          onChange={(event) => {
            if (optional && !event.target.value.trim()) editor.edit(path, undefined);
            else editor.json(path, event.target.value);
          }}
        />
      )}
    </label>
  );
}
function Section({
  path,
  title,
  children,
}: {
  path: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className='editor-group' id={`stack-group-${encodeURIComponent(path)}`} tabIndex={-1}>
      <legend>{title}</legend>
      {children}
    </fieldset>
  );
}
function unique(items: readonly { id: string }[], prefix: string) {
  let n = 1;
  while (items.some((item) => item.id === `${prefix}_${n}`)) n++;
  return `${prefix}_${n}`;
}
function page(items: readonly unknown[], value: number) {
  const pages = Math.max(1, Math.ceil(items.length / 20));
  return { pages, index: Math.min(value, pages - 1) };
}

/** Author stable endpoints, typed ports, protocol rules, lower-link faults and endpoint-targeted scenarios. */
export function StackEditor({
  draft,
  edit: write,
  json: writeJson,
  diagnostics,
  list: writeList,
  synchronize,
  appendDiagram,
}: Editor & {
  synchronize: (protocol: StackProtocol) => void;
  appendDiagram: (
    source: StackDiagramSource,
    command: StackDiagramCommand,
  ) => StackDiagramAppend | undefined;
}) {
  const [tab, setTab] = useState('연결');
  const [graphOpen, setGraphOpen] = useState(false);
  const [graphSelection, setGraphSelection] = useState<{
    key: string;
    item: DraftDiagramSelection;
    inList: boolean;
  }>();
  const [graphFocus, setGraphFocus] = useState<string>();
  const [target, setTarget] = useState('A/app');
  const [messageIndex, setMessageIndex] = useState(0);
  const [statePage, setStatePage] = useState(0);
  const [rulePage, setRulePage] = useState(0);
  const [formIndex, setFormIndex] = useState(-1);
  const [jsonRule, setJsonRule] = useState(-1);
  const [formFocusPath, setFormFocusPath] = useState<string>();
  const [formFocusVersion, setFormFocusVersion] = useState(0);
  const configuration = draft.configuration;
  const endpoints = (['A', 'B'] as const).flatMap((participant) =>
    configuration.nodes[participant].instances.map((i) => ({ participant, instanceId: i.id })),
  );
  const selected = endpoints.find((e) => stackTarget(e) === target) ?? endpoints[0];
  let protocol: StackProtocol | undefined;
  try {
    if (selected)
      protocol = stackProtocolAt(
        {
          schemaVersion: 2,
          mode: 'stack',
          engineVersion: 'stack-1',
          randomAlgorithm: 'mulberry32-v1',
          configuration,
        },
        selected,
      );
  } catch {
    /* Unfinished endpoint references remain editable. */
  }
  const definitionIndex = protocol ? configuration.definitions.indexOf(protocol) : 0;

  const body = protocol ? stackProtocolBody(protocol) : undefined;
  const base = `/definitions/${definitionIndex}`;
  const prefix = `${base}${protocol?.mode === 'legacy-application' ? '/source' : ''}`;
  const message = body?.messages[messageIndex] ?? body?.messages[0];
  const mi = message ? (body?.messages.indexOf(message) ?? 0) : 0;
  function selectionKey(
    current: StackDraft,
    override?: { collection: 'states' | 'rules'; index: number; id: string },
  ) {
    const selectedProtocol = current.configuration.definitions[definitionIndex];
    const currentBody = selectedProtocol && stackProtocolBody(selectedProtocol);
    return JSON.stringify([
      current.id,
      target,
      definitionIndex,
      selectedProtocol?.id,
      currentBody?.states.map((s, i) =>
        override?.collection === 'states' && override.index === i ? override.id : s.id,
      ),
      currentBody?.rules.map((r, i) =>
        override?.collection === 'rules' && override.index === i ? override.id : r.id,
      ),
    ]);
  }
  const graphKey = selectionKey(draft);
  const graphItem = graphSelection?.key === graphKey ? graphSelection.item : undefined;
  const detached = graphOpen && !graphSelection?.inList ? graphItem : undefined;
  const collectionRaw = [
    ...new Set(
      ['states', 'rules']
        .map((kind) => blockingStackRaw(draft.raw, `${prefix}/${kind}`))
        .filter((p): p is string => p !== undefined),
    ),
  ];
  function edit(path: string, value: JsonValue | undefined) {
    const renamed = /\/(states|rules)\/(\d+)\/id$/.exec(path);
    if (graphSelection?.key === graphKey && renamed && typeof value === 'string')
      setGraphSelection({
        ...graphSelection,
        key: selectionKey(draft, {
          collection: renamed[1] as 'states' | 'rules',
          index: Number(renamed[2]),
          id: value,
        }),
      });
    if (/\/(states|rules)(?:\/\d+)?$/.test(path)) setGraphSelection(undefined);
    write(path, value);
  }
  function json(path: string, text: string) {
    if (/\/(states|rules)(?:\/\d+)?$/.test(path)) setGraphSelection(undefined);
    writeJson(path, text);
  }
  function list(path: string, operation: RuleListEdit) {
    if (/\/(states|rules)$/.test(path)) setGraphSelection(undefined);
    writeList(path, operation);
  }
  function selectGraph(item: DraftDiagramSelection, updated?: StackDraft) {
    setGraphSelection({ key: selectionKey(updated ?? draft), item, inList: false });
    setFormFocusPath(undefined);
    setJsonRule(-1);
    if (item.kind === 'state') setStatePage(Math.floor(item.index / 20));
    else {
      setRulePage(Math.floor(item.index / 20));
      setFormIndex(item.index);
    }
    if (updated)
      setGraphFocus(
        `${prefix}/${item.kind === 'state' ? 'states' : 'rules'}/${item.index}/${item.kind === 'state' ? 'label' : 'id'}`,
      );
  }
  useEffect(() => {
    if (!graphFocus) return;
    const node = document.getElementById(`stack-${encodeURIComponent(graphFocus)}`);
    if (node) {
      node.focus({ preventScroll: true });
      node.scrollIntoView({ block: 'nearest' });
    }
    setGraphFocus(undefined);
  }, [graphFocus]);
  function stateRow(index: number) {
    const s = body?.states[index];
    if (!s) return null;
    const path = `${prefix}/states/${index}`;
    const blocked = blockingStackRaw(draft.raw, path);
    return (
      <div className='stack-card' key={index}>
        {blocked === path && <Json path={path} label='미완성 상태 JSON 수정' />}
        <fieldset
          className='rule-boundary'
          id={`stack-group-${encodeURIComponent(path)}`}
          tabIndex={-1}
          disabled={blocked !== undefined}
        >
          <Field path={`${prefix}/states/${index}/id`} label='상태 ID' />
          <Field path={`${prefix}/states/${index}/label`} label='상태 이름' />
          <Field path={`${prefix}/states/${index}/terminal`} label='종료 상태' check />
          <button
            type='button'
            disabled={
              !body ||
              body.initialStateId === s.id ||
              !validDiagramEndpoint(body, { index, id: s.id }) ||
              blockingStackRaw(draft.raw, `${prefix}/initialStateId`) !== undefined
            }
            onClick={() => edit(`${prefix}/initialStateId`, s.id)}
          >
            초기 상태로 지정 · {s.id}
          </button>
          <button type='button' onClick={() => list(`${prefix}/states`, { kind: 'remove', index })}>
            상태 삭제 · {s.id}
          </button>
        </fieldset>
      </div>
    );
  }
  function ruleRow(index: number) {
    const rule = body?.rules[index];
    if (!rule || !protocol || !body) return null;
    return (
      <Section key={index} path={`${prefix}/rules/${index}`} title={rule.id}>
        <fieldset
          className='rule-boundary'
          disabled={blockingStackRaw(draft.raw, `${prefix}/rules/${index}`) !== undefined}
        >
          <Field path={`${prefix}/rules/${index}/id`} label='규칙 ID' />
          <Field
            path={`${prefix}/rules/${index}/fromStateId`}
            label='이전 상태'
            options={body.states.map((s) => s.id)}
          />
          <Field
            path={`${prefix}/rules/${index}/nextStateId`}
            label='다음 상태'
            options={body.states.map((s) => s.id)}
          />
          <button
            type='button'
            onClick={() => {
              setFormFocusPath(undefined);
              setFormIndex(formIndex === index ? -1 : index);
            }}
          >
            규칙 폼 {formIndex === index ? '닫기' : '열기'} · {rule.id.slice(0, 60)} · {index + 1}
          </button>
        </fieldset>
        {formIndex === index && !blockingStackRaw(draft.raw, `${prefix}/rules`) && (
          <StackRuleForm
            key={`${target}:${prefix}:${index}:${formFocusPath ?? ''}:${formFocusVersion}`}
            draft={draft}
            protocol={protocol}
            rule={rule}
            path={`${prefix}/rules/${index}`}
            edit={edit}
            json={json}
            list={list}
            diagnostics={diagnostics}
            {...(formFocusPath ? { focusPath: formFocusPath } : {})}
          />
        )}
        <fieldset
          className='rule-boundary'
          disabled={blockingStackRaw(draft.raw, `${prefix}/rules/${index}`) !== undefined}
        >
          <details
            open={jsonRule === index}
            onToggle={(event) => {
              if (event.currentTarget.open) setJsonRule(index);
              else setJsonRule((old) => (old === index ? -1 : old));
            }}
          >
            <summary>
              규칙 JSON 편집 · {rule.id.slice(0, 60)} · {index + 1}
            </summary>
            {jsonRule === index && (
              <>
                <Json
                  path={`${prefix}/rules/${index}/event`}
                  label='입력·수신·타이머·포트 이벤트 JSON'
                />
                {rule.condition ? (
                  <Json path={`${prefix}/rules/${index}/condition`} label='조건 JSON' optional />
                ) : (
                  <button
                    type='button'
                    onClick={() =>
                      edit(`${prefix}/rules/${index}/condition`, {
                        kind: 'compare',
                        operator: 'eq',
                        left: { kind: 'literal', value: 1 },
                        right: { kind: 'literal', value: 1 },
                      })
                    }
                  >
                    조건 추가 · {rule.id}
                  </button>
                )}
                <Json path={`${prefix}/rules/${index}/actions`} label='순서대로 실행할 동작 JSON' />
              </>
            )}
          </details>
          <Field path={`${prefix}/rules/${index}/ignore`} label='명시적 무시' check />
          <button
            type='button'
            onClick={() => {
              setFormIndex(-1);
              setJsonRule(-1);
              list(`${prefix}/rules`, { kind: 'remove', index });
            }}
          >
            규칙 삭제 · {rule.id}
          </button>
        </fieldset>
      </Section>
    );
  }
  function endpointControl(
    path: string,
    label: string,
    ports: 'requires' | 'provides' | undefined = undefined,
    participant?: string,
  ) {
    const current = stackObject(valueAt(configuration, path));
    const options = endpoints
      .filter((e) => !participant || e.participant === participant)
      .flatMap((endpoint) => {
        try {
          const p = stackProtocolAt(
            {
              schemaVersion: 2,
              mode: 'stack',
              engineVersion: 'stack-1',
              randomAlgorithm: 'mulberry32-v1',
              configuration,
            },
            endpoint,
          );
          const port =
            ports === 'provides'
              ? p.mode === 'stack-protocol'
                ? p.provides
                : undefined
              : p.requires;
          return ports && !port
            ? []
            : [
                {
                  key: `${stackTarget(endpoint)}${ports ? `/${port?.id ?? ''}` : ''}`,
                  endpoint,
                  port,
                },
              ];
        } catch {
          return [];
        }
      });
    const key = `${current.participant}/${current.instanceId}${ports ? `/${current.portId}` : ''}`;
    return (
      <label className='control'>
        <span>{label}</span>
        <select
          data-stack-path={path}
          id={`stack-${encodeURIComponent(path)}`}
          value={key}
          onChange={(event) => {
            const choice = options.find((item) => item.key === event.target.value);
            if (choice)
              edit(path, {
                ...choice.endpoint,
                ...(ports ? { portId: choice.port?.id ?? '' } : {}),
              });
          }}
        >
          {!options.some((o) => o.key === key) && <option value={key}>{key} · 참조 확인</option>}
          {options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.key}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <Context value={{ draft, edit, json, diagnostics, list }}>
      <section className='stack-editor' aria-label='스택 편집'>
        <div className='stack-tabs' role='tablist' aria-label='스택 편집 영역'>
          {['연결', '프로토콜 정의', '하위 환경', '입력·기대 조건'].map((name) => (
            <button
              type='button'
              role='tab'
              aria-selected={tab === name}
              key={name}
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
        </div>
        <Field path='/label' label='스택 실험 이름' />
        {tab === '연결' && (
          <>
            <div className='stack-node-grid'>
              {(['A', 'B'] as const).map((participant) => (
                <Section
                  path={`/nodes/${participant}`}
                  title={`참여자 ${participant}의 계층`}
                  key={participant}
                >
                  {configuration.nodes[participant].instances.map((instance, index) => (
                    <div className='stack-card' key={index}>
                      <Field
                        path={`/nodes/${participant}/instances/${index}/id`}
                        label={`${participant} 계층 ${index + 1} ID`}
                      />
                      <label className='control'>
                        <span>
                          {participant}/{instance.id} 정의
                        </span>
                        <select
                          value={`${instance.definition.id}@${instance.definition.revision}`}
                          onChange={(event) => {
                            const p = configuration.definitions.find(
                              (p) => `${p.id}@${p.revision}` === event.target.value,
                            );
                            if (p)
                              edit(`/nodes/${participant}/instances/${index}/definition`, {
                                id: p.id,
                                revision: p.revision,
                              });
                          }}
                        >
                          <option
                            value={`${instance.definition.id}@${instance.definition.revision}`}
                          >
                            {instance.definition.id} · r{instance.definition.revision}
                          </option>
                          {configuration.definitions
                            .slice(0, 40)
                            .filter(
                              (p) =>
                                p.id !== instance.definition.id ||
                                p.revision !== instance.definition.revision,
                            )
                            .map((p) => (
                              <option key={`${p.id}@${p.revision}`} value={`${p.id}@${p.revision}`}>
                                {p.id} · r{p.revision}
                              </option>
                            ))}
                        </select>
                      </label>
                    </div>
                  ))}
                </Section>
              ))}
            </div>
            {configuration.bindings.map((binding, index) => (
              <Section key={index} path={`/bindings/${index}`} title={`로컬 연결 ${binding.id}`}>
                <Field path={`/bindings/${index}/id`} label={`연결 ${index + 1} ID`} />
                {endpointControl(`/bindings/${index}/consumer`, '상위 requires', 'requires')}
                {endpointControl(`/bindings/${index}/provider`, '하위 provides', 'provides')}
                <button type='button' onClick={() => edit(`/bindings/${index}`, undefined)}>
                  연결 삭제 · {binding.id}
                </button>
              </Section>
            ))}
            <button
              type='button'
              onClick={() =>
                edit('/bindings', [
                  ...configuration.bindings,
                  {
                    id: unique(configuration.bindings, 'binding'),
                    consumer: {
                      participant: 'A',
                      instanceId: configuration.nodes.A.instances[0]?.id ?? 'app',
                      portId: 'lower',
                    },
                    provider: {
                      participant: 'A',
                      instanceId: configuration.nodes.A.instances[1]?.id ?? 'transport',
                      portId: 'upper',
                    },
                  },
                ])
              }
            >
              로컬 연결 추가
            </button>
            <Section path='/link' title='최하위 데이터그램 링크'>
              <Field path='/link/id' label='링크 ID' />
              {endpointControl('/link/A', 'A 링크 포트', 'requires', 'A')}
              {endpointControl('/link/B', 'B 링크 포트', 'requires', 'B')}
            </Section>
          </>
        )}
        {tab === '프로토콜 정의' && (
          <>
            <label className='control'>
              <span>편집할 인스턴스</span>
              <select
                value={selected ? stackTarget(selected) : ''}
                onChange={(event) => {
                  setTarget(event.target.value);
                  setMessageIndex(0);
                  setRulePage(0);
                  setStatePage(0);
                  setFormIndex(-1);
                  setJsonRule(-1);
                }}
              >
                {endpoints.map((e) => (
                  <option key={stackTarget(e)}>{stackTarget(e)}</option>
                ))}
              </select>
            </label>
            {body && protocol && (
              <>
                <p>
                  실행 snapshot은 변경하지 않습니다. 같은 정의 revision을 참조하는 인스턴스는 함께
                  갱신됩니다.
                </p>
                {collectionRaw.map((where) => (
                  <Json key={where} path={where} label={`상태도 미완성 JSON 수정 · ${where}`} />
                ))}
                <details
                  className='stack-visual-details'
                  open={graphOpen}
                  onToggle={(event) => {
                    setGraphOpen(event.currentTarget.open);
                  }}
                >
                  <summary>초안 상태도 편집 보기</summary>
                  {graphOpen && selected && (
                    <div className={`stack-visual-authoring ${detached ? 'has-selection' : ''}`}>
                      <StackDraftDiagram
                        key={`${draft.id}:${target}:${definitionIndex}`}
                        draft={draft}
                        endpoint={selected}
                        protocol={protocol}
                        definition={definitionIndex}
                        selection={graphItem}
                        onSelect={selectGraph}
                        append={appendDiagram}
                      />
                      {detached && (
                        <section
                          className='draft-diagram-editor'
                          aria-label='스택 상태도 선택 편집기'
                        >
                          <h2>선택한 {detached.kind === 'state' ? '상태' : '규칙'} 편집</h2>
                          <p>초안에 반영하고 자동 저장합니다. 실행 당시 정의는 유지합니다.</p>
                          <button
                            type='button'
                            onClick={() => {
                              if (graphSelection)
                                setGraphSelection({ ...graphSelection, inList: true });
                              setGraphFocus(
                                `${prefix}/${detached.kind === 'state' ? 'states' : 'rules'}/${detached.index}/id`,
                              );
                            }}
                          >
                            전체 목록에서 편집
                          </button>
                          {diagnostics
                            .filter(
                              (d) =>
                                d.path ===
                                  `${prefix}/${detached.kind === 'state' ? 'states' : 'rules'}/${detached.index}` ||
                                d.path.startsWith(
                                  `${prefix}/${detached.kind === 'state' ? 'states' : 'rules'}/${detached.index}/`,
                                ),
                            )
                            .slice(0, 16)
                            .map((d, i) => (
                              <p key={i} role='status'>
                                {d.path} · {d.message}
                              </p>
                            ))}
                          {detached.kind === 'state'
                            ? stateRow(detached.index)
                            : ruleRow(detached.index)}
                        </section>
                      )}
                    </div>
                  )}
                </details>
                <Field path={`${base}/id`} label='프로토콜 ID' />
                <Field path={`${prefix}/label`} label='프로토콜 이름' />
                <Field
                  path={`${prefix}/codec`}
                  label='코덱'
                  options={['json-lines', 'json-datagram', 'logical-packet', 'http-1.1']}
                />
                {protocol.mode === 'stack-protocol' && (
                  <Field
                    path={`${base}/layer`}
                    label='계층 역할'
                    options={['application', 'transport']}
                  />
                )}
                <Section path={`${base}/requires`} title={`요구 서비스 · ${protocol.requires.id}`}>
                  <StackPortForm
                    draft={draft}
                    edit={edit}
                    json={json}
                    path={`${base}/requires`}
                    port={protocol.requires}
                    protocol={protocol}
                  />
                </Section>
                {protocol.mode === 'stack-protocol' && (
                  <Section path={`${base}/provides`} title='제공 서비스'>
                    <button
                      type='button'
                      onClick={() =>
                        edit(
                          `${base}/provides`,
                          protocol.provides
                            ? undefined
                            : {
                                id: 'upper',
                                role: 'provides',
                                service: { kind: 'stream', payload: 'bytes' },
                                request: 'write',
                                indication: 'read',
                                lifecycle: { initial: 'ready', notifications: ['failed'] },
                              },
                        )
                      }
                    >
                      {protocol.provides ? '제공 포트 삭제' : '스트림 제공 포트 추가'}
                    </button>
                    {protocol.provides && (
                      <StackPortForm
                        draft={draft}
                        edit={edit}
                        json={json}
                        path={`${base}/provides`}
                        port={protocol.provides}
                        protocol={protocol}
                      />
                    )}
                  </Section>
                )}
                <Section path={`${prefix}/messages`} title='메시지 형식'>
                  <label className='control'>
                    <span>메시지 선택</span>
                    <select
                      value={mi}
                      onChange={(event) => setMessageIndex(Number(event.target.value))}
                    >
                      {body.messages.slice(0, 40).map((m, index) => (
                        <option value={index} key={index}>
                          {m.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type='button'
                    onClick={() =>
                      edit(`${prefix}/messages`, [
                        ...body.messages,
                        { id: unique(body.messages, 'message'), label: '새 메시지', fields: [] },
                      ])
                    }
                  >
                    메시지 추가
                  </button>
                  {message && (
                    <>
                      <Field path={`${prefix}/messages/${mi}/id`} label='메시지 ID' />
                      <Field path={`${prefix}/messages/${mi}/label`} label='메시지 이름' />
                      {message.fields.slice(0, 20).map((field, index) => (
                        <Section
                          key={index}
                          path={`${prefix}/messages/${mi}/fields/${index}`}
                          title={`필드 ${index + 1}`}
                        >
                          <Field
                            path={`${prefix}/messages/${mi}/fields/${index}/id`}
                            label='필드 ID'
                          />
                          <Field
                            path={`${prefix}/messages/${mi}/fields/${index}/name`}
                            label='wire 이름'
                          />
                          <Field
                            path={`${prefix}/messages/${mi}/fields/${index}/type`}
                            label='필드 타입'
                            options={
                              protocol.mode === 'stack-protocol'
                                ? ['string', 'integer', 'boolean', 'enum', 'bytes']
                                : ['string', 'integer', 'boolean', 'enum']
                            }
                          />
                          <Field
                            path={`${prefix}/messages/${mi}/fields/${index}/placement`}
                            label='구획'
                            options={['header', 'body', 'payload']}
                          />
                          <Field
                            path={`${prefix}/messages/${mi}/fields/${index}/required`}
                            label='필수 필드'
                            check
                          />
                          <button
                            type='button'
                            onClick={() =>
                              edit(`${prefix}/messages/${mi}/fields/${index}`, undefined)
                            }
                          >
                            필드 삭제 · {field.id}
                          </button>
                        </Section>
                      ))}
                      {message.fields.length > 20 && (
                        <p>
                          처음 20개 필드를 표시합니다. 나머지는 아래 JSON에서 편집할 수 있습니다.
                        </p>
                      )}
                      <button
                        type='button'
                        onClick={() =>
                          edit(`${prefix}/messages/${mi}/fields`, [
                            ...message.fields,
                            {
                              id: unique(message.fields, 'field'),
                              name: unique(message.fields, 'field'),
                              type: 'string',
                              required: false,
                              placement: 'payload',
                            },
                          ])
                        }
                      >
                        필드 추가
                      </button>
                      <details>
                        <summary>필드 제약·기본값·HTTP 매핑 JSON</summary>
                        <Json path={`${prefix}/messages/${mi}`} label='선택 메시지 JSON' />
                      </details>
                    </>
                  )}
                  {protocol.mode === 'stack-protocol' &&
                    protocol.requires.service.payload !== 'bytes' && (
                      <button type='button' onClick={() => synchronize(protocol)}>
                        양쪽 패킷 형식 맞추기
                      </button>
                    )}
                </Section>
                <StackDeclarations
                  key={`${target}:${prefix}:${formFocusVersion}`}
                  draft={draft}
                  edit={edit}
                  json={json}
                  path={prefix}
                  protocol={protocol}
                  list={list}
                  {...(formFocusPath ? { focusPath: formFocusPath } : {})}
                />
                <Section path={`${prefix}/states`} title='상태'>
                  <Field
                    path={`${prefix}/initialStateId`}
                    label='초기 상태'
                    options={body.states.map((s) => s.id)}
                  />
                  {body.states
                    .slice(
                      page(body.states, statePage).index * 20,
                      (page(body.states, statePage).index + 1) * 20,
                    )
                    .map((_, offset) => {
                      const index = page(body.states, statePage).index * 20 + offset;
                      return detached?.kind === 'state' && detached.index === index
                        ? null
                        : stateRow(index);
                    })}
                  <button
                    type='button'
                    disabled={statePage === 0}
                    onClick={() => setStatePage(Math.max(0, statePage - 1))}
                  >
                    이전 상태 페이지
                  </button>
                  <button
                    type='button'
                    disabled={statePage + 1 >= page(body.states, statePage).pages}
                    onClick={() => setStatePage(statePage + 1)}
                  >
                    다음 상태 페이지
                  </button>
                  <button
                    type='button'
                    onClick={() =>
                      list(`${prefix}/states`, {
                        kind: 'add',
                        value: newDiagramState(body),
                      })
                    }
                  >
                    상태 추가
                  </button>
                </Section>
                <Section path={`${prefix}/rules`} title='규칙'>
                  {body.rules
                    .slice(
                      page(body.rules, rulePage).index * 20,
                      (page(body.rules, rulePage).index + 1) * 20,
                    )
                    .map((_, offset) => {
                      const index = page(body.rules, rulePage).index * 20 + offset;
                      return detached?.kind === 'rule' && detached.index === index
                        ? null
                        : ruleRow(index);
                    })}
                  <button
                    type='button'
                    disabled={rulePage === 0}
                    onClick={() => {
                      setFormIndex(-1);
                      setJsonRule(-1);
                      setRulePage(Math.max(0, rulePage - 1));
                    }}
                  >
                    이전 규칙 페이지
                  </button>
                  <button
                    type='button'
                    disabled={rulePage + 1 >= page(body.rules, rulePage).pages}
                    onClick={() => {
                      setFormIndex(-1);
                      setJsonRule(-1);
                      setRulePage(rulePage + 1);
                    }}
                  >
                    다음 규칙 페이지
                  </button>
                  <button
                    type='button'
                    onClick={() => {
                      setFormIndex(body.rules.length);
                      setRulePage(Math.floor(body.rules.length / 20));
                      setJsonRule(-1);
                      list(`${prefix}/rules`, {
                        kind: 'add',
                        value: {
                          id: unique(body.rules, 'rule'),
                          fromStateId: body.initialStateId,
                          nextStateId: body.initialStateId,
                          event: { kind: 'input', messageId: body.messages[0]?.id ?? 'message' },
                          actions: [],
                        },
                      });
                    }}
                  >
                    규칙 추가
                  </button>
                </Section>
              </>
            )}
          </>
        )}
        {tab === '하위 환경' && (
          <>
            <Field path='/seed' label='스택 seed' number />
            {(['AtoB', 'BtoA'] as const).map((direction) => (
              <Section
                path={`/link/environment/directions/${direction}`}
                title={direction === 'AtoB' ? '하위 A → B' : '하위 B → A'}
                key={direction}
              >
                <Field
                  path={`/link/environment/directions/${direction}/delayMs`}
                  label='패킷 지연 ms'
                  number
                />
                <Field
                  path={`/link/environment/directions/${direction}/jitterMs`}
                  label='지터 ms'
                  number
                />
                <Field
                  path={`/link/environment/directions/${direction}/lossRate`}
                  label='패킷 손실 %'
                  number
                  fraction
                />
                <Field
                  path={`/link/environment/directions/${direction}/duplicateRate`}
                  label='패킷 중복 %'
                  number
                  fraction
                />
              </Section>
            ))}
            <Json path='/link/environment/targetedDrops' label='특정 하위 전송 손실 JSON' />
            <button
              type='button'
              onClick={() =>
                edit('/link/environment/targetedDrops', [{ direction: 'BtoA', transmission: 1 }])
              }
            >
              첫 ACK 손실 설정
            </button>
            <button type='button' onClick={() => edit('/link/environment/targetedDrops', [])}>
              특정 손실 해제
            </button>
            <p>
              장애는 최하위 데이터그램에만 적용합니다. Lite는 TCP 전체 구현이 아닌 사용자 정의
              규약입니다.
            </p>
          </>
        )}
        {tab === '입력·기대 조건' && (
          <StackScenarioForm
            key={`${draft.id}:${formFocusVersion}`}
            draft={draft}
            edit={edit}
            json={json}
            list={list}
            diagnostics={diagnostics}
            {...(formFocusPath ? { focusPath: formFocusPath } : {})}
          />
        )}
        <section aria-label='스택 정의 진단'>
          <h3>정의 진단 · {diagnostics.length}개</h3>
          {diagnostics.length ? (
            diagnostics.slice(0, 20).map((d, index) => (
              <button
                className='diagnostic-link'
                key={index}
                type='button'
                onClick={() => {
                  setGraphSelection(undefined);
                  const stateMatch = /\/states\/(\d+)(?:\/|$)/.exec(d.path);
                  if (stateMatch) setStatePage(Math.floor(Number(stateMatch[1]) / 20));
                  setFormFocusPath(d.path);
                  setFormFocusVersion((version) => version + 1);
                  const definitionMatch = /^\/definitions\/(\d+)(?:\/|$)/.exec(d.path);
                  if (definitionMatch) {
                    const definition = configuration.definitions[Number(definitionMatch[1])];
                    const owner = endpoints.find((endpoint) =>
                      configuration.nodes[endpoint.participant].instances.some(
                        (instance) =>
                          instance.id === endpoint.instanceId &&
                          instance.definition.id === definition?.id &&
                          instance.definition.revision === definition?.revision,
                      ),
                    );
                    if (owner) setTarget(stackTarget(owner));
                  }
                  const match = /^\/definitions\/(\d+)\/(?:source\/)?rules\/(\d+)(?:\/|$)/.exec(
                    d.path,
                  );
                  if (match) {
                    const definition = configuration.definitions[Number(match[1])];
                    const owner = endpoints.find((endpoint) => {
                      const instance = configuration.nodes[endpoint.participant].instances.find(
                        (i) => i.id === endpoint.instanceId,
                      );
                      return (
                        instance?.definition.id === definition?.id &&
                        instance?.definition.revision === definition?.revision
                      );
                    });
                    if (owner) setTarget(stackTarget(owner));
                    const rule = Number(match[2]);
                    setRulePage(Math.floor(rule / 20));
                    setFormIndex(rule);
                    setJsonRule(rule);
                  }
                  setTab(
                    d.path.startsWith('/scenario')
                      ? '입력·기대 조건'
                      : d.path.startsWith('/link/environment')
                        ? '하위 환경'
                        : d.path.startsWith('/definitions')
                          ? '프로토콜 정의'
                          : '연결',
                  );
                  setTimeout(() => {
                    let path = d.path;
                    while (path) {
                      const node =
                        document.getElementById(`stack-form-${encodeURIComponent(path)}`) ??
                        document.getElementById(
                          `stack-form-${encodeURIComponent(`${path}/$json`)}`,
                        ) ??
                        document.getElementById(`stack-form-group-${encodeURIComponent(path)}`) ??
                        document.getElementById(`stack-${encodeURIComponent(path)}`) ??
                        document.getElementById(`stack-group-${encodeURIComponent(path)}`);
                      if (node) {
                        node.focus();
                        node.scrollIntoView({ block: 'nearest' });
                        break;
                      }
                      path = path.slice(0, path.lastIndexOf('/'));
                    }
                  }, 0);
                }}
              >
                {d.path} · {d.message}
              </button>
            ))
          ) : (
            <p>실행 가능한 스택 구성입니다.</p>
          )}
        </section>
      </section>
    </Context>
  );
}
