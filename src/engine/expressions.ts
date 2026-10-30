import type { JsonObject, JsonValue } from '../domain/execution-contract.ts';
import type { Condition, ProtocolMessage, ValueExpression } from '../domain/protocol-model.ts';

export type EvaluationContext = {
  readonly variables: JsonObject;
  readonly message?: ProtocolMessage;
};

/** A modeled runtime error, distinct from an internal engine exception. */
export class EvaluationFault extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'EvaluationFault';
  }
}

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as JsonObject)[key] ?? null)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Compare JSON values structurally, without depending on object insertion order. */
export function equalJson(left: JsonValue, right: JsonValue): boolean {
  return canonical(left) === canonical(right);
}

/** Evaluate a typed declarative expression with safe integer arithmetic. */
export function evaluateValue(expression: ValueExpression, context: EvaluationContext): JsonValue {
  switch (expression.kind) {
    case 'literal':
      return structuredClone(expression.value);
    case 'variable': {
      if (!Object.hasOwn(context.variables, expression.variableId))
        throw new EvaluationFault('missing-variable', expression.variableId);
      return context.variables[expression.variableId] ?? null;
    }
    case 'field': {
      const values = context.message?.values;
      if (!values || !Object.hasOwn(values, expression.fieldId))
        throw new EvaluationFault('missing-field', expression.fieldId);
      return values[expression.fieldId] ?? null;
    }
    case 'add':
    case 'subtract': {
      const left = evaluateValue(expression.left, context);
      const right = evaluateValue(expression.right, context);
      if (
        typeof left !== 'number' ||
        typeof right !== 'number' ||
        !Number.isSafeInteger(left) ||
        !Number.isSafeInteger(right)
      )
        throw new EvaluationFault('arithmetic-type', 'Expected safe integers');
      const result = expression.kind === 'add' ? left + right : left - right;
      if (!Number.isSafeInteger(result))
        throw new EvaluationFault('integer-overflow', 'Arithmetic exceeded safe integer range');
      return result;
    }
  }
}

/** Evaluate guards, including short-circuit boolean groups and structural equality. */
export function evaluateCondition(condition: Condition, context: EvaluationContext): boolean {
  if (condition.kind === 'not') return !evaluateCondition(condition.condition, context);
  if (condition.kind === 'all')
    return condition.conditions.every((item) => evaluateCondition(item, context));
  if (condition.kind === 'any')
    return condition.conditions.some((item) => evaluateCondition(item, context));
  if (condition.kind !== 'compare')
    throw new EvaluationFault('condition-type', 'Unsupported condition');
  const left = evaluateValue(condition.left, context);
  const right = evaluateValue(condition.right, context);
  if (condition.operator === 'eq') return equalJson(left, right);
  if (condition.operator === 'ne') return !equalJson(left, right);
  if (
    !(
      (typeof left === 'number' && typeof right === 'number') ||
      (typeof left === 'string' && typeof right === 'string')
    )
  )
    throw new EvaluationFault('comparison-type', 'Ordered comparisons need matching scalars');
  switch (condition.operator) {
    case 'lt':
      return left < right;
    case 'lte':
      return left <= right;
    case 'gt':
      return left > right;
    case 'gte':
      return left >= right;
  }
  throw new EvaluationFault('condition-type', 'Unsupported comparison');
}
