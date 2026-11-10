import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { DayPlanItem, Effort } from '../../types';
import { clock, duration } from './dayUtils';

/** Left accent colour of a block: how much focus it needs, or what kind of block it is. */
export function accentFor(item: DayPlanItem, effort?: Effort, fixed?: boolean): string {
  if (item.kind === 'BREAK') return 'bg-border';
  if (item.kind === 'BUSY') return 'bg-slate-400';
  if (fixed) return 'bg-amber-500';
  return effort === 'HARD' ? 'bg-indigo-500' : effort === 'EASY' ? 'bg-emerald-500' : 'bg-sky-500';
}

export const LEGEND = [
  { label: 'Deep focus', cls: 'bg-indigo-500' },
  { label: 'Normal', cls: 'bg-sky-500' },
  { label: 'Light', cls: 'bg-emerald-500' },
  { label: 'Set time', cls: 'bg-amber-500' },
  { label: 'Calendar', cls: 'bg-slate-400' },
];

export interface TimelineEntry {
  item: DayPlanItem;
  effort?: Effort;
  fixed?: boolean;
  done?: boolean;
  /** Custom content for task blocks (checkbox, menu...). */
  render?: ReactNode;
}

/**
 * Vertical day timeline with a time rail and, for today, a "now" marker
 * placed between the blocks it falls between.
 */
export function Timeline({ entries, nowMin }: { entries: TimelineEntry[]; nowMin?: number }) {
  const nowIndex = nowMin === undefined ? -1 : entries.findIndex((e) => e.item.end > nowMin);
  return (
    <ol className="relative" aria-label="Day timeline">
      {entries.map((e, i) => {
        const { item } = e;
        const isNow = nowMin !== undefined && item.start <= nowMin && nowMin < item.end;
        const showNowLine = nowMin !== undefined && i === nowIndex && !isNow && item.start > nowMin;
        const quiet = item.kind !== 'TASK';
        return (
          <li key={`${item.start}-${i}`}>
            {showNowLine && <NowLine nowMin={nowMin!} />}
            <div className="group flex gap-3 py-1">
              <div className={clsx('w-16 shrink-0 pt-2 text-right text-xs tabular-nums', isNow ? 'font-semibold text-accent' : 'text-muted')}>{clock(item.start)}</div>
              <div className={clsx(
                'relative min-w-0 flex-1 overflow-hidden rounded-lg border transition-shadow',
                quiet ? 'border-transparent bg-surface-2/70' : 'border-border bg-surface shadow-[0_1px_2px_rgba(16,24,40,0.04)] hover:shadow-sm',
                isNow && !e.done && 'border-accent/50 ring-2 ring-accent/20',
                e.done && 'opacity-60',
              )}>
                <span className={clsx('absolute inset-y-0 left-0 w-1', accentFor(item, e.effort, e.fixed))} aria-hidden />
                <div className={clsx('pl-4 pr-3', quiet ? 'py-1.5' : 'py-2.5')}>
                  {e.render ?? (
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className={clsx('truncate', quiet ? 'text-muted' : 'font-medium')}>
                        {item.title}{item.parts ? <span className="ml-1 text-xs font-normal text-muted">· session {item.part} of {item.parts}</span> : null}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-muted">{duration(item.end - item.start)}</span>
                    </div>
                  )}
                  {!e.render && item.reason && <p className="mt-0.5 text-xs text-muted">{item.reason}</p>}
                </div>
              </div>
            </div>
          </li>
        );
      })}
      {nowMin !== undefined && nowIndex === -1 && entries.length > 0 && <NowLine nowMin={nowMin} />}
    </ol>
  );
}

function NowLine({ nowMin }: { nowMin: number }) {
  return (
    <div className="flex items-center gap-3 py-1" aria-label={`Now, ${clock(nowMin)}`}>
      <div className="w-16 shrink-0 text-right text-[11px] font-semibold uppercase tracking-wide text-danger">Now</div>
      <div className="relative h-px flex-1 bg-danger/70"><span className="absolute -left-1 -top-1 h-2 w-2 rounded-full bg-danger" /></div>
    </div>
  );
}
