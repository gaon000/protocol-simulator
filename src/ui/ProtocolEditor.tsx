/** biome-ignore-all lint/suspicious/noArrayIndexKey: Form rows are stateless and controlled by JSON Pointer; structural edits clear pending values for the affected collection. */
import { nextId } from '../application/edit-experiment.ts';
import type { FieldDefinition, ProtocolDefinition } from '../domain/protocol-model.ts';
import { Control, Group, JsonControl, Remove, useEditor } from './forms.tsx';
import { RuleEditor } from './RuleEditor.tsx';

function FieldEditor({ field, path }: { field: FieldDefinition; path: string }) {
  const { edit } = useEditor();
  return (
    <Group path={path} title={`필드 · ${field.id}`}>
      <div className='form-grid'>
        <Control path={`${path}/id`} label='필드 ID' />
        <Control path={`${path}/name`} label='전송 필드명' />
        <label className='control'>
          <span>필드 타입</span>
          <select
            data-path={`${path}/type`}
            value={field.type}
            onChange={(event) => {
              const base = {
                id: field.id,
                name: field.name,
                required: field.required,
                placement: field.placement,
              };
              const type = event.target.value;
              edit(
                path,
                type === 'enum' ? { ...base, type, options: ['value'] } : { ...base, type },
              );
            }}
          >
            {['string', 'integer', 'boolean', 'enum'].map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
        </label>
        <Control
          path={`${path}/placement`}
          label='필드 위치'
          options={['header', 'body', 'payload']}
        />
        <Control path={`${path}/required`} label='필수 필드' type='checkbox' />
        {field.type === 'integer' && (
          <>
            <Control path={`${path}/min`} label='최솟값' type='number' optional />
            <Control path={`${path}/max`} label='최댓값' type='number' optional />
          </>
        )}
        {field.type === 'string' && (
          <>
            <Control path={`${path}/minLength`} label='최소 글자 수' type='number' optional />
            <Control path={`${path}/maxLength`} label='최대 글자 수' type='number' optional />
          </>
        )}
        {field.type === 'enum' && (
          <label className='control'>
            <span>허용 값 (쉼표 구분)</span>
            <input
              data-path={`${path}/options`}
              value={field.options.join(',')}
              onChange={(event) =>
                edit(
                  `${path}/options`,
                  event.target.value.split(',').map((text) => text.trim()),
                )
              }
            />
          </label>
        )}
      </div>
      <label className='check-control'>
        <span>기본값 사용</span>
        <input
          type='checkbox'
          checked={field.defaultValue !== undefined}
          onChange={(event) =>
            edit(
              `${path}/defaultValue`,
              !event.target.checked
                ? undefined
                : field.type === 'integer'
                  ? 0
                  : field.type === 'boolean'
                    ? false
                    : field.type === 'enum'
                      ? (field.options[0] ?? '')
                      : '',
            )
          }
        />
      </label>
      {field.defaultValue !== undefined && (
        <Control
          path={`${path}/defaultValue`}
          label='기본값'
          type={
            field.type === 'integer' ? 'number' : field.type === 'boolean' ? 'checkbox' : 'text'
          }
          {...(field.type === 'enum' ? { options: field.options } : {})}
        />
      )}
      <Remove path={path} label='필드 삭제' />
    </Group>
  );
}

/** Author message schemas, independent participant states and executable rules in the draft. */
export function ProtocolEditor({
  protocol,
  index,
}: {
  protocol: ProtocolDefinition;
  index: number;
}) {
  const { edit } = useEditor();
  const path = `/definitions/${index}`;
  return (
    <div data-path={path} tabIndex={-1}>
      <nav className='object-navigation' aria-label='프로토콜 구성 요소'>
        {(
          [
            ['messages', '메시지'],
            ['states', '상태'],
            ['variables', '변수'],
            ['timers', '타이머'],
            ['rules', '규칙'],
          ] as const
        ).map(([id, label]) => (
          <a key={id} href={`#editor-${encodeURIComponent(`${path}/${id}`)}`}>
            {label}
          </a>
        ))}
      </nav>
      <div className='form-grid'>
        <Control path={`${path}/label`} label='프로토콜 이름' />
        <Control path={`${path}/id`} label='프로토콜 ID' />
      </div>
      <p className='hint'>
        정의 버전 {protocol.revision} · {protocol.codec}. ID를 변경하거나 삭제하면 남은 참조를
        검사합니다.
      </p>
      <Group path={`${path}/messages`} title='메시지'>
        {protocol.messages.map((message, messageIndex) => {
          const messagePath = `${path}/messages/${messageIndex}`;
          return (
            <Group key={messageIndex} path={messagePath} title={`메시지 · ${message.label}`}>
              <div className='form-grid'>
                <Control path={`${messagePath}/id`} label='메시지 ID' />
                <Control path={`${messagePath}/label`} label='메시지 이름' />
              </div>
              <Group path={`${messagePath}/fields`} title='메시지 필드'>
                {message.fields.map((field, fieldIndex) => (
                  <FieldEditor
                    key={fieldIndex}
                    field={field}
                    path={`${messagePath}/fields/${fieldIndex}`}
                  />
                ))}
                <button
                  type='button'
                  onClick={() => {
                    const id = nextId(message.fields, 'field');
                    edit(`${messagePath}/fields`, [
                      ...message.fields,
                      { id, name: id, type: 'string', required: false, placement: 'body' },
                    ]);
                  }}
                >
                  필드 추가
                </button>
              </Group>
              <Remove path={messagePath} label='메시지 삭제' />
            </Group>
          );
        })}
        <button
          type='button'
          onClick={() => {
            const id = nextId(protocol.messages, 'message');
            edit(`${path}/messages`, [
              ...protocol.messages,
              { id, label: '새 메시지', fields: [] },
            ]);
          }}
        >
          메시지 추가
        </button>
      </Group>
      <Group path={`${path}/states`} title='상태'>
        <Control
          path={`${path}/initialStateId`}
          label='초기 상태'
          options={protocol.states.map((state) => state.id)}
        />
        {protocol.states.map((state, stateIndex) => (
          <Group
            key={stateIndex}
            path={`${path}/states/${stateIndex}`}
            title={`상태 · ${state.id}`}
          >
            <div className='form-grid'>
              <Control path={`${path}/states/${stateIndex}/id`} label='상태 ID' />
              <Control path={`${path}/states/${stateIndex}/label`} label='상태 이름' />
              <Control
                path={`${path}/states/${stateIndex}/terminal`}
                label='종료 상태'
                type='checkbox'
              />
            </div>
            <Remove path={`${path}/states/${stateIndex}`} label='상태 삭제' />
          </Group>
        ))}
        <button
          type='button'
          onClick={() => {
            const id = nextId(protocol.states, 'state');
            edit(`${path}/states`, [...protocol.states, { id, label: '새 상태' }]);
          }}
        >
          상태 추가
        </button>
      </Group>
      <Group path={`${path}/variables`} title='변수'>
        {protocol.variables.map((variable, variableIndex) => (
          <Group
            key={variableIndex}
            path={`${path}/variables/${variableIndex}`}
            title={`변수 · ${variable.id}`}
          >
            <div className='form-grid'>
              <Control path={`${path}/variables/${variableIndex}/id`} label='변수 ID' />
              <Control
                path={`${path}/variables/${variableIndex}/type`}
                label='변수 타입'
                options={['integer', 'string', 'boolean', 'json']}
              />
              <JsonControl path={`${path}/variables/${variableIndex}/initial`} label='초깃값' />
            </div>
            <Remove path={`${path}/variables/${variableIndex}`} label='변수 삭제' />
          </Group>
        ))}
        <button
          type='button'
          onClick={() =>
            edit(`${path}/variables`, [
              ...protocol.variables,
              { id: nextId(protocol.variables, 'variable'), type: 'integer', initial: 0 },
            ])
          }
        >
          변수 추가
        </button>
      </Group>
      <Group path={`${path}/timers`} title='타이머'>
        {protocol.timers.map((timer, timerIndex) => (
          <div key={timerIndex} className='inline-row'>
            <Control path={`${path}/timers/${timerIndex}/id`} label={`타이머 ID · ${timer.id}`} />
            <Remove path={`${path}/timers/${timerIndex}`} label='타이머 삭제' />
          </div>
        ))}
        <button
          type='button'
          onClick={() =>
            edit(`${path}/timers`, [...protocol.timers, { id: nextId(protocol.timers, 'timer') }])
          }
        >
          타이머 추가
        </button>
      </Group>
      <Group path={`${path}/rules`} title='규칙'>
        {protocol.rules.map((rule, ruleIndex) => (
          <RuleEditor
            key={ruleIndex}
            path={`${path}/rules/${ruleIndex}`}
            rule={rule}
            protocol={protocol}
          />
        ))}
        <button
          type='button'
          onClick={() =>
            edit(`${path}/rules`, [
              ...protocol.rules,
              {
                id: nextId(protocol.rules, 'rule'),
                fromStateId: protocol.initialStateId,
                nextStateId: protocol.initialStateId,
                event: { kind: 'input', messageId: protocol.messages[0]?.id ?? '' },
                actions: [],
                ignore: true,
              },
            ])
          }
        >
          규칙 추가
        </button>
      </Group>
    </div>
  );
}
