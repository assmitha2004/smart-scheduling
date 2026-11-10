import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import clsx from 'clsx';
import { api, apiError } from '../services/api';
import { useAuth } from '../services/auth';
import { useCelebrate } from '../components/Celebrate';
import { useToast } from '../components/Toast';
import { Button, Card, ErrorBox, Input, Loading } from '../components/ui';
import { Tempo } from '../features/planner/controls';
import { DayWizard } from '../features/day/DayWizard';
import { TimelineRow, clock, duration } from '../features/day/dayUtils';
import type { DayData, DayPlanItem, DayTask } from '../types';

function useNowMinute(tz: string) {
  const calc = () => { const n = DateTime.now().setZone(tz); return n.hour * 60 + n.minute; };
  const [now, setNow] = useState(calc);
  useEffect(() => { const id = setInterval(() => setNow(calc()), 30_000); return () => clearInterval(id); });
  return now;
}

function ProgressRing({ done, total }: { done: number; total: number }) {
  const pct = total ? done / total : 0;
  return (
    <div className="relative h-20 w-20 shrink-0">
      <svg viewBox="0 0 36 36" className="h-20 w-20 -rotate-90" aria-hidden>
        <circle cx="18" cy="18" r="15.9" fill="none" stroke="var(--c-surface-2)" strokeWidth="3.2" />
        <circle cx="18" cy="18" r="15.9" fill="none" stroke={pct >= 1 ? 'var(--c-ok)' : 'var(--c-accent)'} strokeWidth="3.2" strokeLinecap="round" strokeDasharray={`${pct * 100} 100`} pathLength={100} className="transition-all duration-700" />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center leading-none" aria-label={`${done} of ${total} done`}>
        <span className="text-lg font-bold">{done}/{total}</span>
        <span className="text-[10px] text-muted">done</span>
      </span>
    </div>
  );
}

function headline(done: number, total: number, nowMin: number) {
  if (!total) return 'Nothing planned yet';
  if (done >= total) return 'Day complete! 🎉 You did everything.';
  if (done === 0) return nowMin < 12 * 60 ? 'Fresh start. Let’s go 🌱' : 'Let’s get the first one done 💪';
  if (done / total >= 0.5) return 'More than halfway there 🔥';
  return 'Nice progress, keep going ✨';
}

export default function MyDay() {
  const { user } = useAuth();
  const tz = user?.timezone ?? 'UTC';
  const qc = useQueryClient();
  const toast = useToast();
  const { celebrate } = useCelebrate();
  const [date, setDate] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const [planning, setPlanning] = useState(params.get('plan') === '1');
  useEffect(() => { if (params.get('plan')) setParams({}, { replace: true }); }, [params, setParams]);
  const [quick, setQuick] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nowMin = useNowMinute(tz);

  const q = useQuery({ queryKey: ['day', date], queryFn: async () => (await api.get<DayData>('/day', { params: date ? { date } : {} })).data });
  const day = q.data;
  const viewDate = date ?? day?.today ?? '';
  const isToday = !!day && viewDate === day.today;
  const tomorrow = day ? DateTime.fromISO(day.today).plus({ days: 1 }).toISODate()! : '';
  const setDay = (d: DayData) => { qc.setQueryData(['day', date], d); for (const k of ['progress', 'tasks', 'briefing']) qc.invalidateQueries({ queryKey: [k] }); };

  const taskById = useMemo(() => new Map((day?.tasks ?? []).map((t) => [t.id, t])), [day]);
  const items = day?.plan?.items ?? [];
  const plannedIds = new Set(items.filter((i) => i.taskId).map((i) => i.taskId));
  const unplanned = (day?.tasks ?? []).filter((t) => !t.done && !plannedIds.has(t.id));
  const openItems = items.filter((i) => i.kind === 'TASK' && i.taskId && !taskById.get(i.taskId)?.done);
  const current = isToday ? openItems.find((i) => i.start <= nowMin && nowMin < i.end) : undefined;
  const upNext = isToday ? openItems.find((i) => i.start >= nowMin) : openItems[0];
  const overdue = isToday ? openItems.filter((i) => i.end <= nowMin) : [];

  async function act(id: string, fn: () => Promise<void>) {
    setBusyId(id);
    setError(null);
    try { await fn(); } catch (e) { setError(apiError(e).message); } finally { setBusyId(null); }
  }
  const toggle = (t: DayTask) => act(t.id, async () => {
    const r = await api.post<{ day: DayData; compliment: string | null }>(`/day/tasks/${t.id}/done`, { done: !t.done });
    setDay(r.data.day);
    if (r.data.compliment) celebrate({ line: r.data.compliment, title: t.title, emoji: r.data.day.progress.done >= r.data.day.progress.total ? '🏆' : t.top ? '⭐' : undefined });
  });
  const later = (t: DayTask) => act(t.id, async () => { setDay((await api.post<{ day: DayData }>(`/day/tasks/${t.id}/tomorrow`)).data.day); toast.show(`“${t.title}” moved to tomorrow`, 'success'); });
  const remove = (t: DayTask) => act(t.id, async () => { setDay((await api.delete<{ day: DayData }>(`/day/tasks/${t.id}`)).data.day); });
  const replan = (extend?: { taskId: string; minutes: number }) => act(extend?.taskId ?? 'replan', async () => {
    const r = await api.post<{ day: DayData; moved: string[] }>('/day/replan', { date: viewDate, extend });
    setDay(r.data.day);
    toast.show(r.data.moved.length ? `Re-planned. Moved to tomorrow: ${r.data.moved.join(', ')}` : 'Re-planned the rest of your day ✨', 'success');
  });
  async function addQuick(e: React.FormEvent) {
    e.preventDefault();
    if (!quick.trim()) return;
    await act('quick', async () => { setDay((await api.post<{ day: DayData }>('/day/tasks', { date: viewDate, text: quick })).data.day); setQuick(''); });
  }

  if (q.isLoading || !day) return q.error ? <ErrorBox message={apiError(q.error).message} /> : <Loading label="Opening your day…" />;

  const first = user?.name.split(' ')[0];
  const heading = isToday ? DateTime.now().setZone(tz).toFormat('cccc, d LLLL') : DateTime.fromISO(viewDate).toFormat('cccc, d LLLL');
  const DateSwitch = (
    <div className="flex rounded-lg border border-border bg-surface p-0.5 text-sm" role="tablist">
      {[{ d: null, label: 'Today' }, { d: tomorrow, label: 'Tomorrow' }].map((x) => (
        <button key={x.label} role="tab" aria-selected={(x.d ?? day.today) === viewDate} onClick={() => { setDate(x.d); setPlanning(false); }}
          className={clsx('rounded-md px-3 py-1', (x.d ?? day.today) === viewDate ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg')}>
          {x.label}{x.d && day.tomorrowCount > 0 && viewDate !== tomorrow ? ` · ${day.tomorrowCount}` : ''}
        </button>
      ))}
    </div>
  );

  if (planning) {
    return (
      <div className="mx-auto max-w-2xl">
        <div className="mb-5 flex items-center justify-between gap-2"><h1 className="text-xl font-semibold">{isToday ? 'Plan my day' : 'Plan tomorrow'}</h1>{DateSwitch}</div>
        <DayWizard key={viewDate} day={day} date={viewDate} onCancel={() => setPlanning(false)} onSaved={(d, moved) => {
          setDay(d);
          setPlanning(false);
          celebrate({ emoji: '🗓️', line: isToday ? 'Your day is planned. You’ve got this!' : 'Tomorrow is sorted. Sleep well 🌙' });
          if (moved.length) toast.show(`Moved to tomorrow: ${moved.join(', ')}`, 'info');
        }} />
      </div>
    );
  }

  const leftoverBanner = isToday && day.leftovers.length > 0 && (
    <Card className="mb-4 border-warn/40 bg-warn-soft/40">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-2xl" aria-hidden>↩️</span>
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">{day.leftovers.length} task{day.leftovers.length > 1 ? 's' : ''} left over from before</p>
          <p className="text-muted">{day.leftovers.slice(0, 4).map((t) => t.title).join(', ')}{day.leftovers.length > 4 ? '…' : ''}. That’s okay, let’s fit {day.leftovers.length > 1 ? 'them' : 'it'} in today.</p>
        </div>
        <Button size="sm" onClick={() => setPlanning(true)}>Add to today</Button>
      </div>
    </Card>
  );

  // ---------- no plan yet ----------
  if (!day.plan || items.length === 0) {
    return (
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div><h1 className="text-2xl font-semibold tracking-tight">{isToday ? `Hi ${first} 👋` : 'Tomorrow'}</h1><p className="text-sm text-muted">{heading}</p></div>
          {DateSwitch}
        </div>
        {leftoverBanner}
        <Card className="text-center">
          <div className="py-6">
            <div className="tempo-bob mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-accent-soft text-4xl" aria-hidden>🦉</div>
            <h2 className="mt-4 text-xl font-semibold">{isToday ? 'Not sure where to start today?' : 'Get tomorrow sorted tonight'}</h2>
            <p className="mx-auto mt-2 max-w-md text-muted">Tell me what you need to do. I’ll ask a few quick questions, then plan {isToday ? 'your day' : 'tomorrow'}: what to do when, with breaks. Anything left over moves to the next day automatically.</p>
            {day.tasks.length > 0 && <p className="mt-3 text-sm">{day.tasks.length} task{day.tasks.length > 1 ? 's are' : ' is'} already waiting for {isToday ? 'today' : 'tomorrow'}: {day.tasks.map((t) => t.title).join(', ')}</p>}
            <Button className="mt-6" onClick={() => setPlanning(true)}>{isToday ? '✨ Plan my day' : '✨ Plan tomorrow'}</Button>
          </div>
        </Card>
        {isToday && nowMin >= 20 * 60 && <p className="mt-4 text-center text-sm text-muted">It’s getting late. <button className="text-accent" onClick={() => { setDate(tomorrow); }}>Plan tomorrow instead →</button></p>}
      </div>
    );
  }

  // ---------- the plan ----------
  const { done, total, minutesDone } = day.progress;
  const focus = current ?? upNext;
  const focusTask = focus?.taskId ? taskById.get(focus.taskId) : undefined;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-2xl font-semibold tracking-tight">{isToday ? 'My day' : 'Tomorrow'}</h1><p className="text-sm text-muted">{heading}</p></div>
        {DateSwitch}
      </div>

      {leftoverBanner}

      <Card className="mb-4">
        <div className="flex items-center gap-4">
          <ProgressRing done={done} total={total} />
          <div className="min-w-0 flex-1">
            <p className="text-lg font-semibold">{headline(done, total, nowMin)}</p>
            <p className="text-sm text-muted">{duration(minutesDone)} of focused work done{day.tomorrowCount > 0 && isToday ? ` · ${day.tomorrowCount} waiting for tomorrow` : ''}</p>
          </div>
        </div>
        {done >= total && total > 0 && isToday && <p className="mt-3 rounded-lg bg-ok-soft p-3 text-sm">Everything’s ticked off. Take the rest of the evening for yourself 🌿 <Link to="/app/review" className="text-accent">See your progress →</Link></p>}
      </Card>

      {isToday && focus && focusTask && (
        <Card className="mb-4 border-accent/40 bg-gradient-to-br from-accent-soft/60 to-surface">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">{current ? '▶ Now' : `Up next · ${clock(focus.start)}`}</p>
          <p className="mt-1 text-xl font-semibold">{focusTask.top && '⭐ '}{focusTask.title}{focus.parts ? ` (${focus.part}/${focus.parts})` : ''}</p>
          <p className="text-sm text-muted">{clock(focus.start)} – {clock(focus.end)} · {focus.reason}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={() => toggle(focusTask)} loading={busyId === focusTask.id}>✓ Done</Button>
            {current && <Button variant="secondary" onClick={() => replan({ taskId: focusTask.id, minutes: 15 })} loading={busyId === focusTask.id}>Need 15 more min</Button>}
            <Button variant="ghost" onClick={() => later(focusTask)}>Not today</Button>
          </div>
        </Card>
      )}

      {isToday && overdue.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-warn/40 bg-warn-soft/40 p-3 text-sm">
          <span>⏳ {overdue.length} task{overdue.length > 1 ? 's' : ''} ran past {overdue.length > 1 ? 'their' : 'its'} time. No problem.</span>
          <Button size="sm" variant="secondary" className="ml-auto" onClick={() => replan()} loading={busyId === 'replan'}>Re-plan the rest of my day</Button>
        </div>
      )}

      {error && <div className="mb-4"><ErrorBox message={error} /></div>}

      <ol className="space-y-1.5" aria-label="Timeline">
        {items.map((it: DayPlanItem, i) => {
          const t = it.taskId ? taskById.get(it.taskId) : undefined;
          const isNow = isToday && it.start <= nowMin && nowMin < it.end;
          if (it.kind !== 'TASK' || !t) return <TimelineRow key={i} item={it} now={isNow && it.kind !== 'BREAK'} />;
          return (
            <TimelineRow key={i} item={it} done={t.done} now={isNow && !t.done}>
              <div className="flex items-start gap-3">
                <button type="button" onClick={() => toggle(t)} disabled={busyId === t.id} aria-label={t.done ? `Mark ${t.title} not done` : `Mark ${t.title} done`}
                  className={clsx('mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold transition-colors', t.done ? 'border-ok bg-ok text-white' : 'border-border hover:border-ok')}>
                  {t.done ? '✓' : ''}
                </button>
                <div className="min-w-0 flex-1">
                  <p className={clsx('text-sm font-medium', t.done && 'line-through')}>{t.top && '⭐ '}{t.mustDo && !t.top && '📌 '}{t.title}{it.parts ? ` (${it.part}/${it.parts})` : ''}{t.rolloverCount > 0 && !t.done && <span className="ml-1.5 text-xs text-warn" title="Carried over">↩️</span>}</p>
                  <p className="text-xs text-muted">{clock(it.start)} – {clock(it.end)} · {duration(it.end - it.start)}{it.reason && !t.done ? ` · ${it.reason}` : ''}</p>
                </div>
                {!t.done && (
                  <details className="relative">
                    <summary className="cursor-pointer list-none rounded px-1.5 text-muted hover:text-fg" aria-label={`More for ${t.title}`}>⋯</summary>
                    <div className="absolute right-0 z-10 mt-1 w-44 rounded-lg border border-border bg-surface p-1 text-sm shadow-lg">
                      <button className="block w-full rounded px-2 py-1.5 text-left hover:bg-surface-2" onClick={() => later(t)}>Move to tomorrow</button>
                      {isToday && <button className="block w-full rounded px-2 py-1.5 text-left hover:bg-surface-2" onClick={() => replan({ taskId: t.id, minutes: 15 })}>Needs 15 more min</button>}
                      <button className="block w-full rounded px-2 py-1.5 text-left text-danger hover:bg-surface-2" onClick={() => remove(t)}>Delete</button>
                    </div>
                  </details>
                )}
              </div>
            </TimelineRow>
          );
        })}
      </ol>

      {unplanned.length > 0 && (
        <Card className="mt-4">
          <p className="text-sm font-medium">Not in the plan yet</p>
          <p className="mt-1 text-sm text-muted">{unplanned.map((t) => t.title).join(', ')}</p>
          <Button size="sm" className="mt-3" onClick={() => replan()} loading={busyId === 'replan'}>Fit {unplanned.length > 1 ? 'them' : 'it'} in ✨</Button>
        </Card>
      )}

      <form onSubmit={addQuick} className="mt-4 flex gap-2">
        <Input value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="Something new came up? e.g. “call bank 15m”" aria-label="Add a task" />
        <Button type="submit" variant="secondary" loading={busyId === 'quick'}>Add</Button>
      </form>

      {day.plan.insights.length > 0 && (
        <div className="mt-6">
          <Tempo mood="🦉"><ul className="space-y-1 text-sm">{day.plan.insights.map((t, i) => <li key={i}>{t}</li>)}</ul></Tempo>
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setPlanning(true)}>✏️ Change my plan</Button>
        {isToday && <Button variant="ghost" onClick={() => replan()} loading={busyId === 'replan'}>🔄 Re-plan from now</Button>}
        {isToday && <Button variant="ghost" onClick={() => { setDate(tomorrow); }}>Plan tomorrow →</Button>}
      </div>
    </div>
  );
}
