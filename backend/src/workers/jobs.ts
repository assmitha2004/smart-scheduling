import { DateTime } from 'luxon';
import { prisma } from '../db.js';
import { formatInstant } from '../engine/index.js';
import { inQuietHours, notify, resolvePrefs } from '../modules/notifications/notifications.service.js';
import { getDailyBriefing } from '../modules/briefings/briefings.service.js';
import { computeRisks, loadScheduleContext } from '../modules/scheduling/scheduling.service.js';
import { currentPlan } from '../modules/scheduling/plan.js';
import { carryOverMissed } from '../modules/day/day.routes.js';

/** Upcoming task reminder. Skips blocks that were moved/cancelled since the job was queued. */
export async function runBlockReminder(data: { blockId: string; startAt: string }): Promise<string> {
  const block = await prisma.scheduledBlock.findUnique({ where: { id: data.blockId }, include: { task: true, user: true } });
  if (!block || block.status !== 'CONFIRMED') return 'skipped: block no longer active';
  if (block.startAt.toISOString() !== data.startAt) return 'skipped: block was moved';
  if (inQuietHours(block.user)) return 'skipped: quiet hours';
  await notify({
    userId: block.userId,
    type: 'TASK_REMINDER',
    message: `Up next at ${formatInstant(block.startAt.getTime(), block.user.timezone).split(', ')[1]}: "${block.task.title}".`,
    data: { taskId: block.taskId, blockId: block.id },
    dedupeKey: `reminder:${block.id}:${block.startAt.getTime()}`,
  });
  return 'sent';
}

/**
 * Hourly sweep: delivers the daily plan to users whose local time has just
 * reached their preferred hour. Dedupe key = one plan per user per local day.
 */
export async function runDailyPlanSweep(now = new Date()): Promise<number> {
  const users = await prisma.user.findMany({ where: { onboarded: true } });
  let sent = 0;
  for (const u of users) {
    const prefs = resolvePrefs(u.notificationPrefs);
    if (!prefs.dailyPlan) continue;
    const local = DateTime.fromJSDate(now, { zone: u.timezone });
    if (local.hour !== prefs.dailyPlanHour) continue;
    // Sessions missed on earlier days go back on the to-do list before today's plan is built.
    const carried = await carryOverMissed(u.id, u.timezone, now.getTime());
    if (carried.blocks) {
      await notify({
        userId: u.id,
        type: 'CARRIED_OVER',
        message: `${carried.tasks.length} unfinished task${carried.tasks.length === 1 ? '' : 's'} from before ${carried.tasks.length === 1 ? 'is' : 'are'} back on your list: ${carried.tasks.slice(0, 3).map((t) => `"${t.title}"`).join(', ')}${carried.tasks.length > 3 ? '…' : ''}. Open My day to fit ${carried.tasks.length === 1 ? 'it' : 'them'} in.`,
        data: { tasks: carried.tasks },
        dedupeKey: `carry:${u.id}:${local.toISODate()}`,
      });
    }
    const { briefing, narrative } = await getDailyBriefing(u.id, { now: now.getTime() });
    const r = await notify({
      userId: u.id,
      type: 'DAILY_PLAN',
      message: narrative,
      data: { date: briefing.date, topTasks: briefing.topTasks.map((t) => ({ taskId: t.taskId, title: t.title })) },
      dedupeKey: `daily:${u.id}:${local.toISODate()}`,
    });
    if (r.created) sent++;
  }
  return sent;
}

/** Hourly sweep: alerts on deadlines that became at-risk/infeasible (once per target per day). */
export async function runDeadlineRiskSweep(now = new Date()): Promise<number> {
  const users = await prisma.user.findMany({ where: { onboarded: true } });
  let sent = 0;
  for (const u of users) {
    const ctx = await loadScheduleContext(u.id, now.getTime());
    const plan = currentPlan(ctx);
    const day = DateTime.fromJSDate(now, { zone: u.timezone }).toISODate();
    for (const r of computeRisks(ctx, plan.ok ? plan : undefined)) {
      if (r.status !== 'AT_RISK' && r.status !== 'INFEASIBLE') continue;
      const res = await notify({
        userId: u.id,
        type: 'DEADLINE_RISK',
        message: `${r.status === 'INFEASIBLE' ? 'Deadline not feasible' : 'Deadline at risk'}: ${r.explanation}`,
        data: { targetId: r.id, kind: r.kind, status: r.status, recommendations: r.recommendations.map((x) => x.message) },
        dedupeKey: `risk:${r.id}:${r.status}:${day}`,
      });
      if (res.created) sent++;
    }
  }
  return sent;
}
