import assert from 'node:assert/strict';
import test from 'node:test';
import { createStackSimulation } from '../../src/application/create-stack-simulation.ts';
import {
  buildStackMessageJourney,
  type StackJourneyQuery,
} from '../../src/application/stack-message-journey.ts';
import { captureStackRun } from '../../src/application/workspace-v2-operations.ts';
import { buildStackPanelModel } from '../../src/application/stack-panel-model.ts';
import { stackObject, stackRangeBytes } from '../../src/domain/stack-record.ts';
import type { StackExperiment, StackTrace } from '../../src/domain/stack-model.ts';
import { parseSavedStackRun } from '../../src/domain/workspace-v2-validation.ts';
import type { SavedStackRun } from '../../src/domain/workspace-v2-model.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';
import {
  createReliableStackExperiment,
  createStackExampleCopy,
  STACK_EXAMPLES,
} from '../../src/examples/reliable-stack-examples.ts';
import { largeStackEvents, largeStackFrame } from '../fixtures/large-stacks.ts';
import { repeatedAppFixture } from '../fixtures/stack-runtime.ts';

function simulate(configuration: StackExperiment = createStackExampleCopy('stack_first_ack_loss')) {
  const created = createStackSimulation(configuration);
  if (!created.success) assert.fail(JSON.stringify(created.diagnostics));
  return created.value;
}
function record(configuration?: StackExperiment) {
  return captureStackRun(simulate(configuration).run(), 'draft', 1);
}
const end = (r: SavedStackRun) => r.view.events.length + 1;
function journey(r: SavedStackRun, query: StackJourneyQuery = {}, cursor = end(r)) {
  const value = buildStackMessageJourney(r, cursor, query);
  if (value.status === 'unavailable') assert.fail(value.note);
  return value;
}
function all(r: SavedStackRun, query: StackJourneyQuery = {}, cursor = end(r)) {
  const first = journey(r, query, cursor);
  const rows = first.rows.slice();
  for (let page = 1; page < first.pages; page++)
    rows.push(...journey(r, { ...query, page }, cursor).rows);
  return { ...first, rows };
}
function mutateEvent(
  r: SavedStackRun,
  id: string,
  update: (event: StackTrace) => StackTrace,
): SavedStackRun {
  return {
    ...r,
    view: { ...r.view, events: r.view.events.map((e) => (e.eventId === id ? update(e) : e)) },
  };
}

for (const example of STACK_EXAMPLES)
  test(`${example.id} follows actual app bytes to the peer frame without absorbing the response`, () => {
    const r = record(createStackExampleCopy(example.id));
    const before = JSON.stringify(r);
    const result = all(r);
    assert.equal(result.status, 'available', JSON.stringify(result.notes));
    assert.equal(result.frames, 1);
    assert.equal(result.deliveries, 1);
    assert.ok(result.stages.every((s) => s.bytes === result.root.byteLength));
    const response = result.roots.rows.find((e) => e.target === 'B/app');
    assert.ok(response);
    assert.ok(!result.rows.some((e) => e.id === response.id));
    const reverse = all(r, { rootId: response.id });
    assert.equal(reverse.root.target, 'B/app');
    assert.equal(reverse.stages[3]?.target, 'A/app');
    assert.equal(reverse.frames, 1);
    assert.equal(JSON.stringify(r), before);
  });

test('ACK loss remains a control branch and retransmitted DATA has a timer and a recorded byte path', () => {
  const r = record();
  const result = all(r);
  assert.ok(result.rows.some((e) => e.flags.includes('선택 바이트 재송신 · 타이머')));
  assert.ok(
    result.rows.some(
      (e) => e.title.includes('drop-targeted') && e.relation === 'control' && e.mappedBytes === 0,
    ),
  );
  assert.ok(result.rows.some((e) => e.flags.includes('직접 상위 read 관찰 0회')));
  assert.equal(result.rows.filter((e) => e.kind === 'deliver').length, 1);
});

test('UTF-8 field and single-byte selections retain exact original and local fragment coordinates', () => {
  const r = record();
  const first = journey(r);
  const field = first.fields.find((f) => f.id === 'text');
  assert.ok(field);
  assert.equal(field.end - field.start, 8); // quoted UTF-8 string, not its two code points
  const result = all(r, { offset: field.start, length: field.end - field.start });
  assert.equal(result.status, 'available', JSON.stringify(result.notes));
  assert.ok(
    result.rows.every((e) =>
      e.spans.every((s) => s.start >= field.start && s.start + s.length <= field.end),
    ),
  );
  assert.ok(result.stages.every((s) => s.bytes === 8));
  const tail = all(r, { offset: 80, length: 1 });
  assert.equal(tail.status, 'available', JSON.stringify(tail.notes));
  const split = tail.rows.find((e) => e.kind === 'send' && e.target === 'A/transport');
  assert.ok(split);
  assert.equal(split.spans[0]?.start, 80);
  assert.equal(split.spans[0]?.local, 16);
  assert.equal(split.mappedBytes, 1);
});

test('history prefixes never disclose later ACK decisions, receives, messages or byte windows from a future root', () => {
  const r = record();
  const result = all(r, {}, 11);
  assert.ok(result.prefix);
  assert.ok(result.rows.every((e) => e.cursor <= 11));
  assert.equal(result.frames, 0);
  assert.equal(result.stages[2]?.bytes, 0);
  const future = r.view.events.find(
    (e) => e.kind === 'send' && e.endpoint.instanceId === 'app' && e.endpoint.participant === 'B',
  );
  assert.ok(future);
  assert.equal(buildStackMessageJourney(r, 11, { rootId: future.eventId }).status, 'unavailable');
  assert.equal(buildStackMessageJourney(r, 0).status, 'unavailable');
  const old = {
    ...r,
    view: { ...r.view, snapshot: { ...r.view.snapshot, engineVersion: 'future' } },
  };
  assert.equal(buildStackMessageJourney(old, end(old)).status, 'unavailable');
});

test('complete loss and cancellation show observed sender bytes with no invented receive or final delivery', () => {
  const base = createStackExampleCopy('stack_ping_pong');
  const loss = {
    ...base,
    link: {
      ...base.link,
      environment: {
        ...base.link.environment,
        directions: {
          AtoB: { ...base.link.environment.directions.AtoB, lossRate: 1 },
          BtoA: { ...base.link.environment.directions.BtoA, lossRate: 1 },
        },
      },
    },
  };
  const failed = all(record(loss));
  assert.equal(failed.stages[2]?.bytes, 0);
  assert.equal(failed.deliveries, 0);
  const engine = simulate();
  engine.step();
  const partial = journey(captureStackRun(engine.cancel(), 'draft', 1));
  assert.equal(partial.partial, true);
  assert.equal(partial.frames, 0);
});

test('an actual duplicated datagram is marked as a copy while each peer frame remains one observation', () => {
  const base = createStackExampleCopy('stack_ping_pong');
  const config = {
    ...base,
    link: {
      ...base.link,
      environment: {
        ...base.link.environment,
        directions: {
          ...base.link.environment.directions,
          AtoB: { ...base.link.environment.directions.AtoB, duplicateRate: 1 },
        },
      },
    },
  };
  const result = all(record(config));
  assert.ok(result.rows.some((r) => r.flags.includes('환경 복제본 실제 수신')));
  assert.equal(result.frames, 1);
});

for (const identical of [false, true])
  test(`${identical ? 'identical' : 'different'} queued writes and a merged read preserve occurrence-specific positions or explicitly limit ambiguity`, () => {
    const base = createPingPongExperiment();
    const protocol = repeatedAppFixture();
    const app = {
      ...base,
      definitions: [protocol],
      scenario: {
        ...base.scenario,
        observationMs: 1200,
        inputs: [0, 5, 10].map((timeMs, index) => ({
          id: `input_${index}`,
          timeMs,
          participant: 'A' as const,
          message: { messageId: 'ping', values: { sequence: identical ? 1 : index + 1 } },
        })),
        expectations: [
          {
            id: 'count',
            kind: 'delivery-count' as const,
            participant: 'A' as const,
            messageId: 'pong',
            count: 3,
          },
        ],
      },
    };
    const r = record(createReliableStackExperiment(app, { chunkBytes: 256 }));
    const sends = r.view.events.filter(
      (e) => e.kind === 'send' && e.endpoint.participant === 'A' && e.endpoint.instanceId === 'app',
    );
    assert.equal(sends.length, 3);
    if (identical) assert.deepEqual(sends[0]?.payloads, sends[1]?.payloads);
    for (const source of sends) {
      const result = all(r, { rootId: source.eventId });
      assert.ok(result.frames <= 1);
      if (!identical) assert.equal(result.frames, 1, JSON.stringify(result.notes));
      assert.ok(
        result.rows.every(
          (e) => e.kind !== 'send' || e.target !== 'A/app' || e.id === source.eventId,
        ),
      );
    }
    const later = all(r, { rootId: sends[2]?.eventId ?? '' });
    const parsed = later.rows.find((e) => e.target === 'B/app' && e.kind === 'parsed');
    if (parsed) assert.equal(parsed.spans[0]?.local, 0);
    else {
      assert.equal(later.status, 'limited');
      assert.ok(later.notes.some((n) => n.includes('모호')));
    }
  });

test('dense actual byte-variable observations stop analysis at its own finite budget and retain the original record', () => {
  const source = createStackExampleCopy('stack_http_split');
  const config: StackExperiment = {
    ...source,
    definitions: source.definitions.map((definition) =>
      definition.mode === 'stack-protocol'
        ? {
            ...definition,
            variables: [
              ...definition.variables,
              ...Array.from({ length: 60 }, (_, i) => ({
                id: `empty_${i}`,
                type: 'bytes' as const,
                initial: { kind: 'bytes', encoding: 'base64', byteLength: 0, data: '' },
              })),
            ],
          }
        : definition,
    ),
  };
  const r = record(config);
  assert.equal(r.view.status, 'completed');
  const original = JSON.stringify(r);
  const result = journey(r);
  assert.equal(result.status, 'limited');
  assert.ok(result.notes.some((n) => n.includes('한도')));
  assert.ok(result.rows.length <= 20);
  assert.equal(JSON.stringify(r), original);
});

test('untrusted provenance with a wrong destination or mismatching bytes is limited even when record shape validation passes', () => {
  const r = record();
  const sent = r.view.events.find(
    (e) =>
      e.kind === 'send' &&
      e.endpoint.instanceId === 'transport' &&
      stackObject(stackObject(e.data).message).messageId === 'DATA',
  );
  assert.ok(sent);
  for (const update of [{ valueOffset: 1 }, { offset: 1, length: 63 }]) {
    const changed = mutateEvent(r, sent.eventId, (event) => {
      const data = stackObject(event.data);
      const sources = stackObject(data.fieldSources);
      const rows = sources.payload;
      assert.ok(Array.isArray(rows));
      return {
        ...event,
        data: {
          ...data,
          fieldSources: {
            ...sources,
            payload: rows.map((row) => ({ ...stackObject(row), ...update })),
          },
        },
      };
    });
    assert.equal(parseSavedStackRun(changed).success, true);
    const result = journey(changed);
    assert.equal(result.status, 'limited');
    assert.ok(result.notes.some((n) => n.includes('제외')));
    assert.ok(!result.rows.some((e) => e.id === sent.eventId));
  }
});

test('large frames use a bounded real byte window and every worker DTO keeps at most one observation page', () => {
  const r = record(largeStackFrame());
  const result = journey(r, { bytePage: Number.MAX_SAFE_INTEGER });
  assert.equal(result.root.byteLength, 1048576);
  assert.equal(result.status, 'available');
  assert.equal(result.cells.length, 256);
  assert.ok(result.rows.length <= 20);
  assert.ok(JSON.stringify(result).length < 32768);
  const root = r.view.events[result.root.cursor - 1];
  assert.ok(root);
  const range = stackObject(stackObject(root.data).wire).range;
  const bytes = stackRangeBytes(
    r.view.artifacts,
    range as unknown as import('../../src/domain/stack-model.ts').PayloadRange,
    root.payloads,
  );
  assert.deepEqual(
    result.cells.map((c) => Number.parseInt(c.hex, 16)),
    Array.from(bytes.slice(-256)),
  );
  assert.equal(
    buildStackMessageJourney(r, end(r), { offset: 1048576, length: 1 }).status,
    'unavailable',
  );
  assert.equal(buildStackMessageJourney(r, end(r), { offset: -1 }).status, 'unavailable');
  assert.equal(buildStackMessageJourney(r, end(r), { offset: 0.5 }).status, 'unavailable');
});

test('ten thousand timer observations without an app send remain bounded and do not invent a byte journey', () => {
  const r = record(largeStackEvents());
  assert.equal(r.view.events.length, 10000);
  const result = buildStackMessageJourney(r, end(r));
  assert.equal(result.status, 'unavailable');
  assert.ok(JSON.stringify(result).length < 32768);
  const model = buildStackPanelModel(r, {
    cursor: end(r),
    endpoint: { participant: 'A', instanceId: 'app' },
    page: 0,
    statePage: 0,
    rulePage: 0,
    layer: 'all',
    filterTarget: false,
    detail: 'journey',
    bytePage: 0,
    rangeIndex: 0,
  });
  assert.equal(model.journey?.status, 'unavailable');
});

test('actual mapped fields paginate without dropping later fields or changing the selected byte range', () => {
  const source = createStackExampleCopy('stack_ping_pong');
  const config: StackExperiment = {
    ...source,
    definitions: source.definitions.map((d) =>
      d.mode === 'legacy-application'
        ? {
            ...d,
            source: {
              ...d.source,
              messages: d.source.messages.map((m) =>
                m.id === 'ping'
                  ? {
                      ...m,
                      fields: [
                        ...m.fields,
                        ...Array.from({ length: 25 }, (_, i) => ({
                          id: `extra_${i}`,
                          name: `extra_${i}`,
                          type: 'integer' as const,
                          required: false,
                          placement: 'payload' as const,
                          defaultValue: 0,
                        })),
                      ],
                    }
                  : m,
              ),
            },
          }
        : d,
    ),
  };
  const r = record(config);
  const first = journey(r);
  assert.equal(first.fields.length, 20);
  assert.ok(first.fieldPages > 1);
  const last = journey(r, { fieldPage: 1 });
  assert.ok(last.fields.some((f) => f.id === 'extra_24'));
  assert.deepEqual(first.selection, last.selection);
});

test('peer-local field IDs may differ while actual packet wire names and byte provenance still correspond', () => {
  const config = structuredClone(createStackExampleCopy('stack_ping_pong'));
  const peer = config.definitions.find((d) => d.mode === 'stack-protocol' && d.id.endsWith('_B'));
  assert.ok(peer);
  function rewrite(value: unknown) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) rewrite(item);
      return;
    }
    const object = value as Record<string, unknown>;
    if (object.id === 'payload' && object.name === 'payload' && object.type === 'bytes')
      object.id = 'peer_bytes';
    if (object.kind === 'field' && object.fieldId === 'payload') object.fieldId = 'peer_bytes';
    if (object.kind === 'send' && object.messageId === 'DATA') {
      const values = object.values as Record<string, unknown>;
      const { payload, ...others } = values;
      object.values = { ...others, peer_bytes: payload };
    }
    for (const child of Object.values(object)) rewrite(child);
  }
  rewrite(peer);
  const r = record(config);
  assert.ok(r.view.expectations.every((e) => e.status === 'pass'));
  const result = all(r);
  assert.equal(result.status, 'available', JSON.stringify(result.notes));
  assert.equal(result.frames, 1);
  assert.ok(
    result.rows.some(
      (row) => row.target === 'B/transport' && row.spans.some((s) => s.slot === 'field:peer_bytes'),
    ),
  );
});
