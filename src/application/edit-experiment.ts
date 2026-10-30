import type { JsonValue } from '../domain/execution-contract.ts';
import type { ExperimentDefinition, ProtocolDefinition } from '../domain/protocol-model.ts';
import { createPingPongExperiment } from '../examples/ping-pong.ts';

import { valueAt } from '../domain/json-pointer.ts';
export { valueAt, pointerToken } from '../domain/json-pointer.ts';

/** Copy a form edit and advance definition revisions and their participant references together. */
export function editExperiment(
  draft: ExperimentDefinition,
  path: string,
  value: JsonValue | undefined,
): ExperimentDefinition {
  const parts = path
    .split('/')
    .slice(1)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  const parent = valueAt(draft, path.slice(0, path.lastIndexOf('/')));
  if (!parts.length || !parent || typeof parent !== 'object') return draft;
  function replace(node: unknown, depth: number): unknown {
    if (!node || typeof node !== 'object') return node;
    const key = parts[depth];
    if (key === undefined) return node;
    const copy = Array.isArray(node) ? [...node] : { ...node };
    if (depth === parts.length - 1 && value === undefined) {
      if (Array.isArray(copy)) copy.splice(Number(key), 1);
      else delete (copy as Record<string, unknown>)[key];
    } else
      Object.defineProperty(copy, key, {
        value:
          depth === parts.length - 1
            ? structuredClone(value)
            : replace((node as Record<string, unknown>)[key], depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return copy;
  }
  const copy = replace(draft, 0) as ExperimentDefinition;
  const index = /^\/definitions\/(\d+)(?:\/|$)/.exec(path)?.[1];
  if (index !== undefined && !(value === undefined && path === `/definitions/${index}`)) {
    const before = draft.definitions[Number(index)];
    const after = copy.definitions[Number(index)];
    if (before && after) {
      (after as { revision: number }).revision = before.revision + 1;
      const protocols = { ...copy.protocols };
      for (const participant of ['A', 'B'] as const) {
        if (
          copy.protocols[participant].id === before.id &&
          copy.protocols[participant].revision === before.revision
        ) {
          protocols[participant] = {
            id: after.id,
            revision: after.revision,
          };
        }
      }
      (copy as { protocols: ExperimentDefinition['protocols'] }).protocols = protocols;
    }
  }
  return copy;
}

/** Preserve unfinished values on append and move their pointers with surviving rows on deletion. */
export function rebasePending(
  entries: Readonly<Record<string, string>>,
  draft: ExperimentDefinition,
  path: string,
  value: JsonValue | undefined,
): Record<string, string> {
  const before = valueAt(draft, path);
  if (
    Array.isArray(before) &&
    Array.isArray(value) &&
    value.length > before.length &&
    before.every((item, index) => JSON.stringify(item) === JSON.stringify(value[index]))
  )
    return { ...entries };
  const parentPath = path.slice(0, path.lastIndexOf('/'));
  const index = Number(path.slice(path.lastIndexOf('/') + 1));
  const deletingRow = value === undefined && Array.isArray(valueAt(draft, parentPath));
  const next: Record<string, string> = {};
  for (const [key, text] of Object.entries(entries)) {
    if (key === path || key.startsWith(`${path}/`)) continue;
    if (deletingRow && key.startsWith(`${parentPath}/`)) {
      const suffix = key.slice(parentPath.length + 1);
      const [row, ...rest] = suffix.split('/');
      if (Number(row) > index) {
        next[`${parentPath}/${Number(row) - 1}${rest.length ? `/${rest.join('/')}` : ''}`] = text;
        continue;
      }
    }
    next[key] = text;
  }
  return next;
}

/** Switch all participants to one compatible profile while preserving protocol and scenario edits. */
export function changeProfile(
  draft: ExperimentDefinition,
  layer: ProtocolDefinition['layer'],
  service: ProtocolDefinition['lowerService'],
): ExperimentDefinition {
  const lowerService = layer === 'transport' ? 'datagram' : service;
  const codec: ProtocolDefinition['codec'] =
    layer === 'transport'
      ? 'logical-packet'
      : lowerService === 'stream'
        ? 'json-lines'
        : 'json-datagram';
  const environment =
    draft.environment.kind === lowerService
      ? structuredClone(draft.environment)
      : createPingPongExperiment(codec).environment;
  const directions = environment.directions;
  for (const direction of ['AtoB', 'BtoA'] as const) {
    (directions[direction] as { delayMs: number }).delayMs =
      draft.environment.directions[direction].delayMs;
  }
  const definitions = draft.definitions.map((definition) => ({
    ...definition,
    layer,
    lowerService,
    codec: definition.codec === 'http-1.1' ? ('http-1.1' as const) : codec,
    revision: definition.revision + 1,
  }));
  return {
    ...draft,
    definitions,
    environment,
    protocols: Object.fromEntries(
      (['A', 'B'] as const).map((participant) => {
        const definition = definitions.find((item) => item.id === draft.protocols[participant].id);
        return [
          participant,
          definition
            ? { id: definition.id, revision: definition.revision }
            : draft.protocols[participant],
        ];
      }),
    ) as ExperimentDefinition['protocols'],
  };
}

/** Produce a blank authoring surface with a valid initial state and no hidden traffic. */
export function createBlankExperiment(): ExperimentDefinition {
  const starter = createPingPongExperiment();
  return {
    ...starter,
    id: 'custom_experiment',
    label: '새 실험',
    definitions: [
      {
        ...(starter.definitions[0] as ProtocolDefinition),
        label: '새 프로토콜',
        messages: [],
        states: [{ id: 'Idle', label: '대기' }],
        initialStateId: 'Idle',
        variables: [],
        timers: [],
        rules: [],
      },
    ],
    scenario: { ...starter.scenario, inputs: [], expectations: [] },
  };
}

/** Generate an unused stable identifier within one collection. */
export function nextId(items: readonly { readonly id: string }[], prefix: string): string {
  let index = 1;
  while (items.some((item) => item.id === `${prefix}_${index}`)) index++;
  return `${prefix}_${index}`;
}
