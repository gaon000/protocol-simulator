import { valueAt } from './json-pointer.ts';
import { parseJsonData, Reader } from './model-validation.ts';
import type { ValidationResult } from './protocol-model.ts';
import type { StackExperiment } from './stack-model.ts';
import { parseStackView } from './stack-record.ts';
import { canonicalStackJson, stackCaseCondition, stackCommonSource } from './stack-series-model.ts';
import { parseStackExperimentDraft } from './stack-validation.ts';
import { WORKSPACE_POLICY } from './workspace-model.ts';
import type {
  SavedStackRun,
  StackSuite,
  WorkspaceV2,
  WorkspaceV2Bundle,
  WorkspaceV2Envelope,
} from './workspace-v2-model.ts';
import { parseWorkspaceData, parseWorkspaceEnvelope } from './workspace-validation.ts';

function append(r: Reader, path: string, parsed: ValidationResult<unknown>) {
  if (!parsed.success)
    for (const d of parsed.diagnostics) r.issue(`${path}${d.path}`, d.code, d.message);
}
function failure<T>(code: string, message: string): ValidationResult<T> {
  return { success: false, diagnostics: [{ path: '/', code, message }] };
}
/** Wrap legacy data without rewriting a single legacy draft, snapshot, byte or event. */
export function upgradeWorkspaceData(legacy: WorkspaceV2['legacy']): WorkspaceV2 {
  return {
    schemaVersion: 2,
    mode: 'workspace',
    legacy,
    stack: { activeDraftId: null, drafts: [], runs: [] },
  };
}
/** Validate a suite's saved shape; disabled or semantically unfinished cases remain nonexecutable. */
export function parseStackSuite(
  value: unknown,
  source: StackExperiment,
): ValidationResult<StackSuite> {
  const json = parseJsonData(value);
  if (!json.success) return json;
  const r = new Reader();
  const node = r.object(value, '', ['id', 'label', 'revision', 'cases']);
  if (!node) return { success: false, diagnostics: r.diagnostics };
  r.text(node.id, '/id', true);
  r.text(node.label, '/label');
  r.number(node.revision, '/revision', 1);
  const ids = new Set<string>();
  if (Array.isArray(node.cases) && node.cases.length > WORKSPACE_POLICY.maxCases)
    r.issue('/cases', 'suite-capacity', 'At most 20 cases');
  r.array(node.cases, '/cases', (value, path) => {
    const item = r.object(value, path, [
      'id',
      'label',
      'enabled',
      'seed',
      'scenario',
      'environment',
    ]);
    if (!item) return;
    r.text(item.id, `${path}/id`, true);
    r.text(item.label, `${path}/label`);
    r.choice(item.enabled, `${path}/enabled`, [true, false]);
    if (ids.has(String(item.id))) r.issue(path, 'duplicate-case', 'Repeated case');
    ids.add(String(item.id));
    append(
      r,
      path,
      parseStackExperimentDraft({
        ...source,
        seed: item.seed,
        scenario: item.scenario,
        link: { ...source.link, environment: item.environment },
      }),
    );
  });
  return r.result(value as StackSuite);
}
/** Check a run record before projection, import or persistence, including series provenance. */
export function parseSavedStackRun(value: unknown): ValidationResult<SavedStackRun> {
  const r = new Reader();
  const json = parseJsonData(value, { maxDepth: 128, maxNodes: WORKSPACE_POLICY.maxJsonNodes });
  if (!json.success) return json;
  const node = r.object(
    value,
    '',
    ['mode', 'id', 'experimentId', 'createdAt', 'draftVersion', 'view', 'series'],
    ['mode', 'id', 'experimentId', 'createdAt', 'draftVersion', 'view'],
  );
  if (!node) return { success: false, diagnostics: r.diagnostics };
  r.choice(node.mode, '/mode', ['stack']);
  r.text(node.id, '/id', true);
  r.text(node.experimentId, '/experimentId', true);
  r.number(node.createdAt, '/createdAt');
  r.number(node.draftVersion, '/draftVersion', 1);
  const view = parseStackView(node.view);
  append(r, '/view', view);
  if (node.series !== undefined && view.success) {
    const series = r.object(node.series, '/series', [
      'id',
      'label',
      'kind',
      'suite',
      'manifest',
      'index',
      'source',
      'condition',
    ]);
    if (series) {
      r.text(series.id, '/series/id', true);
      r.text(series.label, '/series/label');
      r.choice(series.kind, '/series/kind', ['batch', 'regression']);
      if (series.kind === 'regression') {
        const suite = r.object(series.suite, '/series/suite', ['id', 'revision']);
        if (suite) {
          r.text(suite.id, '/series/suite/id', true);
          r.number(suite.revision, '/series/suite/revision', 1);
        }
      } else if (series.suite !== undefined)
        r.issue('/series/suite', 'series-suite', 'A batch cannot invent a regression suite');
      const ids = new Set<string>();
      r.array(
        series.manifest,
        '/series/manifest',
        (value, path) => {
          const item = r.object(value, path, ['id', 'label']);
          if (!item) return;
          r.text(item.id, `${path}/id`, true);
          r.text(item.label, `${path}/label`);
          if (ids.has(String(item.id)))
            r.issue(path, 'series-manifest', 'Duplicate manifest member');
          ids.add(String(item.id));
        },
        1,
      );
      if (ids.size > (series.kind === 'regression' ? 20 : 100))
        r.issue('/series/manifest', 'series-capacity', 'Too many cases');
      r.number(series.index, '/series/index', 0, ids.size - 1);
      if (
        canonicalStackJson(series.source) !==
          canonicalStackJson(stackCommonSource(view.value.snapshot.configuration)) ||
        canonicalStackJson(series.condition) !==
          canonicalStackJson(stackCaseCondition(view.value.snapshot.configuration))
      )
        r.issue(
          '/series',
          'series-source',
          'Frozen source or case condition differs from the actual snapshot',
        );
    }
  }
  return r.result(value as SavedStackRun);
}
/** Validate both modes under one workspace capacity without converting legacy events to stack events. */
export function parseWorkspaceV2(value: unknown): ValidationResult<WorkspaceV2> {
  const json = parseJsonData(value, {
    maxDepth: WORKSPACE_POLICY.maxJsonDepth,
    maxNodes: WORKSPACE_POLICY.maxJsonNodes,
  });
  if (!json.success) return json;
  if (new TextEncoder().encode(JSON.stringify(value)).length > WORKSPACE_POLICY.maxBytes)
    return failure('workspace-size', 'Workspace exceeds 64 MiB');
  const r = new Reader();
  const node = r.object(value, '', ['schemaVersion', 'mode', 'legacy', 'stack']);
  if (!node) return { success: false, diagnostics: r.diagnostics };
  r.choice(node.schemaVersion, '/schemaVersion', [2]);
  r.choice(node.mode, '/mode', ['workspace']);
  const legacy = parseWorkspaceData(node.legacy);
  append(r, '/legacy', legacy);
  const stack = r.object(node.stack, '/stack', ['activeDraftId', 'drafts', 'runs']);
  if (!stack) return { success: false, diagnostics: r.diagnostics };
  const draftIds = new Set<string>();
  const runIds = new Set<string>();
  r.array(stack.drafts, '/stack/drafts', (value, path) => {
    const draft = r.object(
      value,
      path,
      ['mode', 'id', 'configuration', 'raw', 'version', 'updatedAt', 'suite'],
      ['mode', 'id', 'configuration', 'raw', 'version', 'updatedAt'],
    );
    if (!draft) return;
    r.choice(draft.mode, `${path}/mode`, ['stack']);
    r.text(draft.id, `${path}/id`, true);
    r.number(draft.version, `${path}/version`, 1);
    r.number(draft.updatedAt, `${path}/updatedAt`);
    if (draftIds.has(String(draft.id))) r.issue(path, 'duplicate-draft', 'Repeated stack draft');
    draftIds.add(String(draft.id));
    const config = parseStackExperimentDraft(draft.configuration);
    append(r, `${path}/configuration`, config);
    const raw = r.object(draft.raw, `${path}/raw`);
    if (raw && config.success)
      for (const [key, text] of Object.entries(raw)) {
        if (
          typeof text !== 'string' ||
          text.length > 1_048_576 ||
          !key.startsWith('/') ||
          /~(?![01])/.test(key) ||
          valueAt(config.value, key) === undefined
        ) {
          r.issue(
            `${path}/raw`,
            'draft-raw-path',
            'Raw editor must point to an existing JSON value',
          );
          continue;
        }
        try {
          const parsed = JSON.parse(text);
          if (canonicalStackJson(parsed) !== canonicalStackJson(valueAt(config.value, key)))
            r.issue(
              `${path}/raw`,
              'draft-raw-mismatch',
              'Valid raw text differs from configuration',
            );
        } catch {
          /* Preserve unfinished JSON text; execution will remain blocked. */
        }
      }
    if (draft.suite !== undefined && config.success)
      append(r, `${path}/suite`, parseStackSuite(draft.suite, config.value));
  });
  r.array(stack.runs, '/stack/runs', (value, path) => {
    const parsed = parseSavedStackRun(value);
    append(r, path, parsed);
    if (!parsed.success) return;
    if (runIds.has(parsed.value.id)) r.issue(path, 'duplicate-run', 'Repeated stack run');
    runIds.add(parsed.value.id);
  });
  if (stack.activeDraftId !== null && !draftIds.has(String(stack.activeDraftId)))
    r.issue('/stack/activeDraftId', 'active-draft', 'Missing active stack draft');
  if (
    legacy.success &&
    (legacy.value.drafts.length + draftIds.size > WORKSPACE_POLICY.maxDrafts ||
      legacy.value.runs.length + runIds.size > WORKSPACE_POLICY.maxRuns)
  )
    r.issue('/', 'workspace-capacity', 'Combined modes exceed the shared 100 draft/run capacity');
  if (!r.diagnostics.length) {
    const runs = (value as WorkspaceV2).stack.runs;
    const groups = new Map<
      string,
      {
        source: string;
        manifest: string;
        indexes: Set<number>;
        kind: string;
        owner: string;
        suite: string;
        contract: string;
      }
    >();
    for (const run of runs)
      if (run.series) {
        const s = run.series;
        const group = groups.get(s.id);
        if (
          group &&
          (group.source !== canonicalStackJson(s.source) ||
            group.manifest !== canonicalStackJson(s.manifest) ||
            group.indexes.has(s.index) ||
            group.kind !== s.kind ||
            group.owner !== run.experimentId ||
            group.suite !== canonicalStackJson(s.suite ?? null) ||
            group.contract !==
              `${run.view.snapshot.engineVersion}/${run.view.snapshot.randomAlgorithm}`)
        )
          r.issue(
            '/stack/runs',
            'series-group',
            'Series contains conflicting source, ownership, manifest or repeated case',
          );
        if (group) group.indexes.add(s.index);
        else
          groups.set(s.id, {
            source: canonicalStackJson(s.source),
            manifest: canonicalStackJson(s.manifest),
            indexes: new Set([s.index]),
            kind: s.kind,
            owner: run.experimentId,
            suite: canonicalStackJson(s.suite ?? null),
            contract: `${run.view.snapshot.engineVersion}/${run.view.snapshot.randomAlgorithm}`,
          });
      }
  }
  return r.result(value as WorkspaceV2);
}
/** Accept the native v2 envelope or explicitly upgrade a validated legacy envelope in memory. */
export function parseWorkspaceV2Envelope(value: unknown): ValidationResult<WorkspaceV2Envelope> {
  const json = parseJsonData(value, { maxDepth: 132, maxNodes: WORKSPACE_POLICY.maxJsonNodes });
  if (!json.success) return json;
  if ((value as { schemaVersion?: unknown })?.schemaVersion === 1) {
    const old = parseWorkspaceEnvelope(value);
    return old.success
      ? {
          success: true,
          value: {
            schemaVersion: 2,
            revision: old.value.revision,
            data: upgradeWorkspaceData(old.value.data),
          },
        }
      : old;
  }
  const r = new Reader();
  const node = r.object(value, '', ['schemaVersion', 'revision', 'data']);
  if (!node) return { success: false, diagnostics: r.diagnostics };
  r.choice(node.schemaVersion, '/schemaVersion', [2]);
  r.number(node.revision, '/revision', 1);
  append(r, '/data', parseWorkspaceV2(node.data));
  return r.result(value as WorkspaceV2Envelope);
}
/** Stage a self-contained v1/v2 bundle; unknown versions and dangling payloads never mutate storage. */
export function parseWorkspaceV2Bundle(text: string): ValidationResult<WorkspaceV2Bundle> {
  if (
    text.length > WORKSPACE_POLICY.maxBytes ||
    new TextEncoder().encode(text).length > WORKSPACE_POLICY.maxBytes
  )
    return failure('bundle-size', 'Bundle exceeds 64 MiB');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return failure('bundle-json', 'Invalid bundle JSON');
  }
  const json = parseJsonData(value, { maxDepth: 132, maxNodes: WORKSPACE_POLICY.maxJsonNodes });
  if (!json.success) return json;
  const r = new Reader();
  const node = r.object(value, '', ['schemaVersion', 'kind', 'data']);
  if (!node) return { success: false, diagnostics: r.diagnostics };
  r.choice(node.schemaVersion, '/schemaVersion', [1, 2]);
  r.choice(node.kind, '/kind', ['protocol-studio-bundle']);
  let data: WorkspaceV2 | undefined;
  if (node.schemaVersion === 1) {
    const old = parseWorkspaceData(node.data);
    append(r, '/data', old);
    if (old.success) data = upgradeWorkspaceData(old.value);
  } else {
    const next = parseWorkspaceV2(node.data);
    append(r, '/data', next);
    if (next.success) data = next.value;
  }
  return data && !r.diagnostics.length
    ? { success: true, value: { schemaVersion: 2, kind: 'protocol-studio-bundle', data } }
    : { success: false, diagnostics: r.diagnostics };
}
