/** biome-ignore-all lint/suspicious/noArrayIndexKey: Form rows are stateless and controlled by JSON Pointer; structural edits clear pending values for the affected collection. */
import { pointerToken } from '../application/edit-experiment.ts';
import type {
  Action,
  Condition,
  ProtocolDefinition,
  RuleDefinition,
  ValueExpression,
} from '../domain/protocol-model.ts';
import { Control, Group, JsonControl, Remove, useEditor } from './forms.tsx';

const literal: ValueExpression = { kind: 'literal', value: 1 };
const comparison: Condition = { kind: 'compare', operator: 'eq', left: literal, right: literal };

/** Edit a declarative expression tree without evaluating arbitrary code. */
export function ExpressionEditor({
  path,
  value,
  protocol,
  fields,
  label,
}: {
  path: string;
  value: ValueExpression;
  protocol: ProtocolDefinition;
  fields: readonly string[];
  label: string;
}) {
  const { edit } = useEditor();
  return (
    <Group path={path} title={label}>
      <label className='control'>
        <span>식 종류</span>
        <select
          data-path={`${path}/kind`}
          value={value.kind}
          onChange={(event) => {
            const kind = event.target.value;
            edit(
              path,
              kind === 'variable'
                ? { kind, variableId: protocol.variables[0]?.id ?? '' }
                : kind === 'field'
                  ? { kind, fieldId: fields[0] ?? '' }
                  : kind === 'add' || kind === 'subtract'
                    ? { kind, left: literal, right: literal }
                    : literal,
            );
          }}
        >
          <option value='literal'>고정 값</option>
          <option value='field'>이벤트 필드</option>
          <option value='variable'>변수</option>
          <option value='add'>더하기</option>
          <option value='subtract'>빼기</option>
        </select>
      </label>
      {value.kind === 'literal' && <JsonControl path={`${path}/value`} label='고정 값' />}
      {value.kind === 'field' && (
        <Control path={`${path}/fieldId`} label='이벤트 필드' options={fields} />
      )}
      {value.kind === 'variable' && (
        <Control
          path={`${path}/variableId`}
          label='변수 참조'
          options={protocol.variables.map((item) => item.id)}
        />
      )}
      {(value.kind === 'add' || value.kind === 'subtract') && (
        <div className='form-grid'>
          <ExpressionEditor
            path={`${path}/left`}
            value={value.left}
            protocol={protocol}
            fields={fields}
            label='왼쪽 값'
          />
          <ExpressionEditor
            path={`${path}/right`}
            value={value.right}
            protocol={protocol}
            fields={fields}
            label='오른쪽 값'
          />
        </div>
      )}
    </Group>
  );
}

/** Edit comparison, conjunction, disjunction and negation with nested native forms. */
export function ConditionEditor({
  path,
  value,
  protocol,
  fields,
}: {
  path: string;
  value: Condition;
  protocol: ProtocolDefinition;
  fields: readonly string[];
}) {
  const { edit } = useEditor();
  return (
    <Group path={path} title='응답 조건'>
      <label className='control'>
        <span>조건 종류</span>
        <select
          data-path={`${path}/kind`}
          value={value.kind}
          onChange={(event) => {
            const kind = event.target.value;
            edit(
              path,
              kind === 'all' || kind === 'any'
                ? { kind, conditions: [comparison] }
                : kind === 'not'
                  ? { kind, condition: comparison }
                  : comparison,
            );
          }}
        >
          <option value='compare'>값 비교</option>
          <option value='all'>모두 만족</option>
          <option value='any'>하나 이상 만족</option>
          <option value='not'>반대</option>
        </select>
      </label>
      {value.kind === 'compare' && (
        <>
          <Control
            path={`${path}/operator`}
            label='비교 연산'
            options={['eq', 'ne', 'lt', 'lte', 'gt', 'gte']}
          />
          <div className='form-grid'>
            <ExpressionEditor
              path={`${path}/left`}
              value={value.left}
              protocol={protocol}
              fields={fields}
              label='왼쪽 값'
            />
            <ExpressionEditor
              path={`${path}/right`}
              value={value.right}
              protocol={protocol}
              fields={fields}
              label='오른쪽 값'
            />
          </div>
        </>
      )}
      {value.kind === 'not' && (
        <ConditionEditor
          path={`${path}/condition`}
          value={value.condition}
          protocol={protocol}
          fields={fields}
        />
      )}
      {(value.kind === 'all' || value.kind === 'any') && (
        <>
          {value.conditions.map((condition, index) => (
            <div key={`${path}/${index}`}>
              <ConditionEditor
                path={`${path}/conditions/${index}`}
                value={condition}
                protocol={protocol}
                fields={fields}
              />
              <Remove path={`${path}/conditions/${index}`} label='하위 조건 삭제' />
            </div>
          ))}
          <button
            type='button'
            onClick={() => edit(`${path}/conditions`, [...value.conditions, comparison])}
          >
            하위 조건 추가
          </button>
        </>
      )}
    </Group>
  );
}

function ActionEditor({
  path,
  action,
  protocol,
  fields,
}: {
  path: string;
  action: Action;
  protocol: ProtocolDefinition;
  fields: readonly string[];
}) {
  const { edit } = useEditor();
  const message =
    'messageId' in action
      ? protocol.messages.find((item) => item.id === action.messageId)
      : undefined;
  return (
    <Group path={path} title={`동작 · ${action.kind}`}>
      <label className='control'>
        <span>동작 종류</span>
        <select
          data-path={`${path}/kind`}
          value={action.kind}
          onChange={(event) => {
            const kind = event.target.value;
            const next: Action =
              kind === 'send' || kind === 'deliver'
                ? { kind, messageId: protocol.messages[0]?.id ?? '', values: {} }
                : kind === 'assign'
                  ? { kind, variableId: protocol.variables[0]?.id ?? '', value: literal }
                  : kind === 'start-timer'
                    ? {
                        kind,
                        timerId: protocol.timers[0]?.id ?? '',
                        durationMs: { kind: 'literal', value: 500 },
                      }
                    : kind === 'cancel-timer'
                      ? { kind, timerId: protocol.timers[0]?.id ?? '' }
                      : { kind: 'finish', outcome: 'success' };
            edit(path, next);
          }}
        >
          {['send', 'deliver', 'assign', 'start-timer', 'cancel-timer', 'finish'].map((kind) => (
            <option key={kind}>{kind}</option>
          ))}
        </select>
      </label>
      {'messageId' in action && (
        <>
          <label className='control'>
            <span>동작 메시지</span>
            <select
              data-path={`${path}/messageId`}
              value={action.messageId}
              onChange={(event) =>
                edit(path, { ...action, messageId: event.target.value, values: {} })
              }
            >
              <option value=''>선택</option>
              {protocol.messages.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label} ({item.id})
                </option>
              ))}
            </select>
          </label>
          {message?.fields.map((field) => (
            <div key={field.id} className='value-row'>
              <label className='check-control'>
                <span>{field.name} 값 지정</span>
                <input
                  type='checkbox'
                  checked={Object.hasOwn(action.values, field.id)}
                  onChange={(event) =>
                    edit(
                      `${path}/values/${pointerToken(field.id)}`,
                      event.target.checked ? literal : undefined,
                    )
                  }
                />
              </label>
              {action.values[field.id] && (
                <ExpressionEditor
                  path={`${path}/values/${pointerToken(field.id)}`}
                  value={action.values[field.id] as ValueExpression}
                  protocol={protocol}
                  fields={fields}
                  label={field.name}
                />
              )}
            </div>
          ))}
          {Object.keys(action.values)
            .filter((id) => !message?.fields.some((field) => field.id === id))
            .map((id) => (
              <div key={id} className='value-row'>
                <p>정의에 없는 동작 값: {id}</p>
                <Remove
                  path={`${path}/values/${pointerToken(id)}`}
                  label={`남은 동작 값 ${id} 삭제`}
                />
              </div>
            ))}
        </>
      )}
      {action.kind === 'assign' && (
        <>
          <Control
            path={`${path}/variableId`}
            label='대입할 변수'
            options={protocol.variables.map((item) => item.id)}
          />
          <ExpressionEditor
            path={`${path}/value`}
            value={action.value}
            protocol={protocol}
            fields={fields}
            label='대입 값'
          />
        </>
      )}
      {'timerId' in action && (
        <Control
          path={`${path}/timerId`}
          label='타이머 참조'
          options={protocol.timers.map((item) => item.id)}
        />
      )}
      {action.kind === 'start-timer' && (
        <ExpressionEditor
          path={`${path}/durationMs`}
          value={action.durationMs}
          protocol={protocol}
          fields={fields}
          label='대기 시간 ms'
        />
      )}
      {action.kind === 'finish' && (
        <Control path={`${path}/outcome`} label='종료 결과' options={['success', 'failure']} />
      )}
      <Remove path={path} label='동작 삭제' />
    </Group>
  );
}

/** Define the trigger, guard, ordered actions and state transition of one runtime rule. */
export function RuleEditor({
  path,
  rule,
  protocol,
}: {
  path: string;
  rule: RuleDefinition;
  protocol: ProtocolDefinition;
}) {
  const { edit } = useEditor();
  const messageId = 'messageId' in rule.event ? rule.event.messageId : undefined;
  const eventMessage = protocol.messages.find((item) => item.id === messageId);
  const fields = eventMessage?.fields.map((field) => field.id) ?? [];
  return (
    <Group path={path} title={`규칙 · ${rule.id}`}>
      <div className='form-grid'>
        <Control path={`${path}/id`} label='규칙 ID' />
        <Control
          path={`${path}/fromStateId`}
          label='시작 상태'
          options={protocol.states.map((item) => item.id)}
        />
        <Control
          path={`${path}/nextStateId`}
          label='다음 상태'
          options={protocol.states.map((item) => item.id)}
        />
        <label className='control'>
          <span>이벤트 종류</span>
          <select
            data-path={`${path}/event`}
            value={rule.event.kind}
            onChange={(event) => {
              const kind = event.target.value;
              edit(
                `${path}/event`,
                kind === 'input' || kind === 'receive'
                  ? { kind, messageId: protocol.messages[0]?.id ?? '' }
                  : kind === 'timer'
                    ? { kind, timerId: protocol.timers[0]?.id ?? '' }
                    : { kind: 'connection', state: 'closed' },
              );
            }}
          >
            <option value='input'>최초 입력</option>
            <option value='receive'>메시지 수신</option>
            <option value='timer'>타이머 만료</option>
            <option value='connection'>연결 종료</option>
          </select>
        </label>
        {'messageId' in rule.event && (
          <Control
            path={`${path}/event/messageId`}
            label='이벤트 메시지'
            options={protocol.messages.map((item) => item.id)}
          />
        )}
        {'timerId' in rule.event && (
          <Control
            path={`${path}/event/timerId`}
            label='이벤트 타이머'
            options={protocol.timers.map((item) => item.id)}
          />
        )}
        {'state' in rule.event && (
          <Control path={`${path}/event/state`} label='연결 상태' options={['closed', 'failed']} />
        )}
        <Control path={`${path}/ignore`} type='checkbox' label='명시적으로 무시' />
      </div>
      {rule.condition ? (
        <>
          <ConditionEditor
            path={`${path}/condition`}
            value={rule.condition}
            protocol={protocol}
            fields={fields}
          />
          <Remove path={`${path}/condition`} label='조건 삭제' />
        </>
      ) : (
        <button type='button' onClick={() => edit(`${path}/condition`, comparison)}>
          조건 추가
        </button>
      )}
      <Group path={`${path}/actions`} title='순서대로 실행할 동작'>
        <p className='hint'>
          send는 하위 전송, deliver는 상위 전달입니다. finish는 마지막에 둡니다.
        </p>
        {rule.actions.map((action, index) => (
          <ActionEditor
            key={`${path}/${index}`}
            path={`${path}/actions/${index}`}
            action={action}
            protocol={protocol}
            fields={fields}
          />
        ))}
        <button
          type='button'
          onClick={() =>
            edit(`${path}/actions`, [
              ...rule.actions,
              { kind: 'send', messageId: protocol.messages[0]?.id ?? '', values: {} },
            ])
          }
        >
          동작 추가
        </button>
      </Group>
      <Remove path={path} label='규칙 삭제' />
    </Group>
  );
}
