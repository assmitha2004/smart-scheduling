import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, apiError } from '../../services/api';
import { useAuth } from '../../services/auth';
import { Button, ErrorBox, Input, Select, Spinner } from '../../components/ui';
import { fmtMinutes } from '../../lib/format';
import type { LifeAnswers, LifePlan, Priority, User } from '../../types';
import { ChoiceCard, Chip, DayChips, ListEditor, SlotList, Tempo, TimeInput } from './controls';
import { ACTIVITY_IDEAS, CHRONOTYPES, FOCUS_STYLES, HABIT_IDEAS, MEETING_IDEAS, PERSONAS, SUBJECT_IDEAS, studies, works } from './templates';
import { WeekGlance } from './WeekGlance';

export interface PlannerResult {
  plan: LifePlan;
  user: User;
  summary: { tasksCreated: number; tasksReplaced: number; eventsCreated: number; availabilitySlots: number };
}

interface Step {
  id: string;
  mood?: string;
  say: ReactNode;
  body: ReactNode;
  validate?: () => string | null;
}

const toMin = (hm: string) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const todayIso = () => new Date().toISOString().slice(0, 10);
const COMMUTES = [0, 10, 20, 30, 45, 60, 90];
const DIFFICULTY: { v: 1 | 2 | 3; emoji: string; label: string }[] = [
  { v: 1, emoji: '😌', label: 'Easy' },
  { v: 2, emoji: '🙂', label: 'Okay' },
  { v: 3, emoji: '😵', label: 'Tough' },
];

/** Drops half-filled rows so a forgotten empty line never blocks the plan. */
function clean(a: LifeAnswers): LifeAnswers {
  const named = <T extends { title: string }>(xs: T[]) => xs.map((x) => ({ ...x, title: x.title.trim() })).filter((x) => x.title);
  return {
    ...a,
    classes: named(a.classes).filter((c) => c.weekdays.length),
    meetings: named(a.meetings).filter((c) => c.weekdays.length),
    activities: named(a.activities).filter((c) => c.weekdays.length),
    habits: named(a.habits).filter((h) => h.weekdays.length),
    assignments: named(a.assignments).filter((x) => x.dueDate && x.hours > 0),
    workTasks: named(a.workTasks).filter((x) => x.hours > 0).map((x) => ({ ...x, dueDate: x.dueDate || null })),
    exams: a.exams.filter((e) => e.subject.trim() && e.date).map((e) => ({ ...e, subject: e.subject.trim() })),
    subjects: a.subjects.filter((s) => s.name.trim()),
  };
}

function slotError(xs: { title: string; start: string; end: string }[], what: string): string | null {
  const bad = xs.find((x) => x.title.trim() && toMin(x.end) <= toMin(x.start));
  return bad ? `${what} "${bad.title}" ends before it starts. Check the times? 🕐` : null;
}

export function PlanWizard({ initial, onApplied, onCancel, intro }: { initial: LifeAnswers; onApplied: (r: PlannerResult) => void; onCancel?: () => void; intro?: ReactNode }) {
  const { user } = useAuth();
  const first = user?.name.split(' ')[0] ?? 'friend';
  const [a, setA] = useState<LifeAnswers>(initial);
  const [i, setI] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<LifePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [customSubject, setCustomSubject] = useState('');
  const set = (patch: Partial<LifeAnswers>) => { setA((x) => ({ ...x, ...patch })); setPlan(null); };
  const p = a.persona;
  const persona = PERSONAS.find((x) => x.id === p)!;
  const sleepH = ((toMin(a.wakeTime) - toMin(a.sleepTime) + 1440) % 1440 || 1440) / 60;

  const steps: Step[] = useMemo(() => {
    const s: Step[] = [];
    s.push({
      id: 'horizon',
      mood: '👋',
      say: <>{intro ?? <>Hi {first}! I'm <b>Tempo</b>, your planning buddy. Let's build a schedule that actually fits your life. {persona.emoji}</>} First up: how far ahead should I plan?</>,
      body: (
        <div className="flex flex-col gap-3 sm:flex-row">
          <ChoiceCard selected={a.horizon === 'DAY'} onClick={() => set({ horizon: 'DAY' })} emoji="📅" title="Just today" blurb="Make the most of today" />
          <ChoiceCard selected={a.horizon === 'WEEK'} onClick={() => set({ horizon: 'WEEK' })} emoji="🗓️" title="This week" blurb="The sweet spot for most people" />
          <ChoiceCard selected={a.horizon === 'MONTH'} onClick={() => set({ horizon: 'MONTH' })} emoji="🌙" title="This month" blurb="Big picture: exams, projects" />
        </div>
      ),
    });
    s.push({
      id: 'rhythm',
      mood: '⏰',
      say: <>When does your day usually start and end? And when does your brain feel sharpest?</>,
      validate: () => (sleepH < 4 ? 'That leaves less than 4 hours of sleep. Are the times right? 😅' : null),
      body: (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2">☀️ I wake up at <TimeInput label="Wake time" value={a.wakeTime} onChange={(v) => set({ wakeTime: v })} /></label>
            <label className="flex items-center gap-2">🌙 I go to bed at <TimeInput label="Bed time" value={a.sleepTime} onChange={(v) => set({ sleepTime: v })} /></label>
            <span className={sleepH < 7 ? 'text-warn' : 'text-ok'}>{sleepH.toFixed(1)}h of sleep {sleepH < 7 ? '😴 a bit short' : '✨ nice'}</span>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            {CHRONOTYPES.map((c) => <ChoiceCard key={c.id} selected={a.chronotype === c.id} onClick={() => set({ chronotype: c.id })} emoji={c.emoji} title={c.title} blurb={c.blurb} />)}
          </div>
        </div>
      ),
    });

    if (studies(p)) {
      s.push({
        id: 'classes',
        mood: '🎓',
        say: <>What does your class timetable look like? I'll never schedule anything on top of a class. {p === 'HYBRID' && 'Add your work shifts in a moment.'}</>,
        validate: () => slotError(a.classes, 'Class'),
        body: (
          <div className="space-y-4">
            <SlotList items={a.classes} onChange={(v) => set({ classes: v })} placeholder="e.g. Physics lecture" addLabel="Add a class" />
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Chip on={!a.classes.length} onClick={() => set({ classes: [] })}>🏖️ No classes right now</Chip>
              <span className="ml-auto flex items-center gap-2">🚌 Commute each way
                <Select value={a.commuteMinutes} onChange={(e) => set({ commuteMinutes: Number(e.target.value) })} className="w-28 py-1">
                  {COMMUTES.map((m) => <option key={m} value={m}>{m ? `${m} min` : 'none'}</option>)}
                </Select>
              </span>
            </div>
          </div>
        ),
      });
      s.push({
        id: 'subjects',
        mood: '📚',
        say: <>Which subjects are you taking? Tell me how tough each one feels, and tough ones get more revision time.</>,
        body: (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {SUBJECT_IDEAS.map((name) => {
                const on = a.subjects.some((x) => x.name === name);
                return <Chip key={name} on={on} onClick={() => set({ subjects: on ? a.subjects.filter((x) => x.name !== name) : [...a.subjects, { name, difficulty: 2 }] })}>{name}</Chip>;
              })}
            </div>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const n = customSubject.trim(); if (n && !a.subjects.some((x) => x.name.toLowerCase() === n.toLowerCase())) set({ subjects: [...a.subjects, { name: n, difficulty: 2 }] }); setCustomSubject(''); }}>
              <Input value={customSubject} onChange={(e) => setCustomSubject(e.target.value)} placeholder="Another subject…" className="max-w-xs py-1" aria-label="Another subject" />
              <Button type="submit" variant="secondary" size="sm">Add</Button>
            </form>
            {a.subjects.length > 0 && (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {a.subjects.map((sub) => (
                  <li key={sub.name} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                    <span className="min-w-32 flex-1 font-medium">{sub.name}</span>
                    {DIFFICULTY.map((d) => (
                      <Chip key={d.v} on={sub.difficulty === d.v} onClick={() => set({ subjects: a.subjects.map((x) => (x.name === sub.name ? { ...x, difficulty: d.v } : x)) })}>{d.emoji} {d.label}</Chip>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ),
      });
      s.push({
        id: 'exams',
        mood: '📝',
        say: <>Any exams coming up? I'll space your revision out before each one (spaced repetition is basically a cheat code 🧠). Skip if none!</>,
        body: (
          <ListEditor items={a.exams} onChange={(v) => set({ exams: v })} addLabel="Add an exam" blank={() => ({ subject: a.subjects[0]?.name ?? '', date: '' })}
            render={(e, u) => (
              <>
                <Input list="subject-list" value={e.subject} onChange={(ev) => u({ subject: ev.target.value })} placeholder="Subject" className="min-w-40 flex-1 py-1" aria-label="Exam subject" />
                <datalist id="subject-list">{a.subjects.map((x) => <option key={x.name} value={x.name} />)}</datalist>
                <Input type="date" min={todayIso()} value={e.date} onChange={(ev) => u({ date: ev.target.value })} className="w-40 py-1" aria-label="Exam date" />
              </>
            )} />
        ),
      });
      s.push({
        id: 'assignments',
        mood: '✍️',
        say: <>Homework or assignments due? Big ones get split into research → draft → polish, so no all-nighters. 🌙❌</>,
        body: (
          <ListEditor items={a.assignments} onChange={(v) => set({ assignments: v })} addLabel="Add an assignment" blank={() => ({ title: '', dueDate: '', hours: 2 })}
            render={(x, u) => (
              <>
                <Input value={x.title} onChange={(e) => u({ title: e.target.value })} placeholder="e.g. Chemistry lab report" className="min-w-44 flex-1 py-1" aria-label="Assignment" />
                <label className="flex items-center gap-1 text-xs text-muted">due <Input type="date" min={todayIso()} value={x.dueDate} onChange={(e) => u({ dueDate: e.target.value })} className="w-40 py-1" aria-label="Due date" /></label>
                <label className="flex items-center gap-1 text-xs text-muted">≈ <Input type="number" min={0.5} max={100} step={0.5} value={x.hours} onChange={(e) => u({ hours: Number(e.target.value) })} className="w-20 py-1" aria-label="Hours" /> hours</label>
              </>
            )} />
        ),
      });
    }

    if (works(p)) {
      s.push({
        id: 'work',
        mood: '💼',
        say: p === 'HYBRID' ? <>Now your job: which days and hours do you work?</> : <>Tell me about your work week. Which days and hours?</>,
        validate: () => (toMin(a.workEnd) <= toMin(a.workStart) ? 'Your work day ends before it starts. Check the times? 🕐' : !a.workDays.length ? 'Pick at least one work day 🙂' : slotError(a.meetings, 'Meeting')),
        body: (
          <div className="space-y-4 text-sm">
            <DayChips value={a.workDays} onChange={(v) => set({ workDays: v })} label="Work days" />
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2">From <TimeInput label="Work start" value={a.workStart} onChange={(v) => set({ workStart: v })} /></label>
              <label className="flex items-center gap-2">to <TimeInput label="Work end" value={a.workEnd} onChange={(v) => set({ workEnd: v })} /></label>
              {p === 'WORK' && (
                <label className="ml-auto flex items-center gap-2">🚌 Commute each way
                  <Select value={a.commuteMinutes} onChange={(e) => set({ commuteMinutes: Number(e.target.value) })} className="w-28 py-1">
                    {COMMUTES.map((m) => <option key={m} value={m}>{m ? `${m} min` : 'remote 🏡'}</option>)}
                  </Select>
                </label>
              )}
            </div>
            {p === 'WORK' && (
              <>
                <p className="pt-2 font-medium">Recurring meetings</p>
                <SlotList items={a.meetings} onChange={(v) => set({ meetings: v })} placeholder="e.g. Team sync" addLabel="Add a meeting" ideas={MEETING_IDEAS} />
              </>
            )}
          </div>
        ),
      });
      s.push({
        id: 'workTasks',
        mood: '🎯',
        say: p === 'HYBRID' ? <>Any work tasks you need to fit in outside your shifts? Skip if your job doesn't send work home. 🙌</> : <>What's on your plate at work? Add the big things with a rough time estimate and I'll find the best slots.</>,
        body: (
          <ListEditor items={a.workTasks} onChange={(v) => set({ workTasks: v })} addLabel="Add a task" blank={() => ({ title: '', hours: 2, dueDate: '', priority: 'MEDIUM' as Priority })}
            render={(x, u) => (
              <>
                <Input value={x.title} onChange={(e) => u({ title: e.target.value })} placeholder="e.g. Quarterly report" className="min-w-44 flex-1 py-1" aria-label="Task" />
                <label className="flex items-center gap-1 text-xs text-muted">≈ <Input type="number" min={0.5} step={0.5} value={x.hours} onChange={(e) => u({ hours: Number(e.target.value) })} className="w-20 py-1" aria-label="Hours" /> h</label>
                <label className="flex items-center gap-1 text-xs text-muted">due <Input type="date" min={todayIso()} value={x.dueDate ?? ''} onChange={(e) => u({ dueDate: e.target.value })} className="w-40 py-1" aria-label="Due date (optional)" /></label>
                <Select value={x.priority} onChange={(e) => u({ priority: e.target.value as Priority })} className="w-32 py-1" aria-label="Priority">
                  <option value="LOW">🌱 Low</option><option value="MEDIUM">🙂 Medium</option><option value="HIGH">🔥 High</option><option value="URGENT">🚨 Urgent</option>
                </Select>
              </>
            )} />
        ),
      });
    }

    s.push({
      id: 'focus',
      mood: '🎧',
      say: studies(p) ? <>How much would you like to study each day, and how do you like to focus?</> : <>How do you like to focus on deep work?</>,
      body: (
        <div className="space-y-5">
          {studies(p) && (
            <div>
              <label className="flex items-center justify-between text-sm font-medium" htmlFor="study-hours">
                Study goal per day <span className="text-lg text-accent">{a.studyHoursPerDay}h {a.studyHoursPerDay >= 6 ? '🔥' : a.studyHoursPerDay >= 3 ? '💪' : '🌱'}</span>
              </label>
              <input id="study-hours" type="range" min={0.5} max={8} step={0.5} value={a.studyHoursPerDay} onChange={(e) => set({ studyHoursPerDay: Number(e.target.value) })} className="mt-2 w-full accent-[var(--c-accent)]" />
              <p className="mt-1 text-xs text-muted">{a.studyHoursPerDay > 6 ? 'Ambitious! Remember breaks are part of learning.' : 'Consistency beats cramming. A steady goal wins. 🐢🏆'}</p>
            </div>
          )}
          <div className="flex flex-col gap-3 sm:flex-row">
            {FOCUS_STYLES.map((f) => <ChoiceCard key={f.minutes} selected={a.focusMinutes === f.minutes} onClick={() => set({ focusMinutes: f.minutes })} emoji={f.emoji} title={f.title} blurb={f.blurb} />)}
          </div>
        </div>
      ),
    });

    s.push({
      id: 'life',
      mood: '🍽️',
      say: <>Life outside {studies(p) ? 'studying' : 'work'} matters too! When do you eat, what else fills your week, and which days do you want completely free?</>,
      validate: () => slotError(a.activities, 'Activity'),
      body: (
        <div className="space-y-5 text-sm">
          <div className="flex flex-wrap gap-4">
            {(['breakfast', 'lunch', 'dinner'] as const).map((meal) => {
              const v = a.meals[meal];
              const emoji = { breakfast: '🍳', lunch: '🥗', dinner: '🍲' }[meal];
              const def = { breakfast: '07:30', lunch: '13:00', dinner: '20:00' }[meal];
              return (
                <span key={meal} className="flex items-center gap-2">
                  <input type="checkbox" id={`meal-${meal}`} checked={!!v} onChange={(e) => set({ meals: { ...a.meals, [meal]: e.target.checked ? def : null } })} />
                  <label htmlFor={`meal-${meal}`}>{emoji} {meal[0].toUpperCase() + meal.slice(1)}</label>
                  {v && <TimeInput label={`${meal} time`} value={v} onChange={(t) => set({ meals: { ...a.meals, [meal]: t } })} />}
                </span>
              );
            })}
          </div>
          <div>
            <p className="mb-2 font-medium">Regular activities (gym, sports, clubs, tuition…)</p>
            <SlotList items={a.activities} onChange={(v) => set({ activities: v })} placeholder="e.g. Football practice" addLabel="Add an activity" ideas={ACTIVITY_IDEAS} />
          </div>
          <div>
            <p className="mb-2 font-medium">Days off, with nothing scheduled 🌿</p>
            <DayChips value={a.daysOff} onChange={(v) => set({ daysOff: v })} label="Days off" />
          </div>
        </div>
      ),
    });

    s.push({
      id: 'habits',
      mood: '🌱',
      say: <>Last one! Any little habits you'd love to keep up? I'll sneak them into your free time.</>,
      body: (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {HABIT_IDEAS[p].map((h) => {
              const on = a.habits.some((x) => x.title === h.title);
              return <Chip key={h.title} on={on} onClick={() => set({ habits: on ? a.habits.filter((x) => x.title !== h.title) : [...a.habits, { ...h, weekdays: [1, 2, 3, 4, 5, 6, 0] }] })}>{h.title}</Chip>;
            })}
          </div>
          <ListEditor items={a.habits} onChange={(v) => set({ habits: v })} addLabel="Add my own habit" blank={() => ({ title: '', minutes: 20, weekdays: [1, 2, 3, 4, 5] })}
            render={(h, u) => (
              <>
                <Input value={h.title} onChange={(e) => u({ title: e.target.value })} placeholder="e.g. Journal" className="min-w-40 flex-1 py-1" aria-label="Habit" />
                <label className="flex items-center gap-1 text-xs text-muted"><Input type="number" min={5} max={240} step={5} value={h.minutes} onChange={(e) => u({ minutes: Number(e.target.value) })} className="w-20 py-1" aria-label="Minutes" /> min</label>
                <DayChips value={h.weekdays} onChange={(v) => u({ weekdays: v })} />
              </>
            )} />
        </div>
      ),
    });

    s.push({
      id: 'review',
      mood: '✨',
      say: plan ? <>Ta-da! Here's the shape of your week, {first}. {persona.emoji} Look it over. Nothing is saved until you say so.</> : <>Give me a second while I work out the smartest plan for you…</>,
      body: !plan ? <div className="flex items-center gap-2 py-8 text-sm text-muted"><Spinner className="h-4 w-4" /> Crunching your timetable…</div> : (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-accent-soft p-2"><div className="text-lg font-semibold text-accent">{fmtMinutes(plan.stats.availableMinutesPerWeek)}</div><div className="text-xs text-muted">focus time / week</div></div>
            <div className="rounded-lg bg-ok-soft p-2"><div className="text-lg font-semibold text-ok">{plan.tasks.length}</div><div className="text-xs text-muted">smart tasks ({fmtMinutes(plan.stats.plannedTaskMinutes)})</div></div>
            <div className="rounded-lg bg-surface-2 p-2"><div className="text-lg font-semibold">{plan.stats.sleepHours}h</div><div className="text-xs text-muted">sleep 😴</div></div>
          </div>
          <WeekGlance plan={plan} />
          <ul className="space-y-1.5 rounded-xl border border-border bg-surface-2/50 p-3 text-sm">
            {plan.insights.map((t, k) => <li key={k} className="flex gap-2"><span aria-hidden>💡</span><span>{t}</span></li>)}
          </ul>
          {plan.tasks.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-accent">See the {plan.tasks.length} tasks I'll add</summary>
              <ul className="mt-2 max-h-56 space-y-1 overflow-auto">
                {plan.tasks.map((t) => <li key={t.key} className="flex justify-between gap-2"><span>{t.title}</span><span className="shrink-0 text-xs text-muted">{fmtMinutes(t.estimatedMinutes)}{t.dueAt && ` · by ${new Date(t.dueAt).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`}</span></li>)}
              </ul>
            </details>
          )}
        </div>
      ),
    });
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, plan, customSubject, p]);

  const step = steps[Math.min(i, steps.length - 1)];
  const isReview = step.id === 'review';

  // Build the preview when the review step opens (or answers change while on it).
  useEffect(() => {
    if (!isReview || plan) return;
    let cancelled = false;
    setError(null);
    api.post<{ plan: LifePlan }>('/planner/setup', { answers: clean(a), dryRun: true })
      .then((r) => { if (!cancelled) setPlan(r.data.plan); })
      .catch((e) => {
        if (cancelled) return;
        const err = apiError(e);
        const detail = Array.isArray(err.details) ? (err.details as { path: string; message: string }[])[0] : undefined;
        setError(detail ? `${err.message}: ${detail.path} (${detail.message})` : err.message);
      });
    return () => { cancelled = true; };
  }, [isReview, plan, a]);

  function next() {
    const msg = step.validate?.() ?? null;
    if (msg) return setError(msg);
    setError(null);
    setI((x) => Math.min(steps.length - 1, x + 1));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<PlannerResult>('/planner/setup', { answers: clean(a) });
      onApplied(r.data);
    } catch (e) {
      setError(apiError(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <ol className="flex gap-1" aria-label="Progress">
        {steps.map((s, k) => <li key={s.id} className={`h-1.5 flex-1 rounded-full transition-colors ${k <= i ? 'bg-accent' : 'bg-border'}`} />)}
      </ol>
      <div key={step.id} className="wizard-step space-y-4">
        <Tempo mood={step.mood}>{step.say}</Tempo>
        <div className="rounded-xl border border-border bg-surface p-4 sm:p-5">{step.body}</div>
      </div>
      {error && <ErrorBox message={error} />}
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => { setError(null); setI((x) => Math.max(0, x - 1)); }} disabled={i === 0}>← Back</Button>
          {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
        </div>
        <span className="hidden text-xs text-muted sm:inline">Step {i + 1} of {steps.length}</span>
        {isReview
          ? <Button onClick={save} loading={busy} disabled={!plan}>Save my plan ✨</Button>
          : <Button onClick={next}>{steps[i + 1]?.id === 'review' ? 'Show my plan →' : 'Next →'}</Button>}
      </div>
    </div>
  );
}
