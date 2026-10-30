import type { EngineView, ExperimentDefinition } from './protocol-model.ts';

export const WORKSPACE_POLICY = {
  schemaVersion: 1,
  maxBytes: 67_108_864,
  maxDrafts: 100,
  maxRuns: 100,
  maxJsonNodes: 33_554_432,
  maxJsonDepth: 128,
} as const;
export type DraftRecord = {
  readonly id: string;
  readonly configuration: ExperimentDefinition;
  readonly raw: Readonly<Record<string, string>>;
  readonly version: number;
  readonly updatedAt: number;
};
export type SavedRun = {
  readonly id: string;
  readonly experimentId: string;
  readonly createdAt: number;
  readonly draftVersion: number;
  readonly view: EngineView;
};
export type WorkspaceData = {
  readonly schemaVersion: 1;
  readonly activeDraftId: string;
  readonly drafts: readonly DraftRecord[];
  readonly runs: readonly SavedRun[];
};
export type WorkspaceEnvelope = {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly data: WorkspaceData;
};
export type WorkspaceBundle = {
  readonly schemaVersion: 1;
  readonly kind: 'protocol-studio-bundle';
  readonly data: WorkspaceData;
};
