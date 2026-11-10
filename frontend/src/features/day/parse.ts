import type { Priority } from '../../types';

export type Due = 'TODAY' | 'TOMORROW' | 'WEEK' | 'NONE';

/** One answer card in the "plan my day" questions. */
export interface DraftTask {
  key: string;
  /** Set when the card edits an existing open task. */
  id?: string;
  title: string;
  minutes: number;
  /** True when the time was guessed rather than typed by the user. */
  guessed: boolean;
  priority: Priority;
  due: Due;
  /** Not before this local time today, "HH:mm". */
  startAfter: string | null;
  carried?: boolean;
}

const FOCUS = /\b(study|studies|learn|revise|revision|write|writing|code|coding|program|project|assignment|prepare|prep|research|design|build|read|reading|practice|leetcode|dsa|report|thesis|homework|exam|paper|develop|debug|analy[sz]e|analysis|presentation|slides|draft|course|lecture|notes)\b/i;
const QUICK = /\b(call|mail|email|e-mail|reply|message|text|whatsapp|pay|buy|order|book|bill|recharge|clean|wash|laundry|cook|grocer\w*|shop\w*|meet|visit|pick up|drop|send|post|print|walk|gym|workout)\b/i;
const URGENT = /\b(urgent|asap|important|must|deadline|submit|due)\b/i;

let seq = 0;
export const newKey = () => `d${Date.now().toString(36)}${(seq++).toString(36)}`;

const pad = (n: number) => String(n).padStart(2, '0');

/** A sensible guess when the user gave no time: focus work ~1h, quick chores ~20m. */
export function guessMinutes(title: string): number {
  if (QUICK.test(title)) return 20;
  if (FOCUS.test(title)) return 60;
  return 30;
}

/**
 * Reads one line of a brain dump, e.g. "revise DBMS 2h", "call bank at 4pm",
 * "submit report tomorrow urgent". Anything not understood stays in the title.
 */
export function parseLine(line: string): DraftTask | null {
  let s = line.trim().replace(/^([-*•]|\d+[.)])\s*/, '').trim();
  if (!s) return null;
  let minutes: number | null = null;
  let startAfter: string | null = null;

  const dm = s.match(/(\d+(?:\.\d+)?)\s*(hours|hour|hrs|hr|h|minutes|minute|mins|min|m)\b/i);
  if (dm) {
    const n = parseFloat(dm[1]);
    minutes = /^h/i.test(dm[2]) ? Math.round(n * 60) : Math.round(n);
    s = s.replace(dm[0], ' ');
  } else if (/\bhalf an hour\b/i.test(s)) {
    minutes = 30;
    s = s.replace(/\bhalf an hour\b/i, ' ');
  }

  const tm = s.match(/(?:\bat\b|@)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/i) ?? s.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i);
  if (tm) {
    let h = Number(tm[1]);
    const m = Number(tm[2] ?? 0);
    const ap = (tm[3] ?? '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (!ap && h < 7) h += 12; // "at 5" almost always means 5 PM
    if (h < 24 && m < 60) {
      startAfter = `${pad(h)}:${pad(m)}`;
      s = s.replace(tm[0], ' ');
    }
  }

  let due: Due = 'NONE';
  if (/\b(today|tonight)\b/i.test(s)) due = 'TODAY';
  else if (/\btomorrow\b/i.test(s)) due = 'TOMORROW';
  else if (/\b(this week|weekend|by (mon|tue|wed|thu|fri|sat|sun)\w*)\b/i.test(s)) due = 'WEEK';

  const priority: Priority = URGENT.test(s) ? 'URGENT' : due === 'TODAY' ? 'HIGH' : 'MEDIUM';
  const title = s
    .replace(/\b(today|tonight|tomorrow|this week|urgent|asap)\b/gi, ' ')
    .replace(/!+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\b(for|in|at|by)\s*$/i, '')
    .replace(/^[\s,;:-]+|[\s,;:-]+$/g, '')
    .trim() || line.trim();

  return { key: newKey(), title: title.slice(0, 300), minutes: minutes && minutes >= 5 ? Math.min(minutes, 6000) : guessMinutes(title), guessed: !minutes, priority, due, startAfter };
}

export const parseDump = (text: string): DraftTask[] => text.split(/\n|;/).map(parseLine).filter((x): x is DraftTask => !!x);
