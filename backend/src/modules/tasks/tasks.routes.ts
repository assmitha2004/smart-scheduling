import { Router } from 'express';
import { z } from 'zod';
import type { Prisma, Task, TaskDependency } from '@prisma/client';
import { prisma } from '../../db.js';
import { parse } from '../../middleware/validate.js';
import { currentUser } from '../../middleware/auth.js';
import { badRequest, conflict, notFound, unprocessable } from '../../utils/errors.js';
import { assertProjectAccess, assertTaskAccess, assertWorkspaceMember, userWorkspaceIds } from '../access.js';
import { logActivity } from '../activity/activity.service.js';
import { cycleIfAdded, generateSchedule } from '../../engine/index.js';
import { notify } from '../notifications/notifications.service.js';
import { emitToUser } from '../../realtime/socket.js';
import { loadScheduleContext } from '../scheduling/scheduling.service.js';

export const tasksRouter = Router();

type TaskWithExtras = Task & {
  dependencies?: TaskDependency[];
  assignee?: { id: string; name: string } | null;
};

export function serializeTask(t: TaskWithExtras) {
  return {
    id: t.id,
    projectId: t.projectId,
    assigneeId: t.assigneeId,
    assignee: t.assignee ?? null,
    title: t.title,
    description: t.description,
    estimatedMinutes: t.estimatedMinutes,
    actualMinutes: t.actualMinutes,
    priority: t.priority,
    status: t.status,
    splittable: t.splittable,
    earliestStartAt: t.earliestStartAt?.toISOString() ?? null,
    dueAt: t.dueAt?.toISOString() ?? null,
    completedAt: t.completedAt?.toISOString() ?? null,
    version: t.version,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    ...(t.dependencies ? { dependsOn: t.dependencies.map((d) => d.dependsOnTaskId) } : {}),
  };
}

const priority = z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);
const status = z.enum(['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED']);
const baseTask = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(10_000).nullable().optional(),
  estimatedMinutes: z.number().int().min(0).max(100_000).optional(),
  actualMinutes: z.number().int().min(0).max(100_000).optional(),
  priority: priority.optional(),
  status: status.optional(),
  splittable: z.boolean().optional(),
  earliestStartAt: z.coerce.date().nullable().optional(),
  dueAt: z.coerce.date().nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
});
const createSchema = baseTask.extend({
  projectId: z.string().uuid(),
  dependsOn: z.array(z.string().uuid()).max(50).optional(),
});
const updateSchema = baseTask.partial().extend({
  /** Optimistic concurrency: reject if the task changed since the client loaded it. */
  version: z.number().int().optional(),
});

/** Fields whose change can invalidate the current schedule. */
const SCHEDULE_FIELDS = ['estimatedMinutes', 'actualMinutes', 'priority', 'status', 'earliestStartAt', 'dueAt', 'assigneeId', 'splittable'] as const;

async function assertAssignable(workspaceId: string, assigneeId: string | null | undefined) {
  if (!assigneeId) return;
  await assertWorkspaceMember(assigneeId, workspaceId).catch(() => {
    throw badRequest('Assignee must be a member of the workspace');
  });
}

/**
 * Serialises dependency changes per workspace with a transaction-scoped
 * advisory lock, so two concurrent requests cannot each add half of a cycle.
 */
async function lockWorkspaceGraph(tx: Prisma.TransactionClient, workspaceId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'deps:' + workspaceId}))`;
}

async function workspaceDeps(tx: Prisma.TransactionClient, workspaceId: string) {
  return tx.taskDependency.findMany({
    where: { task: { project: { workspaceId } } },
    select: { taskId: true, dependsOnTaskId: true },
  });
}

async function addDependency(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  taskId: string,
  dependsOnTaskId: string,
) {
  if (taskId === dependsOnTaskId) throw unprocessable('SELF_DEPENDENCY', 'A task cannot depend on itself');
  const prereq = await tx.task.findUnique({ where: { id: dependsOnTaskId }, include: { project: true } });
  if (!prereq || prereq.project.workspaceId !== workspaceId) {
    throw badRequest('Dependencies must be between tasks in the same workspace');
  }
  const existing = await workspaceDeps(tx, workspaceId);
  if (existing.some((d) => d.taskId === taskId && d.dependsOnTaskId === dependsOnTaskId)) {
    throw conflict('DUPLICATE_DEPENDENCY', 'This dependency already exists');
  }
  const cycle = cycleIfAdded(existing, taskId, dependsOnTaskId);
  if (cycle) {
    const titles = await tx.task.findMany({ where: { id: { in: cycle } }, select: { id: true, title: true } });
    const name = new Map(titles.map((t) => [t.id, t.title]));
    const path = cycle.map((id) => ({ id, title: name.get(id) ?? id }));
    throw unprocessable(
      'DEPENDENCY_CYCLE',
      `This would create a dependency cycle: ${path.map((p) => `"${p.title}"`).join(' → ')}. Each task would be waiting on itself.`,
      { cycle: path },
    );
  }
  return tx.taskDependency.create({ data: { taskId, dependsOnTaskId } });
}

/** GET /tasks — tasks across the caller's workspaces (filters: assignee=me, status, projectId). */
tasksRouter.get('/', async (req, res) => {
  const me = currentUser(req);
  const ws = await userWorkspaceIds(me.id);
  const q = req.query;
  const where: Prisma.TaskWhereInput = {
    project: { workspaceId: { in: ws } },
    ...(q.assignee === 'me' ? { OR: [{ assigneeId: me.id }, { assigneeId: null }] } : {}),
    ...(typeof q.status === 'string' ? { status: { in: q.status.split(',') as never } } : {}),
    ...(typeof q.projectId === 'string' ? { projectId: q.projectId } : {}),
  };
  const tasks = await prisma.task.findMany({
    where,
    include: { dependencies: true, assignee: { select: { id: true, name: true } } },
    orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    take: 1000,
  });
  res.json({ tasks: tasks.map(serializeTask) });
});

tasksRouter.post('/', async (req, res) => {
  const me = currentUser(req);
  const body = parse(createSchema, req.body);
  const project = await assertProjectAccess(me.id, body.projectId);
  await assertAssignable(project.workspaceId, body.assigneeId);
  if (body.dueAt && body.earliestStartAt && body.dueAt < body.earliestStartAt) throw badRequest('Due date is before the earliest start date');
  const { dependsOn, projectId, ...data } = body;
  const task = await prisma.$transaction(async (tx) => {
    const t = await tx.task.create({
      data: { ...data, projectId, completedAt: data.status === 'DONE' ? new Date() : null },
    });
    if (dependsOn?.length) {
      await lockWorkspaceGraph(tx, project.workspaceId);
      for (const d of dependsOn) await addDependency(tx, project.workspaceId, t.id, d);
    }
    await logActivity({ workspaceId: project.workspaceId, actorId: me.id, entityType: 'task', entityId: t.id, action: 'task.created', metadata: { title: t.title } }, tx);
    return tx.task.findUniqueOrThrow({ where: { id: t.id }, include: { dependencies: true, assignee: { select: { id: true, name: true } } } });
  });
  emitToUser(me.id, 'task:updated', { taskId: task.id });
  res.status(201).json({ task: serializeTask(task) });
});

tasksRouter.get('/:id', async (req, res) => {
  const me = currentUser(req);
  await assertTaskAccess(me.id, req.params.id);
  const task = await prisma.task.findUniqueOrThrow({
    where: { id: req.params.id },
    include: {
      assignee: { select: { id: true, name: true } },
      project: { select: { id: true, name: true, color: true, workspaceId: true } },
      dependencies: { include: { dependsOn: { select: { id: true, title: true, status: true, dueAt: true } } } },
      dependents: { include: { task: { select: { id: true, title: true, status: true } } } },
      blocks: { where: { status: { in: ['CONFIRMED', 'COMPLETED'] } }, orderBy: { startAt: 'asc' } },
      comments: { orderBy: { createdAt: 'asc' }, include: { author: { select: { id: true, name: true } } } },
    },
  });
  const activity = await prisma.activityLog.findMany({
    where: { entityType: 'task', entityId: task.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { actor: { select: { id: true, name: true } } },
  });
  res.json({
    task: serializeTask(task),
    project: task.project,
    dependencies: task.dependencies.map((d) => ({ id: d.id, type: d.dependencyType, task: d.dependsOn })),
    dependents: task.dependents.map((d) => ({ id: d.id, type: d.dependencyType, task: d.task })),
    blocks: task.blocks,
    comments: task.comments,
    activity,
  });
});

/** GET /tasks/:id/suggestions — when the engine would place this task right now. */
tasksRouter.get('/:id/suggestions', async (req, res) => {
  const me = currentUser(req);
  await assertTaskAccess(me.id, req.params.id);
  const ctx = await loadScheduleContext(me.id);
  if (!ctx.tasks.has(req.params.id)) {
    res.json({ blocks: [], reason: 'This task is not part of your personal schedule (done, or assigned to someone else).' });
    return;
  }
  const result = generateSchedule(ctx.input);
  const id = req.params.id;
  res.json({
    blocks: result.proposedBlocks.filter((b) => b.taskId === id).map((b) => ({ startAt: new Date(b.startAt).toISOString(), endAt: new Date(b.endAt).toISOString() })),
    explanation: result.explanations.find((e) => e.taskId === id) ?? null,
    unscheduled: result.unscheduledTasks.find((u) => u.taskId === id) ?? null,
    warnings: result.warnings.filter((w) => w.taskId === id),
  });
});

tasksRouter.patch('/:id', async (req, res) => {
  const me = currentUser(req);
  const existing = await assertTaskAccess(me.id, req.params.id);
  const { version, ...body } = parse(updateSchema, req.body);
  if (version != null && version !== existing.version) {
    throw conflict('STALE_TASK', 'This task was changed by someone else. Reload to see the latest version.', {
      expectedVersion: version,
      currentVersion: existing.version,
    });
  }
  if (body.assigneeId !== undefined) await assertAssignable(existing.project.workspaceId, body.assigneeId);
  const dueAt = body.dueAt === undefined ? existing.dueAt : body.dueAt;
  const est = body.earliestStartAt === undefined ? existing.earliestStartAt : body.earliestStartAt;
  if (dueAt && est && dueAt < est) throw badRequest('Due date is before the earliest start date');

  const becameDone = body.status === 'DONE' && existing.status !== 'DONE';
  const updated = await prisma.task.updateMany({
    where: { id: existing.id, version: existing.version },
    data: {
      ...body,
      ...(becameDone ? { completedAt: new Date() } : body.status && body.status !== 'DONE' ? { completedAt: null } : {}),
      version: { increment: 1 },
    },
  });
  if (!updated.count) throw conflict('STALE_TASK', 'This task was changed concurrently. Reload and try again.');

  if (becameDone || body.status === 'CANCELLED') {
    // Release future blocks for finished work.
    await prisma.scheduledBlock.updateMany({
      where: { taskId: existing.id, status: 'CONFIRMED', startAt: { gte: new Date() } },
      data: { status: 'CANCELLED' },
    });
    await prisma.scheduledBlock.updateMany({
      where: { taskId: existing.id, status: 'CONFIRMED', endAt: { lte: new Date() } },
      data: { status: 'COMPLETED' },
    });
  }
  const changed = Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined);
  await logActivity({
    workspaceId: existing.project.workspaceId,
    actorId: me.id,
    entityType: 'task',
    entityId: existing.id,
    action: becameDone ? 'task.completed' : 'task.updated',
    metadata: { fields: changed },
  });
  if (becameDone) await notifyUnblocked(existing.id, me.id);

  const task = await prisma.task.findUniqueOrThrow({ where: { id: existing.id }, include: { dependencies: true, assignee: { select: { id: true, name: true } } } });
  const hasFutureBlocks = await prisma.scheduledBlock.count({ where: { taskId: task.id, status: 'CONFIRMED', endAt: { gt: new Date() } } });
  const scheduleRelevant = changed.some((k) => (SCHEDULE_FIELDS as readonly string[]).includes(k));
  emitToUser(me.id, 'task:updated', { taskId: task.id });
  res.json({ task: serializeTask(task), replanSuggested: scheduleRelevant && (hasFutureBlocks > 0 || becameDone) });
});

/** Notifies owners of tasks whose last incomplete prerequisite just finished. */
async function notifyUnblocked(taskId: string, actorId: string) {
  const dependents = await prisma.taskDependency.findMany({
    where: { dependsOnTaskId: taskId },
    include: { task: { include: { dependencies: { include: { dependsOn: { select: { status: true } } } } } } },
  });
  const prereqTitle = (await prisma.task.findUnique({ where: { id: taskId }, select: { title: true } }))?.title;
  for (const d of dependents) {
    const t = d.task;
    if (t.status === 'DONE' || t.status === 'CANCELLED') continue;
    const allDone = t.dependencies.every((x) => x.dependsOn.status === 'DONE' || x.dependsOn.status === 'CANCELLED');
    if (!allDone) continue;
    await notify({
      userId: t.assigneeId ?? actorId,
      type: 'DEPENDENCY_UNBLOCKED',
      message: `"${t.title}" is ready to start — "${prereqTitle}" is done.`,
      data: { taskId: t.id, unblockedBy: taskId },
      dedupeKey: `unblocked:${t.id}:${taskId}`,
    });
  }
}

tasksRouter.delete('/:id', async (req, res) => {
  const me = currentUser(req);
  const t = await assertTaskAccess(me.id, req.params.id);
  await prisma.task.delete({ where: { id: t.id } });
  await logActivity({ workspaceId: t.project.workspaceId, actorId: me.id, entityType: 'task', entityId: t.id, action: 'task.deleted', metadata: { title: t.title } });
  emitToUser(me.id, 'task:updated', { taskId: t.id, deleted: true });
  res.status(204).end();
});

/** POST /tasks/:id/dependencies — add "this task depends on dependsOnTaskId" (finish-to-start). */
tasksRouter.post('/:id/dependencies', async (req, res) => {
  const me = currentUser(req);
  const task = await assertTaskAccess(me.id, req.params.id);
  const body = parse(z.object({ dependsOnTaskId: z.string().uuid(), dependencyType: z.literal('FINISH_TO_START').optional() }), req.body);
  const dep = await prisma.$transaction(async (tx) => {
    await lockWorkspaceGraph(tx, task.project.workspaceId);
    const d = await addDependency(tx, task.project.workspaceId, task.id, body.dependsOnTaskId);
    await logActivity({ workspaceId: task.project.workspaceId, actorId: me.id, entityType: 'task', entityId: task.id, action: 'dependency.added', metadata: { dependsOnTaskId: body.dependsOnTaskId } }, tx);
    return d;
  });
  emitToUser(me.id, 'task:updated', { taskId: task.id });
  res.status(201).json({ dependency: dep, replanSuggested: true });
});

/** DELETE /tasks/:id/dependencies/:dependencyId — accepts the dependency id or the prerequisite task id. */
tasksRouter.delete('/:id/dependencies/:dependencyId', async (req, res) => {
  const me = currentUser(req);
  const task = await assertTaskAccess(me.id, req.params.id);
  const r = await prisma.taskDependency.deleteMany({
    where: { taskId: task.id, OR: [{ id: req.params.dependencyId }, { dependsOnTaskId: req.params.dependencyId }] },
  });
  if (!r.count) throw notFound('Dependency');
  await logActivity({ workspaceId: task.project.workspaceId, actorId: me.id, entityType: 'task', entityId: task.id, action: 'dependency.removed', metadata: { dependencyId: req.params.dependencyId } });
  emitToUser(me.id, 'task:updated', { taskId: task.id });
  res.status(204).end();
});

tasksRouter.post('/:id/comments', async (req, res) => {
  const me = currentUser(req);
  const task = await assertTaskAccess(me.id, req.params.id);
  const { body } = parse(z.object({ body: z.string().trim().min(1).max(5000) }), req.body);
  const comment = await prisma.taskComment.create({
    data: { taskId: task.id, authorId: me.id, body },
    include: { author: { select: { id: true, name: true } } },
  });
  await logActivity({ workspaceId: task.project.workspaceId, actorId: me.id, entityType: 'task', entityId: task.id, action: 'comment.added' });
  res.status(201).json({ comment });
});

/** POST /tasks/:id/log-time — record time actually spent (feeds estimate accuracy analytics). */
tasksRouter.post('/:id/log-time', async (req, res) => {
  const me = currentUser(req);
  const task = await assertTaskAccess(me.id, req.params.id);
  const { minutes } = parse(z.object({ minutes: z.number().int().min(1).max(24 * 60) }), req.body);
  const t = await prisma.task.update({
    where: { id: task.id },
    data: { actualMinutes: { increment: minutes }, version: { increment: 1 }, status: task.status === 'TODO' ? 'IN_PROGRESS' : undefined },
    include: { dependencies: true, assignee: { select: { id: true, name: true } } },
  });
  await logActivity({ workspaceId: task.project.workspaceId, actorId: me.id, entityType: 'task', entityId: task.id, action: 'time.logged', metadata: { minutes } });
  res.json({ task: serializeTask(t) });
});
