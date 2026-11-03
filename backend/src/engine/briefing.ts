import { DateTime } from 'luxon';
import type { ScheduleInput, ScheduleResult } from './types.js';
import { DAY, isComplete, remainingMinutes } from './types.js';
import { capacityBetween, formatInstant } from './scheduler.js';
import type { DeadlineRisk } from './feasibility.js';
import { fmtMinutes } from './feasibility.js';

export interface DailyBriefing {
  date: string;
  timezone: string;
  generatedAt: string;
  suggestedFirstTask: { taskId: string; title: string; why: string } | null;
  topTasks: {
    taskId: string;
    title: string;
    score: number;
    reasons: string[];
    remainingMinutes: number;
    dueAt: number | null;
    onCriticalPath: boolean;
    suggestedBlock: { startAt: number; endAt: number } | null;
  }[];
  blockedTasks: { taskId: string; title: string; blockedBy: { taskId: string; title: string }[] }[];
  upcomingDeadlines: { id: string; title: string; kind: 'task' | 'project'; dueAt: number; status: string }[];
  atRisk: { id: string; title: string; status: string; explanation: string }[];
  unscheduledWork: { taskId: string; title: string; reason: string }[];
  capacity: { availableMinutesToday: number; scheduledMinutesToday: number; remainingMinutesToday: number };
  /** Deterministic plain-language summary; the AI service may rephrase it. */
  narrative: string;
}

/**
 * Builds the daily priority summary purely from structured scheduling data.
 * Every number and task in it comes from the engine, so it is testable and
 * the AI layer can only rephrase, never invent, facts.
 */
export function buildDailyBriefing(params: {
  input: ScheduleInput;
  schedule: ScheduleResult;
  risks: DeadlineRisk[];
  topN?: number;
  deadlineWindowDays?: number;
}): DailyBriefing {
  const { input, schedule, risks } = params;
  const tz = input.timezone;
  const topN = params.topN ?? 3;
  const nowLocal = DateTime.fromMillis(input.now, { zone: tz });
  const dayStart = nowLocal.startOf('day').toMillis();
  const dayEnd = nowLocal.endOf('day').toMillis();
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const expl = new Map(schedule.explanations.map((e) => [e.taskId, e]));

  const prereqs = new Map<string, string[]>();
  for (const d of input.dependencies) {
    if (!prereqs.has(d.taskId)) prereqs.set(d.taskId, []);
    prereqs.get(d.taskId)!.push(d.dependsOnTaskId);
  }

  const blockedTasks = input.tasks
    .filter((t) => !isComplete(t))
    .map((t) => ({
      taskId: t.id,
      title: t.title,
      blockedBy: (prereqs.get(t.id) ?? [])
        .map((p) => byId.get(p))
        .filter((p): p is NonNullable<typeof p> => !!p && !isComplete(p))
        .map((p) => ({ taskId: p.id, title: p.title })),
    }))
    .filter((b) => b.blockedBy.length);
  const blockedIds = new Set(blockedTasks.map((b) => b.taskId));

  const todaysBlocks = schedule.proposedBlocks.filter((b) => b.startAt < dayEnd && b.endAt > dayStart);
  const firstBlockToday = new Map<string, { startAt: number; endAt: number }>();
  for (const b of todaysBlocks) {
    if (!firstBlockToday.has(b.taskId)) firstBlockToday.set(b.taskId, { startAt: b.startAt, endAt: b.endAt });
  }

  // Prefer what the plan actually has today (in time order), then fill with
  // the best-ranked unblocked tasks.
  const candidates: string[] = [...firstBlockToday.keys()];
  const ranked = [...schedule.explanations]
    .sort((a, b) => b.score - a.score)
    .map((e) => e.taskId)
    .filter((id) => !blockedIds.has(id) && !candidates.includes(id));
  candidates.push(...ranked);

  const topTasks = candidates
    .slice(0, topN)
    .map((id) => byId.get(id)!)
    .filter(Boolean)
    .map((t) => ({
      taskId: t.id,
      title: t.title,
      score: expl.get(t.id)?.score ?? 0,
      reasons: expl.get(t.id)?.reasons ?? [],
      remainingMinutes: remainingMinutes(t),
      dueAt: t.dueAt ?? null,
      onCriticalPath: expl.get(t.id)?.onCriticalPath ?? false,
      suggestedBlock: firstBlockToday.get(t.id) ?? null,
    }));

  const first = topTasks.find((t) => !blockedIds.has(t.taskId)) ?? null;
  const suggestedFirstTask = first
    ? {
        taskId: first.taskId,
        title: first.title,
        why: first.reasons.length ? capitalize(first.reasons.slice(0, 3).join(', ')) + '.' : 'Highest-ranked available task.',
      }
    : null;

  const windowEnd = input.now + (params.deadlineWindowDays ?? 3) * DAY;
  const upcomingDeadlines = risks
    .filter((r) => r.status !== 'DONE' && r.dueAt <= windowEnd)
    .sort((a, b) => a.dueAt - b.dueAt)
    .map((r) => ({ id: r.id, title: r.title, kind: r.kind, dueAt: r.dueAt, status: r.status }));
  const atRisk = risks
    .filter((r) => r.status === 'AT_RISK' || r.status === 'INFEASIBLE' || r.status === 'OVERDUE')
    .map((r) => ({ id: r.id, title: r.title, status: r.status, explanation: r.explanation }));

  const availableMinutesToday = capacityBetween(input, Math.max(input.now, dayStart), dayEnd);
  const scheduledMinutesToday = Math.round(
    todaysBlocks.reduce((s, b) => s + (Math.min(b.endAt, dayEnd) - Math.max(b.startAt, dayStart, input.now)), 0) / 60_000,
  );
  const capacity = {
    availableMinutesToday,
    scheduledMinutesToday: Math.max(0, scheduledMinutesToday),
    remainingMinutesToday: Math.max(0, availableMinutesToday - Math.max(0, scheduledMinutesToday)),
  };

  const unscheduledWork = schedule.unscheduledTasks.map((u) => ({
    taskId: u.taskId,
    title: byId.get(u.taskId)?.title ?? u.taskId,
    reason: u.reason,
  }));

  const lines: string[] = [];
  if (suggestedFirstTask) {
    const blk = firstBlockToday.get(suggestedFirstTask.taskId);
    lines.push(
      `Start with "${suggestedFirstTask.title}"${blk ? ` at ${formatInstant(blk.startAt, tz).split(', ')[1]}` : ''} — ${suggestedFirstTask.why.charAt(0).toLowerCase()}${suggestedFirstTask.why.slice(1)}`,
    );
  } else {
    lines.push('Nothing is ready to work on right now.');
  }
  lines.push(
    `You have ${fmtMinutes(capacity.availableMinutesToday)} of free focus time left today; ${fmtMinutes(capacity.scheduledMinutesToday)} of it is planned.`,
  );
  if (blockedTasks.length) {
    const b = blockedTasks[0];
    lines.push(
      `${blockedTasks.length} task(s) are blocked, e.g. "${b.title}" is waiting on ${b.blockedBy.map((x) => `"${x.title}"`).join(', ')}.`,
    );
  }
  for (const r of atRisk.slice(0, 2)) lines.push(`${r.status === 'INFEASIBLE' ? 'Not feasible' : r.status === 'OVERDUE' ? 'Overdue' : 'At risk'}: ${r.explanation}`);
  if (unscheduledWork.length) lines.push(`${unscheduledWork.length} task(s) could not be scheduled in the planning window.`);

  return {
    date: nowLocal.toISODate()!,
    timezone: tz,
    generatedAt: new Date(input.now).toISOString(),
    suggestedFirstTask,
    topTasks,
    blockedTasks,
    upcomingDeadlines,
    atRisk,
    unscheduledWork,
    capacity,
    narrative: lines.join(' '),
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
