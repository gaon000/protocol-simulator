import type { JsonValue } from '../domain/execution-contract.ts';
import { valueAt } from '../domain/json-pointer.ts';
import type { StackExperiment, StackProtocol } from '../domain/stack-model.ts';

/** Copy a stack form edit and rebind exact definition revisions while keeping historical snapshots untouched. */
export function editStackExperiment(
  input: StackExperiment,
  path: string,
  value: JsonValue | undefined,
): StackExperiment {
  const result = structuredClone(input);
  const parts = path
    .split('/')
    .slice(1)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  const key = parts.pop();
  if (key === undefined) return result;
  let parent: unknown = result;
  for (const part of parts) {
    if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, part)) return input;
    parent = (parent as Record<string, unknown>)[part];
  }
  if (!parent || typeof parent !== 'object') return input;
  if (value === undefined) {
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else delete (parent as Record<string, unknown>)[key];
  } else
    Object.defineProperty(parent, key, {
      value: structuredClone(value),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  const match = /^\/definitions\/(\d+)(?:\/|$)/.exec(path);
  if (match) {
    const before = input.definitions[Number(match[1])];
    const after = result.definitions[Number(match[1])];
    if (before && after) {
      const revised = after as { id: string; revision: number };
      revised.revision = before.revision + 1;
      if (after.mode === 'legacy-application') {
        if (path.endsWith('/source/id')) revised.id = after.source.id;
        Object.assign(after.source, { id: revised.id, revision: revised.revision });
      }
      for (const node of Object.values(result.nodes))
        for (const instance of node.instances)
          if (
            instance.definition.id === before.id &&
            instance.definition.revision === before.revision
          )
            Object.assign(instance.definition, { id: revised.id, revision: revised.revision });
    }
  }
  const renamed = /^\/nodes\/([AB])\/instances\/(\d+)\/id$/.exec(path);
  if (renamed && typeof value === 'string') {
    const participant = renamed[1] as 'A' | 'B';
    const before = input.nodes[participant].instances[Number(renamed[2])]?.id;
    if (
      before !== undefined &&
      input.nodes[participant].instances.filter((i) => i.id === before).length === 1
    ) {
      const update = (endpoint: { participant: string; instanceId: string }) => {
        if (endpoint.participant === participant && endpoint.instanceId === before)
          endpoint.instanceId = value;
      };
      for (const binding of result.bindings) {
        update(binding.consumer);
        update(binding.provider);
      }
      update(result.link.A);
      update(result.link.B);
      for (const item of [...result.scenario.inputs, ...result.scenario.expectations])
        update(item.target);
    }
  }
  return result;
}

/** Apply an explicit packet-schema synchronization to both peers sharing the selected service identity. */
export function synchronizeStackMessages(
  input: StackExperiment,
  selected: StackProtocol,
): StackExperiment {
  const service = selected.requires.service;
  if (service.payload === 'bytes' || selected.mode !== 'stack-protocol') return input;
  const payload = service.payload;
  let next = input;
  input.definitions.forEach((definition, index) => {
    const other = definition.requires.service;
    if (
      definition.mode !== 'stack-protocol' ||
      other.payload === 'bytes' ||
      other.payload.id !== payload.id ||
      other.payload.revision !== payload.revision
    )
      return;
    next = editStackExperiment(
      next,
      `/definitions/${index}/messages`,
      selected.messages as unknown as JsonValue,
    );
    next = editStackExperiment(
      next,
      `/definitions/${index}/requires/service/payload/messages`,
      selected.messages as unknown as JsonValue,
    );
  });
  return next;
}

/** Preserve only pending editors whose paths still exist after a structural form edit. */
export function retainedStackRaw(
  raw: Readonly<Record<string, string>>,
  configuration: StackExperiment,
  editedPath: string,
  removed = false,
) {
  const parent = editedPath.slice(0, editedPath.lastIndexOf('/'));
  const structuralArray =
    removed &&
    /^\d+$/.test(editedPath.slice(editedPath.lastIndexOf('/') + 1)) &&
    Array.isArray(valueAt(configuration, parent));
  return Object.fromEntries(
    Object.entries(raw).filter(
      ([path]) =>
        (!structuralArray || !path.startsWith(`${parent}/`)) &&
        path !== editedPath &&
        !path.startsWith(`${editedPath}/`) &&
        valueAt(configuration, path) !== undefined,
    ),
  );
}
