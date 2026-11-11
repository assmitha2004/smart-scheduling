import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { api, apiError } from '../../services/api';
import { Button, ErrorBox, Spinner } from '../../components/ui';
import type { DayData, DayFeedbackDraft, DayPreview, DaySettings, DayUnderstanding, DraftDayTask, Effort, Peak } from '../../types';
import { DURATION_CHOICES, clock, duration, toMin } from './dayUtils';
import { LEGEND, Timeline } from './Timeline';
import { FeedbackPanel, type FeedbackLog } from './Feedback';

const SELECT = 'h-7 rounded-md border border-border bg-surface px-1.5 text-xs text-fg outline-none focus:border-accent';
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
const endClock = (hm: string) => clock(toMin(hm === '24:00' ? '23:59' : hm));

function windowLabel(t: DraftDayTask) {
  if (t.fixedTime) return `at ${clock(toMin(t.fixedTime))}`;
  if (t.notBefore && t.dueBy) return `${clock(toMin(t.notBefore))}–${endClock(t.dueBy)}`;
  if (t.dueBy) return `by ${endClock(t.dueBy)}`;
  if (t.notBefore) return `after ${clock(toMin(t.notBefore))}`;
  return null;
}

interface Snapshot { tasks: DraftDayTask[]; settings: DaySettings; preview: DayPreview; removeIds: string[]; deferIds: string[] }

/** "Here's the plan": edit tasks directly or say what to change; the preview updates live. */
export function Review({ initial, isToday, onSaved, onBack }: { initial: DayUnderstanding; isToday: boolean; onSaved: (d: DayData, moved: string[]) => void; onBack: () => void }) {
  const [tasks, setTasks] = useState<DraftDayTask[]>(initial.tasks);
  const [settings, setSettings] = useState<DaySettings>(initial.settings);
  const [preview, setPreview] = useState<DayPreview>(initial.preview);
  const [removeIds, setRemoveIds] = useState<string[]>([]);
  const [deferIds, setDeferIds] = useState<string[]>([]);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [log, setLog] = useState<FeedbackLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skipPreview = useRef(true);

  const payload = (dryRun: boolean) => ({
    date: initial.date,
    settings,
    dryRun,
    removeIds,
    deferIds,
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, minutes: t.minutes, mustDo: t.mustDo, top: t.top, effort: t.effort, fixedTime: t.fixedTime, notBefore: t.notBefore ?? null, dueBy: t.dueBy ?? null })),
  });

  // Re-plan the preview shortly after a manual edit.
  useEffect(() => {
    if (skipPreview.current) { skipPreview.current = false; return; }
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
  // Taking a saved task out of today's plan leaves it on the list for later.
  const removeTask = (i: number) => setTasks((ts) => ts.filter((_, j) => j !== i));

  async function feedback(text: string) {
    setLoading(true);
    setError(null);
    try {
      const r = await api.post<DayFeedbackDraft>('/day/feedback', { date: initial.date, text, draft: { settings, tasks } });
      setLog((l) => [...l, { text, changes: r.data.changes, notUnderstood: r.data.notUnderstood, help: r.data.help }]);
      if (!r.data.changes.length) return;
      setHistory((h) => [...h, { tasks, settings, preview, removeIds, deferIds }]);
      skipPreview.current = true;
      setTasks(r.data.tasks);
      setSettings(r.data.settings);
      if (r.data.preview) setPreview(r.data.preview);
      for (const x of r.data.removed) if (x.id) (x.tomorrow ? setDeferIds : setRemoveIds)((ids) => [...ids, x.id!]);
    } catch (e) {
      setError(apiError(e).message);
    } finally {
      setLoading(false);
    }
  }
  function undo() {
    const prev = history[history.length - 1];
    if (!prev) return;
    skipPreview.current = true;
    setTasks(prev.tasks);
    setSettings(prev.settings);
    setPreview(prev.preview);
    setRemoveIds(prev.removeIds);
    setDeferIds(prev.deferIds);
    setHistory((h) => h.slice(0, -1));
    setLog((l) => [...l, { text: 'Undo', changes: ['Went back to the previous version of the plan.'], notUnderstood: [], help: null }]);
  }

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
  const free = Math.max(0, preview.stats.freeMinutes - scheduledMinutes);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted">Proposed plan · {isToday ? 'Today' : 'Tomorrow'}</p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight">{clock(toMin(settings.dayStart))} – {endClock(settings.dayEnd)}</h2>
          </div>
          <dl className="flex gap-6 text-sm">
            <div><dt className="text-xs text-muted">Scheduled</dt><dd className="font-semibold tabular-nums">{preview.stats.scheduledCount} of {preview.stats.taskCount}</dd></div>
            <div><dt className="text-xs text-muted">Work</dt><dd className="font-semibold tabular-nums">{duration(scheduledMinutes)}</dd></div>
            <div><dt className="text-xs text-muted">Unplanned</dt><dd className="font-semibold tabular-nums">{duration(free)}</dd></div>
          </dl>
        </div>
        {preview.insights.length > 0 && (
          <ul className="mb-4 space-y-1 text-sm text-muted">
            {preview.insights.map((t, i) => <li key={i} className="flex gap-2"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted" aria-hidden /><span>{t}</span></li>)}
          </ul>
        )}
        {preview.overflow.length > 0 && (
          <div className="mb-4 rounded-lg border border-warn/30 bg-warn-soft/40 px-3.5 py-2.5 text-sm">
            <span className="font-medium">Moves to {isToday ? 'tomorrow' : 'the next day'}:</span> <span className="text-muted">{preview.overflow.map((o) => (o.partial ? `the last ${duration(o.minutes)} of ${o.title}` : `${o.title} (${duration(o.minutes)})`)).join(' · ')}</span>
          </div>
        )}
        <div className={clsx('relative transition-opacity', loading && 'opacity-60')}>
          {loading && <span className="absolute right-0 -top-7 flex items-center gap-1.5 text-xs text-muted"><Spinner className="h-3.5 w-3.5" /> Updating</span>}
          <Timeline entries={preview.items.map((item) => {
            const t = item.taskId ? effortById.get(item.taskId) : undefined;
            return { item, effort: t?.effort, fixed: !!t?.fixedTime };
          })} />
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 pl-[4.75rem] text-xs text-muted">
          {LEGEND.map((l) => <span key={l.label} className="flex items-center gap-1.5"><span className={clsx('h-2.5 w-2.5 rounded-sm', l.cls)} />{l.label}</span>)}
        </div>
      </section>

      <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
        <FeedbackPanel onSend={feedback} busy={loading} log={log} onUndo={undo} canUndo={history.length > 0} />

        <div className="rounded-xl border border-border bg-surface">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">Tasks ({tasks.length})</h3>
            <span className="text-[11px] text-muted">{initial.source === 'ai' ? 'Read by Claude' : 'Built-in planner'}</span>
          </div>
          <ul className="max-h-[42vh] divide-y divide-border overflow-auto">
            {tasks.map((t, i) => (
              <li key={t.id ?? `${t.title}-${i}`} className="px-4 py-2.5">
                <div className="flex items-start gap-2">
                  <button type="button" title={t.top ? 'Top priority' : 'Make this the top priority'} aria-pressed={t.top} onClick={() => update(i, { top: !t.top, mustDo: !t.top ? true : t.mustDo })}
                    className={clsx('mt-0.5 text-sm leading-none', t.top ? 'text-amber-500' : 'text-border hover:text-amber-400')}>★</button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{t.title}{t.fromEarlier && <span className="ml-1.5 text-[11px] font-normal text-warn">carried over</span>}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <select aria-label={`Duration of ${t.title}`} value={t.minutes} onChange={(e) => update(i, { minutes: Number(e.target.value), minutesGuessed: false })} className={SELECT}>
                        {[...new Set([...DURATION_CHOICES, 240, t.minutes])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{duration(m)}{m === t.minutes && t.minutesGuessed ? ' (est.)' : ''}</option>)}
                      </select>
                      <select aria-label={`Focus needed for ${t.title}`} value={t.effort} onChange={(e) => update(i, { effort: e.target.value as Effort })} className={SELECT}>
                        {EFFORTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                      </select>
                      <button type="button" aria-pressed={t.mustDo} onClick={() => update(i, { mustDo: !t.mustDo })}
                        className={clsx('h-7 rounded-md border px-2 text-xs', t.mustDo ? 'border-accent/40 bg-accent-soft text-accent' : 'border-border text-muted hover:text-fg')}>
                        {t.mustDo ? 'Must do' : 'Optional'}
                      </button>
                      {windowLabel(t) && (
                        <span className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted">
                          {windowLabel(t)}
                          <button type="button" aria-label="Remove time" className="hover:text-fg" onClick={() => update(i, { fixedTime: null, notBefore: null, dueBy: null })}>×</button>
                        </span>
                      )}
                    </div>
                  </div>
                  <button type="button" aria-label={`Remove ${t.title}`} onClick={() => removeTask(i)} className="px-1 text-muted hover:text-danger">×</button>
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
          {(settings.commitments?.length || settings.windows?.length) ? (
            <div className="space-y-1 border-t border-border px-4 py-3 text-xs text-muted">
              {settings.commitments?.map((c, i) => (
                <p key={`c${i}`} className="flex items-center justify-between gap-2">
                  <span><span className="font-medium text-fg">{c.title}</span> {clock(toMin(c.start))}–{endClock(c.end)}</span>
                  <button type="button" className="hover:text-danger" aria-label={`Remove ${c.title}`} onClick={() => setSettings({ ...settings, commitments: settings.commitments!.filter((_, j) => j !== i) })}>×</button>
                </p>
              ))}
              {settings.windows?.map((w, i) => (
                <p key={`w${i}`} className="flex items-center justify-between gap-2">
                  <span><span className="font-medium text-fg">Free</span> {clock(toMin(w.start))}–{endClock(w.end)}{w.light ? ' · light work' : ''}</span>
                  <button type="button" className="hover:text-danger" aria-label="Remove free time" onClick={() => setSettings({ ...settings, windows: settings.windows!.filter((_, j) => j !== i) })}>×</button>
                </p>
              ))}
            </div>
          ) : null}
        </div>
        {initial.notes.length > 0 && (
          <ul className="space-y-1 px-1 text-xs text-muted">{initial.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        )}
        {error && <ErrorBox message={error} />}
        <div className="flex gap-2">
          <Button className="flex-1" onClick={save} loading={saving} disabled={!tasks.length || loading}>{isToday ? 'Save and start my day' : 'Save tomorrow’s plan'}</Button>
          <Button variant="secondary" onClick={onBack}>Edit description</Button>
        </div>
      </aside>
    </div>
  );
}
