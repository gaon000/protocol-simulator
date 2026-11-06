import { createWorkspace } from '../../src/application/workspace-operations.ts';
import { createWorkspaceV2 } from '../../src/application/workspace-v2-operations.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';
import { createStackExampleCopy } from '../../src/examples/reliable-stack-examples.ts';

/** Preserve hundreds of actual declared actions while exercising a bounded selected-rule form. */
export function largeStackRuleWorkspace(count = 600) {
  const source = createStackExampleCopy('stack_ping_pong');
  const configuration = {
    ...source,
    definitions: source.definitions.map((protocol, index) =>
      index === 1 && protocol.mode === 'stack-protocol'
        ? {
            ...protocol,
            rules: protocol.rules.map((rule, i) =>
              i === 0
                ? {
                    ...rule,
                    actions: [
                      ...rule.actions,
                      ...Array.from({ length: count }, () => ({
                        kind: 'assign' as const,
                        variableId: 'retries',
                        value: { kind: 'literal' as const, value: 0 },
                      })),
                    ],
                  }
                : rule,
            ),
          }
        : protocol,
    ),
  };
  return createWorkspaceV2(createWorkspace(createPingPongExperiment()), configuration);
}
