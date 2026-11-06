import type { JsonValue } from './execution-contract.ts';
import type { StackExperiment } from './stack-model.ts';
import type { StackView } from './stack-runtime-model.ts';
import type { WorkspaceData } from './workspace-model.ts';

export type StackCase = {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly seed: number;
  readonly scenario: StackExperiment['scenario'];
  readonly environment: StackExperiment['link']['environment'];
};
export type StackSuite = {
  readonly id: string;
  readonly label: string;
  readonly revision: number;
  readonly cases: readonly StackCase[];
};
export type StackDraft = {
  readonly mode: 'stack';
  readonly id: string;
  readonly configuration: StackExperiment;
  readonly raw: Readonly<Record<string, string>>;
  readonly version: number;
  readonly updatedAt: number;
  readonly suite?: StackSuite;
};
export type StackSeriesInfo = {
  readonly id: string;
  readonly label: string;
  readonly kind: 'batch' | 'regression';
  readonly suite?: { readonly id: string; readonly revision: number };
  readonly manifest: readonly { readonly id: string; readonly label: string }[];
  readonly index: number;
  readonly source: JsonValue;
  readonly condition: JsonValue;
};
export type SavedStackRun = {
  readonly mode: 'stack';
  readonly id: string;
  readonly experimentId: string;
  readonly createdAt: number;
  readonly draftVersion: number;
  readonly view: StackView;
  readonly series?: StackSeriesInfo;
};
export type StackWorkspace = {
  readonly activeDraftId: string | null;
  readonly drafts: readonly StackDraft[];
  readonly runs: readonly SavedStackRun[];
};
export type WorkspaceV2 = {
  readonly schemaVersion: 2;
  readonly mode: 'workspace';
  readonly legacy: WorkspaceData;
  readonly stack: StackWorkspace;
};
export type WorkspaceV2Envelope = {
  readonly schemaVersion: 2;
  readonly revision: number;
  readonly data: WorkspaceV2;
};
export type WorkspaceV2Bundle = {
  readonly schemaVersion: 2;
  readonly kind: 'protocol-studio-bundle';
  readonly data: WorkspaceV2;
};
