/**
 * Built-in reader for meeting requests in email, used when no AI model is
 * available (and to double-check the model's output). Finds whether someone
 * is asking to meet, for how long, and which times they offered:
 *
 *   "Can we get 30 minutes ... tomorrow at 2pm or Thursday at 11am?"
 *   "a quick 20 min call sometime tomorrow afternoon"
 *
 * Pure: the email's date and the user's timezone anchor words like "tomorrow".
 */
import { DateTime } from 'luxon';

export interface MeetingRequest {
  isMeetingRequest: boolean;
  title: string;
  durationMinutes: number;
  /** ISO start times the sender offered. */
  proposedTimes: string[];
  preferDate: string | null;
  preferPart: 'MORNING' | 'AFTERNOON' | 'EVENING' | null;
  summary: string;
}

export interface EmailInput {
  subject: string;
  body: string;
  from: { email: string; name: string | null };
  date: string;
}

const ASK = /\b(meet(ing)?|call|sync|catch[\s-]?up|chat|1:1|one[\s-]on[\s-]one|zoom|google meet|hop on|get together|connect)\b/i;
const REQUEST = /\?|\b(let me know|would love|can we|could we|shall we|are you (free|available)|does .{1,30} work|what works|when works|free (on|at|tomorrow|today|this|next)|available (on|at|tomorrow|today|this|next)|propose|how about)\b/i;
const BULK = /\b(unsubscribe|newsletter|no-?reply|do not reply|view in browser)\b/i;

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_RE = '(today|tomorrow|(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday)?)';
const TIME_RE = '(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)';

function dayFrom(word: string, base: DateTime): DateTime | null {
  const w = word.toLowerCase();
  if (w === 'today') return base;
  if (w === 'tomorrow') return base.plus({ days: 1 });
  const idx = DAYS.findIndex((d) => d.startsWith(w.slice(0, 3)));
  if (idx < 0) return null;
  let diff = (idx - (base.weekday % 7) + 7) % 7;
  if (diff === 0) diff = 7;
  return base.plus({ days: diff });
}

function at(day: DateTime, h: string, m: string | undefined, ampm: string): DateTime {
  let hour = Number(h) % 12;
  if (ampm.toLowerCase().startsWith('p')) hour += 12;
  return day.set({ hour, minute: m ? Number(m) : 0, second: 0, millisecond: 0 });
}

export function durationFrom(text: string): number {
  const t = text.toLowerCase();
  if (/\bhalf an? hour\b/.test(t)) return 30;
  const min = t.match(/(\d{1,3})\s*-?\s*(?:min|mins|minutes|minute)\b/);
  if (min) return Math.min(240, Math.max(10, Number(min[1])));
  const hr = t.match(/(\d(?:\.\d)?)\s*-?\s*(?:hour|hours|hr|hrs)\b/);
  if (hr) return Math.min(240, Math.round(Number(hr[1]) * 60));
  if (/\ban hour\b/.test(t)) return 60;
  return 30;
}

export function readMeetingRequest(msg: EmailInput, timezone: string): MeetingRequest {
  const text = `${msg.subject}\n${msg.body}`;
  const base = DateTime.fromISO(msg.date).setZone(timezone).startOf('day');
  const name = msg.from.name ?? msg.from.email.split('@')[0];
  const title = msg.subject.replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').replace(/\?+\s*$/, '').trim() || `Meeting with ${name}`;
  const none: MeetingRequest = { isMeetingRequest: false, title, durationMinutes: 30, proposedTimes: [], preferDate: null, preferPart: null, summary: '' };
  if (BULK.test(text) || /no-?reply/i.test(msg.from.email)) return none;
  if (!ASK.test(text) || !REQUEST.test(text)) return none;

  const times: DateTime[] = [];
  const dayThenTime = new RegExp(`\\b${DAY_RE}\\b(?:\\s+(?:at|around|@|by))?\\s+${TIME_RE}`, 'gi');
  const timeThenDay = new RegExp(`\\b${TIME_RE}\\s+(?:on\\s+)?\\b${DAY_RE}\\b`, 'gi');
  for (const m of text.matchAll(dayThenTime)) {
    const d = dayFrom(m[1], base);
    if (d) times.push(at(d, m[2], m[3], m[4]));
  }
  for (const m of text.matchAll(timeThenDay)) {
    const d = dayFrom(m[4], base);
    if (d) times.push(at(d, m[1], m[2], m[3]));
  }
  const unique = [...new Map(times.map((t) => [t.toMillis(), t])).values()].sort((a, b) => a.toMillis() - b.toMillis());

  let preferDate: string | null = null;
  let preferPart: MeetingRequest['preferPart'] = null;
  const part = text.match(new RegExp(`\\b${DAY_RE}\\s+(morning|afternoon|evening)\\b`, 'i'));
  if (part) {
    preferDate = dayFrom(part[1], base)?.toISODate() ?? null;
    preferPart = part[2].toUpperCase() as MeetingRequest['preferPart'];
  } else {
    const dayOnly = text.match(new RegExp(`\\b(?:sometime|any ?time|on)\\s+${DAY_RE}\\b`, 'i'));
    if (dayOnly) preferDate = dayFrom(dayOnly[1], base)?.toISODate() ?? null;
  }

  const duration = durationFrom(text);
  const offered = unique.length ? ` and offered ${unique.length === 1 ? 'a time' : `${unique.length} times`}` : preferDate ? ' and asked for a time' : '';
  return {
    isMeetingRequest: true,
    title,
    durationMinutes: duration,
    proposedTimes: unique.slice(0, 5).map((t) => t.toUTC().toISO()!),
    preferDate,
    preferPart,
    summary: `${name} wants to meet (${duration} min)${offered}.`,
  };
}
