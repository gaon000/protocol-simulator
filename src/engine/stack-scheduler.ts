import { type DatagramDecision, planDatagram } from '../domain/datagram-policy.ts';
import { createSeededRandom, type JsonValue } from '../domain/execution-contract.ts';
import { freezeOwned } from '../domain/immutable-data.ts';
import type { ModelDiagnostic } from '../domain/protocol-model.ts';
import {
  type PayloadRange,
  type StackEndpoint,
  type StackMessage,
  type StackPortEndpoint,
  type StackRuleEvent,
  type StackSnapshot,
  type StackTrace,
  stackProtocolBody,
} from '../domain/stack-model.ts';
import { StackPayloadStore } from '../domain/stack-payloads.ts';
import { providedStackPort, validateStackMessage } from '../domain/stack-protocol-validation.ts';
import type {
  ByteOrigin,
  StackStatus,
  StackVerdict,
  StackView,
} from '../domain/stack-runtime-model.ts';
import { EventQueue } from './event-queue.ts';
import { EvaluationFault, equalJson } from './expressions.ts';
import {
  type PreparedTransition,
  ProtocolRuntime,
  type RuntimeTrigger,
} from './protocol-runtime.ts';
import { ServiceRouter, stackEndpointKey } from './service-router.ts';
import { stackValue } from './stack-codec.ts';
import { type ByteFragment, StackData, type StoredPayload } from './stack-data.ts';

type OperationBody =
  | { readonly type: 'input'; readonly message: StackMessage }
  | {
      readonly type: 'timer';
      readonly timerId: string;
      readonly generation: number;
      readonly source: string;
    }
  | {
      readonly type: 'request';
      readonly port: StackPortEndpoint;
      readonly payload: StoredPayload;
      readonly source: string;
    }
  | {
      readonly type: 'indication';
      readonly port: StackPortEndpoint;
      readonly operation: 'read' | 'receive' | 'failed' | 'closed';
      readonly payload?: StoredPayload;
      readonly source: string;
    }
  | {
      readonly type: 'wire';
      readonly payload: StoredPayload;
      readonly sources: readonly string[];
      readonly copy: 'original' | 'duplicate';
      readonly transmission: number;
    };
type Operation = {
  readonly id: string;
  readonly endpoint: StackEndpoint;
  readonly timeMs: number;
  readonly kind: 'input' | 'delivery' | 'timer';
  readonly sequence: number;
  readonly body: OperationBody;
  readonly hold?: { readonly owner: string; readonly payload: StoredPayload };
};
type PendingHold = { readonly id: string; readonly payload: StoredPayload };
type Transaction = {
  readonly timeMs: number;
  readonly actors: Map<string, ProtocolRuntime>;
  readonly fragments: Map<string, ByteFragment[]>;
  readonly pending: Map<string, readonly PendingHold[]>;
  readonly operations: Operation[];
  readonly trace: StackTrace[];
  readonly diagnostics: ModelDiagnostic[];
  readonly transmissions: Record<'A' | 'B', number>;
  sequence: number;
};
export type StackSchedulerOptions = { readonly datagramPlanner?: typeof planDatagram };
const ended = (status: StackStatus) => !['idle', 'running', 'paused'].includes(status);
const failed = (actor: ProtocolRuntime) => actor.outcome === 'error';
const isLimit = (code: string) =>
  /(?:limit|budget)$/.test(code) ||
  [
    'bytes-limit',
    'live-buffer-limit',
    'buffer-limit',
    'message-limit',
    'message-size',
    'payload-limit',
    'trace-limit',
    'artifact-limit',
    'staging-limit',
  ].includes(code);

/** A single clock/queue with atomic staged operations, isolated runtime instances and retained artifacts. */
export class StackScheduler {
  readonly snapshot: StackSnapshot;
  readonly runId: string;
  readonly #queue = new EventQueue<Operation>();
  readonly #router: ServiceRouter;
  readonly #data: StackData;
  readonly #planner: typeof planDatagram;
  readonly #random: () => number;
  readonly #draws: number[] = [];
  #drawPosition = 0;
  #actors = new Map<string, ProtocolRuntime>();
  #fragments = new Map<string, ByteFragment[]>();
  #pending = new Map<string, readonly PendingHold[]>();
  #transmissions: Record<'A' | 'B', number> = { A: 0, B: 0 };
  #sequence = 0;
  #timeMs = 0;
  #processed = 0;
  #status: StackStatus = 'idle';
  #diagnostics: ModelDiagnostic[] = [];
  #busy = false;

  constructor(snapshot: StackSnapshot, runId: string, options: StackSchedulerOptions = {}) {
    this.snapshot = snapshot;
    this.runId = runId;
    this.#planner = options.datagramPlanner ?? planDatagram;
    this.#router = new ServiceRouter(snapshot);
    this.#data = new StackData(new StackPayloadStore(runId, snapshot.configuration.limits));
    this.#random = createSeededRandom(snapshot.configuration.seed);
    const definitions = new Map(
      snapshot.configuration.definitions.map((definition) => [
        `${definition.id}@${definition.revision}`,
        definition,
      ]),
    );
    for (const participant of ['A', 'B'] as const)
      for (const instance of snapshot.configuration.nodes[participant].instances) {
        const protocol = definitions.get(
          `${instance.definition.id}@${instance.definition.revision}`,
        );
        if (!protocol) throw new Error('Validated protocol revision is absent');
        const endpoint = { participant, instanceId: instance.id };
        const actor = new ProtocolRuntime(protocol, endpoint, snapshot.configuration.limits);
        this.#actors.set(stackEndpointKey(endpoint), actor);
        this.#fragments.set(stackEndpointKey(endpoint), []);
        this.#syncActor(actor, []);
      }
    if (
      snapshot.configuration.scenario.inputs.length >
      snapshot.configuration.limits.maxPendingOperations
    )
      throw new EvaluationFault('queue-limit', 'Initial inputs exceed the global queue budget');
    for (const input of snapshot.configuration.scenario.inputs)
      this.#queue.push({
        id: `operation_${++this.#sequence}`,
        timeMs: input.timeMs,
        sequence: this.#sequence,
        kind: 'input',
        endpoint: input.target,
        body: { type: 'input', message: input.message },
      });
  }
  #actor(tx: Transaction, endpoint: StackEndpoint): ProtocolRuntime {
    const key = stackEndpointKey(endpoint);
    let actor = tx.actors.get(key);
    if (!actor) {
      const original = this.#actors.get(key);
      if (!original) throw new Error('Unknown runtime endpoint');
      actor = original.fork();
      tx.actors.set(key, actor);
    }
    return actor;
  }
  #record(
    tx: Transaction,
    actor: ProtocolRuntime,
    kind: StackTrace['kind'],
    data: JsonValue,
    sources: readonly string[] = [],
    payloads: readonly PayloadRange[] = [],
    portId?: string,
    linkId?: string,
  ): string {
    const sequence = this.#data.store.usage.traceEvents + tx.trace.length;
    if (sequence >= this.snapshot.configuration.limits.maxTraceEvents)
      throw new EvaluationFault('trace-limit', 'Global trace event limit reached');
    const eventId = `event_${sequence + 1}`;
    tx.trace.push({
      schemaVersion: 2,
      mode: 'stack',
      runId: this.runId,
      eventId,
      timeMs: tx.timeMs,
      sequence,
      endpoint: actor.endpoint,
      kind,
      sourceEventIds: [...new Set(sources)],
      payloads,
      data,
      ...(portId ? { portId } : {}),
      ...(linkId ? { linkId } : {}),
    });
    return eventId;
  }
  #syncPending(tx: Transaction, owner: string): void {
    const entries = tx.pending.get(owner) ?? [];
    stackValue(
      this.#data.store.setOwner(
        { id: owner, kind: 'port' },
        entries.flatMap((entry) => entry.payload.ranges),
        entries.reduce((sum, entry) => sum + entry.payload.bytes, 0),
      ),
    );
  }
  #enqueue(
    tx: Transaction,
    endpoint: StackEndpoint,
    timeMs: number,
    body: OperationBody,
    payload?: StoredPayload,
    portId?: string,
  ): void {
    if (!Number.isSafeInteger(timeMs) || timeMs < tx.timeMs)
      throw new EvaluationFault('time-range', 'Invalid scheduled virtual time');
    if (
      this.#queue.size + tx.operations.length >=
      this.snapshot.configuration.limits.maxPendingOperations
    )
      throw new EvaluationFault('queue-limit', 'Global pending operation limit reached');
    const sequence = ++tx.sequence;
    const id = `operation_${sequence}`;
    const owner = `${stackEndpointKey(endpoint)}/${portId ?? 'network'}/pending`;
    if (payload) {
      tx.pending.set(owner, [...(tx.pending.get(owner) ?? []), { id, payload }]);
      this.#syncPending(tx, owner);
    }
    tx.operations.push({
      id,
      endpoint,
      timeMs,
      sequence,
      kind: body.type === 'timer' ? 'timer' : body.type === 'input' ? 'input' : 'delivery',
      body,
      ...(payload ? { hold: { owner, payload } } : {}),
    });
  }
  #syncActor(actor: ProtocolRuntime, fragments: readonly ByteFragment[]): void {
    const key = stackEndpointKey(actor.endpoint);
    const values = this.#data.variables(actor.protocol, actor.variables);
    const byteVariables = new Set(
      stackProtocolBody(actor.protocol)
        .variables.filter((variable) => variable.type === 'bytes')
        .map((variable) => variable.id),
    );
    let retainedBytes = values.ranges.reduce((sum, range) => sum + range.length, 0);
    for (const [id, value] of Object.entries(actor.variables)) {
      if (byteVariables.has(id)) continue;
      if (typeof value === 'string') retainedBytes += new TextEncoder().encode(value).length;
      else if (value !== null && typeof value === 'object')
        retainedBytes += new TextEncoder().encode(JSON.stringify(value)).length;
    }
    stackValue(
      this.#data.store.setOwner(
        { id: `${key}/variables`, kind: 'provider' },
        actor.outcome === 'error' ? [] : values.ranges,
        actor.outcome === 'error' ? 0 : retainedBytes,
      ),
    );
    stackValue(
      this.#data.store.setOwner(
        { id: `${key}/codec`, kind: 'codec' },
        actor.outcome === 'error' ? [] : fragments.map((fragment) => fragment.range),
      ),
    );
  }
  #indicate(
    tx: Transaction,
    actor: ProtocolRuntime,
    operation: 'read' | 'receive' | 'failed' | 'closed',
    source: string,
    value?: JsonValue,
    origins: readonly ByteOrigin[] = [],
  ): void {
    const port = providedStackPort(actor.protocol);
    const target = this.#router.upper(actor.endpoint);
    if (!port || !target) throw new Error('Validated upper route is absent');
    const payload = value !== undefined ? this.#data.payload(port.service, value) : undefined;
    const provenance = this.#data.origins(origins);
    const id = this.#record(
      tx,
      actor,
      'service-indication',
      {
        operation,
        target,
        sourceRanges: provenance.rows,
        ...(payload ? { payload: payload.traced } : {}),
      },
      [source, ...provenance.sources],
      [...(payload?.ranges ?? []), ...provenance.ranges],
      port.id,
    );
    this.#enqueue(
      tx,
      target,
      tx.timeMs,
      { type: 'indication', port: target, operation, source: id, ...(payload ? { payload } : {}) },
      payload,
      target.portId,
    );
  }
  #fault(tx: Transaction, actor: ProtocolRuntime, fault: EvaluationFault, source: string): void {
    actor.fail(tx.timeMs);
    tx.fragments.set(stackEndpointKey(actor.endpoint), []);
    const diagnostic = {
      path: `/instances/${stackEndpointKey(actor.endpoint)}`,
      code: fault.code,
      message: fault.message,
    };
    tx.diagnostics.push(diagnostic);
    const id = this.#record(tx, actor, 'diagnostic', diagnostic, [source]);
    const upper = this.#router.upper(actor.endpoint);
    if (upper) {
      this.#actor(tx, upper).tainted = true;
      const port = providedStackPort(actor.protocol);
      if (actor.provides === 'ready' && port?.lifecycle.notifications.includes('failed')) {
        actor.provides = 'failed';
        this.#indicate(tx, actor, 'failed', id);
      }
    }
  }
  #draw(): number {
    let value = this.#draws[this.#drawPosition];
    if (value === undefined) {
      value = this.#random();
      this.#draws.push(value);
    }
    this.#drawPosition++;
    return value;
  }
  #checkDecision(
    value: DatagramDecision,
    timeMs: number,
    transmission: number,
    actor: ProtocolRuntime,
  ): void {
    if (
      value.transmission !== transmission ||
      value.direction !== (actor.endpoint.participant === 'A' ? 'AtoB' : 'BtoA') ||
      !['drop-targeted', 'drop-random', 'duplicate', 'deliver'].includes(value.outcome) ||
      value.draws.length > 4 ||
      value.draws.some((draw) => !Number.isFinite(draw) || draw < 0 || draw >= 1) ||
      value.deliveries.length > 2
    )
      throw new Error('Environment planner returned an invalid decision');
    for (const delivery of value.deliveries)
      if (
        !Number.isSafeInteger(delivery.timeMs) ||
        delivery.timeMs < timeMs ||
        !['original', 'duplicate'].includes(delivery.copy)
      )
        throw new Error('Environment planner returned an invalid delivery');
  }
  #effects(
    tx: Transaction,
    actor: ProtocolRuntime,
    transition: PreparedTransition,
    source: string,
  ): void {
    for (const effect of transition.effects) {
      if (effect.kind === 'timer') {
        const id = this.#record(
          tx,
          actor,
          'timer',
          {
            operation: effect.operation,
            timerId: effect.timerId,
            generation: effect.generation,
            due: effect.due,
            ruleId: transition.ruleId,
          },
          [source],
        );
        if (effect.operation === 'start')
          this.#enqueue(tx, actor.endpoint, effect.due, {
            type: 'timer',
            timerId: effect.timerId,
            generation: effect.generation,
            source: id,
          });
      } else if (effect.kind === 'deliver') {
        actor.delivered.push({ message: effect.message, timeMs: tx.timeMs });
        const message = this.#data.message(actor.protocol, effect.message);
        this.#record(
          tx,
          actor,
          'deliver',
          { message: message.value, ruleId: transition.ruleId },
          [source],
          message.ranges,
        );
      } else if (effect.kind === 'service-indicate')
        this.#indicate(tx, actor, effect.operation, source, effect.payload, effect.origins);
      else {
        const port = actor.protocol.requires;
        const payload = this.#data.payload(port.service, effect.payload);
        const message = this.#data.message(actor.protocol, effect.message);
        const provenance = Object.entries(effect.fieldOrigins).map(
          ([id, origins]) => [id, this.#data.origins(origins)] as const,
        );
        const sent = this.#record(
          tx,
          actor,
          'send',
          {
            message: message.value,
            wire: payload.traced,
            ruleId: transition.ruleId,
            fieldSources: Object.fromEntries(provenance.map(([id, data]) => [id, data.rows])),
          },
          [source, ...provenance.flatMap(([, data]) => data.sources)],
          [...payload.ranges, ...message.ranges, ...provenance.flatMap(([, data]) => data.ranges)],
          port.id,
        );
        const target = this.#router.lower(actor.endpoint) ?? this.#router.peer(actor.endpoint);
        const requested = this.#record(
          tx,
          actor,
          'service-request',
          { operation: port.request, target, payload: payload.traced },
          [sent],
          payload.ranges,
          port.id,
        );
        const accepted = this.#record(
          tx,
          actor,
          'service-accepted',
          { operation: port.request, target },
          [requested],
          payload.ranges,
          port.id,
        );
        if (this.#router.lower(actor.endpoint))
          this.#enqueue(
            tx,
            target,
            tx.timeMs,
            { type: 'request', port: target, payload, source: accepted },
            payload,
            target.portId,
          );
        else {
          const transmission = ++tx.transmissions[actor.endpoint.participant];
          const decision = this.#planner(
            this.snapshot.configuration.link.environment,
            actor.endpoint.participant,
            tx.timeMs,
            transmission,
            () => this.#draw(),
          );
          this.#checkDecision(decision, tx.timeMs, transmission, actor);
          const environment = this.#record(
            tx,
            actor,
            'environment',
            { operation: 'datagram-decision', ...decision },
            [accepted],
            [],
            port.id,
            this.snapshot.configuration.link.id,
          );
          for (const delivery of decision.deliveries)
            this.#enqueue(
              tx,
              target,
              delivery.timeMs,
              {
                type: 'wire',
                payload,
                sources: [sent, environment],
                copy: delivery.copy,
                transmission,
              },
              payload,
              target.portId,
            );
        }
      }
    }
  }
  #handle(tx: Transaction, actor: ProtocolRuntime, trigger: RuntimeTrigger, source: string): void {
    if (failed(actor)) return;
    let transition: PreparedTransition;
    try {
      transition = actor.prepare(trigger, tx.timeMs);
    } catch (error) {
      if (!(error instanceof EvaluationFault) || isLimit(error.code)) throw error;
      this.#fault(tx, actor, error, source);
      return;
    }
    this.#effects(tx, actor, transition, source);
    actor.apply(transition);
    const before = this.#data.variables(actor.protocol, transition.before.variables);
    const after = this.#data.variables(actor.protocol, actor.variables);
    const provenance = [...transition.assignedBytes].map(
      (id) => [id, this.#data.origins(transition.byteOrigins[id] ?? [])] as const,
    );
    const committed = this.#record(
      tx,
      actor,
      'transition',
      {
        ruleId: transition.ruleId,
        trigger: trigger.event,
        before: { stateId: transition.before.stateId, variables: before.value },
        after: { stateId: actor.stateId, variables: after.value },
        timers: [...actor.timers].map(([timerId, timer]) => ({ timerId, ...timer })),
        outcome: actor.outcome,
        ignored: transition.ignored,
        byteSources: Object.fromEntries(provenance.map(([id, value]) => [id, value.rows])),
        ports: {
          requires: actor.requires,
          ...(actor.provides ? { provides: actor.provides } : {}),
        },
      },
      [source, ...provenance.flatMap(([, value]) => value.sources)],
      [...before.ranges, ...after.ranges, ...provenance.flatMap(([, value]) => value.ranges)],
    );
    for (const id of transition.assignedBytes) {
      const value = actor.variables[id];
      if (value !== undefined) {
        const range = this.#data.bytes(value);
        actor.byteOrigins[id] = range.length
          ? [
              {
                sourceEventId: committed,
                range,
                valueOffset: 0,
                sourceOffset: 0,
                length: range.length,
              },
            ]
          : [];
      }
    }
  }
  #receive(
    tx: Transaction,
    actor: ProtocolRuntime,
    payload: StoredPayload,
    sources: readonly string[],
    extra: JsonValue,
  ): void {
    const received = this.#record(
      tx,
      actor,
      'receive',
      { wire: payload.traced, context: extra },
      sources,
      payload.ranges,
      actor.protocol.requires.id,
    );
    if (failed(actor)) return;
    const key = stackEndpointKey(actor.endpoint);
    const fragments = tx.fragments.get(key) ?? [];
    const stream = actor.protocol.requires.service.kind === 'stream';
    if (stream)
      for (const range of payload.ranges)
        if (range.length) fragments.push({ range, sourceEventId: received });
    tx.fragments.set(key, fragments);
    let decoded: ReturnType<ProtocolRuntime['codec']['receive']>;
    try {
      decoded = actor.codec.receive(payload.value);
    } catch (error) {
      if (!(error instanceof EvaluationFault) || isLimit(error.code)) throw error;
      this.#fault(tx, actor, error, received);
      return;
    }
    for (const [index, message] of decoded.messages.entries()) {
      if (failed(actor)) break;
      const used = stream ? this.#data.consume(fragments, decoded.frameBytes[index] ?? 0) : [];
      const traced = this.#data.message(actor.protocol, message);
      const parsed = this.#record(
        tx,
        actor,
        'parsed',
        {
          message: traced.value,
          sourceRanges: used.map((fragment) => ({
            ...fragment.range,
            sourceEventId: fragment.sourceEventId,
          })),
        },
        stream ? used.map((fragment) => fragment.sourceEventId) : [received],
        [...used.map((fragment) => fragment.range), ...traced.ranges],
      );
      this.#handle(
        tx,
        actor,
        {
          event: { kind: 'receive', messageId: message.messageId },
          message,
          byteFields: Object.fromEntries(
            stackProtocolBody(actor.protocol)
              .messages.find((definition) => definition.id === message.messageId)
              ?.fields.filter((field) => field.type === 'bytes')
              .map((field) => {
                const value = message.values[field.id];
                const range = value !== undefined ? this.#data.bytes(value) : undefined;
                return [
                  field.id,
                  range?.length
                    ? [
                        {
                          sourceEventId: parsed,
                          range,
                          valueOffset: 0,
                          sourceOffset: 0,
                          length: range.length,
                        },
                      ]
                    : [],
                ];
              }) ?? [],
          ),
        },
        parsed,
      );
    }
    if (decoded.diagnostics.length && !failed(actor)) {
      const first = decoded.diagnostics[0];
      if (first) {
        if (isLimit(first.code)) throw new EvaluationFault(first.code, first.message);
        this.#fault(tx, actor, new EvaluationFault(first.code, first.message), received);
      }
    }
    if (
      !failed(actor) &&
      stream &&
      fragments.reduce((sum, fragment) => sum + fragment.range.length, 0) !==
        actor.codec.bufferedBytes
    )
      throw new Error('Codec/source byte accounting diverged');
  }
  #process(tx: Transaction, operation: Operation): void {
    const actor = this.#actor(tx, operation.endpoint);
    const body = operation.body;
    if (body.type === 'input') {
      const message = stackValue(
        validateStackMessage(
          stackProtocolBody(actor.protocol),
          body.message,
          actor.limits.maxMessageBytes,
        ),
      );
      const data = this.#data.message(actor.protocol, message);
      const id = this.#record(tx, actor, 'input', { message: data.value }, [], data.ranges);
      this.#handle(
        tx,
        actor,
        { event: { kind: 'input', messageId: message.messageId }, message },
        id,
      );
    } else if (body.type === 'timer') {
      const timer = actor.timers.get(body.timerId);
      if (timer) timer.active = false;
      const id = this.#record(
        tx,
        actor,
        'timer',
        { operation: 'expire', timerId: body.timerId, generation: body.generation },
        [body.source],
      );
      this.#handle(tx, actor, { event: { kind: 'timer', timerId: body.timerId } }, id);
    } else if (body.type === 'request') {
      const port = providedStackPort(actor.protocol);
      if (!port) throw new Error('Validated provider port is missing');
      const id = this.#record(
        tx,
        actor,
        'service-received',
        { direction: 'request', operation: port.request, payload: body.payload.traced },
        [body.source],
        body.payload.ranges,
        port.id,
      );
      this.#handle(
        tx,
        actor,
        {
          event: { kind: 'service-request', portId: port.id, operation: port.request },
          payload: body.payload.value,
          payloadOrigins: body.payload.ranges.map((range) => ({
            sourceEventId: id,
            range,
            valueOffset: 0,
            sourceOffset: 0,
            length: range.length,
          })),
        },
        id,
      );
    } else if (body.type === 'wire')
      this.#receive(tx, actor, body.payload, body.sources, {
        linkId: this.snapshot.configuration.link.id,
        transmission: body.transmission,
        copy: body.copy,
      });
    else {
      const id = this.#record(
        tx,
        actor,
        'service-received',
        {
          direction: 'indication',
          operation: body.operation,
          ...(body.payload ? { payload: body.payload.traced } : {}),
        },
        [body.source],
        body.payload?.ranges ?? [],
        body.port.portId,
      );
      const event: StackRuleEvent = {
        kind: 'service-indication',
        portId: body.port.portId,
        operation: body.operation,
      };
      if (body.operation === 'read' || body.operation === 'receive') {
        if (!body.payload) throw new Error('Data indication is missing its payload');
        if (actor.hasEvent(event))
          this.#handle(
            tx,
            actor,
            {
              event,
              payload: body.payload.value,
              payloadOrigins: body.payload.ranges.map((range) => ({
                sourceEventId: id,
                range,
                valueOffset: 0,
                sourceOffset: 0,
                length: range.length,
              })),
            },
            id,
          );
        this.#receive(tx, actor, body.payload, [id], { serviceOperation: body.operation });
      } else {
        actor.requires = body.operation;
        const connection = this.#record(
          tx,
          actor,
          'connection',
          { state: body.operation },
          [id],
          [],
          body.port.portId,
        );
        if (body.operation === 'closed') {
          const finished = actor.codec.finish();
          const first = finished.diagnostics[0];
          if (first) {
            this.#fault(tx, actor, new EvaluationFault(first.code, first.message), connection);
            return;
          }
        } else actor.codec.abort();
        tx.fragments.set(stackEndpointKey(actor.endpoint), []);
        this.#handle(
          tx,
          actor,
          { event: actor.hasEvent(event) ? event : { kind: 'connection', state: body.operation } },
          connection,
        );
      }
    }
  }
  #halt(status: StackStatus, diagnostic?: ModelDiagnostic): void {
    if (ended(this.#status)) return;
    this.#status = status;
    if (diagnostic) this.#diagnostics.push(diagnostic);
    this.#queue.clear();
    this.#pending.clear();
    this.#fragments.clear();
    for (const actor of this.#actors.values()) {
      actor.codec.abort();
      for (const timer of actor.timers.values()) {
        if (timer.active) {
          timer.active = false;
          timer.generation++;
        }
      }
    }
    this.#data.store.clearLive();
    this.#data.collect();
  }
  #advance(): void {
    const next = this.#queue.peek();
    const end = this.snapshot.configuration.scenario.observationMs;
    if (!next || next.timeMs > end) {
      this.#timeMs = end;
      this.#halt('completed');
      return;
    }
    if (this.#processed >= this.snapshot.configuration.limits.maxEvents) {
      this.#halt('limit-reached', {
        path: '/limits/maxEvents',
        code: 'operation-limit',
        message: 'Global processed operation limit reached',
      });
      return;
    }
    const operation = this.#queue.take();
    if (!operation) return;
    this.#processed++;
    if (operation.body.type === 'timer') {
      const timer = this.#actors
        .get(stackEndpointKey(operation.endpoint))
        ?.timers.get(operation.body.timerId);
      if (!timer?.active || timer.generation !== operation.body.generation) return;
    }
    const reservation = this.#data.store.beginReservation();
    const restoreData = this.#data.checkpoint();
    const draws = this.#drawPosition;
    const tx: Transaction = {
      timeMs: operation.timeMs,
      actors: new Map(),
      fragments: new Map([...this.#fragments].map(([key, values]) => [key, [...values]])),
      pending: new Map(this.#pending),
      operations: [],
      trace: [],
      diagnostics: [],
      transmissions: { ...this.#transmissions },
      sequence: this.#sequence,
    };
    try {
      if (operation.hold) {
        tx.pending.set(
          operation.hold.owner,
          (tx.pending.get(operation.hold.owner) ?? []).filter((entry) => entry.id !== operation.id),
        );
        this.#syncPending(tx, operation.hold.owner);
      }
      this.#process(tx, operation);
      for (const actor of tx.actors.values())
        this.#syncActor(actor, tx.fragments.get(stackEndpointKey(actor.endpoint)) ?? []);
      stackValue(this.#data.store.appendTrace(tx.trace));
      reservation.commit();
      for (const [key, actor] of tx.actors) this.#actors.set(key, actor);
      this.#fragments = tx.fragments;
      this.#pending = tx.pending;
      this.#sequence = tx.sequence;
      this.#transmissions = tx.transmissions;
      this.#diagnostics.push(...tx.diagnostics);
      this.#timeMs = tx.timeMs;
      for (const queued of tx.operations) this.#queue.push(queued);
      this.#data.collect();
    } catch (error) {
      reservation.rollback();
      restoreData();
      this.#drawPosition = draws;
      this.#halt(
        error instanceof EvaluationFault && isLimit(error.code) ? 'limit-reached' : 'engine-error',
        {
          path: `/instances/${stackEndpointKey(operation.endpoint)}`,
          code: error instanceof EvaluationFault ? error.code : 'engine-exception',
          message: error instanceof Error ? error.message : 'Unexpected stack execution error',
        },
      );
    }
  }
  #expectations(): readonly StackVerdict[] {
    return this.snapshot.configuration.scenario.expectations.map((expectation) => {
      const actor = this.#actors.get(stackEndpointKey(expectation.target));
      if (!actor || this.#status !== 'completed' || actor.tainted || actor.outcome === 'error')
        return {
          expectationId: expectation.id,
          status: 'undetermined',
          detail: 'Observation incomplete or this instance depends on a protocol error',
        };
      let pass = false;
      switch (expectation.kind) {
        case 'state':
          pass = actor.stateId === expectation.stateId;
          break;
        case 'delivery-count':
          pass =
            actor.delivered.filter((item) => item.message.messageId === expectation.messageId)
              .length === expectation.count;
          break;
        case 'completion-before':
          pass =
            actor.outcome === 'success' &&
            actor.finishedAt !== null &&
            actor.finishedAt <= expectation.timeMs;
          break;
        case 'delivered-values': {
          const expected = stackValue(
            validateStackMessage(
              stackProtocolBody(actor.protocol),
              expectation.message,
              actor.limits.maxMessageBytes,
            ),
          );
          pass = actor.delivered.some((item) => equalJson(item.message, expected));
          break;
        }
      }
      return {
        expectationId: expectation.id,
        status: pass ? 'pass' : 'fail',
        detail: pass ? 'Expected condition observed' : 'Expected condition not observed',
      };
    });
  }
  /** Read committed immutable artifacts without copying runtime states for a debugger observer. */
  readArtifacts(): import('../domain/stack-model.ts').RunArtifacts {
    return this.#data.store.capture().artifacts;
  }
  /** Return a detached immutable view with all runtime instances. */
  view(): StackView {
    const data = this.#data.store.capture();
    return freezeOwned({
      schemaVersion: 2,
      mode: 'stack',
      runId: this.runId,
      status: this.#status,
      timeMs: this.#timeMs,
      processedOperations: this.#processed,
      pendingOperations: this.#queue.size,
      instances: Object.fromEntries(
        [...this.#actors].map(([key, actor]) => [
          key,
          {
            ...structuredClone(actor.view()),
            buffers: {
              codecBytes: this.#data.store.ownerBytes(`${key}/codec`),
              variableBytes: this.#data.store.ownerBytes(`${key}/variables`),
              portBytes: [actor.protocol.requires.id, providedStackPort(actor.protocol)?.id]
                .filter((id): id is string => id !== undefined)
                .reduce((sum, id) => sum + this.#data.store.ownerBytes(`${key}/${id}/pending`), 0),
            },
          },
        ]),
      ),
      events: data.trace,
      artifacts: data.artifacts,
      usage: this.#data.store.usage,
      diagnostics: [...this.#diagnostics],
      expectations: this.#expectations(),
      snapshot: this.snapshot,
    });
  }
  /** Process finite queue operations; observer failures pause after commit without failing the engine. */
  runBatch(budget = 100, stopAfter?: (events: readonly StackTrace[]) => boolean): StackView {
    if (!Number.isSafeInteger(budget) || budget < 1)
      throw new RangeError('Batch budget must be positive');
    if (this.#busy) throw new Error('Stack execution is already running');
    if (ended(this.#status)) return this.view();
    this.#busy = true;
    this.#status = 'running';
    try {
      for (let index = 0; index < budget && this.#status === 'running'; index++) {
        const count = this.#data.store.usage.traceEvents;
        this.#advance();
        if (
          stopAfter &&
          this.#data.store.usage.traceEvents > count &&
          stopAfter(this.#data.store.capture().trace.slice(count))
        )
          break;
      }
    } finally {
      if (this.#status === 'running') this.#status = 'paused';
      this.#busy = false;
    }
    return this.view();
  }
  /** Process one atomic queue operation, including every frame produced by that operation. */
  step(): StackView {
    return this.runBatch(1);
  }
  /** Run until the observation horizon or a finite terminal limit. */
  run(): StackView {
    return this.runBatch(this.snapshot.configuration.limits.maxEvents + 1);
  }
  /** Pause while retaining the shared queue, runtime buffers and random position. */
  pause(): StackView {
    if (!ended(this.#status)) this.#status = 'paused';
    return this.view();
  }
  /** End this run and free live ownership while retaining all committed record artifacts. */
  cancel(): StackView {
    this.#halt('cancelled');
    return this.view();
  }
  /** Inspect completion without serializing the captured trace or artifacts. */
  get terminal(): boolean {
    return ended(this.#status);
  }
  /** Return a captured result only after completion, cancellation or an explicit failure. */
  result(): StackView | undefined {
    return ended(this.#status) ? this.view() : undefined;
  }
}
