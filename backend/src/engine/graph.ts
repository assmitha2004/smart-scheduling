import type { EngineDependency } from './types.js';

/**
 * Dependency graph utilities. Edges point from prerequisite -> dependent
 * (finish-to-start): an edge B -> A means "A depends on B".
 */
export interface DependencyGraph {
  nodes: string[];
  /** prerequisite -> dependents */
  successors: Map<string, string[]>;
  /** dependent -> prerequisites */
  predecessors: Map<string, string[]>;
}

export function buildGraph(nodeIds: Iterable<string>, deps: EngineDependency[]): DependencyGraph {
  const nodes = [...new Set(nodeIds)];
  const successors = new Map<string, string[]>();
  const predecessors = new Map<string, string[]>();
  for (const n of nodes) {
    successors.set(n, []);
    predecessors.set(n, []);
  }
  for (const d of deps) {
    if (!successors.has(d.dependsOnTaskId) || !predecessors.has(d.taskId)) continue;
    successors.get(d.dependsOnTaskId)!.push(d.taskId);
    predecessors.get(d.taskId)!.push(d.dependsOnTaskId);
  }
  return { nodes, successors, predecessors };
}

/**
 * Finds a dependency cycle using iterative-safe DFS with white/grey/black
 * colouring. Returns the cycle as an ordered list of task ids where each
 * task depends on the next one, closing back on the first
 * (e.g. ["A", "B", "C", "A"] = A depends on B, B on C, C on A), or null.
 */
export function findCycle(nodeIds: Iterable<string>, deps: EngineDependency[]): string[] | null {
  const ids = new Set(nodeIds);
  for (const d of deps) {
    ids.add(d.taskId);
    ids.add(d.dependsOnTaskId);
  }
  // Walk "depends on" edges so the reported path reads naturally.
  const dependsOn = new Map<string, string[]>();
  for (const id of ids) dependsOn.set(id, []);
  for (const d of deps) dependsOn.get(d.taskId)!.push(d.dependsOnTaskId);

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string>();
  for (const id of ids) color.set(id, WHITE);

  for (const root of ids) {
    if (color.get(root) !== WHITE) continue;
    // Explicit stack avoids recursion limits on large graphs.
    const stack: { node: string; i: number }[] = [{ node: root, i: 0 }];
    color.set(root, GREY);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const next = dependsOn.get(frame.node)!;
      if (frame.i < next.length) {
        const child = next[frame.i++];
        const c = color.get(child);
        if (c === WHITE) {
          parent.set(child, frame.node);
          color.set(child, GREY);
          stack.push({ node: child, i: 0 });
        } else if (c === GREY) {
          // Back edge frame.node -> child closes a cycle. Walk parents from
          // frame.node back up to child, then reverse to read forwards.
          const path: string[] = [];
          let cur = frame.node;
          while (cur !== child) {
            path.push(cur);
            cur = parent.get(cur)!;
          }
          return [child, ...path.reverse(), child];
        }
      } else {
        color.set(frame.node, BLACK);
        stack.pop();
      }
    }
  }
  return null;
}

/** Would adding "taskId depends on dependsOnTaskId" create a cycle? */
export function cycleIfAdded(
  existing: EngineDependency[],
  taskId: string,
  dependsOnTaskId: string,
): string[] | null {
  if (taskId === dependsOnTaskId) return [taskId, taskId];
  return findCycle([], [...existing, { taskId, dependsOnTaskId }]);
}

export class CycleError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`Dependency cycle detected: ${cycle.join(' -> ')}`);
  }
}

/**
 * Kahn's algorithm. When several tasks are ready at once, `compare` breaks
 * ties (lower sorts first) so the order is deterministic.
 */
export function topologicalSort(
  nodeIds: Iterable<string>,
  deps: EngineDependency[],
  compare: (a: string, b: string) => number = (a, b) => (a < b ? -1 : a > b ? 1 : 0),
): string[] {
  const g = buildGraph(nodeIds, deps);
  const indegree = new Map<string, number>();
  for (const n of g.nodes) indegree.set(n, g.predecessors.get(n)!.length);
  const ready = g.nodes.filter((n) => indegree.get(n) === 0).sort(compare);
  const order: string[] = [];
  while (ready.length) {
    const n = ready.shift()!;
    order.push(n);
    let changed = false;
    for (const s of g.successors.get(n)!) {
      const d = indegree.get(s)! - 1;
      indegree.set(s, d);
      if (d === 0) {
        ready.push(s);
        changed = true;
      }
    }
    if (changed) ready.sort(compare);
  }
  if (order.length !== g.nodes.length) {
    throw new CycleError(findCycle(g.nodes, deps) ?? []);
  }
  return order;
}

/** All tasks transitively downstream of `taskIds` (excluding the inputs). */
export function descendants(taskIds: string[], deps: EngineDependency[]): Set<string> {
  const succ = new Map<string, string[]>();
  for (const d of deps) {
    if (!succ.has(d.dependsOnTaskId)) succ.set(d.dependsOnTaskId, []);
    succ.get(d.dependsOnTaskId)!.push(d.taskId);
  }
  const seen = new Set<string>();
  const queue = [...taskIds];
  while (queue.length) {
    const n = queue.shift()!;
    for (const s of succ.get(n) ?? []) {
      if (!seen.has(s)) {
        seen.add(s);
        queue.push(s);
      }
    }
  }
  for (const t of taskIds) seen.delete(t);
  return seen;
}

/** All tasks transitively upstream of `taskId` (excluding itself). */
export function ancestors(taskId: string, deps: EngineDependency[]): Set<string> {
  const pred = new Map<string, string[]>();
  for (const d of deps) {
    if (!pred.has(d.taskId)) pred.set(d.taskId, []);
    pred.get(d.taskId)!.push(d.dependsOnTaskId);
  }
  const seen = new Set<string>();
  const queue = [taskId];
  while (queue.length) {
    const n = queue.shift()!;
    for (const p of pred.get(n) ?? []) {
      if (!seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  seen.delete(taskId);
  return seen;
}
