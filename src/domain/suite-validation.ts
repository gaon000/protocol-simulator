import { valueAt } from './json-pointer.ts';
import { parseExperimentDraft, parseJsonData, type Reader } from './model-validation.ts';
import type { ExperimentDefinition } from './protocol-model.ts';
import { type SavedRun, type ScenarioCase, WORKSPACE_POLICY } from './workspace-model.ts';

/** Combine shared protocol definitions with a case's independent scenario and environment. */
export function caseConfiguration(
  source: ExperimentDefinition,
  item: ScenarioCase,
): ExperimentDefinition {
  return { ...source, scenario: item.scenario, environment: item.environment, seed: item.seed };
}
function object(value: unknown, path: string, keys: readonly string[], r: Reader) {
  return r.object(value, path, keys, keys);
}
function label(value: unknown, path: string, r: Reader) {
  if (typeof value !== 'string' || value.length > 80)
    r.issue(path, 'suite-label', 'Expected at most 80 characters');
}

/** Validate renderable suite drafts, retaining semantic errors and unfinished case JSON. */
export function inspectScenarioSuite(
  value: unknown,
  source: ExperimentDefinition,
  path: string,
  r: Reader,
) {
  const suite = object(value, path, ['id', 'label', 'revision', 'cases'], r);
  if (!suite) return;
  r.text(suite.id, `${path}/id`, true);
  label(suite.label, `${path}/label`, r);
  r.number(suite.revision, `${path}/revision`, 1);
  const ids = new Set<string>();
  if (Array.isArray(suite.cases) && suite.cases.length > WORKSPACE_POLICY.maxCases)
    r.issue(path, 'suite-capacity', 'Too many cases');
  r.array(suite.cases, `${path}/cases`, (value, location) => {
    const item = object(
      value,
      location,
      ['id', 'label', 'enabled', 'scenario', 'environment', 'seed', 'raw'],
      r,
    );
    if (!item) return;
    r.text(item.id, `${location}/id`, true);
    label(item.label, `${location}/label`, r);
    r.choice(item.enabled, `${location}/enabled`, [true, false]);
    if (ids.has(String(item.id))) r.issue(location, 'duplicate-case', 'Duplicate case ID');
    ids.add(String(item.id));
    const configuration = parseExperimentDraft({
      ...source,
      scenario: item.scenario,
      environment: item.environment,
      seed: item.seed,
    });
    if (!configuration.success)
      r.diagnostics.push(
        ...configuration.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          path: `${location}${diagnostic.path}`,
        })),
      );
    const raw = r.object(item.raw, `${location}/raw`);
    if (raw && configuration.success)
      for (const [pointer, text] of Object.entries(raw)) {
        if (
          typeof text !== 'string' ||
          !/^\/scenario\/(?:inputs|expectations)\/\d+\/message\/values\/[^/]+$/.test(pointer) ||
          /~(?![01])/.test(pointer) ||
          valueAt(configuration.value, pointer) === undefined
        ) {
          r.issue(
            location,
            'case-raw-path',
            'Case raw text must point to an existing message value',
          );
          continue;
        }
        try {
          const parsed = parseJsonData(JSON.parse(text));
          if (
            parsed.success &&
            JSON.stringify(parsed.value) !== JSON.stringify(valueAt(configuration.value, pointer))
          )
            r.issue(location, 'case-raw-mismatch', 'Valid raw text differs from stored value');
        } catch {
          /* Preserve unfinished text. */
        }
      }
  });
}

/** Validate a compact frozen case manifest; actual executable settings live in each snapshot. */
export function inspectRegressionInfo(value: unknown, path: string, r: Reader) {
  const info = object(
    value,
    path,
    ['id', 'label', 'suiteId', 'suiteRevision', 'cases', 'caseIndex'],
    r,
  );
  if (!info) return;
  r.text(info.id, `${path}/id`, true);
  r.text(info.suiteId, `${path}/suiteId`, true);
  r.text(info.label, `${path}/label`);
  label(info.label, `${path}/label`, r);
  r.number(info.suiteRevision, `${path}/suiteRevision`, 1);
  if (Array.isArray(info.cases) && info.cases.length > WORKSPACE_POLICY.maxCases)
    r.issue(path, 'suite-capacity', 'Too many case manifest entries');
  const ids = new Set<string>();
  r.array(
    info.cases,
    `${path}/cases`,
    (value, location) => {
      const item = object(value, location, ['id', 'label'], r);
      if (!item) return;
      r.text(item.id, `${location}/id`, true);
      r.text(item.label, `${location}/label`);
      label(item.label, `${location}/label`, r);
      if (ids.has(String(item.id)))
        r.issue(location, 'duplicate-case', 'Duplicate manifest case ID');
      ids.add(String(item.id));
    },
    1,
  );
  r.number(info.caseIndex, `${path}/caseIndex`, 0, ids.size - 1);
}

/** Reject mixed-source groups or duplicate case slots instead of silently combining results. */
export function inspectRegressionGroups(value: unknown, r: Reader) {
  if (!Array.isArray(value) || r.diagnostics.length) return;
  const groups = new Map<string, { header: string; slots: Set<number> }>();
  for (const record of value as SavedRun[]) {
    const info = record.regression;
    if (!info) continue;
    const {
      scenario: _scenario,
      environment: _environment,
      seed: _seed,
      ...source
    } = record.view.snapshot.configuration;
    const header = JSON.stringify({
      experimentId: record.experimentId,
      version: record.draftVersion,
      info: { ...info, caseIndex: 0 },
      source,
      engine: record.view.snapshot.engineVersion,
      random: record.view.snapshot.randomAlgorithm,
      limits: record.view.snapshot.limits,
    });
    const group = groups.get(info.id) ?? { header, slots: new Set<number>() };
    if (group.header !== header || group.slots.has(info.caseIndex))
      r.issue(
        '/runs',
        'regression-consistency',
        'Case records must share source and have unique slots',
      );
    group.slots.add(info.caseIndex);
    groups.set(info.id, group);
  }
}
