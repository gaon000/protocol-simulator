import type { SavedStackRun } from '../domain/workspace-v2-model.ts';
import type { StackView } from '../domain/stack-runtime-model.ts';
import {
  stackObservationKey,
  type StackWorkerCommand,
  type StackWorkerReply,
  type StackWorkerRequest,
  type StackWorkerWireReply,
} from './stack-worker-protocol.ts';
import { StackViewReceiver } from './stack-view-transfer.ts';

class WorkerFailure extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

/** Fence worker requests and reject outstanding work on unmount instead of applying stale run callbacks. */
export class StackWorkerClient {
  readonly #worker: Worker;
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  #next = 0;
  #closed = false;
  readonly #registered = new WeakMap<SavedStackRun, Promise<string>>();
  readonly #published = new WeakMap<StackView, string>();
  readonly #receiver = new StackViewReceiver();
  onEvent: (event: Exclude<StackWorkerReply, { type: 'response' }>) => void = () => {};
  onError: (message: string) => void = () => {};
  constructor(
    worker = new Worker(new URL('./stack-ui-worker.ts', import.meta.url), { type: 'module' }),
  ) {
    this.#worker = worker;
    worker.onmessage = (event: MessageEvent<StackWorkerWireReply>) => {
      if (this.#closed) return;
      let reply: StackWorkerReply;
      if (event.data.type === 'view-transfer') {
        try {
          const { type: _type, transfer, ...meta } = event.data;
          reply = { ...meta, type: 'view', view: this.#receiver.receive(transfer) };
        } catch (error) {
          this.onError(String(error));
          this.close();
          return;
        }
      } else reply = event.data;
      if (reply.type !== 'response') {
        if (reply.type === 'view')
          this.#published.set(reply.view, stackObservationKey(reply.meta.id, reply.view));
        if (reply.type === 'series-progress' && reply.record)
          this.#registered.set(
            reply.record,
            Promise.resolve(stackObservationKey(reply.record.id, reply.record.view)),
          );
        this.onEvent(reply);
        return;
      }
      const pending = this.#pending.get(reply.id);
      this.#pending.delete(reply.id);
      if (reply.error) pending?.reject(new WorkerFailure(reply.error, reply.code));
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
  async register(record: SavedStackRun): Promise<string> {
    let pending = this.#registered.get(record);
    if (!pending) {
      const key = stackObservationKey(record.id, record.view);
      pending =
        this.#published.get(record.view) === key
          ? Promise.resolve(key)
          : this.request<string>({ type: 'register', record });
      this.#registered.set(record, pending);
    }
    return await pending;
  }
  /** Retry evicted immutable observations once, transferring records separately to keep the UI responsive. */
  async inspect<T>(
    records: readonly SavedStackRun[],
    command: (keys: readonly string[]) => StackWorkerCommand,
  ): Promise<T> {
    const keys: string[] = [];
    for (const record of records) keys.push(await this.register(record));
    try {
      return await this.request<T>(command(keys));
    } catch (error) {
      if (!(error instanceof WorkerFailure) || error.code !== 'record-missing') throw error;
      for (const record of records) {
        this.#registered.delete(record);
        this.#published.delete(record.view);
        await this.register(record);
      }
      return await this.request<T>(command(keys));
    }
  }
  /** Release an archived cache entry while allowing an existing memory view to register again later. */
  async forget(record: SavedStackRun): Promise<void> {
    this.#registered.delete(record);
    this.#published.delete(record.view);
    await this.request({ type: 'forget', id: stackObservationKey(record.id, record.view) });
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
