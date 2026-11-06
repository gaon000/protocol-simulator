import type { JsonValue } from './execution-contract.ts';
import type { ModelDiagnostic } from './protocol-model.ts';
import type {
  PayloadRange,
  RunArtifacts,
  StackEndpoint,
  StackSnapshot,
  StackTrace,
} from './stack-model.ts';

export type ByteOrigin = {
  readonly sourceEventId: string;
  readonly range: PayloadRange;
  readonly valueOffset: number;
  readonly sourceOffset: number;
  readonly length: number;
};

import type { PayloadUsage } from './stack-payloads.ts';

export type StackStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'limit-reached'
  | 'engine-error';
export type StackTimer = { generation: number; active: boolean; due: number };
export type StackPortState = 'ready' | 'failed' | 'closed';
export type StackInstanceView = {
  readonly endpoint: StackEndpoint;
  readonly stateId: string;
  readonly variables: Readonly<Record<string, JsonValue>>;
  readonly outcome: 'active' | 'success' | 'failure' | 'error';
  readonly finishedAt: number | null;
  readonly tainted: boolean;
  readonly timers: readonly (StackTimer & { readonly timerId: string })[];
  readonly ports: { readonly requires: StackPortState; readonly provides?: StackPortState };
};
export type StackVerdict = {
  readonly expectationId: string;
  readonly status: 'pass' | 'fail' | 'undetermined';
  readonly detail: string;
};
export type StackView = {
  readonly schemaVersion: 2;
  readonly mode: 'stack';
  readonly runId: string;
  readonly status: StackStatus;
  readonly timeMs: number;
  readonly processedOperations: number;
  readonly pendingOperations: number;
  readonly instances: Readonly<Record<string, StackInstanceView>>;
  readonly events: readonly StackTrace[];
  readonly artifacts: RunArtifacts;
  readonly usage: PayloadUsage;
  readonly diagnostics: readonly ModelDiagnostic[];
  readonly expectations: readonly StackVerdict[];
  readonly snapshot: StackSnapshot;
};
