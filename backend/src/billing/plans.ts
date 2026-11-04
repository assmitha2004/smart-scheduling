/**
 * Plans and entitlements. Every Pro-only action is checked on the server
 * with `requireFeature`, so hiding a button in the UI is never the only guard.
 * New accounts start with a 14-day Pro trial; no card is needed.
 */
import { AppError } from '../utils/errors.js';

export type PlanId = 'FREE' | 'PRO';
export type Feature = 'MONTH_PLANNING' | 'CALENDAR_SYNC' | 'WEEKLY_REVIEW' | 'TEAM_INVITES';

export const TRIAL_DAYS = 14;

export const PLANS: Record<PlanId, { name: string; priceMonthly: number; features: Feature[] }> = {
  FREE: { name: 'Free', priceMonthly: 0, features: [] },
  PRO: { name: 'Pro', priceMonthly: 4, features: ['MONTH_PLANNING', 'CALENDAR_SYNC', 'WEEKLY_REVIEW', 'TEAM_INVITES'] },
};

export const FEATURE_LABELS: Record<Feature, string> = {
  MONTH_PLANNING: 'Planning a whole month ahead',
  CALENDAR_SYNC: 'Syncing your plan to Google / Apple Calendar',
  WEEKLY_REVIEW: 'The weekly review',
  TEAM_INVITES: 'Inviting teammates to your workspace',
};

export interface BillingUser {
  plan: string;
  trialEndsAt: Date | null;
}

export function isTrialing(u: BillingUser, now = Date.now()): boolean {
  return u.plan !== 'PRO' && !!u.trialEndsAt && u.trialEndsAt.getTime() > now;
}

/** The plan whose features apply right now. */
export function effectivePlan(u: BillingUser, now = Date.now()): PlanId {
  return u.plan === 'PRO' || isTrialing(u, now) ? 'PRO' : 'FREE';
}

export function can(u: BillingUser, feature: Feature, now = Date.now()): boolean {
  return PLANS[effectivePlan(u, now)].features.includes(feature);
}

export function trialDaysLeft(u: BillingUser, now = Date.now()): number {
  return isTrialing(u, now) ? Math.ceil((u.trialEndsAt!.getTime() - now) / 86_400_000) : 0;
}

export function upgradeRequired(feature: Feature): AppError {
  return new AppError(403, 'UPGRADE_REQUIRED', `${FEATURE_LABELS[feature]} is a Pro feature. Start your free trial or upgrade to use it.`, { feature });
}

export function requireFeature(u: BillingUser, feature: Feature, now = Date.now()): void {
  if (!can(u, feature, now)) throw upgradeRequired(feature);
}

export function billingSummary(u: BillingUser, now = Date.now()) {
  const eff = effectivePlan(u, now);
  return {
    plan: u.plan as PlanId,
    effectivePlan: eff,
    trialing: isTrialing(u, now),
    trialEndsAt: u.trialEndsAt?.toISOString() ?? null,
    trialDaysLeft: trialDaysLeft(u, now),
    features: PLANS[eff].features,
  };
}
