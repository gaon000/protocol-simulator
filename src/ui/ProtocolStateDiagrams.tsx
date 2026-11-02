import { useMemo, useState } from 'react';
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
import { StateDiagram, type DiagramActor } from './StateDiagram.tsx';

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
}: {
  run: EngineView;
  draft: ExperimentDefinition;
  eventCount: number;
  onEdit: Edit;
}) {
  const [expanded, setExpanded] = useState(false);
  const [participant, setParticipant] = useState<ParticipantId>('A');
  const protocol = sourceProtocol(run, participant);
  const editorIndex = useMemo(
    () => (protocol ? matchingDiagramDefinition(draft, protocol) : undefined),
    [draft, protocol],
  );
  return (
    <details
      className='execution-state-diagram'
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>실행 상태도 보기</summary>
      {expanded && protocol && (
        <>
          <fieldset className='diagram-participants' aria-label='상태도 참여자 선택'>
            {participants.map((id) => (
              <button
                key={id}
                type='button'
                aria-pressed={participant === id}
                onClick={() => setParticipant(id)}
              >
                참여자 {id} 상태도
              </button>
            ))}
          </fieldset>
          <StateDiagram
            key={`${run.runId}-${participant}`}
            protocol={protocol}
            title={`참여자 ${participant} 실행 상태도`}
            source={`실행 당시 정의 v${protocol.revision} · ${run.runId} · ${run.timeMs} ms`}
            actors={[actor(run, participant, protocol, eventCount)]}
            onEdit={
              editorIndex === undefined
                ? undefined
                : (kind, index) => onEdit(editorIndex, kind, index)
            }
          />
        </>
      )}
    </details>
  );
}
