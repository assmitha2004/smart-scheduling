import type { Interval } from './types.js';
import { MINUTE } from './types.js';

/** Half-open intervals [start, end): touching intervals do not overlap. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Sorts and merges overlapping or touching intervals. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((i) => i.end > i.start)
    .map((i) => ({ start: i.start, end: i.end }))
    .sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else out.push(cur);
  }
  return out;
}

/** base minus every interval in `remove`. Result is sorted and merged. */
export function subtractIntervals(base: Interval[], remove: Interval[]): Interval[] {
  const b = mergeIntervals(base);
  const r = mergeIntervals(remove);
  const out: Interval[] = [];
  let j = 0;
  for (const iv of b) {
    let start = iv.start;
    // Skip removals that end before this interval starts.
    while (j < r.length && r[j].end <= start) j++;
    let k = j;
    while (k < r.length && r[k].start < iv.end) {
      if (r[k].start > start) out.push({ start, end: r[k].start });
      start = Math.max(start, r[k].end);
      if (start >= iv.end) break;
      k++;
    }
    if (start < iv.end) out.push({ start, end: iv.end });
  }
  return out;
}

/** Restricts intervals to the window [from, to). */
export function clipIntervals(intervals: Interval[], from: number, to: number): Interval[] {
  return intervals
    .map((i) => ({ start: Math.max(i.start, from), end: Math.min(i.end, to) }))
    .filter((i) => i.end > i.start);
}

export function totalMinutes(intervals: Interval[]): number {
  return Math.round(intervals.reduce((s, i) => s + (i.end - i.start), 0) / MINUTE);
}

/** Every pair of overlapping intervals among `items` (sweep line, O(n log n + k)). */
export function findOverlaps<T extends Interval>(items: T[]): [T, T][] {
  const sorted = [...items].sort((a, b) => a.start - b.start);
  const pairs: [T, T][] = [];
  const active: T[] = [];
  for (const cur of sorted) {
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].end <= cur.start) active.splice(i, 1);
    }
    for (const a of active) pairs.push([a, cur]);
    active.push(cur);
  }
  return pairs;
}
