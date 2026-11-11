/**
 * Understands a plain-language description of someone's day, e.g.
 *
 *   "I wake up at 8. Exam tomorrow so I must revise maths for 2 hours, that's
 *    the most important. Gym after work, call mom at 7pm, and maybe groceries
 *    if I have time. I focus best in the morning."
 *
 * and turns it into tasks (title, duration, must-do, #1 priority, effort,
 * set time, "after"/"before" windows) plus day settings (start, end, peak
 * energy, today or tomorrow). Rule-based and deterministic, so it works with
 * no AI provider; when Claude is enabled the AI service does the same job and
 * this is the fallback.
 */
import { fromMin, parseTaskLine, toMin, type Effort, type Peak } from './dayPlan.js';

export interface UnderstoodTask {
  title: string;
  minutes: number;
  minutesGuessed: boolean;
  mustDo: boolean;
  top: boolean;
  effort: Effort;
  fixedTime: string | null;
  notBefore: string | null;
  dueBy: string | null;
}

/** A fixed commitment such as "work 9 to 6:30" or "class 10-12" (local HH:mm). */
export interface Commitment { title: string; start: string; end: string }
/** Free time the person named, e.g. "I can study 11:30-1 and 3-5 in between work". */
export interface FreeWindow { start: string; end: string; light: boolean }

export interface Understanding {
  date: 'today' | 'tomorrow';
  settings: { dayStart?: string; dayEnd?: string; peak?: Peak };
  tasks: UnderstoodTask[];
  /** Fixed commitments: never scheduled over, except inside the free windows. */
  commitments: Commitment[];
  windows: FreeWindow[];
  notes: string[];
}

// ---------- time words ----------
const clockText = (hm: string) => {
  const m = toMin(hm);
  const h = Math.floor(m / 60) % 24;
  const mm = m % 60;
  return `${h % 12 || 12}${mm ? `:${String(mm).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
};

/**
 * "7", "7pm", "7:30 am", "19:00" → HH:mm. Without am/pm: `morning` reads the
 * hour as written (wake-up times), `late` reads 7-11 as evening (bedtime,
 * "until 9"), and `auto` reads 1-6 as afternoon ("call at 3").
 */
export type TimeMode = 'morning' | 'late' | 'auto';
export function readTime(h: string, m: string | undefined, ampm: string | undefined, mode: TimeMode = 'auto'): string | null {
  let hour = Number(h);
  const min = m ? Number(m) : 0;
  if (min > 59) return null;
  const mer = ampm?.replace(/\./g, '').toLowerCase();
  if (mer) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (mer === 'pm' ? 12 : 0);
  } else {
    if (hour > 24) return null;
    if (hour === 24) return '24:00';
    if (mode !== 'morning' && hour >= 1 && hour <= 6) hour += 12;
    else if (mode === 'late' && hour >= 7 && hour <= 11) hour += 12;
  }
  return fromMin(hour * 60 + min);
}

const timeIn = (text: string, re: RegExp, mode: TimeMode = 'auto'): { time: string; match: RegExpExecArray } | null => {
  const m = re.exec(text);
  if (!m) return null;
  const word = m.groups?.word?.toLowerCase();
  if (word === 'noon' || word === 'midday') return { time: '12:00', match: m };
  if (word === 'midnight') return { time: '24:00', match: m };
  const time = readTime(m.groups!.h, m.groups!.m, m.groups!.ap, mode);
  return time ? { time, match: m } : null;
};
const T = String.raw`(?:(?<word>noon|midday|midnight)|(?<h>\d{1,2})(?::(?<m>\d{2}))?\s*(?<ap>am|pm|a\.m\.|p\.m\.)?)`;

// ---------- time ranges: "9 to 6:30", "11:30-1:00", "3-5pm", "10am – 12" ----------
const P = String.raw`(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?`;
export const RANGE_RE = new RegExp(String.raw`(?:\bfrom\s+|\bbetween\s+)?\b${P}\s*(?:-|–|—|to|till|until)\s*${P}(?!\s*(?:h|hr|hrs|hours?|m|mins?|minutes?)\b)`, 'gi');

/**
 * Reads a time range the way people say it: "9 to 6:30" is 9am-6:30pm,
 * "11:30-1" is 11:30am-1pm, "3-5" is 3pm-5pm, "3-5pm" too.
 */
export function readRange(h1: string, m1: string | undefined, a1: string | undefined, h2: string, m2: string | undefined, a2: string | undefined): [string, string] | null {
  const mer = (a?: string) => a?.replace(/\./g, '').toLowerCase() as 'am' | 'pm' | undefined;
  let ap1 = mer(a1);
  const ap2 = mer(a2);
  const H1 = Number(h1);
  const H2 = Number(h2);
  if (H1 > 24 || H2 > 24 || Number(m1 ?? 0) > 59 || Number(m2 ?? 0) > 59) return null;
  // "3-5pm": the first time shares the second's am/pm when that keeps it earlier.
  if (!ap1 && ap2 && H1 <= 12 && (H1 % 12) <= (H2 % 12)) ap1 = ap2;
  const start = readTime(h1, m1, ap1, ap1 ? 'auto' : H1 >= 7 && H1 <= 11 ? 'morning' : 'auto');
  if (!start) return null;
  let endMin: number;
  if (ap2) {
    const e = readTime(h2, m2, ap2);
    if (!e) return null;
    endMin = toMin(e);
  } else {
    endMin = H2 * 60 + Number(m2 ?? 0);
    while (endMin <= toMin(start) && endMin < 24 * 60) endMin += 12 * 60;
  }
  if (endMin > 24 * 60) endMin = 24 * 60;
  if (endMin - toMin(start) < 10 || endMin - toMin(start) > 16 * 60) return null;
  return [start, fromMin(endMin)];
}

/** All time ranges in a piece of text, with where they are. */
export function findRanges(text: string): { start: string; end: string; index: number; length: number }[] {
  const out: { start: string; end: string; index: number; length: number }[] = [];
  // "between 2 and 4" reads like "2 to 4" (same length, so indexes still line up).
  const norm = text.replace(/\b(between\s+\S+\s+)and(?=\s)/gi, '$1to ');
  for (const m of norm.matchAll(RANGE_RE)) {
    const r = readRange(m[1], m[2], m[3], m[4], m[5], m[6]);
    if (r) out.push({ start: r[0], end: r[1], index: m.index!, length: m[0].length });
  }
  return out;
}

const COMMITMENT_RE = /\b(work|office|job|shift|duty|internship|class(?:es)?|college|school|lecture|lab|tuition|coaching|meeting|exam|commute|travel(?:ling)?)\b/i;
const FREE_RE = /\b(free|available|can (?:spend|use|study|work|do|fit)|i have time|have some time|get time|in ?between|gap|breaks? (?:from|between)|spare)\b/i;

/** "Work 9 to 6:30" -> commitment; "I can spend 11:30-1 and 3-5 in between for light study" -> free windows. */
export function readCommitments(sentence: string): { commitments: Commitment[]; windows: FreeWindow[]; consumed: boolean; rest: string } {
  const ranges = findRanges(sentence);
  if (!ranges.length) return { commitments: [], windows: [], consumed: false, rest: sentence };
  if (FREE_RE.test(sentence)) {
    const light = /\b(light|easy|quick|small|short|revision|revise)\b/i.test(sentence);
    return { commitments: [], windows: ranges.map((r) => ({ start: r.start, end: r.end, light })), consumed: true, rest: '' };
  }
  const noun = COMMITMENT_RE.exec(sentence);
  if (!noun) return { commitments: [], windows: [], consumed: false, rest: sentence };
  const word = noun[1].toLowerCase();
  const title = /^class/.test(word) ? 'Classes' : word[0].toUpperCase() + word.slice(1);
  // Remove "work 9 to 6:30 (today)" and keep anything else in the sentence for tasks.
  let rest = sentence;
  for (const r of [...ranges].reverse()) rest = rest.slice(0, r.index) + ' ' + rest.slice(r.index + r.length);
  rest = rest.replace(new RegExp(String.raw`\b(?:i\s+(?:have|am at|'m at|go to)\s+)?(?:my\s+)?${noun[1]}\b`, 'i'), ' ').replace(/\b(today|tomorrow|tonight)\b/gi, ' ').replace(/\s{2,}/g, ' ').trim();
  if (/^(?:i|and|then|from|at|is|are|have|has)?\W*$/i.test(rest)) rest = '';
  return { commitments: ranges.map((r) => ({ title, start: r.start, end: r.end })), windows: [], consumed: !rest, rest };
}

const MEAL_TIMES: Record<string, string> = { breakfast: '08:30', lunch: '14:00', dinner: '21:00' };
const MEAL_BEFORE: Record<string, string> = { breakfast: '08:00', lunch: '13:00', dinner: '20:00' };
const PARTS: Record<string, [string, string]> = {
  morning: ['06:00', '12:00'],
  afternoon: ['12:00', '17:00'],
  evening: ['17:00', '22:00'],
  night: ['19:00', '24:00'],
  tonight: ['17:00', '24:00'],
};

// ---------- splitting ----------
const VERBS = 'finish|complete|do|study|revise|review|read|write|work|prepare|practice|practise|reply|answer|email|buy|clean|cook|go|gym|call|phone|text|meet|attend|submit|send|pay|wash|walk|run|exercise|plan|update|fix|build|code|solve|learn|watch|start|make|take|pick|drop|visit|book|order|apply|edit|record|draw|design|test|deploy|organise|organize|tidy|pack|meditate|journal|leetcode|grocery|groceries|laundry|shower|nap|play|practice';
const AND_SPLIT = new RegExp(String.raw`\s+(?:and\s+then|and|then|also|plus|after that|afterwards)\s+(?=(?:i\s+(?:need|have|want|must|should|will|gotta)\s+to\s+|i(?:'ll| will)?\s+|maybe\s+|also\s+|to\s+)?(?:${VERBS})\b)`, 'i');

const NOUNS = 'assignments?|projects?|reports?|homework|essays?|presentations?|slides|labs?|exams?|revision|notes|laundry|groceries|grocery|shopping|leetcode|dsa|emails?|mails|gym|workout|dishes|cooking|cleaning|reading|coding|interview|meeting|class|lecture|resume|portfolio|thesis|research|practice|tasks?|work';
const NOUN_AND = new RegExp(String.raw`\s+(?:and|&)\s+(?=(?:(?:my|the|a|an|some|that)\s+)?(?:[\w-]+\s+){0,2}(?:${NOUNS})\b)`, 'i');

export function splitClauses(text: string): string[] {
  return text
    .replace(/\r/g, '')
    // "I have so many things: a, b, c" / "my tasks today are a, b" -> just the list
    .replace(/(^|[.!?\n]\s*)(?:i\s+(?:have|'ve got|have got|got)\s+)?(?:so\s+)?(?:many|a lot of|lots of|a bunch of|tons of|some|these|the following|few)?\s*(?:things|tasks|work|stuff|jobs|items)(?:\s+(?:to do|today|tomorrow|pending|left))*\s*(?::|-|are|is|like)\s*/gi, '$1')
    .replace(/(^|[.!?\n]\s*)my\s+(?:tasks|to-?do(?:\s+list)?|work|plan)\s+(?:for\s+)?(?:today|tomorrow)?\s*(?:is|are|:)\s*/gi, '$1')
    .split(/\n+|[.!?;]+(?=\s|$)|\s*,\s*(?:and\s+)?/)
    .flatMap((c) => {
      const out: string[] = [];
      let rest = c;
      for (let guard = 0; guard < 10; guard++) {
        const a = AND_SPLIT.exec(rest);
        const b = NOUN_AND.exec(rest);
        const m = a && b ? (a.index <= b.index ? a : b) : a ?? b;
        if (!m) break;
        out.push(rest.slice(0, m.index));
        rest = rest.slice(m.index + m[0].length);
      }
      out.push(rest);
      return out.flatMap(splitRunOn);
    })
    .map((c) => c.trim().replace(/^(?:(?:and|then|also|plus|after that|afterwards)\s+)+/i, ''))
    .filter((c) => c && !ONLY_FILLER.test(c));
}

/** Words that start a new task in a run-on list: "study X do Y study Z". */
const RUN_VERBS = 'study|learn|revise|practice|practise|do|finish|complete|solve|read|write|prepare|watch|review';
const RUN_SPLIT = new RegExp(String.raw`\s+(?=(?:${RUN_VERBS})\s+\S)`, 'i');
/** A piece with no task in it: "I need to", "study", "and then". */
const FILLER_WORDS = String.raw`i|i'll|i will|need|needs|have|has|got|want|must|should|gotta|to|and|then|also|after|that|so|plus|maybe|today|tomorrow|tonight|now|first|please|ok|okay|so|this week|this month|every ?day|daily`;
const ONLY_FILLER = new RegExp(String.raw`^(?:(?:${FILLER_WORDS})\s*)+$`, 'i');
const FILLER_OR_VERB = new RegExp(String.raw`^(?:(?:${FILLER_WORDS}|${RUN_VERBS})\s*)+$`, 'i');
const STUDY_START = new RegExp(String.raw`^(?:${RUN_VERBS}|work on)\b`, 'i');

/**
 * Splits "I need to study Do 2 leetcode problems study some new technology"
 * into "Do 2 leetcode problems" and "study some new technology", and
 * "study my project and some core" into "study my project" and "some core".
 */
function splitRunOn(clause: string): string[] {
  const parts: string[] = [];
  const pieces = clause.split(RUN_SPLIT).map((x) => x.trim()).filter(Boolean);
  for (const [i, p] of pieces.entries()) {
    // A bare verb ("study") or filler ("I need to") belongs to what follows.
    if (i < pieces.length - 1 && FILLER_OR_VERB.test(p)) continue;
    // "study my project and some core": after a study verb, "and some/my X" is another subject.
    const m = STUDY_START.test(p) ? /\s+(?:and|&)\s+(?=(?:some|my|the|a\s+bit\s+of)\s+\w)/i.exec(p) : null;
    // The second subject keeps the verb: "study my project and some core" -> "study core".
    if (m) parts.push(p.slice(0, m.index), `${p.split(/\s+/)[0]} ${p.slice(m.index + m[0].length)}`);
    else parts.push(p);
  }
  return parts.length ? parts : [clause];
}

// ---------- settings ----------
function readSettings(text: string, out: Understanding) {
  const lower = text.toLowerCase();
  const wake = timeIn(lower, new RegExp(String.raw`\b(?<kind>wake(?:\s+up)?|get\s+up|start(?:\s+my\s+day)?|begin(?:\s+my\s+day)?|free\s+from|available\s+from|my\s+day\s+starts)\s+(?:at\s+|around\s+|by\s+)?${T}`, 'i'), 'morning');
  if (wake) {
    const woke = /wake|get/.test(wake.match.groups!.kind);
    // After waking up, give 30 minutes to get going.
    out.settings.dayStart = fromMin(Math.min(toMin(wake.time) + (woke ? 30 : 0), 1425));
  }
  const end = timeIn(lower, new RegExp(String.raw`\b(?:sleep|go\s+to\s+bed|bed(?:time)?|stop(?:\s+working)?|wrap\s+up|end\s+my\s+day|free\s+until|available\s+until|my\s+day\s+ends)\s+(?:at\s+|around\s+|by\s+)?${T}`, 'i'), 'late');
  if (end) {
    const sleep = /sleep|bed/.test(end.match[0]);
    const m = end.time === '24:00' ? 1440 : toMin(end.time);
    const value = sleep ? (m <= 6 * 60 ? 1440 : Math.max(0, m - 30)) : m;
    out.settings.dayEnd = fromMin(Math.min(value, 1440));
  }
  if (/\b(morning person|early bird|(?:focus|think|work|study)(?:ed)?\s+best\s+(?:in\s+the\s+)?morning|sharp(?:est)?\s+in\s+the\s+morning|mornings? (?:are|is) (?:my )?best)\b/.test(lower)) out.settings.peak = 'MORNING';
  else if (/\b(night owl|(?:focus|think|work|study)(?:ed)?\s+best\s+(?:at\s+night|in\s+the\s+evening|late)|evenings? (?:are|is) (?:my )?best)\b/.test(lower)) out.settings.peak = 'EVENING';
  else if (/\b((?:focus|think|work|study)(?:ed)?\s+best\s+(?:in\s+the\s+)?afternoon)\b/.test(lower)) out.settings.peak = 'AFTERNOON';
  if (/\btomorrow\b/.test(lower) && !/\btoday\b/.test(lower) && !/\b(exam|test|deadline|due|submission|interview|presentation)\b[^.]*\btomorrow\b/.test(lower)) out.date = 'tomorrow';
}

const SETTINGS_ONLY = /^(?:i\s+)?(?:usually\s+)?(?:wake(?:\s+up)?|get\s+up|sleep|go\s+to\s+bed|i'?m\s+(?:a\s+)?(?:morning person|night owl|early bird)|(?:i\s+)?(?:focus|work|study|think)\s+best|i'?m\s+free|i\s+am\s+free|free\s+(?:from|until)|available|my\s+day\s+(?:starts|ends)|start\s+my\s+day|end\s+my\s+day)\b/i;

// ---------- one clause → one task ----------
const FILLER_START = /^(?:(?:and|then|also|plus|so|but|after that|afterwards|finally|oh|ok|okay|today|tomorrow|tonight|i|i'll|i will|i'd like to|i would like to|i need to|i have to|i want to|i must|i should|i gotta|i've got to|i've got|i have got|i have|i've|i got|there'?s|there is|there are|need to|have to|want to|must|should|gotta|got to|have|let me|please|try to|maybe|probably|also need to|then i|and i|i also|to|do|work on)\s+)+/i;
const FILLER_END = /\s+(?:too|as well|also|today|tomorrow|tonight|please|if possible|if i (?:have|get|can find) (?:the )?time|if there'?s time|if time permits|if i can|at some point|sometime)\s*$/i;

function stripPhrase(text: string, m: RegExpExecArray | null): string {
  return m ? (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/\s{2,}/g, ' ').trim() : text;
}

export function understandClause(raw: string, opts: { afterWork?: string } = {}): UnderstoodTask | null {
  let text = raw.trim();
  const lower = text.toLowerCase();
  if (!text || SETTINGS_ONLY.test(text)) return null;
  if (/^(?:i\s+(?:have|got)\s+(?:a\s+)?(?:lot|bunch|many things)|that'?s\s+(?:it|all)|thanks|thank you|help me|plan my day|please plan|my day)\b/i.test(text)) return null;
  // Feelings and requests, not tasks: "I don't know how to organise it", "no idea where to start".
  if (/\b(?:(?:don'?t|do not|dont)\s+know|no idea|not sure|confused|overwhelmed|stressed|organi[sz]e (?:it|them|this|my)|where to start|what to do first|how to (?:plan|organi[sz]e|manage|schedule)|help me|can you|please (?:plan|help|organi[sz]e|schedule)|plan (?:it|this|my day)|sort (?:it|this) out)\b/i.test(text)
      && !/\b\d+\s*(?:h|hr|hrs|hours?|m|mins?|minutes?)\b/i.test(text)) return null;

  const top = /\b(most important|top priority|(?:my\s+)?(?:main|biggest|#?1|number one|first)\s+(?:priority|thing|task)|priority\s*(?:#|no\.?|number)?\s*1|before anything else|first thing)\b/i.test(lower);
  const optional = /\b(maybe|if (?:i (?:have|get|can find) (?:the )?)?time|if there'?s time|if possible|optional|if i can|not urgent|nice to have|could)\b/i.test(lower);
  const mustDo = !optional && (top || /\b(must|have to|need to|needs to|gotta|got to|important|urgent|asap|deadline|due|submit|exam|test|interview|can'?t miss|cannot miss|definitely|no matter what)\b/i.test(lower));

  let notBefore: string | null = null;
  let dueBy: string | null = null;
  let m: RegExpExecArray | null;
  if ((m = /\b(?:after|post)\s+(breakfast|lunch|dinner)\b/i.exec(text))) { notBefore = MEAL_TIMES[m[1].toLowerCase()]; text = stripPhrase(text, m); }
  if ((m = /\bbefore\s+(breakfast|lunch|dinner)\b/i.exec(text))) { dueBy = MEAL_BEFORE[m[1].toLowerCase()]; text = stripPhrase(text, m); }
  if ((m = /\b(?:after|post)\s+(work|class(?:es)?|college|school|office|uni(?:versity)?)\b/i.exec(text))) { notBefore = opts.afterWork ?? '17:30'; text = stripPhrase(text, m); }
  if ((m = /\b(?:in\s+the\s+|this\s+)?(morning|afternoon|evening)\b|\b(tonight)\b|\bat\s+(night)\b/i.exec(text))) {
    const part = (m[1] ?? m[2] ?? m[3]).toLowerCase();
    [notBefore, dueBy] = [notBefore ?? PARTS[part][0], dueBy ?? PARTS[part][1]];
    text = stripPhrase(text, m);
  }
  const by = timeIn(text, new RegExp(String.raw`\b(?:by|before|until|till|no later than)\s+${T}`, 'i'));
  if (by) { dueBy = by.time; text = stripPhrase(text, by.match); }
  const after = timeIn(text, new RegExp(String.raw`\b(?:after|from)\s+${T}(?!\s*(?:-|to)\s*\d)`, 'i'));
  if (after) { notBefore = after.time; text = stripPhrase(text, after.match); }
  let fixedTime: string | null = null;
  const at = timeIn(text, new RegExp(String.raw`\b(?:at|@|around)\s+${T}`, 'i'));
  if (at) { fixedTime = at.time === '24:00' ? '23:45' : at.time; text = stripPhrase(text, at.match); }

  // Remove priority words, filler and trailing qualifiers from the title.
  text = text
    .replace(/\b(?:(?:is|are|it'?s|it is|this is|that'?s|that is|which is)\s+)?(?:(?:the|my)\s+)?(?:most important(?: thing| task)?|top priority|main priority|(?:main|biggest|first|#?1|number one) (?:thing|task|priority)|first thing|before anything else|asap|urgent(?:ly)?|no matter what|definitely|if possible|if i can|optional|not urgent)\b/gi, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  for (let i = 0; i < 3; i++) text = text.replace(FILLER_START, '').replace(FILLER_END, '').trim();
  text = text.replace(/^(?:(?:a|an|the|my|some|a bit of)\s+)+(?=\S)/i, '').replace(/^(\w+)\s+(?:some|a bit of)\s+/i, '$1 ').replace(/[\s,;:-]+$/, '');
  if (text.length < 2) return null;

  const parsed = parseTaskLine(text);
  if (!parsed) return null;
  if (parsed.fixedTime && !fixedTime) fixedTime = parsed.fixedTime;
  let { minutes, effort, minutesGuessed } = parsed;
  if (/\b(quick(?:ly)?|small|short|briefly|5 ?min)\b/i.test(lower) && minutesGuessed) { minutes = Math.min(minutes, 15); effort = 'EASY'; }
  if (/\b(hard|difficult|tough|deep work|focus(?:ed)? work|complex|challenging)\b/i.test(lower)) effort = 'HARD';
  if (/\b(easy|simple|light|chill)\b/i.test(lower)) effort = 'EASY';
  const title = parsed.title.replace(/\b(?:quick(?:ly)?|hard|difficult|tough)\s+/i, '').replace(/^\w/, (c) => c.toUpperCase());
  if (dueBy && notBefore && toMin(dueBy === '24:00' ? '23:59' : dueBy) - toMin(notBefore) < minutes) notBefore = null;
  return { title, minutes, minutesGuessed, mustDo, top, effort, fixedTime, notBefore, dueBy };
}

export function understandDay(text: string): Understanding {
  const out: Understanding = { date: 'today', settings: {}, tasks: [], commitments: [], windows: [], notes: [] };
  readSettings(text, out);
  const seen = new Set<string>();

  // Sentence by sentence: fixed commitments and free time first, then tasks.
  const sentences = text.replace(/\r/g, '').split(/\n+|(?<!\d)[.!?;]+(?=\s|$)|(?<=\d)[.!?;]+(?=\s+[A-Za-z]|\s*$)/).map((x) => x.trim()).filter(Boolean);
  const taskText: { sentence: string; notBefore: string | null; dueBy: string | null; context: 'work' | null }[] = [];
  for (const sentence of sentences) {
    const c = readCommitments(sentence);
    out.commitments.push(...c.commitments);
    out.windows.push(...c.windows);
    if (c.consumed || !c.rest) continue;
    // "After work I need to ...": the time applies to every task in the sentence.
    let rest = c.rest;
    let notBefore: string | null = null;
    let dueBy: string | null = null;
    let context: 'work' | null = null;
    const lead = /^(?:and\s+|then\s+|also\s+)?(?:(after|post)\s+(work|office|class(?:es)?|college|school|lunch|dinner|breakfast)|(?:in\s+the\s+|this\s+)?(morning|afternoon|evening)|(tonight)|at\s+(night))\b[,\s]*/i.exec(rest);
    if (lead) {
      const what = (lead[2] ?? '').toLowerCase();
      if (/work|office|class|college|school/.test(what)) context = 'work';
      else if (what) notBefore = MEAL_TIMES[what];
      else {
        const part = (lead[3] ?? lead[4] ?? lead[5]).toLowerCase();
        [notBefore, dueBy] = PARTS[part];
      }
      rest = rest.slice(lead[0].length);
    }
    taskText.push({ sentence: rest, notBefore, dueBy, context });
  }
  // "after work" = when the last work-like commitment ends.
  const workEnds = out.commitments.filter((x) => x.title !== 'Meeting').map((x) => x.end).sort();
  const afterWork = workEnds.length ? workEnds[workEnds.length - 1] : undefined;

  for (const part of taskText) {
    for (const clause of splitClauses(part.sentence)) {
      // "that's the most important", "it's urgent", "it's hard": describes the previous task.
      const remark = /^(?:that|it|this|which)(?:'s|\s+is|\s+was|\s+will\s+be)?\b/i.test(clause)
        || /^(?:(?:very|super|really|pretty)\s+)?(?:quick(?:ly)?|easy|simple|small|short|hard|difficult|tough|urgent(?:ly)?|important|asap|optional|if possible|if i (?:have|get) (?:the )?time|maybe|not urgent|top priority|most important)(?:\s+one)?$/i.test(clause.trim());
      if (remark && out.tasks.length) {
        const prev = out.tasks[out.tasks.length - 1];
        const c = clause.toLowerCase();
        if (/\b(most important|top priority|main|biggest|first|number one|#1)\b/.test(c)) { prev.top = true; prev.mustDo = true; }
        else if (/\b(important|urgent|must|asap|due|deadline)\b/.test(c)) prev.mustDo = true;
        if (/\b(optional|not urgent|can wait|if (?:i have )?time)\b/.test(c)) { prev.mustDo = false; prev.top = false; }
        if (/\b(hard|difficult|tough|complex|deep)\b/.test(c)) prev.effort = 'HARD';
        if (/\b(easy|quick|simple|small|short)\b/.test(c)) {
          prev.effort = 'EASY';
          if (/\b(quick|small|short)\b/.test(c) && prev.minutesGuessed) prev.minutes = Math.min(prev.minutes, 15);
        }
        continue;
      }
      const t = understandClause(clause, { afterWork });
      if (!t) continue;
      if (!t.fixedTime) {
        // With free time named inside work hours, those gaps are fair game too.
        if (part.context === 'work' && !t.notBefore && !out.windows.length) t.notBefore = afterWork ?? '17:30';
        if (part.notBefore && !t.notBefore) t.notBefore = part.notBefore;
        if (part.dueBy && !t.dueBy) t.dueBy = part.dueBy;
      }
      const key = t.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.tasks.push(t);
      if (out.tasks.length >= 30) break;
    }
  }
  if (out.commitments.length) out.notes.push(`I kept ${out.commitments.map((x) => `${x.title.toLowerCase()} (${clockText(x.start)}–${clockText(x.end)})`).join(', ')} free of tasks.`);
  if (out.windows.length) out.notes.push(`I used your free time ${out.windows.map((w) => `${clockText(w.start)}–${clockText(w.end)}`).join(' and ')}${out.windows.some((w) => w.light) ? ' for lighter work' : ''}.`);
  // Only one #1 priority: the first one mentioned.
  let topSeen = false;
  for (const t of out.tasks) {
    if (t.top && topSeen) t.top = false;
    topSeen ||= t.top;
  }
  const guessed = out.tasks.filter((t) => t.minutesGuessed);
  if (guessed.length) out.notes.push(`I estimated how long ${guessed.length === 1 ? `“${guessed[0].title}”` : `${guessed.length} tasks`} will take. Tap a task to change it.`);
  if (out.date === 'tomorrow') out.notes.push('You mentioned tomorrow, so I’m planning tomorrow.');
  if (!out.tasks.some((t) => t.top) && out.tasks.length > 1) out.notes.push('Tip: say which task matters most (“X is the most important”) and I’ll give it your best time.');
  return out;
}
