import { Link } from 'react-router-dom';
import { Logo } from '../components/Layout';

const FEATURES = [
  { title: 'Dependency-aware', body: 'Tasks never get scheduled before their prerequisites finish. Cycles are caught before they are saved.' },
  { title: 'Fits your real week', body: 'Plans around working hours, breaks and fixed commitments — and never moves your fixed events.' },
  { title: 'Deadline risk, early', body: 'Compares remaining effort with available capacity and tells you which tasks put a deadline at risk.' },
  { title: 'Explains itself', body: 'Every recommendation shows why: priority, urgency, critical path and what it unblocks.' },
  { title: 'Replans with a preview', body: 'When something slips, see the before-and-after for downstream work, then approve it.' },
  { title: 'AI that drafts, you decide', body: 'Turn a paragraph into draft tasks and get a daily briefing — nothing changes without your approval.' },
];

/** The spec's example: website launch, 2h on weekdays + 5h on Saturday. */
const EXAMPLE = [
  { day: 'Mon', blocks: [{ t: 'Design DB schema', h: 2, c: '#6366f1' }] },
  { day: 'Tue', blocks: [{ t: 'Design DB schema', h: 1, c: '#6366f1' }, { t: 'Backend APIs', h: 1, c: '#0ea5e9' }] },
  { day: 'Wed', blocks: [{ t: 'Backend APIs', h: 2, c: '#0ea5e9' }] },
  { day: 'Thu', blocks: [{ t: 'Backend APIs', h: 2, c: '#0ea5e9' }] },
  { day: 'Fri', blocks: [{ t: 'Backend APIs', h: 1, c: '#0ea5e9' }, { t: 'Frontend', h: 1, c: '#10b981' }] },
  { day: 'Sat', blocks: [{ t: 'Frontend', h: 4, c: '#10b981' }, { t: 'Testing', h: 1, c: '#f59e0b' }] },
];

export default function Landing() {
  return (
    <div className="min-h-full">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Logo />
        <div className="flex gap-2 text-sm">
          <Link to="/login" className="rounded-lg px-3 py-2 text-muted hover:text-fg">Log in</Link>
          <Link to="/register" className="rounded-lg bg-accent px-3.5 py-2 font-medium text-accent-fg">Get started</Link>
        </div>
      </header>
      <section className="mx-auto grid max-w-6xl items-center gap-10 px-6 py-12 lg:grid-cols-2 lg:py-20">
        <div>
          <p className="mb-3 text-sm font-medium text-accent">Planning that understands your work</p>
          <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">Know what to work on next — and whether you'll make the deadline.</h1>
          <p className="mt-4 max-w-xl text-lg text-muted">Smart Scheduling turns projects, dependencies and estimates into a realistic daily plan that fits your calendar, flags risk early and adapts when things slip.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/register" className="rounded-lg bg-accent px-5 py-3 font-medium text-accent-fg">Build my first plan</Link>
            <Link to="/login" className="rounded-lg border border-border bg-surface px-5 py-3 font-medium">I have an account</Link>
          </div>
        </div>
        <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm" aria-label="Example schedule preview">
          <div className="mb-1 text-sm font-semibold">Website launch — proposed week</div>
          <div className="mb-4 text-xs text-muted">2h available on weekdays, 5h on Saturday · dependencies respected</div>
          <div className="grid grid-cols-6 gap-2">
            {EXAMPLE.map((d) => (
              <div key={d.day}>
                <div className="mb-1 text-center text-xs text-muted">{d.day}</div>
                <div className="flex h-56 flex-col gap-1 rounded-lg bg-surface-2 p-1">
                  {d.blocks.map((b, i) => (
                    <div key={i} className="overflow-hidden rounded-md px-1.5 py-1 text-[10px] font-medium leading-tight text-white" style={{ background: b.c, height: `${(b.h / 5) * 100}%` }}>{b.t}</div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">Launch target Saturday is not feasible: 18h of work, 15h available — 3h of testing and deployment do not fit. Options: move the target to Tuesday, cut 3h of scope, or add capacity.</div>
        </div>
      </section>
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl border border-border bg-surface p-5">
              <h3 className="font-semibold">{f.title}</h3>
              <p className="mt-1 text-sm text-muted">{f.body}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
