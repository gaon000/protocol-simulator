import { createNewStack, NEW_STACK_DEFAULTS } from '../../src/application/new-stack.ts';
import { createWorkspace } from '../../src/application/workspace-operations.ts';
import { createWorkspaceV2 } from '../../src/application/workspace-v2-operations.ts';
import { serializeBytes } from '../../src/domain/stack-bytes.ts';
import type {
  NativeStackProtocol,
  StackField,
  StackExperiment,
} from '../../src/domain/stack-model.ts';
import { createPingPongExperiment } from '../../src/examples/ping-pong.ts';

/** Exercise typed scenario values with a real native one-way sender/provider/receiver stack. */
export function stackScenarioConfiguration(large = false, byteDraft = false): StackExperiment {
  const result = createNewStack(NEW_STACK_DEFAULTS, 'scenario_stack');
  if (!result.success) throw new Error(JSON.stringify(result.diagnostics));
  const original = result.value.definitions[0];
  if (original?.mode !== 'stack-protocol') throw new Error('Missing native application');
  const fields: readonly StackField[] = [
    {
      id: 'text',
      name: '본문',
      type: 'string',
      placement: 'body',
      required: true,
      defaultValue: '기본 내용',
    },
    {
      id: 'count',
      name: '횟수',
      type: 'integer',
      placement: 'body',
      required: true,
      defaultValue: 7,
      min: 0,
    },
    {
      id: 'flag',
      name: '표시',
      type: 'boolean',
      placement: 'body',
      required: true,
      defaultValue: false,
    },
    {
      id: 'mode',
      name: '모드',
      type: 'enum',
      placement: 'body',
      required: true,
      options: ['idle', 'active'],
      defaultValue: 'idle',
    },
    ...(byteDraft
      ? [
          {
            id: 'bytes',
            name: '바이트',
            type: 'bytes',
            placement: 'body',
            required: true,
            defaultValue: serializeBytes(new Uint8Array()),
          } as const,
        ]
      : []),
    {
      id: 'token',
      name: '토큰',
      type: 'string',
      placement: 'body',
      required: false,
      defaultValue: '',
    },
    ...(large
      ? Array.from(
          { length: 124 },
          (_, i): StackField => ({
            id: `extra_${i}`,
            name: `추가 ${i}`,
            type: 'string',
            placement: 'body',
            required: false,
            defaultValue: '',
          }),
        )
      : []),
  ];
  const protocol: NativeStackProtocol = {
    ...original,
    messages: Array.from({ length: large ? 125 : 2 }, (_, i) => ({
      id: i ? `other_${i}` : 'message',
      label: i ? `다른 메시지 ${i}` : '기본 메시지',
      fields: structuredClone(i ? fields.slice(0, 4) : fields),
    })),
    rules: original.rules.map((rule) => ({
      ...rule,
      actions: rule.actions.map((action) =>
        action.kind === 'send' || action.kind === 'deliver'
          ? {
              ...action,
              values: Object.fromEntries(
                fields.map((field) => [field.id, { kind: 'field' as const, fieldId: field.id }]),
              ),
            }
          : action,
      ),
    })),
  };
  const target = { participant: 'A' as const, instanceId: 'app' };
  const message = {
    messageId: 'message',
    values: {
      text: '처음',
      count: 0,
      flag: false,
      mode: 'idle',
      ...(byteDraft ? { bytes: serializeBytes(new Uint8Array()) } : {}),
      token: '',
    },
  };
  return {
    ...result.value,
    definitions: [protocol, ...result.value.definitions.slice(1)],
    scenario: {
      ...result.value.scenario,
      inputs: Array.from({ length: large ? 125 : 1 }, (_, i) => ({
        id: `input_${i + 1}`,
        timeMs: 0,
        target,
        message: structuredClone(message),
      })),
      expectations: Array.from({ length: large ? 125 : 1 }, (_, i) => ({
        id: `expected_${i + 1}`,
        kind: 'delivered-values' as const,
        target: { participant: 'B', instanceId: 'app' },
        message: structuredClone(message),
      })),
    },
  };
}

/** Wrap an independently cloned stack draft in the actual canonical v2 workspace shape. */
export function stackScenarioWorkspace(large = false, byteDraft = false) {
  return createWorkspaceV2(
    createWorkspace(createPingPongExperiment()),
    stackScenarioConfiguration(large, byteDraft),
  );
}
