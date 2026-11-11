/**
 * The planner chat, built in (works without any AI service): you tell it what
 * you need to do, it asks one question at a time when something is unclear
 * (how long the plan runs, same routine or different days, how often each
 * task happens, how long things take, what matters most, fixed hours), makes
 * suggestions when the plan doesn't fit, takes changes in plain language and,
 * once you say so, the plan is finalised into a schedule.
 *
 * Pure: the conversation state travels in `ChatDraft`, so nothing is saved
 * until the plan is finalised.
 */
import { DateTime } from 'luxon';
import { understandDay, readCommitments, readTime } from './understand.js';
import { applyFeedback, findTask, sameTask, type FeedbackTask } from './feedback.js';
import { fmtDuration, toMin, type Peak } from './dayPlan.js';
import {
  ALL_DAYS, WEEKDAYS, WEEKEND, MAX_DAYS, addDays, dayLabel, daysText, periodLabel, programPreview, repeatText, weekdayOf,
  type ProgramCommitment, type ProgramSpec, type ProgramTask, type ProgramWindow, type Repeat,
} from './program.js';

export interface Question { id: string; text: string; options: string[] }
export interface Suggestion { text: string; action: string }
export interface ChatDraft { spec: ProgramSpec; pending: Question | null; asked: string[]; ready: boolean }
export interface ChatContext {
  today: string;
  /** Minutes since local midnight now (today's plan starts from now). */
  nowMin?: number;
  defaults: { dayStart: string; dayEnd: string; peak: Peak };
  meals?: { title: string; start: string; minutes: number }[];
}
export interface ChatTurn {
  reply: string;
  draft: ChatDraft;
  question: Question | null;
  suggestions: Suggestion[];
  ready: boolean;
  /** The person asked to finalise: save the plan now. */
  finalize: boolean;
  changes: string[];
}

const clock = (hm: string) => {
  const m = hm === '24:00' ? 1440 : toMin(hm);
  if (m === 1440) return 'midnight';
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h % 12 || 12}${mm ? `:${String(mm).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
};
const q = (s: string) => `“${s}”`;
const listText = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export function emptySpec(ctx: ChatContext): ProgramSpec {
  return {
    title: '', startDate: null, days: null, sameEveryDay: null,
    dayStart: ctx.defaults.dayStart, dayEnd: ctx.defaults.dayEnd, peak: ctx.defaults.peak,
    commitments: [], windows: [], restDays: [], tasks: [],
  };
}

// ---------------------------------------------------------------- weekdays
const DAY_WORD = String.raw`(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?s?`;
const DAY_INDEX: [RegExp, number][] = [[/^mon/, 1], [/^tue/, 2], [/^wed/, 3], [/^thu/, 4], [/^fri/, 5], [/^sat/, 6], [/^sun/, 7]];
const dayNum = (w: string) => DAY_INDEX.find(([re]) => re.test(w.toLowerCase()))?.[1] ?? 0;
/** The first date on or after `from` that falls on `weekday`. */
const nextWeekday = (from: string, weekday: number, strictlyAfter = false) => {
  let d = from;
  if (strictlyAfter) d = addDays(d, 1);
  while (weekdayOf(d) !== weekday) d = addDays(d, 1);
  return d;
};

// ---------------------------------------------------------------- period
const NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, few: 3 };
const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : NUM[s.toLowerCase().replace(/\s*of$/, '').replace(/^a\s+/, '')] ?? 1);

export interface Period { startDate: string; days: number; matched: string[] }

/** "this week", "next 10 days", "for a month", "this year", "monday to friday", "today", "tomorrow". */
export function parsePeriod(text: string, today: string): Period | null {
  const t = text.toLowerCase();
  const tomorrow = addDays(today, 1);
  const cap = (n: number) => Math.max(1, Math.min(MAX_DAYS, n));
  const span = (a: string, b: string) => Math.round(DateTime.fromISO(b, { zone: 'utc' }).diff(DateTime.fromISO(a, { zone: 'utc' }), 'days').days) + 1;
  // When does it start? "starting tomorrow", "from monday".
  let start = today;
  const startWord = /\b(?:starting|from|beginning|start)\s+(?:on\s+|this\s+|next\s+)?(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.exec(t);
  const matchedStart = startWord ? [startWord[0]] : [];
  if (startWord) start = startWord[1] === 'tomorrow' ? tomorrow : startWord[1] === 'today' ? today : nextWeekday(today, dayNum(startWord[1]));

  // 2026-11-20 to 2026-11-30
  const iso = /\b(\d{4}-\d{2}-\d{2})\s*(?:to|-|–|till|until)\s*(\d{4}-\d{2}-\d{2})\b/.exec(t);
  if (iso && iso[2] >= iso[1] && iso[1] >= today) return { startDate: iso[1], days: cap(span(iso[1], iso[2])), matched: [iso[0]] };

  // monday to friday
  const range = new RegExp(String.raw`\b(?:from\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s*(?:to|-|–|till|until|through)\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b`).exec(t);
  if (range) {
    const a = nextWeekday(today, dayNum(range[1]));
    const b = nextWeekday(a, dayNum(range[2]));
    return { startDate: a, days: cap(span(a, b)), matched: [range[0]] };
  }

  // "for 10 days", "next 2 weeks", "a month", "3 months", "one year"
  const unitRe = /\b(?:for\s+|next\s+|the\s+next\s+|coming\s+|over\s+(?:the\s+)?(?:next\s+)?)?(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|a\s+couple\s+of|a\s+few|couple\s+of)\s*(days?|weeks?|months?|years?)\b/g;
  for (const m of t.matchAll(unitRe)) {
    const before = t.slice(0, m.index).trimEnd();
    if (/(?:times|once|twice|thrice|\bx|hours?|hrs?|\bh|mins?|minutes?|per|each|every|\d)$/.test(before)) continue;
    if (/^(?:a|an|one)$/.test(m[1]) && /\b(?:in|once|per)$/.test(before)) continue;
    const n = num(m[1]);
    const unit = m[2].replace(/s$/, '');
    const s = DateTime.fromISO(start, { zone: 'utc' });
    const days = unit === 'day' ? n : unit === 'week' ? n * 7 : Math.round(s.plus(unit === 'month' ? { months: n } : { years: n }).diff(s, 'days').days);
    return { startDate: start, days: cap(days), matched: [m[0], ...matchedStart] };
  }

  // "this week", "rest of the month", "this year"
  const thisRe = /\b(?:this|(?:the\s+)?rest\s+of\s+(?:the|this))\s+(week|month|year)\b/.exec(t);
  if (thisRe) {
    const end = DateTime.fromISO(start, { zone: 'utc' }).endOf(thisRe[1] as 'week' | 'month' | 'year').toISODate()!;
    return { startDate: start, days: cap(span(start, end)), matched: [thisRe[0], ...matchedStart] };
  }
  // "next week" = Monday to Sunday; "next month", "next year" = the whole one.
  const nextRe = /\bnext\s+(week|month|year)\b/.exec(t);
  if (nextRe) {
    const unit = nextRe[1] as 'week' | 'month' | 'year';
    const a = DateTime.fromISO(today, { zone: 'utc' }).plus({ [`${unit}s`]: 1 }).startOf(unit);
    return { startDate: a.toISODate()!, days: cap(span(a.toISODate()!, a.endOf(unit).toISODate()!)), matched: [nextRe[0]] };
  }
  // "a whole week", "the week", "the month"
  const wholeRe = /\b(?:for\s+)?(?:the\s+(?:whole|entire)\s+|the\s+|a\s+whole\s+)(week|month|year)\b/.exec(t);
  if (wholeRe) {
    const s = DateTime.fromISO(start, { zone: 'utc' });
    const days = wholeRe[1] === 'week' ? 7 : Math.round(s.plus(wholeRe[1] === 'month' ? { months: 1 } : { years: 1 }).diff(s, 'days').days);
    return { startDate: start, days: cap(days), matched: [wholeRe[0], ...matchedStart] };
  }
  // "(this) weekend"
  const weekend = /\b(?:this\s+|the\s+|next\s+)?weekend\b/.exec(t);
  if (weekend && !/\b(?:on|every|at|during)\s+(?:the\s+)?weekends?\b/.test(t)) {
    const wd = weekdayOf(today);
    const sat = /next/.test(weekend[0]) ? addDays(nextWeekday(today, 6, true), wd >= 6 ? 0 : 7) : wd === 7 ? today : nextWeekday(today, 6);
    return { startDate: sat, days: weekdayOf(sat) === 7 ? 1 : 2, matched: [weekend[0]] };
  }
  // "until friday"
  const until = /\b(?:until|till|through|up to)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.exec(t);
  if (until && !/\b(?:finish|submit|complete|done|due|deadline)\b/.test(t)) {
    const b = nextWeekday(start, dayNum(until[1]));
    return { startDate: start, days: cap(span(start, b)), matched: [until[0], ...matchedStart] };
  }
  if (/\bday after tomorrow\b/.test(t)) return { startDate: addDays(today, 2), days: 1, matched: ['day after tomorrow'] };
  if (/\btomorrow\b/.test(t) && !/\btoday\b/.test(t) && !/\b(exam|test|deadline|due|submission|interview|presentation|by)\b[^.]*\btomorrow\b/.test(t)) return { startDate: tomorrow, days: 1, matched: [/\b(?:for\s+|just\s+|plan\s+)?tomorrow\b\s*:?/.exec(t)![0]] };
  const todayRe = /\b(?:for\s+|just\s+)?(?:today|for the day)\b\s*:?/.exec(t);
  if ((todayRe || /\btonight\b/.test(t)) && !/\btomorrow\b/.test(t)) return { startDate: today, days: 1, matched: todayRe ? [todayRe[0]] : [] };
  return null;
}

// ---------------------------------------------------------------- repeats
interface Annotation {
  repeat?: Repeat;
  days?: number[];
  timesPerWeek?: number;
  onceWeekday?: number;
  untilWeekday?: number;
  totalMinutes?: number;
}

const DAYS_LIST = new RegExp(String.raw`\b(?:(?:only\s+)?(?:on|every|each)\s+)?(${DAY_WORD}(?:\s*(?:,|and|&|or|\/)\s*${DAY_WORD})*)\b`, 'i');

/** Finds "every day", "weekdays", "3 times a week", "on mondays and thursdays", "once", "20 hours in total", "by friday". */
export function readRepeat(text: string): { ann: Annotation; matched: string[] } {
  const ann: Annotation = {};
  const matched: string[] = [];
  let t = text;
  const take = (re: RegExp, fn: (m: RegExpExecArray) => boolean | void) => {
    const m = re.exec(t);
    if (m && fn(m) !== false) { matched.push(m[0]); t = t.replace(m[0], ' '); }
  };
  take(/\b(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)\s*(?:in\s+total|total|overall|altogether|in\s+all)\b/i, (m) => { ann.totalMinutes = Math.round(Number(m[1]) * 60); });
  take(/\b(?:a\s+)?total\s+(?:of\s+)?(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)\b/i, (m) => { ann.totalMinutes = Math.round(Number(m[1]) * 60); });
  take(new RegExp(String.raw`\b(?:by|before|until|till|due)\s+(?:this\s+|next\s+)?(${DAY_WORD})\b`, 'i'), (m) => { ann.untilWeekday = dayNum(m[1]); });
  take(/\b(\d|one|two|three|four|five|six|once|twice|thrice)\s*(?:times?|x)?\s*(?:a|per|every|each|\/|in\s+a)\s*week\b/i, (m) => {
    const w = m[1].toLowerCase();
    ann.repeat = 'WEEKLY';
    ann.timesPerWeek = w === 'once' ? 1 : w === 'twice' ? 2 : w === 'thrice' ? 3 : num(w);
  });
  if (!ann.repeat) take(/\b(every\s*day|everyday|daily|each\s+day|every\s+single\s+day|all\s+days|day\s+by\s+day|every\s+morning|every\s+evening|every\s+night|each\s+morning|each\s+evening|each\s+night)\b/i, () => { ann.repeat = 'DAILY'; });
  if (!ann.repeat) take(/\b(?:on\s+|every\s+|only\s+on\s+|during\s+(?:the\s+)?)?(?:weekdays|week\s+days|working\s+days|work\s+days|mon(?:day)?\s*(?:-|to|–|till|through)\s*fri(?:day)?)\b/i, () => { ann.repeat = 'WEEKDAYS'; });
  if (!ann.repeat) take(/\b(?:on\s+|every\s+|at\s+|only\s+on\s+|during\s+)?(?:the\s+)?(?:weekends?|sat(?:urday)?s?\s*(?:and|&|,)\s*sun(?:day)?s?)\b/i, () => { ann.repeat = 'WEEKENDS'; });
  if (!ann.repeat) take(DAYS_LIST, (m) => {
    const words = m[1].split(/\s*(?:,|and|&|or|\/)\s*/).filter(Boolean);
    const days = [...new Set(words.map(dayNum).filter(Boolean))];
    if (!days.length) return false;
    // "on monday" (one day, said once) = once that day; "on mondays", "every monday" = each week.
    const every = /\b(every|each)\b/i.test(m[0]) || words.some((w) => /s$/i.test(w) && !/^(tue|thu)s$/i.test(w)) || days.length > 1;
    if (every) { ann.repeat = 'DAYS'; ann.days = days.sort(); } else { ann.repeat = 'ONCE'; ann.onceWeekday = days[0]; }
  });
  if (!ann.repeat) take(/\b(?:just\s+|only\s+)?(?:once|one\s+time|a\s+single\s+time)\b(?!\s*(?:a|per)\s+week)/i, () => { ann.repeat = 'ONCE'; });
  // "20 hours" in a longer plan is a goal for the whole period, not one sitting.
  if (!ann.totalMinutes && ann.repeat !== 'DAILY') take(/\b(\d{1,3})\s*(?:h|hrs?|hours?)\b(?!\s*(?:a|per|each)\s+day)/i, (m) => {
    if (Number(m[1]) < 8) return false;
    ann.totalMinutes = Number(m[1]) * 60;
  });
  return { ann, matched };
}

/** Every repeat phrase in a sentence, in order and not overlapping. */
function repeatPhrases(s: string): { index: number; text: string }[] {
  const found: { index: number; text: string }[] = [];
  let rest = s;
  for (let guard = 0; guard < 10; guard++) {
    const { matched } = readRepeat(rest);
    if (!matched.length) break;
    for (const m of matched) {
      const i = rest.indexOf(m);
      if (i < 0) continue;
      found.push({ index: i, text: m });
      rest = rest.slice(0, i) + ' '.repeat(m.length) + rest.slice(i + m.length);
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

function applyAnnotation(t: ProgramTask, ann: Annotation, startDate: string) {
  if (ann.repeat && ann.repeat !== t.repeat) { delete t.days; delete t.timesPerWeek; if (ann.repeat !== 'ONCE') t.date = null; }
  if (ann.repeat) t.repeat = ann.repeat;
  if (ann.days) t.days = ann.days;
  if (ann.timesPerWeek) t.timesPerWeek = ann.timesPerWeek;
  if (ann.onceWeekday) t.date = nextWeekday(startDate, ann.onceWeekday);
  if (ann.untilWeekday) t.until = nextWeekday(startDate, ann.untilWeekday);
  if (ann.totalMinutes) {
    t.totalMinutes = ann.totalMinutes;
    t.minutesGuessed = false;
    if (!t.repeat && !t.until) t.repeat = 'DAILY';
  }
}

/** Days a commitment happens on: what the sentence says, else weekdays for work/college, else every day. */
function commitmentDays(sentence: string, title: string): number[] {
  const { ann } = readRepeat(sentence);
  if (ann.repeat === 'DAILY') return ALL_DAYS;
  if (ann.repeat === 'WEEKDAYS') return WEEKDAYS;
  if (ann.repeat === 'WEEKENDS') return WEEKEND;
  if (ann.repeat === 'DAYS' && ann.days) return ann.days;
  if (ann.repeat === 'ONCE' && ann.onceWeekday) return [ann.onceWeekday];
  if (/^(work|office|job|college|school|classes|class|lecture|internship|tuition|coaching|lab)$/i.test(title)) return /\b(sat|saturday)\b/i.test(sentence) ? [1, 2, 3, 4, 5, 6] : WEEKDAYS;
  return ALL_DAYS;
}

// ---------------------------------------------------------------- reading a message
const REST_RE = new RegExp(String.raw`\b(?:(${DAY_WORD}(?:\s*(?:and|&|,)\s*${DAY_WORD})*)\s+(?:off|free|(?:is|are|as)\s+(?:a\s+)?(?:rest|off|holiday|free)\s*(?:days?)?|rest(?:\s+days?)?)|(?:no\s+(?:work|tasks?|plans?|study(?:ing)?)|rest|off|free|holiday|day\s+off|break)\s+on\s+(${DAY_WORD}(?:\s*(?:and|&|,)\s*${DAY_WORD})*))\b`, 'i');

export function readRestDays(text: string): { days: number[]; matched: string | null } {
  const m = REST_RE.exec(text);
  if (!m) return { days: [], matched: null };
  const days = [...new Set((m[1] ?? m[2]).split(/\s*(?:and|&|,)\s*/).map(dayNum).filter(Boolean))];
  return { days, matched: m[0] };
}

interface ReadPlan {
  tasks: ProgramTask[];
  commitments: ProgramCommitment[];
  windows: ProgramWindow[];
  settings: { dayStart?: string; dayEnd?: string; peak?: Peak };
  period: Period | null;
  restDays: number[];
  notes: string[];
}

let keySeq = 0;
const newKey = () => `t${Date.now().toString(36)}${(keySeq++).toString(36)}`;
const TOKEN_RE = /\s*\bzq([ase])(\d+)\b\s*/gi;

/** Reads tasks, how often they repeat, fixed hours and the period from a message. */
export function readPlanText(text: string, ctx: ChatContext, startDate?: string | null): ReadPlan {
  const period = parsePeriod(text, ctx.today);
  let body = text;
  for (const m of period?.matched ?? []) body = body.replace(new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
  // "Plan my next 2 weeks: ..." -> just the list.
  body = body.replace(/(^|[.!?\n]\s*)(?:hi|hey|hello)?[,\s]*(?:can you\s+|could you\s+|please\s+|help me\s+|i want to\s+|i need to\s+)?(?:plan|schedule|organi[sz]e|make\s+(?:a\s+)?(?:plan|schedule)\s+for)\s+(?:out\s+)?(?:my|the|a|for)?\s*(?:whole\s+|entire\s+)?(?:day|days|week|weeks|month|months|year|time|schedule)?\s*(?:[:,-]|\bfor\b)?\s*/gi, '$1');
  const rest = readRestDays(body);
  if (rest.matched) body = body.replace(rest.matched, ' ');
  const start = period?.startDate ?? startDate ?? ctx.today;

  const anns: Annotation[] = [];
  const commitDays: { title: string; start: string; end: string; days: number[] }[] = [];
  const sentences = body.replace(/\r/g, '').split(/\n+|(?<!\d)[.!?;]+(?=\s|$)|(?<=\d)[.!?;]+(?=\s+[A-Za-z]|\s*$)/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const [i, raw] of sentences.entries()) {
    let s = raw;
    const c = readCommitments(s);
    if (c.commitments.length) {
      for (const x of c.commitments) commitDays.push({ ...x, days: commitmentDays(s, x.title) });
      // The days belong to the commitment; don't let them turn into a task.
      const { matched } = readRepeat(s);
      for (const m of matched) s = s.replace(m, ' ');
      out.push(s);
      continue;
    }
    // "Every day: gym and leetcode" — the repeat covers the whole sentence.
    const lead = /^(?:and\s+|also\s+|then\s+|plus\s+)?((?:on\s+|every\s+|each\s+|during\s+(?:the\s+)?)?(?:every\s*day|everyday|daily|each\s+day|weekdays|weekends?|week\s+days|(?:\d|once|twice|thrice)\s*(?:times?\s*)?(?:a|per)\s+week|(?:every|on)\s+(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?s?(?:\s*(?:,|and|&)\s*(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?s?)*))\b\s*[,:-]?\s*(?:i\s+(?:will|want\s+to|need\s+to|have\s+to|should|must)\s+|i'll\s+)?/i.exec(s);
    if (lead && lead[0].length < s.length - 2 && !repeatPhrases(s.slice(lead[0].length)).length) {
      anns.push(readRepeat(lead[1]).ann);
      const idx = anns.length - 1;
      out.push(`zqs${idx}, ${s.slice(lead[0].length)}, zqe${idx}`);
      continue;
    }
    // Per task: mark each repeat phrase where it was said, so "gym daily, leetcode 3 times a week" keep their own.
    for (const ph of repeatPhrases(s).reverse()) {
      anns.push(readRepeat(ph.text).ann);
      s = `${s.slice(0, ph.index)} zqa${anns.length - 1} ${s.slice(ph.index + ph.text.length)}`;
    }
    void i;
    out.push(s);
  }

  const u = understandDay(out.join('. '));
  const tasks: ProgramTask[] = [];
  let sentenceAnn: Annotation | null = null;
  let nextAnn: Annotation | null = null;
  for (const t of u.tasks) {
    const tokens = [...t.title.matchAll(TOKEN_RE)].map((m) => ({ kind: m[1].toLowerCase(), i: Number(m[2]) }));
    const title = t.title.replace(TOKEN_RE, ' ').replace(/\s{2,}/g, ' ').trim().replace(/^(?:and|then|also|i|to)\s+/i, '').replace(/^\w/, (c) => c.toUpperCase());
    let own: Annotation | null = null;
    for (const tk of tokens) {
      if (tk.kind === 's') sentenceAnn = anns[tk.i] ?? null;
      else if (tk.kind === 'a') own = { ...(own ?? {}), ...anns[tk.i] };
    }
    const ends = tokens.some((tk) => tk.kind === 'e');
    if (!title || title.length < 2) {
      if (own) nextAnn = own;
      if (ends) sentenceAnn = null;
      continue;
    }
    const task: ProgramTask = {
      key: newKey(), title, minutes: t.minutes, minutesGuessed: t.minutesGuessed, effort: t.effort, top: t.top, mustDo: t.mustDo,
      fixedTime: t.fixedTime, notBefore: t.notBefore, dueBy: t.dueBy, repeat: null,
    };
    const ann = { ...(sentenceAnn ?? {}), ...(nextAnn ?? {}), ...(own ?? {}) };
    nextAnn = null;
    applyAnnotation(task, ann, start);
    tasks.push(task);
    if (ends) sentenceAnn = null;
  }

  const commitments: ProgramCommitment[] = u.commitments.map((c) => ({
    ...c,
    days: commitDays.find((x) => x.title === c.title && x.start === c.start && x.end === c.end)?.days ?? commitmentDays('', c.title),
  }));
  const windows: ProgramWindow[] = u.windows.map((w) => {
    const inside = commitments.find((c) => toMin(w.start) >= toMin(c.start) && toMin(w.start) < (c.end === '24:00' ? 1440 : toMin(c.end)));
    return { ...w, days: inside?.days ?? ALL_DAYS };
  });
  return { tasks, commitments, windows, settings: u.settings, period, restDays: rest.days, notes: [] };
}

// ---------------------------------------------------------------- questions
const REPEAT_OPTIONS = ['Every day', 'Weekdays', 'Weekends', '3 times a week', 'Just once'];

function durationOptions(t: ProgramTask): string[] {
  const opts = ['30 min', '1 hour', '2 hours', '3 hours'];
  const keep = `Keep ${fmtDuration(t.minutes)}`;
  return [...opts.filter((o) => o !== ({ 30: '30 min', 60: '1 hour', 120: '2 hours', 180: '3 hours' } as Record<number, string>)[t.minutes]), keep];
}

function nextQuestion(spec: ProgramSpec, asked: Set<string>): Question | null {
  if (!spec.tasks.length) {
    return { id: 'tasks', text: 'What do you want to get done? List everything — with or without times. I’ll ask about anything unclear.', options: ['Study 2h, gym, call mom at 7pm', 'Leetcode daily, project 20 hours this month'] };
  }
  if (!spec.startDate || !spec.days) {
    return { id: 'period', text: 'How long should this plan cover?', options: ['Just today', 'Tomorrow', 'This week', 'Next 7 days', 'This month', 'Other…'] };
  }
  if (spec.days > 1 && spec.sameEveryDay === null) {
    return { id: 'same', text: `That’s ${spec.days} days. Should every day follow the same routine, or do different days have different things?`, options: ['Same every day', 'Different days'] };
  }
  if (spec.days > 1 && spec.sameEveryDay === false) {
    const t = spec.tasks.find((x) => !x.repeat && !asked.has(`repeat:${x.key}`));
    if (t) return { id: `repeat:${t.key}`, text: `How often should I plan ${q(t.title)}?`, options: spec.days >= 7 ? REPEAT_OPTIONS : REPEAT_OPTIONS.filter((o) => o !== '3 times a week') };
  }
  const guessed = spec.tasks.filter((t) => t.minutesGuessed && !t.totalMinutes).sort((a, b) => (b.effort === 'HARD' ? 1 : 0) - (a.effort === 'HARD' ? 1 : 0) || b.minutes - a.minutes);
  const askedDur = [...asked].filter((a) => a.startsWith('minutes:')).length;
  const g = guessed.find((t) => !asked.has(`minutes:${t.key}`));
  if (g && askedDur < 3) return { id: `minutes:${g.key}`, text: `How long does ${q(g.title)} take${spec.days > 1 ? ' each time' : ''}? I guessed ${fmtDuration(g.minutes)}.`, options: durationOptions(g) };
  if (spec.tasks.length > 1 && !spec.tasks.some((t) => t.top) && !asked.has('top')) {
    return { id: 'top', text: 'Which one matters most? It gets your best hours first.', options: [...spec.tasks.slice(0, 4).map((t) => t.title), 'No single priority'] };
  }
  if (!spec.commitments.length && !asked.has('fixed')) {
    return { id: 'fixed', text: 'Any fixed hours I should keep free — work, college, classes?', options: ['No fixed hours', 'Work 9am–6pm on weekdays', 'College 9am–4pm on weekdays'] };
  }
  if (!asked.has('hours')) {
    return { id: 'hours', text: `I’ll plan between ${clock(spec.dayStart)} and ${clock(spec.dayEnd)}. Does that work?`, options: ['Sounds good', 'Start at 6am', 'Start at 9am', 'Go until midnight'] };
  }
  if (spec.days >= 7 && !spec.restDays.length && !asked.has('rest') && spec.tasks.some((t) => !t.repeat || t.repeat === 'DAILY')) {
    return { id: 'rest', text: 'Do you want a rest day each week? It makes a long plan easier to keep.', options: ['Sundays off', 'Saturdays off', 'No rest day'] };
  }
  return null;
}

const CONFIRM: Question = { id: 'confirm', text: 'Shall I finalise this into your schedule? You can still tell me changes.', options: ['Finalise', 'Make changes'] };

// ---------------------------------------------------------------- intents
const FINALIZE_RE = /^(?:(?:ok(?:ay)?|yes|yep|yeah|sure|cool|great|perfect|good|nice|fine|alright)[\s,.!]*)*(?:finali[sz]e(?:\s+it)?|confirm|save(?:\s+it)?|lock\s+it(?:\s+in)?|that'?s\s+(?:it|all|fine|good|perfect)|looks?\s+(?:good|great|fine|perfect)|go\s+ahead|let'?s\s+go|do\s+it|make\s+(?:it|the\s+schedule)|schedule\s+it|plan\s+it|done|all\s+good|perfect|yes|yep|yeah|ok(?:ay)?|sure)?(?:\s+please)?[\s.!]*$/i;
const SKIP_RE = /^(?:skip|you\s+decide|you\s+choose|your\s+call|whatever|any|anything|don'?t\s+know|dont\s+know|not\s+sure|idk|no\s+idea|up\s+to\s+you|i'?m\s+confused|confused|help|suggest|you\s+tell\s+me)\b/i;
const NO_RE = /^(?:no|nope|nah|none|nothing|no\s+fixed\s+hours|not\s+really|no\s+single\s+priority|no\s+rest\s+day|all\s+equal|equal)\b/i;

function isFinalize(msg: string): boolean {
  const m = msg.trim();
  return m.length > 0 && m.length < 60 && FINALIZE_RE.test(m) && !/^(?:make changes|change)/i.test(m);
}

/** Reads a duration answer: "45 min", "1.5 hours", "2h 30m", "an hour". */
function readMinutes(text: string): number | null {
  const t = text.toLowerCase();
  const hm = /(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)\s*(?:and\s*)?(\d+)\s*(?:m|mins?|minutes?)\b/.exec(t);
  if (hm) return Math.round(Number(hm[1]) * 60 + Number(hm[2]));
  const h = /(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)\b/.exec(t);
  if (h) return Math.round(Number(h[1]) * 60);
  const m = /(\d+)\s*(?:m|mins?|minutes?)\b/.exec(t);
  if (m) return Number(m[1]);
  if (/\bhalf\s+(?:an\s+)?hour\b/.test(t)) return 30;
  if (/\b(?:an|one|1)\s+hour\b/.test(t)) return 60;
  if (/^\s*\d+(?:\.\d+)?\s*$/.test(t)) { const n = Number(t); return n <= 8 ? Math.round(n * 60) : Math.round(n); }
  return null;
}

/** Applies a default answer to a question (when the person skips it or asks Claude to decide). */
function defaultAnswer(spec: ProgramSpec, id: string, ctx: ChatContext): string {
  if (id === 'period') { spec.startDate = ctx.today; spec.days = 1; return 'I’ll plan just today for now.'; }
  if (id === 'same') { spec.sameEveryDay = true; return 'I’ll keep one routine for every day.'; }
  if (id.startsWith('repeat:')) {
    const t = spec.tasks.find((x) => x.key === id.slice(7));
    if (t) { t.repeat = t.effort === 'EASY' ? 'WEEKLY' : 'DAILY'; if (t.repeat === 'WEEKLY') t.timesPerWeek = 3; return `I’ll plan ${q(t.title)} ${repeatText(t)}.`; }
  }
  if (id.startsWith('minutes:')) { const t = spec.tasks.find((x) => x.key === id.slice(8)); if (t) { t.minutesGuessed = false; return `I’ll keep ${fmtDuration(t.minutes)} for ${q(t.title)}.`; } }
  if (id === 'top') {
    const t = [...spec.tasks].sort((a, b) => Number(b.mustDo) - Number(a.mustDo) || (b.effort === 'HARD' ? 1 : 0) - (a.effort === 'HARD' ? 1 : 0) || b.minutes - a.minutes)[0];
    if (t) { t.top = true; t.mustDo = true; return `I’ll treat ${q(t.title)} as the priority — it’s the biggest focus task.`; }
  }
  if (id === 'rest') return 'No rest day then.';
  return 'Okay.';
}

/** Answers to the question that was asked. Returns null when the message isn't an answer. */
function answer(spec: ProgramSpec, pending: Question, msg: string, ctx: ChatContext): string | null {
  const m = msg.trim();
  const l = m.toLowerCase();
  const id = pending.id;
  if (SKIP_RE.test(l)) return defaultAnswer(spec, id, ctx);

  if (id === 'period') {
    if (/^other/i.test(l) || /^custom/i.test(l)) return '';
    const p = parsePeriod(/^\d+$/.test(l) ? `${l} days` : l.replace(/^just\s+/, ''), ctx.today) ?? (/^next 7 days$/i.test(l) ? { startDate: ctx.today, days: 7, matched: [] } : null);
    if (!p) return null;
    spec.startDate = p.startDate;
    spec.days = p.days;
    if (p.days === 1) spec.sameEveryDay = true;
    return `Planning ${periodLabel(p.startDate, p.days)}${p.days > 1 ? ` (${p.days} days)` : ''}.`;
  }
  if (id === 'same') {
    if (/\b(same|repeat|routine|yes|every ?day|daily)\b/.test(l) && !/\bdifferent\b/.test(l)) { spec.sameEveryDay = true; return 'One routine, every day.'; }
    if (/\b(differ|vary|varies|change|no|mix)\w*/.test(l)) { spec.sameEveryDay = false; return 'Different days it is — I’ll ask how often each thing happens.'; }
    return null;
  }
  if (id.startsWith('repeat:')) {
    const t = spec.tasks.find((x) => x.key === id.slice(7));
    if (!t) return '';
    const { ann } = readRepeat(/^just once$/i.test(l) ? 'once' : l);
    if (!ann.repeat && !ann.totalMinutes) return null;
    applyAnnotation(t, ann, spec.startDate!);
    return `${t.title}: ${repeatText(t)}${t.totalMinutes ? `, ${fmtDuration(t.totalMinutes)} in total` : ''}.`;
  }
  if (id.startsWith('minutes:')) {
    const t = spec.tasks.find((x) => x.key === id.slice(8));
    if (!t) return '';
    if (/^(keep|fine|ok|okay|yes|good|that'?s right|correct|sounds good)/i.test(l)) { t.minutesGuessed = false; return `${fmtDuration(t.minutes)} for ${t.title}.`; }
    const mins = readMinutes(l);
    if (!mins) return null;
    t.minutes = Math.max(5, Math.min(720, Math.round(mins / 5) * 5));
    t.minutesGuessed = false;
    return `${t.title}: ${fmtDuration(t.minutes)}${(spec.days ?? 1) > 1 ? ' each time' : ''}.`;
  }
  if (id === 'top') {
    if (NO_RE.test(l)) return 'No single priority — I’ll balance them.';
    const key = findTask(m, spec.tasks.map((x) => ({ ...x, id: x.key })))?.id ?? spec.tasks.find((x) => x.title.toLowerCase() === l)?.key;
    if (!key) return null;
    for (const x of spec.tasks) x.top = x.key === key;
    const top = spec.tasks.find((x) => x.top)!;
    top.mustDo = true;
    return `${top.title} comes first.`;
  }
  if (id === 'fixed') {
    if (NO_RE.test(l)) return 'No fixed hours — the whole day is yours.';
    const r = readPlanText(m, ctx, spec.startDate);
    if (!r.commitments.length) return null;
    spec.commitments.push(...r.commitments);
    spec.windows.push(...r.windows);
    return `I’ll keep ${listText(r.commitments.map((c) => `${c.title.toLowerCase()} ${clock(c.start)}–${clock(c.end)} (${daysText(c.days)})`))} free.`;
  }
  if (id === 'hours') {
    if (/^(sounds good|good|fine|ok|okay|yes|yep|works|keep|perfect|great)/i.test(l)) return '';
    const changed = readDayHours(spec, m);
    return changed || null;
  }
  if (id === 'rest') {
    if (NO_RE.test(l)) return 'No rest day.';
    const { days } = readRestDays(l.replace(/^(\w+?)s?\s+off$/i, '$1 off'));
    const d = days.length ? days : (DAYS_LIST.exec(l) ? [dayNum(DAYS_LIST.exec(l)![1])] : []);
    if (!d.length || !d[0]) return null;
    spec.restDays = d;
    return `${daysText(d).replace(/^\w/, (c) => c.toUpperCase())} off.`;
  }
  if (id === 'tasks') return null;
  return null;
}

/** "start at 6am", "go until midnight", "7am to 11pm", "wake at 6", "sleep at 12". */
function readDayHours(spec: ProgramSpec, msg: string): string | null {
  const l = msg.toLowerCase();
  const said: string[] = [];
  const range = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|-|–|till|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b|\b(midnight)\b/.exec(l);
  const start = /\b(?:start|begin|wake(?:\s+up)?|get\s+up|from)\s+(?:at\s+|around\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(l);
  const end = /\b(?:until|till|end|stop|finish|sleep|bed|go\s+until|go\s+till|to)\s+(?:at\s+|around\s+)?(?:(midnight)|(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)/.exec(l);
  if (start) {
    const s = readTime(start[1], start[2], start[3], 'morning');
    if (s) { spec.dayStart = /wake|get/.test(start[0]) ? fixHm(toMin(s) + 30) : s; said.push(`start at ${clock(spec.dayStart)}`); }
  }
  if (end) {
    const e = end[1] ? '24:00' : readTime(end[2], end[3], end[4], 'late');
    if (e) { spec.dayEnd = /sleep|bed/.test(end[0]) ? fixHm((e === '24:00' ? 1440 : toMin(e)) - 30) : e; said.push(`finish by ${clock(spec.dayEnd)}`); }
  }
  if (!said.length && range && !range[7]) {
    const s = readTime(range[1], range[2], range[3], 'morning');
    const e = readTime(range[4], range[5], range[6] ?? (Number(range[4]) <= 12 ? 'pm' : undefined), 'late');
    if (s && e && toMin(e === '24:00' ? '23:59' : e) > toMin(s)) { spec.dayStart = s; spec.dayEnd = e; said.push(`plan ${clock(s)}–${clock(e)}`); }
  }
  if (!said.length && range?.[7]) { spec.dayEnd = '24:00'; said.push('go until midnight'); }
  return said.length ? `Okay, I’ll ${listText(said)}.` : null;
}
const fixHm = (m: number) => {
  const c = Math.max(0, Math.min(1440, m));
  return `${String(Math.floor(c / 60)).padStart(2, '0')}:${String(c % 60).padStart(2, '0')}`;
};

// ---------------------------------------------------------------- changes after the plan exists
/** Plain-language changes to a plan: period, routine, how often, rest days, durations, times, priorities, adding/removing. */
function applyChanges(spec: ProgramSpec, msg: string, ctx: ChatContext): { changes: string[]; notUnderstood: string[] } {
  const changes: string[] = [];
  const l = msg.toLowerCase();
  const asTasks = () => spec.tasks.map((t) => ({ ...t, id: t.key }));

  // Adding tasks: "add reading 30 min daily", "also gym on weekends".
  const add = /^(?:please\s+)?(?:add|also|plus|include|and also|i\s+(?:also\s+)?(?:need|have|want)\s+to|put\s+in)\s+(.+)$/i.exec(msg.trim());
  if (add) {
    const r = readPlanText(add[1], ctx, spec.startDate);
    const fresh = r.tasks.filter((t) => !spec.tasks.some((x) => sameTask(x.title, t.title)));
    if (fresh.length) {
      spec.tasks.push(...fresh);
      changes.push(`Added ${listText(fresh.map((t) => `${t.title} (${fmtDuration(t.minutes)}${t.repeat ? `, ${repeatText(t)}` : ''})`))}.`);
    }
    if (r.commitments.length) { spec.commitments.push(...r.commitments); changes.push(`Keeping ${listText(r.commitments.map((c) => `${c.title.toLowerCase()} ${clock(c.start)}–${clock(c.end)}`))} free.`); }
    if (changes.length) return { changes, notUnderstood: [] };
  }

  // Period: "make it 2 weeks", "plan the whole month instead".
  const mentioned = findTask(msg, asTasks());
  const p = parsePeriod(msg, ctx.today);
  if (p && (!mentioned || /\b(plan|make it|change|extend|instead|whole|entire|period|for the)\b/.test(l))) {
    if (p.startDate !== spec.startDate || p.days !== spec.days) {
      spec.startDate = p.startDate;
      spec.days = p.days;
      if (p.days === 1) spec.sameEveryDay = true;
      changes.push(`The plan now covers ${periodLabel(p.startDate, p.days)}${p.days > 1 ? ` (${p.days} days)` : ''}.`);
    }
  }
  // Same routine or different days.
  if (/\b(same (?:every ?day|routine|each day|for all days|daily)|every day (?:the )?same|repeat (?:it|this) daily)\b/.test(l)) {
    spec.sameEveryDay = true;
    for (const t of spec.tasks) if (t.repeat && t.repeat !== 'ONCE') t.repeat = 'DAILY';
    changes.push('Every day now follows the same routine.');
  } else if (/\b(different (?:days|every ?day|each day|schedule|routine)|vary|daily (?:a )?different|each day different)\b/.test(l)) {
    spec.sameEveryDay = false;
    changes.push('Different days can have different things now.');
  }
  // Rest days: "sundays off", "no tasks on saturday".
  const rest = readRestDays(msg);
  if (rest.days.length) {
    spec.restDays = [...new Set([...spec.restDays, ...rest.days])].sort();
    changes.push(`${daysText(rest.days).replace(/^\w/, (c) => c.toUpperCase())} off.`);
  } else if (/\b(no rest days?|work every day|remove (?:the )?rest days?)\b/.test(l) && spec.restDays.length) {
    spec.restDays = [];
    changes.push('No rest days.');
  }
  // How often a task happens: "gym only on weekends", "leetcode 3 times a week".
  if (mentioned && !rest.days.length) {
    const t = spec.tasks.find((x) => x.key === mentioned.id)!;
    const { ann } = readRepeat(msg);
    if (ann.repeat || ann.totalMinutes || ann.untilWeekday) {
      applyAnnotation(t, ann, spec.startDate ?? ctx.today);
      if (ann.repeat && ann.repeat !== 'DAILY') spec.sameEveryDay = false;
      changes.push(`${t.title}: ${repeatText(t)}${t.totalMinutes ? `, ${fmtDuration(t.totalMinutes)} in total` : ''}${t.until ? `, until ${dayLabel(t.until)}` : ''}.`);
      return { changes, notUnderstood: [] };
    }
  }
  if (changes.length) return { changes, notUnderstood: [] };

  // Everything else a single day understands: durations, times, priorities, breaks, hours, removing.
  const settings = { dayStart: spec.dayStart, dayEnd: spec.dayEnd, peak: spec.peak, breaks: spec.breaks, maxSession: spec.maxSession, commitments: spec.commitments.map(({ title, start, end }) => ({ title, start, end })), windows: spec.windows.map(({ start, end, light }) => ({ start, end, light })) };
  const r = applyFeedback(msg, settings, asTasks() as FeedbackTask[]);
  if (!r.changes.length) return { changes: [], notUnderstood: r.notUnderstood };
  spec.dayStart = r.settings.dayStart;
  spec.dayEnd = r.settings.dayEnd;
  spec.peak = r.settings.peak;
  if (r.settings.breaks) spec.breaks = r.settings.breaks;
  if (r.settings.maxSession) spec.maxSession = r.settings.maxSession;
  const keepC = (c: { title: string; start: string; end: string }) => spec.commitments.find((x) => x.title === c.title && x.start === c.start && x.end === c.end);
  spec.commitments = (r.settings.commitments ?? []).map((c) => keepC(c) ?? { ...c, days: commitmentDays(msg, c.title) });
  const keepW = (w: { start: string; end: string }) => spec.windows.find((x) => x.start === w.start && x.end === w.end);
  spec.windows = (r.settings.windows ?? []).map((w) => keepW(w) ?? { ...w, days: ALL_DAYS });
  const next: ProgramTask[] = [];
  for (const t of r.tasks) {
    const before = spec.tasks.find((x) => x.key === t.id);
    if (before) next.push({ ...before, title: t.title, minutes: t.minutes, minutesGuessed: false, effort: t.effort, top: t.top, mustDo: t.mustDo, fixedTime: t.fixedTime, notBefore: t.notBefore ?? null, dueBy: t.dueBy ?? null, totalMinutes: t.minutes !== before.minutes ? null : before.totalMinutes });
    else next.push({ key: newKey(), title: t.title, minutes: t.minutes, minutesGuessed: t.minutesGuessed, effort: t.effort, top: t.top, mustDo: t.mustDo, fixedTime: t.fixedTime, notBefore: t.notBefore ?? null, dueBy: t.dueBy ?? null, repeat: null });
  }
  // "Move X to tomorrow" in a longer plan: start it a day later.
  for (const x of r.removed) {
    const before = spec.tasks.find((t) => t.key === x.task.id);
    if (x.tomorrow && before && spec.days && spec.days > 1 && spec.startDate) next.push({ ...before, repeat: before.repeat ?? 'ONCE', date: addDays(before.date ?? spec.startDate, 1) });
  }
  spec.tasks = next;
  return { changes: r.changes, notUnderstood: r.notUnderstood };
}

// ---------------------------------------------------------------- suggestions
function suggest(spec: ProgramSpec, ctx: ChatContext): { suggestions: Suggestion[]; preview: ReturnType<typeof programPreview> | null } {
  if (!spec.tasks.length || !spec.startDate || !spec.days) return { suggestions: [], preview: null };
  const preview = programPreview(spec, { count: 14, meals: ctx.meals, firstDayStartMin: spec.startDate === ctx.today ? ctx.nowMin : undefined });
  const s = preview.summary!;
  const out: Suggestion[] = [];
  if (s.overloaded.length) {
    const first = s.overloaded[0];
    const daily = spec.tasks.filter((t) => !t.top && (t.repeat === 'DAILY' || (!t.repeat && spec.sameEveryDay !== false)) && !t.fixedTime).sort((a, b) => b.minutes - a.minutes)[0];
    const head = s.overloaded.length === 1 ? `${first.label} doesn’t fit everything (${fmtDuration(first.minutes)} over).` : `${s.overloaded.length} days don’t fit everything, e.g. ${first.label} (${fmtDuration(first.minutes)} over).`;
    if (daily && (spec.days ?? 1) >= 7) out.push({ text: `${head} Doing ${daily.title} 3 times a week instead of daily would free up time.`, action: `${daily.title} 3 times a week` });
    else if (spec.breaks !== 'SHORT') out.push({ text: `${head} Shorter breaks would fit more in.`, action: 'Shorter breaks' });
    else out.push({ text: `${head} Starting earlier would help.`, action: 'Start at 6am' });
  }
  const focus = spec.tasks.filter((t) => t.effort === 'HARD').reduce((sum, t) => sum + t.minutes, 0);
  if (focus > 6 * 60 && (spec.days ?? 1) > 1) out.push({ text: `That’s about ${fmtDuration(focus)} of deep focus a day. Most people manage 4–5 hours well; shorter sessions help.`, action: 'Shorter sessions' });
  if ((spec.days ?? 1) >= 7 && !spec.restDays.length && s.avgMinutesPerDay > 5 * 60) out.push({ text: 'A weekly rest day helps you keep a long plan going.', action: 'Sundays off' });
  const notTop = spec.tasks.length > 1 && !spec.tasks.some((t) => t.top);
  if (notTop && out.length < 3) out.push({ text: `Pick one priority so it always gets your best hours.`, action: `${spec.tasks[0].title} is the most important` });
  return { suggestions: out.slice(0, 3), preview };
}

function summaryLine(spec: ProgramSpec): string {
  const parts: string[] = [];
  const tasks = spec.tasks.map((t) => `${t.title} (${t.totalMinutes ? `${fmtDuration(t.totalMinutes)} total` : fmtDuration(t.minutes)}${(spec.days ?? 1) > 1 && t.repeat ? `, ${repeatText(t)}` : ''})`);
  parts.push(`${spec.tasks.length} task${spec.tasks.length === 1 ? '' : 's'}: ${listText(tasks)}`);
  if (spec.commitments.length) parts.push(`keeping ${listText(spec.commitments.map((c) => `${c.title.toLowerCase()} ${clock(c.start)}–${clock(c.end)}${(spec.days ?? 1) > 1 ? ` (${daysText(c.days)})` : ''}`))} free`);
  if (spec.startDate && spec.days) parts.push(`for ${periodLabel(spec.startDate, spec.days)}`);
  return `${parts.join('; ')}.`;
}

/** Fills anything still open with sensible defaults (used when the person finalises early). */
export function fillDefaults(spec: ProgramSpec, ctx: ChatContext): string[] {
  const notes: string[] = [];
  if (!spec.startDate || !spec.days) { spec.startDate = ctx.today; spec.days = 1; notes.push('I planned just today.'); }
  if (spec.sameEveryDay === null) spec.sameEveryDay = spec.days <= 1 || spec.tasks.every((t) => !t.repeat);
  for (const t of spec.tasks) {
    if (!t.repeat) t.repeat = spec.days <= 1 ? 'ONCE' : spec.sameEveryDay ? 'DAILY' : 'DAILY';
    t.minutesGuessed = false;
  }
  if (!spec.title) spec.title = spec.days <= 1 ? `Plan for ${dayLabel(spec.startDate)}` : `${periodLabel(spec.startDate, spec.days)} plan`;
  return notes;
}

// ---------------------------------------------------------------- one turn
export function chatTurn(message: string, draftIn: ChatDraft | null, ctx: ChatContext): ChatTurn {
  const draft: ChatDraft = draftIn ? structuredClone(draftIn) : { spec: emptySpec(ctx), pending: null, asked: [], ready: false };
  const spec = draft.spec;
  const asked = new Set(draft.asked);
  const msg = message.trim();
  const said: string[] = [];
  const changes: string[] = [];
  let finalize = false;

  if (!spec.tasks.length) {
    // Opening message: read everything we can.
    const r = readPlanText(msg, ctx);
    spec.tasks = r.tasks;
    spec.commitments = r.commitments;
    spec.windows = r.windows;
    if (r.settings.dayStart) spec.dayStart = r.settings.dayStart;
    if (r.settings.dayEnd) spec.dayEnd = r.settings.dayEnd;
    if (r.settings.peak) spec.peak = r.settings.peak;
    if (r.restDays.length) spec.restDays = r.restDays;
    if (r.period && !spec.startDate) { spec.startDate = r.period.startDate; spec.days = r.period.days; }
    else if (draft.pending?.id === 'period') { /* keep asking */ }
    if (spec.startDate && spec.days) for (const t of spec.tasks) if (t.date && (t.date < spec.startDate)) t.date = spec.startDate;
    if (spec.days === 1) spec.sameEveryDay = true;
    if (spec.tasks.some((t) => t.repeat && t.repeat !== 'DAILY')) spec.sameEveryDay = false;
    else if (spec.tasks.length && spec.tasks.every((t) => t.repeat === 'DAILY')) spec.sameEveryDay = spec.sameEveryDay ?? true;
    if (!spec.tasks.length) {
      const question = nextQuestion(spec, asked)!;
      return { reply: msg ? 'I couldn’t find tasks in that yet.' : 'Hi! Let’s plan.', draft: { ...draft, pending: question }, question, suggestions: [], ready: false, finalize: false, changes: [] };
    }
    said.push(`Got it — ${summaryLine(spec)}`);
    if (r.period === null && /\b(\d+\s*(?:days?|weeks?|months?|years?))\b/i.test(msg) === false) { /* period asked next */ }
  } else if (isFinalize(msg) && (draft.ready || draft.pending?.id === 'confirm' || /finali[sz]e|confirm|lock|save|schedule it|plan it/i.test(msg))) {
    finalize = true;
    said.push(...fillDefaults(spec, ctx), 'Done — your schedule is ready.');
  } else if (/^(?:make changes|change something|edit|changes)$/i.test(msg)) {
    said.push('Sure — tell me what to change, like “gym only on weekends”, “leetcode 45 min”, “start at 8am” or “add reading daily”.');
    draft.pending = null;
    draft.ready = false;
    const turn = { reply: said.join(' '), draft: { ...draft, asked: [...asked] }, question: null, suggestions: [], ready: true, finalize: false, changes: [] };
    return turn;
  } else {
    let handled = false;
    if (draft.pending && draft.pending.id !== 'confirm') {
      const a = answer(spec, draft.pending, msg, ctx);
      if (a !== null) {
        handled = true;
        asked.add(draft.pending.id);
        if (a) said.push(a);
        else if (draft.pending.id === 'period') { said.push('Tell me how long — e.g. “10 days”, “2 weeks”, “until Friday”, “this year”.'); asked.delete('period'); }
      }
    }
    if (!handled) {
      const r = applyChanges(spec, msg, ctx);
      if (r.changes.length) { changes.push(...r.changes); said.push(r.changes.join(' ')); handled = true; }
      if (!handled) {
        // Maybe more tasks.
        const more = readPlanText(msg, ctx, spec.startDate);
        const fresh = more.tasks.filter((t) => !spec.tasks.some((x) => sameTask(x.title, t.title)));
        if (fresh.length && (fresh.length > 1 || /\b\d+\s*(?:h|hrs?|hours?|m|mins?|minutes?)\b|\b(?:daily|every|weekly|weekends?|weekdays)\b/i.test(msg) || /^\s*(?:i\s+)?(?:also\s+)?(?:need|have|want|must)/i.test(msg))) {
          spec.tasks.push(...fresh);
          if (more.commitments.length) spec.commitments.push(...more.commitments);
          const m = `Added ${listText(fresh.map((t) => t.title))}.`;
          changes.push(m);
          said.push(m);
          handled = true;
        }
      }
      if (!handled) {
        said.push(draft.pending && draft.pending.id !== 'confirm'
          ? 'Sorry, I didn’t catch that. Pick one of the options, type your own answer, or say “you decide”.'
          : 'I didn’t understand that change. Try “gym only on weekends”, “leetcode 45 min”, “project first”, “start at 8am”, “Sundays off”, “add reading 30 min daily” or “make it 2 weeks”.');
      }
    }
  }

  if (spec.days === 1) spec.sameEveryDay = true;
  if (spec.startDate && spec.days && !spec.title) spec.title = spec.days <= 1 ? `Plan for ${dayLabel(spec.startDate)}` : `${periodLabel(spec.startDate, spec.days)} plan`;
  if (spec.startDate && spec.days) spec.title = spec.days <= 1 ? `Plan for ${dayLabel(spec.startDate)}` : `${periodLabel(spec.startDate, spec.days)} plan`;

  const { suggestions, preview } = suggest(spec, ctx);
  let question: Question | null = null;
  let ready = false;
  if (!finalize) {
    question = nextQuestion(spec, asked);
    if (!question) {
      ready = true;
      if (!draft.ready && preview?.summary) {
        const s = preview.summary;
        said.push(s.days > 1
          ? `Here’s the plan: ${s.days} days, about ${fmtDuration(s.avgMinutesPerDay)} of tasks on a working day.${s.overloaded.length ? ` ${s.overloaded.length} day${s.overloaded.length > 1 ? 's are' : ' is'} too full — see the suggestion below.` : ' Everything fits.'}`
          : `Here’s your day.${s.overloaded.length ? ' Not everything fits — see the suggestion below.' : ' Everything fits.'}`);
      }
      question = CONFIRM;
    }
  }
  draft.pending = question;
  draft.asked = [...asked];
  draft.ready = ready || finalize;
  return { reply: said.join(' ') || 'Okay.', draft, question, suggestions: finalize ? [] : suggestions, ready: draft.ready, finalize, changes };
}

/** A program preview without the chat (for the API response). */
export function chatPreview(spec: ProgramSpec, ctx: ChatContext, from = 0, count = 14) {
  if (!spec.tasks.length || !spec.startDate || !spec.days) return null;
  return programPreview(spec, { from, count, meals: ctx.meals, firstDayStartMin: spec.startDate === ctx.today ? ctx.nowMin : undefined });
}
