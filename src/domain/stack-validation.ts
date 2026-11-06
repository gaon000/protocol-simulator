import { freezeOwned } from './immutable-data.ts';
import { parseJsonData, Reader } from './model-validation.ts';
import type { ValidationResult } from './protocol-model.ts';
import {
  defaultStackLimits,
  STACK_POLICY,
  type StackEndpoint,
  type StackExperiment,
  type StackLimits,
  type StackPortEndpoint,
  type StackProtocol,
  type StackSnapshot,
  stackProtocolBody,
} from './stack-model.ts';
import {
  compatibleStackServices,
  parseStackProtocol,
  providedStackPort,
  sameWireMessages,
  validateStackMessage,
} from './stack-protocol-validation.ts';

const endpointKey = (endpoint: StackEndpoint) => `${endpoint.participant}/${endpoint.instanceId}`;
const portKey = (endpoint: StackPortEndpoint) => `${endpointKey(endpoint)}/${endpoint.portId}`;

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
function endpointShape(value: unknown, path: string, r: Reader, port = false): void {
  const node = r.object(value, path, ['participant', 'instanceId', ...(port ? ['portId'] : [])]);
  if (!node) return;
  r.choice(node.participant, `${path}/participant`, ['A', 'B']);
  r.text(node.instanceId, `${path}/instanceId`, true);
  if (port) r.text(node.portId, `${path}/portId`, true);
}
function environmentShape(value: unknown, path: string, r: Reader): void {
  const env = r.object(value, path, ['schemaVersion', 'id', 'kind', 'directions', 'targetedDrops']);
  if (!env) return;
  r.choice(env.schemaVersion, `${path}/schemaVersion`, [1]);
  r.text(env.id, `${path}/id`, true);
  r.choice(env.kind, `${path}/kind`, ['datagram']);
  const directions = r.object(env.directions, `${path}/directions`, ['AtoB', 'BtoA']);
  if (directions)
    for (const key of ['AtoB', 'BtoA']) {
      const settings = r.object(directions[key], `${path}/directions/${key}`, [
        'delayMs',
        'jitterMs',
        'lossRate',
        'duplicateRate',
      ]);
      if (!settings) continue;
      for (const key2 of ['delayMs', 'jitterMs'])
        r.number(settings[key2], `${path}/directions/${key}/${key2}`);
      for (const key2 of ['lossRate', 'duplicateRate'])
        r.number(settings[key2], `${path}/directions/${key}/${key2}`, 0, 1, false);
      if (
        typeof settings.delayMs === 'number' &&
        typeof settings.jitterMs === 'number' &&
        !Number.isSafeInteger(settings.delayMs + settings.jitterMs)
      )
        r.issue(
          `${path}/directions/${key}`,
          'number-range',
          'Maximum delivery delay exceeds safe integer range',
        );
    }
  const drops = new Set<string>();
  r.array(env.targetedDrops, `${path}/targetedDrops`, (item, location) => {
    const drop = r.object(item, location, ['direction', 'transmission']);
    if (!drop) return;
    r.choice(drop.direction, `${location}/direction`, ['AtoB', 'BtoA']);
    r.number(drop.transmission, `${location}/transmission`, 1);
    const key = `${drop.direction}:${drop.transmission}`;
    if (drops.has(key)) r.issue(location, 'duplicate-drop', 'Duplicate targeted transmission');
    drops.add(key);
  });
}
function scenarioShape(value: unknown, r: Reader): void {
  const scenario = r.object(value, '/scenario', [
    'schemaVersion',
    'id',
    'observationMs',
    'inputs',
    'expectations',
  ]);
  if (!scenario) return;
  r.choice(scenario.schemaVersion, '/scenario/schemaVersion', [2]);
  r.text(scenario.id, '/scenario/id', true);
  r.number(scenario.observationMs, '/scenario/observationMs');
  r.array(scenario.inputs, '/scenario/inputs', (item, path) => {
    const input = r.object(item, path, ['id', 'timeMs', 'target', 'message'], ['message']);
    if (!input) return;
    r.text(input.id, `${path}/id`, true);
    r.number(input.timeMs, `${path}/timeMs`);
    endpointShape(input.target, `${path}/target`, r);
  });
  r.array(scenario.expectations, '/scenario/expectations', (item, path) => {
    const expectation = r.object(item, path);
    if (!expectation) return;
    const extra =
      expectation.kind === 'state'
        ? ['stateId']
        : expectation.kind === 'delivery-count'
          ? ['messageId', 'count']
          : expectation.kind === 'delivered-values'
            ? ['message']
            : ['timeMs'];
    r.object(expectation, path, ['id', 'kind', 'target', ...extra], extra);
    r.text(expectation.id, `${path}/id`, true);
    endpointShape(expectation.target, `${path}/target`, r);
    r.choice(expectation.kind, `${path}/kind`, [
      'state',
      'delivery-count',
      'delivered-values',
      'completion-before',
    ]);
    if (expectation.kind === 'state') r.text(expectation.stateId, `${path}/stateId`, true);
    if (expectation.kind === 'delivery-count') {
      r.text(expectation.messageId, `${path}/messageId`, true);
      r.number(expectation.count, `${path}/count`);
    }
    if (expectation.kind === 'completion-before') r.number(expectation.timeMs, `${path}/timeMs`);
  });
}

function semantics(experiment: StackExperiment, r: Reader): void {
  for (const participant of ['A', 'B'] as const)
    if (experiment.nodes[participant].instances.length !== 2)
      r.issue(
        `/nodes/${participant}/instances`,
        'stack-topology',
        'Exactly two instances per participant are supported',
      );
  if (r.diagnostics.length) return;
  const definitions = new Map<string, StackProtocol>();
  experiment.definitions.forEach((definition, index) => {
    const key = `${definition.id}@${definition.revision}`;
    if (definitions.has(key))
      r.issue(`/definitions/${index}`, 'duplicate-revision', 'Duplicate exact definition revision');
    definitions.set(key, definition);
  });
  const instances = new Map<string, StackProtocol>();
  for (const participant of ['A', 'B'] as const) {
    const list = experiment.nodes[participant].instances;
    unique(list, `/nodes/${participant}/instances`, r);
    const roles = new Map<string, number>();
    list.forEach((instance, index) => {
      const path = `/nodes/${participant}/instances/${index}`;
      const protocol = definitions.get(`${instance.definition.id}@${instance.definition.revision}`);
      if (!protocol) {
        r.issue(`${path}/definition`, 'reference', 'Exact definition revision is absent');
        return;
      }
      instances.set(`${participant}/${instance.id}`, protocol);
      const layer = stackProtocolBody(protocol).layer;
      roles.set(layer, (roles.get(layer) ?? 0) + 1);
      if (layer === 'application' && providedStackPort(protocol))
        r.issue(
          `${path}/definition`,
          'stack-topology',
          'The top application cannot provide another upper service in this topology',
        );
      if (layer === 'transport' && !providedStackPort(protocol))
        r.issue(
          `${path}/definition`,
          'provider-missing',
          'The lower transport must explicitly provide an upper service',
        );
    });
    if (roles.get('application') !== 1 || roles.get('transport') !== 1)
      r.issue(
        `/nodes/${participant}/instances`,
        'stack-topology',
        'One application and one transport are required',
      );
  }
  const resolve = (endpoint: StackEndpoint, path: string) => {
    const protocol = instances.get(endpointKey(endpoint));
    if (!protocol) r.issue(path, 'endpoint-reference', 'Instance endpoint is absent');
    return protocol;
  };
  const resolvePort = (
    endpoint: StackPortEndpoint,
    role: 'requires' | 'provides',
    path: string,
  ) => {
    const protocol = resolve(endpoint, path);
    const port =
      protocol && (role === 'requires' ? protocol.requires : providedStackPort(protocol));
    if (protocol && port?.id !== endpoint.portId)
      r.issue(`${path}/portId`, 'port-reference', `Endpoint must name its ${role} port`);
    return port?.id === endpoint.portId ? port : undefined;
  };
  unique(experiment.bindings, '/bindings', r);
  if (experiment.bindings.length !== 2)
    r.issue('/bindings', 'stack-topology', 'Exactly one local binding per participant is required');
  const consumers = new Set<string>();
  const providers = new Set<string>();
  const graph = new Map<string, string[]>();
  experiment.bindings.forEach((binding, index) => {
    const path = `/bindings/${index}`;
    const consumer = resolvePort(binding.consumer, 'requires', `${path}/consumer`);
    const provider = resolvePort(binding.provider, 'provides', `${path}/provider`);
    if (binding.consumer.participant !== binding.provider.participant)
      r.issue(path, 'local-binding', 'Local binding endpoints must belong to the same participant');
    if (consumers.has(portKey(binding.consumer)))
      r.issue(
        `${path}/consumer`,
        'multiple-provider',
        'A required port has more than one provider',
      );
    if (providers.has(portKey(binding.provider)))
      r.issue(
        `${path}/provider`,
        'stack-topology',
        'A provider cannot serve multiple consumers in this topology',
      );
    consumers.add(portKey(binding.consumer));
    providers.add(portKey(binding.provider));
    const key = endpointKey(binding.consumer);
    if (instances.has(key) && instances.has(endpointKey(binding.provider))) {
      const edges = graph.get(key) ?? [];
      edges.push(endpointKey(binding.provider));
      graph.set(key, edges);
    }
    if (consumer && provider) {
      if (!compatibleStackServices(consumer.service, provider.service))
        r.issue(path, 'service-incompatible', 'Consumer and provider payload contracts differ');
      if (
        provider.lifecycle.notifications.some(
          (kind) => !consumer.lifecycle.notifications.includes(kind),
        )
      )
        r.issue(
          path,
          'lifecycle-incompatible',
          'Consumer cannot receive every provided lifecycle indication',
        );
    }
    if (
      instances.get(endpointKey(binding.consumer)) &&
      stackProtocolBody(instances.get(endpointKey(binding.consumer)) as StackProtocol).layer !==
        'application'
    )
      r.issue(`${path}/consumer`, 'stack-topology', 'Local consumer must be the application');
    if (
      instances.get(endpointKey(binding.provider)) &&
      stackProtocolBody(instances.get(endpointKey(binding.provider)) as StackProtocol).layer !==
        'transport'
    )
      r.issue(`${path}/provider`, 'stack-topology', 'Local provider must be the transport');
  });
  const active = new Set<string>();
  const done = new Set<string>();
  const visit = (key: string): void => {
    if (active.has(key)) {
      r.issue(
        '/bindings',
        'dependency-cycle',
        'Consumer-to-provider dependency graph contains a cycle',
      );
      return;
    }
    if (done.has(key)) return;
    active.add(key);
    for (const child of graph.get(key) ?? []) visit(child);
    active.delete(key);
    done.add(key);
  };
  for (const key of graph.keys()) visit(key);
  const bottomPorts = [];
  for (const participant of ['A', 'B'] as const) {
    const endpoint = experiment.link[participant];
    if (endpoint.participant !== participant)
      r.issue(
        `/link/${participant}/participant`,
        'link-direction',
        'Link side differs from its participant',
      );
    const port = resolvePort(endpoint, 'requires', `/link/${participant}`);
    bottomPorts.push(port);
    const protocol = instances.get(endpointKey(endpoint));
    if (protocol && stackProtocolBody(protocol).layer !== 'transport')
      r.issue(
        `/link/${participant}`,
        'stack-topology',
        'The link must connect the bottom transport ports',
      );
    if (port && port.service.kind !== experiment.link.environment.kind)
      r.issue(
        `/link/${participant}`,
        'environment-incompatible',
        'Bottom service must match the datagram environment',
      );
    if (consumers.has(portKey(endpoint)))
      r.issue(`/link/${participant}`, 'multiple-provider', 'Port is already locally bound');
    consumers.add(portKey(endpoint));
  }
  if (
    bottomPorts[0] &&
    bottomPorts[1] &&
    !compatibleStackServices(bottomPorts[0].service, bottomPorts[1].service)
  )
    r.issue('/link', 'service-incompatible', 'Peer link payload contracts differ');
  for (const [key, protocol] of instances) {
    if (!consumers.has(`${key}/${protocol.requires.id}`))
      r.issue(
        '/bindings',
        'disconnected-port',
        `Required port ${key}/${protocol.requires.id} is unconnected`,
      );
    const provided = providedStackPort(protocol);
    if (provided && !providers.has(`${key}/${provided.id}`))
      r.issue(
        '/bindings',
        'disconnected-port',
        `Provided port ${key}/${provided.id} is unconnected`,
      );
  }
  for (const layer of ['application', 'transport']) {
    const peer = (participant: string) =>
      [...instances].find(
        ([key, protocol]) =>
          key.startsWith(`${participant}/`) && stackProtocolBody(protocol).layer === layer,
      )?.[1];
    const a = peer('A');
    const b = peer('B');
    if (a && b) {
      const left = stackProtocolBody(a);
      const right = stackProtocolBody(b);
      if (left.codec !== right.codec || !sameWireMessages(left.messages, right.messages))
        r.issue(
          '/nodes/B/instances',
          'peer-wire',
          `${layer} peers have incompatible codec/message wire contracts`,
        );
    }
  }
  unique(experiment.scenario.inputs, '/scenario/inputs', r);
  unique(experiment.scenario.expectations, '/scenario/expectations', r);
  experiment.scenario.inputs.forEach((input, index) => {
    const path = `/scenario/inputs/${index}`;
    const protocol = resolve(input.target, `${path}/target`);
    if (input.timeMs > experiment.scenario.observationMs)
      r.issue(`${path}/timeMs`, 'observation-window', 'Input is outside the observation period');
    if (protocol) {
      if (stackProtocolBody(protocol).layer !== 'application')
        r.issue(`${path}/target`, 'scenario-target', 'User inputs target the top application only');
      append(
        r,
        `${path}/message`,
        validateStackMessage(
          stackProtocolBody(protocol),
          input.message,
          experiment.limits.maxMessageBytes,
        ),
      );
    }
  });
  experiment.scenario.expectations.forEach((expectation, index) => {
    const path = `/scenario/expectations/${index}`;
    const protocol = resolve(expectation.target, `${path}/target`);
    if (!protocol) return;
    const body = stackProtocolBody(protocol);
    if (
      expectation.kind === 'state' &&
      !body.states.some((state) => state.id === expectation.stateId)
    )
      r.issue(`${path}/stateId`, 'reference', 'Expected state is absent');
    if (
      expectation.kind === 'completion-before' &&
      expectation.timeMs > experiment.scenario.observationMs
    )
      r.issue(`${path}/timeMs`, 'observation-window', 'Deadline is outside the observation period');
    if (expectation.kind === 'delivery-count' || expectation.kind === 'delivered-values') {
      if (body.layer !== 'application')
        r.issue(
          `${path}/target`,
          'scenario-target',
          'Delivery expectations refer to application deliver observations',
        );
      if (
        expectation.kind === 'delivery-count' &&
        !body.messages.some((message) => message.id === expectation.messageId)
      )
        r.issue(`${path}/messageId`, 'reference', 'Expected message is absent');
      if (expectation.kind === 'delivered-values')
        append(
          r,
          `${path}/message`,
          validateStackMessage(body, expectation.message, experiment.limits.maxMessageBytes),
        );
    }
  });
}

/** Validate self-contained stack topology, exact versions, port/wire types, and endpoint scenarios. */
export function parseStackExperiment(value: unknown): ValidationResult<StackExperiment> {
  const json = parseJsonData(value);
  if (!json.success) return json;
  const r = new Reader();
  if (new TextEncoder().encode(JSON.stringify(value)).length > STACK_POLICY.maxArtifactBytes) {
    r.issue('/', 'model-size', 'Stack JSON exceeds the serialized size limit');
    return { success: false, diagnostics: r.diagnostics };
  }
  const node = r.object(value, '', [
    'schemaVersion',
    'mode',
    'id',
    'label',
    'origin',
    'seed',
    'definitions',
    'nodes',
    'bindings',
    'link',
    'scenario',
    'limits',
  ]);
  if (!node) return { success: false, diagnostics: r.diagnostics };
  r.choice(node.schemaVersion, '/schemaVersion', [2]);
  r.choice(node.mode, '/mode', ['stack']);
  r.text(node.id, '/id', true);
  r.text(node.label, '/label');
  if (Object.hasOwn(node, 'origin')) {
    const origin = r.object(node.origin, '/origin', ['exampleId', 'version']);
    if (origin) {
      r.text(origin.exampleId, '/origin/exampleId', true);
      r.number(origin.version, '/origin/version', 1);
    }
  }
  r.number(node.seed, '/seed', 0, 0xffff_ffff);
  r.array(
    node.definitions,
    '/definitions',
    (item, path) => append(r, path, parseStackProtocol(item)),
    1,
  );
  const nodes = r.object(node.nodes, '/nodes', ['A', 'B']);
  if (nodes)
    for (const participant of ['A', 'B']) {
      const entry = r.object(nodes[participant], `/nodes/${participant}`, ['instances']);
      if (!entry) continue;
      r.array(entry.instances, `/nodes/${participant}/instances`, (item, path) => {
        const instance = r.object(item, path, ['id', 'definition']);
        if (!instance) return;
        r.text(instance.id, `${path}/id`, true);
        const definition = r.object(instance.definition, `${path}/definition`, ['id', 'revision']);
        if (definition) {
          r.text(definition.id, `${path}/definition/id`, true);
          r.number(definition.revision, `${path}/definition/revision`, 1);
        }
      });
    }
  r.array(node.bindings, '/bindings', (item, path) => {
    const binding = r.object(item, path, ['id', 'consumer', 'provider']);
    if (!binding) return;
    r.text(binding.id, `${path}/id`, true);
    endpointShape(binding.consumer, `${path}/consumer`, r, true);
    endpointShape(binding.provider, `${path}/provider`, r, true);
  });
  const link = r.object(node.link, '/link', ['id', 'A', 'B', 'environment']);
  if (link) {
    r.text(link.id, '/link/id', true);
    endpointShape(link.A, '/link/A', r, true);
    endpointShape(link.B, '/link/B', r, true);
    environmentShape(link.environment, '/link/environment', r);
  }
  scenarioShape(node.scenario, r);
  const limits = r.object(node.limits, '/limits', Object.keys(defaultStackLimits()));
  if (limits)
    for (const [key, maximum] of Object.entries(defaultStackLimits()))
      r.number(limits[key], `/limits/${key}`, 1, maximum);
  if (!r.diagnostics.length) semantics(value as StackExperiment, r);
  return r.result(value as StackExperiment);
}

/** Capture an owned, deeply frozen stack snapshot without freezing or retaining the authoring input. */
export function prepareStackSnapshot(value: unknown): ValidationResult<StackSnapshot> {
  const parsed = parseStackExperiment(value);
  if (!parsed.success) return parsed;
  return {
    success: true,
    value: freezeOwned({
      schemaVersion: 2,
      mode: 'stack',
      engineVersion: STACK_POLICY.engineVersion,
      randomAlgorithm: STACK_POLICY.randomAlgorithm,
      configuration: structuredClone(parsed.value),
    }),
  };
}

/** Read only the supported stack engine contract; no silent v1 or future-version reinterpretation. */
export function parseStackSnapshot(value: unknown): ValidationResult<StackSnapshot> {
  const json = parseJsonData(value);
  if (!json.success) return json;
  const r = new Reader();
  const snapshot = r.object(value, '', [
    'schemaVersion',
    'mode',
    'engineVersion',
    'randomAlgorithm',
    'configuration',
  ]);
  if (!snapshot) return { success: false, diagnostics: r.diagnostics };
  r.choice(snapshot.schemaVersion, '/schemaVersion', [2]);
  r.choice(snapshot.mode, '/mode', ['stack']);
  r.choice(snapshot.engineVersion, '/engineVersion', [STACK_POLICY.engineVersion]);
  r.choice(snapshot.randomAlgorithm, '/randomAlgorithm', [STACK_POLICY.randomAlgorithm]);
  append(r, '/configuration', parseStackExperiment(snapshot.configuration));
  return r.diagnostics.length
    ? { success: false, diagnostics: r.diagnostics }
    : r.result(freezeOwned(structuredClone(value as StackSnapshot)));
}

/** Validate reduced per-experiment limits while keeping every budget global across the four instances. */
export function parseStackLimits(value: unknown): ValidationResult<StackLimits> {
  const json = parseJsonData(value);
  if (!json.success) return json;
  const r = new Reader();
  const limits = r.object(value, '', Object.keys(defaultStackLimits()));
  if (limits)
    for (const [key, max] of Object.entries(defaultStackLimits()))
      r.number(limits[key], `/${key}`, 1, max);
  return r.result(value as StackLimits);
}
