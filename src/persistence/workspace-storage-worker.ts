import type { WorkspaceV2 } from '../domain/workspace-v2-model.ts';
import { parseWorkspaceV2, parseWorkspaceV2Envelope } from '../domain/workspace-v2-validation.ts';
import { parseOwnedJsonData } from '../domain/model-validation.ts';
import { WORKSPACE_POLICY } from '../domain/workspace-model.ts';
import { freezeOwned } from '../domain/immutable-data.ts';
import { restoreWorkspace } from './workspace-transfer.ts';
import { createIndexedDbV2Storage } from './indexed-db-v2.ts';
import { StorageFailure } from './storage-port.ts';

const port = createIndexedDbV2Storage();
const validated = new Map<number, WorkspaceV2>();
const writable = new Set<number>();
function remember(id: number, data: WorkspaceV2, canWrite: boolean) {
  validated.set(id, data);
  if (canWrite) writable.add(id);
  while (validated.size > 2) {
    const oldest = validated.keys().next().value;
    if (oldest !== undefined) {
      validated.delete(oldest);
      writable.delete(oldest);
    }
  }
}
const scope = globalThis as unknown as {
  onmessage: (
    event: MessageEvent<{
      id: number;
      type: string;
      data?: unknown;
      revision?: number | null;
      token?: number;
      baseToken?: number;
    }>,
  ) => void;
  postMessage: (value: unknown) => void;
};
scope.onmessage = async ({ data: request }) => {
  try {
    let value: unknown;
    switch (request.type) {
      case 'read':
        value = await port.read();
        break;
      case 'backup':
        value = await port.readLegacyBackup();
        break;
      case 'write':
        {
          const data = request.token === undefined ? request.data : validated.get(request.token);
          if (!data || (request.token !== undefined && !writable.has(request.token)))
            throw new StorageFailure('invalid', '저장 자료를 다시 검사하세요.');
          try {
            value = await port.write(data as WorkspaceV2, request.revision ?? null);
          } finally {
            if (request.token !== undefined) writable.delete(request.token);
          }
        }
        break;
      case 'validate': {
        let candidate: unknown = request.data;
        if (request.baseToken !== undefined) {
          const base = validated.get(request.baseToken);
          if (!base) {
            value = { success: false, missingBase: true };
            break;
          }
          const restored = restoreWorkspace(candidate, base);
          if (!restored.success) {
            value = restored;
            break;
          }
          candidate = restored.value;
        }
        const json = parseOwnedJsonData(candidate, {
          maxNodes: WORKSPACE_POLICY.maxJsonNodes,
          maxDepth: 128,
        });
        const result = json.success ? parseWorkspaceV2(json.value) : json;
        if (result.success) remember(request.id, result.value, true);
        value = result.success ? { success: true, token: request.id } : result;
        break;
      }
      case 'envelope': {
        const json = parseOwnedJsonData(request.data, {
          maxNodes: WORKSPACE_POLICY.maxJsonNodes,
          maxDepth: 132,
        });
        const result = json.success ? parseWorkspaceV2Envelope(json.value) : json;
        if (result.success) remember(request.id, freezeOwned(result.value.data), false);
        value = result.success
          ? {
              success: true,
              token: request.id,
              ...(request.data &&
              typeof request.data === 'object' &&
              'schemaVersion' in request.data &&
              request.data.schemaVersion === 1
                ? { upgraded: result.value }
                : {}),
            }
          : result;
        break;
      }
      default:
        throw new StorageFailure('invalid', '알 수 없는 저장 요청입니다.');
    }
    scope.postMessage({ id: request.id, value });
  } catch (error) {
    scope.postMessage({
      id: request.id,
      error: {
        code: error instanceof StorageFailure ? error.code : 'unknown',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
};
