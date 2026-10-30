import {
  createJsonDatagramCodec,
  createJsonLinesCodec,
  createLogicalPacketCodec,
  type DecodeBatch,
} from '../codecs/message-codecs.ts';
import { createHttpCodec } from '../codecs/http-codec.ts';
import type { JsonObject, JsonValue, ParticipantId } from '../domain/execution-contract.ts';
import { validateProtocolMessage } from '../domain/model-validation.ts';
import type {
  EventTrace,
  ExperimentSnapshot,
  ModelDiagnostic,
  ProtocolDefinition,
  ProtocolMessage,
  RuleDefinition,
  RuleEvent,
  RunResult,
  ValidationResult,
} from '../domain/protocol-model.ts';
import {
  EnvironmentLimit,
  type DeliveryEvent,
  type EnvironmentAdapter,
  type EnvironmentEvent,
  type WirePayload,
} from './environment-port.ts';
import { EventQueue } from './event-queue.ts';
import { equalJson, evaluateCondition, evaluateValue, EvaluationFault } from './expressions.ts';

type TerminalStatus = RunResult['status'];
export type EngineStatus = TerminalStatus | 'idle' | 'running' | 'paused';
export type ParticipantView = {
  readonly stateId: string;
  readonly variables: JsonObject;
  readonly outcome: 'active' | 'success' | 'failure' | 'error';
  readonly finishedAt: number | null;
  readonly timers: readonly {
    readonly timerId: string;
    readonly generation: number;
    readonly active: boolean;
    readonly due: number;
  }[];
};
export type EngineView = {
  readonly runId: string;
  readonly status: EngineStatus;
  readonly timeMs: number;
  readonly processedEvents: number;
  readonly participants: Readonly<Record<ParticipantId, ParticipantView>>;
  readonly events: readonly EventTrace[];
  readonly diagnostics: readonly ModelDiagnostic[];
  readonly expectations: RunResult['expectations'];
  readonly snapshot: ExperimentSnapshot;
};
type Timer = { generation: number; active: boolean; due: number };
type ParticipantCodec = {
  encode(message: ProtocolMessage): ValidationResult<WirePayload>;
  receive(payload: WirePayload): DecodeBatch;
  finish(): DecodeBatch;
  abort(): void;
};
type Participant = {
  protocol: ProtocolDefinition;
  codec: ParticipantCodec;
  stateId: string;
  variables: Record<string, JsonValue>;
  timers: Map<string, Timer>;
  outcome: ParticipantView['outcome'];
  finishedAt: number | undefined;
  delivered: { message: ProtocolMessage; timeMs: number }[];
  transmission: number;
};
type InputEvent = { type: 'input'; participant: ParticipantId; message: ProtocolMessage };
type TimerEvent = {
  type: 'timer';
  participant: ParticipantId;
  timerId: string;
  generation: number;
};
type QueuedEvent = {
  timeMs: number;
  sequence: number;
  kind: 'input' | 'delivery' | 'connection' | 'timer';
  event: InputEvent | TimerEvent | EnvironmentEvent;
};
type Effect =
  | { kind: 'send'; message: ProtocolMessage; payload: WirePayload }
  | { kind: 'deliver'; message: ProtocolMessage }
  | { kind: 'start-timer'; timerId: string; generation: number; due: number }
  | { kind: 'cancel-timer'; timerId: string; generation: number };

function terminal(status: EngineStatus): status is TerminalStatus {
  return !['idle', 'running', 'paused'].includes(status);
}
function freeze<Value>(value: Value): Readonly<Value> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function unwrap<Value>(result: ValidationResult<Value>): Value {
  if (result.success) return result.value;
  const first = result.diagnostics[0];
  throw new EvaluationFault(first?.code ?? 'invalid-message', first?.message ?? 'Invalid message');
}
function payloadData(payload: WirePayload): JsonObject {
  return payload.kind === 'bytes'
    ? { kind: 'bytes', bytes: Array.from(payload.bytes) }
    : { kind: 'packet', packet: payload.packet };
}
function codecFor(protocol: ProtocolDefinition, snapshot: ExperimentSnapshot): ParticipantCodec {
  const limits = {
    maxMessageBytes: snapshot.limits.maxMessageBytes,
    maxBufferBytes: snapshot.limits.maxBufferBytes,
  };
  const bad = (): DecodeBatch => ({
    messages: [],
    diagnostics: [{ path: '/', code: 'payload-type', message: 'Incompatible lower payload type' }],
    closed: true,
  });
  if (protocol.codec === 'json-lines' || protocol.codec === 'http-1.1') {
    const codec = unwrap(
      protocol.codec === 'http-1.1'
        ? createHttpCodec(protocol, limits)
        : createJsonLinesCodec(protocol, limits),
    );
    return {
      encode: (message) => {
        const encoded = codec.encode(message);
        return encoded.success
          ? { success: true, value: { kind: 'bytes', bytes: encoded.value } }
          : encoded;
      },
      receive: (payload) => (payload.kind === 'bytes' ? codec.push(payload.bytes) : bad()),
      finish: codec.finish,
      abort: codec.abort,
    };
  }
  if (protocol.codec === 'json-datagram') {
    const codec = unwrap(createJsonDatagramCodec(protocol, limits));
    return {
      encode: (message) => {
        const encoded = codec.encode(message);
        return encoded.success
          ? { success: true, value: { kind: 'bytes', bytes: encoded.value } }
          : encoded;
      },
      receive: (payload) => {
        if (payload.kind !== 'bytes') return bad();
        const decoded = codec.decode(payload.bytes);
        return {
          messages: decoded.success ? [decoded.value] : [],
          diagnostics: decoded.success ? [] : decoded.diagnostics,
          closed: false,
        };
      },
      finish: () => ({ messages: [], diagnostics: [], closed: true }),
      abort: () => {},
    };
  }
  const codec = unwrap(createLogicalPacketCodec(protocol, limits));
  return {
    encode: (message) => {
      const encoded = codec.encode(message);
      return encoded.success
        ? { success: true, value: { kind: 'packet', packet: encoded.value } }
        : encoded;
    },
    receive: (payload) => {
      if (payload.kind !== 'packet') return bad();
      const decoded = codec.decode(payload.packet);
      return {
        messages: decoded.success ? [decoded.value] : [],
        diagnostics: decoded.success ? [] : decoded.diagnostics,
        closed: false,
      };
    },
    finish: () => ({ messages: [], diagnostics: [], closed: true }),
    abort: () => {},
  };
}

/** Deterministic, DOM-free protocol runtime with bounded synchronous batches. */
export class SimulationEngine {
  readonly snapshot: ExperimentSnapshot;
  readonly runId: string;
  private readonly environment: EnvironmentAdapter;
  private readonly queue = new EventQueue<QueuedEvent>();
  private readonly participants: Record<ParticipantId, Participant>;
  private readonly events: EventTrace[] = [];
  private readonly diagnostics: ModelDiagnostic[] = [];
  private status: EngineStatus = 'idle';
  private timeMs = 0;
  private sequence = 0;
  private processed = 0;
  private traceBytes = 0;

  constructor(snapshot: ExperimentSnapshot, environment: EnvironmentAdapter, runId: string) {
    this.snapshot = snapshot;
    this.environment = environment;
    this.runId = runId;
    const create = (id: ParticipantId): Participant => {
      const reference = snapshot.configuration.protocols[id];
      const protocol = snapshot.configuration.definitions.find(
        (item) => item.id === reference.id && item.revision === reference.revision,
      );
      if (!protocol) throw new Error('Validated definition is missing');
      const initiallyTerminal = protocol.states.some(
        (state) => state.id === protocol.initialStateId && state.terminal,
      );
      return {
        protocol,
        codec: codecFor(protocol, snapshot),
        stateId: protocol.initialStateId,
        variables: Object.fromEntries(
          protocol.variables.map((item) => [item.id, structuredClone(item.initial)]),
        ),
        timers: new Map(
          protocol.timers.map((item) => [item.id, { generation: 0, active: false, due: 0 }]),
        ),
        outcome: initiallyTerminal ? 'success' : 'active',
        finishedAt: initiallyTerminal ? 0 : undefined,
        delivered: [],
        transmission: 0,
      };
    };
    this.participants = { A: create('A'), B: create('B') };
    for (const input of snapshot.configuration.scenario.inputs)
      this.enqueue(input.timeMs, 'input', {
        type: 'input',
        participant: input.participant,
        message: input.message,
      });
    for (const event of environment.initialEvents()) {
      if (terminal(this.status)) break;
      this.scheduleEnvironment(event);
    }
  }

  private halt(status: TerminalStatus, diagnostic?: ModelDiagnostic): void {
    if (terminal(this.status)) return;
    this.status = status;
    if (diagnostic) this.diagnostics.push(diagnostic);
    this.queue.clear();
    try {
      this.environment.dispose?.();
    } catch (error) {
      this.status = 'engine-error';
      this.diagnostics.push({
        path: '/environment',
        code: 'environment-dispose',
        message: error instanceof Error ? error.message : 'Environment cleanup failed',
      });
    }
    for (const actor of Object.values(this.participants)) {
      actor.codec.abort();
      for (const timer of actor.timers.values())
        if (timer.active) {
          timer.active = false;
          timer.generation++;
        }
    }
  }
  private enqueue(timeMs: number, kind: QueuedEvent['kind'], event: QueuedEvent['event']): void {
    if (terminal(this.status)) return;
    if (!Number.isSafeInteger(timeMs) || timeMs < this.timeMs)
      throw new EvaluationFault('time-range', 'Invalid scheduled virtual time');
    if (this.queue.size >= this.snapshot.limits.maxEvents) {
      this.halt('limit-reached', {
        path: '/limits/maxEvents',
        code: 'queue-limit',
        message: 'Queue limit reached',
      });
      return;
    }
    this.queue.push({ timeMs, kind, sequence: this.sequence++, event });
  }
  private scheduleEnvironment(event: EnvironmentEvent): void {
    this.enqueue(event.timeMs, event.kind === 'connection' ? 'connection' : 'delivery', event);
  }
  private record(
    kind: EventTrace['kind'],
    participant: ParticipantId,
    data: JsonValue,
    causeEventId?: string,
    ruleId?: string,
  ): EventTrace | undefined {
    if (terminal(this.status)) return;
    const entry: EventTrace = {
      schemaVersion: 1,
      runId: this.runId,
      eventId: `e-${this.events.length + 1}`,
      timeMs: this.timeMs,
      sequence: this.events.length,
      kind,
      participant,
      data: structuredClone(data),
      ...(causeEventId ? { causeEventId } : {}),
      ...(ruleId ? { ruleId } : {}),
    };
    // A generated run ID must not change deterministic resource-limit outcomes.
    const bytes = new TextEncoder().encode(JSON.stringify({ ...entry, runId: '' })).length;
    if (
      this.events.length >= this.snapshot.limits.maxEvents ||
      this.traceBytes + bytes > this.snapshot.limits.maxTraceBytes
    ) {
      this.halt('limit-reached', {
        path: '/limits',
        code: 'trace-limit',
        message: 'Event trace limit reached',
      });
      return;
    }
    this.traceBytes += bytes;
    this.events.push(freeze(entry));
    return entry;
  }
  private fault(
    participant: ParticipantId,
    code: string,
    message: string,
    causeEventId?: string,
    ruleId?: string,
  ): void {
    const diagnostic = {
      path: `/participants/${participant}${ruleId ? `/rules/${ruleId}` : ''}`,
      code,
      message,
    };
    if (code === 'message-limit' || code === 'buffer-limit' || code === 'staging-limit') {
      this.halt('limit-reached', diagnostic);
      return;
    }
    const actor = this.participants[participant];
    actor.outcome = 'error';
    actor.finishedAt ??= this.timeMs;
    for (const timer of actor.timers.values()) {
      timer.active = false;
      timer.generation++;
    }
    this.diagnostics.push(diagnostic);
    this.record('diagnostic', participant, diagnostic, causeEventId, ruleId);
  }

  private handle(
    participant: ParticipantId,
    event: RuleEvent,
    cause: string,
    message?: ProtocolMessage,
  ): void {
    const actor = this.participants[participant];
    if (actor.outcome === 'error' || terminal(this.status)) return;
    let ruleId: string | undefined;
    try {
      const context = { variables: actor.variables, ...(message ? { message } : {}) };
      const matching = actor.protocol.rules.filter((rule) => {
        if (rule.fromStateId !== actor.stateId || !equalJson(rule.event, event)) return false;
        ruleId = rule.id;
        return !rule.condition || evaluateCondition(rule.condition, context);
      });
      if (matching.length !== 1) {
        ruleId = undefined;
        throw new EvaluationFault(
          matching.length ? 'rule-conflict' : 'unmatched-event',
          matching.length
            ? `Matching rules: ${matching.map((rule) => rule.id).join(', ')}`
            : `No rule for ${actor.stateId} and ${event.kind}`,
        );
      }
      const rule = matching[0];
      if (!rule) return;
      ruleId = rule.id;
      if (actor.outcome !== 'active' && !rule.ignore)
        throw new EvaluationFault(
          'participant-finished',
          'Only explicit ignore is allowed after completion',
        );
      this.execute(participant, rule, cause, message);
    } catch (error) {
      if (error instanceof EnvironmentLimit) throw error;
      if (error instanceof EvaluationFault)
        this.fault(participant, error.code, error.message, cause, ruleId);
      else
        this.halt('engine-error', {
          path: `/participants/${participant}`,
          code: 'engine-exception',
          message: error instanceof Error ? error.message : 'Unexpected engine exception',
        });
    }
  }

  private execute(
    participant: ParticipantId,
    rule: RuleDefinition,
    cause: string,
    message?: ProtocolMessage,
  ): void {
    const actor = this.participants[participant];
    const before = { stateId: actor.stateId, variables: structuredClone(actor.variables) };
    const variables = structuredClone(actor.variables);
    const timers = new Map([...actor.timers].map(([id, timer]) => [id, { ...timer }]));
    const effects: Effect[] = [];
    let stagedBytes = 0;
    const stage = (effect: Effect, bytes = 0): void => {
      stagedBytes += bytes;
      if (
        effects.length >= this.snapshot.limits.maxEvents ||
        stagedBytes > this.snapshot.limits.maxTraceBytes
      )
        throw new EvaluationFault('staging-limit', 'Rule effects exceed bounded staging resources');
      effects.push(effect);
    };
    let outcome = actor.outcome;
    const context = { variables, ...(message ? { message } : {}) };
    // Validate every dynamic action before committing participant state or sending data.
    for (const action of rule.actions) {
      if (action.kind === 'send' || action.kind === 'deliver') {
        const values = Object.fromEntries(
          Object.entries(action.values).map(([id, expression]) => [
            id,
            evaluateValue(expression, context),
          ]),
        );
        const prepared = unwrap(
          validateProtocolMessage(actor.protocol, { messageId: action.messageId, values }),
        );
        if (action.kind === 'send') {
          const payload = unwrap(actor.codec.encode(prepared));
          stage(
            {
              kind: 'send',
              message: prepared,
              payload,
            },
            payload.kind === 'bytes'
              ? payload.bytes.length
              : new TextEncoder().encode(JSON.stringify(payload.packet)).length,
          );
        } else {
          const encoded = unwrap(actor.codec.encode(prepared));
          stage(
            { kind: 'deliver', message: prepared },
            encoded.kind === 'bytes'
              ? encoded.bytes.length
              : new TextEncoder().encode(JSON.stringify(encoded.packet)).length,
          );
        }
      } else if (action.kind === 'assign') {
        const value = evaluateValue(action.value, context);
        const variable = actor.protocol.variables.find((item) => item.id === action.variableId);
        if (
          !variable ||
          (variable.type !== 'json' &&
            (variable.type === 'integer'
              ? typeof value !== 'number' || !Number.isSafeInteger(value)
              : typeof value !== variable.type))
        )
          throw new EvaluationFault('variable-type', 'Assignment value has a different type');
        variables[action.variableId] = structuredClone(value);
      } else if (action.kind === 'start-timer' || action.kind === 'cancel-timer') {
        const timer = timers.get(action.timerId);
        if (!timer) throw new EvaluationFault('timer-reference', action.timerId);
        timer.generation++;
        if (action.kind === 'start-timer') {
          const duration = evaluateValue(action.durationMs, context);
          if (
            typeof duration !== 'number' ||
            !Number.isSafeInteger(duration) ||
            duration < 0 ||
            !Number.isSafeInteger(this.timeMs + duration)
          )
            throw new EvaluationFault('timer-duration', 'Invalid runtime timer duration');
          timer.active = true;
          timer.due = this.timeMs + duration;
          stage({
            kind: 'start-timer',
            timerId: action.timerId,
            generation: timer.generation,
            due: timer.due,
          });
        } else {
          timer.active = false;
          stage({
            kind: 'cancel-timer',
            timerId: action.timerId,
            generation: timer.generation,
          });
        }
      } else if (action.kind === 'finish') outcome = action.outcome;
    }
    const next = actor.protocol.states.find((state) => state.id === rule.nextStateId);
    if (next?.terminal && outcome === 'active') outcome = 'success';
    if (outcome !== 'active')
      for (const timer of timers.values()) {
        timer.active = false;
        timer.generation++;
      }
    actor.variables = variables;
    actor.timers = timers;
    actor.stateId = rule.nextStateId;
    actor.outcome = outcome;
    if (outcome !== 'active' && actor.finishedAt === undefined) actor.finishedAt = this.timeMs;
    for (const effect of effects) {
      if (terminal(this.status)) break;
      if (effect.kind === 'send') {
        const entry = this.record(
          'send',
          participant,
          { message: effect.message, wire: payloadData(effect.payload) },
          cause,
          rule.id,
        );
        if (!entry) break;
        actor.transmission++;
        for (const scheduled of this.environment.transmit({
          from: participant,
          to: participant === 'A' ? 'B' : 'A',
          timeMs: this.timeMs,
          transmission: actor.transmission,
          causeEventId: entry.eventId,
          payload: effect.payload,
        })) {
          if (terminal(this.status)) break;
          this.scheduleEnvironment(scheduled);
        }
      } else if (effect.kind === 'deliver') {
        actor.delivered.push({ message: effect.message, timeMs: this.timeMs });
        this.record('deliver', participant, { message: effect.message }, cause, rule.id);
      } else if (effect.kind === 'start-timer') {
        this.record(
          'timer',
          participant,
          {
            operation: 'start',
            timerId: effect.timerId,
            generation: effect.generation,
            due: effect.due,
          },
          cause,
          rule.id,
        );
        this.enqueue(effect.due, 'timer', {
          type: 'timer',
          participant,
          timerId: effect.timerId,
          generation: effect.generation,
        });
      } else
        this.record(
          'timer',
          participant,
          { operation: 'cancel', timerId: effect.timerId, generation: effect.generation },
          cause,
          rule.id,
        );
    }
    this.record(
      'transition',
      participant,
      {
        before,
        after: { stateId: actor.stateId, variables: actor.variables },
        outcome: actor.outcome,
        ignored: rule.ignore ?? false,
      },
      cause,
      rule.id,
    );
  }

  private consumeBatch(participant: ParticipantId, batch: DecodeBatch, cause: string): void {
    for (const message of batch.messages) {
      if (terminal(this.status) || this.participants[participant].outcome === 'error') break;
      const parsed = this.record('parsed', participant, { message }, cause);
      if (parsed)
        this.handle(
          participant,
          { kind: 'receive', messageId: message.messageId },
          parsed.eventId,
          message,
        );
    }
    const diagnostic = batch.diagnostics[0];
    if (diagnostic && !terminal(this.status))
      this.fault(participant, diagnostic.code, diagnostic.message, cause);
  }

  private receive(event: DeliveryEvent): void {
    const trace = this.record(
      'receive',
      event.to,
      {
        from: event.from,
        wire: payloadData(event.payload),
        ...(event.sourceEventIds ? { sourceEventIds: event.sourceEventIds } : {}),
        ...(event.copy ? { copy: event.copy } : {}),
        ...(event.transmission !== undefined ? { transmission: event.transmission } : {}),
      },
      event.causeEventId,
    );
    if (trace && this.participants[event.to].outcome !== 'error')
      this.consumeBatch(
        event.to,
        this.participants[event.to].codec.receive(event.payload),
        trace.eventId,
      );
  }

  private advance(): void {
    const next = this.queue.peek();
    const end = this.snapshot.configuration.scenario.observationMs;
    if (!next || next.timeMs > end) {
      this.timeMs = end;
      this.halt('completed');
      return;
    }
    if (this.processed >= this.snapshot.limits.maxEvents) {
      this.halt('limit-reached', {
        path: '/limits/maxEvents',
        code: 'event-limit',
        message: 'Processed event limit reached',
      });
      return;
    }
    const item = this.queue.take();
    if (!item) return;
    this.processed++;
    const event = item.event;
    if ('type' in event && event.type === 'timer') {
      const actor = this.participants[event.participant];
      const timer = actor.timers.get(event.timerId);
      if (!timer?.active || timer.generation !== event.generation) return;
    }
    this.timeMs = item.timeMs;
    if ('type' in event) {
      if (event.type === 'input') {
        const actor = this.participants[event.participant];
        const message = unwrap(validateProtocolMessage(actor.protocol, event.message));
        const trace = this.record('input', event.participant, { message });
        if (trace)
          this.handle(
            event.participant,
            { kind: 'input', messageId: message.messageId },
            trace.eventId,
            message,
          );
      } else {
        const timer = this.participants[event.participant].timers.get(event.timerId);
        if (timer) timer.active = false;
        const trace = this.record('timer', event.participant, {
          operation: 'expire',
          timerId: event.timerId,
          generation: event.generation,
        });
        if (trace)
          this.handle(event.participant, { kind: 'timer', timerId: event.timerId }, trace.eventId);
      }
    } else if (event.kind === 'delivery') {
      this.receive(event);
    } else if (event.kind === 'stream-read') {
      if (!this.environment.readStream) throw new Error('Environment cannot resolve stream reads');
      for (const delivery of this.environment.readStream(event.readId)) {
        if (terminal(this.status)) break;
        this.receive(delivery);
      }
    } else if (event.kind === 'connection') {
      const trace = this.record('connection', event.participant, { state: event.state });
      if (trace) {
        if (event.state === 'closed')
          this.consumeBatch(
            event.participant,
            this.participants[event.participant].codec.finish(),
            trace.eventId,
          );
        else this.participants[event.participant].codec.abort();
        this.handle(event.participant, { kind: 'connection', state: event.state }, trace.eventId);
      }
    } else this.record('environment', event.participant, event.detail, event.causeEventId);
  }

  private safelyAdvance(): void {
    try {
      this.advance();
    } catch (error) {
      if (error instanceof EnvironmentLimit) {
        this.halt('limit-reached', {
          path: '/limits/maxTraceBytes',
          code: 'environment-buffer-limit',
          message: error.message,
        });
        return;
      }
      this.halt('engine-error', {
        path: '/',
        code: 'engine-exception',
        message: error instanceof Error ? error.message : 'Unexpected engine exception',
      });
    }
  }

  private expectations(): RunResult['expectations'] {
    return this.snapshot.configuration.scenario.expectations.map((expectation) => {
      const actor = this.participants[expectation.participant];
      if (this.status !== 'completed' || actor.outcome === 'error')
        return {
          expectationId: expectation.id,
          status: 'undetermined',
          detail: 'Observation is incomplete or the participant encountered an error',
        };
      let passed = false;
      switch (expectation.kind) {
        case 'state':
          passed = actor.stateId === expectation.stateId;
          break;
        case 'delivery-count':
          passed =
            actor.delivered.filter((item) => item.message.messageId === expectation.messageId)
              .length === expectation.count;
          break;
        case 'delivered-values': {
          const expected = unwrap(validateProtocolMessage(actor.protocol, expectation.message));
          passed = actor.delivered.some((item) => equalJson(item.message, expected));
          break;
        }
        case 'completion-before':
          passed =
            actor.outcome === 'success' &&
            actor.finishedAt !== undefined &&
            actor.finishedAt <= expectation.timeMs;
          break;
      }
      return {
        expectationId: expectation.id,
        status: passed ? 'pass' : 'fail',
        detail: passed ? 'Expected condition observed' : 'Expected condition was not observed',
      };
    });
  }

  /** Read a detached immutable state suitable for UI rendering or inspection. */
  view(): EngineView {
    const actorView = (id: ParticipantId): ParticipantView => {
      const actor = this.participants[id];
      return {
        stateId: actor.stateId,
        variables: structuredClone(actor.variables),
        outcome: actor.outcome,
        finishedAt: actor.finishedAt ?? null,
        timers: [...actor.timers].map(([timerId, timer]) => ({ timerId, ...timer })),
      };
    };
    return freeze({
      runId: this.runId,
      status: this.status,
      timeMs: this.timeMs,
      processedEvents: this.processed,
      participants: { A: actorView('A'), B: actorView('B') },
      events: [...this.events],
      diagnostics: [...this.diagnostics],
      expectations: this.expectations(),
      snapshot: this.snapshot,
    });
  }
  /** Process one observable event, skipping invalidated timer entries. */
  step(): EngineView {
    if (terminal(this.status)) return this.view();
    this.status = 'running';
    const before = this.events.length;
    do {
      this.safelyAdvance();
    } while (!terminal(this.status) && this.events.length === before);
    if (!terminal(this.status)) this.status = 'paused';
    return this.view();
  }
  /** Process a finite queue budget; return paused when more work remains. */
  runBatch(budget = 100): EngineView {
    if (!Number.isSafeInteger(budget) || budget < 1)
      throw new RangeError('Batch budget must be positive');
    if (terminal(this.status)) return this.view();
    this.status = 'running';
    for (let index = 0; index < budget && !terminal(this.status); index++) this.safelyAdvance();
    if (!terminal(this.status)) this.status = 'paused';
    return this.view();
  }
  /** Execute until observation completion or a bounded terminal condition. */
  run(): EngineView {
    return this.runBatch(this.snapshot.limits.maxEvents + 1);
  }
  /** Keep a nonterminal instance paused without losing its queue or PRNG state. */
  pause(): EngineView {
    if (!terminal(this.status)) this.status = 'paused';
    return this.view();
  }
  /** Cancel an instance and release pending events; further execution is inert. */
  cancel(): EngineView {
    this.halt('cancelled');
    return this.view();
  }
  /** Return the final result only after the instance has reached a terminal state. */
  result(): RunResult | undefined {
    if (!terminal(this.status)) return;
    return freeze({
      schemaVersion: 1,
      status: this.status,
      snapshot: this.snapshot,
      events: [...this.events],
      diagnostics: [...this.diagnostics],
      expectations: this.expectations(),
    });
  }
}
