import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { api } from '../../services/api';
import { useAuth } from '../../services/auth';
import { Button, Card } from '../../components/ui';
import { useCelebrate } from '../../components/Celebrate';
import { fmtMinutes } from '../../lib/format';
import type { CalendarData, LifeAnswers, Persona, Project, Task } from '../../types';
import { TIPS, studies } from './templates';
import { useProgress } from '../progress/progress';

/** Pomodoro-style focus timer; the length follows the user's focus preference. */
export function FocusTimer() {
  const { user } = useAuth();
  const { celebrate } = useCelebrate();
  const focusMin = Math.min(90, Math.max(25, user?.focusBlockMinutes ?? 25));
  const breakMin = focusMin >= 90 ? 15 : focusMin >= 50 ? 10 : 5;
  const [mode, setMode] = useState<'focus' | 'break'>('focus');
  const [left, setLeft] = useState(focusMin * 60);
  const [endAt, setEndAt] = useState<number | null>(null);
  const [rounds, setRounds] = useState(0);
  const baseTitle = useRef(document.title);

  useEffect(() => { if (!endAt) setLeft((mode === 'focus' ? focusMin : breakMin) * 60); }, [focusMin, breakMin, mode, endAt]);
  useEffect(() => {
    if (!endAt) { document.title = baseTitle.current; return; }
    const tick = () => {
      const s = Math.max(0, Math.round((endAt - Date.now()) / 1000));
      setLeft(s);
      document.title = `${mode === 'focus' ? '🎯' : '☕'} ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · ${baseTitle.current}`;
      if (s === 0) {
        setEndAt(null);
        if (mode === 'focus') {
          setRounds((r) => r + 1);
          celebrate({ emoji: '🍅', line: `Focus session done! Take a ${breakMin}-minute break ☕` });
          setMode('break');
        } else {
          celebrate({ emoji: '⚡', line: 'Break over. Ready for another round?' });
          setMode('focus');
        }
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [endAt, mode, breakMin, celebrate]);
  useEffect(() => () => { document.title = baseTitle.current; }, []);

  const total = (mode === 'focus' ? focusMin : breakMin) * 60;
  const pct = 1 - left / total;
  return (
    <Card title={mode === 'focus' ? '🎯 Focus timer' : '☕ Break time'} action={rounds > 0 ? <span className="text-xs text-muted">{'🍅'.repeat(Math.min(rounds, 8))}</span> : undefined}>
      <div className="flex items-center gap-4">
        <div className="relative h-20 w-20 shrink-0">
          <svg viewBox="0 0 36 36" className="h-20 w-20 -rotate-90" aria-hidden>
            <circle cx="18" cy="18" r="15.9" fill="none" stroke="var(--c-surface-2)" strokeWidth="3" />
            <circle cx="18" cy="18" r="15.9" fill="none" stroke={mode === 'focus' ? 'var(--c-accent)' : 'var(--c-ok)'} strokeWidth="3" strokeLinecap="round" strokeDasharray={`${pct * 100} 100`} pathLength={100} />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums" role="timer">{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span>
        </div>
        <div className="space-y-2 text-sm">
          <p className="text-muted">{mode === 'focus' ? (endAt ? 'Phone away, you got this 📵' : `${focusMin} minutes of pure focus.`) : 'Stretch, sip water, look out a window 🌿'}</p>
          <div className="flex gap-2">
            {endAt
              ? <Button size="sm" variant="secondary" onClick={() => { setLeft(Math.max(0, Math.round((endAt - Date.now()) / 1000))); setEndAt(null); }}>Pause</Button>
              : <Button size="sm" onClick={() => setEndAt(Date.now() + left * 1000)}>{left < total ? 'Resume' : 'Start'}</Button>}
            <Button size="sm" variant="ghost" onClick={() => { setEndAt(null); setMode('focus'); setLeft(focusMin * 60); }}>Reset</Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

function StreakCard() {
  const p = useProgress().data;
  const streak = p?.streak ?? 0;
  const msg = streak >= 7 ? 'Unstoppable! A whole week 🏆' : streak >= 3 ? 'You’re on a roll! Keep it going 🔥' : streak >= 1 ? 'Nice! Finish one task today to keep it alive ✨' : 'Finish a task today to start a streak 🌱';
  return (
    <Card title="🔥 Streak" action={p ? <Link to="/app/review" className="text-xs text-accent">Level {p.level}</Link> : undefined}>
      <div className="flex items-end gap-3">
        <span className="text-4xl font-bold text-accent">{streak}</span>
        <span className="pb-1 text-sm text-muted">day{streak === 1 ? '' : 's'} in a row · {p?.doneToday ?? 0} done today</span>
      </div>
      <p className="mt-2 text-sm">{msg}</p>
    </Card>
  );
}

function ExamCountdown({ answers, tz }: { answers: LifeAnswers | null; tz: string }) {
  const today = DateTime.now().setZone(tz).startOf('day');
  const exams = (answers?.exams ?? [])
    .map((e) => ({ ...e, days: Math.round(DateTime.fromISO(e.date, { zone: tz }).diff(today, 'days').days) }))
    .filter((e) => e.days >= 0)
    .sort((a, b) => a.days - b.days)
    .slice(0, 4);
  return (
    <Card title="📝 Exam countdown" action={<Link to="/app/plan" className="text-xs text-accent">Add exams</Link>}>
      {!exams.length ? <p className="text-sm text-muted">No exams coming up. Enjoy it! 🎉</p> : (
        <ul className="space-y-2">
          {exams.map((e) => (
            <li key={e.subject + e.date} className="flex items-center justify-between gap-2 text-sm">
              <span className="font-medium">{e.subject}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${e.days <= 3 ? 'bg-danger-soft text-danger' : e.days <= 7 ? 'bg-warn-soft text-warn' : 'bg-ok-soft text-ok'}`}>
                {e.days === 0 ? 'today! 🍀' : e.days === 1 ? 'tomorrow 😬' : `${e.days} days`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function WorkDay({ calendar, focusLeft }: { calendar?: CalendarData; focusLeft: number }) {
  const meetings = (calendar?.events ?? []).filter((e) => e.title.startsWith('👥'));
  const mins = meetings.reduce((s, m) => s + (Date.parse(m.endAt) - Date.parse(m.startAt)) / 60000, 0);
  return (
    <Card title="💼 Your work day">
      <div className="grid grid-cols-2 gap-3 text-center">
        <div className="rounded-lg bg-surface-2 p-2"><div className="text-xl font-semibold">{meetings.length}</div><div className="text-xs text-muted">meetings ({fmtMinutes(mins)})</div></div>
        <div className="rounded-lg bg-accent-soft p-2"><div className="text-xl font-semibold text-accent">{fmtMinutes(focusLeft)}</div><div className="text-xs text-muted">focus time left</div></div>
      </div>
      <p className="mt-3 text-sm text-muted">{mins > 180 ? 'Meeting-heavy day. Guard one deep-work block 🛡️' : 'Plenty of room for deep work today 🎧'}</p>
    </Card>
  );
}

function Balance({ done, projects }: { done: Task[]; projects: Project[] }) {
  const weekStart = DateTime.now().startOf('week');
  const name = new Map(projects.map((p) => [p.id, p.name.toLowerCase()]));
  let work = 0;
  let study = 0;
  for (const t of done) {
    if (!t.completedAt || DateTime.fromISO(t.completedAt) < weekStart) continue;
    const n = name.get(t.projectId) ?? '';
    if (n.includes('work')) work += t.estimatedMinutes; else if (n.includes('stud')) study += t.estimatedMinutes;
  }
  const totalMin = work + study;
  const studyPct = totalMin ? Math.round((study / totalMin) * 100) : 50;
  return (
    <Card title="⚖️ Work / study balance">
      <div className="flex h-3 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={`Study ${studyPct}%, work ${100 - studyPct}%`}>
        <div style={{ width: `${studyPct}%`, background: '#6366f1' }} />
        <div style={{ width: `${100 - studyPct}%`, background: '#0ea5e9' }} />
      </div>
      <div className="mt-2 flex justify-between text-xs text-muted"><span>📚 Study {fmtMinutes(study)}</span><span>💼 Work {fmtMinutes(work)}</span></div>
      <p className="mt-2 text-sm">{!totalMin ? 'Finish a few tasks this week to see your balance.' : studyPct < 30 ? 'Work is winning this week. Sneak in a study session? 📚' : studyPct > 70 ? 'Study mode! Don’t forget work tasks 💼' : 'Beautifully balanced ✨'}</p>
    </Card>
  );
}

function TipOfTheDay({ persona }: { persona: Persona }) {
  const tips = TIPS[persona];
  const tip = tips[DateTime.now().ordinal % tips.length];
  return (
    <Card title="💡 Tip of the day">
      <p className="text-sm leading-relaxed">{tip}</p>
    </Card>
  );
}

/** Dashboard cards tailored to students, workers and people doing both. */
export function PersonaWidgets({ calendar, focusLeft }: { calendar?: CalendarData; focusLeft: number }) {
  const { user } = useAuth();
  const tz = user?.timezone ?? 'UTC';
  const persona = user?.persona ?? 'WORK';
  const done = useQuery({ queryKey: ['tasks', 'done'], queryFn: async () => (await api.get<{ tasks: Task[] }>('/tasks', { params: { assignee: 'me', status: 'DONE' } })).data.tasks });
  const planner = useQuery({ queryKey: ['planner'], enabled: studies(persona), queryFn: async () => (await api.get<{ answers: LifeAnswers | null }>('/planner')).data });
  const projects = useQuery({ queryKey: ['projects'], enabled: persona === 'HYBRID', queryFn: async () => (await api.get<{ projects: Project[] }>('/projects')).data.projects });

  return (
    <div className="mb-5 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
      <FocusTimer />
      <StreakCard />
      {studies(persona) ? <ExamCountdown answers={planner.data?.answers ?? null} tz={tz} /> : <WorkDay calendar={calendar} focusLeft={focusLeft} />}
      {persona === 'HYBRID' ? <Balance done={done.data ?? []} projects={projects.data ?? []} /> : <TipOfTheDay persona={persona} />}
    </div>
  );
}
