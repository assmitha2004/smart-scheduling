import { Router } from 'express';
import { DateTime } from 'luxon';
import { prisma } from '../../db.js';
import { currentUser } from '../../middleware/auth.js';
import { userWorkspaceIds } from '../access.js';
import { computeRisks, loadScheduleContext, serializeRisk } from '../scheduling/scheduling.service.js';
import { currentPlan } from '../scheduling/plan.js';

export const analyticsRouter = Router();

/** GET /analytics/deadline-risk — feasibility of every task deadline and project target date. */
analyticsRouter.get('/deadline-risk', async (req, res) => {
  const ctx = await loadScheduleContext(currentUser(req).id);
  const plan = currentPlan(ctx);
  const risks = computeRisks(ctx, plan.ok ? plan : undefined).map(serializeRisk);
  const counts = { ON_TRACK: 0, AT_RISK: 0, INFEASIBLE: 0, OVERDUE: 0, DONE: 0 };
  for (const r of risks) counts[r.status]++;
  res.json({ risks, counts, conflicts: plan.conflicts });
});

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

/** GET /analytics/overview?weeks=8 — planned vs actual, workload, overdue trend, estimate accuracy. */
analyticsRouter.get('/overview', async (req, res) => {
  const me = currentUser(req);
  const weeks = Math.min(26, Math.max(1, Number(req.query.weeks ?? 8) || 8));
  const user = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
  const tz = user.timezone;
  const ws = await userWorkspaceIds(me.id);
  const now = DateTime.now().setZone(tz);
  const firstWeek = now.startOf('week').minus({ weeks: weeks - 1 });
  const scope = { project: { workspaceId: { in: ws } }, OR: [{ assigneeId: me.id }, { assigneeId: null }] };

  const [tasks, blocks, projects] = await Promise.all([
    prisma.task.findMany({ where: scope, select: { id: true, projectId: true, status: true, estimatedMinutes: true, actualMinutes: true, dueAt: true, completedAt: true } }),
    prisma.scheduledBlock.findMany({
      where: { userId: me.id, status: { in: ['CONFIRMED', 'COMPLETED'] }, startAt: { gte: firstWeek.toJSDate(), lt: now.plus({ days: 7 }).toJSDate() } },
      select: { taskId: true, startAt: true, endAt: true, status: true },
    }),
    prisma.project.findMany({ where: { workspaceId: { in: ws } }, select: { id: true, name: true, color: true } }),
  ]);
  const mins = (b: { startAt: Date; endAt: Date }) => (b.endAt.getTime() - b.startAt.getTime()) / 60_000;

  const weekly = Array.from({ length: weeks }, (_, i) => {
    const start = firstWeek.plus({ weeks: i });
    const end = start.plus({ weeks: 1 });
    const inWeek = (d: Date | null) => !!d && d >= start.toJSDate() && d < end.toJSDate();
    const plannedMinutes = Math.round(blocks.filter((b) => inWeek(b.startAt)).reduce((s, b) => s + mins(b), 0));
    const completed = tasks.filter((t) => t.status === 'DONE' && inWeek(t.completedAt));
    const due = tasks.filter((t) => inWeek(t.dueAt) && t.dueAt! < new Date() && t.status !== 'CANCELLED');
    const overdue = due.filter((t) => (t.status === 'DONE' ? t.completedAt! > t.dueAt! : true)).length;
    return {
      weekStart: start.toISODate(),
      plannedMinutes,
      actualMinutes: completed.reduce((s, t) => s + t.actualMinutes, 0),
      estimatedMinutesCompleted: completed.reduce((s, t) => s + t.estimatedMinutes, 0),
      tasksCompleted: completed.length,
      dueCount: due.length,
      overdueCount: overdue,
    };
  });

  const nextWeekEnd = now.plus({ days: 7 }).toJSDate();
  const workloadByProject = projects
    .map((p) => {
      const pt = tasks.filter((t) => t.projectId === p.id);
      const ids = new Set(pt.map((t) => t.id));
      return {
        projectId: p.id,
        name: p.name,
        color: p.color,
        remainingMinutes: pt.filter((t) => t.status === 'TODO' || t.status === 'IN_PROGRESS').reduce((s, t) => s + Math.max(0, t.estimatedMinutes - t.actualMinutes), 0),
        scheduledNext7DaysMinutes: Math.round(
          blocks.filter((b) => ids.has(b.taskId) && b.status === 'CONFIRMED' && b.startAt >= new Date() && b.startAt < nextWeekEnd).reduce((s, b) => s + mins(b), 0),
        ),
        openTasks: pt.filter((t) => t.status === 'TODO' || t.status === 'IN_PROGRESS').length,
        doneTasks: pt.filter((t) => t.status === 'DONE').length,
      };
    })
    .filter((p) => p.openTasks + p.doneTasks > 0)
    .sort((a, b) => b.remainingMinutes - a.remainingMinutes);

  const measured = tasks.filter((t) => t.status === 'DONE' && t.actualMinutes > 0 && t.estimatedMinutes > 0);
  const ratios = measured.map((t) => t.actualMinutes / t.estimatedMinutes);
  const estimateAccuracy = {
    sampleSize: measured.length,
    medianActualToEstimate: ratios.length ? round2(median(ratios)!) : null,
    meanAbsolutePercentError: ratios.length ? round2((ratios.reduce((s, r) => s + Math.abs(r - 1), 0) / ratios.length) * 100) : null,
    withinTwentyPercent: ratios.length ? round2((ratios.filter((r) => Math.abs(r - 1) <= 0.2).length / ratios.length) * 100) : null,
    underestimated: ratios.filter((r) => r > 1.2).length,
    overestimated: ratios.filter((r) => r < 0.8).length,
  };

  const openOverdue = tasks.filter((t) => (t.status === 'TODO' || t.status === 'IN_PROGRESS') && t.dueAt && t.dueAt < new Date()).length;
  res.json({
    timezone: tz,
    weekly,
    workloadByProject,
    estimateAccuracy,
    totals: {
      openTasks: tasks.filter((t) => t.status === 'TODO' || t.status === 'IN_PROGRESS').length,
      doneTasks: tasks.filter((t) => t.status === 'DONE').length,
      openOverdue,
      plannedMinutes: weekly.reduce((s, w) => s + w.plannedMinutes, 0),
      actualMinutes: weekly.reduce((s, w) => s + w.actualMinutes, 0),
    },
  });
});
