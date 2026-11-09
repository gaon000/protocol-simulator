import { useState } from 'react';
import type { ModelDiagnostic } from '../domain/protocol-model.ts';
import type { JsonValue } from '../domain/execution-contract.ts';
import type { StackExpectation } from '../domain/stack-model.ts';
import { stackObject, stackTarget } from '../domain/stack-record.ts';
import { valueAt } from '../domain/json-pointer.ts';
import { blockingStackRaw, type StackListEdit } from '../application/edit-stack-list.ts';
import {
  newStackScenarioRow,
  prepareStackExpectationKind,
  type ScenarioCollection,
  stackScenarioProtocol,
  stackScenarioTargets,
  uniqueScenarioDeclarations,
} from '../application/stack-scenario-authoring.ts';
import { ScenarioBoundary, ScenarioChoice, StackScenarioMessage } from './StackScenarioMessage.tsx';
import { StackJsonInput, StackValueInput, type StackInputProps } from './StackValueInput.tsx';

type Props = StackInputProps & {
  list: (path: string, operation: StackListEdit) => void;
  diagnostics: readonly ModelDiagnostic[];
  focusPath?: string;
};
type Selection = { collection: ScenarioCollection; index: number; id: string };
const title = (collection: ScenarioCollection) => (collection === 'inputs' ? '입력' : '기대 조건');
const kinds: readonly { value: StackExpectation['kind']; label: string }[] = [
  { value: 'state', label: '상태 도달' },
  { value: 'delivery-count', label: '메시지 전달 횟수' },
  { value: 'delivered-values', label: '전달된 메시지 값' },
  { value: 'completion-before', label: '성공 완료 기한' },
];

/** Page scenario rows and edit exactly one current selection through the canonical draft/raw/history boundary. */
export function StackScenarioForm(props: Props) {
  const { draft, edit, list, focusPath } = props;
  const scenario = draft.configuration.scenario;
  const match = /^\/scenario\/(inputs|expectations)\/(\d+)(?:\/|$)/.exec(focusPath ?? '');
  const initialCollection = match
    ? (match[1] as ScenarioCollection)
    : scenario.inputs.length
      ? 'inputs'
      : 'expectations';
  const initialIndex = Number(match?.[2] ?? 0);
  const initial = scenario[initialCollection][initialIndex];
  const [selection, setSelection] = useState<Selection | undefined>(
    initial ? { collection: initialCollection, index: initialIndex, id: initial.id } : undefined,
  );
  const [pages, setPages] = useState({
    inputs: initialCollection === 'inputs' ? Math.floor(initialIndex / 10) : 0,
    expectations: initialCollection === 'expectations' ? Math.floor(initialIndex / 10) : 0,
  });
  const [jsonPath, setJsonPath] = useState<string>();
  const selected =
    selection && scenario[selection.collection][selection.index]?.id === selection.id
      ? selection
      : undefined;
  const blocked = ['/scenario', '/scenario/inputs', '/scenario/expectations']
    .map((p) => blockingStackRaw(draft.raw, p))
    .find((p) => p !== undefined);
  function choose(collection: ScenarioCollection, index: number) {
    const row = scenario[collection][index];
    if (!row) return;
    setSelection({ collection, index, id: row.id });
    setPages({ ...pages, [collection]: Math.floor(index / 10) });
    setJsonPath(undefined);
  }
  function changeList(collection: ScenarioCollection, operation: StackListEdit) {
    const rows = scenario[collection];
    if (blockingStackRaw(draft.raw, `/scenario/${collection}`)) return;
    if (operation.kind === 'add') {
      const id = stackObject(operation.value).id;
      if (typeof id === 'string') setSelection({ collection, index: rows.length, id });
      setPages({ ...pages, [collection]: Math.floor(rows.length / 10) });
    } else if (selected?.collection === collection) {
      if (operation.kind === 'remove') {
        if (selected.index === operation.index) setSelection(undefined);
        else if (selected.index > operation.index)
          setSelection({ ...selected, index: selected.index - 1 });
      } else if (operation.kind === 'move') {
        const index =
          selected.index === operation.from
            ? operation.to
            : operation.from < selected.index && operation.to >= selected.index
              ? selected.index - 1
              : operation.from > selected.index && operation.to <= selected.index
                ? selected.index + 1
                : selected.index;
        setSelection({ ...selected, index });
        setPages({ ...pages, [collection]: Math.floor(index / 10) });
      }
    }
    setJsonPath(undefined);
    list(`/scenario/${collection}`, operation);
  }
  function write(path: string, value: JsonValue | undefined) {
    if (
      selected &&
      path === `/scenario/${selected.collection}/${selected.index}/id` &&
      typeof value === 'string'
    )
      setSelection({ ...selected, id: value });
    edit(path, value);
  }
  return (
    <section
      aria-label='스택 시나리오 폼'
      className='stack-scenario-form'
      id={`stack-group-${encodeURIComponent('/scenario')}`}
      tabIndex={-1}
    >
      <h3>입력·기대 조건 폼</h3>
      {blocked ? (
        <ScenarioBoundary {...props} path={blocked}>
          {null}
        </ScenarioBoundary>
      ) : (
        <>
          <StackValueInput
            {...props}
            path='/scenario/observationMs'
            native={false}
            type='integer'
            label='관찰 기간 ms'
          />
          <p>
            입력은 상위 응용에 전달합니다. 기대 조건은 실제 실행의 상태·상위 전달·성공 완료를
            검사합니다.
          </p>
          <div className='stack-scenario-layout'>
            <div className='stack-scenario-lists'>
              {(['inputs', 'expectations'] as const).map((collection) => {
                const rows = scenario[collection];
                const count = Math.max(1, Math.ceil(rows.length / 10));
                const page = Math.max(0, Math.min(pages[collection], count - 1));
                const label = title(collection);
                return (
                  <section
                    aria-label={`${label} 목록`}
                    key={collection}
                    id={`stack-group-${encodeURIComponent(`/scenario/${collection}`)}`}
                    tabIndex={-1}
                  >
                    <h4>
                      {label} · {rows.length}개
                    </h4>
                    <nav aria-label={`${label} 페이지`} className='stack-inline'>
                      <button
                        type='button'
                        disabled={page === 0}
                        onClick={() => setPages({ ...pages, [collection]: page - 1 })}
                      >
                        이전 {label} 10개
                      </button>
                      <span>
                        {page + 1}/{count}
                      </span>
                      <button
                        type='button'
                        disabled={page + 1 === count}
                        onClick={() => setPages({ ...pages, [collection]: page + 1 })}
                      >
                        다음 {label} 10개
                      </button>
                    </nav>
                    {rows.slice(page * 10, page * 10 + 10).map((row, offset) => {
                      const index = page * 10 + offset;
                      return (
                        <button
                          type='button'
                          key={`${index}:${row.id}`}
                          className='scenario-row'
                          aria-pressed={
                            selected?.collection === collection && selected.index === index
                          }
                          onClick={() => choose(collection, index)}
                        >
                          {label} 편집 · {index + 1} · {row.id.slice(0, 48)} ·{' '}
                          {stackTarget(row.target).slice(0, 64)}
                        </button>
                      );
                    })}
                    <div className='stack-inline'>
                      <button
                        type='button'
                        onClick={() =>
                          changeList(collection, {
                            kind: 'add',
                            value: newStackScenarioRow(draft, collection),
                          })
                        }
                      >
                        {collection === 'inputs' ? '입력 추가' : '기대 조건 추가'}
                      </button>
                      <button
                        type='button'
                        onClick={() =>
                          setJsonPath(
                            jsonPath === `/scenario/${collection}`
                              ? undefined
                              : `/scenario/${collection}`,
                          )
                        }
                      >
                        {label} 목록 JSON 편집
                      </button>
                    </div>
                  </section>
                );
              })}
            </div>
            <section aria-label='선택 시나리오 항목' className='stack-scenario-item'>
              {jsonPath ? (
                <>
                  <button type='button' onClick={() => setJsonPath(undefined)}>
                    선택 항목 폼으로 돌아가기
                  </button>
                  <StackJsonInput {...props} path={jsonPath} label='시나리오 목록 JSON' />
                </>
              ) : selected ? (
                <ScenarioItem
                  {...props}
                  edit={write}
                  key={`${selected.collection}:${selected.index}`}
                  selection={selected}
                  changeList={(operation) => changeList(selected.collection, operation)}
                />
              ) : (
                <p>편집할 입력이나 기대 조건을 선택하세요.</p>
              )}
            </section>
          </div>
        </>
      )}
    </section>
  );
}

function ScenarioItem(
  props: Props & { selection: Selection; changeList: (operation: StackListEdit) => void },
) {
  const { draft, selection, changeList, edit, diagnostics } = props;
  const { collection, index } = selection;
  const rows = draft.configuration.scenario[collection];
  const row = rows[index];
  const [json, setJson] = useState(false);
  if (!row) return null;
  const path = `/scenario/${collection}/${index}`;
  const expectation =
    collection === 'expectations' ? draft.configuration.scenario.expectations[index] : undefined;
  const kind = expectation?.kind;
  const target = row.target;
  const applicationOnly =
    collection === 'inputs' || kind === 'delivery-count' || kind === 'delivered-values';
  const source = stackScenarioProtocol(draft, target);
  const targets = stackScenarioTargets(draft, applicationOnly);
  const pending = Object.keys(draft.raw).some((p) => p.startsWith(`${path}/`));
  const repair = Object.keys(draft.raw)
    .filter((p) => p === path || p.startsWith(`${path}/`))
    .filter((p) => {
      const value = valueAt(draft.configuration, p),
        text = draft.raw[p] ?? '';
      return !(
        (text.startsWith('number:') && typeof value === 'number') ||
        (text.startsWith('hex:') && stackObject(value).kind === 'bytes')
      );
    })
    .sort((a, b) => a.length - b.length)[0];
  const message = stackObject(row).message;
  const messageKey = JSON.stringify([
    target,
    source?.path,
    source?.protocol.id,
    stackObject(message).messageId,
  ]);
  return (
    <>
      <h4 id={`stack-group-${encodeURIComponent(path)}`} tabIndex={-1}>
        {title(collection)} {index + 1} · {row.id.slice(0, 64)}
      </h4>
      <button type='button' onClick={() => setJson(!json)}>
        {json ? '항목 폼으로 돌아가기' : '선택 항목 JSON 편집'}
      </button>
      {json ? (
        <StackJsonInput {...props} path={path} label='선택 시나리오 항목 JSON' />
      ) : repair ? (
        <ScenarioBoundary {...props} path={repair}>
          {null}
        </ScenarioBoundary>
      ) : (
        <ScenarioBoundary {...props} path={path}>
          <StackValueInput
            {...props}
            path={`${path}/id`}
            native={false}
            type='string'
            label={collection === 'inputs' ? '입력 ID' : '기대 조건 ID'}
          />
          {expectation && (
            <>
              <fieldset className='rule-boundary' disabled={pending}>
                <ScenarioChoice
                  path={`${path}/kind`}
                  label='기대 종류'
                  value={expectation.kind}
                  options={kinds}
                  change={(value) => {
                    const next = prepareStackExpectationKind(
                      draft,
                      path,
                      value as StackExpectation['kind'],
                    );
                    if (next) edit(path, next as unknown as JsonValue);
                  }}
                />
              </fieldset>
              {pending && (
                <p role='status'>기대 종류를 바꾸기 전에 이 항목의 미완성 값을 수정하세요.</p>
              )}
            </>
          )}
          <ScenarioBoundary {...props} path={`${path}/target`} identity>
            <ScenarioChoice
              path={`${path}/target`}
              label={collection === 'inputs' ? '입력 대상' : '기대 대상'}
              value={stackTarget(target)}
              options={targets}
              diagnostics={diagnostics}
              change={(value) => {
                const next = targets.find((t) => t.value === value);
                if (next) edit(`${path}/target`, next.target);
              }}
            />
          </ScenarioBoundary>
          {collection === 'inputs' && (
            <StackValueInput
              {...props}
              path={`${path}/timeMs`}
              native={false}
              type='integer'
              label='입력 시각 ms'
            />
          )}
          {(collection === 'inputs' || kind === 'delivered-values') && (
            <StackScenarioMessage
              {...props}
              key={messageKey}
              path={`${path}/message`}
              target={target}
            />
          )}
          {kind === 'state' && (
            <ScenarioBoundary {...props} path={`${path}/stateId`}>
              <ScenarioChoice
                path={`${path}/stateId`}
                label='기대 상태'
                value={expectation?.kind === 'state' ? expectation.stateId : ''}
                diagnostics={diagnostics}
                options={uniqueScenarioDeclarations(source?.body.states ?? []).map((s) => ({
                  value: s.id,
                  label: `${s.label} (${s.id})`,
                }))}
                change={(id) => edit(`${path}/stateId`, id)}
              />
            </ScenarioBoundary>
          )}
          {kind === 'delivery-count' && (
            <>
              <ScenarioBoundary {...props} path={`${path}/messageId`}>
                <ScenarioChoice
                  path={`${path}/messageId`}
                  label='횟수를 확인할 메시지'
                  value={expectation?.kind === 'delivery-count' ? expectation.messageId : ''}
                  diagnostics={diagnostics}
                  options={uniqueScenarioDeclarations(source?.body.messages ?? []).map((m) => ({
                    value: m.id,
                    label: `${m.label} (${m.id})`,
                  }))}
                  change={(id) => edit(`${path}/messageId`, id)}
                />
              </ScenarioBoundary>
              <StackValueInput
                {...props}
                path={`${path}/count`}
                native={false}
                type='integer'
                label='기대 전달 횟수'
              />
            </>
          )}
          {kind === 'completion-before' && (
            <StackValueInput
              {...props}
              path={`${path}/timeMs`}
              native={false}
              type='integer'
              label='성공 완료 기한 ms'
            />
          )}
          {expectation && (
            <p>
              상태와 완료 기한은 선택한 인스턴스, 전달 횟수/값은 상위 응용의 실제 deliver를
              확인합니다.
            </p>
          )}
          <div className='stack-inline'>
            <button
              type='button'
              disabled={index === 0}
              onClick={() => changeList({ kind: 'move', from: index, to: index - 1 })}
            >
              {title(collection)} 위로
            </button>
            <button
              type='button'
              disabled={index + 1 === rows.length}
              onClick={() => changeList({ kind: 'move', from: index, to: index + 1 })}
            >
              {title(collection)} 아래로
            </button>
            <button type='button' onClick={() => changeList({ kind: 'remove', index })}>
              {collection === 'inputs' ? '입력 삭제' : '기대 삭제'} · {row.id.slice(0, 64)}
            </button>
          </div>
        </ScenarioBoundary>
      )}
    </>
  );
}
