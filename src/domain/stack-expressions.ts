import type { JsonValue } from './execution-contract.ts';
import { freezeOwned } from './immutable-data.ts';
import { pointerToken } from './json-pointer.ts';
import { parseJsonData, Reader } from './model-validation.ts';
import type { ValidationResult } from './protocol-model.ts';
import { deserializeBytes, parseBytesValue, serializeBytes } from './stack-bytes.ts';
import { STACK_POLICY, type StackExpression, type StackValueType } from './stack-model.ts';

export type ExpressionTypes = {
  readonly variables: Readonly<Record<string, StackValueType>>;
  readonly fields: Readonly<Record<string, StackValueType>>;
  readonly servicePayload?: StackValueType;
};
export type ExpressionValues = {
  readonly variables: Readonly<Record<string, JsonValue>>;
  readonly fields: Readonly<Record<string, JsonValue>>;
  readonly servicePayload?: JsonValue;
};

/** Classify a JSON value; bytes are recognized only by the explicit reserved tag. */
export function stackValueType(value: JsonValue): StackValueType {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'kind' in value &&
    value.kind === 'bytes'
  )
    return 'bytes';
  return typeof value === 'string'
    ? 'string'
    : typeof value === 'boolean'
      ? 'boolean'
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? 'integer'
        : 'json';
}

function shape(value: unknown, r: Reader): void {
  let count = 0;
  function visit(value: unknown, path: string, depth: number): void {
    if (++count > STACK_POLICY.maxExpressionNodes || depth > STACK_POLICY.maxExpressionDepth) {
      r.issue(path, 'expression-limit', 'Expression depth or node limit exceeded');
      return;
    }
    const node = r.object(value, path);
    if (!node) return;
    const child = (key: string) => visit(node[key], `${path}/${key}`, depth + 1);
    switch (node.kind) {
      case 'literal':
        r.object(node, path, ['kind', 'value'], ['value']);
        if (node.value !== undefined && stackValueType(node.value as JsonValue) === 'bytes') {
          const bytes = parseBytesValue(node.value);
          if (!bytes.success)
            for (const d of bytes.diagnostics)
              r.issue(`${path}/value${d.path === '/' ? '' : d.path}`, d.code, d.message);
        }
        break;
      case 'variable':
      case 'field': {
        const key = node.kind === 'variable' ? 'variableId' : 'fieldId';
        r.object(node, path, ['kind', key]);
        r.text(node[key], `${path}/${key}`, true);
        break;
      }
      case 'service-payload':
        r.object(node, path, ['kind']);
        break;
      case 'add':
      case 'subtract':
        r.object(node, path, ['kind', 'left', 'right']);
        child('left');
        child('right');
        break;
      case 'byteLength':
        r.object(node, path, ['kind', 'value']);
        child('value');
        break;
      case 'slice':
        r.object(node, path, ['kind', 'value', 'offset', 'length']);
        child('value');
        child('offset');
        child('length');
        break;
      case 'concat':
        r.object(node, path, ['kind', 'values']);
        r.array(
          node.values,
          `${path}/values`,
          (item, location) => visit(item, location, depth + 1),
          1,
        );
        break;
      default:
        r.issue(`${path}/kind`, 'choice', 'Unsupported stack expression');
    }
  }
  visit(value, '', 0);
}

/** Parse a bounded expression without accepting executable code or coercions. */
export function parseStackExpression(value: unknown): ValidationResult<StackExpression> {
  const json = parseJsonData(value);
  if (!json.success) return json;
  const r = new Reader();
  if (new TextEncoder().encode(JSON.stringify(value)).length > STACK_POLICY.maxArtifactBytes)
    r.issue('/', 'expression-limit', 'Expression JSON exceeds the size limit');
  else shape(value, r);
  return r.result(value as StackExpression);
}

/** Check operand/reference types in the exact triggering message or service-event scope. */
export function checkStackExpression(
  value: unknown,
  context: ExpressionTypes,
): ValidationResult<StackValueType> {
  const parsed = parseStackExpression(value);
  if (!parsed.success) return parsed;
  const r = new Reader();
  function visit(node: StackExpression, path: string): StackValueType | undefined {
    const requireType = (expression: StackExpression, key: string, type: StackValueType) => {
      const actual = visit(expression, `${path}/${key}`);
      if (actual && actual !== type)
        r.issue(`${path}/${key}`, 'expression-type', `Expected ${type}, received ${actual}`);
    };
    switch (node.kind) {
      case 'literal':
        return stackValueType(node.value);
      case 'variable':
      case 'field': {
        const key = node.kind === 'variable' ? node.variableId : node.fieldId;
        const source = node.kind === 'variable' ? context.variables : context.fields;
        const type = Object.hasOwn(source, key) ? source[key] : undefined;
        if (!type)
          r.issue(
            `${path}/${node.kind === 'variable' ? 'variableId' : 'fieldId'}`,
            'reference',
            'Value is unavailable in this event scope',
          );
        return type;
      }
      case 'service-payload':
        if (!context.servicePayload)
          r.issue(path, 'service-payload', 'This event has no service payload');
        return context.servicePayload;
      case 'add':
      case 'subtract':
        requireType(node.left, 'left', 'integer');
        requireType(node.right, 'right', 'integer');
        return 'integer';
      case 'byteLength':
        requireType(node.value, 'value', 'bytes');
        return 'integer';
      case 'slice':
        requireType(node.value, 'value', 'bytes');
        requireType(node.offset, 'offset', 'integer');
        requireType(node.length, 'length', 'integer');
        return 'bytes';
      case 'concat':
        node.values.forEach((item, index) => {
          requireType(item, `values/${index}`, 'bytes');
        });
        return 'bytes';
    }
  }
  const type = visit(parsed.value, '');
  return type && !r.diagnostics.length
    ? r.result(type)
    : { success: false, diagnostics: r.diagnostics };
}

/** Evaluate bounded byte/integer operations, returning an owned JSON value or a precise failure. */
export function evaluateStackExpression(
  value: unknown,
  context: ExpressionValues,
  maxBytes: number = STACK_POLICY.maxMessageBytes,
): ValidationResult<JsonValue> {
  const parsed = parseStackExpression(value);
  if (!parsed.success) return parsed;
  const json = parseJsonData(context);
  if (!json.success) return json;
  const r = new Reader();
  r.number(maxBytes, '/limits/maxMessageBytes', 1, STACK_POLICY.maxMessageBytes);
  if (r.diagnostics.length) return { success: false, diagnostics: r.diagnostics };
  function fault(path: string, code: string, message: string): never {
    r.issue(path, code, message);
    throw new Error('expression-evaluation');
  }
  function bytes(value: JsonValue, path: string): Uint8Array {
    const result = deserializeBytes(value, maxBytes);
    if (!result.success) {
      for (const d of result.diagnostics)
        r.issue(`${path}${d.path === '/' ? '' : d.path}`, d.code, d.message);
      throw new Error('expression-evaluation');
    }
    return result.value;
  }
  function integer(value: JsonValue, path: string): number {
    return typeof value === 'number' && Number.isSafeInteger(value)
      ? value
      : fault(path, 'integer', 'Expected a safe integer');
  }
  function visit(node: StackExpression, path: string): JsonValue {
    switch (node.kind) {
      case 'literal':
        return node.value;
      case 'variable':
      case 'field': {
        const key = node.kind === 'variable' ? node.variableId : node.fieldId;
        const source = node.kind === 'variable' ? context.variables : context.fields;
        return Object.hasOwn(source, key)
          ? source[key] === undefined
            ? fault(path, 'reference', 'Value is absent')
            : source[key]
          : fault(`${path}/${pointerToken(key)}`, 'reference', 'Value is absent');
      }
      case 'service-payload':
        return (
          context.servicePayload ?? fault(path, 'service-payload', 'Service payload is absent')
        );
      case 'add':
      case 'subtract': {
        const left = integer(visit(node.left, `${path}/left`), `${path}/left`);
        const right = integer(visit(node.right, `${path}/right`), `${path}/right`);
        return integer(node.kind === 'add' ? left + right : left - right, path);
      }
      case 'byteLength':
        return bytes(visit(node.value, `${path}/value`), `${path}/value`).length;
      case 'slice': {
        const source = bytes(visit(node.value, `${path}/value`), `${path}/value`);
        const offset = integer(visit(node.offset, `${path}/offset`), `${path}/offset`);
        const length = integer(visit(node.length, `${path}/length`), `${path}/length`);
        if (offset < 0 || length < 0 || offset > source.length - length)
          fault(path, 'bytes-range', 'Slice is outside the payload');
        return serializeBytes(source.subarray(offset, offset + length), maxBytes);
      }
      case 'concat': {
        const parts: Uint8Array[] = [];
        let size = 0;
        for (const [index, child] of node.values.entries()) {
          const part = bytes(visit(child, `${path}/values/${index}`), `${path}/values/${index}`);
          size += part.length;
          if (size > maxBytes)
            fault(path, 'bytes-limit', 'Concatenation exceeds the message limit');
          parts.push(part);
        }
        const output = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
          output.set(part, offset);
          offset += part.length;
        }
        return serializeBytes(output, maxBytes);
      }
    }
  }
  try {
    const output = visit(parsed.value, '');
    if (stackValueType(output) === 'bytes') bytes(output, '');
    if (new TextEncoder().encode(JSON.stringify(output)).length > STACK_POLICY.maxArtifactBytes)
      fault('/', 'expression-limit', 'Result JSON exceeds the size limit');
    return r.result(freezeOwned(structuredClone(output)));
  } catch (error) {
    if (!r.diagnostics.length) throw error;
    return { success: false, diagnostics: r.diagnostics };
  }
}
