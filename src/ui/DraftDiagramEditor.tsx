/** biome-ignore-all lint/suspicious/noArrayIndexKey: Diagnostic rows are stateless summaries and may repeat a path/code in an unfinished definition. */
import type { DraftDiagramSelection } from '../application/diagram-authoring.ts';
import type { ProtocolDefinition } from '../domain/protocol-model.ts';
import { useEditor } from './forms.tsx';
import { StateEditor } from './ProtocolEditor.tsx';
import { RuleEditor } from './RuleEditor.tsx';

/** Reuse the selected state's or rule's real form without duplicate JSON Pointer controls. */
export function DraftDiagramEditor({
  protocol,
  definition,
  selection,
  onReattach,
}: {
  protocol: ProtocolDefinition;
  definition: number;
  selection: DraftDiagramSelection;
  onReattach: () => void;
}) {
  const { diagnostics } = useEditor();
  const path = `/definitions/${definition}/${selection.kind === 'state' ? 'states' : 'rules'}/${selection.index}`;
  const errors = diagnostics.filter(
    (item) => item.path === path || item.path.startsWith(`${path}/`),
  );
  const state = selection.kind === 'state' ? protocol.states[selection.index] : undefined;
  const rule = selection.kind === 'rule' ? protocol.rules[selection.index] : undefined;
  return (
    <section className='draft-diagram-editor' aria-label='상태도 선택 편집기'>
      <h2>선택한 {selection.kind === 'state' ? '상태' : '규칙'} 편집</h2>
      <p className='hint'>현재 초안에 반영하고 자동 저장합니다. 실행 당시 정의는 유지합니다.</p>
      <button type='button' onClick={onReattach}>
        전체 목록에서 편집
      </button>
      {!!errors.length && (
        <section aria-label='선택 항목 진단'>
          <h3>확인할 내용 · {errors.length}개</h3>
          <ul>
            {errors.slice(0, 16).map((item, index) => (
              <li key={`${item.path}-${item.code}-${index}`}>
                {item.code} · {item.message}
              </li>
            ))}
          </ul>
          {errors.length > 16 && <p>나머지는 정의 진단에서 확인하세요.</p>}
        </section>
      )}
      {state && <StateEditor state={state} path={path} />}
      {rule && <RuleEditor rule={rule} protocol={protocol} path={path} />}
    </section>
  );
}
