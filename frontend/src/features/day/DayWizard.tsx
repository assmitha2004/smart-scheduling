import { useEffect, useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { api, apiError } from '../../services/api';
import { useAuth } from '../../services/auth';
import { Button, ErrorBox, Spinner } from '../../components/ui';
import { Chip, ChoiceCard, Tempo, TimeInput } from '../planner/controls';
import type { DayData, DayPlanItem, DaySettings, DayTask, Effort, ParsedTask, Peak } from '../../types';
import { DURATION_CHOICES, TimelineRow, clock, duration, toMin } from './dayUtils';

/** A task while answering the questions. */
interface Draft {
  key: string;
  id?: string;
  title: string;
  minutes: number;
  minutesGuessed: boolean;
  mustDo: boolean;
  top: boolean;
  effort: Effort;
  fixedTime: string | null;
  fromEarlier: boolean;
}

interface Preview {
  items: DayPlanItem[];
  overflow: { taskId: string; title: string; minutes: number; mustDo: boolean }[];
  insights: string[];
  stats: { freeMinutes: number; plannedMinutes: number; taskCount: number; scheduledCount: number };
}

const PEAKS: { id: Peak; emoji: string; title: string; blurb: string }[] = [
  { id: 'MORNING', emoji: '🌅', title: 'Morning', blurb: 'Sharpest before lunch' },
  { id: 'AFTERNOON', emoji: '☀️', title: 'Afternoon', blurb: 'Warm up, then go' },
  { id: 'EVENING', emoji: '🌙', title: 'Evening', blurb: 'Come alive later' },
];

let keySeq = 0;
const nextKey = () => `d${++keySeq}`;
const fromTask = (t: DayTask, fromEarlier: boolean): Draft => ({ key: nextKey(), id: t.id, title: t.title, minutes: t.minutes, minutesGuessed: false, mustDo: t.mustDo || fromEarlier, top: false, effort: t.effort, fixedTime: t.fixedTime, fromEarlier });

export function DayWizard({ day, date, onSaved, onCancel }: { day: DayData; date: string; onSaved: (d: DayData, moved: string[]) => void; onCancel?: () => void }) {
  const { user } = useAuth();
  const first = user?.name.split(' ')[0] ?? 'friend';
  const isToday = date === day.today;
  // Start from what's already on the day plus leftovers from earlier days.
  const [drafts, setDrafts] = useState<Draft[]>(() => [
    ...day.leftovers.map((t) => fromTask(t, true)),
    ...day.tasks.filter((t) => !t.done).map((t) => ({ ...fromTask(t, false), top: t.top })),
  ]);
  const [text, setText] = useState('');
  const [settings, setSettings] = useState<DaySettings>(() => {
    const s = day.plan?.settings ?? day.defaults;
    return isToday ? { ...s, dayStart: day.defaults.dayStart > s.dayStart ? day.defaults.dayStart : s.dayStart } : s;
  });
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const update = (key: string, patch: Partial<Draft>) => { setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d))); setPreview(null); };
  const removed = useMemo(() => [...day.tasks.filter((t) => !t.done), ...day.leftovers].map((t) => t.id).filter((id) => !drafts.some((d) => d.id === id)), [day, drafts]);

  async function addFromText() {
    if (!text.trim()) return true;
    try {
      const r = await api.post<{ tasks: ParsedTask[] }>('/day/parse', { text });
      setDrafts((ds) => [...ds, ...r.data.tasks.map((t) => ({ key: nextKey(), ...t, mustDo: false, top: false, fromEarlier: false }))]);
      setText('');
      return true;
    } catch (e) {
      setError(apiError(e).message);
      return false;
    }
  }

  const steps: { id: string; mood: string; say: ReactNode; body: ReactNode; valid?: () => string | null }[] = [
    {
      id: 'dump', mood: '📝',
      say: <>Hi {first}! Don’t worry about order or timing, that’s my job. <b>What do you need to do {isToday ? 'today' : 'tomorrow'}?</b> Type everything on your mind, one per line. Add a time if you know it, like “gym 1h” or “call mom at 6pm”.</>,
      valid: () => (drafts.length === 0 && !text.trim() ? 'Add at least one task 🙂' : null),
      body: (
        <div className="space-y-3">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} autoFocus
            placeholder={'finish assignment 2h\nreply to emails\ngym\ncall mom at 6pm\nbuy groceries'}
            className="w-full rounded-xl border border-border bg-surface px-3.5 py-3 text-[15px] leading-relaxed outline-none focus:border-accent" aria-label="Your tasks, one per line" />
          {drafts.length > 0 && (
            <div>
              <p className="mb-2 text-sm font-medium">Already on your list</p>
              <ul className="flex flex-wrap gap-2">
                {drafts.map((d) => (
                  <li key={d.key} className="flex items-center gap-1.5 rounded-full border border-border bg-surface-2 py-1 pl-3 pr-1.5 text-sm">
                    {d.fromEarlier && <span title="Left over from before" aria-label="left over">↩️</span>}{d.title}
                    <button type="button" className="rounded-full px-1.5 text-muted hover:text-danger" aria-label={`Remove ${d.title}`} onClick={() => { setDrafts((ds) => ds.filter((x) => x.key !== d.key)); setPreview(null); }}>✕</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ),
    },
    {
      id: 'time', mood: '⏱️',
      say: <>Roughly how long will each one take? I made a guess where you didn’t say. Tap to change it. Not sure? Keep my guess.</>,
      body: (
        <ul className="space-y-3">
          {drafts.map((d) => (
            <li key={d.key} className="rounded-xl border border-border p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-sm font-medium">
                {d.title}
                {d.minutesGuessed && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-normal text-muted">my guess</span>}
                {d.fixedTime && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent">⏰ at {clock(toMin(d.fixedTime))} <button type="button" aria-label="Remove set time" onClick={() => update(d.key, { fixedTime: null })}>✕</button></span>}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {[...new Set([...DURATION_CHOICES, d.minutes])].sort((a, b) => a - b).map((m) => (
                  <Chip key={m} on={d.minutes === m} onClick={() => update(d.key, { minutes: m, minutesGuessed: false })}>{duration(m)}</Chip>
                ))}
              </div>
            </li>
          ))}
        </ul>
      ),
    },
    {
      id: 'must', mood: '📌',
      say: <>Which of these <b>must</b> happen {isToday ? 'today' : 'tomorrow'}, no matter what? Tap them. The rest can slide if the day gets busy.</>,
      body: (
        <div className="flex flex-wrap gap-2">
          {drafts.map((d) => <Chip key={d.key} on={d.mustDo} onClick={() => update(d.key, { mustDo: !d.mustDo })}>{d.mustDo ? '📌 ' : ''}{d.title}</Chip>)}
          <p className="w-full pt-1 text-xs text-muted">Tip: things left over from before are already marked 📌. Tap to unmark.</p>
        </div>
      ),
    },
    {
      id: 'top', mood: '⭐',
      say: <>If you could only finish <b>one</b> thing, which would make you happiest? It gets your best time.</>,
      body: (
        <div className="flex flex-wrap gap-2">
          {[...drafts].sort((a, b) => Number(b.mustDo) - Number(a.mustDo)).map((d) => (
            <Chip key={d.key} on={d.top} onClick={() => { setDrafts((ds) => ds.map((x) => ({ ...x, top: x.key === d.key ? !x.top : false }))); setPreview(null); }}>{d.top ? '⭐ ' : ''}{d.title}</Chip>
          ))}
          <Chip on={!drafts.some((d) => d.top)} onClick={() => { setDrafts((ds) => ds.map((x) => ({ ...x, top: false }))); setPreview(null); }}>🤷 Not sure, you decide</Chip>
        </div>
      ),
    },
    {
      id: 'hard', mood: '🧠',
      say: <>Which ones need your <b>full brain</b>? I’ll put those when you’re sharpest and the easy stuff when you’re tired.</>,
      body: (
        <ul className="space-y-2">
          {drafts.map((d) => (
            <li key={d.key} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>{d.title}</span>
              <span className="flex gap-1.5">
                {(['EASY', 'MEDIUM', 'HARD'] as Effort[]).map((e) => <Chip key={e} on={d.effort === e} onClick={() => update(d.key, { effort: e })}>{{ EASY: '🍃 Easy', MEDIUM: '🙂 Normal', HARD: '🧠 Hard' }[e]}</Chip>)}
              </span>
            </li>
          ))}
        </ul>
      ),
    },
    {
      id: 'day', mood: '⏰',
      say: <>Last question! When {isToday ? 'does the rest of your day' : 'does your day'} start and end, and when do you focus best?</>,
      valid: () => (toMin(settings.dayEnd) <= toMin(settings.dayStart) + 15 ? 'The day needs to end after it starts 🙂' : null),
      body: (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2">{isToday ? '▶️ From' : '☀️ Start at'} <TimeInput label="Day start" value={settings.dayStart} onChange={(v) => { setSettings({ ...settings, dayStart: v }); setPreview(null); }} /></label>
            <label className="flex items-center gap-2">🌙 Stop at <TimeInput label="Day end" value={settings.dayEnd === '24:00' ? '23:59' : settings.dayEnd} onChange={(v) => { setSettings({ ...settings, dayEnd: v }); setPreview(null); }} /></label>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            {PEAKS.map((p) => <ChoiceCard key={p.id} selected={settings.peak === p.id} onClick={() => { setSettings({ ...settings, peak: p.id }); setPreview(null); }} emoji={p.emoji} title={p.title} blurb={p.blurb} />)}
          </div>
        </div>
      ),
    },
    {
      id: 'review', mood: '✨',
      say: preview ? <>Here’s your {isToday ? 'day' : 'plan for tomorrow'}, {first}! Nothing is saved until you tap the button.</> : <>Working out the smartest order…</>,
      body: !preview ? <div className="flex items-center gap-2 py-8 text-sm text-muted"><Spinner className="h-4 w-4" /> Planning…</div> : (
        <div className="space-y-4">
          <ul className="space-y-1.5 rounded-xl border border-border bg-surface-2/50 p-3 text-sm">
            {preview.insights.map((t, i) => <li key={i} className="flex gap-2"><span aria-hidden>💡</span><span>{t}</span></li>)}
          </ul>
          <ol className="space-y-1.5">
            {preview.items.map((it, i) => (
              <TimelineRow key={i} item={it}>
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{it.title}{it.parts ? ` (${it.part}/${it.parts})` : ''}</span>
                    {it.reason && <span className="block text-xs text-muted">{it.reason}</span>}
                  </span>
                  <span className="shrink-0 text-xs text-muted">{duration(it.end - it.start)}</span>
                </div>
              </TimelineRow>
            ))}
          </ol>
          {preview.overflow.length > 0 && (
            <div className="rounded-xl border border-warn/40 bg-warn-soft/50 p-3 text-sm">
              <p className="font-medium">Moving to {isToday ? 'tomorrow' : 'the day after'} 💛</p>
              <p className="text-muted">{preview.overflow.map((o) => o.title).join(', ')}</p>
            </div>
          )}
        </div>
      ),
    },
  ];
  const current = steps[step];

  const payload = (dryRun: boolean) => ({
    date,
    settings,
    dryRun,
    removeIds: removed,
    tasks: drafts.map((d) => ({ id: d.id, title: d.title, minutes: d.minutes, mustDo: d.mustDo, top: d.top, effort: d.effort, fixedTime: d.fixedTime })),
  });

  useEffect(() => {
    if (current.id !== 'review' || preview) return;
    let cancelled = false;
    api.post<{ preview: Preview }>('/day/plan', payload(true))
      .then((r) => { if (!cancelled) setPreview(r.data.preview); })
      .catch((e) => { if (!cancelled) setError(apiError(e).message); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.id, preview]);

  async function next() {
    setError(null);
    if (current.id === 'dump' && !(await addFromText())) return;
    const msg = current.valid?.();
    if (msg && !(current.id === 'dump' && drafts.length)) return setError(msg);
    setStep((s) => Math.min(steps.length - 1, s + 1));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ day: DayData; moved: string[] }>('/day/plan', payload(false));
      onSaved(r.data.day, r.data.moved);
    } catch (e) {
      setError(apiError(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <ol className="flex gap-1" aria-label="Progress">
        {steps.map((s, k) => <li key={s.id} className={clsx('h-1.5 flex-1 rounded-full transition-colors', k <= step ? 'bg-accent' : 'bg-border')} />)}
      </ol>
      <div key={current.id} className="wizard-step space-y-4">
        <Tempo mood={current.mood}>{current.say}</Tempo>
        <div className="rounded-xl border border-border bg-surface p-4 sm:p-5">{current.body}</div>
      </div>
      {error && <ErrorBox message={error} />}
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => { setError(null); setStep((s) => Math.max(0, s - 1)); }} disabled={step === 0}>← Back</Button>
          {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
        </div>
        <span className="hidden text-xs text-muted sm:inline">Question {Math.min(step + 1, steps.length - 1)} of {steps.length - 1}</span>
        {current.id === 'review'
          ? <Button onClick={save} loading={busy} disabled={!preview}>{isToday ? 'Start my day 🚀' : 'Save tomorrow’s plan'}</Button>
          : <Button onClick={next}>{steps[step + 1]?.id === 'review' ? 'Plan it ✨' : 'Next →'}</Button>}
      </div>
    </div>
  );
}
