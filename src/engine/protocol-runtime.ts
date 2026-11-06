import type { JsonValue } from '../domain/execution-contract.ts';
import type { Condition, ValueExpression } from '../domain/protocol-model.ts';
import { parseBytesValue } from '../domain/stack-bytes.ts';
import { evaluateStackExpression, stackValueType } from '../domain/stack-expressions.ts';
import {
  type StackCondition,
  type StackEndpoint,
  type StackExpression,
  type StackLimits,
  type StackMessage,
  type StackProtocol,
  type StackRuleEvent,
  stackProtocolBody,
} from '../domain/stack-model.ts';
import {
  providedStackPort,
  validateServicePayload,
  validateStackMessage,
} from '../domain/stack-protocol-validation.ts';
import type {
  ByteOrigin,
  StackInstanceView,
  StackPortState,
  StackTimer,
} from '../domain/stack-runtime-model.ts';
import { EvaluationFault, equalJson, evaluateCondition, evaluateValue } from './expressions.ts';
import { matchingRules } from './rule-evaluation.ts';
import { StackCodec, stackValue } from './stack-codec.ts';

export type RuntimeTrigger = {
  readonly event: StackRuleEvent;
  readonly message?: StackMessage;
  readonly payload?: JsonValue;
  readonly byteFields?: Readonly<Record<string, readonly ByteOrigin[]>>;
  readonly payloadOrigins?: readonly ByteOrigin[];
};
export type RuntimeEffect =
  | {
      readonly kind: 'send';
      readonly message: StackMessage;
      readonly payload: JsonValue;
      readonly fieldOrigins: Readonly<Record<string, readonly ByteOrigin[]>>;
    }
  | { readonly kind: 'deliver'; readonly message: StackMessage }
  | {
      readonly kind: 'timer';
      readonly operation: 'start' | 'cancel';
      readonly timerId: string;
      readonly generation: number;
      readonly due: number;
    }
  | {
      readonly kind: 'service-indicate';
      readonly operation: 'read' | 'receive' | 'failed' | 'closed';
      readonly payload?: JsonValue;
      readonly origins?: readonly ByteOrigin[];
    };
export type PreparedTransition = {
  readonly ruleId: string;
  readonly before: {
    readonly stateId: string;
    readonly variables: Readonly<Record<string, JsonValue>>;
  };
  readonly variables: Record<string, JsonValue>;
  readonly timers: Map<string, StackTimer>;
  readonly stateId: string;
  readonly outcome: StackInstanceView['outcome'];
  readonly finishedAt: number | null;
  readonly provided: StackPortState | undefined;
  readonly effects: readonly RuntimeEffect[];
  readonly ignored: boolean;
  readonly byteOrigins: Record<string, readonly ByteOrigin[]>;
  readonly assignedBytes: ReadonlySet<string>;
};

/** An independent protocol instance; preparation never mutates committed state, codecs or other instances. */
export class ProtocolRuntime {
  readonly protocol: StackProtocol;
  readonly endpoint: StackEndpoint;
  readonly limits: StackLimits;
  codec: StackCodec;
  stateId: string;
  variables: Record<string, JsonValue>;
  timers: Map<string, StackTimer>;
  outcome: StackInstanceView['outcome'];
  finishedAt: number | null;
  tainted = false;
  requires: StackPortState = 'ready';
  provides: StackPortState | undefined;
  delivered: { readonly message: StackMessage; readonly timeMs: number }[] = [];
  byteOrigins: Record<string, readonly ByteOrigin[]> = {};
  constructor(
    protocol: StackProtocol,
    endpoint: StackEndpoint,
    limits: StackLimits,
    previous?: ProtocolRuntime,
  ) {
    this.protocol = protocol;
    this.endpoint = endpoint;
    this.limits = limits;
    const body = stackProtocolBody(protocol);
    this.codec = previous ? previous.codec.fork() : new StackCodec(protocol, limits);
    this.stateId = previous?.stateId ?? body.initialStateId;
    this.variables = previous
      ? { ...previous.variables }
      : Object.fromEntries(
          body.variables.map((variable) => [variable.id, structuredClone(variable.initial)]),
        );
    this.timers = new Map(
      previous
        ? [...previous.timers].map(([id, timer]) => [id, { ...timer }])
        : body.timers.map((timer) => [timer.id, { generation: 0, active: false, due: 0 }]),
    );
    this.outcome =
      previous?.outcome ??
      (body.states.some((state) => state.id === body.initialStateId && state.terminal)
        ? 'success'
        : 'active');
    this.finishedAt = previous ? previous.finishedAt : this.outcome === 'success' ? 0 : null;
    this.provides = providedStackPort(protocol) ? 'ready' : undefined;
    if (previous) {
      this.byteOrigins = { ...previous.byteOrigins };
      this.tainted = previous.tainted;
      this.requires = previous.requires;
      this.provides = previous.provides;
      this.delivered = [...previous.delivered];
    }
  }
  fork(): ProtocolRuntime {
    return new ProtocolRuntime(this.protocol, this.endpoint, this.limits, this);
  }
  hasEvent(event: StackRuleEvent): boolean {
    return stackProtocolBody(this.protocol).rules.some((rule) => equalJson(rule.event, event));
  }
  #value(
    expression: StackExpression,
    variables: Readonly<Record<string, JsonValue>>,
    trigger: RuntimeTrigger,
  ): JsonValue {
    if (this.protocol.mode === 'legacy-application')
      return evaluateValue(expression as ValueExpression, {
        variables,
        ...(trigger.message
          ? { message: trigger.message as import('../domain/protocol-model.ts').ProtocolMessage }
          : {}),
      });
    return stackValue(
      evaluateStackExpression(
        expression,
        {
          variables,
          fields: trigger.message?.values ?? {},
          ...(trigger.payload !== undefined ? { servicePayload: trigger.payload } : {}),
        },
        this.limits.maxMessageBytes,
      ),
    );
  }
  #origins(
    expression: StackExpression,
    origins: Readonly<Record<string, readonly ByteOrigin[]>>,
    variables: Readonly<Record<string, JsonValue>>,
    trigger: RuntimeTrigger,
  ): readonly ByteOrigin[] {
    if (this.protocol.mode === 'legacy-application') return [];
    switch (expression.kind) {
      case 'variable':
        return origins[expression.variableId] ?? [];
      case 'field':
        return trigger.byteFields?.[expression.fieldId] ?? [];
      case 'service-payload':
        return trigger.payload !== undefined && stackValueType(trigger.payload) === 'bytes'
          ? (trigger.payloadOrigins ?? [])
          : [];
      case 'concat': {
        let offset = 0;
        const output: ByteOrigin[] = [];
        for (const part of expression.values) {
          output.push(
            ...this.#origins(part, origins, variables, trigger).map((origin) => ({
              ...origin,
              valueOffset: origin.valueOffset + offset,
            })),
          );
          if (output.length > this.limits.maxTraceEvents)
            throw new EvaluationFault(
              'staging-limit',
              'Byte provenance exceeds the global trace budget',
            );
          offset += stackValue(parseBytesValue(this.#value(part, variables, trigger))).byteLength;
        }
        return output;
      }
      case 'slice': {
        const offset = this.#value(expression.offset, variables, trigger) as number;
        const length = this.#value(expression.length, variables, trigger) as number;
        return this.#origins(expression.value, origins, variables, trigger).flatMap((origin) => {
          const start = Math.max(offset, origin.valueOffset);
          const end = Math.min(offset + length, origin.valueOffset + origin.length);
          return end > start
            ? [
                {
                  ...origin,
                  valueOffset: start - offset,
                  sourceOffset: origin.sourceOffset + start - origin.valueOffset,
                  length: end - start,
                },
              ]
            : [];
        });
      }
      default:
        return [];
    }
  }
  #condition(
    condition: StackCondition,
    variables: Readonly<Record<string, JsonValue>>,
    trigger: RuntimeTrigger,
  ): boolean {
    if (this.protocol.mode === 'legacy-application')
      return evaluateCondition(condition as Condition, {
        variables,
        ...(trigger.message
          ? { message: trigger.message as import('../domain/protocol-model.ts').ProtocolMessage }
          : {}),
      });
    if (condition.kind === 'all')
      return condition.conditions.every((item) => this.#condition(item, variables, trigger));
    if (condition.kind === 'any')
      return condition.conditions.some((item) => this.#condition(item, variables, trigger));
    if (condition.kind === 'not') return !this.#condition(condition.condition, variables, trigger);
    if (condition.kind !== 'compare')
      throw new EvaluationFault('condition-type', 'Unsupported condition');
    const left = this.#value(condition.left, variables, trigger);
    const right = this.#value(condition.right, variables, trigger);
    if (condition.operator === 'eq') return equalJson(left, right);
    if (condition.operator === 'ne') return !equalJson(left, right);
    if (
      !(
        (typeof left === 'number' && typeof right === 'number') ||
        (typeof left === 'string' && typeof right === 'string')
      )
    )
      throw new EvaluationFault('comparison-type', 'Ordered comparisons require matching scalars');
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
  prepare(trigger: RuntimeTrigger, timeMs: number): PreparedTransition {
    const body = stackProtocolBody(this.protocol);
    const matches = matchingRules(
      body.rules,
      this.stateId,
      trigger.event,
      (rule) => !rule.condition || this.#condition(rule.condition, this.variables, trigger),
    );
    const rule = matches[0];
    if (matches.length !== 1 || !rule)
      throw new EvaluationFault(
        matches.length ? 'rule-conflict' : 'unmatched-event',
        `Expected one rule for ${this.stateId}/${trigger.event.kind}`,
      );
    if (this.outcome !== 'active' && !rule.ignore)
      throw new EvaluationFault(
        'instance-finished',
        'Only explicit ignore is allowed after instance completion',
      );
    const variables = { ...this.variables };
    const timers = new Map([...this.timers].map(([id, timer]) => [id, { ...timer }]));
    const effects: RuntimeEffect[] = [];
    let outcome = this.outcome;
    let provided = this.provides;
    let stagedBytes = 0;
    const byteOrigins = { ...this.byteOrigins };
    const assignedBytes = new Set<string>();
    const value = (expression: StackExpression) => this.#value(expression, variables, trigger);
    for (const action of rule.actions) {
      const previousEffects = effects.length;
      switch (action.kind) {
        case 'assign': {
          const result = value(action.value);
          const variable = body.variables.find((variable) => variable.id === action.variableId);
          const type = stackValueType(result);
          if (
            !variable ||
            (variable.type === 'bytes'
              ? type !== 'bytes'
              : variable.type === 'json'
                ? this.protocol.mode !== 'legacy-application' && type === 'bytes'
                : type !== variable.type)
          )
            throw new EvaluationFault(
              'variable-type',
              'Dynamic assignment differs from the variable type',
            );
          if (variable.type === 'bytes')
            stackValue(parseBytesValue(result, this.limits.maxMessageBytes));
          if (variable.type === 'bytes') {
            byteOrigins[action.variableId] = this.#origins(
              action.value,
              byteOrigins,
              variables,
              trigger,
            );
            assignedBytes.add(action.variableId);
          }
          variables[action.variableId] = result;
          break;
        }
        case 'send':
        case 'deliver': {
          if (action.kind === 'send' && this.requires !== 'ready')
            throw new EvaluationFault('service-unavailable', 'The lower service is not ready');
          const values = Object.fromEntries(
            Object.entries(action.values).map(([id, expression]) => [id, value(expression)]),
          );
          const message = stackValue(
            validateStackMessage(
              body,
              { messageId: action.messageId, values },
              this.limits.maxMessageBytes,
            ),
          );
          const payload = this.codec.encode(message);
          const fieldOrigins = Object.fromEntries(
            Object.entries(action.values).map(([id, expression]) => [
              id,
              this.#origins(expression, byteOrigins, variables, trigger),
            ]),
          );
          effects.push(
            action.kind === 'send'
              ? { kind: 'send', message, payload, fieldOrigins }
              : { kind: 'deliver', message },
          );
          break;
        }
        case 'start-timer':
        case 'cancel-timer': {
          const timer = timers.get(action.timerId);
          if (!timer) throw new EvaluationFault('timer-reference', 'Timer is absent');
          timer.generation++;
          if (action.kind === 'start-timer') {
            const duration = value(action.durationMs);
            if (
              typeof duration !== 'number' ||
              !Number.isSafeInteger(duration) ||
              duration < 0 ||
              !Number.isSafeInteger(timeMs + duration)
            )
              throw new EvaluationFault('timer-duration', 'Invalid virtual timer deadline');
            timer.active = true;
            timer.due = timeMs + duration;
          } else timer.active = false;
          effects.push({
            kind: 'timer',
            operation: action.kind === 'start-timer' ? 'start' : 'cancel',
            timerId: action.timerId,
            generation: timer.generation,
            due: timer.due,
          });
          break;
        }
        case 'finish':
          outcome = action.outcome;
          break;
        case 'service-indicate': {
          const port = providedStackPort(this.protocol);
          if (!port) throw new EvaluationFault('port-reference', 'No upper service is provided');
          if (provided !== 'ready')
            throw new EvaluationFault(
              'service-unavailable',
              'Provided service has already terminated',
            );
          if (action.operation === 'read' || action.operation === 'receive')
            effects.push({
              kind: 'service-indicate',
              operation: action.operation,
              origins: this.#origins(action.payload, byteOrigins, variables, trigger),
              payload: stackValue(
                validateServicePayload(
                  port.service,
                  value(action.payload),
                  this.limits.maxMessageBytes,
                ),
              ),
            });
          else {
            provided = action.operation;
            effects.push({ kind: 'service-indicate', operation: action.operation });
          }
          break;
        }
      }
      if (effects.length > previousEffects) {
        stagedBytes += new TextEncoder().encode(JSON.stringify(effects.at(-1))).length;
        if (stagedBytes > this.limits.maxArtifactBytes)
          throw new EvaluationFault(
            'staging-limit',
            'Staged effects exceed the global byte budget',
          );
      }
      if (effects.length > this.limits.maxPendingOperations)
        throw new EvaluationFault('staging-limit', 'Too many staged effects');
    }
    if (
      body.states.some((state) => state.id === rule.nextStateId && state.terminal) &&
      outcome === 'active'
    )
      outcome = 'success';
    if (outcome !== 'active')
      for (const timer of timers.values()) {
        timer.active = false;
        timer.generation++;
      }
    return {
      ruleId: rule.id,
      before: { stateId: this.stateId, variables: this.variables },
      variables,
      timers,
      stateId: rule.nextStateId,
      outcome,
      finishedAt: outcome !== 'active' ? (this.finishedAt ?? timeMs) : this.finishedAt,
      provided,
      effects,
      ignored: rule.ignore ?? false,
      byteOrigins,
      assignedBytes,
    };
  }
  apply(transition: PreparedTransition): void {
    this.byteOrigins = transition.byteOrigins;
    this.variables = transition.variables;
    this.timers = transition.timers;
    this.stateId = transition.stateId;
    this.outcome = transition.outcome;
    this.finishedAt = transition.finishedAt;
    this.provides = transition.provided;
  }
  fail(timeMs: number): void {
    this.outcome = 'error';
    this.tainted = true;
    this.finishedAt ??= timeMs;
    this.codec.abort();
    for (const timer of this.timers.values()) {
      timer.active = false;
      timer.generation++;
    }
  }
  view(): StackInstanceView {
    return {
      endpoint: this.endpoint,
      stateId: this.stateId,
      variables: this.variables,
      outcome: this.outcome,
      finishedAt: this.finishedAt,
      tainted: this.tainted,
      timers: [...this.timers].map(([timerId, timer]) => ({ timerId, ...timer })),
      ports: { requires: this.requires, ...(this.provides ? { provides: this.provides } : {}) },
    };
  }
}
