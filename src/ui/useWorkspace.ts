import { useEffect, useState } from 'react';
import { createWorkspaceController } from '../application/workspace-controller.ts';
import { createWorkspace } from '../application/workspace-operations.ts';
import { createExampleCopy } from '../examples/catalog.ts';
import { createIndexedDbStorage } from '../persistence/indexed-db.ts';

/** Bind browser storage to React while keeping transactional state and save sequencing outside UI. */
export function useWorkspace() {
  const [controller] = useState(() =>
    createWorkspaceController(
      createIndexedDbStorage(),
      createWorkspace(createExampleCopy('ping_pong')),
    ),
  );
  const [state, setState] = useState(controller.view);
  useEffect(() => controller.subscribe(() => setState(controller.view())), [controller]);
  useEffect(() => {
    void controller.load();
  }, [controller]);
  useEffect(() => {
    if (!state.ready || state.serial === 0) return;
    const timeout = window.setTimeout(() => {
      void controller.save();
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [controller, state.ready, state.serial]);
  return { ...state, controller };
}
