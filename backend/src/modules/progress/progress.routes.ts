import { Router } from 'express';
import { prisma } from '../../db.js';
import { currentUser } from '../../middleware/auth.js';
import { notFound } from '../../utils/errors.js';
import { userWorkspaceIds } from '../access.js';
import { computeProgress } from '../../progress/progress.js';

export const progressRouter = Router();

/** GET /progress — XP, level, streak, badges and the weekly review. */
progressRouter.get('/', async (req, res) => {
  const me = currentUser(req);
  const user = await prisma.user.findUnique({ where: { id: me.id } });
  if (!user) throw notFound('User');
  const workspaceIds = await userWorkspaceIds(me.id);
  const now = Date.now();
  const twoWeeksAgo = new Date(now - 15 * 86_400_000);
  const [done, blocks, accepted] = await Promise.all([
    prisma.task.findMany({
      where: { status: 'DONE', completedAt: { not: null }, project: { workspaceId: { in: workspaceIds } }, OR: [{ assigneeId: me.id }, { assigneeId: null }] },
      select: { id: true, title: true, estimatedMinutes: true, completedAt: true, project: { select: { name: true } } },
      take: 5000,
    }),
    prisma.scheduledBlock.findMany({ where: { userId: me.id, startAt: { gte: twoWeeksAgo } }, select: { startAt: true, endAt: true, status: true } }),
    prisma.scheduleRecommendation.findFirst({ where: { userId: me.id, status: 'ACCEPTED' }, orderBy: { resolvedAt: 'asc' }, select: { resolvedAt: true, createdAt: true } }),
  ]);
  const progress = computeProgress({
    done: done.map((t) => ({ id: t.id, title: t.title, estimatedMinutes: t.estimatedMinutes, completedAt: t.completedAt!, projectName: t.project.name })),
    blocks: blocks.map((b) => ({ start: b.startAt, end: b.endAt, status: b.status })),
    firstScheduleAcceptedAt: accepted ? accepted.resolvedAt ?? accepted.createdAt : null,
    tz: user.timezone,
    now,
  });
  res.json(progress);
});
