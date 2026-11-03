import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '../services/auth';
import { CELEBRATIONS } from '../features/planner/templates';

interface Celebration { id: number; title?: string; line: string; emoji: string }
interface CelebrateApi { celebrate(opts?: { title?: string; line?: string; emoji?: string }): void }
const Ctx = createContext<CelebrateApi>({ celebrate: () => undefined });

const EMOJIS = ['🎉', '🥳', '🌟', '🏆', '💫', '🎊', '🦄', '🍀'];
const COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#0ea5e9', '#a855f7'];
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

/** Cute "well done" pop-up with confetti when something gets finished. */
export function CelebrateProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [current, setCurrent] = useState<Celebration | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const celebrate = useCallback((opts: { title?: string; line?: string; emoji?: string } = {}) => {
    const lines = [...CELEBRATIONS.ANY, ...(user?.persona ? CELEBRATIONS[user.persona] : [])];
    setCurrent({ id: Date.now(), title: opts.title, line: opts.line ?? pick(lines), emoji: opts.emoji ?? pick(EMOJIS) });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCurrent(null), 4200);
  }, [user?.persona]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const api = useMemo(() => ({ celebrate }), [celebrate]);

  return (
    <Ctx.Provider value={api}>
      {children}
      {current && (
        <div key={current.id} className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center" aria-live="polite">
          <div className="confetti" aria-hidden>
            {Array.from({ length: 36 }, (_, k) => (
              <span key={k} style={{ left: `${(k * 97) % 100}%`, background: COLORS[k % COLORS.length], animationDelay: `${(k % 9) * 0.06}s`, animationDuration: `${1.6 + (k % 5) * 0.25}s`, transform: `rotate(${k * 37}deg)` }} />
            ))}
          </div>
          <button type="button" onClick={() => setCurrent(null)}
            className="celebrate-pop pointer-events-auto mx-4 max-w-sm rounded-2xl border border-border bg-surface px-6 py-5 text-center shadow-2xl">
            <div className="celebrate-emoji text-5xl" aria-hidden>{current.emoji}</div>
            <div className="mt-2 text-lg font-semibold">{current.line}</div>
            {current.title && <div className="mt-1 text-sm text-muted">“{current.title}” is done ✓</div>}
            <div className="mt-3 text-[11px] text-muted">tap to close</div>
          </button>
        </div>
      )}
    </Ctx.Provider>
  );
}

export const useCelebrate = () => useContext(Ctx);
