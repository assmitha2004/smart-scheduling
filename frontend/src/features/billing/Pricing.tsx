import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { ProBadge } from './plan';

export const FREE_FEATURES = [
  'Plan my day & Plan my week',
  'Tempo’s questions for students, workers or both',
  'Smart engine: deadlines, dependencies, replanning',
  'Calendar, timeline and analytics',
  'Focus timer, streaks, XP & badges',
  'AI task drafts (built-in parser)',
  'Export your data any time',
];
export const PRO_FEATURES = [
  'Everything in Free',
  '🌙 Plan a whole month ahead',
  '🔗 Sync to Google / Apple Calendar',
  '📊 Weekly review with your wins',
  '👥 Invite classmates or teammates',
];

function Check({ children }: { children: string }) {
  return <li className="flex gap-2"><span className="text-ok" aria-hidden>✓</span><span>{children}</span></li>;
}

/** Plan cards for the landing page, /pricing and Settings → Plan. */
export function PricingCards({ current, action }: { current?: 'FREE' | 'PRO'; action?: (plan: 'FREE' | 'PRO') => React.ReactNode }) {
  const cards = [
    { id: 'FREE' as const, name: 'Free', price: '$0', period: 'forever', blurb: 'Everything you need to plan your days and weeks.', features: FREE_FEATURES },
    { id: 'PRO' as const, name: 'Pro', price: '$4', period: 'per month', blurb: 'For exam seasons, busy jobs and the big picture.', features: PRO_FEATURES },
  ];
  return (
    <div className="grid gap-5 md:grid-cols-2">
      {cards.map((c) => (
        <div key={c.id} className={clsx('relative flex flex-col rounded-2xl border bg-surface p-6', c.id === 'PRO' ? 'border-accent shadow-lg shadow-accent/10' : 'border-border')}>
          {c.id === 'PRO' && <span className="absolute -top-3 left-6 rounded-full bg-accent px-3 py-1 text-xs font-semibold text-accent-fg">14-day free trial</span>}
          <div className="flex items-center gap-2 text-lg font-semibold">{c.name} {c.id === 'PRO' && <ProBadge />} {current === c.id && <span className="ml-auto rounded-full bg-ok-soft px-2 py-0.5 text-xs font-medium text-ok">Your plan</span>}</div>
          <p className="mt-1 text-sm text-muted">{c.blurb}</p>
          <p className="mt-4"><span className="text-4xl font-bold tracking-tight">{c.price}</span> <span className="text-sm text-muted">{c.period}</span></p>
          <ul className="mt-5 flex-1 space-y-2 text-sm">{c.features.map((f) => <Check key={f}>{f}</Check>)}</ul>
          <div className="mt-6">
            {action ? action(c.id) : (
              <Link to="/register" className={clsx('block rounded-lg px-4 py-2.5 text-center text-sm font-medium', c.id === 'PRO' ? 'bg-accent text-accent-fg' : 'border border-border hover:bg-surface-2')}>
                {c.id === 'PRO' ? 'Start free trial' : 'Get started free'}
              </Link>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
