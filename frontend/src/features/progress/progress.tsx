import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';
import { useAuth } from '../../services/auth';
import { useCelebrate } from '../../components/Celebrate';
import { Card } from '../../components/ui';
import type { Progress } from '../../types';
import { useInstallPrompt } from '../../hooks/useInstallPrompt';

export function useProgress() {
  const { user } = useAuth();
  return useQuery({ queryKey: ['progress'], enabled: !!user, queryFn: async () => (await api.get<Progress>('/progress')).data, staleTime: 30_000 });
}

/** Level + XP bar for the sidebar. */
export function LevelChip() {
  const p = useProgress().data;
  if (!p) return null;
  const pct = Math.round((p.xpIntoLevel / p.xpForNext) * 100);
  return (
    <Link to="/app/review" className="block rounded-lg border border-border bg-surface-2/60 p-2.5 hover:border-accent" title={`${p.xp} XP total`}>
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold">Level {p.level}</span>
        <span className="text-muted">{p.streak > 0 ? `🔥 ${p.streak}` : ''}</span>
      </div>
      <div className="mt-0.5 truncate text-[11px] text-muted">{p.levelTitle}</div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-border" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Progress to next level">
        <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-fuchsia-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 text-[10px] text-muted">{p.xpForNext - p.xpIntoLevel} XP to level {p.level + 1}</div>
    </Link>
  );
}

const SEEN_KEY = 'ss.badges.seen';
const readSeen = (): string[] | null => { try { const v = localStorage.getItem(SEEN_KEY); return v ? JSON.parse(v) : null; } catch { return null; } };
const writeSeen = (ids: string[]) => { try { localStorage.setItem(SEEN_KEY, JSON.stringify(ids)); } catch { /* ignore */ } };

/** Celebrates level-ups and newly earned badges (refreshes when tasks change). */
export function ProgressWatcher() {
  const { celebrate } = useCelebrate();
  const { data } = useProgress();
  const lastLevel = useRef<number | null>(null);
  useEffect(() => {
    if (!data) return;
    const earned = data.badges.filter((b) => b.earnedAt).map((b) => b.id);
    const seen = readSeen();
    if (seen === null) { writeSeen(earned); lastLevel.current = data.level; return; } // first visit: no fireworks for history
    const fresh = data.badges.find((b) => b.earnedAt && !seen.includes(b.id));
    if (lastLevel.current !== null && data.level > lastLevel.current) {
      celebrate({ emoji: '🆙', line: `Level up! You’re now level ${data.level}: ${data.levelTitle}` });
    } else if (fresh) {
      celebrate({ emoji: fresh.emoji, line: `New badge: ${fresh.title}!`, title: undefined });
    }
    lastLevel.current = data.level;
    writeSeen(earned);
  }, [data, celebrate]);
  return null;
}

export function BadgeGrid({ badges }: { badges: Progress['badges'] }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {badges.map((b) => (
        <li key={b.id} className={`rounded-xl border p-3 text-center ${b.earnedAt ? 'border-accent/40 bg-accent-soft/50' : 'border-border bg-surface opacity-60'}`}>
          <div className={`text-3xl ${b.earnedAt ? '' : 'grayscale'}`} aria-hidden>{b.earnedAt ? b.emoji : '🔒'}</div>
          <div className="mt-1 text-sm font-semibold">{b.title}</div>
          <div className="text-xs text-muted">{b.description}</div>
          {b.earnedAt && <div className="mt-1 text-[11px] text-accent">Earned {new Date(b.earnedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</div>}
        </li>
      ))}
    </ul>
  );
}

const CHECK_KEY = 'ss.checklist.hidden';

/** "Getting started" checklist on the dashboard until everything is done (or hidden). */
export function GettingStarted({ hasPlan }: { hasPlan: boolean; hasSchedule?: boolean }) {
  const { user } = useAuth();
  const p = useProgress().data;
  const install = useInstallPrompt();
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(CHECK_KEY) === '1'; } catch { return false; } });
  if (hidden || !p) return null;
  const items = [
    { done: hasPlan || !!user?.persona, label: 'Plan your first day', to: '/app?plan=1' },
    { done: p.totalDone > 0, label: 'Finish your first task 🎉', to: '/app' },
    { done: !!user?.calendarFeedEnabled, label: 'Sync with your phone calendar', to: '/app/settings?tab=integrations' },
    { done: install.installed, label: 'Install the app', to: '/app/settings?tab=integrations' },
  ];
  const doneCount = items.filter((i) => i.done).length;
  if (doneCount === items.length) return null;
  return (
    <Card className="mb-5" title={`🚀 Getting started · ${doneCount}/${items.length}`} action={<button className="text-xs text-muted hover:text-fg" onClick={() => { setHidden(true); try { localStorage.setItem(CHECK_KEY, '1'); } catch { /* ignore */ } }}>Hide</button>}>
      <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-ok transition-all" style={{ width: `${(doneCount / items.length) * 100}%` }} /></div>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((i) => (
          <li key={i.label}>
            <Link to={i.to} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${i.done ? 'border-ok/30 bg-ok-soft/50 text-muted line-through' : 'border-border hover:border-accent'}`}>
              <span aria-hidden>{i.done ? '✅' : '⬜'}</span>{i.label}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
