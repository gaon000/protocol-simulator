/** biome-ignore-all lint/suspicious/noArrayIndexKey: Form rows are stateless and controlled by JSON Pointer; structural edits clear pending values for the affected collection. */
import { nextId, pointerToken } from '../application/edit-experiment.ts';
import type { Expectation, ProtocolDefinition, ProtocolMessage } from '../domain/protocol-model.ts';
import { Control, Group, Remove, useEditor } from './forms.tsx';

/** Set a typed scenario message, including explicit omission so schema defaults stay observable. */
export function MessageEditor({
  path,
  message,
  protocol,
}: {
  path: string;
  message: ProtocolMessage;
  protocol: ProtocolDefinition | undefined;
}) {
  const { edit } = useEditor();
  const definition = protocol?.messages.find((item) => item.id === message.messageId);
  return (
    <Group path={path} title='메시지 값'>
      <label className='control'>
        <span>메시지 선택</span>
        <select
          data-path={`${path}/messageId`}
          value={message.messageId}
          onChange={(event) => edit(path, { messageId: event.target.value, values: {} })}
        >
          <option value=''>선택</option>
          {protocol?.messages.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label} ({item.id})
            </option>
          ))}
        </select>
      </label>
      {definition?.fields.map((field) => {
        const fieldPath = `${path}/values/${pointerToken(field.id)}`;
        const present = Object.hasOwn(message.values, field.id);
        return (
          <div className='value-row' key={field.id}>
            <label className='check-control'>
              <span>
                {field.name} 값 포함{field.required ? ' · 필수' : ''}
              </span>
              <input
                type='checkbox'
                checked={present}
                onChange={(event) =>
                  edit(
                    fieldPath,
                    event.target.checked
                      ? (field.defaultValue ??
                          (field.type === 'integer'
                            ? 0
                            : field.type === 'boolean'
                              ? false
                              : field.type === 'enum'
                                ? (field.options[0] ?? '')
                                : ''))
                      : undefined,
                  )
                }
              />
            </label>
            {present ? (
              <Control
                path={fieldPath}
                label={`${field.name} 값`}
                type={
                  field.type === 'integer'
                    ? 'number'
                    : field.type === 'boolean'
                      ? 'checkbox'
                      : 'text'
                }
                {...(field.type === 'enum' ? { options: field.options } : {})}
              />
            ) : (
              <small>생략 시 기본값: {JSON.stringify(field.defaultValue) ?? '없음'}</small>
            )}
          </div>
        );
      })}
      {Object.keys(message.values)
        .filter((id) => !definition?.fields.some((field) => field.id === id))
        .map((id) => (
          <div key={id} className='value-row'>
            <p>정의에 없는 값: {id}</p>
            <Remove path={`${path}/values/${pointerToken(id)}`} label={`남은 값 ${id} 삭제`} />
          </div>
        ))}
    </Group>
  );
}

/** Edit timed inputs and all four expectation policies used by the real engine. */
export function ScenarioEditor() {
  const { draft, edit } = useEditor();
  const scenario = draft.scenario;
  const protocolFor = (participant: 'A' | 'B') =>
    draft.definitions.find((item) => item.id === draft.protocols[participant].id);
  return (
    <>
      <Control path='/scenario/observationMs' label='전체 관찰 기간 ms' type='number' />
      <Group path='/scenario/inputs' title='최초 입력'>
        {scenario.inputs.map((input, index) => {
          const path = `/scenario/inputs/${index}`;
          return (
            <Group key={index} path={path} title={`입력 · ${input.id}`}>
              <div className='form-grid'>
                <Control path={`${path}/id`} label='입력 ID' />
                <Control path={`${path}/participant`} label='입력 참여자' options={['A', 'B']} />
                <Control path={`${path}/timeMs`} label='입력 시각 ms' type='number' />
              </div>
              <MessageEditor
                path={`${path}/message`}
                message={input.message}
                protocol={protocolFor(input.participant)}
              />
              <Remove path={path} label='입력 삭제' />
            </Group>
          );
        })}
        <button
          type='button'
          onClick={() =>
            edit('/scenario/inputs', [
              ...scenario.inputs,
              {
                id: nextId(scenario.inputs, 'input'),
                timeMs: 0,
                participant: 'A',
                message: { messageId: protocolFor('A')?.messages[0]?.id ?? '', values: {} },
              },
            ])
          }
        >
          입력 추가
        </button>
      </Group>
      <Group path='/scenario/expectations' title='기대 조건'>
        <p className='hint'>
          관찰 종료와 성공 판정은 별개입니다. 실패 상태를 기대하는 검사도 만들 수 있습니다.
        </p>
        {scenario.expectations.map((expectation, index) => {
          const path = `/scenario/expectations/${index}`;
          const protocol = protocolFor(expectation.participant);
          return (
            <Group key={index} path={path} title={`기대 조건 · ${expectation.id}`}>
              <div className='form-grid'>
                <Control path={`${path}/id`} label='기대 조건 ID' />
                <Control path={`${path}/participant`} label='검사 참여자' options={['A', 'B']} />
                <label className='control'>
                  <span>검사 종류</span>
                  <select
                    data-path={`${path}/kind`}
                    value={expectation.kind}
                    onChange={(event) => {
                      const base = { id: expectation.id, participant: expectation.participant };
                      const kind = event.target.value;
                      const next: Expectation =
                        kind === 'state'
                          ? { ...base, kind, stateId: protocol?.initialStateId ?? '' }
                          : kind === 'delivery-count'
                            ? {
                                ...base,
                                kind,
                                messageId: protocol?.messages[0]?.id ?? '',
                                count: 1,
                              }
                            : kind === 'delivered-values'
                              ? {
                                  ...base,
                                  kind,
                                  message: {
                                    messageId: protocol?.messages[0]?.id ?? '',
                                    values: {},
                                  },
                                }
                              : { ...base, kind: 'completion-before', timeMs: 500 };
                      edit(path, next);
                    }}
                  >
                    <option value='state'>최종 상태</option>
                    <option value='delivery-count'>상위 전달 횟수</option>
                    <option value='delivered-values'>상위 전달 내용</option>
                    <option value='completion-before'>완료 기한</option>
                  </select>
                </label>
                {expectation.kind === 'state' && (
                  <Control
                    path={`${path}/stateId`}
                    label='기대 상태'
                    options={protocol?.states.map((item) => item.id) ?? []}
                  />
                )}
                {expectation.kind === 'delivery-count' && (
                  <>
                    <Control
                      path={`${path}/messageId`}
                      label='검사 메시지'
                      options={protocol?.messages.map((item) => item.id) ?? []}
                    />
                    <Control path={`${path}/count`} label='기대 횟수' type='number' />
                  </>
                )}
                {expectation.kind === 'completion-before' && (
                  <Control path={`${path}/timeMs`} label='완료 기한 ms' type='number' />
                )}
              </div>
              {expectation.kind === 'delivered-values' && (
                <MessageEditor
                  path={`${path}/message`}
                  message={expectation.message}
                  protocol={protocol}
                />
              )}
              <Remove path={path} label='기대 조건 삭제' />
            </Group>
          );
        })}
        <button
          type='button'
          onClick={() =>
            edit('/scenario/expectations', [
              ...scenario.expectations,
              {
                id: nextId(scenario.expectations, 'expect'),
                participant: 'A',
                kind: 'state',
                stateId: protocolFor('A')?.initialStateId ?? '',
              },
            ])
          }
        >
          기대 조건 추가
        </button>
      </Group>
    </>
  );
}
