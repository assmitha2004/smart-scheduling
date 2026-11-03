import { DateTime } from 'luxon';
import type {
  EngineDependency,
  EngineTask,
  Interval,
  ProposedBlock,
  ScheduleInput,
  ScheduleOptions,
  ScheduleResult,
  ScheduleWarning,
  TaskExplanation,
  TaskRanking,
  UnscheduledTask,
} from './types.js';
import { DAY, DEFAULT_OPTIONS, DEFAULT_WEIGHTS, MINUTE, isComplete, remainingMinutes } from './types.js';
import { ancestors, findCycle, topologicalSort } from './graph.js';
import { computeCriticalPath } from './cpm.js';
import { compareRankings, scoreTask } from './ranking.js';
import { computeFreeIntervals, expandAvailability } from './availability.js';
import { subtractIntervals, totalMinutes } from './intervals.js';

/** Short break inserted between consecutive focus blocks of the same task. */
const BREAK_BETWEEN_BLOCKS = 15 * MINUTE;
const SLOT_GRANULARITY = 5 * MINUTE;

export function resolveOptions(partial?: Partial<ScheduleOptions>): ScheduleOptions {
  return {
    ...DEFAULT_OPTIONS,
    ...partial,
    weights: { ...DEFAULT_WEIGHTS, ...(partial?.weights ?? {}) },
  };
}

export function formatInstant(ms: number, timezone: string): string {
  return DateTime.fromMillis(ms, { zone: timezone }).toFormat('ccc d LLL, HH:mm');
}

function emptyResult(now: number, horizonEnd: number): ScheduleResult {
  return {
    ok: false,
    proposedBlocks: [],
    unscheduledTasks: [],
    warnings: [],
    conflicts: [],
    explanations: [],
    criticalPath: [],
    summary: {
      availableMinutes: 0,
      scheduledMinutes: 0,
      remainingMinutes: 0,
      horizonStart: now,
      horizonEnd,
      projectedFinish: null,
    },
  };
}

/** Validates inputs. Returns human-readable problems (empty = valid). */
export function validateInput(tasks: EngineTask[], deps: EngineDependency[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) problems.push(`Duplicate task id ${t.id}`);
    ids.add(t.id);
    if (!Number.isFinite(t.estimatedMinutes) || t.estimatedMinutes < 0) {
      problems.push(`Task "${t.title}" has an invalid estimate`);
    }
    if (t.dueAt != null && t.earliestStartAt != null && t.dueAt < t.earliestStartAt) {
      problems.push(`Task "${t.title}" is due before its earliest start date`);
    }
  }
  for (const d of deps) {
    if (d.taskId === d.dependsOnTaskId) problems.push(`Task ${d.taskId} cannot depend on itself`);
  }
  return problems;
}

/**
 * Greedy, dependency-aware list scheduler (serial schedule-generation scheme):
 *
 *   1. validate input and reject dependency cycles
 *   2. compute the critical path and a transparent ranking score per task
 *   3. compute free intervals = working hours - fixed events - locked blocks
 *   4. repeatedly pick the highest-ranked task whose prerequisites are all
 *      complete or already placed, and place it at the earliest free time
 *      after every prerequisite finishes (splitting into focus blocks if allowed)
 *   5. report blocks, unscheduled tasks, deadline warnings and explanations
 *
 * It never places work outside availability: if a task does not fit in the
 * planning horizon it is reported as unscheduled rather than forced in.
 */
export function generateSchedule(input: ScheduleInput): ScheduleResult {
  const prep = prepare(input);
  if ('conflicts' in prep) return prep;
  let best = scheduleOnce(input, prep, new Map());
  // Deadline repair: if the greedy plan misses deadlines, try placing each
  // late task (and its prerequisites) first. Keep a change only when total
  // lateness strictly drops and no extra work becomes unscheduled.
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  let boosts = new Map<string, string>();
  const tried = new Set<string>();
  for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt++) {
    const late = best.warnings
      .filter((w) => w.code === 'DEADLINE_MISSED' && !tried.has(w.taskId))
      .map((w) => byId.get(w.taskId)!)
      .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
    if (!late.length) break;
    const target = late[0];
    tried.add(target.id);
    const next = new Map(boosts);
    for (const id of [target.id, ...ancestors(target.id, input.dependencies)]) {
      const t = byId.get(id);
      if (t && !isComplete(t) && !next.has(id)) next.set(id, target.title);
    }
    const candidate = scheduleOnce(input, prep, next);
    if (
      candidate.ok &&
      candidate.unscheduledTasks.length <= best.unscheduledTasks.length &&
      lateness(candidate, byId) < lateness(best, byId)
    ) {
      best = candidate;
      boosts = next;
    }
  }
  return best;
}

const MAX_REPAIR_ATTEMPTS = 6;

/** Total minutes by which planned finishes exceed due dates. */
function lateness(r: ScheduleResult, byId: Map<string, EngineTask>): number {
  const finish = new Map<string, number>();
  for (const b of r.proposedBlocks) finish.set(b.taskId, Math.max(finish.get(b.taskId) ?? -Infinity, b.endAt));
  let total = 0;
  for (const [id, f] of finish) {
    const due = byId.get(id)?.dueAt;
    if (due != null && f > due) total += (f - due) / MINUTE;
  }
  return total;
}

interface Prepared {
  opts: ScheduleOptions;
  horizonStart: number;
  horizonEnd: number;
  byId: Map<string, EngineTask>;
  prereqs: Map<string, string[]>;
  succ: Map<string, string[]>;
  cpm: ReturnType<typeof computeCriticalPath>;
  rankings: Map<string, TaskRanking>;
  /** Free time before any placement (working hours minus events), and its total. */
  working: Interval[];
}

/**
 * Everything that does not depend on placement order: validation, cycle
 * check, critical path, ranking and capacity. Computed once per request.
 */
function prepare(input: ScheduleInput): Prepared | ScheduleResult {
  const opts = resolveOptions(input.options);
  const horizonStart = Math.ceil(input.now / SLOT_GRANULARITY) * SLOT_GRANULARITY;
  const horizonEnd = horizonStart + opts.horizonDays * DAY;

  const problems = validateInput(input.tasks, input.dependencies);
  if (problems.length) {
    const result = emptyResult(horizonStart, horizonEnd);
    result.conflicts.push({ code: 'INVALID_INPUT', message: problems.join('; '), details: problems });
    return result;
  }

  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const deps = input.dependencies.filter((d) => byId.has(d.taskId) && byId.has(d.dependsOnTaskId));
  const cycle = findCycle(byId.keys(), deps);
  if (cycle) {
    const result = emptyResult(horizonStart, horizonEnd);
    const names = cycle.map((id) => byId.get(id)?.title ?? id);
    result.conflicts.push({
      code: 'DEPENDENCY_CYCLE',
      message: `Dependency cycle: ${names.join(' → ')}. Remove one of these links to continue.`,
      details: cycle,
    });
    return result;
  }

  const prereqs = new Map<string, string[]>();
  const succ = new Map<string, string[]>();
  for (const t of input.tasks) {
    prereqs.set(t.id, []);
    succ.set(t.id, []);
  }
  for (const d of deps) {
    prereqs.get(d.taskId)!.push(d.dependsOnTaskId);
    succ.get(d.dependsOnTaskId)!.push(d.taskId);
  }

  const cpm = computeCriticalPath(input.tasks, deps);
  const order = topologicalSort(byId.keys(), deps);

  // Reverse-topological pass computes, per task, (a) the set of incomplete
  // tasks downstream of it and (b) the earliest deadline among them, so
  // prerequisites of urgent tasks are not starved by unrelated work.
  const downstream = new Map<string, Set<string>>();
  const inheritedDue = new Map<string, { dueAt: number; fromTitle: string }>();
  for (const id of [...order].reverse()) {
    const set = new Set<string>();
    let best: { dueAt: number; fromTitle: string } | undefined;
    for (const sId of succ.get(id)!) {
      const st = byId.get(sId)!;
      for (const x of downstream.get(sId)!) set.add(x);
      if (isComplete(st)) continue;
      set.add(sId);
      const cands = [inheritedDue.get(sId), st.dueAt != null ? { dueAt: st.dueAt, fromTitle: st.title } : undefined];
      for (const c of cands) if (c && (!best || c.dueAt < best.dueAt)) best = c;
    }
    downstream.set(id, set);
    if (best) inheritedDue.set(id, best);
  }
  const downstreamCounts = new Map([...downstream].map(([id, set]) => [id, set.size]));

  const rankings = new Map<string, TaskRanking>();
  for (const t of input.tasks) {
    if (isComplete(t)) continue;
    rankings.set(
      t.id,
      scoreTask(t, {
        now: input.now,
        criticalTaskIds: cpm.criticalTaskIds,
        downstreamCounts,
        weights: opts.weights,
        inheritedDue,
      }),
    );
  }

  const working = computeFreeIntervals({
    rules: input.availability,
    timezone: input.timezone,
    from: horizonStart,
    to: horizonEnd,
    events: input.events,
  });
  return { opts, horizonStart, horizonEnd, byId, prereqs, succ, cpm, rankings, working };
}

/**
 * One greedy placement pass. `boosts` maps taskIds that must be placed
 * before all others (deadline repair) to the deadline task that required it.
 */
function scheduleOnce(input: ScheduleInput, prep: Prepared, boosts: Map<string, string>): ScheduleResult {
  const { opts, horizonStart, horizonEnd, byId, prereqs, succ, cpm, rankings, working } = prep;
  const tz = input.timezone;
  const result = emptyResult(horizonStart, horizonEnd);

  // Capacity.
  const locked = (input.lockedBlocks ?? []).filter((b) => byId.has(b.taskId));
  let free: Interval[] = subtractIntervals(
    working,
    locked.map((b) => ({ start: b.start, end: b.end })),
  );
  result.summary.availableMinutes = totalMinutes(working);

  const finish = new Map<string, number>(); // placed or completed tasks
  const failed = new Set<string>();
  const blocks: ProposedBlock[] = [];
  const warnings: ScheduleWarning[] = [];
  const unscheduled: UnscheduledTask[] = [];
  const explanations: TaskExplanation[] = [];
  const earliestPossible = new Map<string, number>();

  for (const t of input.tasks) if (isComplete(t)) finish.set(t.id, -Infinity);

  // Locked tasks keep their existing blocks unchanged.
  const lockedByTask = new Map<string, ProposedBlock[]>();
  for (const b of locked) {
    if (!lockedByTask.has(b.taskId)) lockedByTask.set(b.taskId, []);
    lockedByTask.get(b.taskId)!.push({ taskId: b.taskId, startAt: b.start, endAt: b.end, locked: true });
  }
  // Lock in deterministic (rank) order so explanations are stable.
  const lockedOrder = [...lockedByTask.keys()].sort((a, b) =>
    Math.min(...lockedByTask.get(a)!.map((x) => x.startAt)) - Math.min(...lockedByTask.get(b)!.map((x) => x.startAt)));
  let rank = 0;
  for (const taskId of lockedOrder) {
    if (finish.has(taskId)) continue;
    const bs = lockedByTask.get(taskId)!;
    blocks.push(...bs);
    const end = Math.max(...bs.map((b) => b.endAt));
    finish.set(taskId, end);
    const task = byId.get(taskId)!;
    const ranking = rankings.get(taskId);
    const reasons = [...(ranking?.reasons ?? []), 'already on your calendar (kept in place)'];
    if (task.dueAt != null && end > task.dueAt && task.dueAt >= input.now) {
      warnings.push({ taskId, code: 'DEADLINE_MISSED', reason: `"${task.title}" is planned to finish ${formatInstant(end, tz)}, after its deadline (${formatInstant(task.dueAt, tz)}).` });
    }
    explanations.push({
      taskId, title: task.title, rank: ++rank, score: ranking?.score ?? 0,
      earliestPossibleStart: Math.min(...bs.map((b) => b.startAt)), plannedStart: Math.min(...bs.map((b) => b.startAt)), plannedFinish: end,
      onCriticalPath: cpm.criticalTaskIds.has(taskId), reasons,
    });
  }

  const pending = new Set(
    input.tasks.filter((t) => !isComplete(t) && !finish.has(t.id)).map((t) => t.id),
  );
  // Incremental ready set: a task becomes ready once all prerequisites are
  // complete, placed or failed (O(n²) overall instead of re-scanning + sorting).
  const remaining = new Map<string, number>();
  const ready: string[] = [];
  for (const id of pending) {
    const n = prereqs.get(id)!.filter((p) => !finish.has(p)).length;
    remaining.set(id, n);
    if (!n) ready.push(id);
  }
  const settle = (id: string) => {
    for (const sId of succ.get(id)!) {
      if (!pending.has(sId)) continue;
      const n = remaining.get(sId)! - 1;
      remaining.set(sId, n);
      if (!n) ready.push(sId);
    }
  };
  const better = (a: string, b: string) =>
    (Number(boosts.has(b)) - Number(boosts.has(a)) || compareRankings(rankings.get(a)!, rankings.get(b)!, byId)) < 0;

  while (ready.length) {
    let bi = 0;
    for (let i = 1; i < ready.length; i++) if (better(ready[i], ready[bi])) bi = i;
    const id = ready[bi];
    ready.splice(bi, 1);
    pending.delete(id);

    // A task whose prerequisite could not be scheduled cannot be scheduled either.
    const badPrereq = prereqs.get(id)!.find((p) => failed.has(p));
    if (badPrereq) {
      failed.add(id);
      unscheduled.push({
        taskId: id,
        code: 'PREREQUISITE_UNSCHEDULED',
        reason: `Waiting on "${byId.get(badPrereq)!.title}", which could not be scheduled in the planning window.`,
      });
      settle(id);
      continue;
    }
    const task = byId.get(id)!;
    const ranking = rankings.get(id)!;
    const reasons = [...ranking.reasons];
    if (boosts.has(id)) reasons.push(`moved earlier so "${boosts.get(id)}" can meet its deadline`);

    const unplannedExternal = (task.externalPrereqs ?? []).find((e) => e.readyAt == null);
    if (unplannedExternal) {
      failed.add(id);
      unscheduled.push({
        taskId: id,
        code: 'PREREQUISITE_UNSCHEDULED',
        reason: `Waiting on "${unplannedExternal.title}" (owned by someone else), which has no planned finish yet.`,
      });
      explanations.push({
        taskId: id, title: task.title, rank: ++rank, score: ranking.score,
        earliestPossibleStart: horizonStart, plannedStart: null, plannedFinish: null,
        onCriticalPath: cpm.criticalTaskIds.has(id), reasons,
      });
      settle(id);
      continue;
    }
    const externalReady = Math.max(-Infinity, ...(task.externalPrereqs ?? []).map((e) => e.readyAt!));
    const prereqFinish = Math.max(-Infinity, ...prereqs.get(id)!.map((p) => finish.get(p)!));
    const est = Math.max(horizonStart, task.earliestStartAt ?? -Infinity, prereqFinish, externalReady);
    if (externalReady > horizonStart && externalReady >= prereqFinish) {
      const ext = task.externalPrereqs!.find((e) => e.readyAt === externalReady)!;
      reasons.push(`waits for "${ext.title}" (owned by someone else, planned to finish ${formatInstant(externalReady, tz)})`);
    }
    earliestPossible.set(id, est);
    const latePrereq = prereqs
      .get(id)!
      .filter((p) => finish.get(p)! > -Infinity)
      .sort((a, b) => finish.get(b)! - finish.get(a)!)[0];
    if (latePrereq && finish.get(latePrereq)! >= est) {
      reasons.push(
        `waits for "${byId.get(latePrereq)!.title}" (planned to finish ${formatInstant(finish.get(latePrereq)!, tz)})`,
      );
    }
    if (task.earliestStartAt != null && task.earliestStartAt >= est && task.earliestStartAt > horizonStart) {
      reasons.push(`cannot start before ${formatInstant(task.earliestStartAt, tz)}`);
    }
    if (task.dueAt != null && task.dueAt < input.now) {
      warnings.push({ taskId: id, code: 'PAST_DUE', reason: `"${task.title}" is already past its due date.` });
    }

    const need = remainingMinutes(task) * MINUTE;
    if (need === 0) {
      warnings.push({ taskId: id, code: 'NO_ESTIMATE', reason: `"${task.title}" has no time estimate; add one so it can be scheduled.` });
      finish.set(id, est);
      explanations.push({
        taskId: id, title: task.title, rank: ++rank, score: ranking.score,
        earliestPossibleStart: est, plannedStart: null, plannedFinish: null,
        onCriticalPath: cpm.criticalTaskIds.has(id), reasons,
      });
      settle(id);
      continue;
    }

    const splittable = opts.allowSplitting && task.splittable !== false;
    const placed = splittable
      ? placeSplit(free, est, need, opts.minBlockMinutes * MINUTE, opts.maxBlockMinutes * MINUTE)
      : placeContiguous(free, est, need);

    if (!placed) {
      failed.add(id);
      const capacity = totalMinutes(free.filter((f) => f.end > est).map((f) => ({ start: Math.max(f.start, est), end: f.end })));
      unscheduled.push(
        splittable || capacity * MINUTE < need
          ? {
              taskId: id,
              code: 'INSUFFICIENT_CAPACITY',
              reason: `Needs ${Math.round(need / MINUTE)} min but only ${capacity} min of free time remain in the ${opts.horizonDays}-day planning window after its earliest start.`,
            }
          : {
              taskId: id,
              code: 'NO_CONTIGUOUS_SLOT',
              reason: `Needs one uninterrupted ${Math.round(need / MINUTE)} min block and none is available. Allow splitting or free up a longer slot.`,
            },
      );
      explanations.push({
        taskId: id, title: task.title, rank: ++rank, score: ranking.score,
        earliestPossibleStart: est, plannedStart: null, plannedFinish: null,
        onCriticalPath: cpm.criticalTaskIds.has(id), reasons,
      });
      settle(id);
      continue;
    }

    free = subtractIntervals(free, placed);
    for (const p of placed) blocks.push({ taskId: id, startAt: p.start, endAt: p.end });
    const end = placed[placed.length - 1].end;
    finish.set(id, end);
    if (placed.length > 1) reasons.push(`split into ${placed.length} focus blocks`);

    if (task.dueAt != null && end > task.dueAt && task.dueAt >= input.now) {
      const lateHours = Math.round(((end - task.dueAt) / 3_600_000) * 10) / 10;
      warnings.push({
        taskId: id,
        code: 'DEADLINE_MISSED',
        reason: `"${task.title}" is planned to finish ${formatInstant(end, tz)}, ${lateHours}h after its deadline (${formatInstant(task.dueAt, tz)}).`,
      });
      reasons.push('at risk: projected to finish after its deadline');
    }

    explanations.push({
      taskId: id, title: task.title, rank: ++rank, score: ranking.score,
      earliestPossibleStart: est, plannedStart: placed[0].start, plannedFinish: end,
      onCriticalPath: cpm.criticalTaskIds.has(id), reasons,
    });
    settle(id);
  }

  blocks.sort((a, b) => a.startAt - b.startAt || (a.taskId < b.taskId ? -1 : 1));
  const scheduledMinutes = Math.round(blocks.reduce((s, b) => s + (b.endAt - b.startAt), 0) / MINUTE);
  const finishes = blocks.map((b) => b.endAt);

  result.ok = true;
  result.proposedBlocks = blocks;
  result.unscheduledTasks = unscheduled;
  result.warnings = warnings;
  result.explanations = explanations;
  result.criticalPath = cpm.criticalPath;
  result.summary.scheduledMinutes = scheduledMinutes;
  result.summary.remainingMinutes = Math.max(0, result.summary.availableMinutes - scheduledMinutes);
  result.summary.projectedFinish = finishes.length ? Math.max(...finishes) : null;
  return result;
}

/** First free slot at/after `from` that fits `need` contiguously. */
function placeContiguous(free: Interval[], from: number, need: number): Interval[] | null {
  for (const iv of free) {
    const s = Math.max(iv.start, from);
    if (iv.end - s >= need) return [{ start: s, end: s + need }];
  }
  return null;
}

/**
 * Fills free time from `from` onwards in focus blocks of at most `maxBlock`,
 * never creating a fragment shorter than `minBlock` (unless that is all the
 * task still needs). Returns null if the task cannot be fully placed.
 */
function placeSplit(
  free: Interval[],
  from: number,
  need: number,
  minBlock: number,
  maxBlock: number,
): Interval[] | null {
  const out: Interval[] = [];
  let left = need;
  for (const iv of free) {
    let s = Math.max(iv.start, from);
    while (left > 0 && iv.end - s > 0) {
      const avail = iv.end - s;
      let take = Math.min(left, avail, maxBlock);
      const remainder = left - take;
      // Avoid leaving a tiny tail for later: shrink this block so the tail is >= minBlock.
      if (remainder > 0 && remainder < minBlock && take - (minBlock - remainder) >= minBlock) {
        take -= minBlock - remainder;
      }
      if (take < minBlock && take < left) break; // fragment too small to be useful
      out.push({ start: s, end: s + take });
      left -= take;
      s += take + BREAK_BETWEEN_BLOCKS;
    }
    if (left <= 0) return out;
  }
  return null;
}

/** Capacity (free minutes) between two instants, ignoring task placement. */
export function capacityBetween(
  input: Pick<ScheduleInput, 'availability' | 'events' | 'timezone'>,
  from: number,
  to: number,
): number {
  if (to <= from) return 0;
  const working = expandAvailability(input.availability, input.timezone, from, to);
  return totalMinutes(
    subtractIntervals(working, input.events.map((e) => ({ start: e.start, end: e.end }))),
  );
}
