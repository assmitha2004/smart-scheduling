import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, apiError } from '../../services/api';
import { useAuth } from '../../services/auth';
import { Button } from '../../components/ui';
import { useCelebrate } from '../../components/Celebrate';
import type { Feature, User } from '../../types';

export const FEATURE_INFO: Record<Feature, { emoji: string; title: string; blurb: string }> = {
  MONTH_PLANNING: { emoji: '🌙', title: 'Month planning', blurb: 'Plan 30 days ahead: exam seasons, big projects, the whole picture.' },
  CALENDAR_SYNC: { emoji: '🔗', title: 'Calendar sync', blurb: 'See your plan in Google Calendar, Apple Calendar or Outlook on every device.' },
  WEEKLY_REVIEW: { emoji: '📊', title: 'Weekly review', blurb: 'Your wins, follow-through and best day, compared with last week.' },
  TEAM_INVITES: { emoji: '👥', title: 'Team workspace', blurb: 'Invite classmates or teammates and plan shared projects together.' },
};

export function usePlan() {
  const { user } = useAuth();
  const b = user?.billing;
  return {
    isPro: b?.effectivePlan === 'PRO',
    trialing: !!b?.trialing,
    trialDaysLeft: b?.trialDaysLeft ?? 0,
    paidPro: b?.plan === 'PRO',
    has: (f: Feature) => !!b?.features.includes(f),
  };
}

export function ProBadge({ className = '' }: { className?: string }) {
  return <span className={`inline-flex items-center gap-0.5 rounded-full bg-gradient-to-r from-indigo-500 to-fuchsia-500 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white ${className}`}>Pro</span>;
}

/** Starts the one-time 14-day trial. */
export function useStartTrial() {
  const { setUser } = useAuth();
  const { celebrate } = useCelebrate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ user: User }>('/billing/trial');
      setUser(r.data.user);
      celebrate({ emoji: '✨', line: 'Pro unlocked for 14 days!' });
    } catch (e) {
      setError(apiError(e).message);
    } finally {
      setBusy(false);
    }
  };
  return { start, busy, error };
}

/** Shows `children` when the feature is available, otherwise a friendly upsell card. */
export function ProGate({ feature, children, compact }: { feature: Feature; children: ReactNode; compact?: boolean }) {
  const plan = usePlan();
  const { user } = useAuth();
  const trial = useStartTrial();
  if (plan.has(feature)) return <>{children}</>;
  const info = FEATURE_INFO[feature];
  const trialUsed = !!user?.billing.trialEndsAt;
  return (
    <div className={`rounded-xl border border-accent/30 bg-gradient-to-br from-accent-soft/70 to-surface ${compact ? 'p-4' : 'p-6'} text-center`}>
      <div className="text-3xl" aria-hidden>{info.emoji}</div>
      <p className="mt-2 flex items-center justify-center gap-2 font-semibold">{info.title} <ProBadge /></p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted">{info.blurb}</p>
      {trial.error && <p className="mt-2 text-sm text-danger">{trial.error}</p>}
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {!trialUsed && <Button onClick={trial.start} loading={trial.busy}>Start 14-day free trial</Button>}
        <Link to="/app/settings?tab=plan"><Button variant={trialUsed ? 'primary' : 'secondary'}>See plans</Button></Link>
      </div>
      {!trialUsed && <p className="mt-2 text-xs text-muted">No card needed.</p>}
    </div>
  );
}

/** Small banner shown during the trial. */
export function TrialBanner() {
  const plan = usePlan();
  if (!plan.trialing) return null;
  return (
    <Link to="/app/settings?tab=plan" className="block bg-gradient-to-r from-indigo-500 to-fuchsia-500 px-4 py-1.5 text-center text-xs font-medium text-white hover:opacity-95">
      ✨ Pro trial: {plan.trialDaysLeft} day{plan.trialDaysLeft === 1 ? '' : 's'} left. Month planning, calendar sync and weekly reviews are unlocked.
    </Link>
  );
}
