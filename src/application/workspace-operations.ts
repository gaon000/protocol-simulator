import type {
  ExperimentDefinition,
  EngineView,
  ValidationResult,
} from '../domain/protocol-model.ts';
import { parseWorkspaceBundle, parseWorkspaceData } from '../domain/workspace-validation.ts';
import {
  WORKSPACE_POLICY,
  type DraftRecord,
  type SavedRun,
  type WorkspaceData,
} from '../domain/workspace-model.ts';
import { isOwnedImmutable } from '../domain/immutable-data.ts';

/** Allocate a workspace identity independently of declaration IDs inside experiments. */
export function workspaceId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
/** Create a detached, editable draft record with stable workspace identity. */
export function createDraftRecord(configuration: ExperimentDefinition): DraftRecord {
  return {
    id: workspaceId('experiment'),
    configuration: structuredClone(configuration),
    raw: {},
    version: 1,
    updatedAt: Date.now(),
  };
}
/** Initialize a bounded workspace without pretending it has already been persisted. */
export function createWorkspace(configuration: ExperimentDefinition): WorkspaceData {
  const draft = createDraftRecord(configuration);
  return { schemaVersion: 1, activeDraftId: draft.id, drafts: [draft], runs: [] };
}
/** Share native immutable views, copying unowned inputs so records never share mutable objects. */
export function captureRun(
  view: EngineView,
  experimentId: string,
  draftVersion: number,
  id = workspaceId('saved_run'),
): SavedRun {
  return {
    id,
    experimentId,
    createdAt: Date.now(),
    draftVersion,
    view: isOwnedImmutable(view) ? view : structuredClone(view),
  };
}
/** Merge staged records into new identities on collision, preserving every historical snapshot. */
export function mergeWorkspaces(
  current: WorkspaceData,
  incoming: WorkspaceData,
  reuseIdentical = false,
): WorkspaceData {
  const parents = new Set([
    ...current.drafts.map((item) => item.id),
    ...current.runs.map((item) => item.experimentId),
  ]);
  const mapping = new Map<string, string>();
  for (const id of new Set([
    ...incoming.drafts.map((item) => item.id),
    ...incoming.runs.map((item) => item.experimentId),
  ])) {
    const old = current.drafts.find((item) => item.id === id);
    const next = incoming.drafts.find((item) => item.id === id);
    const reuse = reuseIdentical && old && next && JSON.stringify(old) === JSON.stringify(next);
    mapping.set(id, parents.has(id) && !reuse ? workspaceId('experiment') : id);
  }
  const drafts = [...current.drafts];
  for (const item of incoming.drafts) {
    const id = mapping.get(item.id) ?? item.id;
    if (!drafts.some((draft) => draft.id === id)) drafts.push({ ...item, id });
  }
  const runs = [...current.runs];
  for (const item of incoming.runs) {
    if (
      reuseIdentical &&
      runs.some((run) => run.id === item.id && JSON.stringify(run) === JSON.stringify(item))
    )
      continue;
    runs.push({
      ...item,
      id: runs.some((run) => run.id === item.id) ? workspaceId('saved_run') : item.id,
      experimentId: mapping.get(item.experimentId) ?? item.experimentId,
    });
  }
  if (drafts.length > WORKSPACE_POLICY.maxDrafts || runs.length > WORKSPACE_POLICY.maxRuns)
    throw new Error(
      '합친 결과가 초안/기록 100개 한도를 넘습니다. 먼저 내보내거나 불필요한 항목을 삭제하세요.',
    );
  return {
    schemaVersion: 1,
    activeDraftId: mapping.get(incoming.activeDraftId) ?? incoming.activeDraftId,
    drafts,
    runs,
  };
}
/** Stage and fully validate a bundle before any workspace mutation is possible. */
export function stageBundle(text: string, current: WorkspaceData): ValidationResult<WorkspaceData> {
  const parsed = parseWorkspaceBundle(text);
  if (!parsed.success) return parsed;
  try {
    const merged = mergeWorkspaces(current, parsed.value.data);
    return parseWorkspaceData(merged);
  } catch (error) {
    return {
      success: false,
      diagnostics: [
        {
          path: '/',
          code: 'workspace-capacity',
          message: error instanceof Error ? error.message : 'Unable to merge workspace',
        },
      ],
    };
  }
}
/** Serialize a self-contained export, including unfinished drafts, provenance and frozen run records. */
export function exportWorkspace(data: WorkspaceData): ValidationResult<string> {
  const valid = parseWorkspaceData(data);
  if (!valid.success) return valid;
  const text = JSON.stringify({ schemaVersion: 1, kind: 'protocol-studio-bundle', data });
  if (new TextEncoder().encode(text).length > WORKSPACE_POLICY.maxBytes)
    return {
      success: false,
      diagnostics: [
        { path: '/', code: 'bundle-size', message: '내보낼 bundle이 64 MiB 한도를 넘습니다.' },
      ],
    };
  return { success: true, value: text };
}
/** Prevent deletion of a current participant definition while leaving historical snapshots independent. */
export function definitionDeletionReason(
  configuration: ExperimentDefinition,
  index: number,
): string | undefined {
  const definition = configuration.definitions[index];
  if (!definition) return '정의를 찾을 수 없습니다.';
  if (configuration.definitions.length <= 1)
    return '초안에는 편집할 프로토콜 정의가 하나 이상 필요합니다.';
  if (
    Object.values(configuration.protocols).some(
      (item) => item.id === definition.id && item.revision === definition.revision,
    )
  )
    return '참여자가 참조 중인 정의입니다. 참여자의 프로토콜을 먼저 변경하세요.';
  return undefined;
}
