import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { parse } from '../../middleware/validate.js';
import { currentUser } from '../../middleware/auth.js';
import { commitRecommendation, dismissRecommendation, previewReplan, previewSchedule } from './scheduling.service.js';

export const schedulesRouter = Router();

/** POST /schedules/preview — generate a proposed schedule (nothing is saved to the calendar). */
const previewSchema = z.object({
  horizon: z.enum(['DAY', 'WEEK', 'MONTH']).optional(),
  /** How the user feels: LOW plans shorter sessions and a lighter load. */
  energy: z.enum(['LOW', 'OK', 'HIGH']).optional(),
  /** DAY only: "I can work today from … until …" (local HH:mm), used instead of the usual working hours. */
  window: z
    .object({ from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), until: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/) })
    .refine((w) => w.until > w.from, 'The end time must be after the start time')
    .optional(),
});
schedulesRouter.post('/preview', async (req, res) => {
  const { horizon, energy, window } = parse(previewSchema, req.body ?? {});
  res.json(await previewSchedule(currentUser(req).id, Date.now(), horizon, energy, horizon === 'DAY' ? window : undefined));
});

const commitSchema = z.object({
  recommendationId: z.string().uuid(),
  /** The scheduleVersion returned by the preview (optimistic concurrency). */
  expectedVersion: z.number().int().min(0),
  /** Tasks the user rejected; their downstream dependents are excluded too. */
  excludeTaskIds: z.array(z.string().uuid()).optional(),
});

/** POST /schedules/commit — approve a preview or replan. 409 if the schedule changed meanwhile. */
schedulesRouter.post('/commit', async (req, res) => {
  const body = parse(commitSchema, req.body);
  res.json(await commitRecommendation(currentUser(req).id, body));
});

const replanSchema = z
  .object({
    changes: z
      .array(
        z.object({
          taskId: z.string().uuid(),
          delayUntil: z.string().datetime({ offset: true }).optional(),
          estimatedMinutes: z.number().int().min(0).max(100_000).optional(),
          priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
        }),
      )
      .max(100)
      .optional(),
    taskIds: z.array(z.string().uuid()).max(500).optional(),
    full: z.boolean().optional(),
  })
  .refine((b) => b.full || b.changes?.length || b.taskIds?.length, 'Provide changes, taskIds or full: true');

/** POST /schedules/replan — preview the impact of a delay / estimate change on downstream work. */
schedulesRouter.post('/replan', async (req, res) => {
  const body = parse(replanSchema, req.body);
  res.json(await previewReplan(currentUser(req).id, body));
});

schedulesRouter.get('/recommendations', async (req, res) => {
  const recs = await prisma.scheduleRecommendation.findMany({
    where: { userId: currentUser(req).id },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, recommendationType: true, reason: true, status: true, baseVersion: true, createdAt: true, resolvedAt: true },
  });
  res.json({ recommendations: recs });
});

schedulesRouter.post('/recommendations/:id/dismiss', async (req, res) => {
  await dismissRecommendation(currentUser(req).id, req.params.id);
  res.status(204).end();
});
