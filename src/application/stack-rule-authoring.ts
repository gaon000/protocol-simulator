import type { JsonValue } from '../domain/execution-contract.ts';
import { valueAt } from '../domain/json-pointer.ts';
import { pointerToken } from '../domain/json-pointer.ts';
import { stackObject } from '../domain/stack-record.ts';
import type {
  StackAction,
  StackCondition,
  StackExpression,
  StackProtocol,
  StackRule,
  StackRuleEvent,
  StackValueType,
} from '../domain/stack-model.ts';
import { stackProtocolBody } from '../domain/stack-model.ts';
import type { StackDraft } from '../domain/workspace-v2-model.ts';
import { serializeBytes } from '../domain/stack-bytes.ts';
import { editStackExperiment } from './edit-stack.ts';

export const RULE_FORM_POLICY = {
  nodes: 48,
  depth: 6,
  pageSize: 10,
  choices: 20,
  jsonChars: 16384,
  hexChars: 8192,
} as const;
export type RuleListEdit =
  | { readonly kind: 'add'; readonly value: JsonValue }
  | { readonly kind: 'move'; readonly from: number; readonly to: number }
  | { readonly kind: 'duplicate'; readonly index: number }
  | { readonly kind: 'remove'; readonly index: number };
export type RuleValueContext = ReturnType<typeof stackRuleValueContext>;

/** Reveal the list pages containing a diagnostic path without changing the authored tree. */
export function ruleFormFocusPages(
  configuration: unknown,
  path: string | undefined,
): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  if (!path) return result;
  const parts = path.split('/').slice(1);
  for (let i = 0; i < parts.length; i++) {
    const parent = `/${parts.slice(0, i).join('/')}`;
    const value = valueAt(configuration, parent);
    const part = parts[i] ?? '';
    if (Array.isArray(value) && /^\d+$/.test(part)) result[parent] = Math.floor(Number(part) / 10);
    else if (parent.endsWith('/values') && value && typeof value === 'object') {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      const index = Object.keys(value).indexOf(key);
      if (index >= 0) result[parent] = Math.floor(index / 10);
    }
  }
  return result;
}

/** Derive reference scope from the exact editable definition and event, without rewriting unavailable references. */
export function stackRuleValueContext(protocol: StackProtocol, rule: StackRule) {
  const body = stackProtocolBody(protocol);
  const event = rule.event;
  const fields =
    event.kind === 'input' || event.kind === 'receive'
      ? (body.messages.find((m) => m.id === event.messageId)?.fields ?? [])
      : [];
  const port =
    protocol.mode === 'stack-protocol' && rule.event.kind === 'service-request'
      ? protocol.provides
      : protocol.requires;
  const payload =
    protocol.mode === 'stack-protocol' &&
    ((rule.event.kind === 'service-request' && rule.event.operation === port?.request) ||
      (rule.event.kind === 'service-indication' && rule.event.operation === port?.indication))
      ? port?.service.payload === 'bytes'
        ? ('bytes' as const)
        : ('json' as const)
      : undefined;
  return {
    native: protocol.mode === 'stack-protocol',
    body,
    fields,
    variables: body.variables,
    port,
    payload,
  };
}

/** Precompute a deterministic bounded tree before rendering; React re-renders never consume a shared mutable budget. */
export function ruleFormTreePaths(
  rule: StackRule,
  actionIndex: number,
  path: string,
  pages: Readonly<Record<string, number>>,
): ReadonlySet<string> {
  const result = new Set<string>();
  const page = (values: readonly unknown[], where: string) => {
    const count = Math.max(1, Math.ceil(values.length / 10));
    const index = Math.max(0, Math.min(pages[where] ?? 0, count - 1));
    return values
      .slice(index * 10, index * 10 + 10)
      .map((value, i) => ({ value, index: index * 10 + i }));
  };
  function visit(value: unknown, where: string, depth: number, condition = false) {
    if (result.size >= RULE_FORM_POLICY.nodes || depth >= RULE_FORM_POLICY.depth) return;
    result.add(where);
    const node = stackObject(value);
    const child = (key: string, isCondition = false) =>
      visit(node[key], `${where}/${key}`, depth + 1, isCondition);
    if (
      node.kind === 'literal' ||
      node.kind === 'variable' ||
      node.kind === 'field' ||
      node.kind === 'service-payload'
    )
      return;
    if (node.kind === 'compare' || node.kind === 'add' || node.kind === 'subtract') {
      child('left');
      child('right');
    } else if (node.kind === 'not') child('condition', true);
    else if (node.kind === 'byteLength') child('value');
    else if (node.kind === 'slice') {
      child('value');
      child('offset');
      child('length');
    } else {
      const key =
        condition && (node.kind === 'all' || node.kind === 'any')
          ? 'conditions'
          : node.kind === 'concat'
            ? 'values'
            : undefined;
      const items = key ? node[key] : undefined;
      if (key && Array.isArray(items))
        for (const item of page(items, `${where}/${key}`))
          visit(item.value, `${where}/${key}/${item.index}`, depth + 1, condition);
    }
  }
  if (rule.condition) visit(rule.condition, `${path}/condition`, 0, true);
  const action = stackObject(rule.actions[actionIndex]);
  const base = `${path}/actions/${actionIndex}`;
  for (const key of ['value', 'durationMs', 'payload'])
    if (Object.hasOwn(action, key)) visit(action[key], `${base}/${key}`, 0);
  const values = stackObject(action.values);
  for (const item of page(Object.keys(values), `${base}/values`))
    visit(values[String(item.value)], `${base}/values/${pointerToken(String(item.value))}`, 0);
  return result;
}

/** Supply a bounded literal default; bytes remain explicit tagged values and JSON defaults to null. */
export function ruleLiteral(type: StackValueType): JsonValue {
  return type === 'bytes'
    ? serializeBytes(new Uint8Array())
    : type === 'string'
      ? ''
      : type === 'boolean'
        ? false
        : type === 'json'
          ? null
          : 0;
}

/** Build one selected expression kind, retaining compatible arithmetic children and literal values. */
export function ruleExpression(
  kind: StackExpression['kind'],
  context: RuleValueContext,
  type: StackValueType = 'integer',
  old?: StackExpression,
): StackExpression {
  if (old?.kind === kind) return old;
  const literal = (): StackExpression => ({ kind: 'literal', value: ruleLiteral(type) });
  if (kind === 'literal') return literal();
  if (kind === 'variable')
    return {
      kind,
      variableId:
        context.variables.find((v) => v.type === type)?.id ?? context.variables[0]?.id ?? '',
    };
  if (kind === 'field')
    return {
      kind,
      fieldId: context.fields.find((f) => f.type === type)?.id ?? context.fields[0]?.id ?? '',
    };
  if (kind === 'service-payload') return { kind };
  if (kind === 'add' || kind === 'subtract')
    return {
      kind,
      left: old?.kind === 'add' || old?.kind === 'subtract' ? old.left : literal(),
      right: old?.kind === 'add' || old?.kind === 'subtract' ? old.right : literal(),
    };
  const bytes = (): StackExpression => ({ kind: 'literal', value: ruleLiteral('bytes') });
  if (kind === 'byteLength') return { kind, value: bytes() };
  if (kind === 'slice')
    return {
      kind,
      value: bytes(),
      offset: { kind: 'literal', value: 0 },
      length: { kind: 'literal', value: 0 },
    };
  return { kind: 'concat', values: [bytes()] };
}

/** Wrap existing conditions for boolean groups; replacing a comparison is an explicit local edit. */
export function ruleCondition(kind: StackCondition['kind'], old?: StackCondition): StackCondition {
  if (old?.kind === kind) return old;
  const compare: StackCondition = {
    kind: 'compare',
    operator: 'eq',
    left: { kind: 'literal', value: 0 },
    right: { kind: 'literal', value: 0 },
  };
  if (kind === 'compare') return compare;
  if (kind === 'not') return { kind, condition: old ?? compare };
  return {
    kind,
    conditions: old?.kind === 'all' || old?.kind === 'any' ? old.conditions : [old ?? compare],
  };
}

/** Create only the event shape selected by the author; execution validation remains authoritative. */
export function ruleEvent(kind: StackRuleEvent['kind'], protocol: StackProtocol): StackRuleEvent {
  const body = stackProtocolBody(protocol);
  if (kind === 'input' || kind === 'receive')
    return { kind, messageId: body.messages[0]?.id ?? '' };
  if (kind === 'timer') return { kind, timerId: body.timers[0]?.id ?? '' };
  if (kind === 'connection')
    return { kind, state: protocol.requires.lifecycle.notifications[0] ?? 'failed' };
  const port =
    kind === 'service-request' && protocol.mode === 'stack-protocol'
      ? protocol.provides
      : protocol.requires;
  return kind === 'service-request'
    ? { kind, portId: port?.id ?? '', operation: port?.request ?? 'write' }
    : { kind, portId: port?.id ?? '', operation: port?.indication ?? 'read' };
}

/** Create one action using declared identities/defaults; switching message actions preserves existing field expressions. */
export function ruleAction(
  kind: StackAction['kind'],
  protocol: StackProtocol,
  context: RuleValueContext,
  old?: StackAction,
): StackAction {
  if (old?.kind === kind) return old;
  if (kind === 'send' || kind === 'deliver') {
    if (old?.kind === 'send' || old?.kind === 'deliver') return { ...old, kind };
    const message = context.body.messages[0];
    return {
      kind,
      messageId: message?.id ?? '',
      values: Object.fromEntries(
        (message?.fields ?? [])
          .filter((f) => f.required && f.defaultValue === undefined)
          .map((f) => [
            f.id,
            { kind: 'literal', value: ruleLiteral(f.type === 'enum' ? 'string' : f.type) },
          ]),
      ),
    };
  }
  if (kind === 'assign') {
    const variable = context.variables[0];
    return {
      kind,
      variableId: variable?.id ?? '',
      value: { kind: 'literal', value: ruleLiteral(variable?.type ?? 'integer') },
    };
  }
  if (kind === 'start-timer')
    return {
      kind,
      timerId: old?.kind === 'cancel-timer' ? old.timerId : (context.body.timers[0]?.id ?? ''),
      durationMs: { kind: 'literal', value: 100 },
    };
  if (kind === 'cancel-timer')
    return {
      kind,
      timerId: old?.kind === 'start-timer' ? old.timerId : (context.body.timers[0]?.id ?? ''),
    };
  if (kind === 'finish') return { kind, outcome: 'success' };
  const port = protocol.mode === 'stack-protocol' ? protocol.provides : undefined;
  return {
    kind: 'service-indicate',
    portId: port?.id ?? '',
    operation: port?.indication ?? 'read',
    payload: {
      kind: 'literal',
      value: ruleLiteral(port?.service.payload === 'bytes' ? 'bytes' : 'json'),
    },
  };
}

/** Find pending text at or above a form boundary, leaving descendant editors free to repair their own values. */
export function blockingRuleRaw(
  raw: Readonly<Record<string, string>>,
  path: string,
): string | undefined {
  return Object.keys(raw)
    .filter((key) => key === path || path.startsWith(`${key}/`))
    .sort((a, b) => a.length - b.length)[0];
}

/** Apply a list change and remap pending child JSON atomically, with one exact definition/draft revision. */
export function editStackRuleList(
  draft: StackDraft,
  path: string,
  operation: RuleListEdit,
  now = Date.now(),
): StackDraft {
  if (
    !/^\/definitions\/\d+\/(?:source\/)?rules\/\d+\//.test(path) ||
    blockingRuleRaw(draft.raw, path)
  )
    return draft;
  const original = valueAt(draft.configuration, path);
  if (!Array.isArray(original)) return draft;
  const entries = original.map((value, index) => ({
    value: value as JsonValue,
    from: index as number | undefined,
  }));
  const valid = (i: number) => Number.isSafeInteger(i) && i >= 0 && i < entries.length;
  if (operation.kind === 'add')
    entries.push({ value: structuredClone(operation.value), from: undefined });
  else if (operation.kind === 'move') {
    if (!valid(operation.from) || !valid(operation.to) || operation.from === operation.to)
      return draft;
    const item = entries.splice(operation.from, 1)[0];
    if (item) entries.splice(operation.to, 0, item);
  } else {
    if (!valid(operation.index)) return draft;
    if (operation.kind === 'remove') entries.splice(operation.index, 1);
    else {
      const entry = entries[operation.index];
      if (entry)
        entries.splice(operation.index + 1, 0, {
          value: structuredClone(entry.value),
          from: entry.from,
        });
    }
  }
  const raw: Record<string, string> = {};
  for (const [key, text] of Object.entries(draft.raw)) {
    if (!key.startsWith(`${path}/`)) {
      raw[key] = text;
      continue;
    }
    const tail = key.slice(path.length + 1);
    const separator = tail.indexOf('/');
    const token = separator < 0 ? tail : tail.slice(0, separator);
    if (!/^\d+$/.test(token)) {
      raw[key] = text;
      continue;
    }
    entries.forEach((entry, index) => {
      if (entry.from === Number(token))
        raw[`${path}/${index}${separator < 0 ? '' : tail.slice(separator)}`] = text;
    });
  }
  return {
    ...draft,
    configuration: editStackExperiment(
      draft.configuration,
      path,
      entries.map((entry) => entry.value),
    ),
    raw,
    version: draft.version + 1,
    updatedAt: now,
  };
}
