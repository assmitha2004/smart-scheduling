import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { parse } from '../../middleware/validate.js';
import { currentUser } from '../../middleware/auth.js';
import { badRequest, conflict, notFound } from '../../utils/errors.js';
import { expandAvailability, formatInstant } from '../../engine/index.js';
import { logActivity } from '../activity/activity.service.js';
import { emitToUser } from '../../realtime/socket.js';
import { scheduleBlockReminders } from '../../queues/index.js';
import { resolvePrefs } from '../notifications/notifications.service.js';

export const calendarRouter = Router();

const rangeSchema = z.object({ from: z.coerce.date(), to: z.coerce.date() }).refine((r) => r.to > r.from, 'to must be after from');
const eventSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    startAt: z.coerce.date(),
    endAt: z.coerce.date(),
    eventType: z.enum(['FIXED', 'BREAK', 'UNAVAILABLE']).default('FIXED'),
  })
  .refine((e) => e.endAt > e.startAt, 'endAt must be after startAt');

/** GET /calendar?from&to — fixed events, task blocks and working hours in one call. */
calendarRouter.get('/', async (req, res) => {
  const me = currentUser(req);
  const now = Date.now();
  const { from, to } = parse(rangeSchema, {
    from: req.query.from ?? new Date(now - 7 * 86_400_000),
    to: req.query.to ?? new Date(now + 28 * 86_400_000),
  });
  if (to.getTime() - from.getTime() > 400 * 86_400_000) throw badRequest('Range too large (max 400 days)');
  const projectIds = typeof req.query.projectId === 'string' ? req.query.projectId.split(',') : undefined;
  const [user, events, blocks] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: me.id }, include: { availabilityRules: true } }),
    prisma.calendarEvent.findMany({ where: { userId: me.id, startAt: { lt: to }, endAt: { gt: from } }, orderBy: { startAt: 'asc' } }),
    prisma.scheduledBlock.findMany({
      where: {
        userId: me.id,
        status: { in: ['CONFIRMED', 'COMPLETED'] },
        startAt: { lt: to },
        endAt: { gt: from },
        ...(projectIds ? { task: { projectId: { in: projectIds } } } : {}),
      },
      include: { task: { select: { id: true, title: true, status: true, priority: true, dueAt: true, projectId: true, project: { select: { name: true, color: true } } } } },
      orderBy: { startAt: 'asc' },
    }),
  ]);
  const working = expandAvailability(user.availabilityRules, user.timezone, from.getTime(), to.getTime());
  res.json({
    timezone: user.timezone,
    scheduleVersion: user.scheduleVersion,
    events,
    blocks: blocks.map((b) => ({
      id: b.id,
      taskId: b.taskId,
      startAt: b.startAt,
      endAt: b.endAt,
      status: b.status,
      scheduleVersion: b.scheduleVersion,
      title: b.task.title,
      taskStatus: b.task.status,
      priority: b.task.priority,
      dueAt: b.task.dueAt,
      projectId: b.task.projectId,
      projectName: b.task.project.name,
      color: b.task.project.color,
    })),
    workingHours: working.map((w) => ({ startAt: new Date(w.start).toISOString(), endAt: new Date(w.end).toISOString() })),
  });
});

calendarRouter.post('/events', async (req, res) => {
  const me = currentUser(req);
  const body = parse(eventSchema, req.body);
  const event = await prisma.calendarEvent.create({ data: { ...body, userId: me.id, source: 'MANUAL' } });
  const clashing = await blocksClashingWith(me.id, body.startAt, body.endAt);
  emitToUser(me.id, 'calendar:updated', { reason: 'event' });
  res.status(201).json({ event, conflictingBlocks: clashing, replanSuggested: clashing.length > 0 });
});

calendarRouter.patch('/events/:id', async (req, res) => {
  const me = currentUser(req);
  const existing = await prisma.calendarEvent.findFirst({ where: { id: req.params.id, userId: me.id } });
  if (!existing) throw notFound('Event');
  const merged = parse(eventSchema, { ...existing, ...req.body });
  const event = await prisma.calendarEvent.update({ where: { id: existing.id }, data: merged });
  const clashing = await blocksClashingWith(me.id, event.startAt, event.endAt);
  emitToUser(me.id, 'calendar:updated', { reason: 'event' });
  res.json({ event, conflictingBlocks: clashing, replanSuggested: clashing.length > 0 });
});

calendarRouter.delete('/events/:id', async (req, res) => {
  const me = currentUser(req);
  const r = await prisma.calendarEvent.deleteMany({ where: { id: req.params.id, userId: me.id } });
  if (!r.count) throw notFound('Event');
  emitToUser(me.id, 'calendar:updated', { reason: 'event' });
  res.status(204).end();
});

async function blocksClashingWith(userId: string, start: Date, end: Date) {
  const blocks = await prisma.scheduledBlock.findMany({
    where: { userId, status: 'CONFIRMED', startAt: { lt: end }, endAt: { gt: start } },
    include: { task: { select: { title: true } } },
  });
  return blocks.map((b) => ({ id: b.id, taskId: b.taskId, title: b.task.title, startAt: b.startAt, endAt: b.endAt }));
}

export interface BlockIssue {
  severity: 'error' | 'warning';
  type: 'INVALID' | 'PAST' | 'FIXED_EVENT' | 'BLOCK_OVERLAP' | 'OUTSIDE_AVAILABILITY' | 'DEPENDENCY' | 'DOWNSTREAM' | 'DEADLINE';
  message: string;
}

/**
 * Validates moving a block. Errors are hard rules (fixed commitments,
 * double booking, starting before a prerequisite finishes); warnings need
 * explicit acknowledgement.
 */
export async function checkBlockMove(userId: string, blockId: string, startAt: Date, endAt: Date): Promise<BlockIssue[]> {
  const block = await prisma.scheduledBlock.findFirst({
    where: { id: blockId, userId },
    include: {
      task: {
        include: {
          dependencies: { include: { dependsOn: { include: { blocks: { where: { status: { in: ['CONFIRMED', 'COMPLETED'] } } } } } } },
          dependents: { include: { task: { include: { blocks: { where: { status: 'CONFIRMED' } } } } } },
        },
      },
    },
  });
  if (!block) throw notFound('Block');
  if (block.status !== 'CONFIRMED') throw badRequest('Only confirmed blocks can be moved');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { availabilityRules: true } });
  const tz = user.timezone;
  const s = startAt.getTime();
  const e = endAt.getTime();
  const issues: BlockIssue[] = [];
  if (e <= s) return [{ severity: 'error', type: 'INVALID', message: 'The block must end after it starts.' }];
  if (s < Date.now() - 60_000) issues.push({ severity: 'error', type: 'PAST', message: 'Blocks cannot be moved into the past.' });

  const [events, others] = await Promise.all([
    prisma.calendarEvent.findMany({ where: { userId, startAt: { lt: endAt }, endAt: { gt: startAt } } }),
    prisma.scheduledBlock.findMany({
      where: { userId, status: 'CONFIRMED', id: { not: blockId }, startAt: { lt: endAt }, endAt: { gt: startAt } },
      include: { task: { select: { title: true } } },
    }),
  ]);
  for (const ev of events) {
    issues.push({ severity: 'error', type: 'FIXED_EVENT', message: `Clashes with "${ev.title}" (${ev.eventType.toLowerCase()}), which cannot be moved.` });
  }
  for (const o of others) {
    issues.push({ severity: 'error', type: 'BLOCK_OVERLAP', message: `Overlaps the block for "${o.task.title}".` });
  }

  const working = expandAvailability(user.availabilityRules, tz, s - 86_400_000, e + 86_400_000);
  if (!working.some((w) => w.start <= s && e <= w.end)) {
    issues.push({ severity: 'warning', type: 'OUTSIDE_AVAILABILITY', message: 'This time is outside your working hours.' });
  }

  for (const d of block.task.dependencies) {
    const p = d.dependsOn;
    if (p.status === 'DONE' || p.status === 'CANCELLED') continue;
    const pEnd = Math.max(-Infinity, ...p.blocks.map((b) => b.endAt.getTime()));
    if (!p.blocks.length) {
      issues.push({ severity: 'warning', type: 'DEPENDENCY', message: `Prerequisite "${p.title}" is not done and not scheduled yet.` });
    } else if (pEnd > s) {
      issues.push({ severity: 'error', type: 'DEPENDENCY', message: `Starts before prerequisite "${p.title}" is planned to finish (${formatInstant(pEnd, tz)}).` });
    }
  }
  // The other blocks of this task stay put; the task finishes at its latest block.
  const siblingEnds = await prisma.scheduledBlock.findMany({ where: { taskId: block.taskId, status: 'CONFIRMED', id: { not: blockId } }, select: { endAt: true } });
  const taskFinish = Math.max(e, ...siblingEnds.map((b) => b.endAt.getTime()));
  for (const d of block.task.dependents) {
    const dep = d.task;
    if (dep.status === 'DONE' || dep.status === 'CANCELLED' || !dep.blocks.length) continue;
    const firstStart = Math.min(...dep.blocks.map((b) => b.startAt.getTime()));
    if (firstStart < taskFinish) {
      issues.push({ severity: 'warning', type: 'DOWNSTREAM', message: `"${dep.title}" is scheduled to start before this finishes; it will need replanning.` });
    }
  }
  if (block.task.dueAt && taskFinish > block.task.dueAt.getTime()) {
    issues.push({ severity: 'warning', type: 'DEADLINE', message: `"${block.task.title}" would finish after its deadline (${formatInstant(block.task.dueAt.getTime(), tz)}).` });
  }
  return issues;
}

const moveSchema = z.object({
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  acknowledgeWarnings: z.boolean().optional(),
  expectedVersion: z.number().int().optional(),
});

/** POST /calendar/blocks/:id/check — dry-run used by drag-and-drop before saving. */
calendarRouter.post('/blocks/:id/check', async (req, res) => {
  const me = currentUser(req);
  const body = parse(moveSchema, req.body);
  const issues = await checkBlockMove(me.id, req.params.id, body.startAt, body.endAt);
  res.json({ ok: !issues.some((i) => i.severity === 'error'), issues });
});

/** PATCH /calendar/blocks/:id — move/resize a block after validation. */
calendarRouter.patch('/blocks/:id', async (req, res) => {
  const me = currentUser(req);
  const body = parse(moveSchema, req.body);
  const issues = await checkBlockMove(me.id, req.params.id, body.startAt, body.endAt);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length) throw conflict('BLOCK_CONFLICT', errors[0].message, { issues });
  const warnings = issues.filter((i) => i.severity === 'warning');
  if (warnings.length && !body.acknowledgeWarnings) {
    throw conflict('WARNINGS_NOT_ACKNOWLEDGED', 'This change has warnings. Review and confirm to continue.', { issues });
  }
  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUniqueOrThrow({ where: { id: me.id } });
    if (body.expectedVersion != null && body.expectedVersion !== user.scheduleVersion) {
      throw conflict('STALE_SCHEDULE', 'Your schedule changed in another session. Reload and try again.', {
        expectedVersion: body.expectedVersion,
        currentVersion: user.scheduleVersion,
      });
    }
    const cas = await tx.user.updateMany({ where: { id: me.id, scheduleVersion: user.scheduleVersion }, data: { scheduleVersion: { increment: 1 } } });
    if (!cas.count) throw conflict('STALE_SCHEDULE', 'Your schedule changed concurrently. Reload and try again.');
    // Exclusion constraint still guards against a concurrent overlapping write.
    const block = await tx.scheduledBlock.update({
      where: { id: req.params.id },
      data: { startAt: body.startAt, endAt: body.endAt, scheduleVersion: user.scheduleVersion + 1 },
    });
    await logActivity({ actorId: me.id, entityType: 'block', entityId: block.id, action: 'block.moved', metadata: { startAt: body.startAt.toISOString(), endAt: body.endAt.toISOString() } }, tx);
    return { block, scheduleVersion: user.scheduleVersion + 1 };
  });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
  await scheduleBlockReminders([result.block], resolvePrefs(user.notificationPrefs).reminderLeadMinutes).catch(() => undefined);
  emitToUser(me.id, 'schedule:updated', { scheduleVersion: result.scheduleVersion });
  res.json({ ...result, issues, replanSuggested: warnings.some((w) => w.type === 'DOWNSTREAM' || w.type === 'DEADLINE') });
});

/** POST /calendar/blocks/:id/complete — mark a block done and log its time. */
calendarRouter.post('/blocks/:id/complete', async (req, res) => {
  const me = currentUser(req);
  const block = await prisma.scheduledBlock.findFirst({ where: { id: req.params.id, userId: me.id }, include: { task: true } });
  if (!block) throw notFound('Block');
  if (block.status !== 'CONFIRMED') throw badRequest('Block is not active');
  const minutes = Math.round((block.endAt.getTime() - block.startAt.getTime()) / 60_000);
  await prisma.$transaction([
    prisma.scheduledBlock.update({ where: { id: block.id }, data: { status: 'COMPLETED' } }),
    prisma.task.update({
      where: { id: block.taskId },
      data: { actualMinutes: { increment: minutes }, version: { increment: 1 }, status: block.task.status === 'TODO' ? 'IN_PROGRESS' : undefined },
    }),
  ]);
  emitToUser(me.id, 'schedule:updated', {});
  res.json({ ok: true, loggedMinutes: minutes });
});
