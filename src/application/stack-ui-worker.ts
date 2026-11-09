import { freezeOwned } from '../domain/immutable-data.ts';
import type { SavedStackRun } from '../domain/workspace-v2-model.ts';
import {
  createStackSimulation,
  createStackSimulationFromSnapshot,
} from './create-stack-simulation.ts';
import {
  compileStackBreakpoints,
  matchStackBreakpoints,
  runStackWithBreakpoints,
  type StackBreakpointPlan,
  type StackBreakpointStop,
} from './stack-breakpoints.ts';
import { compareStackCaseRuns } from './stack-coverage.ts';
import {
  buildStackComparisonModel,
  buildStackCoverageModel,
  buildStackPanelModel,
} from './stack-panel-model.ts';
import { primeOwnedStackRecord } from './stack-replay.ts';
import { createStackSeriesSession } from './stack-series.ts';
import { StackViewPublisher } from './stack-view-transfer.ts';
import {
  stackObservationKey,
  type StackRunMeta,
  type StackWorkerCommand,
  type StackWorkerWireReply,
  type StackWorkerRequest,
} from './stack-worker-protocol.ts';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<StackWorkerRequest>) => void) | null;
  postMessage: (message: StackWorkerWireReply) => void;
};
let engine: import('../engine/stack-scheduler.ts').StackScheduler | undefined;
let meta: StackRunMeta | undefined;
let debug: StackBreakpointPlan | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let turn = 0;
let series: ReturnType<typeof createStackSeriesSession> | undefined;
let seriesTimer: ReturnType<typeof setTimeout> | undefined;
let awaitingSeriesAck: number | undefined;
const records = new Map<string, SavedStackRun>();
const publisher = new StackViewPublisher();
class MissingRecord extends Error {}
function register(record: SavedStackRun) {
  const owned = freezeOwned(record);
  primeOwnedStackRecord(owned);
  const key = stackObservationKey(owned.id, owned.view);
  records.delete(key);
  records.set(key, owned);
  while (records.size > 64) {
    const oldest = records.keys().next().value;
    if (oldest !== undefined) records.delete(oldest);
  }
  return key;
}
function record(id: string) {
  const value = records.get(id);
  if (!value) throw new MissingRecord('기록 준비가 필요합니다.');
  records.delete(id);
  records.set(id, value);
  return value;
}
function clearRun() {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  running = false;
}
function publish(
  checkpoint: boolean,
  stop?: StackBreakpointStop,
  observed?: import('../domain/stack-runtime-model.ts').StackView,
) {
  if (!engine || !meta) return;
  const view = observed ?? engine.view();
  register({
    mode: 'stack',
    id: meta.id,
    experimentId: meta.experimentId,
    createdAt: meta.createdAt,
    draftVersion: meta.draftVersion,
    view,
  });
  scope.postMessage({
    type: 'view-transfer',
    meta,
    transfer: publisher.capture(view),
    running,
    checkpoint,
    ...(stop ? { stop } : {}),
  });
}
function advance(id: string, one = false) {
  if (!engine || engine.runId !== id || !debug) return;
  const result = runStackWithBreakpoints(engine, debug, one || turn++ < 4 ? 1 : 64);
  if (result.stop || engine.terminal || one) clearRun();
  publish(!running || engine.terminal, result.stop, result.view);
  if (running) timer = setTimeout(() => safeAdvance(id), 8);
}
function safeAdvance(id: string) {
  try {
    advance(id);
  } catch (error) {
    clearRun();
    engine?.pause();
    publish(true);
    scope.postMessage({ type: 'failure', runId: id, message: String(error) });
  }
}
function safeSeries(id: string) {
  try {
    advanceSeries(id);
  } catch (error) {
    seriesProgress(series?.cancel());
    scope.postMessage({ type: 'failure', seriesId: id, message: String(error) });
  }
}
function seriesProgress(record?: SavedStackRun) {
  if (!series) return;
  const progress = series.progress();
  if (record) register(record);
  scope.postMessage({
    type: 'series-progress',
    id: series.id,
    ...progress,
    ...(record ? { record } : {}),
  });
}
function advanceSeries(id: string) {
  if (!series || series.id !== id || series.progress().done) return;
  const next = series.advance();
  seriesProgress(next);
  if (!series.progress().done) {
    if (next) awaitingSeriesAck = series.progress().finished;
    else seriesTimer = setTimeout(() => safeSeries(id), 0);
  }
}
function handle(command: StackWorkerCommand): unknown {
  switch (command.type) {
    case 'start': {
      const created = command.snapshot
        ? createStackSimulationFromSnapshot(command.source, { runId: command.meta.runId })
        : createStackSimulation(command.source, { runId: command.meta.runId });
      if (!created.success) throw new Error(created.diagnostics[0]?.message);
      const points = compileStackBreakpoints(created.value.snapshot, command.settings);
      if (!points.success) throw new Error(points.diagnostics[0]?.message);
      clearRun();
      engine?.cancel();
      engine = created.value;
      meta = command.meta;
      debug = points.value;
      turn = 0;
      if (command.mode === 'step') advance(engine.runId, true);
      else {
        running = true;
        publish(false);
        timer = setTimeout(() => safeAdvance(command.meta.runId), 0);
      }
      return true;
    }
    case 'control': {
      if (!engine || engine.runId !== command.runId) return false;
      if (command.settings) {
        const points = compileStackBreakpoints(engine.snapshot, command.settings);
        if (!points.success) {
          clearRun();
          engine.pause();
          publish(true);
          throw new Error(points.diagnostics[0]?.message);
        }
        debug = points.value;
      }
      clearRun();
      if (engine.terminal) return true;
      if (command.action === 'cancel') {
        engine.cancel();
        publish(true);
      } else if (command.action === 'pause') {
        engine.pause();
        publish(true);
      } else if (command.action === 'step') advance(engine.runId, true);
      else {
        running = true;
        timer = setTimeout(() => safeAdvance(command.runId), 0);
      }
      return true;
    }
    case 'register':
      return register(command.record);
    case 'history-step': {
      const saved = record(command.recordKey);
      const cursor = Math.max(0, Math.min(saved.view.events.length + 1, command.cursor));
      const event = saved.view.events[cursor];
      const compiled = compileStackBreakpoints(saved.view.snapshot, command.settings);
      if (!compiled.success) throw new Error(compiled.diagnostics[0]?.message);
      const stop = event
        ? matchStackBreakpoints(compiled.value, [event], saved.view.artifacts)
        : undefined;
      return {
        cursor: Math.min(saved.view.events.length + 1, cursor + 1),
        eventId: event?.eventId,
        stop,
      };
    }
    case 'forget':
      records.delete(command.id);
      return true;
    case 'panel':
      return buildStackPanelModel(record(command.recordKey), command.query);
    case 'compare':
      return buildStackComparisonModel(record(command.left), record(command.right), command.page);
    case 'case-changes': {
      const rows = command.recordKeys.map(record);
      const before = rows.filter((r) => r.series?.id === command.before);
      const after = rows.filter((r) => r.series?.id === command.after);
      const manifest = after[0]?.series?.manifest ?? [];
      return manifest.slice(0, 20).map((member) => {
        const find = (rows: readonly SavedStackRun[]) =>
          rows.find((r) => r.series?.manifest[r.series.index]?.id === member.id);
        const left = find(before);
        const right = find(after);
        return {
          id: member.id,
          label: member.label,
          status: left && right ? compareStackCaseRuns(left, right) : 'missing',
          leftId: left?.id,
          rightId: right?.id,
        };
      });
    }
    case 'coverage':
      return buildStackCoverageModel(
        command.recordKeys.map(record),
        command.groupId,
        command.page,
        command.endpoint,
        command.unobservedOnly,
      );
    case 'continue-series': {
      if (
        !series ||
        series.id !== command.id ||
        awaitingSeriesAck !== command.finished ||
        series.progress().done
      )
        return false;
      awaitingSeriesAck = undefined;
      seriesTimer = setTimeout(() => safeSeries(command.id), 0);
      return true;
    }
    case 'series': {
      awaitingSeriesAck = undefined;
      if (seriesTimer !== undefined) clearTimeout(seriesTimer);
      series?.cancel();
      clearRun();
      engine?.cancel();
      series = createStackSeriesSession(command.plan);
      seriesProgress();
      seriesTimer = setTimeout(() => safeSeries(command.plan.id), 0);
      return true;
    }
    case 'cancel-series': {
      if (!series || series.id !== command.id) return false;
      awaitingSeriesAck = undefined;
      if (seriesTimer !== undefined) clearTimeout(seriesTimer);
      seriesTimer = undefined;
      seriesProgress(series.cancel());
      return true;
    }
  }
}
scope.onmessage = (event) => {
  const request = event.data;
  try {
    scope.postMessage({ type: 'response', id: request.id, value: handle(request.command) });
  } catch (error) {
    scope.postMessage({
      type: 'response',
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof MissingRecord ? { code: 'record-missing' as const } : {}),
    });
  }
};
