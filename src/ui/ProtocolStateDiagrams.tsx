import { useMemo, useState } from 'react';
import type { DiagramInspection, DiagramTarget } from '../application/diagram-links.ts';
import {
  appliedDiagramRule,
  diagramProtocolsMatch,
  matchingDiagramDefinition,
} from '../application/state-diagram.ts';
import type { ParticipantId } from '../domain/execution-contract.ts';
import type {
  EngineView,
  ExperimentDefinition,
  ProtocolDefinition,
} from '../domain/protocol-model.ts';
import { DiagramLinkDetails } from './DiagramLinkDetails.tsx';
import { type DiagramActor, StateDiagram } from './StateDiagram.tsx';
import { useDiagramPanel } from './useDiagramPanel.ts';

type Edit = (definition: number, kind: 'state' | 'rule', index: number) => void;
const participants = ['A', 'B'] as const;
function sourceProtocol(run: EngineView, participant: ParticipantId) {
  const reference = run.snapshot.configuration.protocols[participant];
  return run.snapshot.configuration.definitions.find(
    (item) => item.id === reference.id && item.revision === reference.revision,
  );
}
function actor(
  run: EngineView,
  participant: ParticipantId,
  protocol: ProtocolDefinition,
  eventCount: number,
): DiagramActor {
  return {
    participant,
    stateId: run.participants[participant].stateId,
    outcome: run.participants[participant].outcome,
    ruleIndex: appliedDiagramRule(run, participant, protocol, eventCount),
  };
}

/** Decorate the editable definition only with execution data from an exactly matching snapshot. */
export function DraftStateDiagram({
  protocol,
  index,
  run,
  eventCount,
  onEdit,
}: {
  protocol: ProtocolDefinition;
  index: number;
  run: EngineView | undefined;
  eventCount: number;
  onEdit: Edit;
}) {
  const snapshot = run?.snapshot;
  const matching = useMemo(
    () =>
      participants.filter((participant) => {
        if (!snapshot) return false;
        const reference = snapshot.configuration.protocols[participant];
        const source = snapshot.configuration.definitions.find(
          (item) => item.id === reference.id && item.revision === reference.revision,
        );
        return source && diagramProtocolsMatch(protocol, source);
      }),
    [protocol, snapshot],
  );
  const actors = run
    ? matching.map((participant) => actor(run, participant, protocol, eventCount))
    : [];
  return (
    <StateDiagram
      key={`${index}-${protocol.revision}`}
      protocol={protocol}
      title='프로토콜 상태도'
      source={`현재 초안 · 정의 v${protocol.revision}${run && !actors.length ? ' · 일치하는 실행 표시 없음' : ''}`}
      actors={actors}
      onEdit={(kind, item) => onEdit(index, kind, item)}
    />
  );
}

/** Inspect each participant's frozen definition and cursor state independently of current draft edits. */
export function ExecutionStateDiagram({
  run,
  draft,
  eventCount,
  onEdit,
  inspection,
  selected,
  onInspect,
  onOccurrence,
  onSequence,
  onFollow,
  revealRequest,
  context,
}: {
  run: EngineView;
  draft: ExperimentDefinition;
  eventCount: number;
  onEdit: Edit;
  inspection: DiagramInspection | undefined;
  selected: string | undefined;
  onInspect: (target: DiagramTarget) => void;
  onOccurrence: (id: string) => void;
  onSequence: () => void;
  onFollow: () => void;
  revealRequest: number;
  context: string;
}) {
  const panel = useDiagramPanel(revealRequest);
  const [manual, setManual] = useState<{ participant: ParticipantId; key: string | undefined }>({
    participant: 'A',
    key: undefined,
  });
  const participant =
    manual.key === inspection?.key
      ? manual.participant
      : (inspection?.participant ?? manual.participant);
  const protocol = sourceProtocol(run, participant);
  const editorIndex = useMemo(
    () => (protocol ? matchingDiagramDefinition(draft, protocol) : undefined),
    [draft, protocol],
  );
  return (
    <details
      ref={panel.ref}
      className='execution-state-diagram'
      open={panel.expanded}
      onToggle={(event) => panel.onToggle(event.currentTarget.open)}
    >
      <summary>실행 상태도 보기</summary>
      {panel.expanded && protocol && (
        <>
          <fieldset className='diagram-participants' aria-label='상태도 참여자 선택'>
            {participants.map((id) => (
              <button
                key={id}
                type='button'
                aria-pressed={participant === id}
                onClick={() => setManual({ participant: id, key: inspection?.key })}
              >
                참여자 {id} 상태도
              </button>
            ))}
          </fieldset>
          <StateDiagram
            key={`${run.runId}-${context}-${participant}`}
            protocol={protocol}
            title={`참여자 ${participant} 실행 상태도`}
            source={`실행 당시 정의 v${protocol.revision} · ${run.runId} · ${run.timeMs} ms`}
            actors={[actor(run, participant, protocol, eventCount)]}
            inspection={inspection?.participant === participant ? inspection : undefined}
            onInspect={(kind, index) => onInspect({ participant, kind, index })}
            onFollow={onFollow}
            onEdit={
              editorIndex === undefined
                ? undefined
                : (kind, index) => onEdit(editorIndex, kind, index)
            }
          />
          {inspection && inspection.participant === participant && (
            <DiagramLinkDetails
              key={`${participant}-${inspection.target?.kind ?? inspection.event?.eventId}-${inspection.target?.index ?? ''}`}
              inspection={inspection}
              selected={selected}
              onSelect={onOccurrence}
              onSequence={onSequence}
            />
          )}
          {inspection && inspection.participant !== participant && (
            <p className='hint'>
              선택한 기록은 참여자 {inspection.participant}의 실행입니다. 해당 참여자 버튼으로
              연결을 확인하세요.
            </p>
          )}
        </>
      )}
    </details>
  );
}
