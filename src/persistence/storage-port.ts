/** A versioned adapter resolves writes only when the entire CAS transaction commits. */
export type VersionedStoragePort<Data> = {
  readonly read: () => Promise<unknown>;
  readonly write: (data: Data, expectedRevision: number | null) => Promise<number>;
};
/** Describe recoverable storage errors while preserving memory and the last committed database. */
export class StorageFailure extends Error {
  readonly code: 'unavailable' | 'blocked' | 'quota' | 'conflict' | 'invalid' | 'unknown';
  constructor(code: StorageFailure['code'], message: string) {
    super(message);
    this.code = code;
  }
}
/** Normalize browser failures without exposing data or mistaking request success for a commit. */
export function storageProblem(error: unknown): StorageFailure {
  if (error instanceof StorageFailure) return error;
  if (error && typeof error === 'object' && 'name' in error && error.name === 'VersionError')
    return new StorageFailure(
      'invalid',
      '더 새로운 저장소 버전입니다. 기존 자료를 덮어쓰지 않았습니다.',
    );
  if (error && typeof error === 'object' && 'name' in error && error.name === 'QuotaExceededError')
    return new StorageFailure(
      'quota',
      '브라우저 저장 공간이 부족합니다. 메모리 초안을 유지했습니다.',
    );
  return new StorageFailure(
    'unknown',
    error instanceof Error ? error.message : '브라우저 저장에 실패했습니다.',
  );
}
