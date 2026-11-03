import type { EngineTask, RankingWeights, TaskRanking } from './types.js';
import { DAY, DEFAULT_WEIGHTS } from './types.js';

export interface RankingContext {
  now: number;
  criticalTaskIds: Set<string>;
  /** taskId -> number of incomplete tasks transitively waiting on it */
  downstreamCounts: Map<string, number>;
  weights?: RankingWeights;
  /**
   * Deadline inherited from downstream work: a prerequisite is as urgent as
   * the earliest deadline of anything waiting on it.
   */
  inheritedDue?: Map<string, { dueAt: number; fromTitle: string }>;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Transparent, configurable ranking heuristic:
 *   score = priority + urgency + criticalPathBonus + blockerImpact + age
 * Every factor is returned separately with a human-readable reason so the
 * UI can explain the ranking.
 */
export function scoreTask(task: EngineTask, ctx: RankingContext): TaskRanking {
  const w = ctx.weights ?? DEFAULT_WEIGHTS;
  const reasons: string[] = [];

  const priority = w.priority[task.priority];
  reasons.push(`${task.priority.toLowerCase()} priority (+${priority})`);

  let urgency = 0;
  const inherited = ctx.inheritedDue?.get(task.id);
  const useInherited = inherited != null && (task.dueAt == null || inherited.dueAt < task.dueAt);
  const effectiveDue = useInherited ? inherited!.dueAt : task.dueAt;
  if (effectiveDue != null) {
    const daysLeft = (effectiveDue - ctx.now) / DAY;
    const what = useInherited ? `needed for "${inherited!.fromTitle}", due` : 'due';
    if (daysLeft <= 0) {
      urgency = w.urgency;
      reasons.push(useInherited ? `${what} already (+${w.urgency})` : `overdue (+${w.urgency})`);
    } else if (daysLeft < w.urgencyHorizonDays) {
      // Linear ramp: full weight at the deadline, zero at the horizon.
      urgency = round1(w.urgency * (1 - daysLeft / w.urgencyHorizonDays));
      reasons.push(`${what} in ${daysLeft < 1 ? '<1' : Math.floor(daysLeft)} day(s) (+${urgency})`);
    }
  }

  const criticalPath = ctx.criticalTaskIds.has(task.id) ? w.criticalPathBonus : 0;
  if (criticalPath) reasons.push(`on the critical path (+${criticalPath})`);

  const downstream = ctx.downstreamCounts.get(task.id) ?? 0;
  const blockerImpact = Math.min(w.blockerImpactCap, downstream * w.blockerImpactPerTask);
  if (blockerImpact) reasons.push(`blocks ${downstream} downstream task(s) (+${blockerImpact})`);

  let age = 0;
  if (task.createdAt != null) {
    age = round1(Math.min(w.ageCap, Math.max(0, (ctx.now - task.createdAt) / DAY) * w.agePerDay));
    if (age >= 1) reasons.push(`waiting ${Math.floor((ctx.now - task.createdAt) / DAY)} day(s) (+${age})`);
  }

  return {
    taskId: task.id,
    score: round1(priority + urgency + criticalPath + blockerImpact + age),
    factors: { priority, urgency, criticalPath, blockerImpact, age },
    reasons,
  };
}

/** Deterministic comparator: higher score first, then earlier due date, then id. */
export function compareRankings(
  a: TaskRanking,
  b: TaskRanking,
  tasks: Map<string, EngineTask>,
): number {
  if (b.score !== a.score) return b.score - a.score;
  const da = tasks.get(a.taskId)?.dueAt ?? Infinity;
  const db = tasks.get(b.taskId)?.dueAt ?? Infinity;
  if (da !== db) return da - db;
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
}
