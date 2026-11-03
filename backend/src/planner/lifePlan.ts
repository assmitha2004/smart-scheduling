/**
 * Life planner: turns the answers from the "Plan my time" questions into
 * everything the scheduling engine needs. It is pure (no DB, no clock):
 * `now` and the timezone are passed in, so it is deterministic and tested.
 *
 *  - a weekly routine of fixed events (classes, work, meetings, meals,
 *    commute, activities) that the engine never schedules over;
 *  - weekly availability windows where tasks may be placed. Students get
 *    study windows chosen around their energy pattern (early bird, daytime,
 *    night owl) and daily study goal; workers get their work hours;
 *  - smart tasks: exam revision spaced out before the exam, big assignments
 *    split into research -> draft -> polish, weekly subject reviews, work
 *    tasks, and daily habits;
 *  - friendly insights that explain the choices.
 */
import { DateTime } from 'luxon';

export type Persona = 'STUDENT' | 'WORK' | 'HYBRID';
export type Chronotype = 'EARLY_BIRD' | 'DAYTIME' | 'NIGHT_OWL';
export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

/** A weekly commitment, e.g. "Physics lecture, Mon/Wed 10:00-11:30". */
export interface WeeklySlot {
  title: string;
  weekdays: number[]; // 0 = Sunday ... 6 = Saturday
  start: string; // HH:mm
  end: string; // HH:mm (24:00 allowed)
}

export interface LifeAnswers {
  persona: Persona;
  horizon: 'DAY' | 'WEEK' | 'MONTH';
  wakeTime: string;
  sleepTime: string;
  chronotype: Chronotype;
  focusMinutes: number;
  meals: { breakfast?: string | null; lunch?: string | null; dinner?: string | null };
  commuteMinutes: number;
  daysOff: number[];
  activities: WeeklySlot[];
  habits: { title: string; minutes: number; weekdays: number[] }[];
  // Students and work + study
  classes: WeeklySlot[];
  subjects: { name: string; difficulty: 1 | 2 | 3 }[];
  exams: { subject: string; date: string }[]; // YYYY-MM-DD
  assignments: { title: string; dueDate: string; hours: number }[];
  studyHoursPerDay: number;
  // Workers and work + study
  workDays: number[];
  workStart: string;
  workEnd: string;
  meetings: WeeklySlot[];
  workTasks: { title: string; hours: number; dueDate?: string | null; priority: Priority }[];
}

export type RoutineKind = 'CLASS' | 'WORK' | 'MEETING' | 'ACTIVITY' | 'MEAL' | 'COMMUTE';
export interface RoutineItem {
  title: string;
  weekday: number;
  start: string;
  end: string;
  kind: RoutineKind;
  eventType: 'FIXED' | 'BREAK';
}

export interface Window {
  weekday: number;
  startTime: string;
  endTime: string;
}

export type ProjectKey = 'study' | 'work' | 'personal';
export interface PlannedTask {
  key: string;
  title: string;
  project: ProjectKey;
  estimatedMinutes: number;
  priority: Priority;
  splittable: boolean;
  earliestStartAt: string | null; // ISO
  dueAt: string | null; // ISO
  dependsOn: string[]; // keys of other planned tasks
  kind: 'EXAM_PREP' | 'ASSIGNMENT' | 'REVIEW' | 'WORK' | 'HABIT';
}

export interface LifePlan {
  routine: RoutineItem[];
  availability: Window[];
  tasks: PlannedTask[];
  focusBlockMinutes: number;
  horizonDays: number;
  insights: string[];
  stats: { availableMinutesPerWeek: number; plannedTaskMinutes: number; studyDays: number; sleepHours: number };
}

export const PROJECTS: Record<ProjectKey, { name: string; color: string }> = {
  study: { name: '📚 Studies', color: '#6366f1' },
  work: { name: '💼 Work', color: '#0ea5e9' },
  personal: { name: '🌱 Me time', color: '#10b981' },
};

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY = 1440;
export const HORIZON_DAYS: Record<LifeAnswers['horizon'], number> = { DAY: 1, WEEK: 7, MONTH: 30 };

// ---------- time helpers ----------
export const toMin = (hm: string): number => {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
};
export const fromMin = (m: number): string => {
  const c = Math.max(0, Math.min(DAY, Math.round(m)));
  return `${String(Math.floor(c / 60)).padStart(2, '0')}:${String(c % 60).padStart(2, '0')}`;
};
type Iv = [number, number];
function subtract(base: Iv[], cut: Iv[]): Iv[] {
  let out = base;
  for (const [cs, ce] of cut) {
    const next: Iv[] = [];
    for (const [s, e] of out) {
      if (ce <= s || cs >= e) next.push([s, e]);
      else {
        if (cs > s) next.push([s, cs]);
        if (ce < e) next.push([ce, e]);
      }
    }
    out = next;
  }
  return out;
}
function merge(ivs: Iv[]): Iv[] {
  const sorted = [...ivs].sort((a, b) => a[0] - b[0]);
  const out: Iv[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}
const total = (ivs: Iv[]) => ivs.reduce((s, [a, b]) => s + (b - a), 0);
const fmtHours = (min: number) => {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
};
const fmtHm = (hm: string) => {
  const m = toMin(hm) % DAY;
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}${m % 60 ? `:${String(m % 60).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
};

/** The awake part of a day: from 30 min after waking to 60 min before sleep (wind-down). */
export function awakeWindow(a: Pick<LifeAnswers, 'wakeTime' | 'sleepTime'>): Iv {
  const wake = toMin(a.wakeTime);
  let sleep = toMin(a.sleepTime);
  if (sleep <= wake) sleep += DAY; // sleeping after midnight
  return [Math.min(wake + 30, DAY), Math.min(sleep - 60, DAY)];
}

export function sleepMinutes(a: Pick<LifeAnswers, 'wakeTime' | 'sleepTime'>): number {
  const wake = toMin(a.wakeTime);
  const sleep = toMin(a.sleepTime);
  return (wake - sleep + DAY) % DAY || DAY;
}

const hasWork = (a: LifeAnswers) => a.persona === 'WORK' || a.persona === 'HYBRID';
const hasStudy = (a: LifeAnswers) => a.persona === 'STUDENT' || a.persona === 'HYBRID';

// ---------- weekly routine ----------
export function buildRoutine(a: LifeAnswers): RoutineItem[] {
  const items: RoutineItem[] = [];
  const add = (slot: WeeklySlot, kind: RoutineKind, prefix: string) => {
    for (const wd of new Set(slot.weekdays)) {
      if (toMin(slot.end) > toMin(slot.start)) items.push({ title: `${prefix} ${slot.title}`.trim(), weekday: wd, start: slot.start, end: slot.end, kind, eventType: 'FIXED' });
    }
  };
  if (hasStudy(a)) a.classes.forEach((c) => add(c, 'CLASS', '🎓'));
  if (hasWork(a)) {
    if (toMin(a.workEnd) > toMin(a.workStart)) {
      for (const wd of new Set(a.workDays)) items.push({ title: a.persona === 'HYBRID' ? '💼 Work shift' : '💼 Work', weekday: wd, start: a.workStart, end: a.workEnd, kind: 'WORK', eventType: 'FIXED' });
    }
    a.meetings.forEach((m) => add(m, 'MEETING', '👥'));
  }
  a.activities.forEach((x) => add(x, 'ACTIVITY', '⭐'));

  // Meals every day the person is awake for them.
  const meals: [string | null | undefined, string, number][] = [
    [a.meals.breakfast, '🍳 Breakfast', 30],
    [a.meals.lunch, '🥗 Lunch', 45],
    [a.meals.dinner, '🍲 Dinner', 45],
  ];
  for (let wd = 0; wd < 7; wd++) {
    for (const [time, title, len] of meals) {
      if (!time) continue;
      const s = toMin(time);
      items.push({ title, weekday: wd, start: fromMin(s), end: fromMin(Math.min(DAY, s + len)), kind: 'MEAL', eventType: 'BREAK' });
    }
  }

  // Commute before the first and after the last class/work commitment of the day.
  if (a.commuteMinutes > 0) {
    for (let wd = 0; wd < 7; wd++) {
      const anchors = items.filter((i) => i.weekday === wd && (i.kind === 'CLASS' || i.kind === 'WORK'));
      if (!anchors.length) continue;
      const first = Math.min(...anchors.map((i) => toMin(i.start)));
      const last = Math.max(...anchors.map((i) => toMin(i.end)));
      if (first - a.commuteMinutes >= 0) items.push({ title: '🚌 Commute', weekday: wd, start: fromMin(first - a.commuteMinutes), end: fromMin(first), kind: 'COMMUTE', eventType: 'FIXED' });
      if (last + a.commuteMinutes <= DAY) items.push({ title: '🚌 Commute home', weekday: wd, start: fromMin(last), end: fromMin(last + a.commuteMinutes), kind: 'COMMUTE', eventType: 'FIXED' });
    }
  }
  return items.sort((x, y) => x.weekday - y.weekday || toMin(x.start) - toMin(y.start));
}

/** How much a person with this energy pattern wants to focus at a given minute of the day (0-10). */
export function energyScore(chrono: Chronotype, minute: number): number {
  const h = minute / 60;
  if (chrono === 'EARLY_BIRD') return h < 5 ? 1 : h < 12 ? 10 - (h - 5) * 0.4 : h < 17 ? 6 : h < 20 ? 4 : 1;
  if (chrono === 'NIGHT_OWL') return h < 10 ? 2 : h < 14 ? 4 : h < 17 ? 6 : h < 23 ? 10 : 7;
  return h < 8 ? 3 : h < 13 ? 10 : h < 18 ? 8 : h < 21 ? 5 : 2;
}

/**
 * Picks the best `targetMin` minutes out of the free intervals for this
 * energy pattern, in 15-minute steps, and merges them into windows.
 * Short scraps (< 30 min) are ignored so blocks stay useful.
 */
export function pickWindows(free: Iv[], targetMin: number, chrono: Chronotype): Iv[] {
  const slots: { s: number; score: number }[] = [];
  for (const [s, e] of free) {
    if (e - s < 30) continue;
    for (let t = Math.ceil(s / 15) * 15; t + 15 <= e; t += 15) slots.push({ s: t, score: energyScore(chrono, t + 7.5) });
  }
  // Prefer high energy; tie-break toward earlier times (later for night owls).
  slots.sort((x, y) => y.score - x.score || (chrono === 'NIGHT_OWL' ? y.s - x.s : x.s - y.s));
  const chosen = slots.slice(0, Math.ceil(targetMin / 15)).map((x): Iv => [x.s, x.s + 15]);
  return merge(chosen).filter(([s, e]) => e - s >= 30);
}

export interface AvailabilityResult {
  windows: Window[];
  shortDays: { weekday: number; got: number; wanted: number }[];
}

export function buildAvailability(a: LifeAnswers, routine: RoutineItem[]): AvailabilityResult {
  const windows: Window[] = [];
  const shortDays: AvailabilityResult['shortDays'] = [];
  const awake = awakeWindow(a);
  for (let wd = 0; wd < 7; wd++) {
    if (a.daysOff.includes(wd)) continue;
    const busy: Iv[] = routine.filter((r) => r.weekday === wd).map((r) => [toMin(r.start), toMin(r.end)]);
    const free = subtract([awake], merge(busy)).filter(([s, e]) => e - s >= 30);
    const habitMin = a.habits.filter((h) => h.weekdays.includes(wd)).reduce((s, h) => s + h.minutes, 0);
    let chosen: Iv[] = [];

    const isWorkDay = hasWork(a) && a.workDays.includes(wd) && toMin(a.workEnd) > toMin(a.workStart);
    // Work tasks go inside work hours (meetings and lunch are fixed events the engine avoids).
    if (isWorkDay && (a.persona === 'WORK' || a.workTasks.length > 0)) chosen.push([toMin(a.workStart), toMin(a.workEnd)]);

    if (hasStudy(a)) {
      const wanted = Math.round(a.studyHoursPerDay * 60);
      // 20% headroom so the engine can work around deadlines, plus time for habits.
      const target = Math.round(wanted * 1.2) + habitMin;
      const picked = pickWindows(free, target, a.chronotype);
      const got = total(picked);
      if (wanted > 0 && got < wanted) shortDays.push({ weekday: wd, got, wanted });
      chosen.push(...picked);
    } else if (habitMin > 0 || !isWorkDay) {
      // Workers: a personal window for habits and goals, outside work.
      const personal = Math.min(150, Math.max(habitMin + 30, isWorkDay ? 0 : 120));
      const outsideWork = isWorkDay ? subtract(free, [[toMin(a.workStart), toMin(a.workEnd)]]) : free;
      if (personal > 0) chosen.push(...pickWindows(outsideWork, personal, a.chronotype === 'DAYTIME' && isWorkDay ? 'NIGHT_OWL' : a.chronotype));
    }

    for (const [s, e] of merge(chosen)) {
      const start = Math.ceil(s / 15) * 15;
      const end = Math.floor(e / 15) * 15;
      if (end - start >= 30) windows.push({ weekday: wd, startTime: fromMin(start), endTime: fromMin(end) });
    }
  }
  return { windows, shortDays };
}

// ---------- tasks ----------
interface TaskCtx {
  now: number;
  tz: string;
  horizonDays: number;
}
const localDay = (date: string, tz: string) => DateTime.fromISO(date, { zone: tz }).startOf('day');
/** Wall-clock time on a local day (DST-safe); 24:00 means the start of the next day. */
const at = (d: DateTime, hm: string) => {
  const m = toMin(hm);
  const base = m >= DAY ? d.plus({ days: 1 }) : d;
  return base.set({ hour: Math.floor((m % DAY) / 60), minute: m % 60, second: 0, millisecond: 0 });
};

const DIFFICULTY_MINUTES = { 1: 45, 2: 60, 3: 90 } as const;
const DIFFICULTY_SESSIONS = { 1: 3, 2: 4, 3: 5 } as const;
/** Days before the exam for each revision session: spaced repetition, widest gap first. */
const REVISION_OFFSETS = [12, 7, 4, 2, 1];

export function buildTasks(a: LifeAnswers, ctx: TaskCtx, notes: string[]): PlannedTask[] {
  const tasks: PlannedTask[] = [];
  const now = DateTime.fromMillis(ctx.now, { zone: ctx.tz });
  const today = now.startOf('day');
  const horizonEnd = today.plus({ days: ctx.horizonDays });
  const priorityFor = (due: DateTime): Priority => {
    const days = due.diff(now, 'days').days;
    return days <= 1 ? 'URGENT' : days <= 3 ? 'HIGH' : days <= 10 ? 'MEDIUM' : 'LOW';
  };
  const isoOrNull = (d: DateTime | null) => (d ? d.toUTC().toISO() : null);

  if (hasStudy(a)) {
    const difficulty = new Map(a.subjects.map((s) => [s.name.toLowerCase(), s.difficulty]));
    const examSubjects = new Set<string>();

    a.exams.forEach((exam, ei) => {
      const examDay = localDay(exam.date, ctx.tz);
      if (!examDay.isValid || examDay < today) {
        notes.push(`The ${exam.subject} exam date has already passed, so I skipped it.`);
        return;
      }
      examSubjects.add(exam.subject.toLowerCase());
      const diff = difficulty.get(exam.subject.toLowerCase()) ?? 2;
      const daysLeft = Math.round(examDay.diff(today, 'days').days);
      const offsets = REVISION_OFFSETS.slice(-DIFFICULTY_SESSIONS[diff]).filter((o) => o <= Math.max(daysLeft, 0));
      const sessions = offsets.length ? offsets : [0];
      let prev: string | null = null;
      sessions.forEach((offset, i) => {
        const day = examDay.minus({ days: offset });
        const key = `exam${ei}-${i}`;
        const last = i === sessions.length - 1;
        tasks.push({
          key,
          title: last ? `⚡ Final recap: ${exam.subject}` : `🧠 Revise ${exam.subject} (${i + 1}/${sessions.length})`,
          project: 'study',
          estimatedMinutes: last ? Math.max(30, DIFFICULTY_MINUTES[diff] - 15) : DIFFICULTY_MINUTES[diff],
          priority: daysLeft <= 3 ? 'URGENT' : daysLeft <= 7 ? 'HIGH' : 'MEDIUM',
          splittable: false,
          earliestStartAt: isoOrNull(i === 0 ? null : day.startOf('day')),
          dueAt: isoOrNull(offset === 0 ? at(day, '08:00') : at(day, '22:00')),
          dependsOn: prev ? [prev] : [],
          kind: 'EXAM_PREP',
        });
        prev = key;
      });
      notes.push(
        sessions.length > 1
          ? `${exam.subject} exam on ${examDay.toFormat('ccc d LLL')}: ${sessions.length} revision sessions spaced out so it really sticks (spaced repetition 🧠).`
          : `${exam.subject} exam is very soon, so I added one focused recap session. You've got this! 💪`,
      );
    });

    let splitAny = false;
    a.assignments.forEach((as, ai) => {
      const dueDay = localDay(as.dueDate, ctx.tz);
      if (!dueDay.isValid || at(dueDay, '20:00') < now) {
        notes.push(`"${as.title}" is already past its due date, so I left it out.`);
        return;
      }
      const due = at(dueDay, '20:00');
      const minutes = Math.round(as.hours * 60);
      const priority = priorityFor(due);
      if (minutes >= 180) {
        splitAny = true;
        const parts: [string, number][] = [
          [`🔎 Research: ${as.title}`, 0.25],
          [`✍️ Draft: ${as.title}`, 0.5],
          [`✅ Polish & submit: ${as.title}`, 0.25],
        ];
        parts.forEach(([title, share], i) => {
          tasks.push({
            key: `as${ai}-${i}`,
            title,
            project: 'study',
            estimatedMinutes: Math.max(30, Math.round((minutes * share) / 15) * 15),
            priority,
            splittable: true,
            earliestStartAt: null,
            dueAt: isoOrNull(due),
            dependsOn: i ? [`as${ai}-${i - 1}`] : [],
            kind: 'ASSIGNMENT',
          });
        });
      } else {
        tasks.push({ key: `as${ai}`, title: `📝 ${as.title}`, project: 'study', estimatedMinutes: Math.max(15, minutes), priority, splittable: true, earliestStartAt: null, dueAt: isoOrNull(due), dependsOn: [], kind: 'ASSIGNMENT' });
      }
    });
    if (splitAny) notes.push('Big assignments are split into research → draft → polish, so there is never a blank page the night before. ✨');

    // Weekly review for subjects without an upcoming exam (skipped for a one-day plan).
    if (ctx.horizonDays >= 7) {
      const weeks = Math.min(5, Math.ceil(ctx.horizonDays / 7));
      a.subjects
        .filter((s) => !examSubjects.has(s.name.toLowerCase()))
        .forEach((s, si) => {
          for (let w = 0; w < weeks; w++) {
            const start = today.plus({ weeks: w });
            const end = DateTime.min(start.plus({ days: 7 }), horizonEnd).minus({ minutes: 1 });
            tasks.push({ key: `rev${si}-${w}`, title: `🔁 Weekly review: ${s.name}`, project: 'study', estimatedMinutes: s.difficulty === 3 ? 60 : 45, priority: 'LOW', splittable: false, earliestStartAt: isoOrNull(w ? start : null), dueAt: isoOrNull(end), dependsOn: [], kind: 'REVIEW' });
          }
        });
    }
  }

  if (hasWork(a)) {
    a.workTasks.forEach((wt, wi) => {
      const dueDay = wt.dueDate ? localDay(wt.dueDate, ctx.tz) : null;
      const due = dueDay && dueDay.isValid ? at(dueDay, a.workEnd) : null;
      if (due && due < now) {
        notes.push(`"${wt.title}" is already overdue, so I gave it top priority.`);
      }
      tasks.push({
        key: `work${wi}`,
        title: `💼 ${wt.title}`,
        project: 'work',
        estimatedMinutes: Math.max(15, Math.round(wt.hours * 60)),
        priority: due && due < now ? 'URGENT' : wt.priority,
        splittable: true,
        earliestStartAt: null,
        dueAt: due && due >= now ? isoOrNull(due) : null,
        dependsOn: [],
        kind: 'WORK',
      });
    });
  }

  // Daily habits for the planning window (up to two weeks ahead).
  const habitDays = Math.min(ctx.horizonDays, 14);
  a.habits.forEach((h, hi) => {
    for (let d = 0; d < habitDays; d++) {
      const day = today.plus({ days: d });
      const wd = day.weekday % 7;
      if (!h.weekdays.includes(wd) || a.daysOff.includes(wd)) continue;
      const due = at(day, '23:00');
      if (due < now.plus({ minutes: h.minutes })) continue;
      tasks.push({ key: `habit${hi}-${d}`, title: `🌱 ${h.title}`, project: 'personal', estimatedMinutes: h.minutes, priority: 'LOW', splittable: false, earliestStartAt: isoOrNull(d ? day : null), dueAt: isoOrNull(due), dependsOn: [], kind: 'HABIT' });
    }
  });

  return tasks;
}

// ---------- the whole plan ----------
export function buildLifePlan(a: LifeAnswers, opts: { now: number; tz: string }): LifePlan {
  const horizonDays = HORIZON_DAYS[a.horizon];
  const routine = buildRoutine(a);
  const { windows, shortDays } = buildAvailability(a, routine);
  const notes: string[] = [];
  const tasks = buildTasks(a, { now: opts.now, tz: opts.tz, horizonDays }, notes);
  const insights: string[] = [];

  const weekly = windows.reduce((s, w) => s + toMin(w.endTime) - toMin(w.startTime), 0);
  const chronoText = { EARLY_BIRD: 'an early bird 🐦, so your focus time sits in the morning', DAYTIME: 'at your best during the day ☀️, so focus time sits late morning and afternoon', NIGHT_OWL: 'a night owl 🦉, so your focus time sits in the evening' }[a.chronotype];
  if (hasStudy(a)) {
    insights.push(`You're ${chronoText}. I found ${fmtHours(weekly)} of focus time a week around your ${a.persona === 'HYBRID' ? 'work and classes' : 'classes'}.`);
  } else {
    insights.push(`Your work tasks go inside your work hours (${fmtHm(a.workStart)}–${fmtHm(a.workEnd)}); meetings and lunch are blocked out so nothing lands on top of them.`);
    if (windows.some((w) => !a.workDays.includes(w.weekday) || toMin(w.startTime) >= toMin(a.workEnd) || toMin(w.endTime) <= toMin(a.workStart))) insights.push(`You're ${chronoText}, so your personal time for habits and goals is placed there.`);
  }
  for (const d of shortDays) {
    insights.push(`${WEEKDAY_NAMES[d.weekday]} is packed, so it only has ${fmtHours(d.got)} of study time instead of ${fmtHours(d.wanted)}. That's okay, other days pick up the slack. 💛`);
  }
  if (a.daysOff.length) insights.push(`${[...a.daysOff].sort((x, y) => ((x + 6) % 7) - ((y + 6) % 7)).map((d) => WEEKDAY_NAMES[d] + 's').join(' and ')} stay free for rest. Recharging is part of the plan 🌿`);
  const sleepH = sleepMinutes(a) / 60;
  if (sleepH < 7) insights.push(`Heads up: that's only about ${sleepH.toFixed(1)} hours of sleep. Your brain files away what you learned while you sleep, so 7–9 hours really helps 😴`);
  if (a.focusMinutes <= 30) insights.push('Short focus sprints with breaks in between (Pomodoro style) 🍅. Great for staying fresh.');
  else if (a.focusMinutes >= 90) insights.push('Long deep-focus blocks for getting into the zone 🎧. Breaks are added between them.');
  insights.push(...notes);

  return {
    routine,
    availability: windows,
    tasks,
    focusBlockMinutes: a.focusMinutes,
    horizonDays,
    insights,
    stats: {
      availableMinutesPerWeek: weekly,
      plannedTaskMinutes: tasks.reduce((s, t) => s + t.estimatedMinutes, 0),
      studyDays: 7 - a.daysOff.length,
      sleepHours: Math.round(sleepH * 10) / 10,
    },
  };
}

/** Expands the weekly routine into dated events from today for `days` days, in the user's timezone. */
export function expandRoutine(routine: RoutineItem[], opts: { now: number; tz: string; days: number }) {
  const today = DateTime.fromMillis(opts.now, { zone: opts.tz }).startOf('day');
  const events: { title: string; startAt: Date; endAt: Date; eventType: 'FIXED' | 'BREAK' }[] = [];
  for (let d = 0; d < opts.days; d++) {
    const day = today.plus({ days: d });
    const wd = day.weekday % 7;
    for (const r of routine) {
      if (r.weekday !== wd) continue;
      const start = at(day, r.start);
      const end = at(day, r.end);
      if (end.toMillis() <= opts.now) continue;
      events.push({ title: r.title, startAt: start.toJSDate(), endAt: end.toJSDate(), eventType: r.eventType });
    }
  }
  return events;
}
