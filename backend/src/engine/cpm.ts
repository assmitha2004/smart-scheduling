import type { EngineDependency, EngineTask } from './types.js';
import { remainingMinutes } from './types.js';
import { topologicalSort } from './graph.js';

export interface CpmNode {
  taskId: string;
  duration: number;
  earliestStart: number;
  earliestFinish: number;
  latestStart: number;
  latestFinish: number;
  slack: number;
  critical: boolean;
}

export interface CpmResult {
  /** Length of the longest dependency chain, in effort-minutes. */
  projectDuration: number;
  nodes: Map<string, CpmNode>;
  criticalTaskIds: Set<string>;
  /** One longest chain, ordered prerequisite-first. */
  criticalPath: string[];
}

/**
 * Critical Path Method on remaining effort (in minutes). Completed tasks
 * have zero duration so they never dominate the path.
 *
 * This measures effort-chains, not calendar time: it is a risk signal for
 * which tasks would push the project finish if they slip, not a guarantee
 * that other tasks have spare capacity.
 */
export function computeCriticalPath(tasks: EngineTask[], deps: EngineDependency[]): CpmResult {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const relevant = deps.filter((d) => byId.has(d.taskId) && byId.has(d.dependsOnTaskId));
  const order = topologicalSort(byId.keys(), relevant);

  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const id of byId.keys()) {
    preds.set(id, []);
    succs.set(id, []);
  }
  for (const d of relevant) {
    preds.get(d.taskId)!.push(d.dependsOnTaskId);
    succs.get(d.dependsOnTaskId)!.push(d.taskId);
  }

  const nodes = new Map<string, CpmNode>();
  // Forward pass.
  for (const id of order) {
    const duration = remainingMinutes(byId.get(id)!);
    const es = Math.max(0, ...preds.get(id)!.map((p) => nodes.get(p)!.earliestFinish));
    nodes.set(id, {
      taskId: id,
      duration,
      earliestStart: es,
      earliestFinish: es + duration,
      latestStart: 0,
      latestFinish: 0,
      slack: 0,
      critical: false,
    });
  }
  const projectDuration = Math.max(0, ...[...nodes.values()].map((n) => n.earliestFinish));

  // Backward pass.
  for (const id of [...order].reverse()) {
    const n = nodes.get(id)!;
    const s = succs.get(id)!;
    n.latestFinish = s.length ? Math.min(...s.map((x) => nodes.get(x)!.latestStart)) : projectDuration;
    n.latestStart = n.latestFinish - n.duration;
    n.slack = n.latestStart - n.earliestStart;
    n.critical = n.slack === 0 && n.duration > 0;
  }

  const criticalTaskIds = new Set([...nodes.values()].filter((n) => n.critical).map((n) => n.taskId));

  // Trace one concrete critical chain: start at a critical node with ES=0 and
  // follow critical successors whose ES equals our EF.
  const criticalPath: string[] = [];
  if (projectDuration > 0) {
    let cur = order.find((id) => {
      const n = nodes.get(id)!;
      return n.critical && n.earliestStart === 0;
    });
    while (cur) {
      criticalPath.push(cur);
      const ef = nodes.get(cur)!.earliestFinish;
      cur = succs
        .get(cur)!
        .filter((s) => nodes.get(s)!.critical && nodes.get(s)!.earliestStart === ef)
        .sort()[0];
    }
  }

  return { projectDuration, nodes, criticalTaskIds, criticalPath };
}
