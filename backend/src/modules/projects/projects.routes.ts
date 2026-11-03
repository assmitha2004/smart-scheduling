import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { parse } from '../../middleware/validate.js';
import { currentUser } from '../../middleware/auth.js';
import { badRequest, notFound } from '../../utils/errors.js';
import { assertProjectAccess, assertWorkspaceMember, userWorkspaceIds } from '../access.js';
import { logActivity } from '../activity/activity.service.js';
import { computeCriticalPath, isComplete, type EngineTask } from '../../engine/index.js';
import { toEngineTask } from '../scheduling/scheduling.service.js';
import { serializeTask } from '../tasks/tasks.routes.js';

export const projectsRouter = Router();

const dateish = z.coerce.date();
const projectSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  startDate: dateish.nullable().optional(),
  targetDate: dateish.nullable().optional(),
  status: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED']).optional(),
});

projectsRouter.get('/', async (req, res) => {
  const me = currentUser(req);
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
  if (workspaceId) await assertWorkspaceMember(me.id, workspaceId);
  const ids = workspaceId ? [workspaceId] : await userWorkspaceIds(me.id);
  const projects = await prisma.project.findMany({
    where: { workspaceId: { in: ids } },
    orderBy: { createdAt: 'desc' },
    include: { tasks: { select: { status: true, estimatedMinutes: true, actualMinutes: true } } },
  });
  res.json({
    projects: projects.map(({ tasks, ...p }) => ({
      ...p,
      taskCount: tasks.length,
      doneCount: tasks.filter((t) => t.status === 'DONE').length,
      remainingMinutes: tasks
        .filter((t) => t.status === 'TODO' || t.status === 'IN_PROGRESS')
        .reduce((s, t) => s + Math.max(0, t.estimatedMinutes - t.actualMinutes), 0),
    })),
  });
});

projectsRouter.post('/', async (req, res) => {
  const me = currentUser(req);
  const body = parse(projectSchema, req.body);
  const workspaceId = body.workspaceId ?? (await userWorkspaceIds(me.id))[0];
  if (!workspaceId) throw badRequest('Create a workspace first');
  await assertWorkspaceMember(me.id, workspaceId);
  if (body.startDate && body.targetDate && body.targetDate < body.startDate) throw badRequest('Target date must be after start date');
  const project = await prisma.project.create({
    data: {
      workspaceId,
      name: body.name,
      description: body.description ?? null,
      color: body.color,
      startDate: body.startDate ?? null,
      targetDate: body.targetDate ?? null,
      status: body.status,
    },
  });
  await logActivity({ workspaceId, actorId: me.id, entityType: 'project', entityId: project.id, action: 'project.created', metadata: { name: project.name } });
  res.status(201).json({ project });
});

projectsRouter.get('/:id', async (req, res) => {
  const project = await assertProjectAccess(currentUser(req).id, req.params.id);
  const milestones = await prisma.milestone.findMany({ where: { projectId: project.id }, orderBy: { dueAt: 'asc' } });
  res.json({ project, milestones });
});

projectsRouter.patch('/:id', async (req, res) => {
  const me = currentUser(req);
  const existing = await assertProjectAccess(me.id, req.params.id);
  const body = parse(projectSchema.partial().omit({ workspaceId: true }), req.body);
  const project = await prisma.project.update({ where: { id: existing.id }, data: body });
  await logActivity({ workspaceId: project.workspaceId, actorId: me.id, entityType: 'project', entityId: project.id, action: 'project.updated', metadata: Object.keys(body) });
  res.json({ project });
});

projectsRouter.delete('/:id', async (req, res) => {
  const me = currentUser(req);
  const p = await assertProjectAccess(me.id, req.params.id, ['OWNER', 'ADMIN']);
  await prisma.project.delete({ where: { id: p.id } });
  await logActivity({ workspaceId: p.workspaceId, actorId: me.id, entityType: 'project', entityId: p.id, action: 'project.deleted', metadata: { name: p.name } });
  res.status(204).end();
});

projectsRouter.get('/:id/tasks', async (req, res) => {
  await assertProjectAccess(currentUser(req).id, req.params.id);
  const status = typeof req.query.status === 'string' ? req.query.status.split(',') : undefined;
  const tasks = await prisma.task.findMany({
    where: { projectId: req.params.id, ...(status ? { status: { in: status as never } } : {}) },
    include: { dependencies: true, assignee: { select: { id: true, name: true } } },
    orderBy: [{ createdAt: 'asc' }],
  });
  res.json({ tasks: tasks.map(serializeTask) });
});

projectsRouter.post('/:id/milestones', async (req, res) => {
  const me = currentUser(req);
  const p = await assertProjectAccess(me.id, req.params.id);
  const body = parse(z.object({ name: z.string().trim().min(1).max(200), dueAt: dateish }), req.body);
  const milestone = await prisma.milestone.create({ data: { projectId: p.id, ...body } });
  res.status(201).json({ milestone });
});

projectsRouter.delete('/:id/milestones/:milestoneId', async (req, res) => {
  const p = await assertProjectAccess(currentUser(req).id, req.params.id);
  const r = await prisma.milestone.deleteMany({ where: { id: req.params.milestoneId, projectId: p.id } });
  if (!r.count) throw notFound('Milestone');
  res.status(204).end();
});

const DAY = 86_400_000;

/**
 * GET /projects/:id/timeline — Gantt data: bars from confirmed blocks (or a
 * projection for unplanned tasks), dependency links, critical path and
 * late / blocked / at-risk flags.
 */
projectsRouter.get('/:id/timeline', async (req, res) => {
  const project = await assertProjectAccess(currentUser(req).id, req.params.id);
  const now = Date.now();
  const [tasks, milestones] = await Promise.all([
    prisma.task.findMany({
      where: { projectId: project.id, status: { not: 'CANCELLED' } },
      include: {
        dependencies: true,
        assignee: { select: { id: true, name: true } },
        blocks: { where: { status: { in: ['CONFIRMED', 'COMPLETED'] } }, orderBy: { startAt: 'asc' } },
      },
    }),
    prisma.milestone.findMany({ where: { projectId: project.id }, orderBy: { dueAt: 'asc' } }),
  ]);
  const ids = new Set(tasks.map((t) => t.id));
  const deps = tasks.flatMap((t) => t.dependencies.filter((d) => ids.has(d.dependsOnTaskId)).map((d) => ({ id: d.id, taskId: d.taskId, dependsOnTaskId: d.dependsOnTaskId })));
  const engineTasks: EngineTask[] = tasks.map(toEngineTask);
  const cpm = computeCriticalPath(engineTasks, deps);
  const byId = new Map(tasks.map((t) => [t.id, t]));

  // Bars: confirmed blocks give the real span; otherwise project forward in
  // dependency order, assuming ~6 focus hours per day.
  const bars = new Map<string, { start: number; end: number; planned: boolean }>();
  const order = [...cpm.nodes.values()].sort((a, b) => a.earliestStart - b.earliestStart).map((n) => n.taskId);
  for (const id of order) {
    const t = byId.get(id)!;
    if (t.blocks.length) {
      bars.set(id, { start: t.blocks[0].startAt.getTime(), end: t.blocks[t.blocks.length - 1].endAt.getTime(), planned: true });
      continue;
    }
    if (t.status === 'DONE') {
      const end = (t.completedAt ?? t.updatedAt).getTime();
      bars.set(id, { start: end - Math.max(1, Math.ceil(t.estimatedMinutes / 360)) * DAY, end, planned: true });
      continue;
    }
    const prereqEnd = Math.max(0, ...t.dependencies.map((d) => bars.get(d.dependsOnTaskId)?.end ?? 0));
    const start = Math.max(now, project.startDate?.getTime() ?? 0, t.earliestStartAt?.getTime() ?? 0, prereqEnd);
    const days = Math.max(1, Math.ceil(Math.max(0, t.estimatedMinutes - t.actualMinutes) / 360));
    bars.set(id, { start, end: start + days * DAY, planned: false });
  }

  const items = tasks.map((t) => {
    const bar = bars.get(t.id)!;
    const blockedBy = t.dependencies.map((d) => byId.get(d.dependsOnTaskId)).filter((p) => p && !isComplete(toEngineTask(p)));
    const done = t.status === 'DONE';
    const late = !done && t.dueAt != null && t.dueAt.getTime() < now;
    const atRisk = !done && !late && t.dueAt != null && bar.end > t.dueAt.getTime();
    return {
      ...serializeTask(t),
      startAt: new Date(bar.start).toISOString(),
      endAt: new Date(bar.end).toISOString(),
      planned: bar.planned,
      progress: done ? 100 : t.estimatedMinutes ? Math.min(99, Math.round((t.actualMinutes / t.estimatedMinutes) * 100)) : 0,
      critical: cpm.criticalTaskIds.has(t.id),
      slackMinutes: cpm.nodes.get(t.id)?.slack ?? 0,
      flags: { late, blocked: blockedBy.length > 0, atRisk },
      blockedBy: blockedBy.map((p) => ({ id: p!.id, title: p!.title })),
    };
  });
  const finish = Math.max(0, ...items.map((i) => new Date(i.endAt).getTime()));
  res.json({
    project,
    tasks: items,
    dependencies: deps,
    milestones,
    criticalPath: cpm.criticalPath,
    projectedFinish: finish ? new Date(finish).toISOString() : null,
    targetAtRisk: project.targetDate ? finish > project.targetDate.getTime() : false,
  });
});
