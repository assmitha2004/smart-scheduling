/**
 * Progress & motivation: XP, levels, streaks, badges and the weekly review.
 * Pure: everything (including `now` and the timezone) is passed in, and it is
 * computed from data the app already stores, so there is nothing to keep in sync.
 */
import { DateTime } from 'luxon';

export interface DoneTask {
  id: string;
  title: string;
  estimatedMinutes: number;
  completedAt: Date;
  projectName: string;
}
export interface BlockLite {
  start: Date;
  end: Date;
  status: 'CONFIRMED' | 'COMPLETED' | 'PROPOSED' | 'CANCELLED';
}
export interface ProgressInput {
  done: DoneTask[];
  blocks: BlockLite[];
  /** When the user first accepted a generated schedule (null = never). */
  firstScheduleAcceptedAt: Date | null;
  tz: string;
  now: number;
}

export interface Badge {
  id: string;
  emoji: string;
  title: string;
  description: string;
  earnedAt: string | null;
}

// ---------- XP & levels ----------
/** XP for finishing a task: 10 for showing up, plus 1 per 6 minutes of work (capped at 4h). */
export const taskXp = (estimatedMinutes: number) => 10 + Math.round(Math.min(240, Math.max(0, estimatedMinutes)) / 6);
/** Total XP needed to reach a level: 0, 100, 300, 600, 1000, ... (each level takes 100 more). */
export const xpForLevel = (level: number) => 50 * level * (level - 1);
export function levelFor(xp: number) {
  let level = 1;
  while (xp >= xpForLevel(level + 1)) level++;
  const floor = xpForLevel(level);
  const next = xpForLevel(level + 1);
  return { level, xpIntoLevel: xp - floor, xpForNext: next - floor };
}
export const LEVEL_TITLES = ['Seedling 🌱', 'Sprout 🌿', 'Go-getter 🚀', 'Focused 🎯', 'Planner pro 🗓️', 'Time wizard 🧙', 'Unstoppable 🔥', 'Legend 🏆'];
export const levelTitle = (level: number) => LEVEL_TITLES[Math.min(level, LEVEL_TITLES.length) - 1];

// ---------- streaks ----------
const dayKey = (d: Date, tz: string) => DateTime.fromJSDate(d, { zone: tz }).toISODate()!;

export function streaks(done: DoneTask[], tz: string, now: number) {
  const days = [...new Set(done.map((t) => dayKey(t.completedAt, tz)))].sort();
  const set = new Set(days);
  // Best streak and the day each streak length was first reached.
  let best = 0;
  let run = 0;
  let prev: DateTime | null = null;
  const reached = new Map<number, string>();
  for (const k of days) {
    const d = DateTime.fromISO(k, { zone: tz });
    run = prev && Math.round(d.diff(prev, 'days').days) === 1 ? run + 1 : 1;
    prev = d;
    if (!reached.has(run)) reached.set(run, k);
    best = Math.max(best, run);
  }
  // Current streak: ending today, or yesterday if nothing is done yet today.
  const today = DateTime.fromMillis(now, { zone: tz });
  let cursor = set.has(today.toISODate()!) ? today : today.minus({ days: 1 });
  let current = 0;
  while (set.has(cursor.toISODate()!)) { current++; cursor = cursor.minus({ days: 1 }); }
  return { current, best, reached, doneToday: done.filter((t) => dayKey(t.completedAt, tz) === today.toISODate()).length };
}

// ---------- badges ----------
const localHour = (d: Date, tz: string) => DateTime.fromJSDate(d, { zone: tz }).hour;
const isWeekend = (d: Date, tz: string) => DateTime.fromJSDate(d, { zone: tz }).weekday >= 6;
const isWork = (t: DoneTask) => /work/i.test(t.projectName);
const isStudy = (t: DoneTask) => /stud/i.test(t.projectName);

export function computeBadges(input: ProgressInput, sorted: DoneTask[], reached: Map<number, string>): Badge[] {
  const { tz } = input;
  const first = (pred: (t: DoneTask) => boolean) => sorted.find(pred)?.completedAt.toISOString() ?? null;
  const nth = (n: number) => sorted[n - 1]?.completedAt.toISOString() ?? null;
  const streakDay = (n: number) => { const k = reached.get(n); return k ? DateTime.fromISO(k, { zone: tz }).endOf('day').toUTC().toISO() : null; };

  // Balanced: a week (Mon-Sun) with at least one study and one work task finished.
  let balanced: string | null = null;
  const weeks = new Map<string, { s: boolean; w: boolean }>();
  for (const t of sorted) {
    const wk = DateTime.fromJSDate(t.completedAt, { zone: tz }).startOf('week').toISODate()!;
    const v = weeks.get(wk) ?? { s: false, w: false };
    v.s ||= isStudy(t);
    v.w ||= isWork(t);
    weeks.set(wk, v);
    if (v.s && v.w && !balanced) balanced = t.completedAt.toISOString();
  }

  return [
    { id: 'first-step', emoji: '🌱', title: 'First step', description: 'Finish your first task', earnedAt: nth(1) },
    { id: 'on-a-roll', emoji: '🔥', title: 'On a roll', description: 'Finish tasks 3 days in a row', earnedAt: streakDay(3) },
    { id: 'unstoppable', emoji: '🏆', title: 'Unstoppable', description: 'Keep a 7-day streak', earnedAt: streakDay(7) },
    { id: 'ten-down', emoji: '✅', title: 'Ten down', description: 'Finish 10 tasks', earnedAt: nth(10) },
    { id: 'half-century', emoji: '💯', title: 'Half century', description: 'Finish 50 tasks', earnedAt: nth(50) },
    { id: 'deep-diver', emoji: '🎧', title: 'Deep diver', description: 'Finish a task of 2 hours or more', earnedAt: first((t) => t.estimatedMinutes >= 120) },
    { id: 'early-bird', emoji: '🐦', title: 'Early bird', description: 'Finish a task before 8am', earnedAt: first((t) => localHour(t.completedAt, tz) < 8) },
    { id: 'night-owl', emoji: '🦉', title: 'Night owl', description: 'Finish a task after 10pm', earnedAt: first((t) => localHour(t.completedAt, tz) >= 22) },
    { id: 'weekend-warrior', emoji: '🏖️', title: 'Weekend warrior', description: 'Get something done on a weekend', earnedAt: first((t) => isWeekend(t.completedAt, tz)) },
    { id: 'exam-ready', emoji: '🎓', title: 'Exam ready', description: 'Finish a final exam recap', earnedAt: first((t) => /final recap/i.test(t.title)) },
    { id: 'balanced', emoji: '⚖️', title: 'Balanced', description: 'Finish study and work tasks in the same week', earnedAt: balanced },
    { id: 'planner-pro', emoji: '🗓️', title: 'Planner pro', description: 'Accept your first smart schedule', earnedAt: input.firstScheduleAcceptedAt?.toISOString() ?? null },
  ];
}

// ---------- weekly review ----------
export function weekSummary(input: ProgressInput, weekStart: DateTime) {
  const weekEnd = weekStart.plus({ weeks: 1 });
  const inWeek = (d: Date) => d.getTime() >= weekStart.toMillis() && d.getTime() < weekEnd.toMillis();
  const done = input.done.filter((t) => inWeek(t.completedAt));
  const blocks = input.blocks.filter((b) => inWeek(b.start) && (b.status === 'CONFIRMED' || b.status === 'COMPLETED'));
  const pastBlocks = blocks.filter((b) => b.end.getTime() <= input.now);
  const mins = (b: BlockLite) => (b.end.getTime() - b.start.getTime()) / 60000;
  const plannedMinutes = blocks.reduce((s, b) => s + mins(b), 0);
  const completedMinutes = pastBlocks.filter((b) => b.status === 'COMPLETED').reduce((s, b) => s + mins(b), 0);
  const pastMinutes = pastBlocks.reduce((s, b) => s + mins(b), 0);
  const byDay = new Map<string, number>();
  for (const t of done) {
    const k = DateTime.fromJSDate(t.completedAt, { zone: input.tz }).toFormat('cccc');
    byDay.set(k, (byDay.get(k) ?? 0) + 1);
  }
  const best = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];
  const byProject = new Map<string, { tasks: number; minutes: number }>();
  for (const t of done) {
    const v = byProject.get(t.projectName) ?? { tasks: 0, minutes: 0 };
    v.tasks++;
    v.minutes += t.estimatedMinutes;
    byProject.set(t.projectName, v);
  }
  return {
    weekStart: weekStart.toISODate()!,
    tasksDone: done.length,
    minutesDone: done.reduce((s, t) => s + t.estimatedMinutes, 0),
    xpEarned: done.reduce((s, t) => s + taskXp(t.estimatedMinutes), 0),
    plannedMinutes: Math.round(plannedMinutes),
    followThrough: pastMinutes ? Math.round((completedMinutes / pastMinutes) * 100) : null,
    bestDay: best ? { day: best[0], tasks: best[1] } : null,
    byProject: [...byProject.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.minutes - a.minutes),
    wins: [...done].sort((a, b) => b.estimatedMinutes - a.estimatedMinutes).slice(0, 5).map((t) => ({ id: t.id, title: t.title, minutes: t.estimatedMinutes })),
  };
}

function reviewMessage(cur: ReturnType<typeof weekSummary>, prev: ReturnType<typeof weekSummary>): string {
  if (!cur.tasksDone && !prev.tasksDone) return 'A fresh week, a fresh start. Pick one small task and get the ball rolling 🌱';
  if (!cur.tasksDone) return 'Nothing ticked off yet this week. One small win today gets you going again 💪';
  if (cur.tasksDone > prev.tasksDone) return `You've finished ${cur.tasksDone - prev.tasksDone} more task${cur.tasksDone - prev.tasksDone === 1 ? '' : 's'} than last week. Momentum! 🚀`;
  if (cur.tasksDone === prev.tasksDone) return 'Matching last week. Consistency is a superpower 🐢🏆';
  return 'A lighter week than the last, and that’s okay. Rest is part of the plan 🌿';
}

export function computeProgress(input: ProgressInput) {
  const sorted = [...input.done].sort((a, b) => a.completedAt.getTime() - b.completedAt.getTime());
  const xp = sorted.reduce((s, t) => s + taskXp(t.estimatedMinutes), 0);
  const lvl = levelFor(xp);
  const st = streaks(sorted, input.tz, input.now);
  const badges = computeBadges(input, sorted, st.reached);
  const thisWeek = DateTime.fromMillis(input.now, { zone: input.tz }).startOf('week');
  const current = weekSummary(input, thisWeek);
  const previous = weekSummary(input, thisWeek.minus({ weeks: 1 }));
  const weekStartMs = thisWeek.toMillis();
  return {
    xp,
    ...lvl,
    levelTitle: levelTitle(lvl.level),
    streak: st.current,
    bestStreak: st.best,
    doneToday: st.doneToday,
    totalDone: sorted.length,
    badges,
    week: {
      current,
      previous,
      message: reviewMessage(current, previous),
      badgesEarned: badges.filter((b) => b.earnedAt && Date.parse(b.earnedAt) >= weekStartMs).map((b) => b.id),
    },
  };
}
