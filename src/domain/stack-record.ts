import type { JsonValue } from './execution-contract.ts';
import { freezeOwned } from './immutable-data.ts';
import { parseJsonData, Reader } from './model-validation.ts';
import type { ValidationResult } from './protocol-model.ts';
import { deserializeBytes, parseBytesValue, serializeBytes } from './stack-bytes.ts';
import {
  type PayloadRange,
  type RunArtifacts,
  STACK_POLICY,
  type StackEndpoint,
  type StackProtocol,
  type StackSnapshot,
  stackProtocolBody,
} from './stack-model.ts';
import { parseStackTrace } from './stack-payloads.ts';
import { providedStackPort, validateStackMessage } from './stack-protocol-validation.ts';
import type { StackView } from './stack-runtime-model.ts';
import { canonicalStackJson } from './stack-series-model.ts';
import { parseStackExperiment } from './stack-validation.ts';
import { WORKSPACE_POLICY } from './workspace-model.ts';

/** Build a stable instance key without treating a per-run event ID as an endpoint identity. */
export function stackTarget(endpoint: StackEndpoint): string {
  return `${endpoint.participant}/${endpoint.instanceId}`;
}
/** Read an object from already validated JSON without coercing arrays or scalar values. */
export function stackObject(value: unknown): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}
/** Resolve an exact definition revision from a frozen stack snapshot. */
export function stackProtocolAt(snapshot: StackSnapshot, endpoint: StackEndpoint): StackProtocol {
  const instance = snapshot.configuration.nodes[endpoint.participant]?.instances.find(
    (item) => item.id === endpoint.instanceId,
  );
  const protocol = snapshot.configuration.definitions.find(
    (item) => item.id === instance?.definition.id && item.revision === instance.definition.revision,
  );
  if (!protocol) throw new Error(`Missing snapshot endpoint ${stackTarget(endpoint)}`);
  return protocol;
}
/** Keep unknown engine/random versions readable while fencing all computation and reruns. */
export function stackRecordCompatibility(snapshot: StackSnapshot): string | undefined {
  return snapshot.engineVersion !== STACK_POLICY.engineVersion ||
    snapshot.randomAlgorithm !== STACK_POLICY.randomAlgorithm
    ? '지원하지 않는 스택 실행 버전입니다. 원본 보관/내보내기만 가능합니다.'
    : undefined;
}
/** Validate a historical snapshot structurally without claiming a future engine can execute it. */
export function parseRecordedStackSnapshot(value: unknown): ValidationResult<StackSnapshot> {
  const json = parseJsonData(value);
  if (!json.success) return json;
  const r = new Reader();
  const node = r.object(value, '', [
    'schemaVersion',
    'mode',
    'engineVersion',
    'randomAlgorithm',
    'configuration',
  ]);
  if (!node) return { success: false, diagnostics: r.diagnostics };
  r.choice(node.schemaVersion, '/schemaVersion', [2]);
  r.choice(node.mode, '/mode', ['stack']);
  r.text(node.engineVersion, '/engineVersion', true);
  r.text(node.randomAlgorithm, '/randomAlgorithm', true);
  const parsed = parseStackExperiment(node.configuration);
  if (!parsed.success)
    r.diagnostics.push(
      ...parsed.diagnostics.map((d) => ({ ...d, path: `/configuration${d.path}` })),
    );
  return r.result(value as StackSnapshot);
}
/** Copy one explicitly typed range; the optional event ranges forbid unobserved byte reads. */
export function stackRangeBytes(
  artifacts: RunArtifacts,
  range: PayloadRange,
  allowed?: readonly PayloadRange[],
): Uint8Array {
  if (
    allowed &&
    !allowed.some(
      (item) =>
        item.payloadId === range.payloadId &&
        range.offset >= item.offset &&
        range.length >= 0 &&
        range.offset + range.length <= item.offset + item.length,
    )
  )
    throw new Error('Byte range is outside this observation');
  const entry = artifacts.payloads.find((item) => item.payloadId === range.payloadId);
  if (
    !entry ||
    !Number.isSafeInteger(range.offset) ||
    !Number.isSafeInteger(range.length) ||
    range.offset < 0 ||
    range.length < 0 ||
    range.offset > entry.bytes.byteLength - range.length
  )
    throw new Error('Invalid record-local byte range');
  const parsed = deserializeBytes(entry.bytes, STACK_POLICY.maxPayloadBytes);
  if (!parsed.success) throw new Error('Invalid artifact bytes');
  return parsed.value.slice(range.offset, range.offset + range.length);
}
/** Hydrate only a declared bytes value, leaving byte-like user JSON untouched. */
export function stackRecordedBytes(
  value: JsonValue,
  artifacts: RunArtifacts,
  allowed?: readonly PayloadRange[],
): JsonValue {
  const range = stackObject(value);
  if (range.kind !== 'payload-range') throw new Error('Expected typed payload range');
  return serializeBytes(stackRangeBytes(artifacts, range as unknown as PayloadRange, allowed));
}

/** Stage a complete saved view, validating endpoints, commits, messages and all actual byte references. */
export function parseStackView(value: unknown): ValidationResult<StackView> {
  const json = parseJsonData(value, { maxNodes: WORKSPACE_POLICY.maxJsonNodes, maxDepth: 128 });
  if (!json.success) return json;
  if (new TextEncoder().encode(JSON.stringify(value)).length > WORKSPACE_POLICY.maxBytes)
    return {
      success: false,
      diagnostics: [
        {
          path: '/',
          code: 'record-size',
          message: 'Saved view exceeds the shared workspace budget',
        },
      ],
    };
  const r = new Reader();
  const node = r.object(value, '', [
    'schemaVersion',
    'mode',
    'runId',
    'status',
    'timeMs',
    'processedOperations',
    'pendingOperations',
    'instances',
    'events',
    'artifacts',
    'usage',
    'diagnostics',
    'expectations',
    'snapshot',
  ]);
  if (!node) return { success: false, diagnostics: r.diagnostics };
  const snapshot = parseRecordedStackSnapshot(node.snapshot);
  if (!snapshot.success) return snapshot;
  const config = snapshot.value.configuration;
  r.choice(node.schemaVersion, '/schemaVersion', [2]);
  r.choice(node.mode, '/mode', ['stack']);
  r.text(node.runId, '/runId', true);
  r.choice(node.status, '/status', [
    'idle',
    'running',
    'paused',
    'completed',
    'cancelled',
    'limit-reached',
    'engine-error',
  ]);
  r.number(node.timeMs, '/timeMs', 0, config.scenario.observationMs);
  r.number(node.processedOperations, '/processedOperations', 0, config.limits.maxEvents);
  r.number(node.pendingOperations, '/pendingOperations', 0, config.limits.maxPendingOperations);
  if (node.status === 'completed' && node.timeMs !== config.scenario.observationMs)
    r.issue('/timeMs', 'record-horizon', 'Completed observation must reach its frozen horizon');
  if (
    ['completed', 'cancelled', 'limit-reached', 'engine-error'].includes(String(node.status)) &&
    node.pendingOperations !== 0
  )
    r.issue(
      '/pendingOperations',
      'record-cleanup',
      'Terminal runs cannot retain live queue operations',
    );
  const trace = parseStackTrace(node.events, node.artifacts, config.limits);
  if (!trace.success) return trace;
  const artifacts = node.artifacts as RunArtifacts;
  const pool = new Map(
    artifacts.payloads.map((entry) => [entry.payloadId, entry.bytes.byteLength]),
  );
  const checkReference = (value: unknown, allowed: readonly PayloadRange[]) => {
    const range = stackObject(value) as unknown as PayloadRange;
    const size = pool.get(range.payloadId);
    if (
      size === undefined ||
      !Number.isSafeInteger(range.offset) ||
      !Number.isSafeInteger(range.length) ||
      range.offset < 0 ||
      range.length < 0 ||
      range.offset > size - range.length ||
      !allowed.some(
        (a) =>
          a.payloadId === range.payloadId &&
          range.offset >= a.offset &&
          range.offset + range.length <= a.offset + a.length,
      )
    )
      throw new Error('Range is outside this event or record');
  };
  const endpoints = (['A', 'B'] as const).flatMap((participant) =>
    config.nodes[participant].instances.map((i) => ({ participant, instanceId: i.id })),
  );
  function variables(
    input: unknown,
    protocol: StackProtocol,
    path: string,
    ranges?: readonly PayloadRange[],
  ) {
    const declarations = stackProtocolBody(protocol).variables;
    const values = r.object(
      input,
      path,
      declarations.map((v) => v.id),
      declarations.map((v) => v.id),
    );
    if (!values) return;
    for (const v of declarations) {
      const current = values[v.id] as JsonValue;
      try {
        if (v.type === 'bytes') {
          if (ranges) {
            if (stackObject(current).kind !== 'payload-range')
              throw new Error('Expected bytes range');
            checkReference(current, ranges);
            if (Number(stackObject(current).length) > config.limits.maxMessageBytes)
              throw new Error('Bytes variable limit');
          } else if (!parseBytesValue(current, config.limits.maxMessageBytes).success)
            throw new Error('Invalid bytes variable');
        } else if (
          v.type !== 'json' &&
          (v.type === 'integer' ? !Number.isSafeInteger(current) : typeof current !== v.type)
        )
          throw new Error('Invalid variable type');
      } catch (error) {
        r.issue(`${path}/${v.id}`, 'record-variable', String(error));
      }
    }
  }
  function timers(input: unknown, protocol: StackProtocol, path: string) {
    const ids = new Set<string>();
    r.array(input, path, (value, location) => {
      const timer = r.object(value, location, ['timerId', 'generation', 'active', 'due']);
      if (!timer) return;
      if (
        !stackProtocolBody(protocol).timers.some((t) => t.id === timer.timerId) ||
        ids.has(String(timer.timerId))
      )
        r.issue(location, 'record-timer', 'Unknown or repeated timer');
      ids.add(String(timer.timerId));
      r.number(timer.generation, `${location}/generation`);
      r.number(timer.due, `${location}/due`);
      r.choice(timer.active, `${location}/active`, [true, false]);
    });
    if (ids.size !== stackProtocolBody(protocol).timers.length)
      r.issue(path, 'record-timer', 'Missing declared timer');
  }
  function ports(input: unknown, protocol: StackProtocol, path: string) {
    const keys = ['requires', ...(providedStackPort(protocol) ? ['provides'] : [])];
    const values = r.object(input, path, keys, keys);
    if (values)
      for (const key of keys)
        r.choice(values[key], `${path}/${key}`, ['ready', 'failed', 'closed']);
  }
  const instances = r.object(
    node.instances,
    '/instances',
    endpoints.map(stackTarget),
    endpoints.map(stackTarget),
  );
  if (instances)
    for (const endpoint of endpoints) {
      const key = stackTarget(endpoint);
      const actor = r.object(instances[key], `/instances/${key}`, [
        'endpoint',
        'stateId',
        'variables',
        'outcome',
        'finishedAt',
        'tainted',
        'timers',
        'ports',
      ]);
      if (!actor) continue;
      const protocol = stackProtocolAt(snapshot.value, endpoint);
      if (canonicalStackJson(actor.endpoint) !== canonicalStackJson(endpoint))
        r.issue(
          `/instances/${key}/endpoint`,
          'record-endpoint',
          'Endpoint differs from instance key',
        );
      r.choice(
        actor.stateId,
        `/instances/${key}/stateId`,
        stackProtocolBody(protocol).states.map((s) => s.id),
      );
      r.choice(actor.outcome, `/instances/${key}/outcome`, [
        'active',
        'success',
        'failure',
        'error',
      ]);
      r.choice(actor.tainted, `/instances/${key}/tainted`, [true, false]);
      if (actor.finishedAt !== null)
        r.number(actor.finishedAt, `/instances/${key}/finishedAt`, 0, Number(node.timeMs));
      variables(actor.variables, protocol, `/instances/${key}/variables`);
      timers(actor.timers, protocol, `/instances/${key}/timers`);
      ports(actor.ports, protocol, `/instances/${key}/ports`);
    }
  const eventMap = new Map(trace.value.map((event) => [event.eventId, event]));
  const committed = new Map(
    endpoints.map((endpoint) => {
      const body = stackProtocolBody(stackProtocolAt(snapshot.value, endpoint));
      return [
        stackTarget(endpoint),
        {
          stateId: body.initialStateId,
          variables: Object.fromEntries(body.variables.map((v) => [v.id, v.initial])) as Record<
            string,
            JsonValue
          >,
          first: true,
        },
      ];
    }),
  );
  for (const [index, event] of trace.value.entries()) {
    const path = `/events/${index}`;
    if (event.runId !== node.runId || event.timeMs > Number(node.timeMs))
      r.issue(path, 'record-order', 'Event is outside the saved run');
    let protocol: StackProtocol;
    try {
      protocol = stackProtocolAt(snapshot.value, event.endpoint);
    } catch {
      r.issue(`${path}/endpoint`, 'record-endpoint', 'Unknown endpoint');
      continue;
    }
    if (
      event.portId &&
      ![protocol.requires.id, providedStackPort(protocol)?.id].includes(event.portId)
    )
      r.issue(`${path}/portId`, 'record-port', 'Unknown port');
    if (event.linkId && event.linkId !== config.link.id)
      r.issue(`${path}/linkId`, 'record-link', 'Unknown link');
    const data = stackObject(event.data);
    if (event.kind === 'timer') {
      r.choice(data.operation, `${path}/operation`, ['start', 'cancel', 'expire']);
      r.choice(
        data.timerId,
        `${path}/timerId`,
        stackProtocolBody(protocol).timers.map((t) => t.id),
      );
      r.number(data.generation, `${path}/generation`);
      if (data.due !== undefined) r.number(data.due, `${path}/due`);
      if (data.operation === 'start' && data.due === undefined)
        r.issue(path, 'record-timer', 'Missing timer deadline');
    }
    if (event.kind === 'connection') r.choice(data.state, `${path}/state`, ['failed', 'closed']);
    if (event.kind === 'diagnostic')
      for (const key of ['path', 'code', 'message']) r.text(data[key], `${path}/${key}`);
    if (['service-request', 'service-accepted', 'service-indication'].includes(event.kind)) {
      const target = stackObject(data.target);
      try {
        const other = stackProtocolAt(snapshot.value, target as unknown as StackEndpoint);
        if (![other.requires.id, providedStackPort(other)?.id].includes(String(target.portId)))
          throw new Error('Unknown target port');
        const binding =
          event.kind === 'service-indication'
            ? config.bindings.find((b) => stackTarget(b.provider) === stackTarget(event.endpoint))
            : config.bindings.find((b) => stackTarget(b.consumer) === stackTarget(event.endpoint));
        const expectedTarget =
          event.kind === 'service-indication'
            ? binding?.consumer
            : (binding?.provider ?? config.link[event.endpoint.participant === 'A' ? 'B' : 'A']);
        if (canonicalStackJson(expectedTarget) !== canonicalStackJson(target))
          throw new Error('Target differs from the actual binding/link');
      } catch (error) {
        r.issue(`${path}/target`, 'record-route', String(error));
      }
    }
    if (event.kind === 'transition') {
      const before = stackObject(data.before);
      const after = stackObject(data.after);
      const rule = stackProtocolBody(protocol).rules.find((rule) => rule.id === data.ruleId);
      if (
        !rule ||
        rule.fromStateId !== before.stateId ||
        rule.nextStateId !== after.stateId ||
        canonicalStackJson(rule.event) !== canonicalStackJson(data.trigger) ||
        Boolean(rule.ignore) !== data.ignored
      )
        r.issue(path, 'record-commit', 'Commit differs from the snapshot rule');
      variables(before.variables, protocol, `${path}/before/variables`, event.payloads);
      variables(after.variables, protocol, `${path}/after/variables`, event.payloads);
      timers(data.timers, protocol, `${path}/timers`);
      ports(data.ports, protocol, `${path}/ports`);
      r.choice(data.outcome, `${path}/outcome`, ['active', 'success', 'failure', 'error']);
      const direct = eventMap.get(event.sourceEventIds[0] ?? '');
      if (!direct || stackTarget(direct.endpoint) !== stackTarget(event.endpoint))
        r.issue(path, 'record-trigger', 'Missing direct same-instance trigger');
      else if (rule) {
        const trigger = rule.event;
        const origin = stackObject(direct.data);
        const message = stackObject(origin.message);
        const matched =
          trigger.kind === 'input'
            ? direct.kind === 'input' && message.messageId === trigger.messageId
            : trigger.kind === 'receive'
              ? direct.kind === 'parsed' && message.messageId === trigger.messageId
              : trigger.kind === 'timer'
                ? direct.kind === 'timer' &&
                  origin.operation === 'expire' &&
                  origin.timerId === trigger.timerId
                : trigger.kind === 'connection'
                  ? direct.kind === 'connection' && origin.state === trigger.state
                  : 'operation' in trigger &&
                    direct.portId === trigger.portId &&
                    ((direct.kind === 'service-received' &&
                      origin.operation === trigger.operation &&
                      origin.direction ===
                        (trigger.kind === 'service-request' ? 'request' : 'indication')) ||
                      (trigger.kind === 'service-indication' &&
                        direct.kind === 'connection' &&
                        origin.state === trigger.operation));
        if (!matched)
          r.issue(
            path,
            'record-trigger',
            'Declared trigger differs from the actual direct observation',
          );
      }
      const previous = committed.get(stackTarget(event.endpoint));
      if (previous) {
        const beforeValues = { ...stackObject(before.variables) };
        try {
          if (previous.first)
            for (const variable of stackProtocolBody(protocol).variables)
              if (variable.type === 'bytes')
                beforeValues[variable.id] = stackRecordedBytes(
                  beforeValues[variable.id] as JsonValue,
                  artifacts,
                  event.payloads,
                );
          if (
            previous.stateId !== before.stateId ||
            canonicalStackJson(previous.variables) !== canonicalStackJson(beforeValues)
          )
            r.issue(
              path,
              'record-continuity',
              'Commit before differs from the observed previous state/variables',
            );
        } catch (error) {
          r.issue(path, 'record-continuity', String(error));
        }
        previous.stateId = String(after.stateId);
        previous.variables = stackObject(after.variables);
        previous.first = false;
      }
    }
    if (['input', 'parsed', 'send', 'deliver'].includes(event.kind)) {
      const message = stackObject(data.message);
      const values = { ...stackObject(message.values) };
      const schema = stackProtocolBody(protocol).messages.find((m) => m.id === message.messageId);
      try {
        for (const field of schema?.fields ?? [])
          if (field.type === 'bytes' && values[field.id] !== undefined)
            values[field.id] = stackRecordedBytes(
              values[field.id] as JsonValue,
              artifacts,
              event.payloads,
            );
        const parsed = validateStackMessage(stackProtocolBody(protocol), {
          messageId: message.messageId,
          values,
        });
        if (!parsed.success)
          r.issue(path, 'record-message', 'Message differs from snapshot schema');
      } catch (error) {
        r.issue(path, 'record-message', String(error));
      }
    }
    // These fields belong to the trace contract, never arbitrary user JSON variables.
    const checkRange = (value: JsonValue) => {
      try {
        checkReference(value, event.payloads);
      } catch (error) {
        r.issue(path, 'record-range', String(error));
      }
    };
    const checkOrigin = (value: JsonValue) => {
      checkRange(value);
      const row = stackObject(value);
      const source =
        typeof row.sourceEventId === 'string' ? eventMap.get(row.sourceEventId) : undefined;
      try {
        if (
          !source ||
          source.sequence >= event.sequence ||
          !event.sourceEventIds.includes(source.eventId)
        )
          throw new Error('Origin is not an actual earlier cause');
        checkReference(row, source.payloads);
        if (
          row.valueOffset !== undefined &&
          (!Number.isSafeInteger(row.valueOffset) || Number(row.valueOffset) < 0)
        )
          throw new Error('Invalid value offset');
      } catch (error) {
        r.issue(path, 'record-origin', String(error));
      }
    };
    for (const key of ['wire', 'payload']) {
      const payload = stackObject(data[key]);
      if (payload.kind === 'bytes') checkRange(payload.range as JsonValue);
      if (payload.kind === 'packet')
        for (const field of Object.values(stackObject(stackObject(payload.packet).fields)))
          if (stackObject(field).kind === 'payload-range') checkRange(field);
    }
    for (const key of ['byteSources', 'fieldSources'])
      for (const rows of Object.values(stackObject(data[key])))
        if (Array.isArray(rows)) for (const row of rows) checkOrigin(row);
    if (Array.isArray(data.sourceRanges)) for (const row of data.sourceRanges) checkOrigin(row);
  }
  if (instances)
    for (const endpoint of endpoints) {
      const previous = committed.get(stackTarget(endpoint));
      const actor = stackObject(instances[stackTarget(endpoint)]);
      if (!previous) continue;
      const expectedValues = { ...previous.variables };
      try {
        if (!previous.first)
          for (const variable of stackProtocolBody(stackProtocolAt(snapshot.value, endpoint))
            .variables)
            if (variable.type === 'bytes')
              expectedValues[variable.id] = stackRecordedBytes(
                expectedValues[variable.id] as JsonValue,
                artifacts,
              );
        if (
          previous.stateId !== actor.stateId ||
          canonicalStackJson(expectedValues) !== canonicalStackJson(actor.variables)
        )
          r.issue(
            `/instances/${stackTarget(endpoint)}`,
            'record-final-state',
            'Saved state/variables differ from observed commits',
          );
      } catch (error) {
        r.issue('/instances', 'record-final-state', String(error));
      }
    }
  const usage = r.object(node.usage, '/usage', [
    'uniqueBytes',
    'liveBytes',
    'traceEvents',
    'artifactBytes',
  ]);
  if (usage) {
    r.number(usage.uniqueBytes, '/usage/uniqueBytes', 0, config.limits.maxPayloadBytes);
    r.number(usage.liveBytes, '/usage/liveBytes', 0, config.limits.maxLiveBytes);
    r.number(usage.artifactBytes, '/usage/artifactBytes', 0, config.limits.maxArtifactBytes);
    if (usage.traceEvents !== trace.value.length)
      r.issue('/usage/traceEvents', 'record-count', 'Trace count differs');
  }
  r.array(node.diagnostics, '/diagnostics', (value, path) => {
    const d = r.object(value, path, ['path', 'code', 'message']);
    if (d) for (const key of ['path', 'code', 'message']) r.text(d[key], `${path}/${key}`);
  });
  const verdicts = new Set<string>();
  r.array(node.expectations, '/expectations', (value, path) => {
    const verdict = r.object(value, path, ['expectationId', 'status', 'detail']);
    if (!verdict) return;
    if (
      !config.scenario.expectations.some((e) => e.id === verdict.expectationId) ||
      verdicts.has(String(verdict.expectationId))
    )
      r.issue(path, 'record-expectation', 'Unknown or repeated verdict');
    verdicts.add(String(verdict.expectationId));
    r.choice(verdict.status, `${path}/status`, ['pass', 'fail', 'undetermined']);
    r.text(verdict.detail, `${path}/detail`);
    if (node.status !== 'completed' && verdict.status !== 'undetermined')
      r.issue(path, 'record-verdict', 'Partial observation cannot assert a final verdict');
  });
  if (verdicts.size !== config.scenario.expectations.length)
    r.issue('/expectations', 'record-expectation', 'Missing verdict');
  return r.diagnostics.length
    ? { success: false, diagnostics: r.diagnostics }
    : r.result(freezeOwned(structuredClone(value as StackView)));
}
