import type { JsonValue } from '../domain/execution-contract.ts';
import type {
  ServicePort,
  StackEndpoint,
  StackProtocol,
  StackRule,
  StackRuleEvent,
} from '../domain/stack-model.ts';
import { stackProtocolBody } from '../domain/stack-model.ts';
import type { StackDraft } from '../domain/workspace-v2-model.ts';
import {
  type DiagramEndpoint,
  type DraftDiagramSelection,
  newDiagramState,
  validDiagramEndpoint,
  validDiagramEvent,
} from './diagram-authoring.ts';
import { blockingStackRaw, editStackList } from './edit-stack-list.ts';
import { nextId } from './edit-experiment.ts';

export type StackDiagramSource = {
  readonly draftId: string;
  readonly version: number;
  readonly endpoint: StackEndpoint;
  readonly definition: number;
  readonly protocolId: string;
  readonly revision: number;
  readonly configuration: StackDraft['configuration'];
  readonly raw: StackDraft['raw'];
};
export type StackDiagramCommand =
  | { readonly kind: 'state' }
  | {
      readonly kind: 'rule';
      readonly from: DiagramEndpoint;
      readonly to: DiagramEndpoint;
      readonly event: StackRuleEvent;
    };
export type StackDiagramAppend = {
  readonly draft: StackDraft;
  readonly selection: DraftDiagramSelection;
};
type EventChoice = { readonly event: StackRuleEvent; readonly label: string };

/** Capture one unambiguous editable endpoint and its exact canonical definition, including pending text. */
export function captureStackDiagramSource(
  draft: StackDraft,
  endpoint: StackEndpoint,
): StackDiagramSource | undefined {
  const instances = draft.configuration.nodes[endpoint.participant].instances.filter(
    (i) => i.id === endpoint.instanceId,
  );
  const reference = instances[0]?.definition;
  if (instances.length !== 1 || !reference) return;
  const matches = draft.configuration.definitions
    .map((p, index) => ({ p, index }))
    .filter(({ p }) => p.id === reference.id && p.revision === reference.revision);
  const match = matches[0];
  if (matches.length !== 1 || !match) return;
  return {
    draftId: draft.id,
    version: draft.version,
    endpoint: { ...endpoint },
    definition: match.index,
    protocolId: match.p.id,
    revision: match.p.revision,
    configuration: draft.configuration,
    raw: draft.raw,
  };
}

/** Format only a bounded trigger label; native port operations remain explicit rather than becoming message events. */
export function stackDiagramEventText(event: StackRuleEvent): string {
  const short = (value: string) => (value.length > 48 ? `${value.slice(0, 48)}…` : value);
  if ('messageId' in event)
    return `${event.kind === 'input' ? '입력' : '수신'} ${short(event.messageId)}`;
  if (event.kind === 'timer') return `만료 ${short(event.timerId)}`;
  if (event.kind === 'connection') return `연결 ${event.state === 'failed' ? '실패' : '종료'}`;
  return `${event.kind === 'service-request' ? '상위 요청' : '하위 통지'} ${short(event.portId)} · ${event.operation}`;
}

function validPort(port: ServicePort | undefined, role: ServicePort['role']): port is ServicePort {
  return (
    !!port?.id.trim() &&
    port.role === role &&
    port.request === (port.service.kind === 'stream' ? 'write' : 'send') &&
    port.indication === (port.service.kind === 'stream' ? 'read' : 'receive')
  );
}
function uniqueIds(items: readonly { readonly id: string }[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  return [...counts].filter(([id, count]) => id.trim() && count === 1).map(([id]) => id);
}
function eventKey(event: StackRuleEvent): string {
  if ('messageId' in event) return JSON.stringify([event.kind, event.messageId]);
  if (event.kind === 'timer') return JSON.stringify([event.kind, event.timerId]);
  if (event.kind === 'connection') return JSON.stringify([event.kind, event.state]);
  return JSON.stringify([event.kind, event.portId, event.operation]);
}

/** Enumerate only unique declared messages/timers and actual native/legacy port contracts for creation. */
export function stackDiagramEvents(protocol: StackProtocol): readonly EventChoice[] {
  const body = stackProtocolBody(protocol);
  const events: StackRuleEvent[] = uniqueIds(body.messages).flatMap((messageId) => [
    { kind: 'input', messageId },
    { kind: 'receive', messageId },
  ]);
  events.push(...uniqueIds(body.timers).map((timerId) => ({ kind: 'timer' as const, timerId })));
  for (const state of ['closed', 'failed'] as const) {
    const event = { kind: 'connection' as const, state };
    if (
      protocol.requires.lifecycle.notifications.includes(state) &&
      (protocol.mode === 'stack-protocol' || validDiagramEvent(protocol.source, event))
    )
      events.push(event);
  }
  if (protocol.mode === 'stack-protocol') {
    if (validPort(protocol.provides, 'provides'))
      events.push({
        kind: 'service-request',
        portId: protocol.provides.id,
        operation: protocol.provides.request,
      });
    if (validPort(protocol.requires, 'requires')) {
      events.push({
        kind: 'service-indication',
        portId: protocol.requires.id,
        operation: protocol.requires.indication,
      });
      for (const operation of ['closed', 'failed'] as const)
        if (protocol.requires.lifecycle.notifications.includes(operation))
          events.push({ kind: 'service-indication', portId: protocol.requires.id, operation });
    }
  }
  return events.map((event) => ({ event, label: stackDiagramEventText(event) }));
}

/** Prepare a state-only rule with validated unique endpoints and an explicitly acknowledged no-op self loop. */
export function prepareStackDiagramTransition(
  protocol: StackProtocol,
  from: DiagramEndpoint,
  to: DiagramEndpoint,
  event: StackRuleEvent,
): { success: true; rule: StackRule; overlaps: boolean } | { success: false; message: string } {
  const body = stackProtocolBody(protocol);
  if (!validDiagramEndpoint(body, from) || !validDiagramEndpoint(body, to))
    return {
      success: false,
      message: '출발·도착 상태의 ID가 없거나 중복됐습니다. 상태를 다시 선택하세요.',
    };
  if (!stackDiagramEvents(protocol).some((choice) => eventKey(choice.event) === eventKey(event)))
    return { success: false, message: '현재 메시지·타이머·포트와 선언한 operation을 확인하세요.' };
  return {
    success: true,
    rule: {
      id: nextId(body.rules, 'rule'),
      fromStateId: from.id,
      nextStateId: to.id,
      event: { ...event },
      actions: [],
      ...(from.id === to.id ? { ignore: true } : {}),
    },
    overlaps: body.rules.some(
      (rule) => rule.fromStateId === from.id && eventKey(rule.event) === eventKey(event),
    ),
  };
}

/** Identify pending text that obscures a chosen endpoint or event declaration; unrelated child raw is retained. */
export function pendingStackDiagramCommand(
  draft: StackDraft,
  source: StackDiagramSource,
  command: StackDiagramCommand,
): string | undefined {
  const protocol = draft.configuration.definitions[source.definition];
  if (!protocol) return '/definitions';
  const body = stackProtocolBody(protocol);
  const base = `/definitions/${source.definition}`;
  const prefix = `${base}${protocol.mode === 'legacy-application' ? '/source' : ''}`;
  const list = `${prefix}/${command.kind === 'state' ? 'states' : 'rules'}`;
  const parent = blockingStackRaw(draft.raw, list);
  if (parent || command.kind === 'state') return parent;
  const paths = [`${prefix}/states/${command.from.index}`, `${prefix}/states/${command.to.index}`];
  const event = command.event;
  if ('messageId' in event)
    paths.push(`${prefix}/messages/${body.messages.findIndex((m) => m.id === event.messageId)}`);
  else if (event.kind === 'timer')
    paths.push(`${prefix}/timers/${body.timers.findIndex((t) => t.id === event.timerId)}`);
  else {
    paths.push(`${base}/${event.kind === 'service-request' ? 'provides' : 'requires'}`);
    if (protocol.mode === 'legacy-application') paths.push(`${prefix}/lowerService`);
  }
  return Object.keys(draft.raw).find((key) =>
    paths.some((path) => key === path || path.startsWith(`${key}/`) || key.startsWith(`${path}/`)),
  );
}

/** Atomically append to the current draft only; stale source/parent raw never rewrites data, history or snapshots. */
export function appendStackDiagram(
  draft: StackDraft,
  source: StackDiagramSource,
  command: StackDiagramCommand,
  now = Date.now(),
): StackDiagramAppend | undefined {
  const current = captureStackDiagramSource(draft, source.endpoint);
  if (
    !current ||
    current.draftId !== source.draftId ||
    current.version !== source.version ||
    current.definition !== source.definition ||
    current.protocolId !== source.protocolId ||
    current.revision !== source.revision ||
    current.configuration !== source.configuration ||
    current.raw !== source.raw
  )
    return;
  const protocol = draft.configuration.definitions[source.definition];
  if (!protocol) return;
  const body = stackProtocolBody(protocol);
  const kind = command.kind;
  const path = `/definitions/${source.definition}${protocol.mode === 'legacy-application' ? '/source' : ''}/${kind === 'state' ? 'states' : 'rules'}`;
  if (pendingStackDiagramCommand(draft, source, command)) return;
  const prepared =
    command.kind === 'rule'
      ? prepareStackDiagramTransition(protocol, command.from, command.to, command.event)
      : undefined;
  if (prepared && !prepared.success) return;
  const value =
    kind === 'state' ? newDiagramState(body) : prepared?.success ? prepared.rule : undefined;
  if (!value) return;
  const result = editStackList(
    draft,
    path,
    { kind: 'add', value: value as unknown as JsonValue },
    now,
  );
  if (result === draft) return;
  return {
    draft: result,
    selection: { kind, index: kind === 'state' ? body.states.length : body.rules.length },
  };
}
