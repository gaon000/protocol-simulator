import assert from 'node:assert/strict';
import test from 'node:test';
import { createSimulation } from '../../src/application/create-simulation.ts';
import {
  buildDiagramLinks,
  diagramOccurrences,
  inspectDiagramLinks,
} from '../../src/application/diagram-links.ts';
import { editExperiment } from '../../src/application/edit-experiment.ts';
import { traceObject } from '../../src/application/sequence-diagram.ts';
import type { ExperimentDefinition } from '../../src/domain/protocol-model.ts';
import { EXAMPLES, getExampleOriginal } from '../../src/examples/catalog.ts';
import { createStopAndWaitExperiment } from '../../src/examples/stop-and-wait.ts';
import {
  createEventLimitExperiment,
  createMessageLimitExperiment,
} from '../fixtures/large-experiments.ts';

function run(config: ExperimentDefinition) {
  const created = createSimulation(config);
  assert.ok(created.success);
  return created.value.run();
}
test('catalog transitions link their exact trigger and effects without crossing participant boundaries', () => {
  for (const example of EXAMPLES) {
    const view = run(getExampleOriginal(example.id));
    const before = JSON.stringify(view);
    const links = buildDiagramLinks(view);
    for (const transition of links.transitions) {
      const inspection = inspectDiagramLinks(links, view, transition.eventId);
      assert.equal(inspection?.focusedTransition, transition);
      assert.equal(inspection?.participant, transition.participant);
      for (const id of inspection?.relatedEventIds ?? []) {
        const event = links.events.get(id);
        assert.equal(event?.participant, transition.participant);
        if (event?.ruleId) assert.equal(event.ruleId, transition.ruleId);
      }
      if (transition.causeEventId)
        assert.ok(inspection?.relatedEventIds.has(transition.causeEventId));
    }
    assert.equal(JSON.stringify(view), before);
  }
});
test('send effects select their committed rule and before/after state while a prefix cannot see its future commit', () => {
  const view = run(getExampleOriginal('ping_pong'));
  const position = view.events.findIndex((event) => event.kind === 'send');
  const send = view.events[position];
  assert.ok(send);
  const full = inspectDiagramLinks(buildDiagramLinks(view), view, send.eventId);
  assert.equal(full?.beforeStateId, 'Idle');
  assert.equal(full?.afterStateId, 'Waiting');
  assert.equal(full?.ruleIndex, 0);
  const prefix = inspectDiagramLinks(buildDiagramLinks(view, position + 1), view, send.eventId);
  assert.equal(prefix?.ruleIndex, 0);
  assert.equal(prefix?.transitions.length, 0);
  assert.equal(prefix?.beforeStateId, undefined);
  assert.equal(prefix?.afterStateId, undefined);
  assert.equal(
    inspectDiagramLinks(buildDiagramLinks(view, position), view, send.eventId),
    undefined,
  );
});
test('ACK loss and repeated retry rules retain distinct execution occurrences and sender environment causes', () => {
  const config = editExperiment(
    createStopAndWaitExperiment(),
    '/environment/directions/AtoB/lossRate',
    1,
  );
  const view = run(config);
  const links = buildDiagramLinks(view);
  const protocol = view.snapshot.configuration.definitions[0];
  const index = protocol?.rules.findIndex((rule) => rule.id === 'retry');
  assert.ok(index !== undefined && index >= 0);
  const target = { participant: 'A' as const, kind: 'rule' as const, index };
  const retries = diagramOccurrences(links, view, target);
  assert.equal(retries.length, 3);
  for (const retry of retries) {
    const inspection = inspectDiagramLinks(links, view, retry.eventId);
    assert.equal(inspection?.transitions.length, 1);
    const sends = [...(inspection?.relatedEventIds ?? [])]
      .map((id) => links.events.get(id))
      .filter((event) => event?.kind === 'send');
    assert.equal(sends.length, 1);
    assert.equal(sends[0]?.causeEventId, retry.causeEventId);
  }
  const drop = view.events.find((event) => event.kind === 'environment');
  assert.ok(drop);
  assert.equal(inspectDiagramLinks(links, view, drop.eventId)?.participant, 'A');
  assert.equal(inspectDiagramLinks(links, view, drop.eventId)?.transitions.length, 1);
  const selected = inspectDiagramLinks(links, view, retries[0]?.eventId, target);
  assert.equal(selected?.transitions.length, 3);
  assert.equal(selected?.focusedTransition, retries[0]);
});
test('state selections include real entries and exits, and unexecuted rules never borrow old occurrences', () => {
  const view = run(getExampleOriginal('ping_pong'));
  const links = buildDiagramLinks(view);
  const waiting = diagramOccurrences(links, view, { participant: 'A', kind: 'state', index: 1 });
  assert.deepEqual(
    waiting.map((event) => event.ruleId),
    ['start', 'complete'],
  );
  const missing = inspectDiagramLinks(links, view, undefined, {
    participant: 'A',
    kind: 'rule',
    index: 3,
  });
  assert.equal(missing?.transitions.length, 0);
  assert.equal(missing?.relatedEventIds.size, 0);
  assert.equal(missing?.focusedTransition, undefined);
});
test('coalesced reads can link several decoded transitions without choosing an arbitrary one', () => {
  const base = getExampleOriginal('ping_pong');
  const actions = base.definitions[0]?.rules[0]?.actions;
  assert.ok(actions?.[1]);
  let config = editExperiment(base, '/definitions/0/rules/0/actions', [
    ...actions.slice(0, 2),
    actions[1],
    ...actions.slice(2),
  ]);
  config = editExperiment(config, '/environment/directions/AtoB/chunkBytes', 65536);
  const view = run(config);
  const read = view.events.find((event) => event.kind === 'receive' && event.participant === 'B');
  assert.ok(read);
  const inspection = inspectDiagramLinks(buildDiagramLinks(view), view, read.eventId);
  assert.equal(inspection?.transitions.length, 2);
  assert.equal(inspection?.focusedTransition, undefined);
  assert.equal(inspection?.ruleIndex, undefined);
  assert.equal(inspection?.beforeStateId, undefined);
});
test('unparsed split chunks and timer expiry before its transition have no invented state changes', () => {
  const view = run(getExampleOriginal('http_split'));
  const links = buildDiagramLinks(view);
  const read = view.events.find((event) => event.kind === 'receive');
  assert.ok(read);
  assert.equal(inspectDiagramLinks(links, view, read.eventId)?.transitions.length, 0);
  const timeout = run(getExampleOriginal('http_delayed'));
  const index = timeout.events.findIndex(
    (event) => event.kind === 'timer' && traceObject(event.data).operation === 'expire',
  );
  const expiry = timeout.events[index];
  assert.ok(expiry);
  assert.equal(
    inspectDiagramLinks(buildDiagramLinks(timeout, index + 1), timeout, expiry.eventId)?.transitions
      .length,
    0,
  );
  assert.ok(
    inspectDiagramLinks(buildDiagramLinks(timeout), timeout, expiry.eventId)?.transitions.length,
  );
});
test('duplicate packet ignore stays a distinct self transition and unrelated raw receives never point to the sender rule', () => {
  const config = editExperiment(
    createStopAndWaitExperiment(),
    '/environment/directions/AtoB/duplicateRate',
    1,
  );
  const view = run(config);
  const links = buildDiagramLinks(view);
  for (const event of view.events.filter(
    (item) => item.kind === 'receive' && item.participant === 'B',
  )) {
    const inspection = inspectDiagramLinks(links, view, event.eventId);
    assert.ok(inspection?.transitions.every((transition) => transition.participant === 'B'));
    assert.equal(
      [...(inspection?.relatedEventIds ?? [])].some(
        (id) => links.events.get(id)?.participant === 'A',
      ),
      false,
    );
  }
  const ignored = view.events.find(
    (event) => event.kind === 'transition' && traceObject(event.data).ignored,
  );
  assert.ok(ignored);
  const inspection = inspectDiagramLinks(links, view, ignored.eventId);
  assert.equal(inspection?.beforeStateId, inspection?.afterStateId);
});
test('10k occurrences and a 1 MiB wire retain shared records and bounded inspection metadata', () => {
  const large = run(createMessageLimitExperiment());
  const send = large.events.find((event) => event.kind === 'send');
  assert.ok(send);
  const links = buildDiagramLinks(large);
  assert.equal(links.events.get(send.eventId), send);
  const inspection = inspectDiagramLinks(links, large, send.eventId);
  assert.ok(inspection?.focusedTransition);
  assert.ok((inspection?.key.length ?? Infinity) < 100);
  const limit = run(createEventLimitExperiment());
  const full = buildDiagramLinks(limit);
  const empty = buildDiagramLinks(limit, 0);
  assert.equal(full.events.size, 10_000);
  assert.ok(full.transitions.length > 3000);
  assert.equal(
    diagramOccurrences(empty, limit, { participant: 'A', kind: 'rule', index: 1 }).length,
    0,
  );
});

test('missing trigger evidence never groups independent effects and commits merely by matching rule ID', () => {
  const view = run(getExampleOriginal('ping_pong'));
  const send = view.events.find((event) => event.kind === 'send');
  const transition = view.events.find((event) => event.kind === 'transition');
  assert.ok(send && transition);
  const { causeEventId: _sendCause, ...unknownSend } = send;
  const { causeEventId: _transitionCause, ...unknownTransition } = transition;
  const links = buildDiagramLinks({ events: [unknownSend, unknownTransition] });
  assert.equal(inspectDiagramLinks(links, view, send.eventId)?.transitions.length, 0);
});
