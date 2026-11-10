import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { api, apiError } from '../services/api';
import { useAuth } from '../services/auth';
import { Badge, Button, Card, Empty, ErrorBox, Loading, PageHeader, RiskBadge, Stat } from '../components/ui';
import { fmtDateTime, fmtMinutes, fmtTime, relativeDays } from '../lib/format';
import type { Briefing, CalendarData } from '../types';
import { useTaskPanel } from '../features/tasks/TaskPanel';
import { PersonaWidgets } from '../features/planner/PersonaWidgets';
import { PERSONAS } from '../features/planner/templates';
import { GettingStarted } from '../features/progress/progress';

const GREETING_LINES = [
  'Small steps every day add up 🌱',
  'You’ve got this 💪',
  'One task at a time ✨',
  'Progress, not perfection 🌈',
  'Let’s make today count 🚀',
  'Breaks are part of the plan ☕',
];

export default function Dashboard() {
  const { user } = useAuth();
  const tz = user?.timezone ?? 'UTC';
  const { openTask } = useTaskPanel();
  const [polish, setPolish] = useState(false);
  const briefing = useQuery({
    queryKey: ['briefing', polish],
    queryFn: async () => (await api.get<{ briefing: Briefing; narrative: string; narrativeSource: string; aiError?: string }>(`/briefings/daily${polish ? '?ai=true' : ''}`)).data,
  });
  const today = DateTime.now().setZone(tz);
  const calendar = useQuery({
    queryKey: ['calendar', 'today'],
    queryFn: async () => (await api.get<CalendarData>('/calendar', { params: { from: today.startOf('day').toISO(), to: today.endOf('day').toISO() } })).data,
  });

  if (briefing.isLoading) return <Loading label="Building today's plan…" />;
  if (briefing.error) return <ErrorBox message={apiError(briefing.error).message} />;
  const b = briefing.data!.briefing;
  const agenda = [
    ...(calendar.data?.blocks ?? []).map((x) => ({ kind: 'block' as const, id: x.id, taskId: x.taskId, title: x.title, startAt: x.startAt, endAt: x.endAt, color: x.color, done: x.status === 'COMPLETED' })),
    ...(calendar.data?.events ?? []).map((x) => ({ kind: 'event' as const, id: x.id, taskId: null, title: x.title, startAt: x.startAt, endAt: x.endAt, color: null, done: false })),
  ].sort((a, c) => Date.parse(a.startAt) - Date.parse(c.startAt));
  const nothing = !b.topTasks.length && !b.blockedTasks.length && !agenda.length;

  return (
    <>
      <PageHeader title={`${today.hour < 12 ? 'Good morning' : today.hour < 18 ? 'Good afternoon' : 'Good evening'}, ${user?.name.split(' ')[0]} ${today.hour < 12 ? '☀️' : today.hour < 18 ? '🌤️' : '🌙'}`}
        subtitle={<>{today.toFormat('cccc d LLLL')} · {GREETING_LINES[today.ordinal % GREETING_LINES.length]}</>}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link to="/app"><Button>📅 Plan my day</Button></Link>
            <Link to="/app/plan?horizon=WEEK"><Button variant="secondary">🗓️ Week</Button></Link>
            <Link to="/app/plan?horizon=MONTH"><Button variant="secondary">🌙 Month</Button></Link>
          </div>
        } />

      {!user?.persona && (
        <Card className="mb-5 border-accent/30 bg-accent-soft/40">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-3xl" aria-hidden>🦉</span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold">Let Tempo plan your time</p>
              <p className="text-sm text-muted">Tell me if you're a {PERSONAS.map((p) => `${p.emoji} ${p.title.toLowerCase()}`).join(', ')} person and I'll build your days around classes, work and life.</p>
            </div>
            <Link to="/app/plan"><Button>Start →</Button></Link>
          </div>
        </Card>
      )}

      <Card className="mb-5 border-accent/30 bg-accent-soft/40">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-3xl">
            <div className="mb-1 flex items-center gap-2 text-xs font-medium text-accent">Daily briefing {briefing.data!.narrativeSource !== 'engine' && <Badge tone="accent">{briefing.data!.narrativeSource === 'anthropic' ? 'AI-written' : 'rephrased'}</Badge>}</div>
            <p className="text-[15px] leading-relaxed">{briefing.data!.narrative}</p>
            {briefing.data!.aiError && <p className="mt-1 text-xs text-muted">AI service unavailable — showing the built-in summary.</p>}
          </div>
          <Button variant="ghost" size="sm" onClick={() => setPolish((p) => !p)}>{polish ? 'Plain summary' : 'Friendlier wording'}</Button>
        </div>
        {b.suggestedFirstTask && (
          <button onClick={() => openTask(b.suggestedFirstTask!.taskId)} className="mt-3 flex w-full items-center gap-3 rounded-lg border border-border bg-surface p-3 text-left hover:border-accent">
            <span className="rounded-md bg-accent px-2 py-1 text-xs font-semibold text-accent-fg">Start here</span>
            <span className="font-medium">{b.suggestedFirstTask.title}</span>
            <span className="hidden truncate text-sm text-muted sm:inline">{b.suggestedFirstTask.why}</span>
          </button>
        )}
      </Card>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Free focus time left today" value={fmtMinutes(b.capacity.availableMinutesToday)} sub={`${fmtMinutes(b.capacity.scheduledMinutesToday)} planned`} />
        <Stat label="Unplanned capacity" value={fmtMinutes(b.capacity.remainingMinutesToday)} sub="today" />
        <Stat label="Blocked tasks" value={b.blockedTasks.length} tone={b.blockedTasks.length ? 'warn' : undefined} />
        <Stat label="Deadlines at risk" value={b.atRisk.length} tone={b.atRisk.length ? 'danger' : 'ok'} sub={`${b.unscheduledWork.length} unscheduled task(s)`} />
      </div>

      <GettingStarted hasPlan={!!user?.persona} hasSchedule={(calendar.data?.blocks.length ?? 0) > 0} />
      <PersonaWidgets calendar={calendar.data} focusLeft={b.capacity.availableMinutesToday} />

      {nothing ? (
        <Empty title="Your plan is empty 🌱">Answer a few questions and Tempo will fill it with a smart schedule. <Link className="text-accent" to="/app/plan">Plan my time →</Link></Empty>
      ) : (
        <div className="grid gap-5 lg:grid-cols-3">
          <div className="space-y-5 lg:col-span-2">
            <Card title="Top priorities">
              {!b.topTasks.length ? <p className="text-sm text-muted">Nothing ready to start.</p> : (
                <ol className="space-y-2">
                  {b.topTasks.map((t, i) => (
                    <li key={t.taskId}>
                      <button onClick={() => openTask(t.taskId)} className="flex w-full items-start gap-3 rounded-lg border border-border p-3 text-left hover:bg-surface-2">
                        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold">{i + 1}</span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2"><span className="font-medium">{t.title}</span>{t.onCriticalPath && <Badge tone="danger">critical path</Badge>}{t.dueAt && <Badge>due {relativeDays(t.dueAt)}</Badge>}</span>
                          <span className="mt-0.5 block text-xs text-muted">{t.reasons.join(' · ')}</span>
                        </span>
                        <span className="shrink-0 text-right text-xs text-muted">
                          <span className="block font-medium text-fg">{fmtMinutes(t.remainingMinutes)}</span>
                          {t.suggestedBlock ? `${fmtTime(t.suggestedBlock.startAt, tz)}–${fmtTime(t.suggestedBlock.endAt, tz)}` : 'not today'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
            <Card title="Today's schedule" action={<Link to="/app/calendar" className="text-xs text-accent">Open calendar</Link>}>
              {calendar.isLoading ? <Loading /> : !agenda.length ? <p className="text-sm text-muted">Nothing on your calendar today. Tap “Plan my day” and I'll fill it in ✨</p> : (
                <ul className="space-y-1.5">
                  {agenda.map((a) => (
                    <li key={a.id} onClick={() => a.taskId && openTask(a.taskId)} className={`flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm ${a.taskId ? 'cursor-pointer hover:bg-surface-2' : ''} ${a.done ? 'opacity-50 line-through' : ''}`}>
                      <span className="w-36 shrink-0 whitespace-nowrap tabular-nums text-muted">{fmtTime(a.startAt, tz)}–{fmtTime(a.endAt, tz)}</span>
                      <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: a.color ?? 'var(--c-border)' }} />
                      <span>{a.title}</span>
                      {a.kind === 'event' && <Badge>fixed</Badge>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
          <div className="space-y-5">
            <Card title="Upcoming deadlines">
              {!b.upcomingDeadlines.length ? <p className="text-sm text-muted">Nothing due in the next 3 days.</p> : (
                <ul className="space-y-2">{b.upcomingDeadlines.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 text-sm"><span className="truncate">{d.title}{d.kind === 'project' && <span className="text-xs text-muted"> (project)</span>}</span><span className="flex shrink-0 items-center gap-1.5"><span className="text-xs text-muted" title={fmtDateTime(d.dueAt, tz)}>{relativeDays(d.dueAt)}</span><RiskBadge s={d.status} /></span></li>
                ))}</ul>
              )}
            </Card>
            <Card title="Blocked">
              {!b.blockedTasks.length ? <p className="text-sm text-muted">Nothing is blocked.</p> : (
                <ul className="space-y-2">{b.blockedTasks.slice(0, 6).map((t) => (
                  <li key={t.taskId} className="text-sm"><button className="font-medium hover:text-accent" onClick={() => openTask(t.taskId)}>{t.title}</button><div className="text-xs text-muted">waiting on {t.blockedBy.map((x) => x.title).join(', ')}</div></li>
                ))}</ul>
              )}
            </Card>
            {b.atRisk.length > 0 && (
              <Card title="Needs attention" action={<Link to="/app/analytics" className="text-xs text-accent">Details</Link>}>
                <ul className="space-y-2">{b.atRisk.map((r) => <li key={r.id} className="text-sm"><RiskBadge s={r.status} /> <span className="font-medium">{r.title}</span><p className="mt-0.5 text-xs text-muted">{r.explanation}</p></li>)}</ul>
              </Card>
            )}
          </div>
        </div>
      )}
    </>
  );
}
