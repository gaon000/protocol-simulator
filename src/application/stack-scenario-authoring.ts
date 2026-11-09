import type { JsonValue } from '../domain/execution-contract.ts';
import { valueAt } from '../domain/json-pointer.ts';
import type { StackEndpoint, StackExpectation, StackField } from '../domain/stack-model.ts';
import { stackProtocolBody } from '../domain/stack-model.ts';
import { serializeBytes } from '../domain/stack-bytes.ts';
import { stackObject, stackTarget } from '../domain/stack-record.ts';
import type { StackDraft } from '../domain/workspace-v2-model.ts';
import { blockingStackRaw } from './edit-stack-list.ts';

export const SCENARIO_FORM_POLICY = { pageSize: 10, choices: 20 } as const;
export type ScenarioCollection = 'inputs' | 'expectations';

/** Resolve one unambiguous endpoint and exact definition revision, never the first matching ID. */
export function stackScenarioProtocol(draft: StackDraft, target: StackEndpoint) {
  const instances = draft.configuration.nodes[target.participant]?.instances.filter(
    (i) => i.id === target.instanceId,
  );
  const instance = instances?.length === 1 ? instances[0] : undefined;
  if (!instance) return;
  const matches = draft.configuration.definitions.flatMap((protocol, index) =>
    protocol.id === instance.definition.id && protocol.revision === instance.definition.revision
      ? [{ protocol, index }]
      : [],
  );
  const found = matches.length === 1 ? matches[0] : undefined;
  if (!found) return;
  const body = stackProtocolBody(found.protocol);
  return {
    protocol: found.protocol,
    body,
    path: `/definitions/${found.index}${found.protocol.mode === 'legacy-application' ? '/source' : ''}`,
  };
}

/** Offer only actual unambiguous endpoints; application-only policies do not hide the current invalid value. */
export function stackScenarioTargets(draft: StackDraft, applicationOnly: boolean) {
  return (['A', 'B'] as const).flatMap((participant) =>
    draft.configuration.nodes[participant].instances.flatMap((instance) => {
      const target = { participant, instanceId: instance.id };
      const source = stackScenarioProtocol(draft, target);
      return source && (!applicationOnly || source.body.layer === 'application')
        ? [{ value: stackTarget(target), label: stackTarget(target), target }]
        : [];
    }),
  );
}

/** Select only unique nonempty declared identities without silently repairing ambiguous references. */
export function uniqueScenarioDeclarations<T extends { readonly id: string }>(rows: readonly T[]) {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  return rows.filter((row) => row.id && counts.get(row.id) === 1);
}

/** Derive the exact message schema, marking pending declaration JSON before using defaults or typed fields. */
export function stackScenarioMessage(draft: StackDraft, target: StackEndpoint, id: string) {
  const source = stackScenarioProtocol(draft, target);
  if (!source) return;
  const declarations = `${source.path}/messages`;
  const message = uniqueScenarioDeclarations(source.body.messages).find((m) => m.id === id);
  const index = message ? source.body.messages.indexOf(message) : -1;
  const blocked =
    blockingStackRaw(draft.raw, declarations) ??
    Object.keys(draft.raw).find(
      (path) =>
        index >= 0 &&
        (path === `${declarations}/${index}` || path.startsWith(`${declarations}/${index}/`)),
    );
  return { ...source, message, blocked };
}

/** Explicitly include a declared default or an editable typed seed; omission remains a separate operation. */
export function stackScenarioFieldValue(field: StackField): JsonValue {
  if (Object.hasOwn(field, 'defaultValue')) return structuredClone(field.defaultValue as JsonValue);
  if (field.type === 'bytes') return serializeBytes(new Uint8Array());
  if (field.type === 'boolean') return false;
  if (field.type === 'integer') return 0;
  if (field.type === 'enum') return field.options[0] ?? '';
  return '';
}

/** Construct one of the engine's four exact expectation shapes without carrying fields from another kind. */
export function stackScenarioExpectation(
  draft: StackDraft,
  id: string,
  target: StackEndpoint,
  kind: StackExpectation['kind'],
): StackExpectation {
  const source = stackScenarioProtocol(draft, target);
  const messages = uniqueScenarioDeclarations(source?.body.messages ?? []);
  const base = { id, target: structuredClone(target) };
  if (kind === 'state') return { ...base, kind, stateId: source?.body.initialStateId ?? '' };
  if (kind === 'completion-before')
    return { ...base, kind, timeMs: draft.configuration.scenario.observationMs };
  if (kind === 'delivery-count')
    return { ...base, kind, messageId: messages[0]?.id ?? '', count: 1 };
  return { ...base, kind, message: { messageId: messages[0]?.id ?? '', values: {} } };
}

/** Block destructive kind replacement until every pending value in that row is repaired. */
export function prepareStackExpectationKind(
  draft: StackDraft,
  path: string,
  kind: StackExpectation['kind'],
): StackExpectation | undefined {
  if (
    !/^\/scenario\/expectations\/\d+$/.test(path) ||
    blockingStackRaw(draft.raw, path) ||
    Object.keys(draft.raw).some((key) => key.startsWith(`${path}/`))
  )
    return;
  const row = stackObject(valueAt(draft.configuration, path));
  if (typeof row.id !== 'string' || row.kind === kind) return;
  const target = stackObject(row.target);
  if (
    (target.participant !== 'A' && target.participant !== 'B') ||
    typeof target.instanceId !== 'string'
  )
    return;
  return stackScenarioExpectation(
    draft,
    row.id,
    { participant: target.participant, instanceId: target.instanceId },
    kind,
  );
}

/** Create a fresh scenario row from the first actual application, independent of the definition editor selection. */
export function newStackScenarioRow(draft: StackDraft, collection: ScenarioCollection): JsonValue {
  const rows = draft.configuration.scenario[collection];
  const prefix = collection === 'inputs' ? 'input' : 'expected';
  let n = 1;
  while (rows.some((row) => row.id === `${prefix}_${n}`)) n++;
  const id = `${prefix}_${n}`;
  const target = stackScenarioTargets(draft, true)[0]?.target ?? {
    participant: 'A',
    instanceId: '',
  };
  if (collection === 'expectations')
    return stackScenarioExpectation(draft, id, target, 'state') as unknown as JsonValue;
  const source = stackScenarioProtocol(draft, target);
  return {
    id,
    timeMs: 0,
    target,
    message: {
      messageId: uniqueScenarioDeclarations(source?.body.messages ?? [])[0]?.id ?? '',
      values: {},
    },
  };
}
