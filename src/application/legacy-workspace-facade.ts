import type { createWorkspaceController } from './workspace-controller.ts';
import type { createWorkspaceV2Controller } from './workspace-v2-controller.ts';

/** Project legacy UI actions through the one canonical v2 controller, preserving all stack records. */
export function createLegacyWorkspaceFacade(
  controller: ReturnType<typeof createWorkspaceV2Controller>,
): ReturnType<typeof createWorkspaceController> {
  return {
    view: () => {
      const state = controller.view();
      return { ...state, data: state.data.legacy };
    },
    subscribe: controller.subscribe,
    load: controller.load,
    save: controller.save,
    retry: controller.retry,
    update: (change) =>
      controller.update((data) => {
        const legacy = change(data.legacy);
        return legacy === data.legacy ? data : { ...data, legacy };
      }),
  };
}
