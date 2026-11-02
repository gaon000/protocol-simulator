import type { ParticipantId } from '../domain/execution-contract.ts';
import type {
  EngineView,
  ExperimentDefinition,
  ProtocolDefinition,
} from '../domain/protocol-model.ts';

export const DIAGRAM_POLICY = { statesPerPage: 40, rulesPerPage: 20 } as const;
export type DiagramNode = {
  readonly key: string;
  readonly stateIndex: number | undefined;
  readonly id: string;
  readonly label: string;
  readonly initial: boolean;
  readonly terminal: boolean;
  readonly problem: string | undefined;
  readonly x: number;
  readonly y: number;
};
export type DiagramEdge = {
  readonly key: string;
  readonly from: string;
  readonly to: string;
  readonly ruleIndices: readonly number[];
  readonly path: string;
  readonly labelX: number;
  readonly labelY: number;
  readonly anchorX: number;
  readonly anchorY: number;
};
export type StateDiagramModel = {
  readonly nodes: readonly DiagramNode[];
  readonly edges: readonly DiagramEdge[];
  readonly width: number;
  readonly height: number;
  readonly statePage: number;
  readonly rulePage: number;
  readonly statePages: number;
  readonly rulePages: number;
  readonly visibleRules: readonly number[];
};
const NODE_WIDTH = 170;
const NODE_HEIGHT = 92;
export const DIAGRAM_NODE_SIZE = { width: NODE_WIDTH, height: NODE_HEIGHT } as const;

function page(value: number | undefined, total: number, size: number) {
  const pages = Math.max(1, Math.ceil(total / size));
  const index = Number.isSafeInteger(value) ? Math.max(0, Math.min(value ?? 0, pages - 1)) : 0;
  return { pages, index };
}

/** Build a bounded graph page without rewriting invalid drafts or choosing ambiguous state IDs. */
export function buildStateDiagram(
  protocol: ProtocolDefinition,
  options: {
    readonly statePage?: number;
    readonly rulePage?: number;
    readonly currentStateIds?: readonly string[];
  } = {},
): StateDiagramModel {
  const states = page(options.statePage, protocol.states.length, DIAGRAM_POLICY.statesPerPage);
  const rules = page(options.rulePage, protocol.rules.length, DIAGRAM_POLICY.rulesPerPage);
  const unique = new Map<string, number | undefined>();
  for (const [index, state] of protocol.states.entries())
    unique.set(state.id, unique.has(state.id) ? undefined : index);
  const temporary = new Map<string, Omit<DiagramNode, 'x' | 'y'>>();
  function addState(index: number): string {
    const state = protocol.states[index];
    if (!state) throw new Error('State index is outside the diagram definition');
    const key = `state-${index}`;
    temporary.set(key, {
      key,
      stateIndex: index,
      id: state.id,
      label: state.label,
      initial:
        state.id !== '' && unique.get(state.id) === index && state.id === protocol.initialStateId,
      terminal: state.terminal === true,
      problem: !state.id.trim()
        ? '빈 상태 ID'
        : unique.get(state.id) === undefined
          ? '중복 상태 ID'
          : undefined,
    });
    return key;
  }
  function endpoint(id: string): string {
    const index = unique.get(id);
    if (id.trim() && index !== undefined) return addState(index);
    const key = `reference-${id}`;
    temporary.set(key, {
      key,
      stateIndex: undefined,
      id,
      label: '해결되지 않은 참조',
      initial: id === protocol.initialStateId,
      terminal: false,
      problem: !id.trim() ? '빈 상태 참조' : unique.has(id) ? '중복 ID 참조' : '없는 상태 참조',
    });
    return key;
  }
  const start = states.index * DIAGRAM_POLICY.statesPerPage;
  for (
    let index = start;
    index < Math.min(start + DIAGRAM_POLICY.statesPerPage, protocol.states.length);
    index++
  )
    addState(index);
  const initial = endpoint(protocol.initialStateId);
  for (const id of (options.currentStateIds ?? []).slice(0, 2)) endpoint(id);
  const visibleRules = Array.from(
    {
      length: Math.min(
        DIAGRAM_POLICY.rulesPerPage,
        Math.max(0, protocol.rules.length - rules.index * DIAGRAM_POLICY.rulesPerPage),
      ),
    },
    (_, index) => index + rules.index * DIAGRAM_POLICY.rulesPerPage,
  );
  const groups = new Map<string, { from: string; to: string; ruleIndices: number[] }>();
  for (const index of visibleRules) {
    const rule = protocol.rules[index];
    if (!rule) continue;
    const from = endpoint(rule.fromStateId);
    const to = endpoint(rule.nextStateId);
    const key = JSON.stringify([from, to]);
    const group = groups.get(key) ?? { from, to, ruleIndices: [] };
    group.ruleIndices.push(index);
    groups.set(key, group);
  }
  // Use the complete definition for reachability so page changes do not change a state's column.
  const adjacency = new Map<number, number[]>();
  for (const rule of protocol.rules) {
    const from = unique.get(rule.fromStateId);
    const to = unique.get(rule.nextStateId);
    if (
      from === undefined ||
      to === undefined ||
      !rule.fromStateId.trim() ||
      !rule.nextStateId.trim()
    )
      continue;
    const outgoing = adjacency.get(from) ?? [];
    outgoing.push(to);
    adjacency.set(from, outgoing);
  }
  const ranks = new Map<number, number>();
  const origin = unique.get(protocol.initialStateId);
  const queue: number[] = [];
  if (origin !== undefined && protocol.initialStateId.trim()) {
    ranks.set(origin, 0);
    queue.push(origin);
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const from = queue[cursor];
    if (from === undefined) continue;
    for (const to of adjacency.get(from) ?? [])
      if (!ranks.has(to)) {
        ranks.set(to, (ranks.get(from) ?? 0) + 1);
        queue.push(to);
      }
  }
  const rows = [0, 0, 0, 0];
  const nodes = [...temporary.values()]
    .sort(
      (a, b) =>
        Number(b.key === initial) - Number(a.key === initial) ||
        (a.stateIndex ?? Number.MAX_SAFE_INTEGER) - (b.stateIndex ?? Number.MAX_SAFE_INTEGER) ||
        a.key.localeCompare(b.key),
    )
    .map((node): DiagramNode => {
      const column = Math.min(
        3,
        node.stateIndex === undefined ? 1 : (ranks.get(node.stateIndex) ?? 0),
      );
      const row = rows[column] ?? 0;
      rows[column] = row + 1;
      return { ...node, x: 72 + column * 320, y: 116 + row * 210 };
    });
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  let width = Math.max(420, ...nodes.map((node) => node.x + NODE_WIDTH + 130));
  let height = Math.max(260, ...nodes.map((node) => node.y + NODE_HEIGHT + 64));
  const edges: DiagramEdge[] = [];
  for (const [key, group] of groups) {
    const from = byKey.get(group.from);
    const to = byKey.get(group.to);
    if (!from || !to) continue;
    let sx = from.x + NODE_WIDTH;
    let sy = from.y + NODE_HEIGHT / 2;
    let ex = to.x;
    let ey = to.y + NODE_HEIGHT / 2;
    let c1x: number, c1y: number, c2x: number, c2y: number;
    if (from.key === to.key) {
      sx = from.x + NODE_WIDTH / 2 - 28;
      sy = from.y;
      ex = from.x + NODE_WIDTH / 2 + 28;
      ey = from.y;
      c1x = sx - 64;
      c1y = sy - 108;
      c2x = ex + 64;
      c2y = ey - 108;
    } else if (from.x < to.x) {
      c1x = sx + (ex - sx) / 2;
      c1y = sy;
      c2x = c1x;
      c2y = ey;
    } else if (from.x > to.x) {
      sx = from.x + NODE_WIDTH / 2;
      sy = from.y;
      ex = to.x + NODE_WIDTH / 2;
      ey = to.y;
      c1x = sx;
      c2x = ex;
      c1y = Math.min(sy, ey) - 60 - (edges.length % 3) * 18;
      c2y = c1y;
    } else {
      ex = to.x + NODE_WIDTH;
      const lane = Math.max(sx, ex) + 84 + (edges.length % 4) * 18;
      c1x = lane;
      c1y = sy;
      c2x = lane;
      c2y = ey;
    }
    const point = (t: number) => ({
      x: (1 - t) ** 3 * sx + 3 * (1 - t) ** 2 * t * c1x + 3 * (1 - t) * t ** 2 * c2x + t ** 3 * ex,
      y: (1 - t) ** 3 * sy + 3 * (1 - t) ** 2 * t * c1y + 3 * (1 - t) * t ** 2 * c2y + t ** 3 * ey,
    });
    const clearLabel = (position: { x: number; y: number }) =>
      position.x >= 56 &&
      position.y >= 24 &&
      !nodes.some(
        (node) =>
          position.x - 54 < node.x + NODE_WIDTH + 2 &&
          position.x + 54 > node.x - 2 &&
          position.y - 22 < node.y + NODE_HEIGHT + 2 &&
          position.y + 22 > node.y - 2,
      ) &&
      !edges.some(
        (edge) =>
          Math.abs(position.x - edge.labelX) < 112 && Math.abs(position.y - edge.labelY) < 48,
      );
    const onCurve = [0.5, 0.34, 0.66, 0.2, 0.8].map(point).find(clearLabel);
    const anchor = onCurve ?? point(0.5);
    const label = onCurve ??
      [
        { x: anchor.x, y: anchor.y - 64 },
        { x: anchor.x, y: anchor.y + 64 },
        { x: anchor.x + 116, y: anchor.y },
        { x: anchor.x - 116, y: anchor.y },
      ].find(clearLabel) ?? { x: Math.max(60, anchor.x), y: height + 32 };
    const labelX = label.x;
    const labelY = label.y;
    width = Math.max(width, labelX + 60);
    height = Math.max(height, labelY + 28);
    width = Math.max(width, c1x + 70, c2x + 70);
    edges.push({
      key,
      ...group,
      path: `M ${sx} ${sy} C ${c1x} ${c1y} ${c2x} ${c2y} ${ex} ${ey}`,
      labelX,
      labelY,
      anchorX: anchor.x,
      anchorY: anchor.y,
    });
  }
  return {
    nodes,
    edges,
    width,
    height,
    statePage: states.index,
    rulePage: rules.index,
    statePages: states.pages,
    rulePages: rules.pages,
    visibleRules,
  };
}

/** Find the latest committed transition inside the visible cursor prefix for one participant. */
export function appliedDiagramRule(
  run: EngineView,
  participant: ParticipantId,
  protocol: ProtocolDefinition,
  eventCount = run.events.length,
): number | undefined {
  const reference = run.snapshot.configuration.protocols[participant];
  const source = run.snapshot.configuration.definitions.find(
    (item) => item.id === reference.id && item.revision === reference.revision,
  );
  if (!source || !diagramProtocolsMatch(source, protocol)) return undefined;
  const end = Number.isFinite(eventCount)
    ? Math.max(0, Math.min(Math.floor(eventCount), run.events.length))
    : 0;
  for (let index = end - 1; index >= 0; index--) {
    const event = run.events[index];
    if (
      event?.participant === participant &&
      event.kind === 'transition' &&
      event.ruleId !== undefined
    ) {
      const found = protocol.rules.findIndex((rule) => rule.id === event.ruleId);
      return found < 0 ? undefined : found;
    }
  }
  return undefined;
}

/** Resolve an editor destination only when a captured protocol exactly matches the current draft. */
export function matchingDiagramDefinition(
  draft: ExperimentDefinition,
  protocol: ProtocolDefinition,
): number | undefined {
  const index = draft.definitions.findIndex((item) => diagramProtocolsMatch(item, protocol));
  return index < 0 ? undefined : index;
}

/** Compare a draft and snapshot without relying on an ID/revision shared by independent experiments. */
export function diagramProtocolsMatch(
  left: ProtocolDefinition,
  right: ProtocolDefinition,
): boolean {
  return (
    left.id === right.id &&
    left.revision === right.revision &&
    (left === right || JSON.stringify(left) === JSON.stringify(right))
  );
}
