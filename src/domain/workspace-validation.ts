import { EXECUTION_POLICY } from './execution-contract.ts';
import { valueAt } from './json-pointer.ts';
import {
  parseExperiment,
  parseExperimentDraft,
  parseJsonData,
  Reader,
  validateProtocolMessage,
} from './model-validation.ts';
import type {
  ExperimentDefinition,
  ExperimentSnapshot,
  ModelDiagnostic,
  ProtocolDefinition,
  ValidationResult,
} from './protocol-model.ts';
import {
  WORKSPACE_POLICY,
  type WorkspaceBundle,
  type WorkspaceData,
  type WorkspaceEnvelope,
} from './workspace-model.ts';

type ObjectData = Record<string, unknown>;
function fail<T>(code: string, message: string, path = '/'): ValidationResult<T> {
  return { success: false, diagnostics: [{ path, code, message }] };
}
function prefix(r: Reader, path: string, result: ValidationResult<unknown>) {
  if (!result.success)
    r.diagnostics.push(
      ...result.diagnostics.map((item) => ({
        ...item,
        path: `${path}${item.path === '/' ? '' : item.path}`,
      })),
    );
}
function strictObject(
  value: unknown,
  path: string,
  keys: readonly string[],
  r: Reader,
): ObjectData | undefined {
  const node = r.object(value, path, keys, keys);
  if (
    node &&
    Object.values(Object.getOwnPropertyDescriptors(node)).some((item) => !('value' in item))
  ) {
    r.issue(path, 'json-accessor', 'Records cannot contain accessors');
    return undefined;
  }
  return node;
}
function rawAllowed(configuration: ExperimentDefinition, path: string): boolean {
  if (!path.startsWith('/') || /~(?![01])/.test(path) || valueAt(configuration, path) === undefined)
    return false;
  if (/^\/definitions\/\d+\/variables\/\d+\/initial$/.test(path)) return true;
  const parent = valueAt(configuration, path.slice(0, path.lastIndexOf('/'))) as
    | ObjectData
    | undefined;
  if (path.startsWith('/definitions/') && path.endsWith('/value') && parent?.kind === 'literal')
    return true;
  const match = /^(\/scenario\/(?:inputs|expectations)\/\d+\/message)\/values\/([^/]+)$/.exec(path);
  if (!match) return false;
  const message = valueAt(configuration, match[1] ?? '') as ObjectData | undefined;
  const id = (match[2] ?? '').replace(/~1/g, '/').replace(/~0/g, '~');
  return configuration.definitions.some((protocol) =>
    protocol.messages.some(
      (item) =>
        item.id === message?.messageId && item.http?.kind === 'raw' && item.http.wireFieldId === id,
    ),
  );
}

/** Derive the execution-blocking errors of unfinished JSON without discarding the saved text. */
export function rawDiagnostics(raw: Readonly<Record<string, string>>): readonly ModelDiagnostic[] {
  const diagnostics: ModelDiagnostic[] = [];
  for (const [path, text] of Object.entries(raw)) {
    try {
      const parsed = parseJsonData(JSON.parse(text));
      if (!parsed.success)
        diagnostics.push({
          path,
          code: 'json-syntax',
          message: '유한한 JSON 값과 깊이·크기 제한을 확인하세요.',
        });
    } catch {
      diagnostics.push({ path, code: 'json-syntax', message: 'JSON 값의 문법을 확인하세요.' });
    }
  }
  return diagnostics;
}

function inspectSnapshot(value: unknown, path: string, r: Reader): ExperimentSnapshot | undefined {
  const node = strictObject(
    value,
    path,
    ['schemaVersion', 'engineVersion', 'randomAlgorithm', 'seed', 'configuration', 'limits'],
    r,
  );
  if (!node) return;
  r.choice(node.schemaVersion, `${path}/schemaVersion`, [1]);
  r.text(node.engineVersion, `${path}/engineVersion`);
  r.text(node.randomAlgorithm, `${path}/randomAlgorithm`);
  r.number(node.seed, `${path}/seed`, 0, 0xffff_ffff);
  const configuration = parseExperiment(node.configuration);
  prefix(r, `${path}/configuration`, configuration);
  if (!configuration.success) return;
  if (node.seed !== configuration.value.seed)
    r.issue(`${path}/seed`, 'snapshot-seed', 'Snapshot and configuration seeds differ');
  const keys = ['maxEvents', 'maxMessageBytes', 'maxBufferBytes', 'maxTraceBytes'] as const;
  const limits = strictObject(node.limits, `${path}/limits`, keys, r);
  if (limits)
    for (const key of keys)
      r.number(limits[key], `${path}/limits/${key}`, 1, EXECUTION_POLICY[key]);
  return value as ExperimentSnapshot;
}

/** Validate a complete historical snapshot before viewing or explicitly rerunning it. */
export function parseRecordedSnapshot(value: unknown): ValidationResult<ExperimentSnapshot> {
  const json = parseJsonData(value);
  if (!json.success) return json;
  const r = new Reader();
  const snapshot = inspectSnapshot(value, '', r);
  return snapshot ? r.result(snapshot) : { success: false, diagnostics: r.diagnostics };
}

/** Explain whether this build can execute a historical snapshot with its original policy. */
export function snapshotCompatibility(snapshot: ExperimentSnapshot): string | undefined {
  if (snapshot.engineVersion !== EXECUTION_POLICY.engineVersion)
    return `이 기록의 엔진 ${snapshot.engineVersion}은 현재 엔진 ${EXECUTION_POLICY.engineVersion}과 달라 재실행할 수 없습니다.`;
  if (snapshot.randomAlgorithm !== EXECUTION_POLICY.randomAlgorithm)
    return '이 기록의 난수 알고리즘은 현재 엔진에서 재실행할 수 없습니다.';
  return undefined;
}
function protocolFor(snapshot: ExperimentSnapshot, actor: 'A' | 'B'): ProtocolDefinition {
  const reference = snapshot.configuration.protocols[actor];
  const found = snapshot.configuration.definitions.find(
    (item) => item.id === reference.id && item.revision === reference.revision,
  );
  if (!found) throw new Error('Validated snapshot protocol missing');
  return found;
}
function inspectVariables(value: unknown, protocol: ProtocolDefinition, path: string, r: Reader) {
  const variables = r.object(
    value,
    path,
    protocol.variables.map((item) => item.id),
    protocol.variables.map((item) => item.id),
  );
  if (!variables) return;
  for (const variable of protocol.variables) {
    const current = variables[variable.id];
    if (
      variable.type !== 'json' &&
      (variable.type === 'integer'
        ? typeof current !== 'number' || !Number.isSafeInteger(current)
        : typeof current !== variable.type)
    )
      r.issue(
        `${path}/${variable.id}`,
        'variable-type',
        'Recorded variable type differs from the snapshot',
      );
  }
}
function inspectWire(value: unknown, path: string, r: Reader) {
  const wire = r.object(value, path);
  if (!wire) return;
  if (wire.kind === 'bytes') {
    r.object(wire, path, ['kind', 'bytes'], ['bytes']);
    if (!Array.isArray(wire.bytes) || wire.bytes.length > EXECUTION_POLICY.maxMessageBytes) {
      r.issue(`${path}/bytes`, 'wire-bytes', 'Expected bounded byte array');
      return;
    }
    for (let i = 0; i < wire.bytes.length; i++)
      if (!Number.isInteger(wire.bytes[i]) || wire.bytes[i] < 0 || wire.bytes[i] > 255) {
        r.issue(`${path}/bytes/${i}`, 'wire-byte', 'Expected byte in [0,255]');
        break;
      }
  } else if (wire.kind === 'packet') {
    r.object(wire, path, ['kind', 'packet'], ['packet']);
    const packet = strictObject(wire.packet, `${path}/packet`, ['messageId', 'fields'], r);
    if (!packet) return;
    r.text(packet.messageId, `${path}/packet/messageId`, true);
    const fields = r.object(packet.fields, `${path}/packet/fields`);
    if (fields)
      for (const [key, item] of Object.entries(fields))
        if (!['string', 'number', 'boolean'].includes(typeof item))
          r.issue(`${path}/packet/fields/${key}`, 'wire-field', 'Expected scalar packet field');
  } else r.issue(`${path}/kind`, 'wire-kind', 'Unknown wire payload');
}
function inspectDiagnostic(value: unknown, path: string, r: Reader) {
  const item = strictObject(value, path, ['path', 'code', 'message'], r);
  if (!item) return;
  for (const key of ['path', 'code', 'message']) r.text(item[key], `${path}/${key}`);
}
function inspectView(value: unknown, path: string, r: Reader) {
  const view = strictObject(
    value,
    path,
    [
      'runId',
      'status',
      'timeMs',
      'processedEvents',
      'participants',
      'events',
      'diagnostics',
      'expectations',
      'snapshot',
    ],
    r,
  );
  if (!view) return;
  const snapshot = inspectSnapshot(view.snapshot, `${path}/snapshot`, r);
  if (!snapshot || r.diagnostics.length) return;
  r.text(view.runId, `${path}/runId`, true);
  r.choice(view.status, `${path}/status`, [
    'idle',
    'running',
    'paused',
    'completed',
    'cancelled',
    'invalid',
    'limit-reached',
    'engine-error',
  ]);
  r.number(view.timeMs, `${path}/timeMs`, 0, snapshot.configuration.scenario.observationMs);
  r.number(view.processedEvents, `${path}/processedEvents`, 0, snapshot.limits.maxEvents);
  const participants = strictObject(view.participants, `${path}/participants`, ['A', 'B'], r);
  if (!participants) return;
  for (const id of ['A', 'B'] as const) {
    const actorPath = `${path}/participants/${id}`;
    const actor = strictObject(
      participants[id],
      actorPath,
      ['stateId', 'variables', 'outcome', 'finishedAt', 'timers'],
      r,
    );
    if (!actor) continue;
    const protocol = protocolFor(snapshot, id);
    r.choice(
      actor.stateId,
      `${actorPath}/stateId`,
      protocol.states.map((item) => item.id),
    );
    r.choice(actor.outcome, `${actorPath}/outcome`, ['active', 'success', 'failure', 'error']);
    if (actor.finishedAt !== null)
      r.number(actor.finishedAt, `${actorPath}/finishedAt`, 0, Number(view.timeMs));
    inspectVariables(actor.variables, protocol, `${actorPath}/variables`, r);
    const timerIds = new Set<string>();
    r.array(actor.timers, `${actorPath}/timers`, (value, location) => {
      const timer = strictObject(value, location, ['timerId', 'generation', 'active', 'due'], r);
      if (!timer) return;
      r.choice(
        timer.timerId,
        `${location}/timerId`,
        protocol.timers.map((item) => item.id),
      );
      if (timerIds.has(String(timer.timerId)))
        r.issue(location, 'duplicate-timer', 'Duplicate recorded timer');
      timerIds.add(String(timer.timerId));
      r.number(timer.generation, `${location}/generation`);
      r.choice(timer.active, `${location}/active`, [true, false]);
      r.number(timer.due, `${location}/due`);
    });
    if (timerIds.size !== protocol.timers.length)
      r.issue(`${actorPath}/timers`, 'missing-timer', 'Recorded timers must include every timer');
  }
  const seen = new Map<string, string>();
  let previousTime = 0;
  let bytes = 0;
  if (Array.isArray(view.events) && view.events.length > snapshot.limits.maxEvents)
    r.issue(`${path}/events`, 'event-limit', 'Too many recorded events');
  r.array(view.events, `${path}/events`, (value, location) => {
    const event = r.object(
      value,
      location,
      [
        'schemaVersion',
        'runId',
        'eventId',
        'timeMs',
        'sequence',
        'kind',
        'participant',
        'causeEventId',
        'ruleId',
        'data',
      ],
      ['data'],
    );
    if (!event) return;
    const index = seen.size;
    r.choice(event.schemaVersion, `${location}/schemaVersion`, [1]);
    r.choice(event.runId, `${location}/runId`, [view.runId]);
    r.text(event.eventId, `${location}/eventId`, true);
    if (seen.has(String(event.eventId))) r.issue(location, 'duplicate-event', 'Duplicate event ID');
    r.choice(event.sequence, `${location}/sequence`, [index]);
    r.number(event.timeMs, `${location}/timeMs`, previousTime, Number(view.timeMs));
    previousTime = Number(event.timeMs);
    r.choice(event.kind, `${location}/kind`, [
      'input',
      'send',
      'receive',
      'parsed',
      'deliver',
      'timer',
      'connection',
      'transition',
      'environment',
      'diagnostic',
    ]);
    r.choice(event.participant, `${location}/participant`, ['A', 'B']);
    if (event.causeEventId !== undefined && !seen.has(String(event.causeEventId)))
      r.issue(`${location}/causeEventId`, 'cause-reference', 'Cause must be a preceding event');
    const protocol = protocolFor(snapshot, event.participant === 'B' ? 'B' : 'A');
    if (event.ruleId !== undefined)
      r.choice(
        event.ruleId,
        `${location}/ruleId`,
        protocol.rules.map((item) => item.id),
      );
    const data = r.object(event.data, `${location}/data`);
    if (data) {
      if (['input', 'send', 'parsed', 'deliver'].includes(String(event.kind)))
        prefix(r, `${location}/data/message`, validateProtocolMessage(protocol, data.message));
      if (['send', 'receive'].includes(String(event.kind)))
        inspectWire(data.wire, `${location}/data/wire`, r);
      if (event.kind === 'receive') {
        r.choice(data.from, `${location}/data/from`, [event.participant === 'A' ? 'B' : 'A']);
        if (data.copy !== undefined)
          r.choice(data.copy, `${location}/data/copy`, ['original', 'duplicate']);
        if (data.transmission !== undefined)
          r.number(data.transmission, `${location}/data/transmission`, 1);
        if (data.sourceEventIds !== undefined)
          r.array(data.sourceEventIds, `${location}/data/sourceEventIds`, (id, itemPath) => {
            if (typeof id !== 'string' || seen.get(id) !== 'send')
              r.issue(itemPath, 'source-reference', 'Stream source must reference an earlier send');
          });
      } else if (event.kind === 'transition') {
        for (const key of ['before', 'after']) {
          const state = strictObject(
            data[key],
            `${location}/data/${key}`,
            ['stateId', 'variables'],
            r,
          );
          if (state) {
            r.choice(
              state.stateId,
              `${location}/data/${key}/stateId`,
              protocol.states.map((item) => item.id),
            );
            inspectVariables(state.variables, protocol, `${location}/data/${key}/variables`, r);
          }
        }
        r.choice(data.outcome, `${location}/data/outcome`, [
          'active',
          'success',
          'failure',
          'error',
        ]);
        r.choice(data.ignored, `${location}/data/ignored`, [true, false]);
      } else if (event.kind === 'timer') {
        r.choice(data.operation, `${location}/data/operation`, ['start', 'cancel', 'expire']);
        r.choice(
          data.timerId,
          `${location}/data/timerId`,
          protocol.timers.map((item) => item.id),
        );
        r.number(data.generation, `${location}/data/generation`);
        if (data.operation === 'start') r.number(data.due, `${location}/data/due`);
      } else if (event.kind === 'connection')
        r.choice(data.state, `${location}/data/state`, ['closed', 'failed']);
      else if (event.kind === 'diagnostic') inspectDiagnostic(data, `${location}/data`, r);
    }
    seen.set(String(event.eventId), String(event.kind));
    bytes += new TextEncoder().encode(JSON.stringify({ ...event, runId: '' })).length;
  });
  if (bytes > snapshot.limits.maxTraceBytes)
    r.issue(`${path}/events`, 'trace-limit', 'Recorded trace exceeds its captured limit');
  r.array(view.diagnostics, `${path}/diagnostics`, (value, location) =>
    inspectDiagnostic(value, location, r),
  );
  const expected = snapshot.configuration.scenario.expectations;
  let count = 0;
  r.array(view.expectations, `${path}/expectations`, (value, location) => {
    const item = strictObject(value, location, ['expectationId', 'status', 'detail'], r);
    const definition = expected[count++];
    if (!item) return;
    r.choice(item.expectationId, `${location}/expectationId`, [definition?.id]);
    r.choice(item.status, `${location}/status`, ['pass', 'fail', 'undetermined']);
    r.text(item.detail, `${location}/detail`);
    const actor = participants[definition?.participant ?? 'A'] as ObjectData | undefined;
    if (
      (view.status !== 'completed' || actor?.outcome === 'error') &&
      item.status !== 'undetermined'
    )
      r.issue(
        `${location}/status`,
        'incomplete-result',
        'Incomplete observations cannot pass or fail',
      );
  });
  if (count !== expected.length)
    r.issue(
      `${path}/expectations`,
      'expectation-count',
      'Recorded checks differ from snapshot expectations',
    );
}

/** Validate untrusted workspace data before it can replace or merge with local data. */
export function parseWorkspaceData(value: unknown): ValidationResult<WorkspaceData> {
  const json = parseJsonData(value, {
    maxNodes: WORKSPACE_POLICY.maxJsonNodes,
    maxDepth: WORKSPACE_POLICY.maxJsonDepth,
  });
  if (!json.success) return json;
  if (new TextEncoder().encode(JSON.stringify(value)).length > WORKSPACE_POLICY.maxBytes)
    return fail('workspace-size', 'Workspace exceeds the 64 MiB limit');
  const r = new Reader();
  const workspace = strictObject(
    value,
    '',
    ['schemaVersion', 'activeDraftId', 'drafts', 'runs'],
    r,
  );
  if (!workspace) return { success: false, diagnostics: r.diagnostics };
  r.choice(workspace.schemaVersion, '/schemaVersion', [1]);
  r.text(workspace.activeDraftId, '/activeDraftId', true);
  const ids = new Set<string>();
  if (Array.isArray(workspace.drafts) && workspace.drafts.length > WORKSPACE_POLICY.maxDrafts)
    r.issue('/drafts', 'workspace-capacity', 'Too many drafts');
  r.array(
    workspace.drafts,
    '/drafts',
    (value, path) => {
      const draft = strictObject(
        value,
        path,
        ['id', 'configuration', 'raw', 'version', 'updatedAt'],
        r,
      );
      if (!draft) return;
      r.text(draft.id, `${path}/id`, true);
      if (ids.has(String(draft.id)))
        r.issue(`${path}/id`, 'duplicate-id', 'Duplicate workspace draft ID');
      ids.add(String(draft.id));
      r.number(draft.version, `${path}/version`, 1);
      r.number(draft.updatedAt, `${path}/updatedAt`);
      const configuration = parseExperimentDraft(draft.configuration);
      prefix(r, `${path}/configuration`, configuration);
      const raw = r.object(draft.raw, `${path}/raw`);
      if (raw && configuration.success)
        for (const [key, text] of Object.entries(raw)) {
          if (typeof text !== 'string' || !rawAllowed(configuration.value, key)) {
            r.issue(
              `${path}/raw/${key}`,
              'draft-raw-path',
              'Unfinished text must point to a known JSON editor',
            );
            continue;
          }
          try {
            const parsed = parseJsonData(JSON.parse(text));
            if (
              parsed.success &&
              JSON.stringify(parsed.value) !== JSON.stringify(valueAt(configuration.value, key))
            )
              r.issue(
                `${path}/raw/${key}`,
                'draft-raw-mismatch',
                'Valid editor text differs from its draft value',
              );
          } catch {
            /* Invalid text is intentionally retained. */
          }
        }
    },
    1,
  );
  if (!ids.has(String(workspace.activeDraftId)))
    r.issue('/activeDraftId', 'active-draft', 'Active draft is missing');
  const runs = new Set<string>();
  if (Array.isArray(workspace.runs) && workspace.runs.length > WORKSPACE_POLICY.maxRuns)
    r.issue('/runs', 'workspace-capacity', 'Too many run records');
  r.array(workspace.runs, '/runs', (value, path) => {
    const run = strictObject(
      value,
      path,
      ['id', 'experimentId', 'createdAt', 'draftVersion', 'view'],
      r,
    );
    if (!run) return;
    r.text(run.id, `${path}/id`, true);
    r.text(run.experimentId, `${path}/experimentId`, true);
    r.number(run.createdAt, `${path}/createdAt`);
    r.number(run.draftVersion, `${path}/draftVersion`, 1);
    if (runs.has(String(run.id))) r.issue(`${path}/id`, 'duplicate-run', 'Duplicate record ID');
    runs.add(String(run.id));
    inspectView(run.view, `${path}/view`, r);
  });
  return r.result(value as WorkspaceData);
}

/** Stage a self-contained file, rejecting versions and capacity before applying any data. */
export function parseWorkspaceBundle(text: string): ValidationResult<WorkspaceBundle> {
  if (
    text.length > WORKSPACE_POLICY.maxBytes ||
    new TextEncoder().encode(text).length > WORKSPACE_POLICY.maxBytes
  )
    return fail('bundle-size', 'Bundle exceeds the 64 MiB limit');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail('bundle-json', 'Bundle is not valid JSON');
  }
  const r = new Reader();
  const node = strictObject(value, '', ['schemaVersion', 'kind', 'data'], r);
  if (!node) return { success: false, diagnostics: r.diagnostics };
  r.choice(node.schemaVersion, '/schemaVersion', [1]);
  r.choice(node.kind, '/kind', ['protocol-studio-bundle']);
  const parsed = parseWorkspaceData(node.data);
  prefix(r, '/data', parsed);
  return r.result(value as WorkspaceBundle);
}

/** Validate persisted envelopes separately from bundle identity and executable definition checks. */
export function parseWorkspaceEnvelope(value: unknown): ValidationResult<WorkspaceEnvelope> {
  const r = new Reader();
  const node = strictObject(value, '', ['schemaVersion', 'revision', 'data'], r);
  if (!node) return { success: false, diagnostics: r.diagnostics };
  r.choice(node.schemaVersion, '/schemaVersion', [1]);
  r.number(node.revision, '/revision', 1);
  const parsed = parseWorkspaceData(node.data);
  prefix(r, '/data', parsed);
  return r.result(value as WorkspaceEnvelope);
}
