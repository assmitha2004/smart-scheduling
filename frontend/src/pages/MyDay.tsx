import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import clsx from 'clsx';
import { api, apiError } from '../services/api';
import { useAuth } from '../services/auth';
import { useCelebrate } from '../components/Celebrate';
import { useToast } from '../components/Toast';
import { Button, ErrorBox, Input, Loading } from '../components/ui';
import { DayWizard } from '../features/day/DayWizard';
import { Composer } from '../features/day/Composer';
import { Review } from '../features/day/Review';
import { LEGEND, Timeline } from '../features/day/Timeline';
import { clock, duration } from '../features/day/dayUtils';
import { useProgress } from '../features/progress/progress';
import type { DayData, DayTask, DayUnderstanding } from '../types';

type Mode = 'compose' | 'review' | 'questions' | 'track';

function useNowMinute(tz: string) {
  const calc = () => { const n = DateTime.now().setZone(tz); return n.hour * 60 + n.minute; };
  const [now, setNow] = useState(calc);
  useEffect(() => { const id = setInterval(() => setNow(calc()), 30_000); return () => clearInterval(id); });
  return now;
}

function Ring({ value, size = 88 }: { value: number; size?: number }) {
  return (
    <svg viewBox="0 0 36 36" style={{ width: size, height: size }} className="-rotate-90" aria-hidden>
      <circle cx="18" cy="18" r="15.9" fill="none" stroke="var(--c-surface-2)" strokeWidth="3" />
      <circle cx="18" cy="18" r="15.9" fill="none" stroke={value >= 1 ? 'var(--c-ok)' : 'var(--c-accent)'} strokeWidth="3" strokeLinecap="round" strokeDasharray={`${Math.min(1, value) * 100} 100`} pathLength={100} className="transition-all duration-700" />
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg bg-surface-2/70 px-3 py-2">
      <div className="text-base font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
    </div>
  );
}

function statusLine(done: number, total: number) {
  if (!total) return 'Nothing planned yet';
  if (done >= total) return 'Day complete. Great work.';
  if (done === 0) return 'Ready when you are';
  if (done / total >= 0.5) return 'More than halfway there';
  return 'Good progress, keep going';
}

export default function MyDay() {
  const { user } = useAuth();
  const tz = user?.timezone ?? 'UTC';
  const qc = useQueryClient();
  const toast = useToast();
  const { celebrate } = useCelebrate();
  const progress = useProgress().data;
  const [params, setParams] = useSearchParams();
  const [date, setDate] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode | null>(params.get('plan') === '1' ? 'compose' : null);
  const [understanding, setUnderstanding] = useState<DayUnderstanding | null>(null);
  const [lastText, setLastText] = useState('');
  const [quick, setQuick] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const nowMin = useNowMinute(tz);
  useEffect(() => { if (params.get('plan')) setParams({}, { replace: true }); }, [params, setParams]);

  const q = useQuery({ queryKey: ['day', date], queryFn: async () => (await api.get<DayData>('/day', { params: date ? { date } : {} })).data });
  const day = q.data;
  const viewDate = date ?? day?.today ?? '';
  const isToday = !!day && viewDate === day.today;
  const tomorrow = day ? DateTime.fromISO(day.today).plus({ days: 1 }).toISODate()! : '';
  const items = day?.plan?.items ?? [];
  const hasPlan = items.length > 0;
  const current: Mode = mode ?? (hasPlan ? 'track' : 'compose');
  const setDay = (d: DayData) => { qc.setQueryData(['day', date], d); for (const k of ['progress', 'tasks', 'briefing']) qc.invalidateQueries({ queryKey: [k] }); };

  const taskById = useMemo(() => new Map((day?.tasks ?? []).map((t) => [t.id, t])), [day]);
  const openItems = items.filter((i) => i.kind === 'TASK' && i.taskId && !taskById.get(i.taskId)?.done);
  const running = isToday ? openItems.find((i) => i.start <= nowMin && nowMin < i.end) : undefined;
  const upNext = isToday ? openItems.find((i) => i.start >= nowMin) : openItems[0];
  const behind = isToday ? openItems.filter((i) => i.end <= nowMin) : [];
  const plannedIds = new Set(items.map((i) => i.taskId));
  const unplanned = (day?.tasks ?? []).filter((t) => !t.done && !plannedIds.has(t.id));

  async function act(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try { await fn(); } catch (e) { const m = apiError(e).message; setError(m); toast.show(m, 'error'); } finally { setBusy(null); }
  }
  const understand = (text: string) => act('understand', async () => {
    setLastText(text);
    const r = await api.post<DayUnderstanding>('/day/understand', { text, date: date ?? undefined });
    if (r.data.date !== viewDate) setDate(r.data.date === day?.today ? null : r.data.date);
    setUnderstanding(r.data);
    setMode('review');
  });
  const toggle = (t: DayTask) => act(t.id, async () => {
    const r = await api.post<{ day: DayData; compliment: string | null }>(`/day/tasks/${t.id}/done`, { done: !t.done });
    setDay(r.data.day);
    if (r.data.compliment) celebrate({ line: r.data.compliment, title: t.title, emoji: r.data.day.progress.done >= r.data.day.progress.total ? '🏆' : t.top ? '⭐' : undefined });
  });
  const later = (t: DayTask) => act(t.id, async () => { setDay((await api.post<{ day: DayData }>(`/day/tasks/${t.id}/tomorrow`)).data.day); toast.show(`Moved “${t.title}” to tomorrow`, 'success'); });
  const remove = (t: DayTask) => act(t.id, async () => { setDay((await api.delete<{ day: DayData }>(`/day/tasks/${t.id}`)).data.day); });
  const replan = (extend?: { taskId: string; minutes: number }) => act(extend?.taskId ?? 'replan', async () => {
    const r = await api.post<{ day: DayData; moved: string[]; changed: number }>('/day/replan', { date: viewDate, extend });
    setDay(r.data.day);
    const msg = extend ? `Added ${extend.minutes} minutes. Everything after it moved.`
      : r.data.changed === 0 && !r.data.moved.length ? 'Your plan is already up to date.'
      : `Re-planned from ${clock(Math.ceil(nowMin / 5) * 5)}: ${r.data.changed} session${r.data.changed === 1 ? '' : 's'} got new times.`;
    setNotice(r.data.moved.length ? `${msg} Moved to tomorrow: ${r.data.moved.join(', ')}.` : msg);
    toast.show(msg, 'success');
  });
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (!quick.trim()) return;
    act('quick', async () => {
      const r = await api.post<{ day: DayData; moved?: string[]; parsed: { title: string } }>('/day/tasks', { date: viewDate, text: quick });
      setDay(r.data.day);
      setQuick('');
      setNotice(r.data.moved?.length ? `Added “${r.data.parsed.title}”. To make room, moved to tomorrow: ${r.data.moved.join(', ')}.` : `Added “${r.data.parsed.title}” and fitted it into your plan.`);
    });
  };

  if (q.isLoading || !day) return q.error ? <ErrorBox message={apiError(q.error).message} /> : <Loading label="Opening your day…" />;

  const first = user?.name.split(' ')[0];
  const heading = DateTime.fromISO(viewDate, { zone: tz }).toFormat('cccc, d LLLL');
  const hour = DateTime.now().setZone(tz).hour;
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const header = (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-sm text-muted">{heading}</p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-[28px]">{isToday ? `${greeting}, ${first}` : 'Tomorrow'}</h1>
      </div>
      <div className="flex rounded-lg border border-border bg-surface p-0.5 text-sm" role="tablist" aria-label="Day">
        {[{ d: null as string | null, label: 'Today' }, { d: tomorrow, label: 'Tomorrow' }].map((x) => {
          const on = (x.d ?? day.today) === viewDate;
          return (
            <button key={x.label} role="tab" aria-selected={on} onClick={() => { setDate(x.d); setMode(null); setUnderstanding(null); setNotice(null); }}
              className={clsx('rounded-md px-3.5 py-1.5 font-medium transition-colors', on ? 'bg-fg text-bg' : 'text-muted hover:text-fg')}>
              {x.label}{x.d && day.tomorrowCount > 0 && !on ? <span className="ml-1.5 rounded-full bg-surface-2 px-1.5 text-[11px]">{day.tomorrowCount}</span> : null}
            </button>
          );
        })}
      </div>
    </header>
  );

  // ---------- describe the day ----------
  if (current === 'compose') {
    return (
      <div className="mx-auto max-w-3xl">
        {header}
        {isToday && day.leftovers.length > 0 && (
          <div className="mb-4 flex items-start gap-3 rounded-xl border border-warn/30 bg-warn-soft/40 px-4 py-3 text-sm">
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-warn" aria-hidden />
            <p><span className="font-medium">{day.leftovers.length} unfinished from before:</span> {day.leftovers.map((t) => t.title).join(', ')}. They’ll be added to today’s plan automatically.</p>
          </div>
        )}
        <h2 className="mb-1 text-lg font-semibold">{isToday ? 'What does your day look like?' : 'What’s on for tomorrow?'}</h2>
        <p className="mb-4 text-sm text-muted">Describe it in your own words. I’ll work out the order, timing and breaks, and you can adjust anything before it’s saved.</p>
        <Composer onSubmit={understand} busy={busy === 'understand'} initial={lastText} onQuestions={() => setMode('questions')} placeholderDay={isToday ? 'today' : 'tomorrow'} />
        {error && <div className="mt-4"><ErrorBox message={error} /></div>}
        <div className="mt-6 grid gap-3 text-sm sm:grid-cols-3">
          {[
            ['Understands you', 'Deadlines, “after lunch”, “by 5pm”, set times and what matters most.'],
            ['Plans around you', 'Hard work at your best time, breaks after every task, meals kept free.'],
            ['Keeps you on track', 'Tick tasks off, re-plan when things run late, leftovers move to tomorrow.'],
          ].map(([t, d]) => (
            <div key={t} className="rounded-xl border border-border bg-surface p-4"><p className="font-medium">{t}</p><p className="mt-1 text-muted">{d}</p></div>
          ))}
        </div>
        {hasPlan && <button className="mt-6 text-sm text-muted hover:text-fg" onClick={() => setMode('track')}>← Back to my current plan</button>}
        {!user?.aiExternalConsent && <p className="mt-4 text-xs text-muted">Want Claude to read your day? Turn on AI in <Link className="text-accent" to="/app/settings">Settings</Link> (it also needs to be enabled on the server).</p>}
      </div>
    );
  }

  // ---------- review what was understood ----------
  if (current === 'review' && understanding) {
    return (
      <div className="mx-auto max-w-6xl">
        {header}
        <Review key={understanding.date + understanding.tasks.length} initial={understanding} isToday={understanding.date === day.today}
          onBack={() => setMode('compose')}
          onSaved={(d, moved) => {
            setDay(d);
            setMode('track');
            setUnderstanding(null);
            celebrate({ emoji: '🗓️', line: understanding.date === day.today ? 'Your day is planned. You’ve got this!' : 'Tomorrow is sorted. Sleep well 🌙' });
            if (moved.length) toast.show(`Moved to tomorrow: ${moved.join(', ')}`, 'info');
          }} />
      </div>
    );
  }

  // ---------- step-by-step questions ----------
  if (current === 'questions') {
    return (
      <div className="mx-auto max-w-2xl">
        {header}
        <DayWizard key={viewDate} day={day} date={viewDate} onCancel={() => setMode(null)} onSaved={(d, moved) => {
          setDay(d);
          setMode('track');
          celebrate({ emoji: '🗓️', line: isToday ? 'Your day is planned. You’ve got this!' : 'Tomorrow is sorted. Sleep well 🌙' });
          if (moved.length) toast.show(`Moved to tomorrow: ${moved.join(', ')}`, 'info');
        }} />
      </div>
    );
  }

  // ---------- track the day ----------
  const { done, total, minutesDone } = day.progress;
  const plannedMinutes = items.filter((i) => i.kind === 'TASK').reduce((s, i) => s + i.end - i.start, 0);
  const focus = running ?? upNext;
  const focusTask = focus?.taskId ? taskById.get(focus.taskId) : undefined;
  const minutesLeftToday = openItems.filter((i) => !isToday || i.end > nowMin).reduce((s, i) => s + i.end - Math.max(i.start, isToday ? nowMin : 0), 0);

  const summaryCards = (
    <>
          <div className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-center gap-4">
          <div className="relative">
            <Ring value={total ? done / total : 0} />
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-xl font-semibold tabular-nums">{total ? Math.round((done / total) * 100) : 0}%</span>
            </div>
          </div>
          <div className="min-w-0">
            <p className="font-semibold">{statusLine(done, total)}</p>
            <p className="text-sm text-muted">{done} of {total} tasks done</p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          <Stat label="Done" value={duration(minutesDone)} />
          <Stat label="Left" value={duration(minutesLeftToday)} />
          <Stat label="Streak" value={progress ? `${progress.streak}d` : '–'} />
        </div>
        {total > 0 && done >= total && isToday && <p className="mt-3 rounded-lg bg-ok-soft px-3 py-2 text-sm">Everything is done. Enjoy the rest of your day. <Link to="/app/review" className="text-accent">See progress →</Link></p>}
        {plannedMinutes > 0 && <p className="mt-3 text-xs text-muted">{duration(plannedMinutes)} planned{day.tomorrowCount > 0 && isToday ? ` · ${day.tomorrowCount} task${day.tomorrowCount > 1 ? 's' : ''} waiting for tomorrow` : ''}</p>}
      </div>

      {focus && focusTask && (
        <div className="rounded-xl border border-accent/30 bg-gradient-to-b from-accent-soft/60 to-surface p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-accent">{running ? 'In progress' : isToday ? `Up next · ${clock(focus.start)}` : `First up · ${clock(focus.start)}`}</p>
          <p className="mt-1 text-lg font-semibold leading-snug">{focusTask.title}</p>
          <p className="text-sm text-muted">{clock(focus.start)} – {clock(focus.end)}{running ? ` · ${duration(focus.end - nowMin)} left` : ''}</p>
          {isToday && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => toggle(focusTask)} loading={busy === focusTask.id}>Mark done</Button>
              {running && <Button size="sm" variant="secondary" onClick={() => replan({ taskId: focusTask.id, minutes: 15 })}>+15 min</Button>}
              <Button size="sm" variant="ghost" onClick={() => later(focusTask)}>Not today</Button>
            </div>
          )}
        </div>
      )}

    </>
  );
  const actionCards = (
    <>
          <form onSubmit={add} className="rounded-xl border border-border bg-surface p-4">
        <label htmlFor="quick-add" className="text-sm font-semibold">Something came up?</label>
        <p className="mb-2 text-xs text-muted">Type it naturally, e.g. “call the bank at 4”, “gym after work 1h”. I’ll fit it in.</p>
        <div className="flex gap-2">
          <Input id="quick-add" value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="Add a task…" />
          <Button type="submit" variant="secondary" loading={busy === 'quick'} disabled={!quick.trim()}>Add</Button>
        </div>
      </form>

      {(notice || error) && (
        <div aria-live="polite">{error ? <ErrorBox message={error} /> : <p className="rounded-xl border border-ok/30 bg-ok-soft/50 px-4 py-3 text-sm">{notice}</p>}</div>
      )}

      <div className="grid gap-2">
        {isToday && <Button variant="secondary" onClick={() => replan()} loading={busy === 'replan'}>Re-plan from now</Button>}
        <Button variant="ghost" onClick={() => { setLastText(''); setMode('compose'); }}>Start over with a new description</Button>
        {isToday && <Button variant="ghost" onClick={() => { setDate(tomorrow); setMode(null); }}>Plan tomorrow →</Button>}
      </div>
    </>
  );

  return (
    <div className="mx-auto max-w-6xl">
      {header}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section>
          <div className="mb-5 space-y-4 lg:hidden">{summaryCards}</div>
          {isToday && behind.length > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-warn/30 bg-warn-soft/40 px-4 py-3 text-sm">
              <span><span className="font-medium">Running behind.</span> {behind.length} task{behind.length > 1 ? 's' : ''} passed {behind.length > 1 ? 'their' : 'its'} time without being ticked off.</span>
              <Button size="sm" variant="secondary" className="ml-auto" onClick={() => replan()} loading={busy === 'replan'}>Re-plan from now</Button>
            </div>
          )}
          <Timeline nowMin={isToday ? nowMin : undefined} entries={items.map((item) => {
            const t = item.taskId ? taskById.get(item.taskId) : undefined;
            if (item.kind !== 'TASK' || !t) return { item };
            return {
              item, effort: t.effort, fixed: !!t.fixedTime, done: t.done,
              render: (
                <div className="flex items-start gap-3">
                  <button type="button" onClick={() => toggle(t)} disabled={busy === t.id} aria-label={t.done ? `Mark ${t.title} not done` : `Mark ${t.title} done`}
                    className={clsx('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 text-[11px] font-bold transition-colors', t.done ? 'border-ok bg-ok text-white' : 'border-border hover:border-ok')}>
                    {t.done ? '✓' : ''}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className={clsx('text-sm font-medium', t.done && 'line-through')}>
                      {t.title}
                      {item.parts ? <span className="ml-1 text-xs font-normal text-muted">· session {item.part} of {item.parts}</span> : null}
                      {t.top && <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">Top priority</span>}
                      {t.rolloverCount > 0 && !t.done && <span className="ml-2 rounded bg-warn-soft px-1.5 py-0.5 text-[10px] font-medium text-warn">carried over</span>}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">{clock(item.start)} – {clock(item.end)} · {duration(item.end - item.start)}{item.reason && !t.done ? ` · ${item.reason}` : ''}</p>
                  </div>
                  {!t.done && (
                    <details className="relative">
                      <summary className="cursor-pointer list-none rounded px-1.5 text-muted opacity-60 hover:opacity-100 group-hover:opacity-100" aria-label={`Options for ${t.title}`}>⋯</summary>
                      <div className="absolute right-0 z-10 mt-1 w-48 rounded-lg border border-border bg-surface p-1 text-sm shadow-lg">
                        {isToday && <button className="block w-full rounded px-2.5 py-1.5 text-left hover:bg-surface-2" onClick={() => replan({ taskId: t.id, minutes: 15 })}>Needs 15 more minutes</button>}
                        <button className="block w-full rounded px-2.5 py-1.5 text-left hover:bg-surface-2" onClick={() => later(t)}>Move to tomorrow</button>
                        <button className="block w-full rounded px-2.5 py-1.5 text-left text-danger hover:bg-surface-2" onClick={() => remove(t)}>Delete</button>
                      </div>
                    </details>
                  )}
                </div>
              ),
            };
          })} />
          <div className="mt-3 flex flex-wrap gap-3 pl-[4.75rem] text-xs text-muted">
            {LEGEND.map((l) => <span key={l.label} className="flex items-center gap-1.5"><span className={clsx('h-2.5 w-2.5 rounded-sm', l.cls)} />{l.label}</span>)}
          </div>
          {unplanned.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm">
              <span><span className="font-medium">Not scheduled yet:</span> {unplanned.map((t) => t.title).join(', ')}</span>
              <Button size="sm" className="ml-auto" onClick={() => replan()} loading={busy === 'replan'}>Fit {unplanned.length > 1 ? 'them' : 'it'} in</Button>
            </div>
          )}
          {day.plan!.insights.length > 0 && (
            <ul className="mt-5 space-y-1 rounded-xl bg-surface-2/60 p-4 text-sm text-muted">
              {day.plan!.insights.map((t, i) => <li key={i}>{t}</li>)}
            </ul>
          )}
        </section>

        <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <div className="hidden space-y-4 lg:block">{summaryCards}</div>
          {actionCards}
        </aside>
      </div>
    </div>
  );
}
