import { DateTime } from 'luxon';
import type { EngineTask, ScheduleInput, ScheduleResult } from './types.js';
import { DAY, isComplete, remainingMinutes } from './types.js';
import { ancestors } from './graph.js';
import { computeCriticalPath } from './cpm.js';
import { capacityBetween, formatInstant } from './scheduler.js';

export type RiskStatus = 'ON_TRACK' | 'AT_RISK' | 'INFEASIBLE' | 'OVERDUE' | 'DONE';

export interface DeadlineTarget {
  /** Task id, or project id for a project target date. */
  id: string;
  kind: 'task' | 'project';
  title: string;
  dueAt: number;
  /** Tasks whose completion the deadline depends on (their ancestors are added automatically). */
  taskIds: string[];
}

export interface Recommendation {
  type: 'REDUCE_SCOPE' | 'MOVE_DEADLINE' | 'ADD_CAPACITY' | 'START_EARLIER' | 'RESOLVE_BLOCKER';
  message: string;
  value?: number | string;
}

export interface DeadlineRisk {
  id: string;
  kind: 'task' | 'project';
  title: string;
  dueAt: number;
  status: RiskStatus;
  requiredMinutes: number;
  availableMinutes: number;
  shortfallMinutes: number;
  /** required / available (Infinity when no capacity). */
  utilization: number | null;
  plannedFinish: number | null;
  contributors: { taskId: string; title: string; remainingMinutes: number; onCriticalPath: boolean }[];
  recommendations: Recommendation[];
  assumptions: string[];
  explanation: string;
}

const AT_RISK_UTILIZATION = 0.8;

/**
 * Deterministic deadline feasibility:
 *   required  = remaining effort of the target's tasks + all incomplete prerequisites
 *   available = free working minutes between now and the deadline
 * A target is INFEASIBLE when required > available, AT_RISK when the plan
 * finishes late or utilisation exceeds 80%, otherwise ON_TRACK.
 */
export function analyzeDeadline(
  input: ScheduleInput,
  target: DeadlineTarget,
  schedule?: ScheduleResult,
): DeadlineRisk {
  const tz = input.timezone;
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const work = new Set<string>();
  for (const id of target.taskIds) {
    if (!byId.has(id)) continue;
    work.add(id);
    for (const a of ancestors(id, input.dependencies)) if (byId.has(a)) work.add(a);
  }
  const open = [...work].map((id) => byId.get(id)!).filter((t) => !isComplete(t));
  const requiredMinutes = open.reduce((s, t) => s + remainingMinutes(t), 0);
  const availableMinutes = capacityBetween(input, input.now, target.dueAt);
  const shortfallMinutes = Math.max(0, requiredMinutes - availableMinutes);
  const utilization = availableMinutes > 0 ? requiredMinutes / availableMinutes : requiredMinutes > 0 ? null : 0;

  let plannedFinish: number | null = null;
  let anyUnscheduled = false;
  if (schedule) {
    for (const t of open) {
      const bs = schedule.proposedBlocks.filter((b) => b.taskId === t.id);
      if (bs.length) plannedFinish = Math.max(plannedFinish ?? -Infinity, ...bs.map((b) => b.endAt));
      if (schedule.unscheduledTasks.some((u) => u.taskId === t.id)) anyUnscheduled = true;
    }
  }

  let critical = new Set<string>();
  try {
    critical = computeCriticalPath(input.tasks.filter((t) => work.has(t.id)), input.dependencies).criticalTaskIds;
  } catch {
    /* cycles are reported elsewhere */
  }
  const contributors = open
    .map((t) => ({
      taskId: t.id,
      title: t.title,
      remainingMinutes: remainingMinutes(t),
      onCriticalPath: critical.has(t.id),
    }))
    .sort((a, b) => Number(b.onCriticalPath) - Number(a.onCriticalPath) || b.remainingMinutes - a.remainingMinutes)
    .slice(0, 5);

  let status: RiskStatus;
  if (!open.length) status = 'DONE';
  else if (target.dueAt <= input.now) status = 'OVERDUE';
  else if (requiredMinutes > availableMinutes) status = 'INFEASIBLE';
  else if (
    anyUnscheduled ||
    (plannedFinish != null && plannedFinish > target.dueAt) ||
    (utilization != null && utilization > AT_RISK_UTILIZATION)
  )
    status = 'AT_RISK';
  else status = 'ON_TRACK';

  const recommendations: Recommendation[] = [];
  if (status === 'INFEASIBLE' || status === 'AT_RISK' || status === 'OVERDUE') {
    const gap = Math.max(shortfallMinutes, plannedFinish != null && plannedFinish > target.dueAt ? 1 : 0);
    if (shortfallMinutes > 0) {
      const biggest = contributors[0];
      recommendations.push({
        type: 'REDUCE_SCOPE',
        message: `Cut about ${fmtMinutes(shortfallMinutes)} of work${biggest ? ` — "${biggest.title}" is the largest remaining item (${fmtMinutes(biggest.remainingMinutes)})` : ''}.`,
        value: shortfallMinutes,
      });
    }
    const newDate = earliestFeasibleDate(input, requiredMinutes);
    if (newDate != null && newDate > target.dueAt) {
      recommendations.push({
        type: 'MOVE_DEADLINE',
        message: `With current availability the work fits by ${formatInstant(newDate, tz)}. Consider moving the deadline there.`,
        value: new Date(newDate).toISOString(),
      });
    }
    const workingDays = countWorkingDays(input, input.now, Math.max(target.dueAt, input.now));
    if (shortfallMinutes > 0 && workingDays > 0) {
      const perDay = Math.ceil(shortfallMinutes / workingDays);
      recommendations.push({
        type: 'ADD_CAPACITY',
        message: `Add roughly ${fmtMinutes(perDay)} of focus time on each of the ${workingDays} remaining working day(s), or bring in help.`,
        value: perDay,
      });
    }
    const delayed = open.filter((t) => t.earliestStartAt != null && t.earliestStartAt > input.now);
    if (delayed.length) {
      recommendations.push({
        type: 'START_EARLIER',
        message: `Start ${delayed.map((t) => `"${t.title}"`).join(', ')} earlier — ${delayed.length > 1 ? 'they are' : 'it is'} held back by an earliest-start date.`,
      });
    }
    if (gap > 0 && !recommendations.length) {
      recommendations.push({
        type: 'START_EARLIER',
        message: 'Competing work is pushing this past its deadline. Raise its priority or start it earlier.',
      });
    }
  }

  const assumptions = [
    'Capacity = your working hours minus fixed events, breaks and unavailable periods.',
    'Remaining effort = estimate minus time already logged, taken as given.',
    `Capacity is not reserved for this deadline: other work competes for it${schedule ? ', which the planned finish reflects' : ''}.`,
    'This is an estimate, not a guarantee.',
  ];

  const explanation =
    status === 'DONE'
      ? `All work for "${target.title}" is complete.`
      : `"${target.title}" needs ${fmtMinutes(requiredMinutes)} of remaining work (including prerequisites) and you have ${fmtMinutes(availableMinutes)} of free working time before ${formatInstant(target.dueAt, tz)}` +
        (status === 'INFEASIBLE'
          ? ` — a shortfall of ${fmtMinutes(shortfallMinutes)}.`
          : status === 'OVERDUE'
            ? ' — the deadline has already passed.'
            : status === 'AT_RISK'
              ? plannedFinish != null && plannedFinish > target.dueAt
                ? `, but the current plan finishes ${formatInstant(plannedFinish, tz)} because of competing work.`
                : anyUnscheduled
                  ? ', but part of the work could not be placed in the current plan.'
                  : `, using ${Math.round((utilization ?? 0) * 100)}% of it, which leaves little slack.`
              : '.');

  return {
    id: target.id,
    kind: target.kind,
    title: target.title,
    dueAt: target.dueAt,
    status,
    requiredMinutes,
    availableMinutes,
    shortfallMinutes,
    utilization: utilization == null ? null : Math.round(utilization * 100) / 100,
    plannedFinish,
    contributors,
    recommendations,
    assumptions,
    explanation,
  };
}

/** Earliest instant by which `requiredMinutes` of free capacity exist (scans up to 180 days). */
export function earliestFeasibleDate(
  input: Pick<ScheduleInput, 'availability' | 'events' | 'timezone' | 'now'>,
  requiredMinutes: number,
): number | null {
  if (requiredMinutes <= 0) return input.now;
  let day = DateTime.fromMillis(input.now, { zone: input.timezone }).endOf('day');
  for (let i = 0; i < 180; i++) {
    const cap = capacityBetween(input, input.now, day.toMillis());
    if (cap >= requiredMinutes) return day.toMillis();
    day = day.plus({ days: 1 });
  }
  return null;
}

function countWorkingDays(input: Pick<ScheduleInput, 'availability' | 'events' | 'timezone'>, from: number, to: number): number {
  let n = 0;
  for (let t = from; t < to; t += DAY) {
    if (capacityBetween(input, t, Math.min(to, t + DAY)) > 0) n++;
  }
  return n;
}

export function fmtMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  if (!h) return `${r} min`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

/** Builds deadline targets for every open task with a due date and every project with a target date. */
export function deadlineTargets(
  tasks: EngineTask[],
  projects: { id: string; name: string; targetDate: number | null }[],
): DeadlineTarget[] {
  const out: DeadlineTarget[] = [];
  for (const t of tasks) {
    if (t.dueAt != null && !isComplete(t)) {
      out.push({ id: t.id, kind: 'task', title: t.title, dueAt: t.dueAt, taskIds: [t.id] });
    }
  }
  for (const p of projects) {
    if (p.targetDate == null) continue;
    const ids = tasks.filter((t) => t.projectId === p.id).map((t) => t.id);
    if (ids.length) out.push({ id: p.id, kind: 'project', title: p.name, dueAt: p.targetDate, taskIds: ids });
  }
  return out;
}
