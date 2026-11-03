import type { ProtocolDefinition, RuleDefinition, RuleEvent } from '../domain/protocol-model.ts';
import { nextId } from './edit-experiment.ts';

export type DraftDiagramSelection = { readonly kind: 'state' | 'rule'; readonly index: number };
export type DiagramEndpoint = { readonly index: number; readonly id: string };
export type DraftDiagramAppend =
  | { readonly kind: 'state'; readonly value: ProtocolDefinition['states'][number] }
  | { readonly kind: 'rule'; readonly value: RuleDefinition };
export type TransitionPreparation =
  | { readonly success: true; readonly rule: RuleDefinition; readonly overlaps: boolean }
  | { readonly success: false; readonly message: string };
function sameEvent(left: RuleEvent, right: RuleEvent): boolean {
  return (
    left.kind === right.kind &&
    ('messageId' in left && 'messageId' in right
      ? left.messageId === right.messageId
      : 'timerId' in left && 'timerId' in right
        ? left.timerId === right.timerId
        : 'state' in left && 'state' in right && left.state === right.state)
  );
}

/** Reserve existing and dangling IDs so a new state cannot silently retarget old references. */
export function newDiagramState(
  protocol: ProtocolDefinition,
): ProtocolDefinition['states'][number] {
  const reserved = [
    ...protocol.states,
    { id: protocol.initialStateId },
    ...protocol.rules.flatMap((rule) => [{ id: rule.fromStateId }, { id: rule.nextStateId }]),
  ];
  return { id: nextId(reserved, 'state'), label: '새 상태' };
}

/** Resolve a state only if both its captured index and unique nonempty ID still match. */
export function validDiagramEndpoint(
  protocol: ProtocolDefinition,
  endpoint: DiagramEndpoint,
): boolean {
  return (
    Number.isSafeInteger(endpoint.index) &&
    endpoint.index >= 0 &&
    !!endpoint.id.trim() &&
    protocol.states[endpoint.index]?.id === endpoint.id &&
    protocol.states.filter((state) => state.id === endpoint.id).length === 1
  );
}

/** Validate available trigger references without inventing messages, timers or lower services. */
export function validDiagramEvent(protocol: ProtocolDefinition, event: RuleEvent): boolean {
  if (event.kind === 'connection')
    return protocol.lowerService === 'stream' && ['closed', 'failed'].includes(event.state);
  const collection = event.kind === 'timer' ? protocol.timers : protocol.messages;
  const id = event.kind === 'timer' ? event.timerId : event.messageId;
  return !!id.trim() && collection.filter((item) => item.id === id).length === 1;
}

/** Prepare a state-only transition, or an explicitly described no-op self loop, for the draft. */
export function prepareDiagramTransition(
  protocol: ProtocolDefinition,
  from: DiagramEndpoint,
  to: DiagramEndpoint,
  event: RuleEvent,
): TransitionPreparation {
  if (!validDiagramEndpoint(protocol, from) || !validDiagramEndpoint(protocol, to))
    return {
      success: false,
      message: '출발·도착 상태의 ID가 없거나 중복됐습니다. 상태를 다시 선택하세요.',
    };
  if (!validDiagramEvent(protocol, event))
    return { success: false, message: '이벤트의 메시지·타이머 또는 하위 서비스를 확인하세요.' };
  const rule: RuleDefinition = {
    id: nextId(protocol.rules, 'rule'),
    fromStateId: from.id,
    nextStateId: to.id,
    event: { ...event },
    actions: [],
    ...(from.id === to.id ? { ignore: true } : {}),
  };
  const overlaps = protocol.rules.some(
    (item) => item.fromStateId === from.id && sameEvent(item.event, event),
  );
  return { success: true, rule, overlaps };
}
