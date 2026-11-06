import type { JsonValue } from './execution-contract.ts';
import { httpSchemaDiagnostics } from './http-schema.ts';
import { freezeOwned } from './immutable-data.ts';
import { pointerToken } from './json-pointer.ts';
import {
  parseJsonData,
  parseProtocolDefinition,
  parseProtocolDefinitionDraft,
  Reader,
} from './model-validation.ts';
import type { ProtocolDefinition, ValidationResult } from './protocol-model.ts';
import { parseBytesValue } from './stack-bytes.ts';
import { checkStackExpression, type ExpressionTypes, stackValueType } from './stack-expressions.ts';
import {
  type LegacyStackApplication,
  type NativeStackProtocol,
  type ServicePort,
  STACK_POLICY,
  type StackCondition,
  type StackField,
  type StackMessage,
  type StackMessageDefinition,
  type StackProtocol,
  type StackProtocolBody,
  type StackService,
  type StackValueType,
} from './stack-model.ts';

const at = (path: string, key: string | number) => `${path}/${pointerToken(String(key))}`;
const has = (value: object, key: string) => Object.hasOwn(value, key);

function append(r: Reader, path: string, result: ValidationResult<unknown>): void {
  if (!result.success)
    for (const d of result.diagnostics)
      r.issue(`${path}${d.path === '/' ? '' : d.path}`, d.code, d.message);
}

function unique(items: readonly { readonly id: string }[], path: string, r: Reader): void {
  const ids = new Set<string>();
  items.forEach((item, index) => {
    if (ids.has(item.id)) r.issue(`${path}/${index}/id`, 'duplicate-id', 'Duplicate stable ID');
    ids.add(item.id);
  });
}

function fieldShape(value: unknown, path: string, r: Reader): void {
  const field = r.object(value, path);
  if (!field) return;
  const constraints =
    field.type === 'string'
      ? ['minLength', 'maxLength']
      : field.type === 'integer'
        ? ['min', 'max']
        : field.type === 'enum'
          ? ['options']
          : field.type === 'bytes'
            ? ['minBytes', 'maxBytes']
            : [];
  r.object(field, path, [
    'id',
    'name',
    'required',
    'placement',
    'type',
    'defaultValue',
    ...constraints,
  ]);
  r.text(field.id, `${path}/id`, true);
  r.text(field.name, `${path}/name`);
  r.choice(field.required, `${path}/required`, [true, false]);
  r.choice(field.placement, `${path}/placement`, ['header', 'body', 'payload']);
  r.choice(field.type, `${path}/type`, ['string', 'integer', 'boolean', 'enum', 'bytes']);
  for (const key of constraints.filter((key) => key !== 'options'))
    if (has(field, key))
      r.number(
        field[key],
        `${path}/${key}`,
        key === 'min' || key === 'max' ? Number.MIN_SAFE_INTEGER : 0,
        key.endsWith('Bytes') ? STACK_POLICY.maxMessageBytes : Number.MAX_SAFE_INTEGER,
      );
  if (field.type === 'enum')
    r.array(field.options, `${path}/options`, (item, location) => r.text(item, location), 1);
}

function messageShape(value: unknown, path: string, r: Reader): void {
  const message = r.object(value, path, ['id', 'label', 'fields', 'http']);
  if (!message) return;
  r.text(message.id, `${path}/id`, true);
  r.text(message.label, `${path}/label`);
  r.array(message.fields, `${path}/fields`, (item, location) => fieldShape(item, location, r));
  if (has(message, 'http')) {
    const mapping = r.object(message.http, `${path}/http`);
    if (!mapping) return;
    r.choice(mapping.kind, `${path}/http/kind`, ['request', 'response', 'raw']);
    const keys =
      mapping.kind === 'request'
        ? ['methodFieldId', 'targetFieldId', 'bodyFieldId']
        : mapping.kind === 'response'
          ? ['statusFieldId', 'reasonFieldId', 'bodyFieldId']
          : ['wireFieldId'];
    r.object(mapping, `${path}/http`, ['kind', ...keys]);
    for (const key of keys) r.text(mapping[key], `${path}/http/${key}`, true);
  }
}

function serviceShape(value: unknown, path: string, r: Reader): void {
  const service = r.object(value, path, ['kind', 'payload']);
  if (!service) return;
  r.choice(service.kind, `${path}/kind`, ['stream', 'datagram']);
  if (service.payload === 'bytes') return;
  if (service.kind === 'stream')
    r.issue(`${path}/payload`, 'service-type', 'Streams carry bytes only');
  const schema = r.object(service.payload, `${path}/payload`, ['id', 'revision', 'messages']);
  if (!schema) return;
  r.text(schema.id, `${path}/payload/id`, true);
  r.number(schema.revision, `${path}/payload/revision`, 1);
  r.array(
    schema.messages,
    `${path}/payload/messages`,
    (item, location) => messageShape(item, location, r),
    1,
  );
}

function portShape(value: unknown, path: string, r: Reader): void {
  const port = r.object(value, path, [
    'id',
    'role',
    'service',
    'request',
    'indication',
    'lifecycle',
  ]);
  if (!port) return;
  r.text(port.id, `${path}/id`, true);
  r.choice(port.role, `${path}/role`, ['requires', 'provides']);
  r.choice(port.request, `${path}/request`, ['write', 'send']);
  r.choice(port.indication, `${path}/indication`, ['read', 'receive']);
  serviceShape(port.service, `${path}/service`, r);
  const life = r.object(port.lifecycle, `${path}/lifecycle`, ['initial', 'notifications']);
  if (life) {
    r.choice(life.initial, `${path}/lifecycle/initial`, ['ready']);
    r.array(life.notifications, `${path}/lifecycle/notifications`, (item, location) =>
      r.choice(item, location, ['failed', 'closed']),
    );
  }
}

function conditionShape(value: unknown, path: string, r: Reader): void {
  const condition = r.object(value, path);
  if (!condition) return;
  if (condition.kind === 'compare') {
    r.object(condition, path, ['kind', 'operator', 'left', 'right'], ['left', 'right']);
    r.choice(condition.operator, `${path}/operator`, ['eq', 'ne', 'lt', 'lte', 'gt', 'gte']);
  } else if (condition.kind === 'not') {
    r.object(condition, path, ['kind', 'condition']);
    conditionShape(condition.condition, `${path}/condition`, r);
  } else if (condition.kind === 'all' || condition.kind === 'any') {
    r.object(condition, path, ['kind', 'conditions']);
    r.array(
      condition.conditions,
      `${path}/conditions`,
      (item, location) => conditionShape(item, location, r),
      1,
    );
  } else r.issue(`${path}/kind`, 'choice', 'Unsupported condition');
}

function ruleShape(value: unknown, path: string, r: Reader): void {
  const rule = r.object(value, path, [
    'id',
    'fromStateId',
    'event',
    'condition',
    'actions',
    'nextStateId',
    'ignore',
  ]);
  if (!rule) return;
  for (const key of ['id', 'fromStateId', 'nextStateId']) r.text(rule[key], `${path}/${key}`, true);
  if (has(rule, 'ignore')) r.choice(rule.ignore, `${path}/ignore`, [true, false]);
  const event = r.object(rule.event, `${path}/event`);
  if (event) {
    const kind = event.kind;
    if (kind === 'input' || kind === 'receive') {
      r.object(event, `${path}/event`, ['kind', 'messageId']);
      r.text(event.messageId, `${path}/event/messageId`, true);
    } else if (kind === 'timer') {
      r.object(event, `${path}/event`, ['kind', 'timerId']);
      r.text(event.timerId, `${path}/event/timerId`, true);
    } else if (kind === 'connection') {
      r.object(event, `${path}/event`, ['kind', 'state']);
      r.choice(event.state, `${path}/event/state`, ['failed', 'closed']);
    } else if (kind === 'service-request' || kind === 'service-indication') {
      r.object(event, `${path}/event`, ['kind', 'portId', 'operation']);
      r.text(event.portId, `${path}/event/portId`, true);
      r.choice(
        event.operation,
        `${path}/event/operation`,
        kind === 'service-request' ? ['write', 'send'] : ['read', 'receive', 'failed', 'closed'],
      );
    } else r.issue(`${path}/event/kind`, 'choice', 'Unsupported rule event');
  }
  if (has(rule, 'condition')) conditionShape(rule.condition, `${path}/condition`, r);
  r.array(rule.actions, `${path}/actions`, (value, location) => {
    const action = r.object(value, location);
    if (!action) return;
    switch (action.kind) {
      case 'send':
      case 'deliver':
        r.object(action, location, ['kind', 'messageId', 'values']);
        r.text(action.messageId, `${location}/messageId`, true);
        r.object(action.values, `${location}/values`);
        break;
      case 'assign':
        r.object(action, location, ['kind', 'variableId', 'value'], ['value']);
        r.text(action.variableId, `${location}/variableId`, true);
        break;
      case 'start-timer':
      case 'cancel-timer':
        r.object(
          action,
          location,
          action.kind === 'start-timer' ? ['kind', 'timerId', 'durationMs'] : ['kind', 'timerId'],
          action.kind === 'start-timer' ? ['durationMs'] : [],
        );
        r.text(action.timerId, `${location}/timerId`, true);
        break;
      case 'finish':
        r.object(action, location, ['kind', 'outcome']);
        r.choice(action.outcome, `${location}/outcome`, ['success', 'failure']);
        break;
      case 'service-indicate':
        r.object(
          action,
          location,
          [
            'kind',
            'portId',
            'operation',
            ...(action.operation === 'read' || action.operation === 'receive' ? ['payload'] : []),
          ],
          action.operation === 'read' || action.operation === 'receive' ? ['payload'] : [],
        );
        r.text(action.portId, `${location}/portId`, true);
        r.choice(action.operation, `${location}/operation`, [
          'read',
          'receive',
          'failed',
          'closed',
        ]);
        break;
      default:
        r.issue(`${location}/kind`, 'choice', 'Unsupported action');
    }
  });
}

function fieldValue(field: StackField, value: unknown, path: string, r: Reader): void {
  let valid = false;
  switch (field.type) {
    case 'bytes': {
      const parsed = parseBytesValue(value, field.maxBytes ?? STACK_POLICY.maxMessageBytes);
      append(r, path, parsed);
      if (parsed.success && parsed.value.byteLength < (field.minBytes ?? 0))
        r.issue(path, 'field-value', 'Byte value is shorter than minBytes');
      return;
    }
    case 'string':
      valid =
        typeof value === 'string' &&
        Array.from(value).length >= (field.minLength ?? 0) &&
        Array.from(value).length <= (field.maxLength ?? Number.MAX_SAFE_INTEGER);
      break;
    case 'integer':
      valid =
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= (field.min ?? Number.MIN_SAFE_INTEGER) &&
        value <= (field.max ?? Number.MAX_SAFE_INTEGER);
      break;
    case 'boolean':
      valid = typeof value === 'boolean';
      break;
    case 'enum':
      valid = typeof value === 'string' && field.options.includes(value);
      break;
  }
  if (!valid) r.issue(path, 'field-value', `Value does not satisfy field ${field.id}`);
}

function messageSemantics(
  messages: readonly StackMessageDefinition[],
  path: string,
  r: Reader,
): void {
  unique(messages, path, r);
  messages.forEach((message, index) => {
    const location = `${path}/${index}/fields`;
    unique(message.fields, location, r);
    const names = new Set<string>();
    message.fields.forEach((field, index) => {
      const p = `${location}/${index}`;
      if (names.has(field.name)) r.issue(`${p}/name`, 'duplicate-name', 'Duplicate wire name');
      names.add(field.name);
      const [min, max] =
        field.type === 'bytes'
          ? [field.minBytes ?? 0, field.maxBytes ?? STACK_POLICY.maxMessageBytes]
          : field.type === 'string'
            ? [field.minLength ?? 0, field.maxLength ?? Number.MAX_SAFE_INTEGER]
            : field.type === 'integer'
              ? [field.min ?? Number.MIN_SAFE_INTEGER, field.max ?? Number.MAX_SAFE_INTEGER]
              : [0, 0];
      if (min > max) r.issue(p, 'range-order', 'Minimum exceeds maximum');
      if (field.type === 'enum' && new Set(field.options).size !== field.options.length)
        r.issue(`${p}/options`, 'duplicate-option', 'Duplicate enum option');
      if (has(field, 'defaultValue')) fieldValue(field, field.defaultValue, `${p}/defaultValue`, r);
    });
  });
}

function portSemantics(
  port: ServicePort,
  role: ServicePort['role'],
  path: string,
  r: Reader,
): void {
  if (port.role !== role) r.issue(`${path}/role`, 'port-direction', `Expected ${role} port`);
  if (
    port.request !== (port.service.kind === 'stream' ? 'write' : 'send') ||
    port.indication !== (port.service.kind === 'stream' ? 'read' : 'receive')
  )
    r.issue(path, 'port-operation', 'Operations differ from the declared service');
  if (new Set(port.lifecycle.notifications).size !== port.lifecycle.notifications.length)
    r.issue(
      `${path}/lifecycle/notifications`,
      'duplicate-notification',
      'Duplicate lifecycle notification',
    );
  if (port.service.payload !== 'bytes')
    messageSemantics(port.service.payload.messages, `${path}/service/payload/messages`, r);
}

function typeOfField(field: StackField): StackValueType {
  return field.type === 'enum' ? 'string' : field.type;
}

function protocolSemantics(protocol: NativeStackProtocol, r: Reader): void {
  for (const key of ['messages', 'states', 'variables', 'timers', 'rules'] as const)
    unique(protocol[key], `/${key}`, r);
  messageSemantics(protocol.messages, '/messages', r);
  portSemantics(protocol.requires, 'requires', '/requires', r);
  if (protocol.provides) {
    portSemantics(protocol.provides, 'provides', '/provides', r);
    if (protocol.provides.id === protocol.requires.id)
      r.issue('/provides/id', 'duplicate-id', 'Port IDs must be distinct');
  }
  const wire = protocol.requires.service;
  const correct =
    protocol.codec === 'logical-packet'
      ? wire.kind === 'datagram' &&
        wire.payload !== 'bytes' &&
        sameWireMessages(protocol.messages, wire.payload.messages)
      : wire.payload === 'bytes' &&
        wire.kind === (protocol.codec === 'json-datagram' ? 'datagram' : 'stream');
  if (!correct)
    r.issue(
      '/requires/service',
      'codec-service',
      'Codec output differs from the required lower service',
    );
  if (
    protocol.codec !== 'logical-packet' &&
    protocol.messages.some((message) => message.fields.some((field) => field.type === 'bytes'))
  )
    r.issue(
      '/messages',
      'codec-bytes',
      'Existing byte codecs accept scalar fields; use explicit logical packet bytes',
    );
  r.diagnostics.push(...httpSchemaDiagnostics(protocol as unknown as ProtocolDefinition, ''));
  const states = new Map(protocol.states.map((state) => [state.id, state]));
  const messages = new Map(protocol.messages.map((message) => [message.id, message]));
  const variables = new Map(protocol.variables.map((variable) => [variable.id, variable]));
  const timers = new Set(protocol.timers.map((timer) => timer.id));
  const reference = (exists: boolean, path: string) => {
    if (!exists) r.issue(path, 'reference', 'Unknown reference');
  };
  reference(states.has(protocol.initialStateId), '/initialStateId');
  protocol.variables.forEach((variable, index) => {
    if (variable.type !== 'json' && stackValueType(variable.initial) !== variable.type)
      r.issue(
        `/variables/${index}/initial`,
        'variable-type',
        'Initial value differs from the declared type',
      );
    if (variable.type === 'bytes')
      append(r, `/variables/${index}/initial`, parseBytesValue(variable.initial));
    if (variable.type === 'json' && stackValueType(variable.initial) === 'bytes')
      r.issue(
        `/variables/${index}/initial`,
        'variable-type',
        'Bytes require an explicit bytes variable',
      );
  });
  protocol.rules.forEach((rule, index) => {
    const path = `/rules/${index}`;
    reference(states.has(rule.fromStateId), `${path}/fromStateId`);
    reference(states.has(rule.nextStateId), `${path}/nextStateId`);
    if (states.get(rule.fromStateId)?.terminal && !rule.ignore)
      r.issue(
        `${path}/fromStateId`,
        'terminal-state',
        'Terminal states only allow explicit ignore rules',
      );
    let fields: readonly StackField[] = [];
    let servicePayload: StackValueType | undefined;
    const event = rule.event;
    if (event.kind === 'input' || event.kind === 'receive') {
      const message = messages.get(event.messageId);
      reference(!!message, `${path}/event/messageId`);
      fields = message?.fields ?? [];
    } else if (event.kind === 'timer')
      reference(timers.has(event.timerId), `${path}/event/timerId`);
    else if (event.kind === 'connection') {
      if (!protocol.requires.lifecycle.notifications.includes(event.state))
        r.issue(`${path}/event/state`, 'port-operation', 'Undeclared lower lifecycle notification');
    } else if (event.kind === 'service-request' || event.kind === 'service-indication') {
      const port = event.kind === 'service-request' ? protocol.provides : protocol.requires;
      reference(port?.id === event.portId, `${path}/event/portId`);
      if (port) {
        const dataOperation = event.kind === 'service-request' ? port.request : port.indication;
        if (event.operation === dataOperation)
          servicePayload = port.service.payload === 'bytes' ? 'bytes' : 'json';
        else if (
          event.kind !== 'service-indication' ||
          !port.lifecycle.notifications.includes(event.operation as 'failed' | 'closed')
        )
          r.issue(
            `${path}/event/operation`,
            'port-operation',
            'Operation is not declared by this port',
          );
      }
    }
    const context: ExpressionTypes = {
      variables: Object.fromEntries(
        protocol.variables.map((variable) => [variable.id, variable.type]),
      ),
      fields: Object.fromEntries(fields.map((field) => [field.id, typeOfField(field)])),
      ...(servicePayload ? { servicePayload } : {}),
    };
    const expression = (value: unknown, location: string, expected?: StackValueType) => {
      const result = checkStackExpression(value, context);
      append(r, location, result);
      if (
        result.success &&
        expected &&
        result.value !== expected &&
        !(expected === 'json' && result.value !== 'bytes')
      )
        r.issue(location, 'expression-type', `Expected ${expected}, received ${result.value}`);
    };
    const condition = (value: StackCondition, location: string): void => {
      if (value.kind === 'compare') {
        const left = checkStackExpression(value.left, context);
        const right = checkStackExpression(value.right, context);
        append(r, `${location}/left`, left);
        append(r, `${location}/right`, right);
        if (
          left.success &&
          right.success &&
          (left.value !== right.value ||
            (!['eq', 'ne'].includes(value.operator) && !['integer', 'string'].includes(left.value)))
        )
          r.issue(location, 'condition-type', 'Comparison operands are incompatible');
      } else if (value.kind === 'not') condition(value.condition, `${location}/condition`);
      else
        value.conditions.forEach((child, i) => {
          condition(child, `${location}/conditions/${i}`);
        });
    };
    if (rule.condition) condition(rule.condition, `${path}/condition`);
    if (
      (rule.ignore && (rule.actions.length || rule.nextStateId !== rule.fromStateId)) ||
      (!rule.ignore && !rule.actions.length && rule.nextStateId === rule.fromStateId)
    )
      r.issue(path, 'ignore-rule', 'No-op rules must explicitly ignore and preserve state');
    rule.actions.forEach((action, index) => {
      const p = `${path}/actions/${index}`;
      switch (action.kind) {
        case 'assign': {
          const variable = variables.get(action.variableId);
          reference(!!variable, `${p}/variableId`);
          expression(action.value, `${p}/value`, variable?.type);
          break;
        }
        case 'send':
        case 'deliver': {
          const message = messages.get(action.messageId);
          reference(!!message, `${p}/messageId`);
          for (const [id, value] of Object.entries(action.values)) {
            const field = message?.fields.find((field) => field.id === id);
            reference(!!field, `${p}/values/${pointerToken(id)}`);
            expression(value, `${p}/values/${pointerToken(id)}`, field && typeOfField(field));
            if (field && value?.kind === 'literal')
              fieldValue(field, value.value, `${p}/values/${pointerToken(id)}`, r);
          }
          for (const field of message?.fields ?? [])
            if (field.required && !has(field, 'defaultValue') && !has(action.values, field.id))
              r.issue(
                `${p}/values/${pointerToken(field.id)}`,
                'required-field',
                'Required field expression is absent',
              );
          break;
        }
        case 'start-timer':
          reference(timers.has(action.timerId), `${p}/timerId`);
          expression(action.durationMs, `${p}/durationMs`, 'integer');
          if (action.durationMs?.kind === 'literal')
            r.number(action.durationMs.value, `${p}/durationMs/value`);
          break;
        case 'cancel-timer':
          reference(timers.has(action.timerId), `${p}/timerId`);
          break;
        case 'finish':
          if (!states.get(rule.nextStateId)?.terminal || index !== rule.actions.length - 1)
            r.issue(p, 'finish-action', 'Finish must be last and enter a terminal state');
          break;
        case 'service-indicate': {
          const port = protocol.provides;
          reference(port?.id === action.portId, `${p}/portId`);
          if (action.operation === 'read' || action.operation === 'receive') {
            if (port && action.operation !== port.indication)
              r.issue(`${p}/operation`, 'port-operation', 'Wrong service indication');
            expression(
              action.payload,
              `${p}/payload`,
              port?.service.payload === 'bytes' ? 'bytes' : 'json',
            );
            if (port && action.payload?.kind === 'literal')
              append(r, `${p}/payload`, validateServicePayload(port.service, action.payload.value));
          } else if (port && !port.lifecycle.notifications.includes(action.operation))
            r.issue(`${p}/operation`, 'port-operation', 'Undeclared lifecycle indication');
          break;
        }
      }
    });
    for (let previous = 0; previous < index; previous++) {
      const other = protocol.rules[previous];
      if (
        other &&
        other.fromStateId === rule.fromStateId &&
        canonical(other.event) === canonical(rule.event) &&
        (!other.condition ||
          !rule.condition ||
          canonical(other.condition) === canonical(rule.condition))
      )
        r.issue(path, 'rule-conflict', `Rule overlaps ${other.id}`);
    }
  });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? '';
}

/** Compare wire schemas by message IDs and wire names, independent of labels/local field IDs/order. */
export function sameWireMessages(
  left: readonly StackMessageDefinition[],
  right: readonly StackMessageDefinition[],
): boolean {
  const wire = (messages: readonly StackMessageDefinition[]) =>
    messages
      .map((message) => ({
        id: message.id,
        fields: message.fields
          .map((field) => {
            const { id: _id, ...rest } = field;
            return rest;
          })
          .sort((a, b) => a.name.localeCompare(b.name)),
        ...(message.http
          ? {
              http: Object.fromEntries(
                Object.entries(message.http).map(([key, value]) => [
                  key,
                  key === 'kind' ? value : message.fields.find((field) => field.id === value)?.name,
                ]),
              ),
            }
          : {}),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  return canonical(wire(left)) === canonical(wire(right));
}

/** Check the exact payload contract; a packet schema never silently converts to bytes. */
export function compatibleStackServices(left: StackService, right: StackService): boolean {
  if (left.kind !== right.kind) return false;
  if (left.payload === 'bytes' || right.payload === 'bytes') return left.payload === right.payload;
  return (
    left.payload.id === right.payload.id &&
    left.payload.revision === right.payload.revision &&
    sameWireMessages(left.payload.messages, right.payload.messages)
  );
}

/** Create an explicit, isolated, versioned requires-only adapter for a valid v1 application. */
export function adaptLegacyApplication(
  value: unknown,
  portId = 'lower',
): ValidationResult<LegacyStackApplication> {
  return adaptApplication(value, portId, true);
}

function adaptApplication(
  value: unknown,
  portId: string,
  executable: boolean,
): ValidationResult<LegacyStackApplication> {
  const parsed = executable ? parseProtocolDefinition(value) : parseProtocolDefinitionDraft(value);
  if (!parsed.success) return parsed;
  const r = new Reader(!executable);
  r.text(portId, '/requires/id', true);
  if (parsed.value.layer !== 'application' || parsed.value.codec === 'logical-packet')
    r.issue(
      '/source/layer',
      'legacy-provider',
      'A legacy transport has no provided service and cannot be adapted as an application',
    );
  if (r.diagnostics.length) return { success: false, diagnostics: r.diagnostics };
  const stream = parsed.value.lowerService === 'stream';
  return r.result(
    freezeOwned({
      schemaVersion: 2,
      mode: 'legacy-application',
      id: parsed.value.id,
      revision: parsed.value.revision,
      adapterVersion: STACK_POLICY.adapterVersion,
      source: structuredClone(parsed.value),
      requires: {
        id: portId,
        role: 'requires',
        service: { kind: parsed.value.lowerService, payload: 'bytes' },
        request: stream ? 'write' : 'send',
        indication: stream ? 'read' : 'receive',
        lifecycle: { initial: 'ready', notifications: ['failed', 'closed'] },
      },
    } as LegacyStackApplication),
  );
}

/** Parse native stack definitions or their explicit legacy application wrapper; v1 readers stay strict. */
export function parseStackProtocol(value: unknown): ValidationResult<StackProtocol> {
  return readProtocol(value, true);
}

/** Read unfinished native/legacy definitions for storage without admitting invalid rules to a snapshot. */
export function parseStackProtocolDraft(value: unknown): ValidationResult<StackProtocol> {
  return readProtocol(value, false);
}

function readProtocol(value: unknown, executable: boolean): ValidationResult<StackProtocol> {
  const json = parseJsonData(value);
  if (!json.success) return json;
  const r = new Reader(!executable);
  if (new TextEncoder().encode(JSON.stringify(value)).length > STACK_POLICY.maxArtifactBytes) {
    r.issue('/', 'model-size', 'Definition exceeds the JSON size limit');
    return { success: false, diagnostics: r.diagnostics };
  }
  const node = r.object(value, '');
  if (!node) return { success: false, diagnostics: r.diagnostics };
  r.choice(node.schemaVersion, '/schemaVersion', [2]);
  r.text(node.id, '/id', true);
  r.number(node.revision, '/revision', 1);
  portShape(node.requires, '/requires', r);
  if (node.mode === 'legacy-application') {
    r.object(node, '', [
      'schemaVersion',
      'mode',
      'id',
      'revision',
      'adapterVersion',
      'source',
      'requires',
    ]);
    r.choice(node.adapterVersion, '/adapterVersion', [STACK_POLICY.adapterVersion]);
    const source = adaptApplication(
      node.source,
      typeof (node.requires as ServicePort | undefined)?.id === 'string'
        ? (node.requires as ServicePort).id
        : 'lower',
      executable,
    );
    append(r, '/source', source);
    if (
      source.success &&
      (source.value.id !== node.id ||
        source.value.revision !== node.revision ||
        canonical(source.value.requires) !== canonical(node.requires))
    )
      r.issue(
        '/requires',
        'adapter-contract',
        'Adapter identity/port differs from its exact v1 source',
      );
    return r.result(value as LegacyStackApplication);
  }
  r.choice(node.mode, '/mode', ['stack-protocol']);
  r.object(node, '', [
    'schemaVersion',
    'mode',
    'id',
    'revision',
    'label',
    'layer',
    'codec',
    'requires',
    'provides',
    'messages',
    'states',
    'initialStateId',
    'variables',
    'timers',
    'rules',
  ]);
  r.text(node.label, '/label');
  r.choice(node.layer, '/layer', ['application', 'transport']);
  r.choice(node.codec, '/codec', ['json-lines', 'json-datagram', 'logical-packet', 'http-1.1']);
  if (has(node, 'provides')) portShape(node.provides, '/provides', r);
  r.array(node.messages, '/messages', (item, location) => messageShape(item, location, r), 1);
  r.array(
    node.states,
    '/states',
    (item, path) => {
      const state = r.object(item, path, ['id', 'label', 'terminal']);
      if (!state) return;
      r.text(state.id, `${path}/id`, true);
      r.text(state.label, `${path}/label`);
      if (has(state, 'terminal')) r.choice(state.terminal, `${path}/terminal`, [true, false]);
    },
    1,
  );
  r.text(node.initialStateId, '/initialStateId', true);
  r.array(node.variables, '/variables', (item, path) => {
    const variable = r.object(item, path, ['id', 'type', 'initial'], ['initial']);
    if (!variable) return;
    r.text(variable.id, `${path}/id`, true);
    r.choice(variable.type, `${path}/type`, ['string', 'integer', 'boolean', 'json', 'bytes']);
  });
  r.array(node.timers, '/timers', (item, path) => {
    const timer = r.object(item, path, ['id']);
    if (timer) r.text(timer.id, `${path}/id`, true);
  });
  r.array(node.rules, '/rules', (item, path) => ruleShape(item, path, r), 1);
  if (!r.diagnostics.length && executable) protocolSemantics(value as NativeStackProtocol, r);
  return r.result(value as NativeStackProtocol);
}

/** Validate message values/defaults against a trusted parsed body, without mutating its input. */
export function validateStackMessage(
  protocol: StackProtocolBody,
  value: unknown,
  maxBytes: number = STACK_POLICY.maxMessageBytes,
): ValidationResult<StackMessage> {
  const json = parseJsonData(value);
  if (!json.success) return json;
  const r = new Reader();
  const node = r.object(value, '', ['messageId', 'values']);
  r.number(maxBytes, '/limits/maxMessageBytes', 1, STACK_POLICY.maxMessageBytes);
  if (!node) return { success: false, diagnostics: r.diagnostics };
  r.text(node.messageId, '/messageId', true);
  const values = r.object(node.values, '/values');
  const message = protocol.messages.find((message) => message.id === node.messageId);
  if (!message) r.issue('/messageId', 'reference', 'Unknown message');
  if (!message || !values) return { success: false, diagnostics: r.diagnostics };
  const entries: [string, unknown][] = [];
  for (const key of Object.keys(values))
    if (!message.fields.some((field) => field.id === key))
      r.issue(at('/values', key), 'unknown-field', 'Unknown field ID');
  for (const field of message.fields) {
    const present = has(values, field.id);
    const fallback = has(field, 'defaultValue');
    if (!present && !fallback) {
      if (field.required)
        r.issue(at('/values', field.id), 'required-field', 'Required field is absent');
      continue;
    }
    const item = present ? values[field.id] : field.defaultValue;
    fieldValue(field, item, at('/values', field.id), r);
    entries.push([field.id, item]);
  }
  const result = { messageId: message.id, values: Object.fromEntries(entries) } as StackMessage;
  if (new TextEncoder().encode(JSON.stringify(result)).length > maxBytes)
    r.issue('/', 'message-size', 'Serialized values exceed the limit');
  return r.diagnostics.length
    ? { success: false, diagnostics: r.diagnostics }
    : r.result(freezeOwned(structuredClone(result)));
}

/** Validate an actual service payload by its declared bytes or logical wire-packet schema. */
export function validateServicePayload(
  service: StackService,
  value: unknown,
  maxBytes: number = STACK_POLICY.maxMessageBytes,
): ValidationResult<JsonValue> {
  const limitReader = new Reader();
  limitReader.number(maxBytes, '/limits/maxMessageBytes', 1, STACK_POLICY.maxMessageBytes);
  if (limitReader.diagnostics.length)
    return { success: false, diagnostics: limitReader.diagnostics };
  if (service.payload === 'bytes') return parseBytesValue(value, maxBytes);
  const json = parseJsonData(value);
  if (!json.success) return json;
  const r = new Reader();
  const node = r.object(value, '', ['messageId', 'fields']);
  if (!node) return { success: false, diagnostics: r.diagnostics };
  const message = service.payload.messages.find((message) => message.id === node.messageId);
  const fields = r.object(node.fields, '/fields');
  if (!message) r.issue('/messageId', 'reference', 'Unknown wire message');
  if (!message || !fields) return { success: false, diagnostics: r.diagnostics };
  for (const name of Object.keys(fields))
    if (!message.fields.some((field) => field.name === name))
      r.issue(at('/fields', name), 'unknown-field', 'Unknown wire name');
  for (const field of message.fields) {
    if (has(fields, field.name))
      fieldValue(field, fields[field.name], at('/fields', field.name), r);
    else if (field.required && !has(field, 'defaultValue'))
      r.issue(at('/fields', field.name), 'required-field', 'Required wire field is absent');
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > maxBytes)
    r.issue('/', 'message-size', 'Logical payload exceeds the JSON limit');
  return r.diagnostics.length
    ? { success: false, diagnostics: r.diagnostics }
    : r.result(freezeOwned(structuredClone(value as JsonValue)));
}

/** Read a trusted definition's optional provider without inferring one from its layer or state. */
export function providedStackPort(protocol: StackProtocol): ServicePort | undefined {
  return protocol.mode === 'stack-protocol' ? protocol.provides : undefined;
}
