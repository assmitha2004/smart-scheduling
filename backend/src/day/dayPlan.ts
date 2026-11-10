/**
 * "My Day": turn a plain list of things to do into a realistic plan for one day.
 *
 * - parseTaskLine / parseBrainDump: "gym 1h", "call mom at 6pm", "finish report"
 *   become tasks with a duration (guessed from the words when missing), a
 *   guessed effort level and an optional fixed time.
 * - planDay: places tasks on the day's free time. The #1 priority and must-dos
 *   go first; hard tasks land in the person's peak-energy hours, easy ones in
 *   low-energy time; long tasks are split into sessions; a short break follows
 *   every task; meals and calendar events are never overlapped. Whatever does
 *   not fit is returned as overflow (moved to tomorrow) with an honest message.
 *
 * Pure and deterministic: times are minutes since local midnight (0..1440),
 * so it is fully unit-tested without dates, timezones or a database.
 */

export type Effort = 'EASY' | 'MEDIUM' | 'HARD';
export type Peak = 'MORNING' | 'AFTERNOON' | 'EVENING';

export interface ParsedTask {
  title: string;
  minutes: number;
  minutesGuessed: boolean;
  effort: Effort;
  fixedTime: string | null; // HH:mm
}

export interface DayTaskInput {
  id: string;
  title: string;
  minutes: number;
  mustDo: boolean;
  top: boolean; // the single most important task
  effort: Effort;
  fixedTime: string | null; // HH:mm, must start then
  fromEarlier?: boolean; // carried over from a previous day
  notBefore?: string | null; // HH:mm, e.g. "after lunch"
  dueBy?: string | null; // HH:mm, e.g. "by 5pm"
}

export interface Busy {
  title: string;
  start: number;
  end: number;
  kind: 'BUSY' | 'BREAK';
}

export interface PlanItem {
  kind: 'TASK' | 'BREAK' | 'BUSY';
  taskId: string | null;
  title: string;
  start: number;
  end: number;
  part: number | null; // 1-based session number for split tasks
  parts: number | null;
  reason: string | null;
}

export interface DayPlanResult {
  items: PlanItem[];
  overflow: { taskId: string; title: string; minutes: number; mustDo: boolean }[];
  insights: string[];
  stats: { freeMinutes: number; plannedMinutes: number; taskCount: number; scheduledCount: number };
}

export interface PlanDayInput {
  dayStart: number;
  dayEnd: number;
  peak: Peak;
  busy: Busy[];
  tasks: DayTaskInput[];
  /** Longest single session before a task is split (default 90). */
  maxSession?: number;
}

// ---------- helpers ----------
export const toMin = (hm: string): number => {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
};
export const fromMin = (m: number): string => {
  const c = Math.max(0, Math.min(1440, Math.round(m)));
  return `${String(Math.floor(c / 60)).padStart(2, '0')}:${String(c % 60).padStart(2, '0')}`;
};
const roundUp = (m: number, step = 5) => Math.ceil(m / step) * step;
export const fmtDuration = (min: number) => {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
};
const fmtClock = (m: number) => {
  const h = Math.floor(m / 60) % 24;
  const mm = m % 60;
  return `${h % 12 || 12}${mm ? `:${String(mm).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
};

// ---------- parsing ----------
const DURATION_RE = /(?:\bfor\s+)?(?:(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b(?:\s*(?:and\s*)?(\d+)\s*(?:m|min|mins|minute|minutes)\b)?|(\d+)\s*(?:m|min|mins|minute|minutes)\b|half\s+(?:an\s+)?hour\b|an?\s+hour\b)/i;
const TIME_RE = /\b(?:at|@)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b|\b(\d{1,2})(?::(\d{2}))\s*(am|pm)?\b|\b(\d{1,2})\s*(am|pm)\b/i;

const GUESSES: [RegExp, number, Effort][] = [
  [/\b(leetcode|dsa|coding problems?|practice problems?|mock test)\b/i, 60, 'HARD'],
  [/\b(exam|revise|revision|study|studying|learn|homework|assignment|essay|thesis|report|presentation|slides|project|code|coding|debug|research|write|writing|draft|prepare|practice problems?)\b/i, 90, 'HARD'],
  [/\b(gym|workout|work out|run|running|exercise|yoga|swim|football|cricket|sports?)\b/i, 60, 'MEDIUM'],
  [/\b(meeting|class|lecture|interview|appointment)\b/i, 60, 'MEDIUM'],
  [/\b(cook|cooking|groceries|grocery|shopping|shop)\b/i, 45, 'EASY'],
  [/\b(read|reading|book|journal|meditate|walk|nap)\b/i, 30, 'EASY'],
  [/\b(clean|tidy|laundry|wash|dishes|iron)\b/i, 30, 'EASY'],
  [/\b(call|phone|email|e-mail|mail|text|message|reply|pay|bill|book a|order|post|send|check)\b/i, 15, 'EASY'],
];

export function guessTask(title: string): { minutes: number; effort: Effort } {
  // Also try base forms: "calling" -> "call", "emails" -> "email".
  const variants = [title, title.replace(/(\w{3,})ing\b/gi, '$1'), title.replace(/(\w{3,})s\b/gi, '$1')];
  for (const [re, minutes, effort] of GUESSES) if (variants.some((v) => re.test(v))) return { minutes, effort };
  return { minutes: 30, effort: 'MEDIUM' };
}

function parseClock(h: number, m: number, ampm: string | undefined): string | null {
  let hour = h;
  if (ampm) {
    const pm = ampm.toLowerCase() === 'pm';
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (pm ? 12 : 0);
  } else if (hour > 23) return null;
  if (m > 59) return null;
  return fromMin(hour * 60 + m);
}

/** "finish report 2h", "call mom at 6pm", "gym for 45 mins", "- study maths". */
export function parseTaskLine(line: string): ParsedTask | null {
  let text = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
  if (!text) return null;

  let fixedTime: string | null = null;
  const t = TIME_RE.exec(text);
  if (t) {
    const parsed = t[1] !== undefined ? parseClock(+t[1], t[2] ? +t[2] : 0, t[3])
      : t[4] !== undefined ? parseClock(+t[4], +t[5], t[6])
      : parseClock(+t[7], 0, t[8]);
    if (parsed) {
      fixedTime = parsed;
      text = (text.slice(0, t.index) + text.slice(t.index + t[0].length)).trim();
    }
  }

  let minutes: number | null = null;
  const d = DURATION_RE.exec(text);
  if (d) {
    const word = d[0].toLowerCase();
    if (d[1] !== undefined) minutes = Math.round(parseFloat(d[1]) * 60) + (d[2] ? +d[2] : 0);
    else if (d[3] !== undefined) minutes = +d[3];
    else minutes = word.includes('half') ? 30 : 60;
    text = (text.slice(0, d.index) + text.slice(d.index + d[0].length)).trim();
  }

  const title = text.replace(/\s{2,}/g, ' ').replace(/[\s,;:-]+$/, '').replace(/^[\s,;:-]+/, '');
  if (!title) return null;
  const guess = guessTask(title);
  const valid = minutes !== null && minutes >= 5 && minutes <= 12 * 60;
  return {
    title: title[0].toUpperCase() + title.slice(1),
    minutes: valid ? minutes! : guess.minutes,
    minutesGuessed: !valid,
    effort: guess.effort,
    fixedTime,
  };
}

/** One task per line (commas also split a line when it has no time words). */
export function parseBrainDump(text: string): ParsedTask[] {
  const lines = text.split(/\r?\n/).flatMap((l) => (/[,;]/.test(l) && !/\d/.test(l) ? l.split(/[,;]/) : [l]));
  return lines.map(parseTaskLine).filter((t): t is ParsedTask => t !== null).slice(0, 40);
}

// ---------- energy ----------
/** How sharp the person is at a minute of the day (0-10). */
export function energyAt(peak: Peak, minute: number): number {
  const h = minute / 60;
  if (peak === 'MORNING') return h < 6 ? 3 : h < 12 ? 10 : h < 14 ? 6 : h < 17 ? 5 : h < 20 ? 4 : 2;
  if (peak === 'EVENING') return h < 10 ? 3 : h < 14 ? 5 : h < 17 ? 6 : h < 22 ? 10 : 7;
  return h < 8 ? 3 : h < 10 ? 6 : h < 13 ? 9 : h < 14 ? 6 : h < 17 ? 10 : h < 20 ? 6 : 3;
}

// ---------- planning ----------
type Iv = [number, number];
function subtract(base: Iv[], cut: Iv): Iv[] {
  const out: Iv[] = [];
  for (const [s, e] of base) {
    if (cut[1] <= s || cut[0] >= e) out.push([s, e]);
    else {
      if (cut[0] > s) out.push([s, cut[0]]);
      if (cut[1] < e) out.push([cut[1], e]);
    }
  }
  return out;
}

/** Splits long tasks into sessions of at most `max` minutes (never leaving a tiny last session). */
export function sessions(minutes: number, max: number): number[] {
  if (minutes <= max) return [minutes];
  const n = Math.ceil(minutes / max);
  const base = Math.floor(minutes / n / 5) * 5;
  const out = Array(n).fill(base);
  let rest = minutes - base * n;
  for (let i = 0; rest > 0; i = (i + 1) % n) { const add = Math.min(5, rest); out[i] += add; rest -= add; }
  return out;
}

const breakAfter = (minutes: number) => (minutes >= 75 ? 15 : minutes >= 40 ? 10 : 5);

function priorityRank(t: DayTaskInput): number {
  return (t.top ? 0 : t.mustDo ? 1 : t.fromEarlier ? 2 : 3) * 10 + (t.effort === 'HARD' ? 0 : t.effort === 'MEDIUM' ? 1 : 2);
}

export function planDay(input: PlanDayInput): DayPlanResult {
  const maxSession = input.maxSession ?? 90;
  const dayStart = roundUp(Math.max(0, input.dayStart));
  const dayEnd = Math.min(1440, input.dayEnd);
  const items: PlanItem[] = [];
  const insights: string[] = [];
  const overflow: DayPlanResult['overflow'] = [];
  let free: Iv[] = dayEnd > dayStart ? [[dayStart, dayEnd]] : [];

  // Fixed commitments: calendar events and meals.
  for (const b of input.busy) {
    const s = Math.max(b.start, dayStart);
    const e = Math.min(b.end, dayEnd);
    if (e <= s) continue;
    items.push({ kind: b.kind, taskId: null, title: b.title, start: s, end: e, part: null, parts: null, reason: null });
    free = subtract(free, [s, e]);
  }
  const freeMinutes = free.reduce((sum, [s, e]) => sum + e - s, 0);

  // Tasks with a set time go exactly there.
  const flexible: DayTaskInput[] = [];
  for (const t of input.tasks) {
    if (!t.fixedTime) { flexible.push(t); continue; }
    const s = toMin(t.fixedTime);
    const e = s + t.minutes;
    if (s < dayStart || e > dayEnd) {
      overflow.push({ taskId: t.id, title: t.title, minutes: t.minutes, mustDo: t.mustDo || t.top });
      insights.push(`“${t.title}” is set for ${fmtClock(s)}, which is outside today’s plan, so I moved it to tomorrow.`);
      continue;
    }
    const clash = items.find((i) => i.start < e && s < i.end);
    items.push({ kind: 'TASK', taskId: t.id, title: t.title, start: s, end: e, part: null, parts: null, reason: clash ? `⏰ At ${fmtClock(s)} like you asked. Heads up: it overlaps “${clash.title}”.` : `⏰ At ${fmtClock(s)} like you asked` });
    free = subtract(free, [s, e + 5]);
  }

  // Flexible tasks, most important first.
  const ordered = [...flexible].sort((a, b) => priorityRank(a) - priorityRank(b) || b.minutes - a.minutes);
  for (const t of ordered) {
    // Try the task in one go (or sessions of maxSession); if no gap is big
    // enough, try shorter sessions before giving up on today.
    const sizes = [maxSession, 45, 30].filter((m, i) => i === 0 || (m < maxSession && t.minutes > m && !t.fixedTime));
    const lo = t.notBefore ? toMin(t.notBefore) : 0;
    const hi = t.dueBy ? toMin(t.dueBy) : 1440;
    const constrained = lo > 0 || hi < 1440;
    // Respect "after lunch" / "by 5pm" first; only if impossible, place it anyway and say so.
    const tries: { size: number; lo: number; hi: number }[] = [
      ...sizes.map((size) => ({ size, lo, hi })),
      ...(constrained ? sizes.map((size) => ({ size, lo: 0, hi: 1440 })) : []),
    ];
    let usedLo = lo;
    let usedHi = hi;
    let chunks: number[] = [];
    let placed: Iv[] = [];
    let saved = free;
    for (const { size, lo: tryLo, hi: tryHi } of tries) {
      usedLo = tryLo;
      usedHi = tryHi;
      chunks = sessions(t.minutes, size);
      placed = [];
      saved = free;
      let notBefore = Math.max(dayStart, tryLo);
      for (const len of chunks) {
        let best: { start: number; score: number } | null = null;
        for (const [s, e] of saved) {
          for (let start = Math.max(s, notBefore); start + len <= Math.min(e, tryHi); start += 15) {
            const mid = start + len / 2;
            const energy = energyAt(input.peak, mid);
            const fit = t.effort === 'HARD' ? energy : t.effort === 'EASY' ? (10 - energy) * 0.6 : 5;
            const urgency = t.top ? 4 : t.mustDo ? 2.5 : t.fromEarlier ? 1.5 : 0.2;
            const score = fit * (t.effort === 'MEDIUM' ? 0.2 : 1) - urgency * ((start - dayStart) / 60);
            if (!best || score > best.score) best = { start, score };
          }
        }
        if (!best) break;
        placed.push([best.start, best.start + len]);
        saved = subtract(saved, [best.start, best.start + len + breakAfter(len)]);
        notBefore = best.start + len + breakAfter(len);
      }
      if (placed.length === chunks.length) break;
    }
    if (placed.length === chunks.length && constrained && (usedLo !== lo || usedHi !== hi)) {
      insights.push(`I couldn’t fit “${t.title}” ${t.dueBy && t.notBefore ? `between ${fmtClock(lo)} and ${fmtClock(hi)}` : t.dueBy ? `before ${fmtClock(hi)}` : `after ${fmtClock(lo)}`}, so I put it at the closest free time.`);
    }
    if (placed.length < chunks.length) {
      overflow.push({ taskId: t.id, title: t.title, minutes: t.minutes, mustDo: t.mustDo || t.top });
      continue;
    }
    free = saved;
    placed.forEach(([s, e], i) => {
      const energy = energyAt(input.peak, (s + e) / 2);
      const reason = t.top ? '⭐ Your #1 priority, placed while you’re fresh'
        : t.dueBy && t.notBefore && usedHi === hi && usedLo === lo ? `🕑 Between ${fmtClock(lo)} and ${fmtClock(hi)}, like you said`
        : t.dueBy && usedHi === hi ? `🎯 Done before ${fmtClock(hi)}, like you said`
        : t.notBefore && usedLo === lo ? `🕑 After ${fmtClock(lo)}, like you said`
        : t.fromEarlier ? '↩️ Left over from before, so it comes early today'
        : t.mustDo ? '📌 Must get done today'
        : t.effort === 'HARD' && energy >= 8 ? '🧠 Needs your full brain, so it’s at your best time'
        : t.effort === 'EASY' && energy <= 5 ? '🍃 Quick and easy, good for lower-energy time'
        : '✅ Fits nicely here';
      items.push({ kind: 'TASK', taskId: t.id, title: t.title, start: s, end: e, part: chunks.length > 1 ? i + 1 : null, parts: chunks.length > 1 ? chunks.length : null, reason: i === 0 ? reason : 'Next session, after a break' });
      // A visible break after each longer session, when the next thing doesn't start right away.
      if (e - s >= 40) items.push({ kind: 'BREAK', taskId: null, title: '☕ Short break', start: e, end: e + breakAfter(e - s), part: null, parts: null, reason: null });
    });
  }

  // Drop breaks that collide with something (e.g. the day ends or a meeting starts).
  const solid = items.filter((i) => i.kind !== 'BREAK' || i.title !== '☕ Short break');
  const breaks = items.filter((i) => i.kind === 'BREAK' && i.title === '☕ Short break' && i.end <= dayEnd && !solid.some((x) => x.start < i.end && i.start < x.end));
  const all = [...solid, ...breaks].sort((a, b) => a.start - b.start || (a.kind === 'TASK' ? -1 : 1));

  // Friendly, honest insights.
  const scheduled = new Set(all.filter((i) => i.kind === 'TASK').map((i) => i.taskId));
  const plannedMinutes = all.filter((i) => i.kind === 'TASK').reduce((s, i) => s + i.end - i.start, 0);
  const top = input.tasks.find((t) => t.top);
  if (top && scheduled.has(top.id)) {
    const first = all.find((i) => i.taskId === top.id)!;
    insights.unshift(`Your #1 priority, “${top.title}”, starts at ${fmtClock(first.start)}. Get that done and the day is already a win 🏆`);
  }
  const split = input.tasks.filter((t) => all.some((i) => i.taskId === t.id && i.parts));
  if (split.length) insights.push(`I split ${split.map((t) => `“${t.title}”`).join(', ')} into shorter sessions with breaks, so it’s less tiring.`);
  const mustMissed = overflow.filter((o) => o.mustDo);
  if (mustMissed.length) {
    const need = mustMissed.reduce((s, o) => s + o.minutes, 0);
    const others = overflow.filter((o) => !o.mustDo);
    insights.push(`Your must-dos don’t all fit: ${fmtDuration(need)} more is needed than you have free. I moved ${mustMissed.map((o) => `“${o.title}”`).join(', ')} to tomorrow${others.length ? `, and also ${others.map((o) => `“${o.title}”`).join(', ')}` : ''}. Want to drop something less important instead?`);
  } else if (overflow.length) {
    insights.push(`${overflow.length} task${overflow.length > 1 ? 's' : ''} didn’t fit today, so I moved ${overflow.length > 1 ? 'them' : 'it'} to tomorrow. No stress 💛`);
  }
  const spare = freeMinutes - plannedMinutes;
  if (!overflow.length && input.tasks.length) {
    insights.push(spare >= 120 ? `Everything fits, with about ${fmtDuration(spare)} to spare. Room for a walk or a nap 🌿` : 'Everything fits. A full but doable day 💪');
  }

  return {
    items: all,
    overflow,
    insights,
    stats: { freeMinutes, plannedMinutes, taskCount: input.tasks.length, scheduledCount: scheduled.size },
  };
}

// ---------- compliments ----------
const COMPLIMENTS = {
  first: ['First one done! The hardest part is starting, and you did it 🚀', 'And we’re off! Great start ✨'],
  top: ['You crushed your #1 priority. Everything else is a bonus 🏆', 'Biggest task of the day: done. Seriously impressive 💪'],
  half: ['Halfway there! Look at you go 🔥', 'Half the list, gone. Keep that rhythm 🎶'],
  all: ['Every single task done. What a day! 🎉 Go enjoy your evening.', 'Day complete! You planned it and you did it 🌟'],
  any: ['Nice one! ✅', 'Done and dusted 🧹', 'Another one down 💫', 'Future you says thank you 💌', 'You’re on a roll 🎯', 'Smooth! On to the next 🚀'],
};

/** A friendly message for finishing a task, based on how the day is going. */
export function compliment(opts: { done: number; total: number; wasTop: boolean; seed: number }): string {
  const pick = (xs: string[]) => xs[Math.abs(opts.seed) % xs.length];
  if (opts.total > 0 && opts.done >= opts.total) return pick(COMPLIMENTS.all);
  if (opts.wasTop) return pick(COMPLIMENTS.top);
  if (opts.done === 1) return pick(COMPLIMENTS.first);
  if (opts.total >= 4 && opts.done === Math.ceil(opts.total / 2)) return pick(COMPLIMENTS.half);
  return pick(COMPLIMENTS.any);
}
