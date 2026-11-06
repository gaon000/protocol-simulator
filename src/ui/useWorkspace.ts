import { createContext, useContext } from 'react';
import type { createLegacyWorkspaceFacade } from '../application/legacy-workspace-facade.ts';
import type { createWorkspaceV2Controller } from '../application/workspace-v2-controller.ts';
import type { ValidationResult } from '../domain/protocol-model.ts';
import type { WorkspaceV2 } from '../domain/workspace-v2-model.ts';

export type WorkspaceHost = {
  readonly controller: ReturnType<typeof createLegacyWorkspaceFacade>;
  readonly full: ReturnType<typeof createWorkspaceV2Controller>;
  readonly stageImport: (text: string) => ValidationResult<WorkspaceV2>;
  readonly applyImport: (data: WorkspaceV2) => void;
  readonly exportBundle: () => ValidationResult<string>;
  readonly exportLegacy: () => ValidationResult<string>;
  readonly exportBackup: () => Promise<ValidationResult<string>>;
  readonly registerLeave: (leave: () => void | Promise<void>) => () => void;
};
export const WorkspaceContext = createContext<WorkspaceHost | null>(null);

/** Bind the legacy editor to the shared canonical v2 workspace without opening an old writer. */
export function useWorkspace() {
  const host = useContext(WorkspaceContext);
  if (!host) throw new Error('Workspace host is required');
  return { ...host, ...host.controller.view() };
}
