import { DateTime } from 'luxon';
import type { AvailabilityRule, FixedEvent, Interval } from './types.js';
import { clipIntervals, mergeIntervals, subtractIntervals } from './intervals.js';

function parseHm(hm: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!m) throw new Error(`Invalid time "${hm}", expected HH:mm`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) {
    throw new Error(`Invalid time "${hm}"`);
  }
  return { hour, minute };
}

/**
 * Expands weekly working-hour rules (in the user's local timezone) into
 * concrete UTC intervals between `from` and `to`. DST transitions are
 * handled by luxon: "09:00 local" always means 09:00 wall-clock time.
 */
export function expandAvailability(
  rules: AvailabilityRule[],
  timezone: string,
  from: number,
  to: number,
): Interval[] {
  const active = rules.filter((r) => r.isActive !== false);
  if (!active.length || to <= from) return [];
  const out: Interval[] = [];
  let day = DateTime.fromMillis(from, { zone: timezone }).startOf('day');
  const last = DateTime.fromMillis(to, { zone: timezone }).endOf('day');
  if (!day.isValid) throw new Error(`Invalid timezone "${timezone}"`);
  while (day <= last) {
    const jsWeekday = day.weekday % 7; // luxon: 1=Mon..7=Sun -> JS 0=Sun..6=Sat
    for (const r of active) {
      if (r.weekday !== jsWeekday) continue;
      const s = parseHm(r.startTime);
      const e = parseHm(r.endTime);
      const start = day.set({ hour: s.hour, minute: s.minute });
      const end = e.hour === 24 ? day.plus({ days: 1 }) : day.set({ hour: e.hour, minute: e.minute });
      if (end > start) out.push({ start: start.toMillis(), end: end.toMillis() });
    }
    day = day.plus({ days: 1 });
  }
  return clipIntervals(mergeIntervals(out), from, to);
}

/**
 * Free time = working hours - fixed events - breaks - unavailable periods
 * - any already-occupied intervals.
 */
export function computeFreeIntervals(params: {
  rules: AvailabilityRule[];
  timezone: string;
  from: number;
  to: number;
  events: FixedEvent[];
  occupied?: Interval[];
}): Interval[] {
  const working = expandAvailability(params.rules, params.timezone, params.from, params.to);
  const busy = [...params.events.map((e) => ({ start: e.start, end: e.end })), ...(params.occupied ?? [])];
  return subtractIntervals(working, busy);
}
