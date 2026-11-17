/**
 * What the assistant knows about the person: their routine (wake/sleep, work
 * hours, when they focus best), meeting preferences, what it has learned from
 * their history, and the meeting decisions they made.
 *
 * Stored in `users.assistant_memory`. The routine falls back to the answers
 * from "Plan my time" (`users.life_profile`), so both features agree.
 */
import { z } from 'zod';
import type { Peak } from '../day/dayPlan.js';

const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');
export type Chronotype = 'EARLY_BIRD' | 'DAYTIME' | 'NIGHT_OWL';

export const profilePatchSchema = z
  .object({
    wakeTime: hm,
    sleepTime: hm,
    workStart: hm,
    workEnd: hm,
    /** 0 = Sunday ... 6 = Saturday */
    workDays: z.array(z.number().int().min(0).max(6)).max(7),
    chronotype: z.enum(['EARLY_BIRD', 'DAYTIME', 'NIGHT_OWL']),
    focusMinutes: z.number().int().min(20).max(180),
    lunch: hm.nullable(),
    meetingsEarliest: hm,
    meetingsLatest: hm,
    meetingBufferMinutes: z.number().int().min(0).max(60),
    maxMeetingsPerDay: z.number().int().min(1).max(15).nullable(),
    protectFocusTime: z.boolean(),
  })
  .partial();
export type ProfilePatch = z.infer<typeof profilePatchSchema>;

export interface Routine {
  wakeTime: string | null;
  sleepTime: string | null;
  workStart: string | null;
  workEnd: string | null;
  workDays: number[];
  chronotype: Chronotype | null;
  focusMinutes: number | null;
  lunch: string | null;
}

export interface MeetingPrefs {
  earliest: string | null;
  latest: string | null;
  bufferMinutes: number;
  maxPerDay: number | null;
  /** Keep meetings out of the person's peak-energy hours when possible. */
  protectFocusTime: boolean;
}

export interface Learned {
  /** Part of day the person actually gets the most done, from finished tasks. */
  peak: Peak | null;
  peakEvidence: string | null;
  /** Multiplier from estimates to reality (1.2 = tasks take 20% longer). */
  estimateFactor: number | null;
  estimateEvidence: string | null;
  /** Share of planned tasks finished on the day they were planned. */
  completionRate: number | null;
  /** Hours (local) the person tends to accept / decline meetings at. */
  preferredMeetingHours: number[];
  avoidedMeetingHours: number[];
  insights: string[];
  updatedAt: string | null;
}

export interface MeetingDecision {
  at: string;
  /** Local hour of the meeting time chosen (or of the declined meeting). */
  hour: number;
  weekday: number;
  choice: 'ACCEPT' | 'DECLINE' | 'RESCHEDULE';
  kind: 'INVITE' | 'REQUEST';
}

export interface AssistantMemory {
  routine: Partial<Routine>;
  meetings: Partial<MeetingPrefs>;
  learned: Learned | null;
  decisions: MeetingDecision[];
  /** Short facts the person told the assistant, newest first. */
  notes: string[];
  /** Email ids already read for meeting requests (not sent to the model again). */
  checkedEmails: string[];
}

export interface Profile {
  routine: Routine;
  meetings: MeetingPrefs;
  learned: Learned | null;
  decisions: MeetingDecision[];
  notes: string[];
  /** Which routine facts came from the person (vs. defaults). */
  known: (keyof Routine)[];
}

interface LifeProfileLite {
  wakeTime?: string;
  sleepTime?: string;
  chronotype?: Chronotype;
  focusMinutes?: number;
  workStart?: string;
  workEnd?: string;
  workDays?: number[];
  persona?: string;
  meals?: { lunch?: string | null };
}

export function readMemory(raw: unknown): AssistantMemory {
  const m = (raw && typeof raw === 'object' ? raw : {}) as Partial<AssistantMemory>;
  return {
    routine: m.routine ?? {},
    meetings: m.meetings ?? {},
    learned: m.learned ?? null,
    decisions: Array.isArray(m.decisions) ? m.decisions : [],
    notes: Array.isArray(m.notes) ? m.notes : [],
    checkedEmails: Array.isArray(m.checkedEmails) ? m.checkedEmails : [],
  };
}

export function readProfile(user: { lifeProfile: unknown; assistantMemory: unknown }): Profile {
  const life = (user.lifeProfile ?? {}) as LifeProfileLite;
  const mem = readMemory(user.assistantMemory);
  const r = mem.routine;
  const pick = <K extends keyof Routine>(k: K, fromLife: Routine[K] | undefined): Routine[K] | null => (r[k] !== undefined ? (r[k] as Routine[K]) : fromLife ?? null);
  const hasWork = life.persona ? life.persona !== 'STUDENT' : true;
  const routine: Routine = {
    wakeTime: pick('wakeTime', life.wakeTime),
    sleepTime: pick('sleepTime', life.sleepTime),
    workStart: pick('workStart', hasWork ? life.workStart : undefined),
    workEnd: pick('workEnd', hasWork ? life.workEnd : undefined),
    workDays: (r.workDays ?? life.workDays ?? [1, 2, 3, 4, 5]) as number[],
    chronotype: pick('chronotype', life.chronotype),
    focusMinutes: pick('focusMinutes', life.focusMinutes),
    lunch: pick('lunch', life.meals?.lunch ?? undefined),
  };
  const known = (Object.keys(routine) as (keyof Routine)[]).filter((k) => routine[k] !== null && (k !== 'workDays' || r.workDays !== undefined || life.workDays !== undefined));
  const meetings: MeetingPrefs = {
    earliest: mem.meetings.earliest ?? routine.workStart ?? null,
    latest: mem.meetings.latest ?? routine.workEnd ?? null,
    bufferMinutes: mem.meetings.bufferMinutes ?? 10,
    maxPerDay: mem.meetings.maxPerDay ?? null,
    protectFocusTime: mem.meetings.protectFocusTime ?? true,
  };
  return { routine, meetings, learned: mem.learned, decisions: mem.decisions, notes: mem.notes, known };
}

/** Merges a validated patch into the stored memory (returns a new object). */
export function applyPatch(raw: unknown, patch: ProfilePatch, note?: string): AssistantMemory {
  const mem = readMemory(raw);
  const routine = { ...mem.routine };
  const meetings = { ...mem.meetings };
  for (const k of ['wakeTime', 'sleepTime', 'workStart', 'workEnd', 'workDays', 'chronotype', 'focusMinutes', 'lunch'] as const) {
    if (patch[k] !== undefined) (routine as Record<string, unknown>)[k] = patch[k];
  }
  if (patch.meetingsEarliest !== undefined) meetings.earliest = patch.meetingsEarliest;
  if (patch.meetingsLatest !== undefined) meetings.latest = patch.meetingsLatest;
  if (patch.meetingBufferMinutes !== undefined) meetings.bufferMinutes = patch.meetingBufferMinutes;
  if (patch.maxMeetingsPerDay !== undefined) meetings.maxPerDay = patch.maxMeetingsPerDay;
  if (patch.protectFocusTime !== undefined) meetings.protectFocusTime = patch.protectFocusTime;
  const notes = note ? [note, ...mem.notes.filter((n) => n !== note)].slice(0, 30) : mem.notes;
  return { ...mem, routine, meetings, notes };
}

export function peakOf(p: Profile): Peak {
  if (p.learned?.peak) return p.learned.peak;
  return p.routine.chronotype === 'EARLY_BIRD' ? 'MORNING' : p.routine.chronotype === 'NIGHT_OWL' ? 'EVENING' : 'AFTERNOON';
}

const PEAK_RANGE: Record<Peak, [number, number]> = { MORNING: [8 * 60, 12 * 60], AFTERNOON: [13 * 60, 17 * 60], EVENING: [18 * 60, 22 * 60] };
export const peakRange = (p: Peak) => PEAK_RANGE[p];

// ---------- profile questions ----------

export interface ProfileQuestion {
  key: string;
  text: string;
  detail: string;
  options: { id: string; label: string; patch: ProfilePatch }[];
}

const workdays = [1, 2, 3, 4, 5];
/** Questions for routine facts the assistant doesn't know yet (most important first). */
export function missingProfileQuestions(p: Profile): ProfileQuestion[] {
  const out: ProfileQuestion[] = [];
  const has = (k: keyof Routine) => p.known.includes(k);
  if (!has('wakeTime')) {
    out.push({
      key: 'profile:wakeTime',
      text: 'When do you usually wake up?',
      detail: 'I won’t plan anything before you’re up.',
      options: ['06:00', '07:00', '08:00', '09:00'].map((t) => ({ id: t, label: label12(t), patch: { wakeTime: t } })),
    });
  }
  if (!has('sleepTime')) {
    out.push({
      key: 'profile:sleepTime',
      text: 'And when do you usually go to sleep?',
      detail: 'Your evening winds down an hour before this.',
      options: ['22:00', '23:00', '00:00', '01:00'].map((t) => ({ id: t, label: label12(t), patch: { sleepTime: t } })),
    });
  }
  if (!has('workStart')) {
    out.push({
      key: 'profile:workHours',
      text: 'What are your working hours?',
      detail: 'Meetings are only suggested inside these hours.',
      options: [
        { id: '9-17', label: '9 AM – 5 PM', patch: { workStart: '09:00', workEnd: '17:00', workDays: workdays } },
        { id: '9-18', label: '9 AM – 6 PM', patch: { workStart: '09:00', workEnd: '18:00', workDays: workdays } },
        { id: '10-19', label: '10 AM – 7 PM', patch: { workStart: '10:00', workEnd: '19:00', workDays: workdays } },
        { id: 'flex', label: 'Flexible (student / freelance)', patch: { workStart: '10:00', workEnd: '18:00', workDays: [1, 2, 3, 4, 5, 6] } },
      ],
    });
  }
  if (!has('chronotype')) {
    out.push({
      key: 'profile:chronotype',
      text: 'When do you do your best focused work?',
      detail: 'Hard tasks go there, and I keep meetings out of it when I can.',
      options: [
        { id: 'EARLY_BIRD', label: 'Mornings', patch: { chronotype: 'EARLY_BIRD' } },
        { id: 'DAYTIME', label: 'Afternoons', patch: { chronotype: 'DAYTIME' } },
        { id: 'NIGHT_OWL', label: 'Evenings', patch: { chronotype: 'NIGHT_OWL' } },
      ],
    });
  }
  return out;
}

export function label12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  const ampm = h < 12 ? 'AM' : 'PM';
  return m ? `${hour}:${String(m).padStart(2, '0')} ${ampm}` : `${hour} ${ampm}`;
}

/** One-line description of the profile, for the AI prompt and the UI. */
export function describeProfile(p: Profile): string[] {
  const r = p.routine;
  const lines: string[] = [];
  if (r.wakeTime || r.sleepTime) lines.push(`Day: wakes ${r.wakeTime ? label12(r.wakeTime) : '?'}, sleeps ${r.sleepTime ? label12(r.sleepTime) : '?'}`);
  if (r.workStart && r.workEnd) lines.push(`Works ${label12(r.workStart)}–${label12(r.workEnd)} on ${daysText(r.workDays)}`);
  if (r.chronotype) lines.push(`Focuses best in the ${r.chronotype === 'EARLY_BIRD' ? 'morning' : r.chronotype === 'NIGHT_OWL' ? 'evening' : 'afternoon'}`);
  if (r.focusMinutes) lines.push(`Focus sessions of about ${r.focusMinutes} min`);
  if (p.meetings.earliest || p.meetings.latest) lines.push(`Meetings between ${p.meetings.earliest ? label12(p.meetings.earliest) : 'any time'} and ${p.meetings.latest ? label12(p.meetings.latest) : 'any time'}, ${p.meetings.bufferMinutes} min buffer`);
  if (p.meetings.maxPerDay) lines.push(`At most ${p.meetings.maxPerDay} meetings a day`);
  return lines;
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function daysText(days: number[]): string {
  const s = [...new Set(days)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  if (s.join() === '1,2,3,4,5') return 'weekdays';
  if (s.length === 7) return 'every day';
  return s.map((d) => DAY[d]).join(', ');
}
