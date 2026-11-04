import { Link } from 'react-router-dom';
import { DateTime } from 'luxon';
import { apiError } from '../services/api';
import { useAuth } from '../services/auth';
import { Card, ErrorBox, Loading, PageHeader, Stat } from '../components/ui';
import { fmtMinutes } from '../lib/format';
import { BadgeGrid, useProgress } from '../features/progress/progress';
import type { WeekSummary } from '../types';

function delta(cur: number, prev: number, unit = '') {
  if (cur === prev) return 'same as last week';
  const d = cur - prev;
  return `${d > 0 ? '▲' : '▼'} ${Math.abs(d)}${unit} vs last week`;
}

function Bars({ cur, prev }: { cur: WeekSummary; prev: WeekSummary }) {
  const max = Math.max(cur.minutesDone, prev.minutesDone, 1);
  const row = (label: string, w: WeekSummary, color: string) => (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-20 shrink-0 text-muted">{label}</span>
      <div className="h-6 flex-1 overflow-hidden rounded-md bg-surface-2">
        <div className="flex h-full items-center rounded-md px-2 text-xs font-medium text-white" style={{ width: `${Math.max(8, (w.minutesDone / max) * 100)}%`, background: color }}>{fmtMinutes(w.minutesDone)}</div>
      </div>
      <span className="w-16 shrink-0 text-right tabular-nums">{w.tasksDone} task{w.tasksDone === 1 ? '' : 's'}</span>
    </div>
  );
  return <div className="space-y-2">{row('This week', cur, 'var(--c-accent)')}{row('Last week', prev, 'var(--c-muted)')}</div>;
}

export default function WeeklyReview() {
  const { user } = useAuth();
  const q = useProgress();
  if (q.isLoading) return <Loading label="Gathering your wins…" />;
  if (q.error) return <ErrorBox message={apiError(q.error).message} />;
  const p = q.data!;
  const tz = user?.timezone ?? 'UTC';
  const pct = Math.round((p.xpIntoLevel / p.xpForNext) * 100);
  const earned = p.badges.filter((b) => b.earnedAt).length;

  return (
    <>
      <PageHeader title="Your progress 🏆" subtitle="Every task you finish earns XP. Keep your streak alive and collect badges along the way." />

      <Card className="mb-5 overflow-hidden border-accent/30 bg-gradient-to-br from-accent-soft/70 to-surface">
        <div className="flex flex-wrap items-center gap-5">
          <div className="flex h-20 w-20 shrink-0 flex-col items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white shadow-lg">
            <span className="text-[10px] uppercase tracking-wide opacity-80">Level</span>
            <span className="text-3xl font-bold leading-none">{p.level}</span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-lg font-semibold">{p.levelTitle}</p>
            <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-fuchsia-500" style={{ width: `${pct}%` }} /></div>
            <p className="mt-1 text-xs text-muted">{p.xp} XP · {p.xpForNext - p.xpIntoLevel} XP to level {p.level + 1}</p>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div><div className="text-2xl font-bold">🔥 {p.streak}</div><div className="text-xs text-muted">day streak</div></div>
            <div><div className="text-2xl font-bold">{p.bestStreak}</div><div className="text-xs text-muted">best streak</div></div>
            <div><div className="text-2xl font-bold">{p.totalDone}</div><div className="text-xs text-muted">tasks done</div></div>
          </div>
        </div>
      </Card>

      <h2 className="mb-3 text-lg font-semibold">📊 Weekly review</h2>
      <div className="mb-6">
          {p.week && (
            <div className="space-y-5">
              <Card className="bg-ok-soft/40"><p className="text-[15px]">💬 {p.week.message}</p></Card>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat label="Tasks finished" value={p.week.current.tasksDone} sub={delta(p.week.current.tasksDone, p.week.previous.tasksDone)} />
                <Stat label="Focused work" value={fmtMinutes(p.week.current.minutesDone)} sub={`${p.week.current.xpEarned} XP earned`} />
                <Stat label="Follow-through" value={p.week.current.followThrough === null ? '–' : `${p.week.current.followThrough}%`} sub="of planned blocks done" tone={p.week.current.followThrough !== null && p.week.current.followThrough >= 70 ? 'ok' : undefined} />
                <Stat label="Best day" value={p.week.current.bestDay?.day ?? '–'} sub={p.week.current.bestDay ? `${p.week.current.bestDay.tasks} tasks` : 'finish a task to find out'} />
              </div>
              <div className="grid gap-5 lg:grid-cols-2">
                <Card title={`Week of ${DateTime.fromISO(p.week.current.weekStart, { zone: tz }).toFormat('d LLL')}`}>
                  <Bars cur={p.week.current} prev={p.week.previous} />
                  {p.week.current.byProject.length > 0 && (
                    <ul className="mt-4 space-y-1 text-sm">
                      {p.week.current.byProject.map((x) => <li key={x.name} className="flex justify-between"><span>{x.name}</span><span className="text-muted">{x.tasks} · {fmtMinutes(x.minutes)}</span></li>)}
                    </ul>
                  )}
                </Card>
                <Card title="🏅 Biggest wins this week">
                  {!p.week.current.wins.length ? <p className="text-sm text-muted">Your finished tasks will show up here. <Link to="/app" className="text-accent">Pick one to start →</Link></p> : (
                    <ol className="space-y-2">
                      {p.week.current.wins.map((w, i) => <li key={w.id} className="flex items-center gap-3 text-sm"><span className="text-lg" aria-hidden>{['🥇', '🥈', '🥉', '⭐', '⭐'][i]}</span><span className="flex-1">{w.title}</span><span className="text-xs text-muted">{fmtMinutes(w.minutes)}</span></li>)}
                    </ol>
                  )}
                  {p.week.badgesEarned.length > 0 && <p className="mt-3 text-sm">New badges this week: {p.badges.filter((b) => p.week!.badgesEarned.includes(b.id)).map((b) => `${b.emoji} ${b.title}`).join(', ')}</p>}
                </Card>
              </div>
            </div>
          )}
      </div>

      <h2 className="mb-3 text-lg font-semibold">🎖️ Badges · {earned}/{p.badges.length}</h2>
      <BadgeGrid badges={p.badges} />
    </>
  );
}
