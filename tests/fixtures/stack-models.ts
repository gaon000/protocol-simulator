import { serializeBytes } from '../../src/domain/stack-bytes.ts';
import {
  defaultStackLimits,
  type NativeStackProtocol,
  type PayloadRange,
  type ServicePort,
  type StackExperiment,
  type StackMessageDefinition,
  type StackTrace,
} from '../../src/domain/stack-model.ts';
import { adaptLegacyApplication } from '../../src/domain/stack-protocol-validation.ts';
import { protocolFixture } from './protocol-models.ts';

/** Minimal model fixture; this is deliberately not a reliable transport implementation. */
export function stackTransportFixture(): NativeStackProtocol {
  const messages: readonly StackMessageDefinition[] = [
    {
      id: 'DATA',
      label: 'Data',
      fields: [
        {
          id: 'sequence',
          name: 'seq',
          type: 'integer',
          min: 0,
          required: true,
          placement: 'header',
        },
        {
          id: 'payload',
          name: 'payload',
          type: 'bytes',
          required: true,
          placement: 'payload',
          maxBytes: 1_048_576,
        },
      ],
    },
  ];
  return {
    schemaVersion: 2,
    mode: 'stack-protocol',
    id: 'fixture_transport',
    revision: 1,
    label: 'Model fixture only',
    layer: 'transport',
    codec: 'logical-packet',
    requires: {
      id: 'network',
      role: 'requires',
      service: {
        kind: 'datagram',
        payload: { id: 'data_packet', revision: 1, messages: structuredClone(messages) },
      },
      request: 'send',
      indication: 'receive',
      lifecycle: { initial: 'ready', notifications: ['failed'] },
    },
    provides: stackPortFixture(),
    messages,
    states: [{ id: 'Ready', label: 'Ready' }],
    initialStateId: 'Ready',
    variables: [
      { id: 'buffer', type: 'bytes', initial: serializeBytes(new Uint8Array()) },
      { id: 'size', type: 'integer', initial: 0 },
    ],
    timers: [{ id: 'retry' }],
    rules: [
      {
        id: 'accept_write',
        fromStateId: 'Ready',
        nextStateId: 'Ready',
        event: { kind: 'service-request', portId: 'upper', operation: 'write' },
        actions: [
          { kind: 'assign', variableId: 'buffer', value: { kind: 'service-payload' } },
          {
            kind: 'assign',
            variableId: 'size',
            value: { kind: 'byteLength', value: { kind: 'service-payload' } },
          },
          {
            kind: 'send',
            messageId: 'DATA',
            values: {
              sequence: { kind: 'literal', value: 0 },
              payload: { kind: 'service-payload' },
            },
          },
        ],
      },
      {
        id: 'read_data',
        fromStateId: 'Ready',
        nextStateId: 'Ready',
        event: { kind: 'receive', messageId: 'DATA' },
        actions: [
          {
            kind: 'service-indicate',
            portId: 'upper',
            operation: 'read',
            payload: { kind: 'field', fieldId: 'payload' },
          },
        ],
      },
    ],
  };
}

/** Create the explicit stream service used by the model fixture. */
export function stackPortFixture(): ServicePort {
  return {
    id: 'upper',
    role: 'provides',
    service: { kind: 'stream', payload: 'bytes' },
    request: 'write',
    indication: 'read',
    lifecycle: { initial: 'ready', notifications: ['failed'] },
  };
}

/** Build four instances by stable endpoint with one local binding per node and one bottom link. */
export function stackExperimentFixture(): StackExperiment {
  const app = adaptLegacyApplication(protocolFixture());
  if (!app.success) throw new Error(JSON.stringify(app.diagnostics));
  const transport = stackTransportFixture();
  return {
    schemaVersion: 2,
    mode: 'stack',
    id: 'stack_fixture',
    label: 'Stack model fixture',
    seed: 0,
    definitions: [app.value, transport],
    nodes: {
      A: {
        instances: [
          { id: 'app', definition: { id: app.value.id, revision: 1 } },
          { id: 'transport', definition: { id: transport.id, revision: 1 } },
        ],
      },
      B: {
        instances: [
          { id: 'app', definition: { id: app.value.id, revision: 1 } },
          { id: 'transport', definition: { id: transport.id, revision: 1 } },
        ],
      },
    },
    bindings: (['A', 'B'] as const).map((participant) => ({
      id: `local_${participant}`,
      consumer: { participant, instanceId: 'app', portId: 'lower' },
      provider: { participant, instanceId: 'transport', portId: 'upper' },
    })),
    link: {
      id: 'wire',
      A: { participant: 'A', instanceId: 'transport', portId: 'network' },
      B: { participant: 'B', instanceId: 'transport', portId: 'network' },
      environment: {
        schemaVersion: 1,
        id: 'network',
        kind: 'datagram',
        directions: {
          AtoB: { delayMs: 1, jitterMs: 0, lossRate: 0, duplicateRate: 0 },
          BtoA: { delayMs: 1, jitterMs: 0, lossRate: 0, duplicateRate: 0 },
        },
        targetedDrops: [],
      },
    },
    scenario: {
      schemaVersion: 2,
      id: 'scenario',
      observationMs: 1000,
      inputs: [
        {
          id: 'start',
          timeMs: 0,
          target: { participant: 'A', instanceId: 'app' },
          message: { messageId: 'ping', values: { sequence: 1 } },
        },
      ],
      expectations: [
        {
          id: 'complete',
          kind: 'state',
          target: { participant: 'A', instanceId: 'app' },
          stateId: 'Done',
        },
        {
          id: 'provider_ready',
          kind: 'state',
          target: { participant: 'B', instanceId: 'transport' },
          stateId: 'Ready',
        },
      ],
    },
    limits: defaultStackLimits(),
  };
}

/** Create a versioned trace fixture referencing actual owned payload handles. */
export function stackTraceFixture(payloads: readonly PayloadRange[] = []): StackTrace {
  return {
    schemaVersion: 2,
    mode: 'stack',
    runId: 'run',
    eventId: 'event_1',
    timeMs: 0,
    sequence: 1,
    endpoint: { participant: 'A', instanceId: 'transport' },
    kind: 'send',
    sourceEventIds: [],
    payloads,
    data: null,
  };
}
