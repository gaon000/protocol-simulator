import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonValue } from '../../src/domain/execution-contract.ts';
import { parseExperiment, parseProtocolDefinition } from '../../src/domain/model-validation.ts';
import type { ValidationResult } from '../../src/domain/protocol-model.ts';
import { serializeBytes } from '../../src/domain/stack-bytes.ts';
import { STACK_POLICY, stackProtocolBody } from '../../src/domain/stack-model.ts';
import {
  adaptLegacyApplication,
  compatibleStackServices,
  parseStackProtocol,
  providedStackPort,
  validateServicePayload,
  validateStackMessage,
} from '../../src/domain/stack-protocol-validation.ts';
import {
  parseStackExperiment,
  parseStackSnapshot,
  prepareStackSnapshot,
} from '../../src/domain/stack-validation.ts';
import { createHttpProtocol } from '../../src/examples/http.ts';
import { protocolFixture } from '../fixtures/protocol-models.ts';
import {
  stackExperimentFixture,
  stackPortFixture,
  stackTransportFixture,
} from '../fixtures/stack-models.ts';

function ok<T>(result: ValidationResult<T>): T {
  assert.equal(result.success, true, JSON.stringify(result));
  if (!result.success) throw new Error('Invalid fixture');
  return result.value;
}
function replace(root: unknown, path: string, value: unknown): unknown {
  const clone = structuredClone(root);
  const parts = path.split('/').filter(Boolean);
  let parent = clone as Record<string, unknown>;
  for (const key of parts.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  const key = parts.at(-1);
  if (!key) throw new Error('Path is empty');
  parent[key] = value;
  return clone;
}

test('four stable endpoints validate independently of array order and snapshot captures all versioned contracts', () => {
  const input = stackExperimentFixture();
  const sourceBefore = JSON.stringify(input);
  const snapshot = ok(prepareStackSnapshot(input));
  assert.equal(JSON.stringify(input), sourceBefore);
  assert.ok(!Object.isFrozen(input));
  assert.ok(Object.isFrozen(snapshot.configuration.nodes.A.instances));
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.engineVersion, 'stack-1');
  const adapter = snapshot.configuration.definitions[0];
  assert.equal(adapter?.mode, 'legacy-application');
  if (adapter?.mode === 'legacy-application')
    assert.equal(adapter.adapterVersion, 'v1-application-ports/1');
  assert.deepEqual(ok(parseStackSnapshot(JSON.parse(JSON.stringify(snapshot)))), snapshot);
  assert.equal(parseStackSnapshot({ ...snapshot, engineVersion: '0.1.0-p5' }).success, false);
  assert.equal(parseStackSnapshot({ ...snapshot, schemaVersion: 1 }).success, false);
  const reversed = replace(input, '/nodes/B/instances', [...input.nodes.B.instances].reverse());
  assert.equal(parseStackExperiment(reversed).success, true);
  const changed = replace(input, '/nodes/A/instances/0/id', 'renamed');
  assert.equal(parseStackExperiment(changed).success, false);
  (input as { label: string }).label = 'edited after capture';
  assert.equal(snapshot.configuration.label, 'Stack model fixture');
});

const failures: readonly [string, string, unknown, string][] = [
  ['unknown properties', '/new', true, 'unknown-property'],
  ['legacy version', '/schemaVersion', 1, 'choice'],
  ['unknown mode', '/mode', 'single', 'choice'],
  ['extra participant', '/nodes/C', { instances: [] }, 'unknown-property'],
  ['missing participant', '/nodes/B', null, 'object'],
  [
    'third layer',
    '/nodes/A/instances/2',
    { id: 'extra', definition: { id: 'fixture_transport', revision: 1 } },
    'stack-topology',
  ],
  ['duplicate instance', '/nodes/A/instances/1/id', 'app', 'duplicate-id'],
  ['missing revision', '/nodes/A/instances/1/definition/revision', 2, 'reference'],
  ['missing definition', '/nodes/A/instances/1/definition/id', 'absent', 'reference'],
  ['invalid consumer port', '/bindings/0/consumer/portId', 'upper', 'port-reference'],
  ['invalid provider port', '/bindings/0/provider/portId', 'network', 'port-reference'],
  ['cross-node local binding', '/bindings/0/provider/participant', 'B', 'local-binding'],
  ['provider absent', '/definitions/1/provides', undefined, 'json-value'],
  ['wrong port direction', '/definitions/1/provides/role', 'requires', 'port-direction'],
  ['wrong service operation', '/definitions/1/provides/request', 'send', 'port-operation'],
  ['bytes versus packets', '/definitions/1/requires/service/payload', 'bytes', 'codec-service'],
  ['stream packets', '/definitions/1/requires/service/kind', 'stream', 'service-type'],
  ['wrong upper type', '/definitions/1/provides/service/kind', 'datagram', 'port-operation'],
  ['unknown endpoint', '/bindings/0/provider/instanceId', 'absent', 'endpoint-reference'],
  ['unbound local port', '/bindings', [], 'disconnected-port'],
  ['duplicate binding ID', '/bindings/1/id', 'local_A', 'duplicate-id'],
  ['wrong link participant', '/link/A/participant', 'B', 'link-direction'],
  [
    'link at application',
    '/link/A',
    { participant: 'A', instanceId: 'app', portId: 'lower' },
    'stack-topology',
  ],
  ['link port absent', '/link/B/portId', 'upper', 'port-reference'],
  ['stream link unsupported', '/link/environment/kind', 'stream', 'choice'],
  ['invalid probability', '/link/environment/directions/AtoB/lossRate', 1.1, 'number-range'],
  [
    'input targets lower layer',
    '/scenario/inputs/0/target/instanceId',
    'transport',
    'scenario-target',
  ],
  ['input message missing', '/scenario/inputs/0/message/messageId', 'absent', 'reference'],
  ['input unknown participant', '/scenario/inputs/0/target/participant', 'C', 'choice'],
  ['input outside observation', '/scenario/inputs/0/timeMs', 1001, 'observation-window'],
  [
    'expectation endpoint absent',
    '/scenario/expectations/0/target/instanceId',
    'absent',
    'endpoint-reference',
  ],
  ['expected state absent', '/scenario/expectations/0/stateId', 'absent', 'reference'],
  ['global budget raised', '/limits/maxEvents', 40000, 'number-range'],
  ['global budget zero', '/limits/maxPayloadBytes', 0, 'number-range'],
  ['seed invalid', '/seed', 2 ** 32, 'number-range'],
];
for (const [label, path, value, code] of failures)
  test(`stack validation rejects ${label} with a JSON pointer`, () => {
    const result = parseStackExperiment(replace(stackExperimentFixture(), path, value));
    assert.equal(result.success, false);
    if (!result.success)
      assert.ok(
        result.diagnostics.some((d) => d.code === code && d.path.startsWith('/')),
        JSON.stringify(result.diagnostics),
      );
  });

test('cycles, fanout and duplicate providers are rejected rather than treated as bidirectional data flow', () => {
  const fixture = stackExperimentFixture();
  const cycle = replace(fixture, '/bindings/1', {
    id: 'reverse',
    consumer: { participant: 'A', instanceId: 'transport', portId: 'network' },
    provider: { participant: 'A', instanceId: 'app', portId: 'lower' },
  });
  const result = parseStackExperiment(cycle);
  assert.equal(result.success, false);
  if (!result.success) assert.ok(result.diagnostics.some((d) => d.code === 'dependency-cycle'));
  const duplicate = replace(fixture, '/bindings/1/consumer', fixture.bindings[0]?.consumer);
  const parsed = parseStackExperiment(duplicate);
  assert.equal(parsed.success, false);
  if (!parsed.success) assert.ok(parsed.diagnostics.some((d) => d.code === 'multiple-provider'));
  assert.equal(parseStackExperiment(fixture).success, true);
});

test('different client/server bodies are compatible only when their actual wire schemas match', () => {
  const fixture = stackExperimentFixture();
  const client = ok(adaptLegacyApplication(protocolFixture()));
  const serverSource = replace(protocolFixture(), '/id', 'server') as ReturnType<
    typeof protocolFixture
  >;
  const server = ok(
    adaptLegacyApplication({ ...serverSource, label: 'Server', rules: [serverSource.rules[1]] }),
  );
  const separate = replace(
    { ...fixture, definitions: [client, fixture.definitions[1], server] },
    '/nodes/B/instances/0/definition',
    { id: 'server', revision: 1 },
  );
  assert.equal(parseStackExperiment(separate).success, true);
  const mismatch = replace(separate, '/definitions/2/source/messages/0/fields/0/max', 254);
  const result = parseStackExperiment(mismatch);
  assert.equal(result.success, false);
  if (!result.success) assert.ok(result.diagnostics.some((d) => d.code === 'peer-wire'));
});

test('packet schema identity and structural wire matching both matter for service compatibility', () => {
  const transport = stackTransportFixture();
  const packet = transport.requires.service;
  assert.equal(compatibleStackServices(packet, structuredClone(packet)), true);
  assert.equal(compatibleStackServices(packet, { kind: 'datagram', payload: 'bytes' }), false);
  assert.equal(compatibleStackServices(packet, { kind: 'stream', payload: 'bytes' }), false);
  if (packet.payload === 'bytes') throw new Error('Expected packet fixture');
  assert.equal(
    compatibleStackServices(packet, { ...packet, payload: { ...packet.payload, revision: 2 } }),
    false,
  );
  const altered = replace(transport, '/requires/service/payload/messages/0/fields/0/name', 'other');
  assert.equal(parseStackProtocol(altered).success, false);
});

test('explicit v1 adapters copy sources, retain exact codec semantics and never invent provider ports', () => {
  for (const codec of ['json-lines', 'json-datagram'] as const) {
    const source = protocolFixture(codec);
    const before = JSON.stringify(source);
    const adapter = ok(adaptLegacyApplication(source));
    assert.equal(JSON.stringify(source), before);
    assert.ok(!Object.isFrozen(source));
    assert.equal(adapter.requires.service.payload, 'bytes');
    assert.equal(adapter.requires.service.kind, source.lowerService);
    assert.equal(providedStackPort(adapter), undefined);
    assert.equal(parseStackProtocol(JSON.parse(JSON.stringify(adapter))).success, true);
    assert.equal(parseProtocolDefinition(adapter).success, false);
    assert.equal(parseStackProtocol(source).success, false);
    assert.equal(parseStackProtocol({ ...adapter, adapterVersion: 'future' }).success, false);
    assert.equal(parseStackProtocol({ ...adapter, provides: stackPortFixture() }).success, false);
    assert.equal(
      parseStackProtocol(
        replace(adapter, '/requires/service/kind', codec === 'json-lines' ? 'datagram' : 'stream'),
      ).success,
      false,
    );
  }
  assert.equal(adaptLegacyApplication(protocolFixture('logical-packet')).success, false);
  const http = ok(adaptLegacyApplication(createHttpProtocol()));
  assert.equal(http.requires.service.kind, 'stream');
  assert.equal(parseStackProtocol(JSON.parse(JSON.stringify(http))).success, true);
  const fixture = stackExperimentFixture();
  const transport = stackTransportFixture();
  const { provides: _provides, ...withoutProvider } = transport;
  const missingProvider = parseStackExperiment({
    ...fixture,
    definitions: [
      fixture.definitions[0],
      {
        ...withoutProvider,
        rules: [
          {
            id: 'ignore_data',
            fromStateId: 'Ready',
            nextStateId: 'Ready',
            event: { kind: 'receive', messageId: 'DATA' },
            actions: [],
            ignore: true,
          },
        ],
      },
    ],
  });
  assert.equal(missingProvider.success, false);
  if (!missingProvider.success)
    assert.ok(missingProvider.diagnostics.some((d) => d.code === 'provider-missing'));
  assert.equal(parseExperiment(stackExperimentFixture()).success, false);
});

test('native rules type-check bytes and only expose payload/fields in their actual trigger scope', () => {
  const fixture = stackTransportFixture();
  assert.equal(parseStackProtocol(fixture).success, true);
  for (const [path, value] of [
    ['/rules/0/actions/0/value', { kind: 'literal', value: 'text' }],
    ['/rules/0/event/operation', 'send'],
    ['/rules/0/event/portId', 'network'],
    ['/rules/1/actions/0/operation', 'receive'],
    ['/rules/1/actions/0/portId', 'network'],
    ['/rules/1/actions/0/payload', { kind: 'service-payload' }],
    ['/rules/0/actions/1/value', { kind: 'field', fieldId: 'payload' }],
    [
      '/rules/0/actions/2/values/payload',
      { kind: 'byteLength', value: { kind: 'service-payload' } },
    ],
    ['/variables/0/initial', { kind: 'bytes', encoding: 'base64', data: 'AA==', byteLength: 0 }],
    ['/messages/0/fields/1/minBytes', STACK_POLICY.maxMessageBytes + 1],
  ] as const)
    assert.equal(parseStackProtocol(replace(fixture, path, value)).success, false, path);
});

test('bytes field values/defaults, wire names and service payload boundaries remain explicit', () => {
  const fixture = stackTransportFixture();
  const bytes = serializeBytes(Uint8Array.of(0, 255));
  const message = { messageId: 'DATA', values: { sequence: 0, payload: bytes } };
  assert.deepEqual(ok(validateStackMessage(fixture, message)), message);
  assert.equal(
    validateStackMessage(fixture, { ...message, values: { seq: 0, payload: bytes } }).success,
    false,
  );
  assert.equal(
    validateStackMessage(fixture, { ...message, values: { sequence: 0, payload: 'AA==' } }).success,
    false,
  );
  assert.equal(
    validateStackMessage(fixture, { ...message, values: { sequence: 0 } }).success,
    false,
  );
  const wire = { messageId: 'DATA', fields: { seq: 0, payload: bytes } };
  assert.deepEqual(ok(validateServicePayload(fixture.requires.service, wire)), wire);
  assert.equal(validateServicePayload(fixture.requires.service, message).success, false);
  assert.equal(validateServicePayload(fixture.requires.service, bytes).success, false);
  assert.equal(validateServicePayload(stackPortFixture().service, wire).success, false);
  assert.deepEqual(ok(validateServicePayload(stackPortFixture().service, bytes)), bytes);
  assert.equal(
    stackProtocolBody(ok(adaptLegacyApplication(protocolFixture()))).layer,
    'application',
  );
});

test('untrusted graphs, accessors, deep expressions and excess serialized data fail without freezing callers', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const accessor = Object.defineProperty({}, 'schemaVersion', {
    enumerable: true,
    get() {
      throw new Error('Accessor invoked');
    },
  });
  for (const input of [
    cycle,
    accessor,
    new Date(),
    { ...stackExperimentFixture(), malicious: Symbol() },
  ])
    assert.equal(parseStackExperiment(input).success, false);
  let deep: JsonValue = { kind: 'literal', value: 0 };
  for (let i = 0; i < 70; i++) deep = { kind: 'byteLength', value: deep };
  assert.equal(
    parseStackProtocol(replace(stackTransportFixture(), '/rules/0/actions/0/value', deep)).success,
    false,
  );
  assert.equal(
    parseStackExperiment(
      replace(stackExperimentFixture(), '/label', 'x'.repeat(STACK_POLICY.maxArtifactBytes)),
    ).success,
    false,
  );
});

test('duplicate definitions, scenario references, deadlines and required default values are checked', () => {
  const fixture = stackExperimentFixture();
  assert.equal(
    parseStackExperiment({
      ...fixture,
      definitions: [...fixture.definitions, fixture.definitions[0]],
    }).success,
    false,
  );
  assert.equal(
    parseStackExperiment(replace(fixture, '/scenario/inputs/1', fixture.scenario.inputs[0]))
      .success,
    false,
  );
  for (const expectation of [
    {
      id: 'check',
      kind: 'completion-before',
      target: { participant: 'A', instanceId: 'app' },
      timeMs: 1001,
    },
    {
      id: 'check',
      kind: 'delivery-count',
      target: { participant: 'A', instanceId: 'app' },
      messageId: 'missing',
      count: 1,
    },
    {
      id: 'check',
      kind: 'delivery-count',
      target: { participant: 'A', instanceId: 'transport' },
      messageId: 'DATA',
      count: 1,
    },
    {
      id: 'check',
      kind: 'delivered-values',
      target: { participant: 'A', instanceId: 'app' },
      message: { messageId: 'ping', values: { sequence: false } },
    },
  ])
    assert.equal(
      parseStackExperiment(replace(fixture, '/scenario/expectations/0', expectation)).success,
      false,
    );
  const transport = stackTransportFixture();
  assert.equal(
    validateServicePayload(stackPortFixture().service, serializeBytes(Uint8Array.of(1, 2, 3)), 2)
      .success,
    false,
  );
  assert.equal(parseStackExperiment(replace(fixture, '/limits/maxMessageBytes', 1)).success, false);
  for (const [path, value] of [
    [
      '/messages/0/fields/1/defaultValue',
      { kind: 'bytes', encoding: 'base64', byteLength: 2, data: 'AA==' },
    ],
    ['/messages/0/fields/1/id', 'sequence'],
    ['/variables/1/id', 'buffer'],
    ['/rules/1/id', 'accept_write'],
    [
      '/rules/0/actions/2/values/sequence',
      { kind: 'literal', value: serializeBytes(new Uint8Array()) },
    ],
    ['/states/0/terminal', true],
    ['/rules/0/actions/3', { kind: 'finish', outcome: 'success' }],
    [
      '/rules/0/condition',
      {
        kind: 'compare',
        operator: 'lt',
        left: { kind: 'service-payload' },
        right: { kind: 'variable', variableId: 'buffer' },
      },
    ],
  ] as const)
    assert.equal(parseStackProtocol(replace(transport, path, value)).success, false, path);
  assert.equal(
    validateServicePayload(transport.requires.service, {
      messageId: 'DATA',
      fields: { seq: 0, payload: serializeBytes(new Uint8Array(STACK_POLICY.maxMessageBytes)) },
    }).success,
    false,
  );
});

test('guarded explicit ignore preserves state and known literal constraints fail before execution', () => {
  const transport = stackTransportFixture();
  const ignore = {
    id: 'skip',
    fromStateId: 'Ready',
    nextStateId: 'Ready',
    event: { kind: 'receive', messageId: 'DATA' },
    condition: {
      kind: 'compare',
      operator: 'lt',
      left: { kind: 'field', fieldId: 'sequence' },
      right: { kind: 'literal', value: 0 },
    },
    actions: [],
    ignore: true,
  };
  assert.equal(parseStackProtocol({ ...transport, rules: [ignore] }).success, true);
  assert.equal(
    parseStackProtocol({ ...transport, rules: [{ ...ignore, ignore: false }] }).success,
    false,
  );
  assert.equal(
    parseStackProtocol(
      replace(transport, '/rules/0/actions/2/values/sequence', { kind: 'literal', value: -1 }),
    ).success,
    false,
  );
  assert.equal(
    parseStackProtocol(
      replace(transport, '/rules/0/actions/3', {
        kind: 'start-timer',
        timerId: 'retry',
        durationMs: { kind: 'literal', value: -1 },
      }),
    ).success,
    false,
  );
  const jsonVariable = {
    ...transport,
    variables: [...transport.variables, { id: 'data', type: 'json', initial: null }],
    rules: [
      {
        ...transport.rules[0],
        actions: [{ kind: 'assign', variableId: 'data', value: { kind: 'literal', value: 1 } }],
      },
    ],
  };
  assert.equal(parseStackProtocol(jsonVariable).success, true);
});
