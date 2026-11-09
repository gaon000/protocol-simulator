import { createNewStack, NEW_STACK_DEFAULTS } from '../../src/application/new-stack.ts';
import { createWorkspace } from '../../src/application/workspace-operations.ts';
import { createWorkspaceV2 } from '../../src/application/workspace-v2-operations.ts';
import type { NativeStackProtocol, StackExperiment } from '../../src/domain/stack-model.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';

/** Start with a deliberately unfinished application whose first authored transition will satisfy its scenario. */
export function stackVisualWorkspace(large = false) {
  const built = createNewStack({ ...NEW_STACK_DEFAULTS, flow: 'empty' }, 'visual_stack');
  if (!built.success) throw new Error('Invalid visual authoring fixture');
  const app = built.value.definitions[0];
  if (app?.mode !== 'stack-protocol') throw new Error('Missing native application');
  const definition: NativeStackProtocol = large
    ? {
        ...app,
        states: Array.from({ length: 125 }, (_, i) => ({ id: `s_${i}`, label: `상태 ${i}` })),
        initialStateId: 's_0',
        rules: Array.from({ length: 605 }, (_, i) => ({
          id: `r_${i}`,
          fromStateId: `s_${i % 125}`,
          nextStateId: `s_${i % 125}`,
          event: { kind: 'input', messageId: 'message' },
          condition: {
            kind: 'compare',
            operator: 'eq',
            left: { kind: 'literal', value: 0 },
            right: { kind: 'literal', value: i },
          },
          actions: [],
          ignore: true,
        })),
      }
    : app;
  const configuration: StackExperiment = {
    ...built.value,
    definitions: [definition, ...built.value.definitions.slice(1)],
    scenario: {
      ...built.value.scenario,
      inputs: [
        {
          id: 'start',
          timeMs: 0,
          target: { participant: 'A', instanceId: 'app' },
          message: { messageId: 'message', values: { text: '그림에서 작성' } },
        },
      ],
      expectations: [
        {
          id: 'destination',
          kind: 'state',
          target: { participant: 'A', instanceId: 'app' },
          stateId: large ? 's_0' : 'state_1',
        },
      ],
    },
  };
  return createWorkspaceV2(createWorkspace(createPingPongExperiment()), configuration);
}
