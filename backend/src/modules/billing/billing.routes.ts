import { Router } from 'express';
import { prisma } from '../../db.js';
import { currentUser } from '../../middleware/auth.js';
import { conflict, notFound } from '../../utils/errors.js';
import { billingSummary, FEATURE_LABELS, PLANS, TRIAL_DAYS } from '../../billing/plans.js';
import { serializeUser } from '../users/users.routes.js';

export const billingRouter = Router();

/** Payment checkout is not connected in this deployment; plans and limits are fully enforced. */
const PAYMENTS_ENABLED = process.env.PAYMENTS_ENABLED === 'true';

billingRouter.get('/', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: currentUser(req).id } });
  if (!user) throw notFound('User');
  res.json({
    ...billingSummary(user),
    trialUsed: !!user.trialEndsAt,
    paymentsEnabled: PAYMENTS_ENABLED,
    plans: Object.entries(PLANS).map(([id, p]) => ({ id, name: p.name, priceMonthly: p.priceMonthly, features: p.features.map((f) => FEATURE_LABELS[f]) })),
  });
});

/** POST /billing/trial — one free 14-day Pro trial per account. */
billingRouter.post('/trial', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: currentUser(req).id } });
  if (!user) throw notFound('User');
  if (user.trialEndsAt) throw conflict('TRIAL_USED', 'You have already used your free trial.');
  const updated = await prisma.user.update({ where: { id: user.id }, data: { trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 86_400_000) } });
  res.json({ user: serializeUser(updated) });
});

/** POST /billing/cancel — back to Free now (ends a running trial). Your data is kept. */
billingRouter.post('/cancel', async (req, res) => {
  const me = currentUser(req);
  const user = await prisma.user.findUnique({ where: { id: me.id } });
  if (!user) throw notFound('User');
  const now = new Date();
  const updated = await prisma.user.update({
    where: { id: me.id },
    data: { plan: 'FREE', trialEndsAt: user.trialEndsAt && user.trialEndsAt > now ? now : user.trialEndsAt, calendarFeedToken: null },
  });
  res.json({ user: serializeUser(updated) });
});
