import { useEffect, useMemo, useRef, useState } from 'react';
import type { JsonValue } from '../domain/execution-contract.ts';
import { pointerToken, valueAt } from '../domain/json-pointer.ts';
import type { ModelDiagnostic } from '../domain/protocol-model.ts';
import type {
  StackAction,
  StackProtocol,
  StackRule,
  StackRuleEvent,
} from '../domain/stack-model.ts';
import { stackObject } from '../domain/stack-record.ts';
import type { StackDraft } from '../domain/workspace-v2-model.ts';
import {
  blockingRuleRaw,
  ruleAction,
  ruleCondition,
  ruleEvent,
  ruleFormTreePaths,
  ruleFormFocusPages,
  ruleLiteral,
  stackRuleValueContext,
  type RuleListEdit,
} from '../application/stack-rule-authoring.ts';
import {
  RuleBoundary,
  RuleChoice,
  RuleEditorContext,
  RuleJson,
  RuleListPager,
  RuleReference,
  useRuleEditor,
} from './StackRuleControls.tsx';
import { StackRuleCondition, StackRuleExpression } from './StackRuleTree.tsx';

/** Edit one selected rule through the same canonical paths as JSON, preserving snapshots and raw text. */
export function StackRuleForm({
  draft,
  protocol,
  rule,
  path,
  edit,
  json,
  list,
  diagnostics,
  focusPath,
}: {
  draft: StackDraft;
  protocol: StackProtocol;
  rule: StackRule;
  path: string;
  edit: (path: string, value: JsonValue | undefined) => void;
  json: (path: string, text: string) => void;
  list: (path: string, operation: RuleListEdit) => void;
  diagnostics: readonly ModelDiagnostic[];
  focusPath?: string;
}) {
  const [actionIndex, setActionIndex] = useState(() =>
    Number(focusPath?.match(/\/actions\/(\d+)/)?.[1] ?? 0),
  );
  const [pages, setPages] = useState<Readonly<Record<string, number>>>(() =>
    ruleFormFocusPages(draft.configuration, focusPath),
  );
  const [jsonPath, showJson] = useState<string>();
  const [addKind, setAddKind] = useState<StackAction['kind']>('assign');
  const [focus, setFocus] = useState<string>();
  const container = useRef<HTMLElement>(null);
  const context = useMemo(() => stackRuleValueContext(protocol, rule), [protocol, rule]);
  const selected = Math.max(0, Math.min(actionIndex, rule.actions.length - 1));
  const allowed = useMemo(
    () => ruleFormTreePaths(rule, selected, path, pages),
    [rule, selected, path, pages],
  );
  const actionsPath = `${path}/actions`;
  const page = Math.max(
    0,
    Math.min(pages[actionsPath] ?? 0, Math.max(0, Math.ceil(rule.actions.length / 10) - 1)),
  );
  const blocked = blockingRuleRaw(draft.raw, path);
  useEffect(() => {
    if (focus && draft.configuration) {
      const node = [
        ...(container.current?.querySelectorAll<HTMLElement>('[data-rule-focus]') ?? []),
      ].find((e) => e.dataset.ruleFocus === focus);
      if (node) {
        node.focus({ preventScroll: true });
        setFocus(undefined);
      }
    }
  }, [focus, draft.configuration]);
  function changeList(where: string, operation: RuleListEdit) {
    if (blockingRuleRaw(draft.raw, where)) return;
    showJson(undefined);
    if (where === actionsPath) {
      let next = selected;
      if (operation.kind === 'add') next = rule.actions.length;
      else if (operation.kind === 'duplicate') next = operation.index + 1;
      else if (operation.kind === 'remove')
        next =
          selected > operation.index ? selected - 1 : Math.min(selected, rule.actions.length - 2);
      else if (selected === operation.from) next = operation.to;
      else if (operation.from < selected && operation.to >= selected) next--;
      else if (operation.from > selected && operation.to <= selected) next++;
      next = Math.max(0, next);
      setActionIndex(next);
      setPages((old) => ({ ...old, [actionsPath]: Math.floor(next / 10) }));
      setFocus(`edit:${next}`);
    } else {
      const values = valueAt(draft.configuration, where);
      if (Array.isArray(values)) {
        const next =
          operation.kind === 'add'
            ? values.length
            : operation.kind === 'move'
              ? operation.to
              : operation.kind === 'duplicate'
                ? operation.index + 1
                : Math.min(operation.index, values.length - 2);
        setPages((old) => ({ ...old, [where]: Math.max(0, Math.floor(next / 10)) }));
        setFocus(next >= 0 ? `${where}/${next}` : undefined);
      }
    }
    list(where, operation);
  }
  return (
    <RuleEditorContext
      value={{
        draft,
        protocol,
        rule,
        path,
        context,
        allowed,
        pages,
        setPage: (path, page) => setPages((old) => ({ ...old, [path]: page })),
        edit,
        json,
        list: changeList,
        diagnostics,
        jsonPath,
        showJson,
      }}
    >
      <section
        ref={container}
        className='stack-rule-form'
        aria-label='선택 규칙 폼'
        data-rule-form-path={path}
      >
        <h4>규칙 폼 · {rule.id.slice(0, 80)}</h4>
        <p>
          {context.native ? '네이티브 스택 규칙' : '기존 응용 정의'} · 현재 이벤트의 값과 선언한
          ID를 사용합니다. 동작은 위에서 아래 순서로 실행됩니다.
        </p>
        <p>
          유형 변경은 선택한 부분을 교체합니다. 없는 참조와 다른 타입은 정의 진단에서 확인하세요.
        </p>
        {blocked && blocked !== path && (
          <>
            <p>상위 JSON이 미완성입니다. 해당 텍스트를 먼저 수정하세요.</p>
            <RuleJson path={blocked} label='상위 미완성 JSON 수정' />
          </>
        )}
        <RuleBoundary path={path}>
          <EventForm />
          <fieldset className='rule-list-item'>
            <legend>실행 조건</legend>
            {rule.condition ? (
              <>
                <button type='button' onClick={() => edit(`${path}/condition`, undefined)}>
                  조건 제거
                </button>
                <StackRuleCondition path={`${path}/condition`} />
              </>
            ) : (
              <button
                type='button'
                onClick={() =>
                  edit(`${path}/condition`, ruleCondition('compare') as unknown as JsonValue)
                }
              >
                비교 조건 추가
              </button>
            )}
          </fieldset>
          <fieldset className='rule-list-item'>
            <legend>순서대로 실행할 동작</legend>
            <RuleBoundary path={actionsPath}>
              <RuleListPager path={actionsPath} total={rule.actions.length} />
              <ol className='rule-actions'>
                {rule.actions.slice(page * 10, page * 10 + 10).map((action, offset) => {
                  const index = page * 10 + offset;
                  return (
                    <li key={`${actionsPath}/${index}`} data-rule-action={index}>
                      <span>
                        {index + 1}. {action.kind} ·{' '}
                        {String(
                          stackObject(action).variableId ??
                            stackObject(action).messageId ??
                            stackObject(action).timerId ??
                            '',
                        ).slice(0, 60)}
                      </span>
                      <div className='stack-inline'>
                        <button
                          type='button'
                          data-rule-focus={`edit:${index}`}
                          aria-pressed={selected === index}
                          onClick={() => setActionIndex(index)}
                        >
                          동작 편집 · {index + 1}
                        </button>
                        <button
                          type='button'
                          disabled={index === 0}
                          onClick={() =>
                            changeList(actionsPath, { kind: 'move', from: index, to: index - 1 })
                          }
                        >
                          동작 위로 · {index + 1}
                        </button>
                        <button
                          type='button'
                          disabled={index + 1 === rule.actions.length}
                          onClick={() =>
                            changeList(actionsPath, { kind: 'move', from: index, to: index + 1 })
                          }
                        >
                          동작 아래로 · {index + 1}
                        </button>
                        <button
                          type='button'
                          onClick={() => changeList(actionsPath, { kind: 'duplicate', index })}
                        >
                          동작 복제 · {index + 1}
                        </button>
                        <button
                          type='button'
                          onClick={() => changeList(actionsPath, { kind: 'remove', index })}
                        >
                          동작 삭제 · {index + 1}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ol>
              <RuleChoice
                path={`${actionsPath}/$add`}
                label='추가할 동작 종류'
                value={addKind}
                options={actionChoices(context.native)}
                change={(value) => setAddKind(value as StackAction['kind'])}
              />
              <button
                type='button'
                onClick={() =>
                  changeList(actionsPath, {
                    kind: 'add',
                    value: ruleAction(addKind, protocol, context) as unknown as JsonValue,
                  })
                }
              >
                선택 동작 추가
              </button>
              {rule.actions[selected] && (
                <ActionForm
                  key={`${actionsPath}/${selected}`}
                  path={`${actionsPath}/${selected}`}
                  action={rule.actions[selected]}
                />
              )}
            </RuleBoundary>
          </fieldset>
        </RuleBoundary>
      </section>
    </RuleEditorContext>
  );
}
const actionNames: Record<StackAction['kind'], string> = {
  send: '메시지 송신',
  deliver: '응용 메시지 전달',
  assign: '변수 대입',
  'start-timer': '타이머 시작',
  'cancel-timer': '타이머 취소',
  finish: '인스턴스 완료',
  'service-indicate': '상위 서비스 통지',
};
function actionChoices(native: boolean) {
  return Object.entries(actionNames)
    .filter(([kind]) => native || kind !== 'service-indicate')
    .map(([value, label]) => ({ value, label }));
}
function EventForm() {
  const editor = useRuleEditor();
  const { path, rule, protocol, context } = editor;
  const event = rule.event;
  const names: Record<StackRuleEvent['kind'], string> = {
    input: '시나리오 입력',
    receive: '메시지 수신',
    timer: '타이머 만료',
    connection: '하위 연결 통지',
    'service-request': '상위의 서비스 요청',
    'service-indication': '하위의 서비스 통지',
  };
  const kinds = Object.entries(names).filter(
    ([kind]) => context.native || !kind.startsWith('service-'),
  );
  const service = event.kind === 'service-request' || event.kind === 'service-indication';
  const port =
    event.kind === 'service-request' && protocol.mode === 'stack-protocol'
      ? protocol.provides
      : protocol.requires;
  return (
    <fieldset className='rule-list-item'>
      <legend>규칙을 시작하는 이벤트</legend>
      <RuleBoundary path={`${path}/event`}>
        <RuleChoice
          path={`${path}/event/kind`}
          label='이벤트 종류'
          value={event.kind}
          options={kinds.map(([value, label]) => ({ value, label }))}
          change={(value) =>
            editor.edit(
              `${path}/event`,
              ruleEvent(value as StackRuleEvent['kind'], protocol) as unknown as JsonValue,
            )
          }
        />
        {event.kind === 'input' || event.kind === 'receive' ? (
          <RuleReference
            path={`${path}/event/messageId`}
            label='이벤트 메시지'
            options={context.body.messages}
          />
        ) : event.kind === 'timer' ? (
          <RuleReference
            path={`${path}/event/timerId`}
            label='만료할 타이머'
            options={context.body.timers}
          />
        ) : event.kind === 'connection' ? (
          <RuleChoice
            path={`${path}/event/state`}
            label='연결 통지 종류'
            value={event.state}
            options={protocol.requires.lifecycle.notifications.map((value) => ({
              value,
              label: value,
            }))}
            change={(value) => editor.edit(`${path}/event/state`, value)}
          />
        ) : null}
        {service && (
          <>
            <RuleReference
              path={`${path}/event/portId`}
              label='이벤트 포트'
              options={port ? [port] : []}
            />
            <RuleChoice
              path={`${path}/event/operation`}
              label='서비스 이벤트 동작'
              value={event.operation}
              options={(event.kind === 'service-request'
                ? [port?.request ?? 'write']
                : [port?.indication ?? 'read', ...(port?.lifecycle.notifications ?? [])]
              ).map((value) => ({ value, label: value }))}
              change={(value) => editor.edit(`${path}/event/operation`, value)}
            />
          </>
        )}
      </RuleBoundary>
    </fieldset>
  );
}
function ActionForm({ path, action }: { path: string; action: StackAction }) {
  const editor = useRuleEditor();
  const { context, protocol } = editor;
  return (
    <fieldset className='rule-action-detail' aria-label='선택 동작 폼'>
      <legend>선택 동작</legend>
      <RuleBoundary path={path}>
        <RuleChoice
          path={`${path}/kind`}
          label='동작 종류'
          value={action.kind}
          options={actionChoices(context.native)}
          change={(kind) =>
            editor.edit(
              path,
              ruleAction(
                kind as StackAction['kind'],
                protocol,
                context,
                action,
              ) as unknown as JsonValue,
            )
          }
        />
        {action.kind === 'send' || action.kind === 'deliver' ? (
          <MessageAction path={path} action={action} />
        ) : action.kind === 'assign' ? (
          <>
            <RuleReference
              path={`${path}/variableId`}
              label='대입할 변수'
              options={context.variables}
            />
            <StackRuleExpression
              path={`${path}/value`}
              label='대입할 값'
              expected={
                context.variables.find((v) => v.id === action.variableId)?.type ?? 'integer'
              }
            />
          </>
        ) : action.kind === 'start-timer' || action.kind === 'cancel-timer' ? (
          <>
            <RuleReference
              path={`${path}/timerId`}
              label='동작 타이머'
              options={context.body.timers}
            />
            {action.kind === 'start-timer' && (
              <StackRuleExpression path={`${path}/durationMs`} label='지속 시간 (ms)' />
            )}
          </>
        ) : action.kind === 'finish' ? (
          <RuleChoice
            path={`${path}/outcome`}
            label='완료 결과'
            value={action.outcome}
            options={[
              { value: 'success', label: '성공' },
              { value: 'failure', label: '실패' },
            ]}
            change={(value) => editor.edit(`${path}/outcome`, value)}
          />
        ) : action.kind === 'service-indicate' ? (
          <ServiceAction path={path} action={action} />
        ) : (
          <RuleJson path={path} label='동작 JSON' />
        )}
      </RuleBoundary>
    </fieldset>
  );
}
function MessageAction({
  path,
  action,
}: {
  path: string;
  action: Extract<StackAction, { kind: 'send' | 'deliver' }>;
}) {
  const editor = useRuleEditor();
  const [fieldId, setFieldId] = useState('');
  const message = editor.context.body.messages.find((m) => m.id === action.messageId);
  const values = stackObject(action.values);
  const keys = Object.keys(values);
  const where = `${path}/values`;
  const page = Math.max(
    0,
    Math.min(editor.pages[where] ?? 0, Math.max(0, Math.ceil(keys.length / 10) - 1)),
  );
  const available = (message?.fields ?? []).filter((f) => !Object.hasOwn(values, f.id));
  const selected = available.find((f) => f.id === fieldId) ?? available[0];
  return (
    <>
      <RuleReference
        path={`${path}/messageId`}
        label='동작 메시지'
        options={editor.context.body.messages}
      />
      <p>
        메시지를 바꾸어도 기존 필드 표현식은 유지합니다. 없는 필드는 삭제하거나 새 선언에 맞춰
        수정하세요.
      </p>
      <RuleBoundary path={where}>
        <RuleListPager path={where} total={keys.length} />
        {keys.slice(page * 10, page * 10 + 10).map((id) => {
          const field = message?.fields.find((f) => f.id === id);
          const at = `${where}/${pointerToken(id)}`;
          return (
            <fieldset className='rule-list-item' key={id}>
              <legend>
                필드 {id.slice(0, 60)} · {field?.type ?? '선언 없음'}
              </legend>
              <button type='button' onClick={() => editor.edit(at, undefined)}>
                필드 값 제거 · {id.slice(0, 60)}
              </button>
              <StackRuleExpression
                path={at}
                label={`필드 ${id.slice(0, 40)} 값`}
                expected={field?.type === 'enum' ? 'string' : (field?.type ?? 'integer')}
              />
            </fieldset>
          );
        })}
        <RuleChoice
          path={`${where}/$add`}
          label='값을 추가할 필드'
          value={selected?.id ?? ''}
          options={available.map((f) => ({ value: f.id, label: `${f.id} (${f.type})` }))}
          change={setFieldId}
        />
        <button
          type='button'
          disabled={!selected}
          onClick={() => {
            if (selected)
              editor.edit(`${where}/${pointerToken(selected.id)}`, {
                kind: 'literal',
                value:
                  selected.defaultValue ??
                  (selected.type === 'enum'
                    ? (selected.options[0] ?? '')
                    : ruleLiteral(selected.type)),
              });
          }}
        >
          필드 값 추가
        </button>
      </RuleBoundary>
    </>
  );
}
function ServiceAction({
  path,
  action,
}: {
  path: string;
  action: Extract<StackAction, { kind: 'service-indicate' }>;
}) {
  const editor = useRuleEditor();
  const protocol = editor.protocol;
  const port = protocol.mode === 'stack-protocol' ? protocol.provides : undefined;
  const operations = [port?.indication ?? 'read', ...(port?.lifecycle.notifications ?? [])];
  return (
    <>
      <RuleReference
        path={`${path}/portId`}
        label='통지할 상위 포트'
        options={port ? [port] : []}
      />
      <RuleChoice
        path={`${path}/operation`}
        label='상위 통지 동작'
        value={action.operation}
        options={operations.map((value) => ({ value, label: value }))}
        change={(operation) => {
          editor.edit(
            path,
            operation === 'failed' || operation === 'closed'
              ? { kind: 'service-indicate', portId: action.portId, operation }
              : {
                  kind: 'service-indicate',
                  portId: action.portId,
                  operation,
                  payload:
                    'payload' in action
                      ? (action.payload as unknown as JsonValue)
                      : {
                          kind: 'literal',
                          value: ruleLiteral(port?.service.payload === 'bytes' ? 'bytes' : 'json'),
                        },
                },
          );
        }}
      />
      <p>실패·종료 통지는 payload 없이 전달합니다.</p>
      {'payload' in action && (
        <StackRuleExpression
          path={`${path}/payload`}
          label='상위로 전달할 payload'
          expected={port?.service.payload === 'bytes' ? 'bytes' : 'json'}
        />
      )}
    </>
  );
}
