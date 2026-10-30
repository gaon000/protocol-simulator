import { createRunSnapshot, EXECUTION_POLICY, type JsonValue } from './execution-contract.ts';
import type {
  Condition,
  ExperimentDefinition,
  ExperimentSnapshot,
  FieldDefinition,
  ModelDiagnostic,
  ProtocolDefinition,
  ProtocolMessage,
  RuleDefinition,
  ValidationResult,
  ValueExpression,
} from './protocol-model.ts';

type ObjectValue = Record<string, unknown>;
type ValueType = 'string' | 'integer' | 'boolean' | 'json';
const has = (value: object, key: string) => Object.hasOwn(value, key);
const pointer = (path: string, key: string | number) =>
  `${path}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;

class Reader {
  readonly diagnostics: ModelDiagnostic[] = [];
  issue(path: string, code: string, message: string): void {
    this.diagnostics.push({ path: path || '/', code, message });
  }
  object(
    value: unknown,
    path: string,
    allowed?: readonly string[],
    required: readonly string[] = [],
  ): ObjectValue | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      this.issue(path, 'object', 'Expected an object');
      return;
    }
    const result = value as ObjectValue;
    if (allowed)
      for (const key of Object.keys(result)) {
        if (!allowed.includes(key))
          this.issue(pointer(path, key), 'unknown-property', 'Unsupported property');
      }
    for (const key of required)
      if (!has(result, key))
        this.issue(pointer(path, key), 'required', 'Required property is absent');
    return result;
  }
  array(
    value: unknown,
    path: string,
    inspect: (item: unknown, path: string) => void,
    minimum = 0,
  ): void {
    if (!Array.isArray(value)) {
      this.issue(path, 'array', 'Expected an array');
      return;
    }
    if (value.length < minimum) this.issue(path, 'empty', `At least ${minimum} item(s) required`);
    value.forEach((item, index) => {
      inspect(item, pointer(path, index));
    });
  }
  text(value: unknown, path: string, identifier = false): void {
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      (identifier && !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value))
    ) {
      this.issue(
        path,
        identifier ? 'identifier' : 'string',
        identifier ? 'Expected a stable ASCII identifier' : 'Expected nonempty text',
      );
    }
  }
  number(
    value: unknown,
    path: string,
    minimum = 0,
    maximum = Number.MAX_SAFE_INTEGER,
    integer = true,
  ): void {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (integer && !Number.isSafeInteger(value)) ||
      value < minimum ||
      value > maximum
    ) {
      this.issue(
        path,
        'number-range',
        `Expected ${integer ? 'an integer' : 'a number'} in [${minimum}, ${maximum}]`,
      );
    }
  }
  choice(value: unknown, path: string, options: readonly unknown[]): void {
    if (!options.includes(value))
      this.issue(path, 'choice', `Expected one of ${options.join(', ')}`);
  }
  result<Value>(value: Value): ValidationResult<Value> {
    return this.diagnostics.length
      ? { success: false, diagnostics: this.diagnostics }
      : { success: true, value };
  }
}

function inspectJson(value: unknown, reader: Reader): void {
  const ancestors = new Set<object>();
  let count = 0;
  function visit(item: unknown, path: string, depth: number): void {
    count++;
    if (count > 100_000) {
      if (count === 100_001) reader.issue(path, 'json-limit', 'JSON node limit exceeded');
      return;
    }
    if (depth > 64) {
      reader.issue(path, 'json-depth', 'JSON depth limit exceeded');
      return;
    }
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || item === null) {
      reader.issue(path, 'json-value', 'Expected finite JSON data');
      return;
    }
    if (ancestors.has(item)) {
      reader.issue(path, 'json-cycle', 'Cyclic data is not JSON');
      return;
    }
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    ) {
      reader.issue(path, 'json-object', 'Expected a plain JSON object');
      return;
    }
    ancestors.add(item);
    if (Reflect.ownKeys(item).some((key) => typeof key === 'symbol')) {
      reader.issue(path, 'json-property', 'JSON cannot contain symbol properties');
    }
    if (Array.isArray(item)) {
      for (const key of Object.keys(item))
        if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)
          reader.issue(
            pointer(path, key),
            'json-property',
            'Array properties must be indexed items',
          );
      for (let index = 0; index < item.length && count <= 100_000; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, index);
        if (!descriptor || !('value' in descriptor))
          reader.issue(
            pointer(path, index),
            'json-value',
            'JSON arrays require plain values without holes or accessors',
          );
        else visit(descriptor.value, pointer(path, index), depth + 1);
      }
    } else {
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
        if (!('value' in descriptor))
          reader.issue(pointer(path, key), 'json-accessor', 'JSON cannot contain accessors');
        else if (!descriptor.enumerable)
          reader.issue(pointer(path, key), 'json-property', 'JSON properties must be enumerable');
        else visit(descriptor.value, pointer(path, key), depth + 1);
        if (count > 100_000) break;
      }
    }
    ancestors.delete(item);
  }
  visit(value, '', 0);
}

/** Reject non-JSON graphs before inspecting external logical packets or definitions. */
export function parseJsonData(value: unknown): ValidationResult<JsonValue> {
  const reader = new Reader();
  inspectJson(value, reader);
  return reader.result(value as JsonValue);
}

function inspectExpression(value: unknown, path: string, r: Reader): void {
  const node = r.object(value, path);
  if (!node) return;
  switch (node.kind) {
    case 'literal':
      r.object(node, path, ['kind', 'value'], ['value']);
      break;
    case 'variable':
      r.object(node, path, ['kind', 'variableId']);
      r.text(node.variableId, pointer(path, 'variableId'), true);
      break;
    case 'field':
      r.object(node, path, ['kind', 'fieldId']);
      r.text(node.fieldId, pointer(path, 'fieldId'), true);
      break;
    case 'add':
    case 'subtract':
      r.object(node, path, ['kind', 'left', 'right']);
      inspectExpression(node.left, pointer(path, 'left'), r);
      inspectExpression(node.right, pointer(path, 'right'), r);
      break;
    default:
      r.issue(pointer(path, 'kind'), 'choice', 'Unsupported expression');
  }
}

function inspectCondition(value: unknown, path: string, r: Reader): void {
  const node = r.object(value, path);
  if (!node) return;
  switch (node.kind) {
    case 'compare':
      r.object(node, path, ['kind', 'operator', 'left', 'right']);
      r.choice(node.operator, pointer(path, 'operator'), ['eq', 'ne', 'lt', 'lte', 'gt', 'gte']);
      inspectExpression(node.left, pointer(path, 'left'), r);
      inspectExpression(node.right, pointer(path, 'right'), r);
      break;
    case 'all':
    case 'any':
      r.object(node, path, ['kind', 'conditions']);
      r.array(
        node.conditions,
        pointer(path, 'conditions'),
        (item, location) => inspectCondition(item, location, r),
        1,
      );
      break;
    case 'not':
      r.object(node, path, ['kind', 'condition']);
      inspectCondition(node.condition, pointer(path, 'condition'), r);
      break;
    default:
      r.issue(pointer(path, 'kind'), 'choice', 'Unsupported condition');
  }
}

function inspectMessage(value: unknown, path: string, r: Reader): void {
  const node = r.object(value, path, ['messageId', 'values']);
  if (!node) return;
  r.text(node.messageId, pointer(path, 'messageId'), true);
  r.object(node.values, pointer(path, 'values'));
}

function inspectProtocol(value: unknown, path: string, r: Reader): void {
  const protocol = r.object(value, path, [
    'schemaVersion',
    'id',
    'revision',
    'label',
    'layer',
    'lowerService',
    'codec',
    'messages',
    'states',
    'initialStateId',
    'variables',
    'timers',
    'rules',
  ]);
  if (!protocol) return;
  r.choice(protocol.schemaVersion, pointer(path, 'schemaVersion'), [1]);
  r.text(protocol.id, pointer(path, 'id'), true);
  r.text(protocol.label, pointer(path, 'label'));
  r.number(protocol.revision, pointer(path, 'revision'), 1);
  r.choice(protocol.layer, pointer(path, 'layer'), ['application', 'transport']);
  r.choice(protocol.lowerService, pointer(path, 'lowerService'), ['stream', 'datagram']);
  r.choice(protocol.codec, pointer(path, 'codec'), [
    'json-lines',
    'json-datagram',
    'logical-packet',
  ]);
  r.text(protocol.initialStateId, pointer(path, 'initialStateId'), true);
  r.array(
    protocol.messages,
    pointer(path, 'messages'),
    (value, location) => {
      const message = r.object(value, location, ['id', 'label', 'fields']);
      if (!message) return;
      r.text(message.id, pointer(location, 'id'), true);
      r.text(message.label, pointer(location, 'label'));
      r.array(message.fields, pointer(location, 'fields'), (value, fieldPath) => {
        const field = r.object(value, fieldPath);
        if (!field) return;
        const base = ['id', 'name', 'required', 'placement', 'type', 'defaultValue'];
        const constraints =
          field.type === 'string'
            ? ['minLength', 'maxLength']
            : field.type === 'integer'
              ? ['min', 'max']
              : field.type === 'enum'
                ? ['options']
                : [];
        r.object(field, fieldPath, [...base, ...constraints]);
        r.text(field.id, pointer(fieldPath, 'id'), true);
        r.text(field.name, pointer(fieldPath, 'name'));
        r.choice(field.required, pointer(fieldPath, 'required'), [true, false]);
        r.choice(field.placement, pointer(fieldPath, 'placement'), ['header', 'body', 'payload']);
        r.choice(field.type, pointer(fieldPath, 'type'), ['string', 'integer', 'boolean', 'enum']);
        for (const key of constraints.filter((key) => key !== 'options'))
          if (has(field, key))
            r.number(
              field[key],
              pointer(fieldPath, key),
              key === 'min' || key === 'max' ? Number.MIN_SAFE_INTEGER : 0,
            );
        if (field.type === 'enum')
          r.array(
            field.options,
            pointer(fieldPath, 'options'),
            (option, optionPath) => {
              if (typeof option !== 'string')
                r.issue(optionPath, 'string', 'Expected an enum string');
            },
            1,
          );
      });
    },
    1,
  );
  r.array(
    protocol.states,
    pointer(path, 'states'),
    (value, location) => {
      const state = r.object(value, location, ['id', 'label', 'terminal']);
      if (!state) return;
      r.text(state.id, pointer(location, 'id'), true);
      r.text(state.label, pointer(location, 'label'));
      if (has(state, 'terminal'))
        r.choice(state.terminal, pointer(location, 'terminal'), [true, false]);
    },
    1,
  );
  r.array(protocol.variables, pointer(path, 'variables'), (value, location) => {
    const variable = r.object(value, location, ['id', 'type', 'initial'], ['initial']);
    if (!variable) return;
    r.text(variable.id, pointer(location, 'id'), true);
    r.choice(variable.type, pointer(location, 'type'), ['string', 'integer', 'boolean', 'json']);
  });
  r.array(protocol.timers, pointer(path, 'timers'), (value, location) => {
    const timer = r.object(value, location, ['id']);
    if (timer) r.text(timer.id, pointer(location, 'id'), true);
  });
  r.array(protocol.rules, pointer(path, 'rules'), (value, location) => {
    const rule = r.object(value, location, [
      'id',
      'fromStateId',
      'event',
      'condition',
      'actions',
      'nextStateId',
      'ignore',
    ]);
    if (!rule) return;
    for (const key of ['id', 'fromStateId', 'nextStateId'])
      r.text(rule[key], pointer(location, key), true);
    if (has(rule, 'ignore')) r.choice(rule.ignore, pointer(location, 'ignore'), [true, false]);
    const eventPath = pointer(location, 'event');
    const event = r.object(rule.event, eventPath);
    if (event) {
      switch (event.kind) {
        case 'input':
        case 'receive':
          r.object(event, eventPath, ['kind', 'messageId']);
          r.text(event.messageId, pointer(eventPath, 'messageId'), true);
          break;
        case 'timer':
          r.object(event, eventPath, ['kind', 'timerId']);
          r.text(event.timerId, pointer(eventPath, 'timerId'), true);
          break;
        case 'connection':
          r.object(event, eventPath, ['kind', 'state']);
          r.choice(event.state, pointer(eventPath, 'state'), ['closed', 'failed']);
          break;
        default:
          r.issue(pointer(eventPath, 'kind'), 'choice', 'Unsupported event');
      }
    }
    if (has(rule, 'condition')) inspectCondition(rule.condition, pointer(location, 'condition'), r);
    r.array(rule.actions, pointer(location, 'actions'), (value, actionPath) => {
      const action = r.object(value, actionPath);
      if (!action) return;
      switch (action.kind) {
        case 'send':
        case 'deliver': {
          r.object(action, actionPath, ['kind', 'messageId', 'values']);
          r.text(action.messageId, pointer(actionPath, 'messageId'), true);
          const values = r.object(action.values, pointer(actionPath, 'values'));
          if (values)
            for (const [key, expression] of Object.entries(values))
              inspectExpression(expression, pointer(pointer(actionPath, 'values'), key), r);
          break;
        }
        case 'assign':
          r.object(action, actionPath, ['kind', 'variableId', 'value']);
          r.text(action.variableId, pointer(actionPath, 'variableId'), true);
          inspectExpression(action.value, pointer(actionPath, 'value'), r);
          break;
        case 'start-timer':
          r.object(action, actionPath, ['kind', 'timerId', 'durationMs']);
          r.text(action.timerId, pointer(actionPath, 'timerId'), true);
          inspectExpression(action.durationMs, pointer(actionPath, 'durationMs'), r);
          break;
        case 'cancel-timer':
          r.object(action, actionPath, ['kind', 'timerId']);
          r.text(action.timerId, pointer(actionPath, 'timerId'), true);
          break;
        case 'finish':
          r.object(action, actionPath, ['kind', 'outcome']);
          r.choice(action.outcome, pointer(actionPath, 'outcome'), ['success', 'failure']);
          break;
        default:
          r.issue(pointer(actionPath, 'kind'), 'choice', 'Unsupported action');
      }
    });
  });
}

function valueType(value: JsonValue): ValueType {
  return typeof value === 'string'
    ? 'string'
    : typeof value === 'boolean'
      ? 'boolean'
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? 'integer'
        : 'json';
}

function fieldType(field: FieldDefinition): ValueType {
  return field.type === 'enum' ? 'string' : field.type;
}

function checkFieldValue(field: FieldDefinition, value: unknown, path: string, r: Reader): void {
  let valid = false;
  switch (field.type) {
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
  if (!valid)
    r.issue(path, 'field-value', `Value does not satisfy ${field.type} field ${field.id}`);
}

function unique(items: readonly { readonly id: string }[], path: string, r: Reader): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id))
      r.issue(pointer(pointer(path, index), 'id'), 'duplicate-id', `Duplicate ID ${item.id}`);
    seen.add(item.id);
  });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? '';
}

function inspectProtocolSemantics(protocol: ProtocolDefinition, path: string, r: Reader): void {
  for (const key of ['messages', 'states', 'variables', 'timers', 'rules'] as const)
    unique(protocol[key], pointer(path, key), r);
  const messages = new Map(protocol.messages.map((message) => [message.id, message]));
  const states = new Map(protocol.states.map((state) => [state.id, state]));
  const variables = new Map(protocol.variables.map((variable) => [variable.id, variable]));
  const timers = new Set(protocol.timers.map((timer) => timer.id));
  const missing = (exists: boolean, location: string, id: string) => {
    if (!exists) r.issue(location, 'reference', `Unknown reference ${id}`);
  };
  missing(
    states.has(protocol.initialStateId),
    pointer(path, 'initialStateId'),
    protocol.initialStateId,
  );
  if (
    (protocol.codec === 'json-lines' && protocol.lowerService !== 'stream') ||
    (protocol.codec !== 'json-lines' && protocol.lowerService !== 'datagram') ||
    (protocol.layer === 'transport' && protocol.codec !== 'logical-packet') ||
    (protocol.layer === 'application' && protocol.codec === 'logical-packet')
  ) {
    r.issue(
      pointer(path, 'codec'),
      'service-incompatible',
      'Codec, target layer and lower service are incompatible',
    );
  }
  protocol.messages.forEach((message, index) => {
    const fieldPath = pointer(pointer(pointer(path, 'messages'), index), 'fields');
    unique(message.fields, fieldPath, r);
    const names = new Set<string>();
    message.fields.forEach((field, fieldIndex) => {
      const location = pointer(fieldPath, fieldIndex);
      if (names.has(field.name))
        r.issue(
          pointer(location, 'name'),
          'duplicate-name',
          'Wire field names must be unique within a message',
        );
      names.add(field.name);
      if (
        field.type === 'integer' &&
        (field.min ?? Number.MIN_SAFE_INTEGER) > (field.max ?? Number.MAX_SAFE_INTEGER)
      )
        r.issue(location, 'range-order', 'min exceeds max');
      if (
        field.type === 'string' &&
        (field.minLength ?? 0) > (field.maxLength ?? Number.MAX_SAFE_INTEGER)
      )
        r.issue(location, 'range-order', 'minLength exceeds maxLength');
      if (field.type === 'enum' && new Set(field.options).size !== field.options.length)
        r.issue(pointer(location, 'options'), 'duplicate-option', 'Enum options must be unique');
      if (has(field, 'defaultValue'))
        checkFieldValue(field, field.defaultValue, pointer(location, 'defaultValue'), r);
    });
  });
  protocol.variables.forEach((variable, index) => {
    if (variable.type !== 'json' && valueType(variable.initial) !== variable.type)
      r.issue(
        pointer(pointer(pointer(path, 'variables'), index), 'initial'),
        'variable-type',
        'Initial value has a different type',
      );
  });

  function expressionType(
    expression: ValueExpression,
    rule: RuleDefinition,
    location: string,
  ): ValueType | undefined {
    switch (expression.kind) {
      case 'literal':
        return valueType(expression.value);
      case 'variable': {
        const variable = variables.get(expression.variableId);
        missing(Boolean(variable), pointer(location, 'variableId'), expression.variableId);
        return variable?.type;
      }
      case 'field': {
        const message =
          rule.event.kind === 'input' || rule.event.kind === 'receive'
            ? messages.get(rule.event.messageId)
            : undefined;
        const field = message?.fields.find((candidate) => candidate.id === expression.fieldId);
        missing(Boolean(field), pointer(location, 'fieldId'), expression.fieldId);
        return field && fieldType(field);
      }
      case 'add':
      case 'subtract': {
        const left = expressionType(expression.left, rule, pointer(location, 'left'));
        const right = expressionType(expression.right, rule, pointer(location, 'right'));
        if (left !== 'integer' || right !== 'integer')
          r.issue(location, 'expression-type', 'Arithmetic requires integer operands');
        return 'integer';
      }
    }
  }
  function conditionTypes(condition: Condition, rule: RuleDefinition, location: string): void {
    if (condition.kind === 'compare') {
      const left = expressionType(condition.left, rule, pointer(location, 'left'));
      const right = expressionType(condition.right, rule, pointer(location, 'right'));
      if (
        left !== right ||
        (!['eq', 'ne'].includes(condition.operator) && left !== 'integer' && left !== 'string')
      )
        r.issue(location, 'condition-type', 'Incompatible comparison operands');
    } else if (condition.kind === 'not')
      conditionTypes(condition.condition, rule, pointer(location, 'condition'));
    else
      condition.conditions.forEach((item, index) => {
        conditionTypes(item, rule, pointer(pointer(location, 'conditions'), index));
      });
  }
  protocol.rules.forEach((rule, index) => {
    const location = pointer(pointer(path, 'rules'), index);
    missing(states.has(rule.fromStateId), pointer(location, 'fromStateId'), rule.fromStateId);
    missing(states.has(rule.nextStateId), pointer(location, 'nextStateId'), rule.nextStateId);
    if (rule.event.kind === 'input' || rule.event.kind === 'receive')
      missing(
        messages.has(rule.event.messageId),
        pointer(pointer(location, 'event'), 'messageId'),
        rule.event.messageId,
      );
    if (rule.event.kind === 'timer')
      missing(
        timers.has(rule.event.timerId),
        pointer(pointer(location, 'event'), 'timerId'),
        rule.event.timerId,
      );
    if (rule.event.kind === 'connection' && protocol.lowerService !== 'stream')
      r.issue(pointer(location, 'event'), 'service-event', 'Connection events require a stream');
    if (rule.condition) conditionTypes(rule.condition, rule, pointer(location, 'condition'));
    if (
      (rule.ignore && (rule.actions.length || rule.nextStateId !== rule.fromStateId)) ||
      (!rule.ignore && !rule.actions.length && rule.nextStateId === rule.fromStateId)
    )
      r.issue(location, 'explicit-ignore', 'No-op rules must explicitly ignore and preserve state');
    rule.actions.forEach((action, actionIndex) => {
      const actionPath = pointer(pointer(location, 'actions'), actionIndex);
      if (action.kind === 'finish' && actionIndex !== rule.actions.length - 1) {
        r.issue(actionPath, 'finish-order', 'finish must be the final action');
      }
      if (action.kind === 'send' || action.kind === 'deliver') {
        const message = messages.get(action.messageId);
        missing(Boolean(message), pointer(actionPath, 'messageId'), action.messageId);
        for (const [id, expression] of Object.entries(action.values)) {
          const field = message?.fields.find((candidate) => candidate.id === id);
          missing(Boolean(field), pointer(pointer(actionPath, 'values'), id), id);
          const type = expressionType(expression, rule, pointer(pointer(actionPath, 'values'), id));
          if (field && fieldType(field) !== type)
            r.issue(
              pointer(pointer(actionPath, 'values'), id),
              'expression-type',
              'Expression type differs from target field',
            );
          if (field && expression.kind === 'literal')
            checkFieldValue(field, expression.value, pointer(pointer(actionPath, 'values'), id), r);
        }
        for (const field of message?.fields ?? [])
          if (field.required && !has(field, 'defaultValue') && !has(action.values, field.id))
            r.issue(
              pointer(pointer(actionPath, 'values'), field.id),
              'required-field',
              'Required target field has no expression or default',
            );
      } else if (action.kind === 'assign') {
        const variable = variables.get(action.variableId);
        missing(Boolean(variable), pointer(actionPath, 'variableId'), action.variableId);
        const type = expressionType(action.value, rule, pointer(actionPath, 'value'));
        if (variable && variable.type !== 'json' && type !== variable.type)
          r.issue(
            pointer(actionPath, 'value'),
            'expression-type',
            'Assignment type differs from variable',
          );
      } else if (action.kind === 'start-timer' || action.kind === 'cancel-timer') {
        missing(timers.has(action.timerId), pointer(actionPath, 'timerId'), action.timerId);
        if (action.kind === 'start-timer') {
          if (
            expressionType(action.durationMs, rule, pointer(actionPath, 'durationMs')) !== 'integer'
          )
            r.issue(
              pointer(actionPath, 'durationMs'),
              'timer-duration',
              'Timer duration requires an integer',
            );
          if (action.durationMs.kind === 'literal')
            r.number(action.durationMs.value, pointer(actionPath, 'durationMs'));
        }
      } else if (!states.get(rule.nextStateId)?.terminal)
        r.issue(
          pointer(location, 'nextStateId'),
          'terminal-state',
          'finish requires a terminal next state',
        );
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
        r.issue(location, 'rule-conflict', `Rule overlaps ${other.id}`);
    }
  });
}

/** Parse and validate a complete protocol definition, returning JSON-pointer diagnostics. */
export function parseProtocolDefinition(value: unknown): ValidationResult<ProtocolDefinition> {
  const r = new Reader();
  inspectJson(value, r);
  if (r.diagnostics.length) return { success: false, diagnostics: r.diagnostics };
  inspectProtocol(value, '', r);
  if (!r.diagnostics.length) inspectProtocolSemantics(value as ProtocolDefinition, '', r);
  return r.result(value as ProtocolDefinition);
}

function messageValues(
  protocol: ProtocolDefinition,
  value: unknown,
  path: string,
  r: Reader,
): ProtocolMessage | undefined {
  const node = r.object(value, path, ['messageId', 'values']);
  if (!node) return;
  r.text(node.messageId, pointer(path, 'messageId'), true);
  const values = r.object(node.values, pointer(path, 'values'));
  if (!values) return;
  const message = protocol.messages.find((candidate) => candidate.id === node.messageId);
  if (!message) {
    r.issue(pointer(path, 'messageId'), 'message-reference', 'Unknown message ID');
    return;
  }
  const result: [string, string | number | boolean][] = [];
  for (const key of Object.keys(values))
    if (!message.fields.some((field) => field.id === key))
      r.issue(pointer(pointer(path, 'values'), key), 'unknown-field', 'Unknown field ID');
  for (const field of message.fields) {
    const present = has(values, field.id);
    const fallback = has(field, 'defaultValue');
    if (!present && !fallback) {
      if (field.required)
        r.issue(
          pointer(pointer(path, 'values'), field.id),
          'required-field',
          'Required field is absent',
        );
      continue;
    }
    const fieldValue = present ? values[field.id] : field.defaultValue;
    checkFieldValue(field, fieldValue, pointer(pointer(path, 'values'), field.id), r);
    if (
      typeof fieldValue === 'string' ||
      typeof fieldValue === 'number' ||
      typeof fieldValue === 'boolean'
    )
      result.push([field.id, fieldValue]);
  }
  return { messageId: message.id, values: Object.fromEntries(result) };
}

/** Validate values by stable field ID and materialize declared defaults without mutating input. */
export function validateProtocolMessage(
  protocol: ProtocolDefinition,
  value: unknown,
): ValidationResult<ProtocolMessage> {
  const r = new Reader();
  inspectJson(value, r);
  if (r.diagnostics.length) return { success: false, diagnostics: r.diagnostics };
  const message = messageValues(protocol, value, '', r);
  if (!message || r.diagnostics.length) return { success: false, diagnostics: r.diagnostics };
  return r.result(message);
}

function inspectEnvironment(value: unknown, path: string, r: Reader): void {
  const node = r.object(value, path);
  if (!node) return;
  r.choice(node.schemaVersion, pointer(path, 'schemaVersion'), [1]);
  r.text(node.id, pointer(path, 'id'), true);
  r.choice(node.kind, pointer(path, 'kind'), ['stream', 'datagram']);
  r.object(node, path, [
    'schemaVersion',
    'id',
    'kind',
    'directions',
    ...(node.kind === 'stream' ? ['connections'] : ['targetedDrops']),
  ]);
  const directions = r.object(node.directions, pointer(path, 'directions'), ['AtoB', 'BtoA']);
  for (const direction of ['AtoB', 'BtoA']) {
    const location = pointer(pointer(path, 'directions'), direction);
    const settings =
      directions &&
      r.object(
        directions[direction],
        location,
        node.kind === 'stream'
          ? ['delayMs', 'chunkBytes']
          : ['delayMs', 'jitterMs', 'lossRate', 'duplicateRate'],
      );
    if (!settings) continue;
    r.number(settings.delayMs, pointer(location, 'delayMs'));
    if (node.kind === 'stream')
      r.number(
        settings.chunkBytes,
        pointer(location, 'chunkBytes'),
        1,
        EXECUTION_POLICY.maxBufferBytes,
      );
    else {
      r.number(settings.jitterMs, pointer(location, 'jitterMs'));
      for (const key of ['lossRate', 'duplicateRate'])
        r.number(settings[key], pointer(location, key), 0, 1, false);
    }
  }
  if (node.kind === 'stream')
    r.array(node.connections, pointer(path, 'connections'), (value, location) => {
      const connection = r.object(value, location, ['timeMs', 'direction', 'kind']);
      if (!connection) return;
      r.number(connection.timeMs, pointer(location, 'timeMs'));
      r.choice(connection.direction, pointer(location, 'direction'), ['AtoB', 'BtoA']);
      r.choice(connection.kind, pointer(location, 'kind'), ['close', 'fail']);
    });
  else
    r.array(node.targetedDrops, pointer(path, 'targetedDrops'), (value, location) => {
      const drop = r.object(value, location, ['direction', 'transmission']);
      if (!drop) return;
      r.choice(drop.direction, pointer(location, 'direction'), ['AtoB', 'BtoA']);
      r.number(drop.transmission, pointer(location, 'transmission'), 1);
    });
}

function inspectScenario(value: unknown, path: string, r: Reader): void {
  const node = r.object(value, path, [
    'schemaVersion',
    'id',
    'observationMs',
    'inputs',
    'expectations',
  ]);
  if (!node) return;
  r.choice(node.schemaVersion, pointer(path, 'schemaVersion'), [1]);
  r.text(node.id, pointer(path, 'id'), true);
  r.number(node.observationMs, pointer(path, 'observationMs'));
  r.array(node.inputs, pointer(path, 'inputs'), (value, location) => {
    const input = r.object(value, location, ['id', 'timeMs', 'participant', 'message']);
    if (!input) return;
    r.text(input.id, pointer(location, 'id'), true);
    r.number(input.timeMs, pointer(location, 'timeMs'));
    r.choice(input.participant, pointer(location, 'participant'), ['A', 'B']);
    inspectMessage(input.message, pointer(location, 'message'), r);
  });
  r.array(
    node.expectations,
    pointer(path, 'expectations'),
    (value, location) => {
      const expectation = r.object(value, location);
      if (!expectation) return;
      const base = ['id', 'kind', 'participant'];
      r.text(expectation.id, pointer(location, 'id'), true);
      r.choice(expectation.participant, pointer(location, 'participant'), ['A', 'B']);
      switch (expectation.kind) {
        case 'state':
          r.object(expectation, location, [...base, 'stateId']);
          r.text(expectation.stateId, pointer(location, 'stateId'), true);
          break;
        case 'delivery-count':
          r.object(expectation, location, [...base, 'messageId', 'count']);
          r.text(expectation.messageId, pointer(location, 'messageId'), true);
          r.number(expectation.count, pointer(location, 'count'));
          break;
        case 'delivered-values':
          r.object(expectation, location, [...base, 'message']);
          inspectMessage(expectation.message, pointer(location, 'message'), r);
          break;
        case 'completion-before':
          r.object(expectation, location, [...base, 'timeMs']);
          r.number(expectation.timeMs, pointer(location, 'timeMs'));
          break;
        default:
          r.issue(pointer(location, 'kind'), 'choice', 'Unsupported expectation');
      }
    },
    1,
  );
}

/** Validate a self-contained experiment and all protocol, environment and scenario references. */
export function parseExperiment(value: unknown): ValidationResult<ExperimentDefinition> {
  const r = new Reader();
  inspectJson(value, r);
  if (r.diagnostics.length) return { success: false, diagnostics: r.diagnostics };
  const node = r.object(value, '', [
    'schemaVersion',
    'id',
    'label',
    'seed',
    'protocols',
    'definitions',
    'environment',
    'scenario',
  ]);
  if (!node) return { success: false, diagnostics: r.diagnostics };
  r.choice(node.schemaVersion, '/schemaVersion', [1]);
  r.text(node.id, '/id', true);
  r.text(node.label, '/label');
  r.number(node.seed, '/seed', 0, 0xffff_ffff);
  const references = r.object(node.protocols, '/protocols', ['A', 'B']);
  for (const participant of ['A', 'B']) {
    const reference =
      references &&
      r.object(references[participant], `/protocols/${participant}`, ['id', 'revision']);
    if (reference) {
      r.text(reference.id, `/protocols/${participant}/id`, true);
      r.number(reference.revision, `/protocols/${participant}/revision`, 1);
    }
  }
  r.array(node.definitions, '/definitions', (item, path) => inspectProtocol(item, path, r), 1);
  inspectEnvironment(node.environment, '/environment', r);
  inspectScenario(node.scenario, '/scenario', r);
  if (r.diagnostics.length) return { success: false, diagnostics: r.diagnostics };
  const experiment = value as ExperimentDefinition;
  experiment.definitions.forEach((definition, index) => {
    inspectProtocolSemantics(definition, `/definitions/${index}`, r);
  });
  const definitions = new Map<string, ProtocolDefinition>();
  experiment.definitions.forEach((definition, index) => {
    const key = `${definition.id}@${definition.revision}`;
    if (definitions.has(key))
      r.issue(`/definitions/${index}`, 'duplicate-revision', 'Duplicate protocol ID and revision');
    definitions.set(key, definition);
  });
  for (const participant of ['A', 'B'] as const) {
    const reference = experiment.protocols[participant];
    const protocol = definitions.get(`${reference.id}@${reference.revision}`);
    if (!protocol) {
      r.issue(`/protocols/${participant}`, 'reference', 'Protocol revision is missing');
      continue;
    }
    if (protocol.lowerService !== experiment.environment.kind)
      r.issue(
        `/protocols/${participant}`,
        'service-incompatible',
        'Protocol lower service differs from environment',
      );
    if (
      protocol.layer !==
      definitions.get(`${experiment.protocols.A.id}@${experiment.protocols.A.revision}`)?.layer
    )
      r.issue(
        `/protocols/${participant}`,
        'layer-incompatible',
        'Both participants must target the same layer',
      );
    experiment.scenario.inputs.forEach((input, index) => {
      if (input.participant === participant)
        messageValues(protocol, input.message, `/scenario/inputs/${index}/message`, r);
    });
    experiment.scenario.expectations.forEach((expectation, index) => {
      if (expectation.participant !== participant) return;
      const path = `/scenario/expectations/${index}`;
      if (
        expectation.kind === 'state' &&
        !protocol.states.some((state) => state.id === expectation.stateId)
      )
        r.issue(`${path}/stateId`, 'reference', 'Expected state is missing');
      if (
        expectation.kind === 'delivery-count' &&
        !protocol.messages.some((message) => message.id === expectation.messageId)
      )
        r.issue(`${path}/messageId`, 'reference', 'Expected message is missing');
      if (expectation.kind === 'delivered-values')
        messageValues(protocol, expectation.message, `${path}/message`, r);
    });
  }
  unique(experiment.scenario.inputs, '/scenario/inputs', r);
  unique(experiment.scenario.expectations, '/scenario/expectations', r);
  experiment.scenario.inputs.forEach((input, index) => {
    if (input.timeMs > experiment.scenario.observationMs)
      r.issue(
        `/scenario/inputs/${index}/timeMs`,
        'observation-window',
        'Input is outside observation period',
      );
  });
  experiment.scenario.expectations.forEach((expectation, index) => {
    if (
      expectation.kind === 'completion-before' &&
      expectation.timeMs > experiment.scenario.observationMs
    )
      r.issue(
        `/scenario/expectations/${index}/timeMs`,
        'observation-window',
        'Deadline is outside observation period',
      );
  });
  if (experiment.environment.kind === 'stream') {
    const seen = new Set<string>();
    experiment.environment.connections.forEach((connection, index) => {
      if (seen.has(connection.direction))
        r.issue(
          `/environment/connections/${index}/direction`,
          'duplicate-connection',
          'A stream direction can close or fail only once',
        );
      seen.add(connection.direction);
      if (connection.timeMs > experiment.scenario.observationMs)
        r.issue(
          `/environment/connections/${index}/timeMs`,
          'observation-window',
          'Connection event is outside observation period',
        );
    });
  } else {
    const seen = new Set<string>();
    experiment.environment.targetedDrops.forEach((drop, index) => {
      const key = `${drop.direction}:${drop.transmission}`;
      if (seen.has(key))
        r.issue(
          `/environment/targetedDrops/${index}`,
          'duplicate-drop',
          'Duplicate targeted transmission',
        );
      seen.add(key);
    });
  }
  return r.result(experiment);
}

/** Validate all definitions before capturing the complete experiment for a future engine run. */
export function prepareExperimentSnapshot(value: unknown): ValidationResult<ExperimentSnapshot> {
  const parsed = parseExperiment(value);
  return parsed.success
    ? { success: true, value: createRunSnapshot(parsed.value, parsed.value.seed) }
    : parsed;
}
