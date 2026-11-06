import type { StackExperiment, StackSnapshot } from '../domain/stack-model.ts';
import type { StackView } from '../domain/stack-runtime-model.ts';
import type { SavedStackRun } from '../domain/workspace-v2-model.ts';
import type { StackBreakpoint, StackBreakpointStop } from './stack-breakpoints.ts';
import type { StackPanelQuery } from './stack-panel-model.ts';
import type { StackSeriesPlan } from './stack-series.ts';

export type StackRunMeta = {
  readonly id: string;
  readonly experimentId: string;
  readonly draftVersion: number;
  readonly createdAt: number;
  readonly runId: string;
};
export type StackDebugSettings = {
  readonly enabled: boolean;
  readonly points: readonly StackBreakpoint[];
};
export type StackWorkerCommand =
  | {
      readonly type: 'start';
      readonly meta: StackRunMeta;
      readonly source: StackExperiment | StackSnapshot;
      readonly snapshot: boolean;
      readonly mode: 'run' | 'step';
      readonly settings: StackDebugSettings;
    }
  | {
      readonly type: 'control';
      readonly runId: string;
      readonly action: 'run' | 'step' | 'pause' | 'cancel';
      readonly settings?: StackDebugSettings;
    }
  | { readonly type: 'register'; readonly record: SavedStackRun }
  | {
      readonly type: 'history-step';
      readonly recordId: string;
      readonly cursor: number;
      readonly settings: StackDebugSettings;
    }
  | { readonly type: 'forget'; readonly id: string }
  | { readonly type: 'panel'; readonly recordId: string; readonly query: StackPanelQuery }
  | {
      readonly type: 'compare';
      readonly left: string;
      readonly right: string;
      readonly page: number;
    }
  | {
      readonly type: 'case-changes';
      readonly records: readonly SavedStackRun[];
      readonly before: string;
      readonly after: string;
    }
  | {
      readonly type: 'coverage';
      readonly records: readonly SavedStackRun[];
      readonly groupId: string;
      readonly page: number;
      readonly endpoint: string;
      readonly unobservedOnly: boolean;
    }
  | { readonly type: 'series'; readonly plan: StackSeriesPlan }
  | { readonly type: 'continue-series'; readonly id: string; readonly finished: number }
  | { readonly type: 'cancel-series'; readonly id: string };
export type StackWorkerRequest = { readonly id: number; readonly command: StackWorkerCommand };
export type StackWorkerReply =
  | {
      readonly type: 'failure';
      readonly message: string;
      readonly runId?: string;
      readonly seriesId?: string;
    }
  | {
      readonly type: 'response';
      readonly id: number;
      readonly value?: unknown;
      readonly error?: string;
    }
  | {
      readonly type: 'view';
      readonly meta: StackRunMeta;
      readonly view: StackView;
      readonly running: boolean;
      readonly stop?: StackBreakpointStop;
      readonly checkpoint: boolean;
    }
  | {
      readonly type: 'series-progress';
      readonly id: string;
      readonly finished: number;
      readonly total: number;
      readonly done: boolean;
      readonly record?: SavedStackRun;
    };
