import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { api, apiError } from '../../services/api';
import { Button, ErrorBox, Spinner } from '../../components/ui';

const SELECT = 'h-7 rounded-md border border-border bg-surface px-1.5 text-xs text-fg outline-none focus:border-accent';
import type { DayData, DayPreview, DaySettings, DayUnderstanding, DraftDayTask, Effort, Peak } from '../../types';
import { DURATION_CHOICES, clock, duration, toMin } from './dayUtils';
import { LEGEND, Timeline } from './Timeline';

const PEAKS: { id: Peak; label: string }[] = [
  { id: 'MORNING', label: 'Morning' },
  { id: 'AFTERNOON', label: 'Afternoon' },
  { id: 'EVENING', label: 'Evening' },
];
const EFFORTS: { id: Effort; label: string }[] = [
  { id: 'EASY', label: 'Light' },
  { id: 'MEDIUM', label: 'Normal' },
  { id: 'HARD', label: 'Deep focus' },
];

function windowLabel(t: DraftDayTask) {
  if (t.fixedTime) return `at ${clock(toMin(t.fixedTime))}`;
  if (t.notBefore && t.dueBy) return `${clock(toMin(t.notBefore))}–${clock(toMin(t.dueBy === '24:00' ? '23:59' : t.dueBy))}`;
  if (t.dueBy) return `by ${clock(toMin(t.dueBy))}`;
  if (t.notBefore) return `after ${clock(toMin(t.notBefore))}`;
  return null;
}

/** "Here's what I understood": edit tasks and settings; the plan preview updates live. */
export function Review({ initial, isToday, onSaved, onBack }: { initial: DayUnderstanding; isToday: boolean; onSaved: (d: DayData, moved: string[]) => void; onBack: () => void }) {
  const [tasks, setTasks] = useState<DraftDayTask[]>(initial.tasks);
  const [settings, setSettings] = useState<DaySettings>(initial.settings);
  const [preview, setPreview] = useState<DayPreview>(initial.preview);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef(true);

  const payload = (dryRun: boolean) => ({
    date: initial.date,
    settings,
    dryRun,
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, minutes: t.minutes, mustDo: t.mustDo, top: t.top, effort: t.effort, fixedTime: t.fixedTime, notBefore: t.notBefore ?? null, dueBy: t.dueBy ?? null })),
  });

  // Re-plan the preview shortly after each change.
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (!tasks.length) return;
    const id = setTimeout(() => {
      setLoading(true);
      api.post<{ preview: DayPreview }>('/day/plan', payload(true))
        .then((r) => { setPreview(r.data.preview); setError(null); })
        .catch((e) => setError(apiError(e).message))
        .finally(() => setLoading(false));
    }, 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, settings]);

  const update = (i: number, patch: Partial<DraftDayTask>) => setTasks((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : patch.top ? { ...t, top: false } : t)));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const r = await api.post<{ day: DayData; moved: string[] }>('/day/plan', payload(false));
      onSaved(r.data.day, r.data.moved);
    } catch (e) {
      setError(apiError(e).message);
    } finally {
      setSaving(false);
    }
  }

  const effortById = new Map(tasks.map((t, i) => [t.id ?? `new-${i}`, t]));
  const scheduledMinutes = preview.items.filter((i) => i.kind === 'TASK').reduce((s, i) => s + i.end - i.start, 0);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-accent">Proposed plan</p>
            <h2 className="text-xl font-semibold tracking-tight">{isToday ? 'Your day' : 'Tomorrow'}, {clock(toMin(settings.dayStart))} – {clock(toMin(settings.dayEnd === '24:00' ? '23:59' : settings.dayEnd))}</h2>
            <p className="text-sm text-muted">{preview.stats.scheduledCount} of {preview.stats.taskCount} tasks scheduled · {duration(scheduledMinutes)} of work · {duration(Math.max(0, preview.stats.freeMinutes - scheduledMinutes))} free</p>
          </div>
          {loading && <span className="flex items-center gap-1.5 text-xs text-muted"><Spinner className="h-3.5 w-3.5" /> Updating</span>}
        </div>
        {preview.insights.length > 0 && (
          <ul className="mb-4 space-y-1.5 rounded-xl border border-accent/20 bg-accent-soft/40 p-3.5 text-sm">
            {preview.insights.map((t, i) => <li key={i} className="flex gap-2"><span className="text-accent" aria-hidden>●</span><span>{t}</span></li>)}
          </ul>
        )}
        <div className={clsx('transition-opacity', loading && 'opacity-60')}>
          <Timeline entries={preview.items.map((item) => {
            const t = item.taskId ? effortById.get(item.taskId) : undefined;
            return { item, effort: t?.effort, fixed: !!t?.fixedTime };
          })} />
        </div>
        <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted">
          {LEGEND.map((l) => <span key={l.label} className="flex items-center gap-1.5"><span className={clsx('h-2.5 w-2.5 rounded-sm', l.cls)} />{l.label}</span>)}
        </div>
        {preview.overflow.length > 0 && (
          <div className="mt-4 rounded-xl border border-warn/30 bg-warn-soft/40 p-3.5 text-sm">
            <p className="font-medium">Doesn’t fit, moves to {isToday ? 'tomorrow' : 'the next day'}</p>
            <p className="mt-0.5 text-muted">{preview.overflow.map((o) => `${o.title} (${duration(o.minutes)})`).join(' · ')}</p>
          </div>
        )}
      </section>

      <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
        <div className="rounded-xl border border-border bg-surface">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-sm font-semibold">What I understood</p>
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">{initial.source === 'ai' ? 'Read by Claude' : 'Built-in planner'}</span>
          </div>
          <ul className="max-h-[52vh] divide-y divide-border overflow-auto">
            {tasks.map((t, i) => (
              <li key={t.id ?? `${t.title}-${i}`} className="px-4 py-3">
                <div className="flex items-start gap-2">
                  <button type="button" title={t.top ? 'Most important' : 'Make this the most important'} aria-pressed={t.top} onClick={() => update(i, { top: !t.top, mustDo: !t.top ? true : t.mustDo })}
                    className={clsx('mt-0.5 text-base leading-none', t.top ? 'text-amber-500' : 'text-border hover:text-amber-400')}>★</button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{t.title}{t.fromEarlier && <span className="ml-1.5 rounded bg-warn-soft px-1.5 py-0.5 text-[10px] font-normal text-warn">from before</span>}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <select aria-label={`Duration of ${t.title}`} value={t.minutes} onChange={(e) => update(i, { minutes: Number(e.target.value), minutesGuessed: false })} className={SELECT}>
                        {[...new Set([...DURATION_CHOICES, 240, t.minutes])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{duration(m)}{m === t.minutes && t.minutesGuessed ? ' (guess)' : ''}</option>)}
                      </select>
                      <select aria-label={`Focus needed for ${t.title}`} value={t.effort} onChange={(e) => update(i, { effort: e.target.value as Effort })} className={SELECT}>
                        {EFFORTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                      </select>
                      <button type="button" aria-pressed={t.mustDo} onClick={() => update(i, { mustDo: !t.mustDo })}
                        className={clsx('h-7 rounded-md border px-2 text-xs', t.mustDo ? 'border-accent/40 bg-accent-soft text-accent' : 'border-border text-muted hover:text-fg')}>
                        {t.mustDo ? 'Must do' : 'Optional'}
                      </button>
                      {windowLabel(t) && (
                        <span className="flex h-7 items-center gap-1 rounded-md bg-amber-50 px-2 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                          {windowLabel(t)}
                          <button type="button" aria-label="Remove time" onClick={() => update(i, { fixedTime: null, notBefore: null, dueBy: null })}>×</button>
                        </span>
                      )}
                    </div>
                  </div>
                  <button type="button" aria-label={`Remove ${t.title}`} onClick={() => setTasks((ts) => ts.filter((_, j) => j !== i))} className="px-1 text-muted hover:text-danger">×</button>
                </div>
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-3 gap-2 border-t border-border px-4 py-3 text-xs">
            <label className="space-y-1"><span className="text-muted">Start</span><input type="time" value={settings.dayStart} onChange={(e) => setSettings({ ...settings, dayStart: e.target.value })} className="w-full rounded-md border border-border bg-surface px-1.5 py-1" /></label>
            <label className="space-y-1"><span className="text-muted">End</span><input type="time" value={settings.dayEnd === '24:00' ? '23:59' : settings.dayEnd} onChange={(e) => setSettings({ ...settings, dayEnd: e.target.value })} className="w-full rounded-md border border-border bg-surface px-1.5 py-1" /></label>
            <label className="space-y-1"><span className="text-muted">Best focus</span>
              <select value={settings.peak} onChange={(e) => setSettings({ ...settings, peak: e.target.value as Peak })} className="w-full rounded-md border border-border bg-surface px-1 py-1">
                {PEAKS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
          </div>
        </div>
        {initial.notes.length > 0 && (
          <ul className="space-y-1 px-1 text-xs text-muted">{initial.notes.map((n, i) => <li key={i}>• {n}</li>)}</ul>
        )}
        {error && <ErrorBox message={error} />}
        <div className="flex gap-2">
          <Button className="flex-1" onClick={save} loading={saving} disabled={!tasks.length || loading}>{isToday ? 'Start my day' : 'Save tomorrow’s plan'}</Button>
          <Button variant="secondary" onClick={onBack}>Edit text</Button>
        </div>
      </aside>
    </div>
  );
}
