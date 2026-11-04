import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { parse } from '../../middleware/validate.js';
import { currentUser } from '../../middleware/auth.js';
import { badRequest, notFound } from '../../utils/errors.js';
import { emitToUser } from '../../realtime/socket.js';
import { serializeUser } from '../users/users.routes.js';
import { buildLifePlan, expandRoutine, PROJECTS, type LifeAnswers, type ProjectKey } from '../../planner/lifePlan.js';
import { answersSchema } from '../../planner/answers.schema.js';
import { requireFeature } from '../../billing/plans.js';

export const plannerRouter = Router();

/** Marks tasks created by "Plan my time" so re-running it replaces them instead of duplicating. */
export const PLANNER_MARKER = '✨ Added by Plan my time';
/** Routine events are created this many days ahead (covers a month-long plan). */
const ROUTINE_DAYS = 35;

const bodySchema = z.object({ answers: answersSchema, dryRun: z.boolean().default(false) });

/** GET /planner — the saved answers (to edit and re-run), persona included. */
plannerRouter.get('/', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: currentUser(req).id } });
  if (!user) throw notFound('User');
  res.json({ persona: user.persona, answers: user.lifeProfile && Object.keys(user.lifeProfile as object).length ? user.lifeProfile : null });
});

/**
 * POST /planner/setup — builds a plan from the answers.
 * dryRun: returns the plan without saving (for the "your week at a glance" preview).
 * Otherwise replaces working hours, the planner's routine events and its
 * not-yet-started tasks, then saves persona and answers. The schedule itself
 * is still generated with POST /schedules/preview and approved by the user.
 */
plannerRouter.post('/setup', async (req, res) => {
  const me = currentUser(req);
  const { answers, dryRun } = parse(bodySchema, req.body);
  const user = await prisma.user.findUnique({ where: { id: me.id } });
  if (!user) throw notFound('User');
  const now = Date.now();
  if (answers.horizon === 'MONTH') requireFeature(user, 'MONTH_PLANNING', now);
  const plan = buildLifePlan(answers as LifeAnswers, { now, tz: user.timezone });
  if (!plan.availability.length) {
    throw badRequest('There is no free time left in your week for tasks. Try fewer days off, a later bedtime or fewer fixed commitments.');
  }
  if (dryRun) {
    res.json({ plan });
    return;
  }

  const workspace = await prisma.workspace.findFirst({ where: { ownerId: me.id }, orderBy: { createdAt: 'asc' } });
  if (!workspace) throw badRequest('Create a workspace first');
  const events = expandRoutine(plan.routine, { now, tz: user.timezone, days: ROUTINE_DAYS });

  const result = await prisma.$transaction(
    async (tx) => {
      await tx.availabilityRule.deleteMany({ where: { userId: me.id } });
      await tx.availabilityRule.createMany({ data: plan.availability.map((w) => ({ ...w, userId: me.id })) });

      await tx.calendarEvent.deleteMany({ where: { userId: me.id, source: 'PLANNER', endAt: { gt: new Date(now) } } });
      if (events.length) await tx.calendarEvent.createMany({ data: events.map((e) => ({ ...e, userId: me.id, source: 'PLANNER' as const })) });

      // Re-running replaces the planner's tasks that haven't been started.
      const removed = await tx.task.deleteMany({
        where: { description: { startsWith: PLANNER_MARKER }, status: 'TODO', actualMinutes: 0, project: { workspaceId: workspace.id } },
      });

      const projectIds = new Map<ProjectKey, string>();
      for (const key of new Set(plan.tasks.map((t) => t.project))) {
        const { name, color } = PROJECTS[key];
        const existing = await tx.project.findFirst({ where: { workspaceId: workspace.id, name, status: { notIn: ['ARCHIVED', 'COMPLETED'] } } });
        projectIds.set(key, existing?.id ?? (await tx.project.create({ data: { workspaceId: workspace.id, name, color, description: PLANNER_MARKER } })).id);
      }

      const ids = new Map<string, string>();
      for (const t of plan.tasks) {
        const created = await tx.task.create({
          data: {
            projectId: projectIds.get(t.project)!,
            assigneeId: me.id,
            title: t.title,
            description: `${PLANNER_MARKER} · ${t.kind.toLowerCase().replace('_', ' ')}`,
            estimatedMinutes: t.estimatedMinutes,
            priority: t.priority,
            splittable: t.splittable,
            earliestStartAt: t.earliestStartAt ? new Date(t.earliestStartAt) : null,
            dueAt: t.dueAt ? new Date(t.dueAt) : null,
          },
        });
        ids.set(t.key, created.id);
      }
      const deps = plan.tasks.flatMap((t) => t.dependsOn.filter((d) => ids.has(d)).map((d) => ({ taskId: ids.get(t.key)!, dependsOnTaskId: ids.get(d)! })));
      if (deps.length) await tx.taskDependency.createMany({ data: deps });

      const updated = await tx.user.update({
        where: { id: me.id },
        data: {
          persona: answers.persona,
          lifeProfile: answers as unknown as Prisma.InputJsonValue,
          focusBlockMinutes: plan.focusBlockMinutes,
          allowTaskSplitting: true,
          onboarded: true,
        },
      });
      return { user: updated, created: plan.tasks.length, removed: removed.count };
    },
    { timeout: 30_000 },
  );

  emitToUser(me.id, 'calendar:updated', { reason: 'planner' });
  emitToUser(me.id, 'task:updated', { reason: 'planner' });
  res.json({
    plan,
    user: serializeUser(result.user),
    summary: { tasksCreated: result.created, tasksReplaced: result.removed, eventsCreated: events.length, availabilitySlots: plan.availability.length },
  });
});
