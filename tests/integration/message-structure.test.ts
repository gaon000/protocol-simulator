import assert from 'node:assert/strict';
import test from 'node:test';
import { createSimulation } from '../../src/application/create-simulation.ts';
import { editExperiment } from '../../src/application/edit-experiment.ts';
import {
  buildMessageStructure,
  STRUCTURE_POLICY,
  structureBytePage,
} from '../../src/application/message-structure.ts';
import { projectRecord } from '../../src/application/replay-record.ts';
import { captureRun } from '../../src/application/workspace-operations.ts';
import type {
  EngineView,
  EventTrace,
  ExperimentDefinition,
} from '../../src/domain/protocol-model.ts';
import { createExampleCopy, EXAMPLES } from '../../src/examples/catalog.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';
import { createMessageLimitExperiment } from '../fixtures/large-experiments.ts';

function run(config: ExperimentDefinition) {
  const created = createSimulation(config);
  assert.ok(created.success, created.success ? '' : JSON.stringify(created.diagnostics));
  return created.value.run();
}
function send(view: EngineView) {
  const event = view.events.find((item) => item.kind === 'send');
  assert.ok(event);
  return event;
}
function bytesText(bytes: readonly number[], start: number, end: number) {
  return new TextDecoder().decode(Uint8Array.from(bytes.slice(start, end)));
}
function withBytes(view: EngineView, event: EventTrace, text: string) {
  return {
    ...view,
    events: view.events.map((item) =>
      item.eventId === event.eventId
        ? {
            ...event,
            data: {
              ...(event.data as object),
              wire: { kind: 'bytes', bytes: [...new TextEncoder().encode(text)] },
            },
          }
        : item,
    ),
  } as EngineView;
}

test('all catalog send layouts preserve original wire references and valid bounded ranges', () => {
  for (const item of EXAMPLES) {
    const view = run(createExampleCopy(item.id));
    const before = JSON.stringify(view);
    for (const event of view.events.filter((item) => item.kind === 'send')) {
      const model = buildMessageStructure(view, event.eventId);
      assert.notEqual(model.status, 'unavailable', item.id);
      const bytes = (event.data as { wire: { bytes?: readonly number[] } }).wire.bytes;
      if (bytes) assert.equal(model.bytes, bytes);
      for (const area of [
        ...model.regions.map((item) => item.range),
        ...model.fields.flatMap((item) => (item.range ? [item.range] : [])),
      ]) {
        assert.ok(area.start >= 0 && area.end >= area.start && area.end <= (bytes?.length ?? 0));
      }
    }
    assert.equal(JSON.stringify(view), before);
  }
});

test('HTTP maps start-line roles, headers, computed Content-Length and UTF-8 body offsets', () => {
  const config = editExperiment(
    createExampleCopy('http_post'),
    '/scenario/inputs/0/message/values/body',
    '한글😀',
  );
  const view = run(config);
  const model = buildMessageStructure(view, send(view).eventId);
  assert.equal(model.status, 'mapped');
  assert.equal(model.bodyBytes, 10);
  assert.equal(model.declaredLength, 10);
  assert.deepEqual(model.regions.map((item) => item.id).slice(-2), ['separator', 'body']);
  const body = model.fields.find((item) => item.definition.id === 'body');
  assert.ok(body?.range && model.bytes);
  assert.equal(bytesText(model.bytes, body.range.start, body.range.end), '한글😀');
  const method = model.fields.find((item) => item.definition.id === 'method');
  assert.ok(method?.range);
  assert.equal(bytesText(model.bytes, method.range.start, method.range.end), 'POST');
  const host = model.fields.find((item) => item.definition.id === 'host');
  assert.ok(host?.range);
  assert.equal(bytesText(model.bytes, host.range.start, host.range.end), String(host.value));
  assert.equal(
    model.fields.some((item) => item.definition.name.toLowerCase() === 'content-length'),
    false,
  );
  const response = view.events.find((event) => event.kind === 'send' && event.participant === 'B');
  assert.ok(response);
  const reply = buildMessageStructure(view, response.eventId);
  assert.ok(reply.fields.find((item) => item.definition.id === 'status')?.range);
});

test('empty HTTP bodies have exact zero-length ranges and raw malformed HTTP remains explicitly raw', () => {
  const get = run(createExampleCopy('http_get'));
  const empty = buildMessageStructure(get, send(get).eventId);
  const body = empty.fields.find((item) => item.definition.id === 'body');
  assert.ok(body?.range);
  assert.equal(body.range.start, body.range.end);
  const broken = run(createExampleCopy('http_bad_header'));
  const raw = buildMessageStructure(broken, send(broken).eventId);
  assert.equal(raw.status, 'raw');
  assert.match(raw.note, /유효성 판정이 아닙니다/);
});

test('JSON token ranges use UTF-8 bytes and retain quotes, escapes, zero and false', () => {
  const base = createPingPongExperiment('json-datagram');
  const config = editExperiment(base, '/scenario/inputs/0/message/values/text', '한😀"\\');
  const view = run(config);
  const source = view.events.find((item) => item.kind === 'input');
  assert.ok(source);
  // The starter send omits optional fields, so send the validated input through the real codec actions.
  const actions = config.definitions[0]?.rules[0]?.actions;
  assert.ok(actions?.[1]);
  const configured = editExperiment(config, '/definitions/0/rules/0/actions/1/values', {
    sequence: { kind: 'literal', value: 0 },
    text: { kind: 'field', fieldId: 'text' },
    urgent: { kind: 'literal', value: false },
  });
  const actual = run(configured);
  const model = buildMessageStructure(actual, send(actual).eventId);
  assert.equal(model.status, 'mapped');
  const text = model.fields.find((item) => item.definition.id === 'text');
  assert.ok(text?.range && model.bytes);
  assert.equal(bytesText(model.bytes, text.range.start, text.range.end), JSON.stringify('한😀"\\'));
  assert.equal(model.fields.find((item) => item.definition.id === 'sequence')?.value, 0);
  assert.equal(model.fields.find((item) => item.definition.id === 'urgent')?.value, false);
  assert.equal(
    model.regions.some((item) => item.id === 'delimiter'),
    false,
  );
  assert.match(text.location, /논리 배치/);
});

test('JSON Lines identifies the real LF delimiter and refuses duplicate or malformed token maps', () => {
  const view = run(createExampleCopy('ping_pong'));
  const event = send(view);
  const model = buildMessageStructure(view, event.eventId);
  assert.equal(model.regions.at(-1)?.label, '메시지 구분자 LF');
  assert.ok(model.bytes);
  assert.equal(model.bytes.at(-1), 10);
  const extraFrame = withBytes(view, event, `${bytesText(model.bytes, 0, model.bytes.length)}\n`);
  assert.equal(buildMessageStructure(extraFrame, event.eventId).status, 'raw');
  const duplicate = withBytes(
    view,
    event,
    '{"messageId":"ping","fields":{"number":1,"number":2}}\n',
  );
  assert.equal(buildMessageStructure(duplicate, event.eventId).status, 'raw');
  const malformed = withBytes(view, event, '{"messageId":');
  assert.equal(buildMessageStructure(malformed, event.eventId).status, 'raw');
  const invalidUtf8 = {
    ...view,
    events: [
      { ...event, data: { ...(event.data as object), wire: { kind: 'bytes', bytes: [255] } } },
    ],
  } as EngineView;
  assert.equal(buildMessageStructure(invalidUtf8, event.eventId).status, 'raw');
  const mismatch = withBytes(view, event, '{"messageId":"ping","fields":{"number":2}}\n');
  assert.equal(buildMessageStructure(mismatch, event.eventId).status, 'raw');
});

test('logical packets show wire-named fields without pretending to have byte offsets', () => {
  const view = run(createPingPongExperiment('logical-packet'));
  const model = buildMessageStructure(view, send(view).eventId);
  assert.equal(model.status, 'logical');
  assert.equal(model.bytes, undefined);
  assert.match(model.note, /바이너리 TCP\/IP/);
  assert.ok(model.fields.every((field) => !field.range));
  assert.equal(
    model.fields.find((field) => field.definition.id === 'sequence')?.definition.name,
    'number',
  );
  assert.equal(model.fields.find((field) => field.definition.id === 'sequence')?.value, 1);
});

test('received byte chunks are never replaced by a complete source message or later parsed fields', () => {
  const view = run(createExampleCopy('http_split'));
  const receive = view.events.find((event) => event.kind === 'receive');
  assert.ok(receive);
  const model = buildMessageStructure(view, receive.eventId);
  assert.equal(model.status, 'chunk');
  assert.equal(model.fields.length, 0);
  assert.equal(model.regions.length, 1);
  const parsed = view.events.find((event) => event.kind === 'parsed');
  assert.ok(parsed);
  const values = buildMessageStructure(view, parsed.eventId);
  assert.equal(values.status, 'logical');
  assert.equal(values.bytes, undefined);
  assert.ok(values.fields.length > 0);
});

test('history cursor, changed drafts and unsupported snapshots never substitute field or wire data', () => {
  const view = run(createExampleCopy('http_post'));
  const event = send(view);
  const index = view.events.indexOf(event);
  const projected = projectRecord(captureRun(view, 'draft', 1), index);
  assert.equal(buildMessageStructure(projected, event.eventId, index).event, undefined);
  assert.ok(buildMessageStructure(projected, event.eventId, index + 1).event);
  const model = buildMessageStructure(view, event.eventId);
  const config = editExperiment(
    view.snapshot.configuration,
    '/definitions/0/messages/0/fields/0/name',
    'edited',
  );
  assert.notEqual(
    config.definitions[0]?.messages[0]?.fields[0]?.name,
    model.fields[0]?.definition.name,
  );
  const unknown = buildMessageStructure(
    { ...view, snapshot: { ...view.snapshot, engineVersion: 'future' } },
    event.eventId,
  );
  assert.equal(unknown.status, 'unavailable');
  assert.equal(unknown.bytes, model.bytes);
  assert.equal(unknown.fields.length, 0);
});

test('1 MiB JSON inspection is limited while byte pages retain all original offsets', () => {
  const view = run(createMessageLimitExperiment());
  const model = buildMessageStructure(view, send(view).eventId);
  assert.equal(model.status, 'limited');
  assert.equal(model.bytes?.length, 1_048_576);
  assert.equal(model.fields[0]?.range, undefined);
  assert.ok(model.bytes);
  assert.equal(structureBytePage(model.bytes, 0).values.length, 256);
  const final = structureBytePage(model.bytes, Number.MAX_SAFE_INTEGER);
  assert.equal(final.start + final.values.length, model.bytes.length);
  assert.equal(final.pages, 4096);
  assert.equal(structureBytePage(model.bytes, -2).start, 0);
  assert.equal(structureBytePage([], 100).values.length, 0);
});

test('large HTTP body ranges need only the header prefix, and duplicate headers never pick an arbitrary field', () => {
  const config = editExperiment(
    createExampleCopy('http_post'),
    '/scenario/inputs/0/message/values/body',
    '가'.repeat(30_000),
  );
  const view = run(config);
  const event = send(view);
  const model = buildMessageStructure(view, event.eventId);
  assert.equal(model.status, 'mapped');
  assert.equal(model.bodyBytes, 90_000);
  assert.equal(model.declaredLength, 90_000);
  assert.ok(model.bytes && model.bytes.length > STRUCTURE_POLICY.inspectedBytes);
  const duplicate = withBytes(
    view,
    event,
    'POST / HTTP/1.1\r\nHost: first\r\nHost: second\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\na',
  );
  const ambiguous = buildMessageStructure(duplicate, event.eventId);
  assert.equal(ambiguous.fields.find((field) => field.definition.id === 'host')?.range, undefined);
  assert.equal(ambiguous.declaredLength, undefined);
  assert.match(ambiguous.note, /중복 헤더/);
  const tooLong = withBytes(view, event, `POST / HTTP/1.1\r\nX-Long: ${'a'.repeat(40_000)}`);
  assert.equal(buildMessageStructure(tooLong, event.eventId).status, 'limited');
});

test('real messages with many fields have bounded field and token projections', () => {
  const base = createExampleCopy('ping_pong');
  const definition = base.definitions[0];
  assert.ok(definition);
  const protocol = {
    ...definition,
    messages: definition.messages.map((message) => ({
      ...message,
      fields: [
        ...message.fields,
        ...Array.from({ length: 130 }, (_, index) => ({
          id: `f${index}`,
          name: `wire${index}`,
          type: 'integer' as const,
          placement: 'payload' as const,
          required: false,
          defaultValue: index,
        })),
      ],
    })),
  };
  const view = run({ ...base, definitions: [protocol] });
  const model = buildMessageStructure(view, send(view).eventId);
  assert.equal(model.status, 'limited');
  assert.equal(model.fields.length, 128);
  assert.equal(model.totalFields, 134);
  assert.ok(model.regions.length <= 128);
});
