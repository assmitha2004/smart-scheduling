import { Router } from 'express';
import { z } from 'zod';
import type { User } from '@prisma/client';
import { prisma } from '../../db.js';
import { parse } from '../../middleware/validate.js';
import { currentUser } from '../../middleware/auth.js';
import { badRequest, notFound } from '../../utils/errors.js';
import { isValidTimezone } from '../../utils/time.js';
import { resolvePrefs } from '../notifications/notifications.service.js';
import { emitToUser } from '../../realtime/socket.js';
import { billingSummary } from '../../billing/plans.js';

export function serializeUser(u: User) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    timezone: u.timezone,
    focusBlockMinutes: u.focusBlockMinutes,
    allowTaskSplitting: u.allowTaskSplitting,
    onboarded: u.onboarded,
    scheduleVersion: u.scheduleVersion,
    quietHoursStart: u.quietHoursStart,
    quietHoursEnd: u.quietHoursEnd,
    notificationPrefs: resolvePrefs(u.notificationPrefs),
    aiExternalConsent: u.aiExternalConsent,
    persona: u.persona,
    billing: billingSummary(u),
    calendarFeedEnabled: !!u.calendarFeedToken,
    createdAt: u.createdAt.toISOString(),
  };
}

export const usersRouter = Router();
export const availabilityRouter = Router();

const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Use HH:mm');

const profileSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  timezone: z.string().refine(isValidTimezone, 'Unknown timezone').optional(),
  focusBlockMinutes: z.number().int().min(15).max(480).optional(),
  allowTaskSplitting: z.boolean().optional(),
  onboarded: z.boolean().optional(),
  quietHoursStart: hm.nullable().optional(),
  quietHoursEnd: hm.nullable().optional(),
  aiExternalConsent: z.boolean().optional(),
  persona: z.enum(['STUDENT', 'WORK', 'HYBRID']).nullable().optional(),
  notificationPrefs: z
    .object({
      taskReminders: z.boolean(),
      deadlineRisk: z.boolean(),
      dependencyUnblocked: z.boolean(),
      dailyPlan: z.boolean(),
      reminderLeadMinutes: z.number().int().min(0).max(240),
      dailyPlanHour: z.number().int().min(0).max(23),
    })
    .partial()
    .optional(),
});

usersRouter.get('/me', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: currentUser(req).id } });
  if (!user) throw notFound('User');
  res.json({ user: serializeUser(user) });
});

usersRouter.patch('/me', async (req, res) => {
  const me = currentUser(req);
  const body = parse(profileSchema, req.body);
  const existing = await prisma.user.findUnique({ where: { id: me.id } });
  if (!existing) throw notFound('User');
  const user = await prisma.user.update({
    where: { id: me.id },
    data: {
      ...body,
      notificationPrefs: body.notificationPrefs
        ? { ...resolvePrefs(existing.notificationPrefs), ...body.notificationPrefs }
        : undefined,
    },
  });
  res.json({ user: serializeUser(user) });
});

const ruleSchema = z
  .object({ weekday: z.number().int().min(0).max(6), startTime: hm, endTime: hm, isActive: z.boolean().optional() })
  .refine((r) => r.endTime > r.startTime, 'endTime must be after startTime');
const availabilitySchema = z.object({ rules: z.array(ruleSchema).max(70) });

availabilityRouter.get('/', async (req, res) => {
  const rules = await prisma.availabilityRule.findMany({
    where: { userId: currentUser(req).id },
    orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
  });
  res.json({ rules });
});

/** PUT /availability — replaces the user's weekly working hours. */
availabilityRouter.put('/', async (req, res) => {
  const me = currentUser(req);
  const { rules } = parse(availabilitySchema, req.body);
  // Reject overlapping rules on the same weekday.
  for (let d = 0; d < 7; d++) {
    const day = rules.filter((r) => r.weekday === d).sort((a, b) => a.startTime.localeCompare(b.startTime));
    for (let i = 1; i < day.length; i++) {
      if (day[i].startTime < day[i - 1].endTime) throw badRequest(`Working hours overlap on weekday ${d}`);
    }
  }
  const saved = await prisma.$transaction(async (tx) => {
    await tx.availabilityRule.deleteMany({ where: { userId: me.id } });
    await tx.availabilityRule.createMany({ data: rules.map((r) => ({ ...r, userId: me.id })) });
    return tx.availabilityRule.findMany({ where: { userId: me.id }, orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }] });
  });
  emitToUser(me.id, 'calendar:updated', { reason: 'availability' });
  // Availability changes can invalidate the plan; the client offers a full replan.
  res.json({ rules: saved, replanSuggested: true });
});
