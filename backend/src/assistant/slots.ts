/**
 * Picking good meeting times for the person, and checking times other people
 * propose.
 *
 * A slot must be inside working/meeting hours, at least an hour after waking
 * and before bed, clear of other events (plus a buffer), and on a day that
 * isn't already at the meeting limit. Among those, slots are ranked by what the
 * assistant knows: sooner is better, learned favourite meeting hours win,
 * learned "no" hours and lunch lose, peak focus hours are protected, and a
 * meeting next to another meeting keeps focus time in one block.
 *
 * Pure: takes "now" and the busy list as input.
 */
import { DateTime } from 'luxon';
import { toMin } from '../day/dayPlan.js';
import { peakOf, peakRange, type Profile } from './profile.js';

export interface BusyTime {
  title: string;
  start: string;
  end: string;
}

export interface Slot {
  start: string;
  end: string;
  label: string;
  score: number;
  reasons: string[];
}

export interface SlotRequest {
  now: DateTime;
  timezone: string;
  durationMinutes: number;
  busy: BusyTime[];
  profile: Profile;
  days?: number;
  max?: number;
  /** e.g. "tomorrow afternoon" in a request: prefer this day / part of day. */
  preferDate?: string | null;
  preferPart?: 'MORNING' | 'AFTERNOON' | 'EVENING' | null;
}

const PART: Record<'MORNING' | 'AFTERNOON' | 'EVENING', [number, number]> = { MORNING: [0, 12 * 60], AFTERNOON: [12 * 60, 17 * 60], EVENING: [17 * 60, 24 * 60] };

export function meetingWindow(p: Profile): { start: number; end: number } {
  const r = p.routine;
  let start = toMin(p.meetings.earliest ?? r.workStart ?? '09:00');
  let end = toMin(p.meetings.latest ?? r.workEnd ?? '18:00');
  if (r.wakeTime) start = Math.max(start, toMin(r.wakeTime) + 60);
  if (r.sleepTime && toMin(r.sleepTime) > toMin(r.wakeTime ?? '00:00')) end = Math.min(end, toMin(r.sleepTime) - 60);
  return { start, end };
}

export const slotLabel = (d: DateTime) => `${d.toFormat('ccc d LLL')}, ${d.toFormat(d.minute ? 'h:mm a' : 'h a')}`;

export function suggestSlots(req: SlotRequest): Slot[] {
  const { profile: p, timezone } = req;
  const days = req.days ?? 5;
  const max = req.max ?? 3;
  const buffer = p.meetings.bufferMinutes;
  const win = meetingWindow(p);
  const peak = peakRange(peakOf(p));
  const lunch = p.routine.lunch ? toMin(p.routine.lunch) : 13 * 60;
  const now = req.now.setZone(timezone);
  const earliest = now.plus({ minutes: 30 });
  const busy = req.busy.map((b) => ({ title: b.title, start: Date.parse(b.start), end: Date.parse(b.end) }));
  const preferred = new Set(p.learned?.preferredMeetingHours ?? []);
  const avoided = new Set(p.learned?.avoidedMeetingHours ?? []);
  const workDays = new Set(p.routine.workDays.length ? p.routine.workDays : [1, 2, 3, 4, 5]);

  const candidates: Slot[] = [];
  for (let d = 0; d <= days; d++) {
    const day = now.startOf('day').plus({ days: d });
    if (!workDays.has(day.weekday % 7)) continue;
    const dayStart = day.toMillis();
    const dayEnd = day.plus({ days: 1 }).toMillis();
    const meetingsThatDay = busy.filter((b) => b.start < dayEnd && b.end > dayStart).length;
    if (p.meetings.maxPerDay && meetingsThatDay >= p.meetings.maxPerDay) continue;

    for (let m = Math.ceil(win.start / 30) * 30; m + req.durationMinutes <= win.end; m += 30) {
      const start = day.plus({ minutes: m });
      if (start < earliest) continue;
      const s = start.toMillis();
      const e = s + req.durationMinutes * 60_000;
      if (busy.some((b) => s < b.end + buffer * 60_000 && e > b.start - buffer * 60_000)) continue;

      const reasons: string[] = [];
      let score = 100 - d * 8;
      const hour = Math.floor(m / 60);
      if (preferred.has(hour)) {
        score += 15;
        reasons.push('a time you usually pick');
      }
      if (avoided.has(hour)) score -= 40;
      const endMin = m + req.durationMinutes;
      if (p.meetings.protectFocusTime) {
        if (m < peak[1] && endMin > peak[0]) score -= 25;
        else reasons.push('keeps your focus hours free');
      }
      if (m < lunch + 45 && endMin > lunch) score -= 30;
      const near = busy.some((b) => Math.abs(s - b.end) <= (buffer + 30) * 60_000 || Math.abs(b.start - e) <= (buffer + 30) * 60_000);
      if (near) {
        score += 10;
        reasons.push('next to your other meeting');
      }
      if (req.preferDate) {
        if (day.toISODate() === req.preferDate) {
          score += 25;
          reasons.push('the day they asked for');
        } else score -= 20;
      }
      if (req.preferPart) {
        const [a, b] = PART[req.preferPart];
        if (m >= a && m < b) {
          score += 20;
          reasons.push(`in the ${req.preferPart.toLowerCase()} as they asked`);
        } else score -= 50;
      }
      if (d === 0) reasons.push('today');
      candidates.push({ start: start.toUTC().toISO()!, end: start.plus({ minutes: req.durationMinutes }).toUTC().toISO()!, label: slotLabel(start), score, reasons });
    }
  }

  // Best first, but spread out: no two suggestions within 90 minutes of each other on the same day.
  candidates.sort((a, b) => b.score - a.score || a.start.localeCompare(b.start));
  const picked: Slot[] = [];
  for (const c of candidates) {
    if (picked.some((x) => Math.abs(Date.parse(x.start) - Date.parse(c.start)) < 90 * 60_000)) continue;
    picked.push(c);
    if (picked.length === max) break;
  }
  return picked.sort((a, b) => a.start.localeCompare(b.start));
}

export interface TimeCheck {
  free: boolean;
  conflict: string | null;
  outsideHours: boolean;
  past: boolean;
}

/** Whether a specific proposed time works for the person. */
export function checkTime(startIso: string, durationMinutes: number, busy: BusyTime[], p: Profile, timezone: string, now: DateTime): TimeCheck {
  const start = DateTime.fromISO(startIso).setZone(timezone);
  const s = start.toMillis();
  const e = s + durationMinutes * 60_000;
  const clash = busy.find((b) => s < Date.parse(b.end) && e > Date.parse(b.start));
  const win = meetingWindow(p);
  const m = start.hour * 60 + start.minute;
  const outsideHours = m < win.start || m + durationMinutes > win.end || !p.routine.workDays.includes(start.weekday % 7);
  const past = s < now.toMillis();
  return { free: !clash && !past, conflict: clash?.title ?? null, outsideHours, past };
}
