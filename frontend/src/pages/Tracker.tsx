import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import clsx from 'clsx';
import { api, apiError } from '../services/api';
import { useAuth } from '../services/auth';
import { Button, ErrorBox, Loading } from '../components/ui';
import { duration } from '../features/day/dayUtils';
import type { DayProgress, ProgressDay } from '../types';

type View = 'week' | 'month' | 'year';

function rangeOf(view: View, anchor: DateTime): { from: DateTime; to: DateTime; label: string } {
  if (view === 'week') {
    const from = anchor.startOf('week');
    const to = anchor.endOf('week');
    return { from, to, label: from.month === to.month ? `${from.toFormat('d')} – ${to.toFormat('d LLLL yyyy')}` : `${from.toFormat('d LLL')} – ${to.toFormat('d LLL yyyy')}` };
  }
  if (view === 'month') return { from: anchor.startOf('month'), to: anchor.endOf('month'), label: anchor.toFormat('LLLL yyyy') };
  return { from: anchor.startOf('year'), to: anchor.endOf('year'), label: anchor.toFormat('yyyy') };
}

/** Completion colour for a day. */
function tone(d: ProgressDay, today: string) {
  if (d.projected) return 'border-dashed border-border bg-surface';
  if (!d.planned) return 'border-border bg-surface';
  if (d.missed) return 'border-warn/30 bg-warn-soft/40';
  if (d.done >= d.planned) return 'border-ok/40 bg-ok-soft/60';
  if (d.done > 0) return 'border-accent/30 bg-accent-soft/50';
  return d.date < today ? 'border-warn/30 bg-warn-soft/40' : 'border-border bg-surface';
}

function Bar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={clsx('h-1.5 overflow-hidden rounded-full bg-surface-2', className)} aria-hidden>
      <div className={clsx('h-full rounded-full transition-all', value >= 1 ? 'bg-ok' : 'bg-accent')} style={{ width: `${Math.round(Math.min(1, value) * 100)}%` }} />
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  );
}

export default function Tracker() {
  const { user } = useAuth();
  const tz = user?.timezone ?? 'UTC';
  const navigate = useNavigate();
  const [view, setView] = useState<View>('month');
  const [anchor, setAnchor] = useState<DateTime>(() => DateTime.now().setZone(tz).startOf('day'));
  const r = rangeOf(view, anchor);
  const from = r.from.toISODate()!;
  const to = r.to.toISODate()!;
  const q = useQuery({ queryKey: ['day-progress', from, to], queryFn: async () => (await api.get<DayProgress>('/day/progress', { params: { from, to } })).data });
  const data = q.data;
  const byDate = useMemo(() => new Map((data?.days ?? []).map((d) => [d.date, d])), [data]);
  const move = (n: number) => setAnchor((a) => a.plus(view === 'week' ? { weeks: n } : view === 'month' ? { months: n } : { years: n }));
  const open = (date: string) => navigate(`/app?date=${date}`);
  const today = data?.today ?? DateTime.now().setZone(tz).toISODate()!;

  const cell = (date: string, big = false) => {
    const d = byDate.get(date);
    const dt = DateTime.fromISO(date);
    const isToday = date === today;
    const ratio = d && d.planned ? d.done / d.planned : 0;
    return (
      <button key={date} type="button" onClick={() => open(date)} title={d ? `${dt.toFormat('ccc d LLL')}: ${d.projected ? `${d.planned} planned` : `${d.done} of ${d.planned} done`}` : undefined}
        className={clsx('flex flex-col rounded-lg border p-2 text-left transition-shadow hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40', d ? tone(d, today) : 'border-border bg-surface', big ? 'min-h-[140px]' : 'min-h-[84px]', isToday && 'ring-2 ring-accent/40')}>
        <div className="flex items-center justify-between">
          <span className={clsx('text-xs tabular-nums', isToday ? 'rounded-full bg-accent px-1.5 font-semibold text-accent-fg' : 'text-muted')}>{big ? dt.toFormat('ccc d') : dt.day}</span>
          {d && d.planned > 0 && !d.projected && <span className="text-[11px] font-medium tabular-nums">{d.done}/{d.planned}</span>}
        </div>
        {d && d.planned > 0 && (
          <div className="mt-auto space-y-1 pt-2">
            {d.projected ? <span className="text-[11px] text-muted">{d.planned} planned · {duration(d.minutes)}</span>
              : d.missed ? <span className="text-[11px] text-warn">Not opened</span>
              : <><Bar value={ratio} />{big && <span className="text-[11px] text-muted">{duration(d.minutesDone)} of {duration(d.minutes)}</span>}</>}
          </div>
        )}
      </button>
    );
  };

  // Month grid: Monday-first weeks covering the month.
  const monthCells = () => {
    const start = r.from.startOf('week');
    const end = r.to.endOf('week');
    const out: (string | null)[] = [];
    for (let d = start; d <= end; d = d.plus({ days: 1 })) out.push(d.month === r.from.month ? d.toISODate()! : null);
    return out;
  };

  const months = view === 'year' ? Array.from({ length: 12 }, (_, i) => r.from.plus({ months: i })) : [];

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted">Tracker</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-[28px]">Your progress</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-border bg-surface p-0.5 text-sm" role="tablist" aria-label="View">
            {(['week', 'month', 'year'] as View[]).map((v) => (
              <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)} className={clsx('rounded-md px-3 py-1.5 font-medium capitalize', view === v ? 'bg-fg text-bg' : 'text-muted hover:text-fg')}>{v}</button>
            ))}
          </div>
          <Link to="/app/planner"><Button size="sm">Plan with chat</Button></Link>
        </div>
      </header>

      <div className="mb-4 flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => move(-1)} aria-label={`Previous ${view}`}>←</Button>
        <div className="text-center">
          <p className="font-semibold">{r.label}</p>
          <button className="text-xs text-accent" onClick={() => setAnchor(DateTime.now().setZone(tz).startOf('day'))}>Back to today</button>
        </div>
        <Button variant="ghost" size="sm" onClick={() => move(1)} aria-label={`Next ${view}`}>→</Button>
      </div>

      {q.error && <ErrorBox message={apiError(q.error).message} />}
      {q.isLoading || !data ? <Loading label="Loading progress…" /> : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Completed" value={`${data.totals.rate}%`} sub={`${data.totals.done} of ${data.totals.planned} tasks`} />
            <Tile label="Time done" value={duration(data.totals.minutesDone)} sub={`of ${duration(data.totals.minutes)} planned`} />
            <Tile label="Active days" value={String(data.totals.activeDays)} sub={`in this ${view}`} />
            <Tile label="Streak" value={`${data.streak} day${data.streak === 1 ? '' : 's'}`} sub="in a row with work done" />
          </div>

          {data.programs.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-2 text-sm">
              {data.programs.map((p) => (
                <span key={p.id} className="rounded-full border border-border bg-surface px-3 py-1">
                  <span className="font-medium">{p.title}</span>
                  {p.dayNumber && p.dayNumber > 0 && p.dayNumber <= p.totalDays ? <span className="text-muted"> · day {p.dayNumber}/{p.totalDays}</span> : null}
                </span>
              ))}
            </div>
          )}

          {view === 'week' && <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">{Array.from({ length: 7 }, (_, i) => cell(r.from.plus({ days: i }).toISODate()!, true))}</div>}

          {view === 'month' && (
            <div>
              <div className="mb-1 grid grid-cols-7 gap-1.5 text-center text-[11px] font-medium uppercase tracking-wide text-muted">
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d}>{d}</div>)}
              </div>
              <div className="grid grid-cols-7 gap-1.5">{monthCells().map((d, i) => (d ? cell(d) : <div key={`x${i}`} />))}</div>
            </div>
          )}

          {view === 'year' && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {months.map((m) => {
                const ds = data.days.filter((d) => d.date.startsWith(m.toFormat('yyyy-LL')));
                const past = ds.filter((d) => !d.projected);
                const planned = past.reduce((s, d) => s + d.planned, 0);
                const done = past.reduce((s, d) => s + d.done, 0);
                const ahead = ds.filter((d) => d.projected).reduce((s, d) => s + d.planned, 0);
                return (
                  <button key={m.month} type="button" onClick={() => { setAnchor(m); setView('month'); }} className="rounded-xl border border-border bg-surface p-3 text-left hover:shadow-sm">
                    <div className="flex items-center justify-between text-sm"><span className="font-medium">{m.toFormat('LLLL')}</span><span className="tabular-nums text-muted">{planned ? `${Math.round((done / planned) * 100)}%` : '–'}</span></div>
                    <div className="mt-2 grid grid-cols-[repeat(31,minmax(0,1fr))] gap-px">
                      {Array.from({ length: m.daysInMonth! }, (_, i) => {
                        const d = byDate.get(m.plus({ days: i }).toISODate()!);
                        const c = !d || !d.planned ? 'bg-surface-2' : d.projected ? 'bg-border' : d.done >= d.planned ? 'bg-ok' : d.done > 0 ? 'bg-accent/70' : 'bg-warn/50';
                        return <span key={i} className={clsx('h-4 rounded-[2px]', c)} />;
                      })}
                    </div>
                    <p className="mt-2 text-xs text-muted">{done} of {planned} done{ahead ? ` · ${ahead} planned ahead` : ''}</p>
                  </button>
                );
              })}
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-4 text-xs text-muted">
            <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border border-ok/40 bg-ok-soft" />All done</span>
            <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border border-accent/30 bg-accent-soft" />Partly done</span>
            <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border border-warn/30 bg-warn-soft" />Missed</span>
            <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border border-dashed border-border" />Planned ahead</span>
            <span>Click a day to open it.</span>
          </div>
        </>
      )}
    </div>
  );
}
