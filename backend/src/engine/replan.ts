import type { ExistingBlock, ProposedBlock, ScheduleInput, ScheduleResult } from './types.js';
import { isComplete } from './types.js';
import { descendants } from './graph.js';
import { generateSchedule } from './scheduler.js';

export interface BlockDiffEntry {
  taskId: string;
  title: string;
  change: 'MOVED' | 'ADDED' | 'REMOVED' | 'UNCHANGED';
  before: { startAt: number; endAt: number }[];
  after: { startAt: number; endAt: number }[];
  /** Change in planned finish, minutes (positive = later). */
  finishShiftMinutes: number | null;
}

export interface ReplanResult {
  changedTaskIds: string[];
  affectedTaskIds: string[];
  /** Ordered chain(s) of impact, e.g. ["DB schema", "Backend APIs", "Integration testing"]. */
  impactChain: string[];
  schedule: ScheduleResult;
  diff: BlockDiffEntry[];
  impact: {
    previousFinish: number | null;
    newFinish: number | null;
    shiftMinutes: number | null;
    byProject: { projectId: string; previousFinish: number | null; newFinish: number | null }[];
  };
}

/**
 * Re-plans after tasks change (delay, new estimate, priority, availability).
 *
 * Only the changed tasks and their downstream dependents are rescheduled;
 * every other future block is locked in place so unaffected work does not
 * move. Fixed calendar events are never touched. The result is a preview —
 * nothing is persisted until the user approves it.
 */
export function replan(params: {
  input: ScheduleInput;
  previousBlocks: ExistingBlock[];
  changedTaskIds: string[];
  /** Replan everything (e.g. availability changed). */
  full?: boolean;
}): ReplanResult {
  const { input, previousBlocks } = params;
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const changed = params.full
    ? input.tasks.filter((t) => !isComplete(t)).map((t) => t.id)
    : params.changedTaskIds.filter((id) => byId.has(id));
  const affected = new Set<string>([...changed, ...descendants(changed, input.dependencies)]);
  for (const id of [...affected]) if (isComplete(byId.get(id)!)) affected.delete(id);

  const future = previousBlocks.filter((b) => b.end > input.now && byId.has(b.taskId));
  const locked = future.filter((b) => !affected.has(b.taskId) && !isComplete(byId.get(b.taskId)!));

  const schedule = generateSchedule({ ...input, lockedBlocks: locked });

  const beforeBy = groupBlocks(future.map((b) => ({ taskId: b.taskId, startAt: b.start, endAt: b.end })));
  const afterBy = groupBlocks(schedule.proposedBlocks);
  const diff: BlockDiffEntry[] = [];
  for (const taskId of new Set([...beforeBy.keys(), ...afterBy.keys()])) {
    const before = beforeBy.get(taskId) ?? [];
    const after = afterBy.get(taskId) ?? [];
    const same =
      before.length === after.length &&
      before.every((b, i) => b.startAt === after[i].startAt && b.endAt === after[i].endAt);
    const bf = before.length ? before[before.length - 1].endAt : null;
    const af = after.length ? after[after.length - 1].endAt : null;
    diff.push({
      taskId,
      title: byId.get(taskId)?.title ?? taskId,
      change: same ? 'UNCHANGED' : !before.length ? 'ADDED' : !after.length ? 'REMOVED' : 'MOVED',
      before,
      after,
      finishShiftMinutes: bf != null && af != null ? Math.round((af - bf) / 60_000) : null,
    });
  }
  diff.sort((a, b) => order(a.change) - order(b.change) || a.title.localeCompare(b.title));

  const lastEnd = (bs: { endAt: number }[]) => (bs.length ? Math.max(...bs.map((b) => b.endAt)) : null);
  const prevAll = lastEnd([...beforeBy.values()].flat());
  const newAll = schedule.summary.projectedFinish;
  const projectIds = new Set(input.tasks.map((t) => t.projectId).filter((p): p is string => !!p));
  const byProject = [...projectIds].map((projectId) => {
    const ids = new Set(input.tasks.filter((t) => t.projectId === projectId).map((t) => t.id));
    return {
      projectId,
      previousFinish: lastEnd([...beforeBy.entries()].filter(([id]) => ids.has(id)).flatMap(([, b]) => b)),
      newFinish: lastEnd(schedule.proposedBlocks.filter((b) => ids.has(b.taskId))),
    };
  });

  // Impact chain: affected tasks in schedule (dependency) order.
  const rankOf = new Map(schedule.explanations.map((e) => [e.taskId, e.rank]));
  const impactChain = [...affected]
    .sort((a, b) => (rankOf.get(a) ?? 1e9) - (rankOf.get(b) ?? 1e9))
    .map((id) => byId.get(id)!.title);

  return {
    changedTaskIds: changed,
    affectedTaskIds: [...affected],
    impactChain,
    schedule,
    diff,
    impact: {
      previousFinish: prevAll,
      newFinish: newAll,
      shiftMinutes: prevAll != null && newAll != null ? Math.round((newAll - prevAll) / 60_000) : null,
      byProject,
    },
  };
}

function order(c: BlockDiffEntry['change']): number {
  return { MOVED: 0, ADDED: 1, REMOVED: 2, UNCHANGED: 3 }[c];
}

function groupBlocks(blocks: ProposedBlock[]): Map<string, { startAt: number; endAt: number }[]> {
  const m = new Map<string, { startAt: number; endAt: number }[]>();
  for (const b of blocks) {
    if (!m.has(b.taskId)) m.set(b.taskId, []);
    m.get(b.taskId)!.push({ startAt: b.startAt, endAt: b.endAt });
  }
  for (const v of m.values()) v.sort((a, b) => a.startAt - b.startAt);
  return m;
}
