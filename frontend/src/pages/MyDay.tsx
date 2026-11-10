import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { api, apiError } from '../services/api';
import { useAuth } from '../services/auth';
import { useToast } from '../components/Toast';
import { useCelebrate } from '../components/Celebrate';
import { Button, Card, ErrorBox, Input, Loading, Modal, Textarea } from '../components/ui';
import { fmtMinutes, fmtTime } from '../lib/format';
import { Chip, Tempo } from '../features/planner/controls';
import { SchedulePreviewView } from '../features/scheduling/SchedulePreview';
import { usePlannerAnswers } from './PlanMyTime';
import { newKey, parseDump, parseLine, type DraftTask, type Due } from '../features/day/parse';
import type { DayBlock, DayTask, DayView, Energy, Priority, SchedulePreview } from '../types';

const PRIORITIES: { v: Priority; label: string }[] = [
  { v: 'URGENT', label: '🚨 Must do today' },
  { v: 'HIGH', label: '🔥 Important' },
  { v: 'MEDIUM', label: '🙂 Normal' },
  { v: 'LOW', label: '🌱 If there’s time' },
];
const LENGTHS = [15, 30, 45, 60, 90, 120, 180];
const DUES: { v: Due; label: string }[] = [
  { v: 'TODAY', label: 'Today' },
  { v: 'TOMORROW', label: 'Tomorrow' },
  { v: 'WEEK', label: 'This week' },
  { v: 'NONE', label: 'No deadline' },
];
const ENERGY: { v: Energy; emoji: string; title: string; blurb: string }[] = [
  { v: 'LOW', emoji: '😴', title: 'Low', blurb: 'Short 30-minute sessions' },
  { v: 'OK', emoji: '🙂', title: 'Okay', blurb: 'My usual focus length' },
  { v: 'HIGH', emoji: '🔥', title: 'Great', blurb: 'Longer deep-work sessions' },
];
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const FIRST = ['First win of the day. Momentum unlocked! ✨', 'One down. Starting is the hardest part, and you did it. 💪', 'Nice start. Keep riding this. 🚀'];
const HALF = ['Halfway there. You’re doing better than you think. 🌟', '50% done. Breathe, then keep going. 🌈'];

function dueFromTask(t: DayTask, today: DateTime): Due {
  if (!t.dueAt) return 'NONE';
  const d = Math.round(DateTime.fromISO(t.dueAt).setZone(today.zone).startOf('day').diff(today.startOf('day'), 'days').days);
  return d <= 0 ? 'TODAY' : d === 1 ? 'TOMORROW' : 'WEEK';
}
function draftFromTask(t: DayTask, today: DateTime): DraftTask {
  return {
    key: t.id, id: t.id, title: t.title, minutes: Math.max(5, t.remainingMinutes || 30), guessed: false, priority: t.priority, due: dueFromTask(t, today),
    startAfter: t.earliestStartAt && DateTime.fromISO(t.earliestStartAt) > DateTime.now() ? DateTime.fromISO(t.earliestStartAt).setZone(today.zone).toFormat('HH:mm') : null,
    carried: t.carried,
  };
}

type Step = 'dump' | 'questions' | 'one' | 'energy' | 'preview';
interface Planner {
  step: Step;
  text: string;
  include: Record<string, boolean>;
  drafts: DraftTask[];
  top: string | null;
  energy: Energy;
  /** Today's free window; null = use my usual working hours. */
  window: { from: string; until: string } | null;
  preview: SchedulePreview | null;
}

export default function MyDay() {
  const { user } = useAuth();
  const tz = user?.timezone ?? 'UTC';
  const qc = useQueryClient();
  const toast = useToast();
  const { celebrate } = useCelebrate();
  const answers = usePlannerAnswers();
  const day = useQuery({ queryKey: ['day'], queryFn: async () => (await api.get<DayView>('/day')).data, refetchInterval: 60_000 });
  const [plan, setPlan] = useState<Planner | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState<DayBlock | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 60_000); return () => clearInterval(t); }, []);

  if (day.isLoading) return <Loading label="Opening your day…" />;
  if (day.error) return <ErrorBox message={apiError(day.error).message} />;
  const d = day.data!;
  const today = DateTime.now().setZone(tz);
  const defaultWindow = () => {
    const from = DateTime.now().setZone(tz);
    const sleep = answers.data?.answers?.sleepTime;
    let until = '22:00';
    if (sleep) {
      const [h, m] = sleep.split(':').map(Number);
      const mins = h * 60 + m - 30;
      until = mins > from.hour * 60 + from.minute ? `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}` : '23:59';
    }
    const rounded = from.plus({ minutes: (5 - (from.minute % 5)) % 5 });
    const f = rounded.hour * 60 + rounded.minute >= 24 * 60 - 5 ? '23:00' : rounded.toFormat('HH:mm');
    return { from: f, until: until > f ? until : '23:59' };
  };
  const refresh = () => { for (const k of ['day', 'calendar', 'briefing', 'tasks', 'task', 'progress']) qc.invalidateQueries({ queryKey: [k] }); };

  /* ---------- planning ---------- */
  const startPlanning = (opts: { preselectAll?: boolean } = {}) => {
    const include: Record<string, boolean> = {};
    for (const t of d.openTasks) include[t.id] = opts.preselectAll || !t.scheduledToday;
    setPlan({ step: 'dump', text: '', include, drafts: [], top: null, energy: 'OK', window: defaultWindow(), preview: null });
    setError(null);
    window.scrollTo(0, 0);
  };
  const toQuestions = () => {
    if (!plan) return;
    const existing = d.openTasks.filter((t) => plan.include[t.id]).map((t) => {
      const prev = plan.drafts.find((x) => x.id === t.id);
      return prev ?? draftFromTask(t, today);
    });
    const typed = parseDump(plan.text);
    const kept = plan.drafts.filter((x) => !x.id && !typed.length);
    const drafts = [...existing, ...(typed.length ? typed : kept)];
    if (!drafts.length) { setError('Type at least one task, or tick one of your saved tasks.'); return; }
    setError(null);
    setPlan({ ...plan, drafts, text: typed.length ? '' : plan.text, step: 'questions' });
    window.scrollTo(0, 0);
  };
  const updateDraft = (key: string, patch: Partial<DraftTask>) => setPlan((p) => p && { ...p, drafts: p.drafts.map((x) => (x.key === key ? { ...x, ...patch } : x)) });
  const removeDraft = (key: string) => setPlan((p) => p && { ...p, drafts: p.drafts.filter((x) => x.key !== key), top: p.top === key ? null : p.top, include: { ...p.include, [key]: false } });

  const buildPreview = async (energy: Energy, freeWindow: Planner['window'] = null) => {
    setBusy('preview');
    setError(null);
    try {
      const r = await api.post<SchedulePreview>('/schedules/preview', { horizon: 'DAY', energy, ...(freeWindow ? { window: freeWindow } : {}) });
      setPlan((p) => ({ ...(p ?? { text: '', include: {}, drafts: [], top: null }), energy, window: freeWindow, step: 'preview', preview: r.data }));
      window.scrollTo(0, 0);
    } catch (e) {
      setError(apiError(e).message);
    } finally {
      setBusy(null);
    }
  };
  const saveAnswersAndPreview = async () => {
    if (!plan) return;
    setBusy('preview');
    setError(null);
    try {
      const tasks = plan.drafts.map((x) => {
        const isTop = plan.top === x.key;
        return {
          ...(x.id ? { id: x.id } : {}),
          title: x.title.trim() || 'Untitled task',
          minutes: Math.max(5, Math.round(x.minutes)),
          priority: isTop ? 'URGENT' : x.priority,
          due: isTop && x.due === 'NONE' ? 'TODAY' : x.due,
          startAfter: x.startAfter || null,
        };
      });
      const saved = await api.post<{ tasks: { id: string }[] }>('/day/tasks', { tasks });
      // New tasks now have ids: re-answering edits them instead of duplicating.
      setPlan((p) => p && { ...p, drafts: p.drafts.map((x, i) => ({ ...x, id: saved.data.tasks[i]?.id ?? x.id })) });
      refresh();
    } catch (e) {
      setError(apiError(e).message);
      setBusy(null);
      return;
    }
    await buildPreview(plan.energy, plan.window);
  };

  /* ---------- tracking ---------- */
  const track = async (b: DayBlock, action: 'done' | 'partial' | 'skip' | 'finish' | 'undo', minutes?: number) => {
    setBusy(b.id);
    try {
      const before = d.stats;
      const r = await api.post<{ loggedMinutes: number; taskDone: boolean }>(`/day/blocks/${b.id}`, { action, minutes });
      if (r.data.taskDone) celebrate({ title: b.title });
      else if (action === 'done' || action === 'partial') {
        const done = before.doneMinutes + r.data.loggedMinutes;
        if (before.doneMinutes === 0) toast.show(pick(FIRST), 'success');
        else if (before.plannedMinutes && done / before.plannedMinutes >= 0.5 && before.doneMinutes / before.plannedMinutes < 0.5) toast.show(pick(HALF), 'success');
        else toast.show(`Logged ${fmtMinutes(r.data.loggedMinutes)} on “${b.title}”.`, 'success');
      } else if (action === 'skip') toast.show('Skipped. The work stays on your list for the next plan.', 'info');
      refresh();
    } catch (e) {
      toast.show(apiError(e).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const carryOver = async () => {
    setBusy('carry');
    try {
      const r = await api.post<{ blocks: number; tasks: { taskId: string }[] }>('/day/carry-over');
      await qc.invalidateQueries({ queryKey: ['day'] });
      toast.show(`${r.data.tasks.length} unfinished task${r.data.tasks.length === 1 ? ' is' : 's are'} back on your list.`, 'success');
      const fresh = await qc.fetchQuery({ queryKey: ['day'], queryFn: async () => (await api.get<DayView>('/day')).data });
      const include: Record<string, boolean> = {};
      for (const t of fresh.openTasks) include[t.id] = !t.scheduledToday;
      setPlan({ step: 'dump', text: '', include, drafts: [], top: null, energy: 'OK', window: defaultWindow(), preview: null });
    } catch (e) {
      toast.show(apiError(e).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  /* ---------- planner screens ---------- */
  if (plan) {
    const stepNo = { dump: 1, questions: 2, one: 3, energy: 4, preview: 5 }[plan.step];
    return (
      <div className="mx-auto max-w-3xl space-y-5">
        <div className="flex gap-1.5" aria-label={`Step ${stepNo} of 5`}>{[1, 2, 3, 4, 5].map((n) => <span key={n} className={clsx('h-1.5 flex-1 rounded-full', n <= stepNo ? 'bg-accent' : 'bg-border')} />)}</div>
        {error && <ErrorBox message={error} />}

        {plan.step === 'dump' && (
          <>
            <Tempo mood="🧠">Let’s plan today. <b>Dump everything on your mind</b>, one task per line. Add a time if you know it (<i>“DBMS revision 2h”</i>, <i>“call bank at 4pm”</i>). Not sure how long? Leave it, I’ll guess and you can fix it next.</Tempo>
            <Card>
              <Textarea aria-label="Your tasks" rows={7} value={plan.text} onChange={(e) => setPlan({ ...plan, text: e.target.value })}
                placeholder={'finish OS assignment\nleetcode 1h\npay electricity bill\nreply to project mail\ngym at 6pm\nprepare DBMS exam 3h urgent'} />
              {d.openTasks.length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-sm font-medium">Already on your list. Include in today’s plan?</p>
                  <ul className="space-y-1">
                    {d.openTasks.map((t) => (
                      <li key={t.id}>
                        <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-2">
                          <input type="checkbox" checked={!!plan.include[t.id]} onChange={(e) => setPlan({ ...plan, include: { ...plan.include, [t.id]: e.target.checked } })} />
                          <span className="flex-1">{t.title}</span>
                          {t.carried && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-xs text-warn">carried over</span>}
                          {t.scheduledToday && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">already planned</span>}
                          <span className="text-xs text-muted">{fmtMinutes(t.remainingMinutes)} left</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setPlan(null)}>Cancel</Button>
              <Button onClick={toQuestions}>Next →</Button>
            </div>
          </>
        )}

        {plan.step === 'questions' && (
          <>
            <Tempo mood="❓">Got <b>{plan.drafts.length} task{plan.drafts.length === 1 ? '' : 's'}</b>. A few quick questions about each one so I put them in the right place. My guesses are filled in. Change anything that’s wrong.</Tempo>
            {plan.drafts.map((x) => (
              <Card key={x.key}>
                <div className="mb-3 flex items-center gap-2">
                  <Input aria-label="Task" value={x.title} onChange={(e) => updateDraft(x.key, { title: e.target.value })} className="font-medium" />
                  {x.carried && <span className="shrink-0 rounded-full bg-warn-soft px-2 py-0.5 text-xs text-warn">carried over</span>}
                  <Button variant="ghost" size="sm" aria-label={`Remove ${x.title}`} onClick={() => removeDraft(x.key)}>✕</Button>
                </div>
                <div className="grid gap-3 text-sm sm:grid-cols-[130px_1fr] sm:items-center">
                  <span className="font-medium text-muted">How important?</span>
                  <div className="flex flex-wrap gap-1.5">{PRIORITIES.map((p) => <Chip key={p.v} on={x.priority === p.v} onClick={() => updateDraft(x.key, { priority: p.v })}>{p.label}</Chip>)}</div>
                  <span className="font-medium text-muted">How long?{x.guessed && <span className="block text-xs font-normal">(my guess)</span>}</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {LENGTHS.map((m) => <Chip key={m} on={x.minutes === m} onClick={() => updateDraft(x.key, { minutes: m, guessed: false })}>{fmtMinutes(m)}</Chip>)}
                    <span className="flex items-center gap-1"><span className="w-20"><Input type="number" min={5} max={6000} step={5} aria-label="Minutes" value={x.minutes} onChange={(e) => updateDraft(x.key, { minutes: Number(e.target.value) || 5, guessed: false })} className="py-1" /></span>
                    <span className="text-xs text-muted">min</span></span>
                  </div>
                  <span className="font-medium text-muted">When is it due?</span>
                  <div className="flex flex-wrap gap-1.5">{DUES.map((o) => <Chip key={o.v} on={x.due === o.v} onClick={() => updateDraft(x.key, { due: o.v })}>{o.label}</Chip>)}</div>
                  <span className="font-medium text-muted">Not before</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-36"><Input type="time" aria-label="Not before" value={x.startAfter ?? ''} onChange={(e) => updateDraft(x.key, { startAfter: e.target.value || null })} className="py-1" /></span>
                    <span className="text-xs text-muted">optional, e.g. gym at 6 PM</span>
                  </div>
                </div>
              </Card>
            ))}
            <AddMore onAdd={(t) => setPlan({ ...plan, drafts: [...plan.drafts, t] })} />
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setPlan({ ...plan, step: 'dump' })}>← Back</Button>
              <Button disabled={!plan.drafts.length} onClick={() => { setPlan({ ...plan, step: 'one' }); window.scrollTo(0, 0); }}>Next →</Button>
            </div>
          </>
        )}

        {plan.step === 'one' && (
          <>
            <Tempo mood="⭐">If you get only <b>ONE</b> thing done today, which one should it be? I’ll put it first, in your best slot.</Tempo>
            <Card>
              <ul className="space-y-1">
                {plan.drafts.map((x) => (
                  <li key={x.key}>
                    <label className={clsx('flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm', plan.top === x.key ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-surface-2')}>
                      <input type="radio" name="top" checked={plan.top === x.key} onChange={() => setPlan({ ...plan, top: x.key })} />
                      <span className="flex-1 font-medium">{x.title}</span>
                      <span className="text-xs text-muted">{fmtMinutes(x.minutes)}</span>
                    </label>
                  </li>
                ))}
                <li>
                  <label className={clsx('flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm', plan.top === null ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-surface-2')}>
                    <input type="radio" name="top" checked={plan.top === null} onChange={() => setPlan({ ...plan, top: null })} />
                    <span className="text-muted">Not sure. You decide.</span>
                  </label>
                </li>
              </ul>
            </Card>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setPlan({ ...plan, step: 'questions' })}>← Back</Button>
              <Button onClick={() => setPlan({ ...plan, step: 'energy' })}>Next →</Button>
            </div>
          </>
        )}

        {plan.step === 'energy' && (
          <>
            <Tempo mood="🔋">Last two questions: <b>when are you free today</b>, and how is your energy? I keep sessions short on tired days.</Tempo>
            <Card>
              <p className="mb-2 text-sm font-medium">I can work on tasks today</p>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Chip on={!!plan.window} onClick={() => setPlan({ ...plan, window: plan.window ?? defaultWindow() })}>🕐 From… until…</Chip>
                <Chip on={!plan.window} onClick={() => setPlan({ ...plan, window: null })}>💼 Only in my usual working hours</Chip>
              </div>
              {plan.window && (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                  from <span className="w-36"><Input type="time" aria-label="Free from" value={plan.window.from} onChange={(e) => setPlan({ ...plan, window: { ...plan.window!, from: e.target.value || plan.window!.from } })} /></span>
                  until <span className="w-36"><Input type="time" aria-label="Free until" value={plan.window.until} onChange={(e) => setPlan({ ...plan, window: { ...plan.window!, until: e.target.value || plan.window!.until } })} /></span>
                  <span className="text-xs text-muted">Classes, work shifts and meals on your calendar are still kept free.</span>
                </div>
              )}
            </Card>
            <div className="flex flex-col gap-3 sm:flex-row">
              {ENERGY.map((e) => (
                <button key={e.v} type="button" aria-pressed={plan.energy === e.v} onClick={() => setPlan({ ...plan, energy: e.v })}
                  className={clsx('flex flex-1 flex-col items-start gap-1 rounded-xl border-2 p-4 text-left', plan.energy === e.v ? 'border-accent bg-accent-soft' : 'border-border bg-surface hover:border-accent/50')}>
                  <span className="text-3xl" aria-hidden>{e.emoji}</span><span className="font-semibold">{e.title}</span><span className="text-xs text-muted">{e.blurb}</span>
                </button>
              ))}
            </div>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setPlan({ ...plan, step: 'one' })}>← Back</Button>
              <Button loading={busy === 'preview'} onClick={saveAnswersAndPreview}>✨ Build my day</Button>
            </div>
          </>
        )}

        {plan.step === 'preview' && plan.preview && (
          <>
            <Tempo mood="🎉">Here’s the plan for the rest of today. Untick anything you don’t want, then save. {plan.preview.unscheduledTasks.length > 0 && <>Tasks that don’t fit stay on your list, and I’ll offer them again tomorrow.</>}</Tempo>
            {plan.preview.proposedBlocks.length === 0 && plan.preview.ok && (
              <Card className="border-warn/40 bg-warn-soft/50">
                <p className="text-sm">There’s no free time left in your working hours today. Your tasks are saved and will come back tomorrow. Want more room? <Link className="text-accent" to="/app/settings">Change your working hours</Link>.</p>
              </Card>
            )}
            <Card>
              <SchedulePreviewView preview={plan.preview}
                onDone={() => { setPlan(null); refresh(); celebrate({ emoji: '🗓️', line: 'Your day is planned. You’ve got this!' }); }}
                onRegenerate={() => buildPreview(plan.energy, plan.window)} />
            </Card>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setPlan({ ...plan, step: plan.drafts.length ? 'energy' : 'dump' })}>← Back</Button>
              <Button variant="ghost" onClick={() => setPlan(null)}>Close</Button>
            </div>
          </>
        )}
      </div>
    );
  }

  /* ---------- today view ---------- */
  const now = Date.now();
  const pct = d.stats.plannedMinutes ? Math.round((d.stats.doneMinutes / d.stats.plannedMinutes) * 100) : 0;
  const pending = d.blocks.filter((b) => b.status === 'CONFIRMED');
  const late = pending.filter((b) => Date.parse(b.endAt) <= now);
  const current = pending.find((b) => Date.parse(b.startAt) <= now && Date.parse(b.endAt) > now) ?? pending.find((b) => Date.parse(b.startAt) > now);
  const notPlanned = d.openTasks.filter((t) => !t.scheduledToday);
  const agenda = [
    ...d.blocks.map((b) => ({ kind: 'block' as const, b, start: Date.parse(b.startAt) })),
    ...d.events.map((e) => ({ kind: 'event' as const, e, start: Date.parse(e.startAt) })),
  ].sort((a, b) => a.start - b.start);
  const message = pct >= 100 ? 'Everything you planned is done. Rest well, you earned it! 🎉'
    : late.length ? `${late.length} session${late.length === 1 ? '' : 's'} passed without a check-in. Done? Tick it. Missed? Re-plan the rest of today.`
    : pct >= 50 ? 'More than halfway. Keep going! 💪'
    : d.stats.doneMinutes > 0 ? 'Good start. One session at a time.'
    : 'Start with the first session. Just begin, 5 minutes counts.';

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{today.hour < 12 ? 'Good morning' : today.hour < 18 ? 'Good afternoon' : 'Good evening'}, {user?.name.split(' ')[0]} {today.hour < 12 ? '☀️' : today.hour < 18 ? '🌤️' : '🌙'}</h1>
          <p className="text-sm text-muted">{today.toFormat('cccc d LLLL')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => startPlanning()}>➕ Add tasks & plan</Button>
          {d.blocks.length > 0 && <Button variant="secondary" loading={busy === 'preview'} onClick={() => buildPreview('OK', defaultWindow())}>↻ Re-plan rest of today</Button>}
        </div>
      </div>

      {d.missed.blocks > 0 && (
        <Card className="border-warn/40 bg-warn-soft/60">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-2xl" aria-hidden>↪️</span>
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-semibold">{d.missed.tasks.length} unfinished task{d.missed.tasks.length === 1 ? '' : 's'} from earlier days</p>
              <p className="text-muted">{d.missed.tasks.slice(0, 4).map((t) => t.title).join(', ')}{d.missed.tasks.length > 4 ? '…' : ''} · {fmtMinutes(d.missed.minutes)} not done yet</p>
            </div>
            <Button loading={busy === 'carry'} onClick={carryOver}>Move to today</Button>
          </div>
        </Card>
      )}

      {d.blocks.length === 0 ? (
        <Card className="py-6 text-center">
          <div className="text-4xl" aria-hidden>🗓️</div>
          <h2 className="mt-2 text-lg font-semibold">No plan for today yet</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">Tell me what you need to do, with or without times. I ask a few quick questions, then build your day around your fixed commitments.</p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button onClick={() => startPlanning()}>📝 Plan my day</Button>
            {d.openTasks.length > 0 && <Button variant="secondary" loading={busy === 'preview'} onClick={() => buildPreview('OK', defaultWindow())}>⚡ Quick plan ({d.openTasks.length} saved task{d.openTasks.length === 1 ? '' : 's'})</Button>}
          </div>
        </Card>
      ) : (
        <>
          <Card>
            <div className="flex flex-wrap items-center gap-5">
              <Ring pct={pct} />
              <div className="min-w-0 flex-1">
                <p className="text-lg font-semibold">{fmtMinutes(d.stats.doneMinutes)} of {fmtMinutes(d.stats.plannedMinutes)} done</p>
                <p className="text-sm text-muted">{d.stats.sessionsDone} of {d.stats.sessions} sessions</p>
                <p className="mt-1.5 text-sm">{message}</p>
              </div>
            </div>
          </Card>

          {current && (
            <Card className="border-2 border-accent">
              <p className="text-xs font-semibold uppercase tracking-wide text-accent">{Date.parse(current.startAt) <= now ? 'Right now' : `Up next at ${fmtTime(current.startAt, tz)}`}</p>
              <p className="mt-1 text-xl font-semibold">{current.title}</p>
              <p className="text-sm text-muted">{fmtTime(current.startAt, tz)}–{fmtTime(current.endAt, tz)} · {fmtMinutes(current.minutes)}{Date.parse(current.startAt) <= now && ` · ${fmtMinutes((Date.parse(current.endAt) - now) / 60_000)} left`}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button loading={busy === current.id} onClick={() => track(current, 'done')}>✓ Done</Button>
                <Button variant="secondary" onClick={() => setPartial(current)}>Partly done</Button>
                <Button variant="secondary" onClick={() => track(current, 'skip')}>Skip</Button>
                <Button variant="ghost" onClick={() => track(current, 'finish')}>🏁 Whole task finished</Button>
              </div>
            </Card>
          )}

          <Card title="Today" action={<Link to="/app/calendar" className="text-xs text-accent">Open calendar</Link>}>
            <ul className="space-y-1.5">
              {agenda.map((a, i) => {
                const showNow = a.start > now && (i === 0 || agenda[i - 1].start <= now);
                return (
                  <li key={a.kind === 'block' ? a.b.id : a.e.id}>
                    {showNow && <div className="my-1 flex items-center gap-2 text-xs font-semibold text-danger">NOW {fmtTime(new Date(now).toISOString(), tz)}<span className="h-px flex-1 bg-danger" /></div>}
                    {a.kind === 'event' ? (
                      <div className="flex items-center gap-3 rounded-lg bg-surface-2/60 px-3 py-2 text-sm">
                        <span className="w-40 shrink-0 whitespace-nowrap tabular-nums text-muted">{fmtTime(a.e.startAt, tz)}–{fmtTime(a.e.endAt, tz)}</span>
                        <span className="flex-1">{a.e.title}</span>
                        <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-muted">fixed</span>
                      </div>
                    ) : (
                      <BlockRow b={a.b} tz={tz} now={now} busy={busy === a.b.id} onAction={(act) => (act === 'partial' ? setPartial(a.b) : track(a.b, act))} />
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        </>
      )}

      {notPlanned.length > 0 && (
        <Card title="Not planned for today" action={<Button size="sm" variant="secondary" onClick={() => startPlanning()}>Fit them in</Button>}>
          <p className="mb-2 text-sm text-muted">These stay on your list. Anything you don’t finish today comes back tomorrow automatically.</p>
          <ul className="divide-y divide-border text-sm">
            {notPlanned.slice(0, 12).map((t) => (
              <li key={t.id} className="flex items-center gap-2 py-2">
                <span className="flex-1">{t.title}</span>
                {t.carried && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-xs text-warn">carried over</span>}
                {t.priority === 'URGENT' && <span className="rounded-full bg-danger-soft px-2 py-0.5 text-xs text-danger">must do</span>}
                <span className="text-xs text-muted">{fmtMinutes(t.remainingMinutes)} left</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <PartialModal block={partial} onClose={() => setPartial(null)} onSave={(m) => { const b = partial!; setPartial(null); track(b, 'partial', m); }} />
    </div>
  );
}

function BlockRow({ b, tz, now, busy, onAction }: { b: DayBlock; tz: string; now: number; busy: boolean; onAction: (a: 'done' | 'partial' | 'skip' | 'finish' | 'undo') => void }) {
  const done = b.status === 'COMPLETED';
  const isNow = !done && Date.parse(b.startAt) <= now && Date.parse(b.endAt) > now;
  const isLate = !done && Date.parse(b.endAt) <= now;
  return (
    <div className={clsx('flex flex-wrap items-center gap-3 rounded-lg border-l-4 px-3 py-2 text-sm', done ? 'border-ok bg-ok-soft/60' : 'bg-accent-soft/40', isNow && 'ring-2 ring-accent', isLate && 'ring-2 ring-warn/50')}
      style={done ? undefined : { borderLeftColor: b.color }}>
      <span className="w-40 shrink-0 whitespace-nowrap tabular-nums text-muted">{fmtTime(b.startAt, tz)}–{fmtTime(b.endAt, tz)}</span>
      <span className={clsx('min-w-0 flex-1 font-medium', done && 'text-muted line-through')}>{b.title}</span>
      {b.priority === 'URGENT' && !done && <span className="rounded-full bg-danger-soft px-2 py-0.5 text-xs text-danger">must do</span>}
      {isLate && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-xs text-warn">did you do this?</span>}
      <span className="text-xs text-muted">{fmtMinutes(b.minutes)}</span>
      {done ? (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction('undo')}>Undo</Button>
      ) : (
        <span className="flex gap-1">
          <Button size="sm" variant="secondary" disabled={busy} title="Done" aria-label={`Done: ${b.title}`} onClick={() => onAction('done')}>✓</Button>
          <Button size="sm" variant="secondary" disabled={busy} title="Partly done" aria-label={`Partly done: ${b.title}`} onClick={() => onAction('partial')}>½</Button>
          <Button size="sm" variant="secondary" disabled={busy} title="Skip" aria-label={`Skip: ${b.title}`} onClick={() => onAction('skip')}>Skip</Button>
        </span>
      )}
    </div>
  );
}

function Ring({ pct }: { pct: number }) {
  const r = 40, c = 2 * Math.PI * r;
  return (
    <svg width="96" height="96" viewBox="0 0 96 96" role="img" aria-label={`${pct}% done`}>
      <circle cx="48" cy="48" r={r} fill="none" stroke="var(--c-surface-2)" strokeWidth="10" />
      <circle cx="48" cy="48" r={r} fill="none" stroke={pct >= 100 ? 'var(--c-ok)' : 'var(--c-accent)'} strokeWidth="10" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(1, pct / 100))} transform="rotate(-90 48 48)" />
      <text x="48" y="54" textAnchor="middle" fontSize="20" fontWeight="700" fill="var(--c-fg)">{pct}%</text>
    </svg>
  );
}

function AddMore({ onAdd }: { onAdd: (t: DraftTask) => void }) {
  const [v, setV] = useState('');
  const add = () => { const t = parseLine(v); if (t) onAdd({ ...t, key: newKey() }); setV(''); };
  return (
    <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
      <Input value={v} onChange={(e) => setV(e.target.value)} placeholder="Forgot something? Type it here" aria-label="Add another task" />
      <Button type="submit" variant="secondary" disabled={!v.trim()}>Add</Button>
    </form>
  );
}

function PartialModal({ block, onClose, onSave }: { block: DayBlock | null; onClose: () => void; onSave: (minutes: number) => void }) {
  const [m, setM] = useState(0);
  const options = useMemo(() => (block ? [0.25, 0.5, 0.75].map((f) => Math.max(5, Math.round((block.minutes * f) / 5) * 5)).filter((x, i, a) => x < block.minutes && a.indexOf(x) === i) : []), [block]);
  useEffect(() => { if (block) setM(Math.max(5, Math.round(block.minutes / 2 / 5) * 5)); }, [block]);
  return (
    <Modal open={!!block} onClose={onClose} title="How much did you get done?"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => onSave(m)} disabled={!m}>Save</Button></>}>
      {block && (
        <div className="space-y-3 text-sm">
          <p className="text-muted">“{block.title}” was planned for {fmtMinutes(block.minutes)}. The rest stays on your list and gets planned again.</p>
          <div className="flex flex-wrap gap-1.5">{options.map((o) => <Chip key={o} on={m === o} onClick={() => setM(o)}>{fmtMinutes(o)}</Chip>)}</div>
          <label className="flex items-center gap-2">
            <span className="w-24"><Input type="number" min={1} max={block.minutes} value={m} onChange={(e) => setM(Math.min(block.minutes, Math.max(0, Number(e.target.value) || 0)))} aria-label="Minutes worked" /></span>
            minutes
          </label>
        </div>
      )}
    </Modal>
  );
}
