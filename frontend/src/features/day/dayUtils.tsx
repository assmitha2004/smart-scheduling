import clsx from 'clsx';
import type { DayPlanItem, Effort } from '../../types';

export const toMin = (hm: string) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
export const fromMin = (m: number) => `${String(Math.floor(m / 60) % 25).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export function clock(m: number) {
  const h = Math.floor(m / 60) % 24;
  const mm = m % 60;
  return `${h % 12 || 12}:${String(mm).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}
export function duration(min: number) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
}

export const EFFORT_LABEL: Record<Effort, string> = { EASY: '🍃 Easy', MEDIUM: '🙂 Normal', HARD: '🧠 Hard' };
export const DURATION_CHOICES = [15, 30, 45, 60, 90, 120, 180];

const KIND_STYLE: Record<DayPlanItem['kind'], string> = {
  TASK: 'border-accent/40 bg-surface',
  BREAK: 'border-dashed border-border bg-surface-2/60 text-muted',
  BUSY: 'border-border bg-surface-2 text-muted',
};

/** One row of the day timeline. */
export function TimelineRow({ item, done, now, children }: { item: DayPlanItem; done?: boolean; now?: boolean; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <div className="w-[4.5rem] shrink-0 pt-2.5 text-right text-xs tabular-nums text-muted">{clock(item.start)}</div>
      <div className={clsx('relative min-w-0 flex-1 rounded-xl border px-3.5 py-2.5 transition-colors', KIND_STYLE[item.kind], now && 'ring-2 ring-accent', done && 'opacity-60')}>
        {children ?? (
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="truncate">{item.title}</span>
            <span className="shrink-0 text-xs">{duration(item.end - item.start)}</span>
          </div>
        )}
      </div>
    </li>
  );
}
