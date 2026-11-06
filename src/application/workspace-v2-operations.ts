import { freezeOwned, isOwnedImmutable } from '../domain/immutable-data.ts';
import type { ValidationResult } from '../domain/protocol-model.ts';
import type { StackExperiment } from '../domain/stack-model.ts';
import type { StackView } from '../domain/stack-runtime-model.ts';
import { canonicalStackJson } from '../domain/stack-series-model.ts';
import { WORKSPACE_POLICY } from '../domain/workspace-model.ts';
import type { SavedStackRun, StackDraft, WorkspaceV2 } from '../domain/workspace-v2-model.ts';
import {
  parseWorkspaceV2,
  parseWorkspaceV2Bundle,
  upgradeWorkspaceData,
} from '../domain/workspace-v2-validation.ts';
import { parseWorkspaceEnvelope } from '../domain/workspace-validation.ts';
import { exportWorkspace, mergeWorkspaces, workspaceId } from './workspace-operations.ts';

/** Capture an independent editable draft; raw invalid text never alters a live snapshot. */
export function createStackDraft(configuration: StackExperiment): StackDraft {
  return {
    mode: 'stack',
    id: workspaceId('stack_draft'),
    configuration: structuredClone(configuration),
    raw: {},
    version: 1,
    updatedAt: Date.now(),
  };
}
/** Capture view and artifacts together, retaining committed data after cancellation/reset. */
export function captureStackRun(
  view: StackView,
  experimentId: string,
  draftVersion: number,
  id = workspaceId('stack_run'),
): SavedStackRun {
  return freezeOwned({
    mode: 'stack',
    id,
    experimentId,
    createdAt: Date.now(),
    draftVersion,
    view: isOwnedImmutable(view) ? view : structuredClone(view),
  });
}
/** Remap workspace/group identities only; endpoint, trace, payload and definition references stay record-local. */
export function mergeWorkspacesV2(
  current: WorkspaceV2,
  incoming: WorkspaceV2,
  reuseIdentical = false,
): WorkspaceV2 {
  const mapping = new Map<string, string>();
  const parentIds = new Set([
    ...current.stack.drafts.map((d) => d.id),
    ...current.stack.runs.map((r) => r.experimentId),
  ]);
  for (const id of new Set([
    ...incoming.stack.drafts.map((d) => d.id),
    ...incoming.stack.runs.map((r) => r.experimentId),
  ])) {
    const old = current.stack.drafts.find((d) => d.id === id);
    const next = incoming.stack.drafts.find((d) => d.id === id);
    const identicalOrphans =
      reuseIdentical &&
      !old &&
      !next &&
      incoming.stack.runs
        .filter((r) => r.experimentId === id)
        .every((r) =>
          current.stack.runs.some(
            (saved) => saved.id === r.id && canonicalStackJson(saved) === canonicalStackJson(r),
          ),
        );
    mapping.set(
      id,
      parentIds.has(id) &&
        !(
          identicalOrphans ||
          (reuseIdentical && old && next && canonicalStackJson(old) === canonicalStackJson(next))
        )
        ? workspaceId('stack_draft')
        : id,
    );
  }
  const suites = new Map<string, string>();
  const suiteIds = new Set([
    ...current.stack.drafts.flatMap((d) => (d.suite ? [d.suite.id] : [])),
    ...current.stack.runs.flatMap((r) => (r.series?.suite ? [r.series.suite.id] : [])),
  ]);
  for (const id of new Set([
    ...incoming.stack.drafts.flatMap((d) => (d.suite ? [d.suite.id] : [])),
    ...incoming.stack.runs.flatMap((r) => (r.series?.suite ? [r.series.suite.id] : [])),
  ])) {
    const owners = [
      ...incoming.stack.drafts.filter((d) => d.suite?.id === id).map((d) => d.id),
      ...incoming.stack.runs.filter((r) => r.series?.suite?.id === id).map((r) => r.experimentId),
    ];
    const reuse = reuseIdentical && owners.every((owner) => mapping.get(owner) === owner);
    suites.set(id, suiteIds.has(id) && !reuse ? workspaceId('stack_suite') : id);
  }
  const drafts = [...current.stack.drafts];
  for (const draft of incoming.stack.drafts) {
    const id = mapping.get(draft.id) ?? draft.id;
    if (!drafts.some((d) => d.id === id))
      drafts.push({
        ...structuredClone(draft),
        id,
        ...(draft.suite
          ? {
              suite: {
                ...structuredClone(draft.suite),
                id: suites.get(draft.suite.id) ?? draft.suite.id,
              },
            }
          : {}),
      });
  }
  const groups = new Map<string, string>();
  const usedGroups = new Set(current.stack.runs.flatMap((r) => (r.series ? [r.series.id] : [])));
  for (const run of incoming.stack.runs)
    if (run.series && !groups.has(run.series.id)) {
      const id = run.series.id;
      const reuse =
        reuseIdentical &&
        incoming.stack.runs
          .filter((r) => r.series?.id === id)
          .every(
            (r) =>
              mapping.get(r.experimentId) === r.experimentId &&
              current.stack.runs.some(
                (old) => old.id === r.id && canonicalStackJson(old) === canonicalStackJson(r),
              ),
          );
      groups.set(id, usedGroups.has(id) && !reuse ? workspaceId('stack_series') : id);
    }
  const runs = [...current.stack.runs];
  for (const run of incoming.stack.runs) {
    if (
      reuseIdentical &&
      mapping.get(run.experimentId) === run.experimentId &&
      (!run.series || groups.get(run.series.id) === run.series.id) &&
      runs.some((r) => r.id === run.id && canonicalStackJson(r) === canonicalStackJson(run))
    )
      continue;
    runs.push({
      ...structuredClone(run),
      id: runs.some((r) => r.id === run.id) ? workspaceId('stack_run') : run.id,
      experimentId: mapping.get(run.experimentId) ?? run.experimentId,
      ...(run.series
        ? {
            series: {
              ...structuredClone(run.series),
              id: groups.get(run.series.id) ?? run.series.id,
              ...(run.series.suite
                ? {
                    suite: {
                      ...run.series.suite,
                      id: suites.get(run.series.suite.id) ?? run.series.suite.id,
                    },
                  }
                : {}),
            },
          }
        : {}),
    });
  }
  const data: WorkspaceV2 = {
    schemaVersion: 2,
    mode: 'workspace',
    legacy: mergeWorkspaces(current.legacy, incoming.legacy, reuseIdentical),
    stack: {
      drafts,
      runs,
      activeDraftId: incoming.stack.activeDraftId
        ? (mapping.get(incoming.stack.activeDraftId) ?? incoming.stack.activeDraftId)
        : current.stack.activeDraftId,
    },
  };
  const parsed = parseWorkspaceV2(data);
  if (!parsed.success)
    throw new Error(parsed.diagnostics[0]?.message ?? 'Workspace capacity/validation failed');
  return data;
}
/** Stage all modes and merge only after complete bundle validation. */
export function stageWorkspaceV2Bundle(
  text: string,
  current: WorkspaceV2,
): ValidationResult<WorkspaceV2> {
  const parsed = parseWorkspaceV2Bundle(text);
  if (!parsed.success) return parsed;
  try {
    return { success: true, value: mergeWorkspacesV2(current, parsed.value.data) };
  } catch (error) {
    return {
      success: false,
      diagnostics: [{ path: '/', code: 'workspace-merge', message: String(error) }],
    };
  }
}
/** Export both modes in one self-contained bundle, including frozen actual bytes. */
export function exportWorkspaceV2(data: WorkspaceV2): ValidationResult<string> {
  const valid = parseWorkspaceV2(data);
  if (!valid.success) return valid;
  const text = JSON.stringify({ schemaVersion: 2, kind: 'protocol-studio-bundle', data });
  return new TextEncoder().encode(text).length <= WORKSPACE_POLICY.maxBytes
    ? { success: true, value: text }
    : {
        success: false,
        diagnostics: [{ path: '/', code: 'bundle-size', message: 'Bundle exceeds 64 MiB' }],
      };
}
/** A v1 export must explicitly select legacy data when any stack record/draft would be omitted. */
export function exportLegacyFromV2(
  data: WorkspaceV2,
  explicitlySelectLegacy = false,
): ValidationResult<string> {
  if (!explicitlySelectLegacy && (data.stack.drafts.length || data.stack.runs.length))
    return {
      success: false,
      diagnostics: [
        {
          path: '/stack',
          code: 'legacy-export-selection',
          message:
            '스택 자료가 포함되어 있습니다. 전체 v2 내보내기 또는 명시적 v1 자료 선택이 필요합니다.',
        },
      ],
    };
  return exportWorkspace(data.legacy);
}
/** Recover the preserved v1 envelope as an original v1 bundle without downgrading or writing the DB. */
export function exportLegacyBackup(value: unknown): ValidationResult<string> {
  const parsed = parseWorkspaceEnvelope(value);
  return parsed.success ? exportWorkspace(parsed.value.data) : parsed;
}
/** Build a mixed workspace around existing v1 data without changing its semantics. */
export function createWorkspaceV2(
  legacy: WorkspaceV2['legacy'],
  configuration?: StackExperiment,
): WorkspaceV2 {
  const data = upgradeWorkspaceData(structuredClone(legacy));
  if (!configuration) return data;
  const draft = createStackDraft(configuration);
  return { ...data, stack: { activeDraftId: draft.id, drafts: [draft], runs: [] } };
}
