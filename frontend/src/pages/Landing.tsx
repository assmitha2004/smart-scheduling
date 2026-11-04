import { useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { FaqList, MarketingShell } from './Public';
import type { Persona } from '../types';

const PERSONA_TABS: { id: Persona; emoji: string; label: string; headline: string; points: string[]; insight: string }[] = [
  {
    id: 'STUDENT', emoji: '🎒', label: 'Students', headline: 'Ace exams without all-nighters',
    points: ['Builds study time around your class timetable', 'Spaces exam revision out so it actually sticks', 'Splits big assignments into research → draft → polish', 'Exam countdown, focus timer and study streaks'],
    insight: 'Physics exam on Fri 13 Nov: 4 revision sessions spaced out so it really sticks 🧠',
  },
  {
    id: 'WORK', emoji: '💼', label: 'Professionals', headline: 'Deep work that survives your meetings',
    points: ['Fits work tasks into your hours, around every meeting', 'Puts your hardest work where your energy is', 'Flags deadlines at risk days before they slip', 'Keeps personal time for the gym, learning and rest'],
    insight: 'Your work tasks go inside 9am–5pm; meetings and lunch are blocked out so nothing lands on top of them.',
  },
  {
    id: 'HYBRID', emoji: '🎓', label: 'Work + study', headline: 'Balance a job and your degree',
    points: ['Work shifts are fixed, study fills the gaps', 'Keeps at least one evening a week free', 'Work/study balance meter for every week', 'Re-plans instantly when a shift changes'],
    insight: 'You’re a night owl 🦉, so your focus time sits in the evening. I found 17h 30m of focus time a week around your work.',
  },
];

const FEATURES = [
  { emoji: '🦉', title: 'Plans by asking, not by forms', body: 'Tempo asks a few friendly questions and builds your routine. No blank calendar to fill in.' },
  { emoji: '⚡', title: 'Your energy, respected', body: 'Early bird, daytime or night owl: focus time lands when your brain is sharpest.' },
  { emoji: '🔗', title: 'Dependencies, handled', body: 'Nothing is scheduled before what it depends on. Loops are caught before they’re saved.' },
  { emoji: '🚨', title: 'Deadline risk, early', body: 'Compares the work left with the time you have, and tells you honestly if it won’t fit.' },
  { emoji: '🔄', title: 'Replans with a preview', body: 'Something slipped? See the before/after for everything downstream, then approve.' },
  { emoji: '💬', title: 'Explains every choice', body: '“Due in 4 days · on the critical path · unblocks 3 tasks”. Never a black box.' },
  { emoji: '📱', title: 'On every device', body: 'Install it like an app and sync your plan into Google or Apple Calendar.' },
  { emoji: '🎉', title: 'Actually fun to use', body: 'Confetti when you finish, streaks, XP, levels and badges to keep you going.' },
];

const STEPS = [
  { n: '1', title: 'Answer a few questions', body: 'Student, working or both? Your timetable, deadlines, energy and habits. About 2 minutes.' },
  { n: '2', title: 'See your week at a glance', body: 'Classes, work and meals blocked out, focus time where you’re sharpest, smart tasks ready.' },
  { n: '3', title: 'Follow the plan, celebrate wins', body: 'Plan your day, week or month. Tick tasks off, keep your streak, level up.' },
];

/** Static hero illustration of a planned week (not real user data). */
const WEEK = [
  { d: 'Mon', b: [['🎓 Class', 18, 22, '#8b5cf6'], ['🧠 Revise', 62, 16, '#6366f1'], ['🌱 Read', 82, 8, '#10b981']] },
  { d: 'Tue', b: [['💼 Report', 30, 20, '#0ea5e9'], ['✍️ Draft', 60, 18, '#6366f1']] },
  { d: 'Wed', b: [['🎓 Class', 18, 22, '#8b5cf6'], ['🧠 Revise', 62, 14, '#6366f1'], ['🏃 Gym', 80, 9, '#ec4899']] },
  { d: 'Thu', b: [['👥 Sync', 26, 8, '#f59e0b'], ['✍️ Draft', 58, 20, '#6366f1']] },
  { d: 'Fri', b: [['✅ Polish', 40, 16, '#6366f1'], ['⚡ Recap', 64, 12, '#6366f1']] },
  { d: 'Sat', b: [['🏃 Gym', 30, 10, '#ec4899'], ['🔁 Review', 52, 12, '#6366f1']] },
  { d: 'Sun', b: [] as (string | number)[][] },
] as { d: string; b: [string, number, number, string][] }[];

function HeroPreview() {
  return (
    <div className="relative">
      <div className="absolute -inset-4 -z-10 rounded-[2rem] bg-gradient-to-br from-indigo-500/20 via-fuchsia-500/10 to-transparent blur-2xl" aria-hidden />
      <div className="rounded-2xl border border-border bg-surface p-4 shadow-xl sm:p-5" role="img" aria-label="Illustration of a planned week with classes, study and gym blocks">
        <div className="mb-3 flex items-center justify-between">
          <div><div className="text-sm font-semibold">Your week, planned ✨</div><div className="text-xs text-muted">Night owl · 3h study / day · Sundays off</div></div>
          <span className="rounded-full bg-ok-soft px-2 py-0.5 text-xs font-medium text-ok">All deadlines fit</span>
        </div>
        <div className="grid grid-cols-7 gap-1.5">
          {WEEK.map((day) => (
            <div key={day.d}>
              <div className="relative h-52 rounded-lg bg-surface-2">
                {day.b.length === 0 && <div className="absolute inset-0 flex items-center justify-center text-lg" aria-hidden>🌿</div>}
                {day.b.map(([t, top, h, c], i) => (
                  <div key={i} className="absolute inset-x-0.5 overflow-hidden rounded-md px-1 py-0.5 text-[9px] font-medium leading-tight text-white" style={{ top: `${top}%`, height: `${h}%`, background: c }}>{t}</div>
                ))}
              </div>
              <div className="mt-1 text-center text-[11px] text-muted">{day.d}</div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-accent-soft/60 p-2.5 text-xs">
          <span className="text-lg" aria-hidden>🦉</span>
          <span>Physics exam Friday: 4 revision sessions spaced out so it sticks. Your essay is split into research → draft → polish.</span>
        </div>
      </div>
      <div className="celebrate-pop absolute -bottom-5 -right-2 hidden rounded-xl border border-border bg-surface px-3 py-2 text-sm shadow-lg sm:block" aria-hidden>🎉 Look at you go! <span className="text-muted">+25 XP</span></div>
    </div>
  );
}

export default function Landing() {
  const [tab, setTab] = useState<Persona>('STUDENT');
  const persona = PERSONA_TABS.find((p) => p.id === tab)!;
  return (
    <MarketingShell>
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-14 sm:px-6 lg:grid-cols-2 lg:py-20">
        <div>
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent-soft px-3 py-1 text-sm font-medium text-accent">🦉 For students, professionals, and everyone doing both</p>
          <h1 className="text-4xl font-bold leading-[1.1] tracking-tight sm:text-5xl lg:text-6xl">
            Your whole week, <span className="bg-gradient-to-r from-indigo-500 to-fuchsia-500 bg-clip-text text-transparent">planned in 2 minutes.</span>
          </h1>
          <p className="mt-5 max-w-xl text-lg text-muted">Answer a few friendly questions. Smart Scheduling builds a plan around your classes, work, energy and deadlines, then adapts when life happens.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/register" className="rounded-xl bg-accent px-6 py-3.5 font-semibold text-accent-fg shadow-lg shadow-accent/25 hover:opacity-95">Plan my week, free →</Link>
            <a href="#how" className="rounded-xl border border-border bg-surface px-6 py-3.5 font-medium hover:bg-surface-2">See how it works</a>
          </div>
          <p className="mt-4 text-sm text-muted">Free · every feature included · works on any device</p>
        </div>
        <HeroPreview />
      </section>

      <section className="border-y border-border bg-surface py-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <h2 className="text-center text-3xl font-semibold tracking-tight">Built for how you actually live</h2>
          <div className="mx-auto mt-6 flex max-w-md justify-center gap-1 rounded-xl bg-surface-2 p-1" role="tablist">
            {PERSONA_TABS.map((p) => (
              <button key={p.id} role="tab" aria-selected={tab === p.id} onClick={() => setTab(p.id)}
                className={clsx('flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors', tab === p.id ? 'bg-surface shadow-sm' : 'text-muted hover:text-fg')}>
                {p.emoji} {p.label}
              </button>
            ))}
          </div>
          <div key={tab} className="wizard-step mt-10 grid items-center gap-10 lg:grid-cols-2">
            <div>
              <h3 className="text-2xl font-semibold">{persona.headline}</h3>
              <ul className="mt-5 space-y-3">
                {persona.points.map((pt) => <li key={pt} className="flex gap-3"><span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ok-soft text-xs text-ok">✓</span><span>{pt}</span></li>)}
              </ul>
            </div>
            <div className="flex items-start gap-3">
              <div className="tempo-bob flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent-soft text-2xl" aria-hidden>🦉</div>
              <div className="rounded-2xl rounded-tl-sm border border-border bg-bg p-4 text-[15px] shadow-sm">
                <p className="mb-1 text-xs font-medium text-accent">Tempo, your planning buddy</p>
                {persona.insight}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="how" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16 sm:px-6">
        <h2 className="text-center text-3xl font-semibold tracking-tight">How it works</h2>
        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n} className="rounded-2xl border border-border bg-surface p-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-lg font-bold text-accent-fg">{s.n}</div>
              <h3 className="mt-4 text-lg font-semibold">{s.title}</h3>
              <p className="mt-1 text-muted">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="features" className="scroll-mt-20 bg-surface py-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <h2 className="text-center text-3xl font-semibold tracking-tight">Smart where it matters</h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-muted">A real scheduling engine (dependency graphs, critical path, deadline checks) wrapped in an app that feels friendly.</p>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f) => (
              <div key={f.title} className="rounded-2xl border border-border bg-bg p-5 transition-transform hover:-translate-y-0.5">
                <div className="text-2xl" aria-hidden>{f.emoji}</div>
                <h3 className="mt-3 font-semibold">{f.title}</h3>
                <p className="mt-1 text-sm text-muted">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <h2 className="mb-6 text-center text-3xl font-semibold tracking-tight">Questions</h2>
        <FaqList />
      </section>

      <section className="px-4 pb-20 sm:px-6">
        <div className="mx-auto max-w-4xl rounded-3xl bg-gradient-to-br from-indigo-600 to-fuchsia-600 px-6 py-12 text-center text-white shadow-xl">
          <h2 className="text-3xl font-bold tracking-tight">Ready to get your time back?</h2>
          <p className="mx-auto mt-3 max-w-xl text-white/85">Two minutes of questions. A week that finally makes sense.</p>
          <Link to="/register" className="mt-8 inline-block rounded-xl bg-white px-6 py-3.5 font-semibold text-indigo-700 hover:bg-white/90">Start planning →</Link>
        </div>
      </section>
    </MarketingShell>
  );
}
