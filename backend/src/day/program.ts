/**
 * Plans that span more than one day: "this week", "next 10 days", "this month",
 * "this year". A plan (ProgramSpec) says which tasks happen on which days
 * (every day, weekdays, weekends, some days, N times a week, once, or a total
 * number of hours spread across the period), the fixed commitments of each
 * weekday and the day's hours. Each date expands into an ordinary one-day plan.
 *
 * Pure and deterministic: dates are ISO strings (YYYY-MM-DD), weekdays are
 * 1 (Mon) .. 7 (Sun), times are HH:mm.
 */
import { DateTime } from 'luxon';
import { planDay, toMin, fmtDuration, type Busy, type DayPlanResult, type DayTaskInput, type Effort, type Peak } from './dayPlan.js';

export type Repeat = 'ONCE' | 'DAILY' | 'WEEKDAYS' | 'WEEKENDS' | 'DAYS' | 'WEEKLY';

export interface ProgramTask {
  key: string;
  title: string;
  /** Minutes each time it is planned. */
  minutes: number;
  minutesGuessed?: boolean;
  effort: Effort;
  top: boolean;
  mustDo: boolean;
  fixedTime: string | null;
  notBefore: string | null;
  dueBy: string | null;
  /** null: not decided yet (the chat asks). */
  repeat: Repeat | null;
  /** Weekdays for DAYS (1 = Mon .. 7 = Sun). */
  days?: number[];
  /** For WEEKLY: how many times a week. */
  timesPerWeek?: number;
  /** For ONCE: which date (default: the first day). */
  date?: string | null;
  /** Only plan it until this date (e.g. a deadline). */
  until?: string | null;
  /** A goal for the whole period (e.g. "20 hours this month"), spread over the task's days. */
  totalMinutes?: number | null;
}

export interface ProgramCommitment { title: string; start: string; end: string; days: number[] }
export interface ProgramWindow { start: string; end: string; light: boolean; days: number[] }

export interface ProgramSpec {
  title: string;
  startDate: string | null;
  days: number | null;
  /** true: one routine repeated; false: days differ; null: not decided yet. */
  sameEveryDay: boolean | null;
  dayStart: string;
  dayEnd: string;
  peak: Peak;
  breaks?: 'SHORT' | 'NORMAL' | 'LONG';
  maxSession?: number;
  commitments: ProgramCommitment[];
  windows: ProgramWindow[];
  /** Weekdays with nothing planned. */
  restDays: number[];
  tasks: ProgramTask[];
}

export const MAX_DAYS = 366;
export const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
export const WEEKDAYS = [1, 2, 3, 4, 5];
export const WEEKEND = [6, 7];
const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_LONG = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const dt = (date: string) => DateTime.fromISO(date, { zone: 'utc' });
export const weekdayOf = (date: string) => dt(date).weekday;
export const addDays = (date: string, n: number) => dt(date).plus({ days: n }).toISODate()!;
export const daysBetween = (a: string, b: string) => Math.round(dt(b).diff(dt(a), 'days').days);
const round5 = (m: number) => Math.round(m / 5) * 5;

export function endDate(spec: Pick<ProgramSpec, 'startDate' | 'days'>): string | null {
  if (!spec.startDate || !spec.days) return null;
  return addDays(spec.startDate, Math.min(spec.days, MAX_DAYS) - 1);
}

/** "Mon 16 Nov". */
export const dayLabel = (date: string) => dt(date).toFormat('ccc d LLL');

/** "Mon 16 – Sun 22 Nov", "Mon 16 Nov 2026 – Thu 15 Nov 2027". */
export function periodLabel(start: string, days: number): string {
  if (days <= 1) return dayLabel(start);
  const end = addDays(start, days - 1);
  const a = dt(start);
  const b = dt(end);
  if (a.year !== b.year) return `${a.toFormat('ccc d LLL yyyy')} – ${b.toFormat('ccc d LLL yyyy')}`;
  if (a.month !== b.month) return `${a.toFormat('ccc d LLL')} – ${b.toFormat('ccc d LLL')}`;
  return `${a.toFormat('ccc d')} – ${b.toFormat('ccc d LLL')}`;
}

export function daysText(days: number[]): string {
  const s = [...new Set(days)].sort((a, b) => a - b);
  if (s.length === 7) return 'every day';
  if (s.join() === WEEKDAYS.join()) return 'weekdays';
  if (s.join() === WEEKEND.join()) return 'weekends';
  if (s.length === 1) return `${DAY_LONG[s[0]]}s`;
  return s.map((d) => DAY_NAMES[d]).join(', ');
}

export function repeatText(t: ProgramTask): string {
  switch (t.repeat) {
    case 'DAILY': return 'every day';
    case 'WEEKDAYS': return 'weekdays';
    case 'WEEKENDS': return 'weekends';
    case 'DAYS': return daysText(t.days ?? []);
    case 'WEEKLY': return `${t.timesPerWeek ?? 1}× a week`;
    case 'ONCE': return t.date ? `once, ${dayLabel(t.date)}` : 'once';
    default: return 'not decided';
  }
}

/** The repeat a task actually uses (an undecided one in a same-every-day plan is daily). */
function effectiveRepeat(spec: ProgramSpec, t: ProgramTask): Repeat {
  if (t.repeat) return t.repeat;
  if ((spec.days ?? 1) <= 1) return 'ONCE';
  return spec.sameEveryDay === false ? 'ONCE' : 'DAILY';
}

/** All dates of the plan, with their weekday. */
export function planDates(spec: ProgramSpec): { date: string; weekday: number; index: number }[] {
  if (!spec.startDate || !spec.days) return [];
  const n = Math.min(spec.days, MAX_DAYS);
  const start = dt(spec.startDate);
  return Array.from({ length: n }, (_, index) => {
    const d = start.plus({ days: index });
    return { date: d.toISODate()!, weekday: d.weekday, index };
  });
}

/** The dates a task is planned on. */
export function taskDates(spec: ProgramSpec, t: ProgramTask): string[] {
  const all = planDates(spec);
  if (!all.length) return [];
  const rest = new Set(spec.restDays);
  const until = t.until ?? null;
  const open = all.filter((d) => !rest.has(d.weekday) && (!until || d.date <= until));
  const repeat = effectiveRepeat(spec, t);
  switch (repeat) {
    case 'ONCE': {
      const want = t.date && t.date >= all[0].date && t.date <= all[all.length - 1].date ? t.date : null;
      if (want) return [want];
      return open.length ? [open[0].date] : [all[0].date];
    }
    case 'DAILY': return open.map((d) => d.date);
    case 'WEEKDAYS': return open.filter((d) => d.weekday <= 5).map((d) => d.date);
    case 'WEEKENDS': return open.filter((d) => d.weekday >= 6).map((d) => d.date);
    case 'DAYS': {
      const days = new Set(t.days?.length ? t.days : ALL_DAYS);
      return all.filter((d) => days.has(d.weekday) && (!until || d.date <= until)).map((d) => d.date);
    }
    case 'WEEKLY': {
      // Spread N sessions over each calendar week (Mon–Sun), e.g. 3× = Mon, Wed, Fri.
      const n = Math.max(1, Math.min(7, t.timesPerWeek ?? 1));
      const perFullWeek = Math.max(1, 7 - rest.size);
      const weeks = new Map<string, typeof open>();
      for (const d of open) {
        const wk = dt(d.date).startOf('week').toISODate()!;
        if (!weeks.has(wk)) weeks.set(wk, []);
        weeks.get(wk)!.push(d);
      }
      const out: string[] = [];
      for (const days of weeks.values()) {
        const k = Math.min(days.length, days.length >= perFullWeek ? n : Math.max(1, Math.round((n * days.length) / perFullWeek)));
        for (let i = 0; i < k; i++) out.push(days[Math.floor(((i + 0.5) * days.length) / k)].date);
      }
      return [...new Set(out)];
    }
  }
}

/** Minutes each time a task is planned (a total goal is spread over its days). */
export function minutesEach(spec: ProgramSpec, t: ProgramTask, count = taskDates(spec, t).length): number {
  if (t.totalMinutes && count > 0) return Math.max(15, Math.min(720, round5(t.totalMinutes / count) || 15));
  return t.minutes;
}

export interface DayExpansion {
  date: string;
  weekday: number;
  rest: boolean;
  settings: {
    dayStart: string;
    dayEnd: string;
    peak: Peak;
    breaks?: 'SHORT' | 'NORMAL' | 'LONG';
    maxSession?: number;
    commitments?: { title: string; start: string; end: string }[];
    windows?: { start: string; end: string; light: boolean }[];
  };
  tasks: (Omit<DayTaskInput, 'id'> & { key: string })[];
}

/** Everything planned for each date of the plan. */
export function expandProgram(spec: ProgramSpec): DayExpansion[] {
  const dates = planDates(spec);
  const byDate = new Map<string, DayExpansion['tasks']>();
  for (const t of spec.tasks) {
    const ds = taskDates(spec, t);
    const minutes = minutesEach(spec, t, ds.length);
    for (const d of ds) {
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d)!.push({ key: t.key, title: t.title, minutes, mustDo: t.mustDo, top: t.top, effort: t.effort, fixedTime: t.fixedTime, notBefore: t.notBefore, dueBy: t.dueBy });
    }
  }
  const rest = new Set(spec.restDays);
  return dates.map(({ date, weekday }) => {
    const commitments = spec.commitments.filter((c) => c.days.includes(weekday)).map(({ title, start, end }) => ({ title, start, end }));
    const windows = spec.windows.filter((w) => w.days.includes(weekday)).map(({ start, end, light }) => ({ start, end, light }));
    const tasks = byDate.get(date) ?? [];
    // Only one #1 priority per day.
    let topSeen = false;
    for (const t of tasks) { if (t.top && topSeen) t.top = false; topSeen ||= t.top; }
    return {
      date,
      weekday,
      rest: rest.has(weekday),
      settings: {
        dayStart: spec.dayStart,
        dayEnd: spec.dayEnd,
        peak: spec.peak,
        ...(spec.breaks ? { breaks: spec.breaks } : {}),
        ...(spec.maxSession ? { maxSession: spec.maxSession } : {}),
        ...(commitments.length ? { commitments } : {}),
        ...(windows.length ? { windows } : {}),
      },
      tasks,
    };
  });
}

/** Commitments minus the free windows inside them, as busy minutes. */
export function commitmentBusy(settings: DayExpansion['settings']): Busy[] {
  const end = (hm: string) => (hm === '24:00' ? 1440 : toMin(hm));
  let out: Busy[] = (settings.commitments ?? []).map((c) => ({ title: c.title, start: toMin(c.start), end: end(c.end), kind: 'BUSY' as const }));
  for (const w of settings.windows ?? []) {
    const ws = toMin(w.start);
    const we = end(w.end);
    out = out.flatMap((b) => (we <= b.start || ws >= b.end ? [b] : [
      ...(ws > b.start ? [{ ...b, end: ws }] : []),
      ...(we < b.end ? [{ ...b, start: we }] : []),
    ]));
  }
  return out.filter((b) => b.end > b.start);
}

/** Meals that don't fall inside a commitment (a meal at work isn't a separate block). */
export function mealsFor(settings: DayExpansion['settings'], meals: { title: string; start: string; minutes: number }[]): Busy[] {
  const inside = (s: number, e: number) => (settings.commitments ?? []).some((c) => s < (c.end === '24:00' ? 1440 : toMin(c.end)) && e > toMin(c.start));
  return meals.filter((m) => !inside(toMin(m.start), toMin(m.start) + m.minutes)).map((m) => ({ title: m.title, start: toMin(m.start), end: toMin(m.start) + m.minutes, kind: 'BREAK' as const }));
}

export function planExpandedDay(day: DayExpansion, opts: { busy?: Busy[]; dayStartMin?: number } = {}): DayPlanResult {
  const s = day.settings;
  let dayStart = Math.max(toMin(s.dayStart), opts.dayStartMin ?? 0);
  const dayEnd = s.dayEnd === '24:00' ? 1440 : toMin(s.dayEnd);
  if (dayEnd - dayStart < 15) dayStart = Math.max(0, dayEnd - 15);
  return planDay({
    dayStart,
    dayEnd,
    peak: s.peak,
    busy: [...commitmentBusy(s), ...(opts.busy ?? [])],
    windows: (s.windows ?? []).map((w) => ({ start: toMin(w.start), end: w.end === '24:00' ? 1440 : toMin(w.end), light: w.light })),
    breakScale: s.breaks === 'SHORT' ? 0.5 : s.breaks === 'LONG' ? 2 : 1,
    maxSession: s.maxSession,
    tasks: day.tasks.map((t) => ({ ...t, id: t.key })),
  });
}

export interface ProgramPreviewDay {
  date: string;
  label: string;
  rest: boolean;
  items: DayPlanResult['items'];
  overflow: DayPlanResult['overflow'];
  insights: string[];
  stats: DayPlanResult['stats'];
}

export interface ProgramSummary {
  start: string;
  end: string;
  days: number;
  label: string;
  taskDays: number;
  plannedMinutes: number;
  avgMinutesPerDay: number;
  /** Days where not everything fits. */
  overloaded: { date: string; label: string; minutes: number; titles: string[] }[];
  perTask: { key: string; title: string; when: string; times: number; minutesEach: number; totalMinutes: number }[];
}

/**
 * A preview of the plan: the full timeline of `count` days from `from`, and a
 * summary of the whole period (what fits, which days are overloaded).
 */
export function programPreview(
  spec: ProgramSpec,
  opts: { from?: number; count?: number; meals?: { title: string; start: string; minutes: number }[]; firstDayStartMin?: number } = {},
): { days: ProgramPreviewDay[]; summary: ProgramSummary | null } {
  const expanded = expandProgram(spec);
  if (!expanded.length) return { days: [], summary: null };
  const from = Math.max(0, opts.from ?? 0);
  const count = Math.max(1, Math.min(31, opts.count ?? 14));
  const meals = opts.meals ?? [];
  const results = expanded.map((d, i) => planExpandedDay(d, { busy: mealsFor(d.settings, meals), dayStartMin: i === 0 ? opts.firstDayStartMin : undefined }));
  const days = expanded.slice(from, from + count).map((d, j) => {
    const r = results[from + j];
    return { date: d.date, label: dayLabel(d.date), rest: d.rest, items: r.items, overflow: r.overflow, insights: r.insights, stats: r.stats };
  });
  const overloaded = expanded
    .map((d, i) => ({ d, r: results[i] }))
    .filter(({ r }) => r.overflow.length)
    .map(({ d, r }) => ({ date: d.date, label: dayLabel(d.date), minutes: r.overflow.reduce((s, o) => s + o.minutes, 0), titles: r.overflow.map((o) => o.title) }));
  const plannedMinutes = expanded.reduce((s, d) => s + d.tasks.reduce((x, t) => x + t.minutes, 0), 0);
  const taskDays = expanded.filter((d) => d.tasks.length).length;
  const perTask = spec.tasks.map((t) => {
    const times = taskDates(spec, t).length;
    const each = minutesEach(spec, t, times);
    return { key: t.key, title: t.title, when: repeatText({ ...t, repeat: effectiveRepeat(spec, t) }), times, minutesEach: each, totalMinutes: each * times };
  });
  return {
    days,
    summary: {
      start: expanded[0].date,
      end: expanded[expanded.length - 1].date,
      days: expanded.length,
      label: periodLabel(expanded[0].date, expanded.length),
      taskDays,
      plannedMinutes,
      avgMinutesPerDay: taskDays ? Math.round(plannedMinutes / taskDays) : 0,
      overloaded,
      perTask,
    },
  };
}

/** Short totals for one date (for progress calendars): how much the plan puts there. */
export function plannedOn(spec: ProgramSpec, date: string): { count: number; minutes: number } | null {
  if (!spec.startDate || !spec.days) return null;
  const end = endDate(spec)!;
  if (date < spec.startDate || date > end) return null;
  let count = 0;
  let minutes = 0;
  for (const t of spec.tasks) {
    const ds = taskDates(spec, t);
    if (ds.includes(date)) { count += 1; minutes += minutesEach(spec, t, ds.length); }
  }
  return { count, minutes };
}

export { fmtDuration };
