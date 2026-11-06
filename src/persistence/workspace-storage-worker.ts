import type { WorkspaceV2 } from '../domain/workspace-v2-model.ts';
import { parseWorkspaceV2, parseWorkspaceV2Envelope } from '../domain/workspace-v2-validation.ts';
import { freezeOwned } from '../domain/immutable-data.ts';
import { createIndexedDbV2Storage } from './indexed-db-v2.ts';
import { StorageFailure } from './storage-port.ts';

const port = createIndexedDbV2Storage();
const validated = new Map<number, WorkspaceV2>();
const scope = globalThis as unknown as {
  onmessage: (
    event: MessageEvent<{
      id: number;
      type: string;
      data?: unknown;
      revision?: number | null;
      token?: number;
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
          if (!data) throw new StorageFailure('invalid', '저장 자료를 다시 검사하세요.');
          try {
            value = await port.write(data as WorkspaceV2, request.revision ?? null);
          } finally {
            if (request.token !== undefined) validated.delete(request.token);
          }
        }
        break;
      case 'validate': {
        const data = freezeOwned(request.data);
        const result = parseWorkspaceV2(data);
        if (result.success) {
          validated.set(request.id, result.value);
          while (validated.size > 2) {
            const key = validated.keys().next().value;
            if (key !== undefined) validated.delete(key);
          }
        }
        value = result.success ? { success: true, token: request.id } : result;
        break;
      }
      case 'envelope': {
        const result = parseWorkspaceV2Envelope(request.data);
        value = result.success
          ? {
              success: true,
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
