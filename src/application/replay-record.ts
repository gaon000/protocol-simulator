import type { JsonObject } from '../domain/execution-contract.ts';
import type { EngineView, ParticipantView } from '../domain/protocol-model.ts';
import type { SavedRun } from '../domain/workspace-model.ts';

type MutableActor = {
  stateId: string;
  variables: JsonObject;
  outcome: ParticipantView['outcome'];
  finishedAt: number | null;
  timers: { timerId: string; generation: number; active: boolean; due: number }[];
};
/** Project recorded transitions and timers without resuming or modifying any live simulation. */
export function projectRecord(record: SavedRun, position: number): EngineView {
  const view = record.view;
  if (position >= view.events.length + 1) return view;
  function initial(id: 'A' | 'B'): MutableActor {
    const reference = view.snapshot.configuration.protocols[id];
    const protocol = view.snapshot.configuration.definitions.find(
      (item) => item.id === reference.id && item.revision === reference.revision,
    );
    if (!protocol) throw new Error('Recorded snapshot protocol is missing');
    const terminal = protocol.states.some(
      (item) => item.id === protocol.initialStateId && item.terminal,
    );
    return {
      stateId: protocol.initialStateId,
      variables: Object.fromEntries(
        protocol.variables.map((item) => [item.id, structuredClone(item.initial)]),
      ),
      outcome: terminal ? 'success' : 'active',
      finishedAt: terminal ? 0 : null,
      timers: protocol.timers.map((item) => ({
        timerId: item.id,
        generation: 0,
        active: false,
        due: 0,
      })),
    };
  }
  const participants = { A: initial('A'), B: initial('B') };
  const events = view.events.slice(0, Math.max(0, position));
  function clear(actor: MutableActor) {
    for (const timer of actor.timers) {
      timer.active = false;
      timer.generation++;
    }
  }
  for (const event of events) {
    const actor = participants[event.participant];
    const data = event.data as JsonObject;
    if (event.kind === 'transition') {
      const after = data.after as JsonObject;
      actor.stateId = String(after.stateId);
      actor.variables = structuredClone(after.variables) as JsonObject;
      actor.outcome = data.outcome as ParticipantView['outcome'];
      if (actor.outcome !== 'active') {
        actor.finishedAt ??= event.timeMs;
        clear(actor);
      }
    } else if (event.kind === 'diagnostic') {
      actor.outcome = 'error';
      actor.finishedAt ??= event.timeMs;
      clear(actor);
    } else if (event.kind === 'timer') {
      const timer = actor.timers.find((item) => item.timerId === data.timerId);
      if (timer) {
        timer.generation = Number(data.generation);
        timer.active = data.operation === 'start';
        if (data.due !== undefined) timer.due = Number(data.due);
      }
    }
  }
  return {
    ...view,
    status: 'paused',
    timeMs: events.at(-1)?.timeMs ?? 0,
    processedEvents: 0,
    participants,
    diagnostics: events
      .filter((event) => event.kind === 'diagnostic')
      .map((event) => event.data as EngineView['diagnostics'][number]),
    expectations: view.expectations.map((item) => ({
      ...item,
      status: 'undetermined',
      detail: '기록 재생 중: 저장 시점으로 이동하면 당시 판정을 표시합니다.',
    })),
  };
}

/** Compare semantic history, keeping generated run IDs outside replay equivalence. */
export function compareRecord(record: SavedRun, replayed: EngineView): string {
  const comparable = (events: EngineView['events']) =>
    events.map(({ runId: _runId, ...event }) => event);
  const partial = ['idle', 'running', 'paused', 'cancelled'].includes(record.view.status);
  const events = partial ? replayed.events.slice(0, record.view.events.length) : replayed.events;
  const same =
    JSON.stringify(comparable(record.view.events)) === JSON.stringify(comparable(events)) &&
    (partial ||
      (JSON.stringify(record.view.expectations) === JSON.stringify(replayed.expectations) &&
        record.view.status === replayed.status &&
        JSON.stringify(record.view.participants) === JSON.stringify(replayed.participants) &&
        JSON.stringify(record.view.diagnostics) === JSON.stringify(replayed.diagnostics)));
  return same
    ? partial
      ? '저장된 구간의 의미적 기록이 일치합니다.'
      : 'snapshot 재실행의 의미적 기록·상태·판정이 일치합니다.'
    : 'snapshot 재실행 결과가 저장 기록과 다릅니다. 원본 기록은 유지했습니다.';
}
