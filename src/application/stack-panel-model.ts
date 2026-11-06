import type { JsonValue } from '../domain/execution-contract.ts';
import { type StackEndpoint, type StackTrace, stackProtocolBody } from '../domain/stack-model.ts';
import { stackObject, stackProtocolAt, stackTarget } from '../domain/stack-record.ts';
import type { SavedStackRun } from '../domain/workspace-v2-model.ts';
import { previewJson } from './preview-json.ts';
import { compareStackRuns } from './stack-comparison.ts';
import { buildStackCoverage } from './stack-coverage.ts';
import { diagnoseStackExpectation } from './stack-diagnostics.ts';
import {
  buildStackMessageStructure,
  buildStackSequence,
  buildStackStateDiagram,
  stackEventLinks,
  stackRuleOccurrences,
} from './stack-diagrams.ts';
import { explainStackExecution } from './stack-explanation.ts';
import { projectStackRecord } from './stack-replay.ts';
import { buildStackMessageJourney, type StackJourneyQuery } from './stack-message-journey.ts';

export type StackPanelQuery = {
  readonly cursor: number;
  readonly endpoint: StackEndpoint;
  readonly page: number;
  readonly statePage: number;
  readonly rulePage: number;
  readonly layer: 'all' | 'application' | 'transport';
  readonly filterTarget: boolean;
  readonly eventId?: string;
  readonly ruleId?: string;
  readonly stateId?: string;
  readonly followSelection?: boolean;
  readonly detail: 'event' | 'explanation' | 'structure' | 'diagnosis' | 'journey';
  readonly journey?: StackJourneyQuery;
  readonly bytePage: number;
  readonly rangeIndex: number;
  readonly expectationId?: string;
};
const text = (value: JsonValue | undefined, size = 240) =>
  previewJson(value ?? null).text.slice(0, size);
function eventRow(event: StackTrace, cursor: number) {
  const data = stackObject(event.data);
  return {
    id: event.eventId,
    cursor,
    endpoint: event.endpoint,
    target: stackTarget(event.endpoint),
    kind: event.kind,
    timeMs: event.timeMs,
    title:
      `${event.kind} ${String(data.operation ?? data.ruleId ?? stackObject(data.message).messageId ?? '')} ${String(data.outcome ?? '')}`.slice(
        0,
        160,
      ),
  };
}

/** Build only bounded presentation data in a worker, keeping full records and payloads outside the DOM. */
export function buildStackPanelModel(record: SavedStackRun, query: StackPanelQuery) {
  const projected = projectStackRecord(record, query.cursor);
  if (!projected.success)
    return {
      status: 'unavailable' as const,
      message: projected.diagnostics[0]?.message ?? '기록을 읽을 수 없습니다.',
    };
  const view = projected.value;
  const actor = view.instances[stackTarget(query.endpoint)];
  const protocol = stackProtocolAt(view.snapshot, query.endpoint);
  const body = stackProtocolBody(protocol);
  const diagram = buildStackStateDiagram(record, query.endpoint, query.cursor, {
    statePage: query.statePage,
    rulePage: query.rulePage,
  });
  const filtered = view.events.filter(
    (event) =>
      (!query.filterTarget || stackTarget(event.endpoint) === stackTarget(query.endpoint)) &&
      (query.layer === 'all' ||
        stackProtocolBody(stackProtocolAt(view.snapshot, event.endpoint)).layer === query.layer),
  );
  const selectedIndex = filtered.findIndex((event) => event.eventId === query.eventId);
  const sequence = buildStackSequence(record, query.cursor, {
    page: query.followSelection && selectedIndex >= 0 ? Math.floor(selectedIndex / 30) : query.page,
    ...(query.filterTarget ? { endpoint: query.endpoint } : {}),
    ...(query.layer !== 'all' ? { layer: query.layer } : {}),
  });
  const positions = new Map(view.events.map((e, index) => [e.eventId, index + 1]));
  const selected = view.events.find((e) => e.eventId === query.eventId);
  const selectedRow = selected
    ? {
        ...eventRow(selected, positions.get(selected.eventId) ?? 0),
        preview: text(selected.data, 1600),
      }
    : undefined;
  const links =
    selected && query.detail === 'event'
      ? stackEventLinks(record, selected.eventId, query.cursor)
      : undefined;
  const occurrences = query.ruleId
    ? stackRuleOccurrences(record, query.endpoint, query.ruleId, query.cursor)
    : undefined;
  const stateRows = query.stateId
    ? view.events.flatMap((event, index) =>
        event.kind === 'transition' &&
        stackTarget(event.endpoint) === stackTarget(query.endpoint) &&
        stackObject(stackObject(event.data).after).stateId === query.stateId
          ? [eventRow(event, index + 1)]
          : [],
      )
    : [];
  const initial = query.stateId === body.initialStateId;
  const explanation =
    selected && query.detail === 'explanation'
      ? explainStackExecution(record, selected.eventId, query.cursor)
      : undefined;
  const structure =
    selected && query.detail === 'structure'
      ? buildStackMessageStructure(
          record,
          selected.eventId,
          query.cursor,
          query.rangeIndex,
          query.bytePage,
        )
      : undefined;
  const diagnosis =
    query.detail === 'diagnosis' && query.expectationId
      ? diagnoseStackExpectation(record, query.expectationId, query.cursor)
      : undefined;
  const explanationModel = explanation
    ? {
        status: explanation.status,
        message: explanation.message,
        candidates: explanation.candidates.slice(0, 20).map((c) => ({
          id: c.id,
          selected: c.selected,
          result: c.result,
          conditions: c.conditions.slice(0, 3).map((condition) => ({
            path: condition.path.slice(0, 100),
            result: condition.result,
            left: condition.left?.text.slice(0, 100),
            right: condition.right?.text.slice(0, 100),
          })),
          limited: c.conditions.length > 3,
        })),
        assignments: explanation.assignments.slice(0, 20).map((a) => ({
          id: a.variableId,
          index: a.actionIndex,
          before: a.before.text.slice(0, 100),
          after: a.after.text.slice(0, 100),
        })),
        changes: explanation.changes.slice(0, 20).map((c) => ({
          id: c.id,
          before: c.before.text.slice(0, 100),
          after: c.after.text.slice(0, 100),
        })),
      }
    : undefined;
  return {
    status: 'available' as const,
    timeMs: view.timeMs,
    cursor: query.cursor,
    maxCursor: record.view.events.length + 1,
    actor: actor
      ? {
          stateId: actor.stateId,
          outcome: actor.outcome,
          ports: actor.ports,
          buffers: actor.buffers,
          timers: actor.timers.slice(0, 20),
          variables: Object.entries(actor.variables)
            .slice(0, 20)
            .map(([id, value]) => ({ id, value: text(value, 180) })),
          totalVariables: Object.keys(actor.variables).length,
        }
      : undefined,
    counts: {
      sends: view.events.filter(
        (e) => stackTarget(e.endpoint) === stackTarget(query.endpoint) && e.kind === 'send',
      ).length,
      parsed: view.events.filter(
        (e) => stackTarget(e.endpoint) === stackTarget(query.endpoint) && e.kind === 'parsed',
      ).length,
      deliveries: view.events.filter(
        (e) => stackTarget(e.endpoint) === stackTarget(query.endpoint) && e.kind === 'deliver',
      ).length,
    },
    globalBytes: query.cursor === record.view.events.length + 1 ? view.usage.liveBytes : undefined,
    artifactBytes: view.usage.artifactBytes,
    diagram: diagram.success
      ? {
          ...diagram.value.diagram,
          nodes: diagram.value.diagram.nodes.map((n) => ({ ...n, label: n.label.slice(0, 80) })),
        }
      : undefined,
    rules: diagram.success
      ? diagram.value.diagram.visibleRules.flatMap((index) => {
          const rule = body.rules[index];
          return rule
            ? [
                {
                  id: rule.id,
                  from: rule.fromStateId,
                  to: rule.nextStateId,
                  description: text(rule as unknown as JsonValue, 200),
                },
              ]
            : [];
        })
      : [],
    sequence: sequence.success
      ? {
          page: sequence.value.page,
          pages: sequence.value.pages,
          total: sequence.value.total,
          rows: sequence.value.rows.map((row) => ({
            ...eventRow(row.event, row.cursor),
            title: `${row.title} ${String(stackObject(row.event.data).outcome ?? '')}`.slice(
              0,
              180,
            ),
            causes: row.causes,
            limited: row.limited,
            from: ['receive', 'service-received'].includes(row.event.kind)
              ? (() => {
                  const source = view.events.find((event) =>
                    row.event.sourceEventIds.includes(event.eventId),
                  );
                  return source ? stackTarget(source.endpoint) : stackTarget(row.event.endpoint);
                })()
              : stackTarget(row.event.endpoint),
            to: ['service-request', 'service-indication'].includes(row.event.kind)
              ? (() => {
                  const target = stackObject(stackObject(row.event.data).target);
                  return target.participant && target.instanceId
                    ? `${String(target.participant)}/${String(target.instanceId)}`
                    : stackTarget(row.event.endpoint);
                })()
              : stackTarget(row.event.endpoint),
            pending: ['service-request', 'service-indication'].includes(row.event.kind),
          })),
        }
      : undefined,
    selected: selectedRow,
    journey:
      query.detail === 'journey'
        ? buildStackMessageJourney(record, query.cursor, query.journey, query.eventId)
        : undefined,
    links: links?.success
      ? {
          limited: links.value.limited,
          causes: links.value.directCauses.map((r) => eventRow(r.event, r.cursor)),
          children: links.value.directChildren.map((r) => eventRow(r.event, r.cursor)),
          commits: links.value.commits.map((r) => eventRow(r.event, r.cursor)),
        }
      : undefined,
    stateOccurrences: query.stateId
      ? { initial, total: stateRows.length + Number(initial), rows: stateRows.slice(0, 20) }
      : undefined,
    occurrences: occurrences?.success
      ? {
          total: occurrences.value.total,
          rows: occurrences.value.rows.map((r) => eventRow(r.event, r.cursor)),
        }
      : undefined,
    explanation: explanationModel,
    structure: structure?.success
      ? {
          status: structure.value.status,
          note: structure.value.note,
          limited: structure.value.limited,
          codec: structure.value.codec,
          fields: structure.value.fields.map((f) => ({
            id: f.id,
            name: f.name,
            type: f.type,
            value: f.value.text.slice(0, 140),
            range: structure.value.layout?.ranges[f.id],
          })),
          totalFields: structure.value.totalFields,
          ranges: structure.value.ranges.slice(0, 20),
          totalRanges: structure.value.ranges.length,
          bytePage: structure.value.bytePage,
          regions: structure.value.layout?.regions.slice(0, 20),
          selected: structure.value.selected,
        }
      : undefined,
    expectations: view.expectations
      .slice(0, 20)
      .map((e) => ({ ...e, detail: e.detail.slice(0, 200) })),
    diagnosis: diagnosis?.success
      ? {
          status: diagnosis.value.status,
          note: diagnosis.value.note,
          expected: text(diagnosis.value.expected as unknown as JsonValue),
          observed: diagnosis.value.observed.text.slice(0, 240),
          limited: diagnosis.value.limited,
          evidence: diagnosis.value.evidence.map((r) => eventRow(r.event, r.cursor)),
          ancestors: diagnosis.value.ancestors.map((r) => eventRow(r.event, r.cursor)),
          references: diagnosis.value.references.map((r) => eventRow(r.event, r.cursor)),
        }
      : undefined,
    diagnostics: view.diagnostics.slice(0, 20),
  };
}
export type StackPanelModel = ReturnType<typeof buildStackPanelModel>;

/** Return two independent cursor columns and bounded summaries without sending raw event data to the UI. */
export function buildStackComparisonModel(left: SavedStackRun, right: SavedStackRun, page: number) {
  const result = compareStackRuns(left, right, page);
  const row = (r: (typeof result.rows)[number]) => ({
    relation: r.relation,
    left: r.left ? eventRow(r.left, r.leftCursor ?? 0) : undefined,
    right: r.right ? eventRow(r.right, r.rightCursor ?? 0) : undefined,
  });
  return {
    status: result.status,
    message: result.message,
    limited: result.limited,
    page: 'page' in result ? result.page : 0,
    pages: 'pages' in result ? result.pages : 1,
    rows: result.rows.map(row),
    firstDifference:
      'firstDifference' in result && result.firstDifference
        ? row(result.firstDifference)
        : undefined,
    differences: result.differences.map((d) => ({
      path: d.path,
      relation: d.relation,
      left: d.left.text.slice(0, 260),
      right: d.right.text.slice(0, 260),
    })),
  };
}
export type StackComparisonModel = ReturnType<typeof buildStackComparisonModel>;

/** Page endpoint coverage with case-specific first-observation cursors and explicit missing/excluded status. */
export function buildStackCoverageModel(
  records: readonly SavedStackRun[],
  groupId: string,
  page: number,
  endpoint: string,
  unobservedOnly: boolean,
) {
  const result = buildStackCoverage(records, groupId, { page, endpoint, unobservedOnly });
  return {
    status: result.status,
    message: result.message,
    cases: result.cases,
    excluded: result.excluded.slice(0, 20),
    page: 'page' in result ? result.page : 0,
    pages: 'pages' in result ? result.pages : 1,
    partial: 'partial' in result ? result.partial : true,
    items: result.items,
  };
}
export type StackCoverageModel = ReturnType<typeof buildStackCoverageModel>;
