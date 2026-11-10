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

export interface Understanding {
  date: 'today' | 'tomorrow';
  settings: { dayStart?: string; dayEnd?: string; peak?: Peak };
  tasks: UnderstoodTask[];
  notes: string[];
}

// ---------- time words ----------

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
      return out;
    })
    .map((c) => c.trim().replace(/^(?:(?:and|then|also|plus|after that|afterwards)\s+)+/i, ''))
    .filter(Boolean);
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

export function understandClause(raw: string): UnderstoodTask | null {
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
  if ((m = /\b(?:after|post)\s+(work|class(?:es)?|college|school|office|uni(?:versity)?)\b/i.exec(text))) { notBefore = '17:30'; text = stripPhrase(text, m); }
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
  text = text.replace(/^(?:a|an|the|my)\s+(?=\S)/i, '').replace(/[\s,;:-]+$/, '');
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
  const out: Understanding = { date: 'today', settings: {}, tasks: [], notes: [] };
  readSettings(text, out);
  const seen = new Set<string>();
  for (const clause of splitClauses(text)) {
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
    const t = understandClause(clause);
    if (!t) continue;
    const key = t.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.tasks.push(t);
    if (out.tasks.length >= 30) break;
  }
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
