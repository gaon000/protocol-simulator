import type { SavedStackRun } from '../domain/workspace-v2-model.ts';
import type {
  StackWorkerCommand,
  StackWorkerReply,
  StackWorkerRequest,
} from './stack-worker-protocol.ts';

/** Fence worker requests and reject outstanding work on unmount instead of applying stale run callbacks. */
export class StackWorkerClient {
  readonly #worker: Worker;
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  #next = 0;
  #closed = false;
  readonly #registered = new WeakMap<SavedStackRun, Promise<unknown>>();
  onEvent: (event: Exclude<StackWorkerReply, { type: 'response' }>) => void = () => {};
  onError: (message: string) => void = () => {};
  constructor(
    worker = new Worker(new URL('./stack-ui-worker.ts', import.meta.url), { type: 'module' }),
  ) {
    this.#worker = worker;
    worker.onmessage = (event: MessageEvent<StackWorkerReply>) => {
      const reply = event.data;
      if (this.#closed) return;
      if (reply.type !== 'response') {
        this.onEvent(reply);
        return;
      }
      const pending = this.#pending.get(reply.id);
      this.#pending.delete(reply.id);
      if (reply.error) pending?.reject(new Error(reply.error));
      else pending?.resolve(reply.value);
    };
    worker.onerror = () => {
      if (this.#closed) return;
      this.onError('실행 worker 오류입니다. 마지막 관찰과 저장 자료는 유지합니다.');
      this.close();
    };
  }
  /** Send only the typed private application protocol, never executable expressions. */
  request<T>(command: StackWorkerCommand): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('실행 worker가 닫혔습니다.'));
    const id = ++this.#next;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject });
      const request: StackWorkerRequest = { id, command };
      try {
        this.#worker.postMessage(request);
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }
  /** Transfer each immutable observation once; later bounded queries reuse worker-owned records. */
  async register(record: SavedStackRun): Promise<void> {
    let pending = this.#registered.get(record);
    if (!pending) {
      pending = this.request({ type: 'register', record });
      this.#registered.set(record, pending);
    }
    await pending;
  }
  /** Release an archived cache entry while allowing an existing memory view to register again later. */
  async forget(record: SavedStackRun): Promise<void> {
    this.#registered.delete(record);
    await this.request({ type: 'forget', id: record.id });
  }
  /** Release the worker and fence all responses from the previous editor generation. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#worker.terminate();
    for (const item of this.#pending.values()) item.reject(new Error('실행 창을 닫았습니다.'));
    this.#pending.clear();
  }
}
