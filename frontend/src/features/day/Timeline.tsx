import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { DayPlanItem, Effort } from '../../types';
import { clock, duration, plain } from './dayUtils';

/** Left accent colour of a task block: how much focus it needs. */
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
  { label: 'Commitment', cls: 'bg-slate-400' },
];

export interface TimelineEntry {
  item: DayPlanItem;
  effort?: Effort;
  fixed?: boolean;
  done?: boolean;
  /** Custom content for task blocks (checkbox, menu...). */
  render?: ReactNode;
}

const isShortBreak = (i: DayPlanItem) => i.kind === 'BREAK' && /^(?:\W*\s*)?(?:short\s+)?break$/i.test(plain(i.title));

/**
 * Vertical day timeline: tasks as cards, commitments as shaded blocks,
 * meals and breaks as quiet rows, and a "now" marker for today.
 */
export function Timeline({ entries, nowMin }: { entries: TimelineEntry[]; nowMin?: number }) {
  const nowIndex = nowMin === undefined ? -1 : entries.findIndex((e) => e.item.end > nowMin);
  return (
    <ol className="relative" aria-label="Day timeline">
      {entries.map((e, i) => {
        const { item } = e;
        const isNow = nowMin !== undefined && item.start <= nowMin && nowMin < item.end;
        const showNowLine = nowMin !== undefined && i === nowIndex && !isNow && item.start > nowMin;
        const title = plain(item.title);
        return (
          <li key={`${item.start}-${i}`}>
            {showNowLine && <NowLine nowMin={nowMin!} />}
            {isShortBreak(item) ? (
              <div className="flex items-center gap-3 py-0.5">
                <div className="w-16 shrink-0" />
                <div className="flex flex-1 items-center gap-2 pl-4 text-[11px] text-muted">
                  <span className="h-px w-4 bg-border" aria-hidden />Break · {duration(item.end - item.start)}
                </div>
              </div>
            ) : item.kind === 'BREAK' ? (
              <div className="flex gap-3 py-1">
                <div className="w-16 shrink-0 pt-1.5 text-right text-xs tabular-nums text-muted">{clock(item.start)}</div>
                <div className="flex flex-1 items-center justify-between rounded-lg bg-surface-2/60 px-4 py-1.5 text-sm text-muted">
                  <span>{title}</span><span className="text-xs tabular-nums">{duration(item.end - item.start)}</span>
                </div>
              </div>
            ) : item.kind === 'BUSY' ? (
              <div className="flex gap-3 py-1">
                <div className="w-16 shrink-0 pt-2 text-right text-xs tabular-nums text-muted">{clock(item.start)}</div>
                <div className="flex flex-1 items-center justify-between rounded-lg border border-border px-4 py-2 text-sm text-muted [background-image:repeating-linear-gradient(135deg,transparent_0_6px,var(--c-surface-2)_6px_12px)]">
                  <span className="font-medium text-fg/80">{title}</span>
                  <span className="text-xs tabular-nums">{clock(item.start)} – {clock(item.end)}</span>
                </div>
              </div>
            ) : (
              <div className="group flex gap-3 py-1">
                <div className={clsx('w-16 shrink-0 pt-2.5 text-right text-xs tabular-nums', isNow ? 'font-semibold text-accent' : 'text-muted')}>{clock(item.start)}</div>
                <div className={clsx(
                  'relative min-w-0 flex-1 overflow-hidden rounded-lg border bg-surface transition-shadow',
                  'border-border shadow-[0_1px_2px_rgba(16,24,40,0.04)] hover:shadow-sm',
                  isNow && !e.done && 'border-accent/50 ring-2 ring-accent/15',
                  e.done && 'opacity-60',
                )}>
                  <span className={clsx('absolute inset-y-0 left-0 w-[3px]', accentFor(item, e.effort, e.fixed))} aria-hidden />
                  <div className="py-2.5 pl-4 pr-3">
                    {e.render ?? (
                      <>
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                          <span className="min-w-0 truncate font-medium">
                            {title}{item.parts ? <span className="ml-1.5 text-xs font-normal text-muted">Part {item.part} of {item.parts}</span> : null}
                          </span>
                          <span className="shrink-0 text-xs tabular-nums text-muted">{clock(item.start)} – {clock(item.end)} · {duration(item.end - item.start)}</span>
                        </div>
                        {item.reason && <p className="mt-0.5 text-xs text-muted">{plain(item.reason)}</p>}
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}
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
