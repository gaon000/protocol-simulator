import type { ParticipantId } from '../domain/execution-contract.ts';
import type { EngineView, EventTrace } from '../domain/protocol-model.ts';
import { sequenceProtocol, traceObject } from './sequence-diagram.ts';

export type DiagramTarget = {
  readonly participant: ParticipantId;
  readonly kind: 'rule' | 'state';
  readonly index: number;
};
export type DiagramLinks = {
  readonly events: ReadonlyMap<string, EventTrace>;
  readonly transitions: readonly EventTrace[];
  readonly transitionsByEvent: ReadonlyMap<string, readonly EventTrace[]>;
  readonly eventsByTransition: ReadonlyMap<string, ReadonlySet<string>>;
};
export type DiagramInspection = {
  readonly key: string;
  readonly participant: ParticipantId;
  readonly target: DiagramTarget | undefined;
  readonly event: EventTrace | undefined;
  readonly ruleIndex: number | undefined;
  readonly transitions: readonly EventTrace[];
  readonly relatedEventIds: ReadonlySet<string>;
  readonly focusedTransition: EventTrace | undefined;
  readonly beforeStateId: string | undefined;
  readonly afterStateId: string | undefined;
};
function groupKey(event: EventTrace) {
  return JSON.stringify([event.participant, event.ruleId, event.causeEventId ?? event.eventId]);
}

/** Index observed execution occurrences without copying wire data or crossing actor/trigger boundaries. */
export function buildDiagramLinks(
  run: Pick<EngineView, 'events'>,
  eventCount = run.events.length,
): DiagramLinks {
  const prefix = run.events.slice(
    0,
    Math.max(0, Math.min(run.events.length, Math.floor(eventCount))),
  );
  const events = new Map(prefix.map((event) => [event.eventId, event]));
  const transitions = prefix.filter((event) => event.kind === 'transition');
  const groups = new Map<string, EventTrace[]>();
  for (const event of prefix)
    if (event.ruleId !== undefined) {
      const key = groupKey(event);
      const group = groups.get(key) ?? [];
      group.push(event);
      groups.set(key, group);
    }
  const transitionsByEvent = new Map<string, Set<EventTrace>>();
  const eventsByTransition = new Map<string, Set<string>>();
  function link(event: EventTrace, transition: EventTrace) {
    const related = transitionsByEvent.get(event.eventId) ?? new Set<EventTrace>();
    related.add(transition);
    transitionsByEvent.set(event.eventId, related);
    const ids = eventsByTransition.get(transition.eventId) ?? new Set<string>();
    ids.add(event.eventId);
    eventsByTransition.set(transition.eventId, ids);
  }
  for (const transition of transitions) {
    link(transition, transition);
    if (transition.ruleId !== undefined)
      for (const event of groups.get(groupKey(transition)) ?? []) link(event, transition);
    const trigger = events.get(transition.causeEventId ?? '');
    if (!trigger || trigger.participant !== transition.participant) continue;
    link(trigger, transition);
    const read = trigger.kind === 'parsed' ? events.get(trigger.causeEventId ?? '') : undefined;
    if (read?.kind === 'receive' && read.participant === transition.participant)
      link(read, transition);
  }
  for (const event of prefix)
    if (event.kind === 'environment') {
      const source = events.get(event.causeEventId ?? '');
      if (source?.kind !== 'send' || source.participant !== event.participant) continue;
      for (const transition of transitionsByEvent.get(source.eventId) ?? [])
        link(event, transition);
    }
  return {
    events,
    transitions,
    transitionsByEvent: new Map([...transitionsByEvent].map(([id, values]) => [id, [...values]])),
    eventsByTransition,
  };
}

/** Find actual observed occurrences of a frozen rule or entry/exit of a frozen state. */
export function diagramOccurrences(
  links: DiagramLinks,
  run: EngineView,
  target: DiagramTarget,
): readonly EventTrace[] {
  const protocol = sequenceProtocol(run, target.participant);
  const id =
    target.kind === 'rule' ? protocol?.rules[target.index]?.id : protocol?.states[target.index]?.id;
  if (id === undefined) return [];
  return links.transitions.filter((event) => {
    if (event.participant !== target.participant) return false;
    if (target.kind === 'rule') return event.ruleId === id;
    const data = traceObject(event.data);
    return traceObject(data.before).stateId === id || traceObject(data.after).stateId === id;
  });
}

/** Resolve selection evidence; absent commits and multi-message reads never fabricate one state change. */
export function inspectDiagramLinks(
  links: DiagramLinks,
  run: EngineView,
  selected: string | undefined,
  target?: DiagramTarget,
): DiagramInspection | undefined {
  const event = selected ? links.events.get(selected) : undefined;
  if (!event && !target) return undefined;
  const participant = target?.participant ?? event?.participant ?? 'A';
  const transitions = target
    ? diagramOccurrences(links, run, target)
    : (links.transitionsByEvent.get(event?.eventId ?? '') ?? []);
  const protocol = sequenceProtocol(run, participant);
  const ruleId = event?.ruleId ?? (transitions.length === 1 ? transitions[0]?.ruleId : undefined);
  const found = protocol?.rules.findIndex((rule) => rule.id === ruleId);
  const ruleIndex = target
    ? target.kind === 'rule'
      ? target.index
      : undefined
    : found !== undefined && found >= 0
      ? found
      : undefined;
  const relatedEventIds = new Set<string>();
  if (event && !target) relatedEventIds.add(event.eventId);
  for (const transition of transitions)
    for (const id of links.eventsByTransition.get(transition.eventId) ?? [])
      relatedEventIds.add(id);
  const focusedTransition =
    transitions.find((item) => item.eventId === selected) ??
    (transitions.length === 1 ? transitions[0] : undefined);
  const data = traceObject(focusedTransition?.data);
  const before = traceObject(data.before).stateId;
  const after = traceObject(data.after).stateId;
  return {
    key: target
      ? `${target.kind}-${participant}-${target.index}-${selected ?? ''}`
      : `event-${event?.eventId}`,
    participant,
    target,
    event,
    ruleIndex,
    transitions,
    relatedEventIds,
    focusedTransition,
    beforeStateId: typeof before === 'string' ? before : undefined,
    afterStateId: typeof after === 'string' ? after : undefined,
  };
}
