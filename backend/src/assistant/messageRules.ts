/**
 * Built-in understanding of chat messages to the assistant, used when no AI
 * model is available (and as a safety net for its output):
 *
 *   "I wake up at 6:30 and sleep around 11"      -> routine facts
 *   "I work 10 to 7, no meetings before 11"      -> work hours, meeting window
 *   "I'm a night owl", "max 3 meetings a day"    -> focus style, limits
 *   "plan my day", "what's on tomorrow?", "check my inbox", "add gym 1h"
 *
 * Pure and deterministic.
 */
import type { ProfilePatch } from './profile.js';

export type Intent = 'PLAN_DAY' | 'AGENDA' | 'CHECK_INBOX' | 'ADD_TASKS' | 'PROFILE' | 'HELP';

export interface ReadMessage {
  intent: Intent;
  patch: ProfilePatch;
  /** Plain descriptions of what was understood, e.g. "wake up at 6:30 AM". */
  understood: string[];
  /** For AGENDA: which day. */
  day: 'today' | 'tomorrow' | null;
  /** For ADD_TASKS: the text after "add". */
  tasksText: string | null;
}

const T = String.raw`(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?`;
const pad = (n: number) => String(n).padStart(2, '0');

type Kind = 'morning' | 'night' | 'day' | 'endOfDay';
/** Turns "6", "6:30", "11pm" into HH:mm, guessing AM/PM from what the time is for. */
export function toHm(h: string, m: string | undefined, ampm: string | undefined, kind: Kind): string | null {
  let hour = Number(h);
  const minute = m ? Number(m) : 0;
  if (hour > 23 || minute > 59) return null;
  if (ampm) {
    hour %= 12;
    if (ampm.toLowerCase().startsWith('p')) hour += 12;
  } else if (hour <= 12) {
    if (kind === 'night') hour = hour === 12 ? 0 : hour <= 4 ? hour : hour + 12;
    else if (kind === 'endOfDay') hour = hour === 12 ? 12 : hour <= 9 ? hour + 12 : hour;
    else if (kind === 'day') hour = hour === 12 ? 12 : hour <= 6 ? hour + 12 : hour;
    else hour = hour === 12 ? 0 : hour;
  }
  return `${pad(hour % 24)}:${pad(minute)}`;
}

const label = (hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${pad(m)}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
};

export function readMessage(text: string): ReadMessage {
  const t = text.trim();
  const lower = t.toLowerCase();
  const patch: ProfilePatch = {};
  const understood: string[] = [];

  let m = lower.match(new RegExp(String.raw`\b(?:wake|get up|waking)(?:\s+up)?(?:\s+(?:at|around|by|about))?\s+${T}`));
  if (m) {
    const v = toHm(m[1], m[2], m[3], 'morning');
    if (v) (patch.wakeTime = v), understood.push(`you wake up at ${label(v)}`);
  }
  m = lower.match(new RegExp(String.raw`\b(?:sleep|bed|go to bed|asleep|crash)(?:\s+(?:at|around|by|about))?\s+${T}`));
  if (m) {
    const v = toHm(m[1], m[2], m[3], 'night');
    if (v) (patch.sleepTime = v), understood.push(`you go to sleep at ${label(v)}`);
  }
  m = lower.match(new RegExp(String.raw`\b(?:work|working hours|office hours|job|shift)(?:\s+(?:is|are|hours|from))*\s+${T}\s*(?:-|–|to|till|until)\s*${T}`));
  if (m) {
    const s = toHm(m[1], m[2], m[3], 'morning');
    let e = toHm(m[4], m[5], m[6], 'endOfDay');
    if (s && e && e <= s && !m[6]) e = toHm(String(Number(m[4]) + 12), m[5], undefined, 'day');
    if (s && e && e > s) {
      patch.workStart = s;
      patch.workEnd = e;
      understood.push(`you work ${label(s)}–${label(e)}`);
    }
  }
  m = lower.match(new RegExp(String.raw`\bno meetings?\s+before\s+${T}`));
  if (m) {
    const v = toHm(m[1], m[2], m[3], 'morning');
    if (v) (patch.meetingsEarliest = v), understood.push(`no meetings before ${label(v)}`);
  }
  m = lower.match(new RegExp(String.raw`\bno meetings?\s+after\s+${T}`));
  if (m) {
    const v = toHm(m[1], m[2], m[3], 'endOfDay');
    if (v) (patch.meetingsLatest = v), understood.push(`no meetings after ${label(v)}`);
  }
  m = lower.match(/\b(?:max|maximum|at most|no more than|up to)\s+(\d{1,2})\s+meetings?\b/);
  if (m) (patch.maxMeetingsPerDay = Math.min(15, Math.max(1, Number(m[1])))), understood.push(`at most ${m[1]} meetings a day`);
  m = lower.match(/\b(\d{1,2})\s*(?:min|mins|minutes?)\s+(?:buffer|break|gap)s?\s+between meetings\b/);
  if (m) (patch.meetingBufferMinutes = Math.min(60, Number(m[1]))), understood.push(`${m[1]} min between meetings`);
  m = lower.match(/\bfocus(?:\s+(?:for|in|blocks?|sessions?)(?:\s+of)?)?\s+(\d{1,3})\s*(minutes?|mins?|hours?|hrs?)\b/);
  if (m) {
    const v = /h/.test(m[2]) ? Number(m[1]) * 60 : Number(m[1]);
    if (v >= 20 && v <= 180) (patch.focusMinutes = v), understood.push(`focus sessions of ${v} min`);
  }
  if (/\b(morning person|early bird|best in the morning|focus(?:ed)? (?:best )?in the morning|productive in the morning)\b/.test(lower)) {
    patch.chronotype = 'EARLY_BIRD';
    understood.push('you focus best in the morning');
  } else if (/\b(night owl|best (?:at night|in the evening)|focus(?:ed)? (?:best )?(?:at night|in the evening)|productive (?:at night|in the evening))\b/.test(lower)) {
    patch.chronotype = 'NIGHT_OWL';
    understood.push('you focus best in the evening');
  } else if (/\b(best in the afternoon|focus(?:ed)? (?:best )?in the afternoon|productive in the afternoon|afternoon person)\b/.test(lower)) {
    patch.chronotype = 'DAYTIME';
    understood.push('you focus best in the afternoon');
  }

  const day: ReadMessage['day'] = /\btomorrow\b/.test(lower) ? 'tomorrow' : /\btoday\b|\btonight\b/.test(lower) ? 'today' : null;
  let intent: Intent = 'HELP';
  let tasksText: string | null = null;
  const add = t.match(/^\s*(?:please\s+)?(?:add|also add|i need to|i have to|remind me to)\s+(.+)$/i);
  if (Object.keys(patch).length) intent = 'PROFILE';
  else if (add) {
    intent = 'ADD_TASKS';
    tasksText = add[1].trim();
  } else if (/\b(plan|schedule|organi[sz]e|sort out|re-?plan)\b.*\b(day|today|tomorrow|schedule)\b|\bplan (it|everything)\b/.test(lower)) intent = 'PLAN_DAY';
  else if (/\b(inbox|emails?|mail|meeting requests?|invites?|invitations?)\b/.test(lower)) intent = 'CHECK_INBOX';
  else if (/\b(what'?s|what is|show|do i have|am i free|any|my)\b.*\b(on|meetings?|calendar|agenda|schedule|free|busy)\b/.test(lower)) intent = 'AGENDA';
  return { intent, patch, understood, day, tasksText };
}
