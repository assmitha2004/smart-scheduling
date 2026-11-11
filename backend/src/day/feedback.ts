/**
 * "Tell me what to change": turns plain-language feedback on a proposed day
 * plan into edits of its tasks and settings, e.g.
 *
 *   "move leetcode to 9pm", "core takes 2 hours", "remove gym",
 *   "project first", "I'm busy 3-4", "I'm free 2 to 3", "start at 7",
 *   "nothing after 10pm", "more breaks", "shorter sessions", "too much today",
 *   "add read 30 mins", "leetcode tomorrow", "core is easy"
 *
 * Pure and deterministic. Every applied change is described in plain words,
 * and anything not understood is returned so the person can rephrase.
 */
import { fromMin, toMin, type Effort, type Peak } from './dayPlan.js';
import { findRanges, readTime, understandClause, type Commitment, type FreeWindow } from './understand.js';

export interface FeedbackTask {
  id?: string;
  title: string;
  minutes: number;
  minutesGuessed?: boolean;
  mustDo: boolean;
  top: boolean;
  effort: Effort;
  fixedTime: string | null;
  notBefore?: string | null;
  dueBy?: string | null;
  fromEarlier?: boolean;
}

export interface FeedbackSettings {
  dayStart: string;
  dayEnd: string;
  peak: Peak;
  commitments?: Commitment[];
  windows?: FreeWindow[];
  breaks?: 'SHORT' | 'NORMAL' | 'LONG';
  maxSession?: number;
}

export interface FeedbackResult {
  settings: FeedbackSettings;
  tasks: FeedbackTask[];
  /** Tasks taken out of the day: `tomorrow` = move to the next day, otherwise delete. */
  removed: { task: FeedbackTask; tomorrow: boolean }[];
  changes: string[];
  notUnderstood: string[];
}

const T = String.raw`(?:(noon|midday|midnight)|(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?)`;
const timeOf = (m: RegExpExecArray, at = 1): string | null => {
  const word = m[at]?.toLowerCase();
  if (word === 'noon' || word === 'midday') return '12:00';
  if (word === 'midnight') return '24:00';
  if (m[at + 1] === undefined) return null;
  return readTime(m[at + 1], m[at + 2], m[at + 3]);
};
const clock = (hm: string) => {
  const m = toMin(hm === '24:00' ? '23:59' : hm);
  const h = Math.floor(m / 60) % 24;
  const mm = m % 60;
  return `${h % 12 || 12}${mm ? `:${String(mm).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`;
};
const dur = (min: number) => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
};

const STOP = new Set(['a', 'an', 'the', 'my', 'some', 'to', 'do', 'study', 'studying', 'work', 'on', 'for', 'of', 'and', 'problems', 'problem', 'task', 'session', 'sessions', 'subject', 'subjects', 'finish', 'complete', 'learn', 'practice', 'revise', 'read', 'new']);
/** Meaningful words of a title, singular and lower-case: "Study my projects" -> ["project"]. */
export function keyWords(title: string): string[] {
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w));
}
/** True when two titles name the same thing ("Leetcode" vs "2 leetcode problems"). */
export function sameTask(a: string, b: string): boolean {
  const ka = keyWords(a);
  const kb = keyWords(b);
  if (!ka.length || !kb.length) return a.trim().toLowerCase() === b.trim().toLowerCase();
  const [small, big] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  return small.every((w) => big.includes(w));
}

/** The task a sentence talks about: the one whose key words appear in it (longest match wins). */
export function findTask(clause: string, tasks: FeedbackTask[]): FeedbackTask | null {
  const words = new Set(keyWords(clause));
  let best: { t: FeedbackTask; score: number } | null = null;
  for (const t of tasks) {
    const k = keyWords(t.title);
    if (!k.length) continue;
    const hits = k.filter((w) => words.has(w) || [...words].some((x) => x.length >= 4 && (x.startsWith(w) || w.startsWith(x)))).length;
    if (!hits) continue;
    const score = hits / k.length + hits * 0.01;
    if (!best || score > best.score) best = { t, score };
  }
  return best && best.score >= 0.5 ? best.t : null;
}

const PARTS: Record<string, [string, string]> = {
  morning: ['06:00', '12:00'], afternoon: ['12:00', '17:00'], evening: ['17:00', '22:00'], night: ['19:00', '24:00'], tonight: ['17:00', '24:00'],
};

/** Splits feedback into separate requests: sentences, "and also", "then". */
function requests(text: string): string[] {
  return text.replace(/\r/g, '')
    .split(/\n+|(?<!\d)[.!?;]+(?=\s|$)|(?<=\d)[.!?;]+(?=\s+[a-z]|\s*$)|\s*,\s*(?:and\s+)?|\s+(?:and also|and then|also|then)\s+|\s+and\s+(?=(?:move|put|make|remove|delete|drop|skip|add|start|end|finish|stop|give|shift|push|do|i'?m|i am|no|more|less|shorter|longer|nothing)\b)/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function applyFeedback(text: string, settingsIn: FeedbackSettings, tasksIn: FeedbackTask[], opts: { nowMin?: number } = {}): FeedbackResult {
  const settings: FeedbackSettings = { ...settingsIn, commitments: [...(settingsIn.commitments ?? [])], windows: [...(settingsIn.windows ?? [])] };
  let tasks = tasksIn.map((t) => ({ ...t }));
  const removed: FeedbackResult['removed'] = [];
  const changes: string[] = [];
  const notUnderstood: string[] = [];
  const afterWork = () => {
    const ends = (settings.commitments ?? []).filter((c) => c.title !== 'Meeting').map((c) => c.end).sort();
    return ends.length ? ends[ends.length - 1] : '17:30';
  };

  for (const req of requests(text)) {
    const r = req.toLowerCase();
    let handled = false;
    const say = (s: string) => { changes.push(s); handled = true; };

    // ----- whole-day requests -----
    if (/\b(too much|too packed|too full|overloaded|lighter day|less work|make it lighter|reduce|too many)\b/.test(r)) {
      // Move the least important tasks to tomorrow until about a quarter of the work is gone.
      const total = tasks.reduce((s, t) => s + t.minutes, 0);
      let cut = 0;
      const candidates = [...tasks].filter((t) => !t.top && !t.fixedTime).sort((a, b) => Number(a.mustDo) - Number(b.mustDo) || a.minutes - b.minutes);
      for (const t of candidates) {
        if (cut >= total * 0.25 || (t.mustDo && cut > 0)) break;
        if (t.mustDo && candidates.some((c) => !c.mustDo)) continue;
        tasks = tasks.filter((x) => x !== t);
        removed.push({ task: t, tomorrow: true });
        cut += t.minutes;
      }
      if (cut) say(`Lighter day: moved ${removed.filter((x) => x.tomorrow).map((x) => `“${x.task.title}”`).join(', ')} to tomorrow.`);
      else { say('Nothing optional left to move. Mark a task as not needed today or shorten one.'); }
      continue;
    }
    if (/\b(more|longer|bigger|extra)\s+breaks?\b/.test(r)) { settings.breaks = 'LONG'; say('Longer breaks between tasks.'); continue; }
    if (/\b(fewer|less|shorter|smaller|no|without)\s+breaks?\b/.test(r)) { settings.breaks = 'SHORT'; say('Shorter breaks between tasks.'); continue; }
    if (/\b(shorter|smaller)\s+(sessions?|blocks?|chunks?)\b|\bsplit (?:it|them|tasks|everything)\b|\bbreak (?:it|them|tasks) (?:up|down)\b/.test(r)) { settings.maxSession = 45; say('Sessions are now at most 45 minutes.'); continue; }
    if (/\b(longer|bigger)\s+(sessions?|blocks?|chunks?)\b|\bdon'?t split\b|\bno splitting\b/.test(r)) { settings.maxSession = 120; say('Sessions can now run up to 2 hours.'); continue; }
    const peak = /\b(?:focus|work|study|think|concentrate)\s+(?:best|better)\s+(?:in\s+the\s+|at\s+)?(morning|afternoon|evening|night)\b|\b(morning|afternoon|evening|night)\s+(?:person|is my best|works best)\b|\bhard (?:work|tasks?|stuff)\s+(?:in\s+the\s+|at\s+)?(morning|afternoon|evening|night)\b|\b(night owl|early bird)\b/.exec(r);
    if (peak) {
      const p = (peak[1] ?? peak[2] ?? peak[3] ?? peak[4]) as string;
      settings.peak = /morning|early/.test(p) ? 'MORNING' : /afternoon/.test(p) ? 'AFTERNOON' : 'EVENING';
      say(`Hard work moves to your best time: the ${settings.peak.toLowerCase()}.`);
      continue;
    }

    // ----- busy / free time -----
    const ranges = findRanges(req);
    if (ranges.length && /\b(busy|meeting|class|call|appointment|not free|can'?t|cannot|unavailable|out|away|block|lecture|commute|travel)\b/.test(r)) {
      const noun = /\b(meeting|class|call|appointment|lecture|commute|travel)\b/.exec(r)?.[1];
      for (const x of ranges) settings.commitments!.push({ title: noun ? noun[0].toUpperCase() + noun.slice(1) : 'Busy', start: x.start, end: x.end });
      say(`Kept ${ranges.map((x) => `${clock(x.start)}–${clock(x.end)}`).join(' and ')} free${noun ? ` for the ${noun}` : ''}.`);
      continue;
    }
    if (ranges.length && /\b(free|available|can (?:work|study|spend|do)|have time|spare)\b/.test(r)) {
      const light = /\b(light|easy|quick|small)\b/.test(r);
      for (const x of ranges) settings.windows!.push({ start: x.start, end: x.end, light });
      // A free gap before the day starts or after it ends widens the day.
      const s = Math.min(...ranges.map((x) => toMin(x.start)));
      const e = Math.max(...ranges.map((x) => toMin(x.end)));
      if (s < toMin(settings.dayStart)) settings.dayStart = fromMin(s);
      if (e > toMin(settings.dayEnd)) settings.dayEnd = fromMin(e);
      say(`You’re free ${ranges.map((x) => `${clock(x.start)}–${clock(x.end)}`).join(' and ')}; I’ll use that time${light ? ' for lighter work' : ''}.`);
      continue;
    }

    // ----- one task -----
    const add = /^(?:please\s+)?(?:add|also add|include|plus|put in|i also (?:need|have|want) to|i forgot)\s+(.+)$/i.exec(req);
    if (add) {
      const t = understandClause(add[1], { afterWork: afterWork() });
      if (t) {
        const existing = tasks.find((x) => x.title.toLowerCase() === t.title.toLowerCase());
        if (existing) { say(`“${existing.title}” is already in the plan.`); continue; }
        tasks.push({ ...t, notBefore: t.notBefore, dueBy: t.dueBy });
        say(`Added “${t.title}” (${dur(t.minutes)}${t.minutesGuessed ? ', estimated' : ''}).`);
        continue;
      }
    }

    const task = findTask(req, tasks);
    if (task) {
      if (/\b(remove|delete|drop|cancel|forget|not needed|don'?t need|no need|scrap)\b/.test(r)) {
        tasks = tasks.filter((x) => x !== task);
        removed.push({ task, tomorrow: false });
        say(`Removed “${task.title}”.`);
        continue;
      }
      if (/\b(tomorrow|another day|next day|later this week|postpone|not today|skip)\b/.test(r)) {
        tasks = tasks.filter((x) => x !== task);
        removed.push({ task, tomorrow: true });
        say(`Moved “${task.title}” to tomorrow.`);
        continue;
      }
      // Duration: "core takes 2 hours", "make leetcode 45 min", "project 1.5h".
      const d = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|mins?|minutes?)\b(?:\s*(?:and\s*)?(\d+)\s*(?:m|mins?|minutes?)\b)?|\b(half an hour|an hour|one hour)\b/i.exec(req);
      if (d) {
        const minutes = d[4] ? (/half/.test(d[4]) ? 30 : 60) : /^h/i.test(d[2]) ? Math.round(parseFloat(d[1]) * 60) + (d[3] ? +d[3] : 0) : Math.round(parseFloat(d[1]));
        if (minutes >= 5 && minutes <= 720) { task.minutes = minutes; task.minutesGuessed = false; say(`“${task.title}” now takes ${dur(minutes)}.`); }
      } else if (/\b(more time|longer|extra time|not enough time)\b/.test(r)) {
        task.minutes = Math.min(720, task.minutes + 30); task.minutesGuessed = false; say(`Gave “${task.title}” 30 more minutes (${dur(task.minutes)}).`);
      } else if (/\b(less time|shorter|quicker|too long)\b/.test(r)) {
        task.minutes = Math.max(15, Math.round((task.minutes * 0.66) / 5) * 5); task.minutesGuessed = false; say(`Shortened “${task.title}” to ${dur(task.minutes)}.`);
      }
      // When: "to 9pm", "at 9", "after 6", "before lunch", "in the evening", "after work".
      let m: RegExpExecArray | null;
      if ((m = new RegExp(String.raw`\b(?:at|to|@|around)\s+${T}`, 'i').exec(req)) && timeOf(m)) {
        const at = timeOf(m)!;
        task.fixedTime = at === '24:00' ? '23:45' : at; task.notBefore = null; task.dueBy = null;
        say(`“${task.title}” is set for ${clock(task.fixedTime)}.`);
      } else if ((m = new RegExp(String.raw`\b(?:after|from)\s+${T}`, 'i').exec(req)) && timeOf(m)) {
        task.fixedTime = null; task.notBefore = timeOf(m); say(`“${task.title}” starts after ${clock(task.notBefore!)}.`);
      } else if ((m = new RegExp(String.raw`\b(?:before|by|until)\s+${T}`, 'i').exec(req)) && timeOf(m)) {
        task.fixedTime = null; task.dueBy = timeOf(m); say(`“${task.title}” is done before ${clock(task.dueBy!)}.`);
      } else if ((m = /\bafter\s+(work|office|class(?:es)?|college|lunch|dinner|breakfast)\b/i.exec(req))) {
        const what = m[1].toLowerCase();
        task.fixedTime = null;
        task.notBefore = /lunch/.test(what) ? '14:00' : /dinner/.test(what) ? '21:00' : /breakfast/.test(what) ? '08:30' : afterWork();
        say(`“${task.title}” moves to after ${what} (${clock(task.notBefore)}).`);
      } else if ((m = /\bbefore\s+(lunch|dinner|work|breakfast)\b/i.exec(req))) {
        const what = m[1].toLowerCase();
        task.fixedTime = null;
        task.dueBy = /lunch/.test(what) ? '13:00' : /dinner/.test(what) ? '20:00' : /breakfast/.test(what) ? '08:00' : (settings.commitments?.[0]?.start ?? '09:00');
        say(`“${task.title}” is done before ${what}.`);
      } else if ((m = /\b(?:in\s+the\s+|this\s+|to\s+the\s+)?(morning|afternoon|evening)\b|\b(tonight)\b|\bat\s+(night)\b/i.exec(req)) && !/\bbest\b/.test(r)) {
        const part = (m[1] ?? m[2] ?? m[3]).toLowerCase();
        task.fixedTime = null; [task.notBefore, task.dueBy] = PARTS[part];
        say(`“${task.title}” moves to the ${part === 'tonight' ? 'evening' : part}.`);
      } else if (/\b(earlier|sooner|first thing)\b/.test(r) && !/\b(priority|important)\b/.test(r)) {
        task.fixedTime = null; task.notBefore = null; task.top = true; task.mustDo = true;
        for (const x of tasks) if (x !== task) x.top = false;
        say(`“${task.title}” goes as early as possible.`);
      } else if (/\b(later|last|end of the day|at the end)\b/.test(r)) {
        task.fixedTime = null; task.top = false; task.notBefore = fromMin(Math.max(toMin(settings.dayStart), toMin(settings.dayEnd) - task.minutes - 60));
        say(`“${task.title}” moves later in the day.`);
      }
      // Importance and effort.
      if (/\b(first|most important|top priority|main priority|number one|#1|priority)\b/.test(r) && !/\b(not|isn'?t|less)\b/.test(r)) {
        for (const x of tasks) x.top = x === task;
        task.mustDo = true;
        say(`“${task.title}” is now the top priority.`);
      } else if (/\b(must|important|urgent|need to finish|has to be done|can'?t miss)\b/.test(r) && !/\b(not|isn'?t)\b/.test(r)) {
        task.mustDo = true; say(`“${task.title}” is a must-do.`);
      } else if (/\b(optional|not (?:that )?important|not urgent|if (?:i have )?time|can wait|low priority)\b/.test(r)) {
        task.mustDo = false; task.top = false; say(`“${task.title}” is optional now.`);
      }
      if (/\b(easy|light|simple|quick|not hard)\b/.test(r) && !/\b(easy|light|simple|quick) (?:day|breaks?)\b/.test(r)) { task.effort = 'EASY'; say(`“${task.title}” is marked as light work.`); }
      else if (/\b(hard|difficult|deep focus|tough|complex|needs focus)\b/.test(r)) { task.effort = 'HARD'; say(`“${task.title}” is marked as deep focus.`); }
      if (handled) continue;
    }

    // ----- the day's hours -----
    let m: RegExpExecArray | null;
    if ((m = new RegExp(String.raw`\b(?:start|begin|wake up|get up)(?:\s+my\s+day|\s+working|\s+work)?\s+(?:at|from|around|after)\s+${T}`, 'i').exec(req)) && timeOf(m)) {
      const t = timeOf(m)!;
      settings.dayStart = /wake|get up/.test(r) ? fromMin(Math.min(1425, toMin(t) + 30)) : t;
      say(`Your day starts at ${clock(settings.dayStart)}.`);
      continue;
    }
    if (/\bstart (?:a bit |an hour )?later\b/.test(r)) { settings.dayStart = fromMin(Math.min(toMin(settings.dayEnd) - 60, toMin(settings.dayStart) + 60)); say(`Starting an hour later, at ${clock(settings.dayStart)}.`); continue; }
    if ((m = new RegExp(String.raw`\b(?:sleep|go to bed|bed)\s+(?:at|by|around)\s+${T}`, 'i').exec(req)) && timeOf(m)) {
      const t = timeOf(m)!;
      const late = toMin(t) <= 360 ? 1440 : Math.max(0, toMin(t) - 30);
      settings.dayEnd = fromMin(late);
      say(`Nothing planned after ${clock(settings.dayEnd)}, so you can wind down before bed.`);
      continue;
    }
    if ((m = new RegExp(String.raw`\b(?:end|finish|stop|wrap up|done|nothing|no (?:work|tasks?|study))(?:\s+my\s+day|\s+working|\s+work)?\s+(?:at|by|after|before|around)\s+${T}`, 'i').exec(req)) && timeOf(m)) {
      let t = timeOf(m)!;
      if (toMin(t) <= toMin(settings.dayStart) && toMin(t) < 720) t = fromMin(toMin(t) + 720);
      settings.dayEnd = t;
      say(`Nothing planned after ${clock(t)}.`);
      continue;
    }
    if (/\b(finish|end|stop) (?:a bit |an hour )?earlier\b/.test(r)) { settings.dayEnd = fromMin(Math.max(toMin(settings.dayStart) + 60, toMin(settings.dayEnd) - 60)); say(`Finishing an hour earlier, at ${clock(settings.dayEnd)}.`); continue; }

    if (!handled) notUnderstood.push(req);
  }
  // Keep the day's window sane.
  if (toMin(settings.dayEnd) - toMin(settings.dayStart) < 30) settings.dayEnd = fromMin(Math.min(1440, toMin(settings.dayStart) + 60));
  if (opts.nowMin !== undefined && toMin(settings.dayStart) < opts.nowMin) settings.dayStart = fromMin(Math.ceil(opts.nowMin / 5) * 5);
  return { settings, tasks, removed, changes, notUnderstood };
}
