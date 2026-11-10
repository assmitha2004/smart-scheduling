import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { parse } from '../../middleware/validate.js';
import { currentUser } from '../../middleware/auth.js';
import { badRequest, conflict, notFound } from '../../utils/errors.js';
import { userWorkspaceIds } from '../access.js';
import { logActivity } from '../activity/activity.service.js';
import { emitToUser } from '../../realtime/socket.js';
import { serializeTask } from '../tasks/tasks.routes.js';

/**
 * "My day": the simple daily loop.
 *   1. Dump tasks (with or without a time estimate) and answer a few questions.
 *   2. Generate today's plan with POST /schedules/preview { horizon: 'DAY' } and approve it.
 *   3. Track each session: done, partly done, skipped, or the whole task finished.
 *   4. Sessions that were never checked off on an earlier day are "missed".
 *      Carrying them over cancels those stale blocks; the task's remaining
 *      time (estimate − logged time) goes back into the next plan.
 */
export const dayRouter = Router();

export const MY_TASKS_PROJECT = { name: '📝 My tasks', color: '#5146e5' } as const;
const OPEN = ['TODO', 'IN_PROGRESS'] as const;
const MISSED_LOOKBACK_DAYS = 14;

const mins = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 60_000);
const remaining = (t: { estimatedMinutes: number; actualMinutes: number }) => Math.max(0, t.estimatedMinutes - t.actualMinutes);

async function myTaskScope(userId: string): Promise<Prisma.TaskWhereInput> {
  const ws = await userWorkspaceIds(userId);
  return {
    project: { workspaceId: { in: ws }, status: { notIn: ['ARCHIVED', 'COMPLETED'] } },
    OR: [{ assigneeId: userId }, { assigneeId: null }],
  };
}

/** Confirmed blocks from earlier days that were never checked off, for tasks that are still open. */
export async function findMissedBlocks(userId: string, tz: string, now = Date.now()) {
  const startOfToday = DateTime.fromMillis(now, { zone: tz }).startOf('day');
  return prisma.scheduledBlock.findMany({
    where: {
      userId,
      status: 'CONFIRMED',
      endAt: { lte: startOfToday.toJSDate() },
      startAt: { gte: startOfToday.minus({ days: MISSED_LOOKBACK_DAYS }).toJSDate() },
      task: { status: { in: [...OPEN] } },
    },
    include: { task: { select: { id: true, title: true } } },
    orderBy: { startAt: 'asc' },
  });
}

/**
 * Cancels missed blocks so their work is planned again. Logged time is kept,
 * so only the remaining minutes of each task are rescheduled.
 */
export async function carryOverMissed(userId: string, tz: string, now = Date.now()) {
  const missed = await findMissedBlocks(userId, tz, now);
  if (!missed.length) return { blocks: 0, minutes: 0, tasks: [] as { taskId: string; title: string }[] };
  await prisma.scheduledBlock.updateMany({ where: { id: { in: missed.map((b) => b.id) } }, data: { status: 'CANCELLED' } });
  const tasks = [...new Map(missed.map((b) => [b.taskId, { taskId: b.taskId, title: b.task.title }])).values()];
  await logActivity({ actorId: userId, entityType: 'schedule', entityId: userId, action: 'day.carried_over', metadata: { blocks: missed.length, tasks: tasks.map((t) => t.taskId) } });
  emitToUser(userId, 'schedule:updated', { reason: 'carry-over' });
  return { blocks: missed.length, minutes: missed.reduce((s, b) => s + mins(b.startAt, b.endAt), 0), tasks };
}

/** GET /day — today's sessions, fixed events, open tasks and anything missed on earlier days. */
dayRouter.get('/', async (req, res) => {
  const me = currentUser(req);
  const user = await prisma.user.findUnique({ where: { id: me.id } });
  if (!user) throw notFound('User');
  const now = Date.now();
  const local = DateTime.fromMillis(now, { zone: user.timezone });
  const dayStart = local.startOf('day').toJSDate();
  const dayEnd = local.endOf('day').toJSDate();
  const scope = await myTaskScope(me.id);

  const [blocks, events, open, missed] = await Promise.all([
    prisma.scheduledBlock.findMany({
      where: { userId: me.id, status: { in: ['CONFIRMED', 'COMPLETED'] }, startAt: { lt: dayEnd }, endAt: { gt: dayStart } },
      include: { task: { include: { project: { select: { name: true, color: true } } } } },
      orderBy: { startAt: 'asc' },
    }),
    prisma.calendarEvent.findMany({ where: { userId: me.id, startAt: { lt: dayEnd }, endAt: { gt: dayStart } }, orderBy: { startAt: 'asc' } }),
    prisma.task.findMany({
      where: { ...scope, status: { in: [...OPEN] } },
      include: { blocks: { where: { startAt: { lt: dayStart }, status: { in: ['CONFIRMED', 'CANCELLED'] } }, select: { id: true }, take: 1 } },
      orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      take: 300,
    }),
    findMissedBlocks(me.id, user.timezone, now),
  ]);

  const scheduledToday = new Set(blocks.filter((b) => b.status === 'CONFIRMED' && b.endAt.getTime() > now).map((b) => b.taskId));
  const taskBlocks = blocks.map((b) => ({
    id: b.id,
    taskId: b.taskId,
    title: b.task.title,
    projectName: b.task.project.name,
    color: b.task.project.color,
    priority: b.task.priority,
    startAt: b.startAt.toISOString(),
    endAt: b.endAt.toISOString(),
    minutes: mins(b.startAt, b.endAt),
    status: b.status,
    taskStatus: b.task.status,
    taskRemainingMinutes: remaining(b.task),
  }));
  const planned = taskBlocks.reduce((s, b) => s + b.minutes, 0);
  const done = taskBlocks.filter((b) => b.status === 'COMPLETED').reduce((s, b) => s + b.minutes, 0);

  res.json({
    date: local.toISODate(),
    timezone: user.timezone,
    now: new Date(now).toISOString(),
    blocks: taskBlocks,
    events: events.map((e) => ({ id: e.id, title: e.title, startAt: e.startAt.toISOString(), endAt: e.endAt.toISOString(), eventType: e.eventType })),
    openTasks: open.map((t) => ({
      id: t.id,
      title: t.title,
      priority: t.priority,
      status: t.status,
      estimatedMinutes: t.estimatedMinutes,
      actualMinutes: t.actualMinutes,
      remainingMinutes: remaining(t),
      dueAt: t.dueAt?.toISOString() ?? null,
      earliestStartAt: t.earliestStartAt?.toISOString() ?? null,
      version: t.version,
      scheduledToday: scheduledToday.has(t.id),
      carried: t.blocks.length > 0,
    })),
    missed: {
      blocks: missed.length,
      minutes: missed.reduce((s, b) => s + mins(b.startAt, b.endAt), 0),
      tasks: [...new Map(missed.map((b) => [b.taskId, { taskId: b.taskId, title: b.task.title }])).values()],
    },
    stats: {
      plannedMinutes: planned,
      doneMinutes: done,
      sessions: taskBlocks.length,
      sessionsDone: taskBlocks.filter((b) => b.status === 'COMPLETED').length,
    },
  });
});

const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');
const dayTaskSchema = z.object({
  /** Existing task to update; omit to create a new one. */
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(300),
  /** Minutes still needed. */
  minutes: z.number().int().min(5).max(6000),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']),
  due: z.enum(['TODAY', 'TOMORROW', 'WEEK', 'NONE']),
  /** Not before this local time today (e.g. "18:00" for "gym at 6pm"). */
  startAfter: hm.nullable().optional(),
});
const dayTasksBody = z.object({ tasks: z.array(dayTaskSchema).min(1).max(60) });

/** Finds (or creates) the "My tasks" project in the user's own workspace. */
async function myTasksProject(tx: Prisma.TransactionClient, userId: string) {
  const ws = await tx.workspace.findFirst({ where: { ownerId: userId }, orderBy: { createdAt: 'asc' } });
  const workspace = ws ?? (await tx.workspace.findFirst({ where: { members: { some: { userId } } }, orderBy: { createdAt: 'asc' } }));
  if (!workspace) throw badRequest('Create a workspace first');
  const existing = await tx.project.findFirst({ where: { workspaceId: workspace.id, name: MY_TASKS_PROJECT.name, status: { notIn: ['ARCHIVED', 'COMPLETED'] } } });
  return existing ?? tx.project.create({ data: { workspaceId: workspace.id, name: MY_TASKS_PROJECT.name, color: MY_TASKS_PROJECT.color, description: 'Tasks added from My day' } });
}

/**
 * POST /day/tasks — save the answers from the "plan my day" questions:
 * creates new tasks and updates existing ones (priority, time left, deadline).
 */
dayRouter.post('/tasks', async (req, res) => {
  const me = currentUser(req);
  const { tasks } = parse(dayTasksBody, req.body);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
  const local = DateTime.now().setZone(user.timezone);
  const dueAt = (d: z.infer<typeof dayTaskSchema>['due']) =>
    d === 'TODAY' ? local.endOf('day').toJSDate()
      : d === 'TOMORROW' ? local.plus({ days: 1 }).endOf('day').toJSDate()
      : d === 'WEEK' ? local.plus({ days: 6 }).endOf('day').toJSDate()
      : null;
  const startAfter = (t: string | null | undefined) => {
    if (!t) return null;
    const [h, m] = t.split(':').map(Number);
    const at = local.set({ hour: h, minute: m, second: 0, millisecond: 0 });
    return at.toMillis() > Date.now() ? at.toJSDate() : null;
  };
  const scope = await myTaskScope(me.id);

  const saved = await prisma.$transaction(async (tx) => {
    const out = [];
    let project: { id: string; workspaceId: string } | null = null;
    for (const t of tasks) {
      if (t.id) {
        const existing = await tx.task.findFirst({ where: { ...scope, id: t.id } });
        if (!existing) throw notFound('Task');
        out.push(await tx.task.update({
          where: { id: t.id },
          data: {
            title: t.title,
            priority: t.priority,
            // "minutes" is the time still needed, so the estimate is logged time + that.
            estimatedMinutes: existing.actualMinutes + t.minutes,
            dueAt: dueAt(t.due),
            earliestStartAt: startAfter(t.startAfter),
            status: existing.status,
            version: { increment: 1 },
          },
        }));
      } else {
        project ??= await myTasksProject(tx, me.id);
        const created = await tx.task.create({
          data: {
            projectId: project.id,
            assigneeId: me.id,
            title: t.title,
            estimatedMinutes: t.minutes,
            priority: t.priority,
            dueAt: dueAt(t.due),
            earliestStartAt: startAfter(t.startAfter),
          },
        });
        await logActivity({ workspaceId: project.workspaceId, actorId: me.id, entityType: 'task', entityId: created.id, action: 'task.created', metadata: { title: created.title, via: 'my-day' } }, tx);
        out.push(created);
      }
    }
    return out;
  });
  emitToUser(me.id, 'task:updated', { reason: 'my-day' });
  res.status(201).json({ tasks: saved.map(serializeTask) });
});

const blockActionSchema = z.object({
  action: z.enum(['done', 'partial', 'skip', 'finish', 'undo']),
  /** For "partial": minutes actually worked. */
  minutes: z.number().int().min(1).max(1440).optional(),
});

/**
 * POST /day/blocks/:id — track a session.
 *   done    the session happened; its minutes are logged on the task.
 *   partial only part of it happened; the block is shortened to what was done.
 *   skip    it didn't happen; the work stays on the task for the next plan.
 *   finish  the whole task is done (cancels the task's other upcoming sessions).
 *   undo    reverses done / partial / skip.
 * A task whose logged time reaches its estimate is marked done automatically.
 */
dayRouter.post('/blocks/:id', async (req, res) => {
  const me = currentUser(req);
  const { action, minutes } = parse(blockActionSchema, req.body);
  const block = await prisma.scheduledBlock.findFirst({ where: { id: req.params.id, userId: me.id }, include: { task: true } });
  if (!block) throw notFound('Block');
  const len = mins(block.startAt, block.endAt);
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const task = block.task;
    let logged = 0;
    let taskDone = false;
    if (action === 'done' || action === 'partial' || action === 'finish') {
      if (block.status !== 'CONFIRMED') throw badRequest('This session was already tracked. Undo it first.');
      let worked = len;
      if (action === 'partial') {
        if (!minutes) throw badRequest('Say how many minutes you worked');
        worked = Math.min(minutes, len);
        if (worked < len) await tx.scheduledBlock.update({ where: { id: block.id }, data: { endAt: new Date(block.startAt.getTime() + worked * 60_000) } });
      }
      await tx.scheduledBlock.update({ where: { id: block.id }, data: { status: 'COMPLETED' } });
      logged = worked;
      const actual = task.actualMinutes + worked;
      taskDone = action === 'finish' || (action === 'done' && actual >= task.estimatedMinutes);
      await tx.task.update({
        where: { id: task.id },
        data: {
          actualMinutes: actual,
          status: taskDone ? 'DONE' : task.status === 'TODO' ? 'IN_PROGRESS' : undefined,
          completedAt: taskDone ? now : undefined,
          version: { increment: 1 },
        },
      });
      if (taskDone) {
        await tx.scheduledBlock.updateMany({ where: { taskId: task.id, status: 'CONFIRMED', id: { not: block.id }, startAt: { gte: now } }, data: { status: 'CANCELLED' } });
      }
    } else if (action === 'skip') {
      if (block.status !== 'CONFIRMED') throw badRequest('This session was already tracked. Undo it first.');
      await tx.scheduledBlock.update({ where: { id: block.id }, data: { status: 'CANCELLED' } });
    } else {
      if (block.status === 'CONFIRMED') throw badRequest('Nothing to undo');
      const clash = await tx.scheduledBlock.findFirst({ where: { userId: me.id, status: 'CONFIRMED', id: { not: block.id }, startAt: { lt: block.endAt }, endAt: { gt: block.startAt } } });
      if (clash) throw conflict('BLOCK_OVERLAP', 'Another session now uses this time, so this one cannot be restored.');
      await tx.scheduledBlock.update({ where: { id: block.id }, data: { status: 'CONFIRMED' } });
      if (block.status === 'COMPLETED') {
        logged = -len;
        const actual = Math.max(0, task.actualMinutes - len);
        const reopen = task.status === 'DONE';
        await tx.task.update({
          where: { id: task.id },
          data: {
            actualMinutes: actual,
            status: reopen ? (actual > 0 ? 'IN_PROGRESS' : 'TODO') : undefined,
            completedAt: reopen ? null : undefined,
            version: { increment: 1 },
          },
        });
      }
    }
    await logActivity({ actorId: me.id, entityType: 'block', entityId: block.id, action: `block.${action}`, metadata: { taskId: task.id, minutes: logged } }, tx);
    const fresh = await tx.task.findUniqueOrThrow({ where: { id: task.id } });
    return { loggedMinutes: logged, taskDone, task: serializeTask(fresh) };
  });
  emitToUser(me.id, 'schedule:updated', { reason: 'tracked' });
  emitToUser(me.id, 'task:updated', { taskId: block.taskId });
  res.json(result);
});

/** POST /day/carry-over — move sessions missed on earlier days back onto the to-do list. */
dayRouter.post('/carry-over', async (req, res) => {
  const me = currentUser(req);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
  res.json(await carryOverMissed(me.id, user.timezone));
});
