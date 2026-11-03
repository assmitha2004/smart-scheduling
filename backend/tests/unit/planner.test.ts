import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import {
  awakeWindow,
  buildAvailability,
  buildLifePlan,
  buildRoutine,
  energyScore,
  expandRoutine,
  pickWindows,
  sleepMinutes,
  toMin,
  type LifeAnswers,
} from '../../src/planner/lifePlan.js';

const TZ = 'Asia/Kolkata';
// Monday 2 Nov 2026, 08:00 in Chennai.
const NOW = DateTime.fromISO('2026-11-02T08:00', { zone: TZ }).toMillis();

function answers(over: Partial<LifeAnswers> = {}): LifeAnswers {
  return {
    persona: 'STUDENT',
    horizon: 'WEEK',
    wakeTime: '07:00',
    sleepTime: '23:00',
    chronotype: 'DAYTIME',
    focusMinutes: 50,
    meals: { breakfast: '07:30', lunch: '13:00', dinner: '20:00' },
    commuteMinutes: 0,
    daysOff: [],
    activities: [],
    habits: [],
    classes: [],
    subjects: [],
    exams: [],
    assignments: [],
    studyHoursPerDay: 3,
    workDays: [1, 2, 3, 4, 5],
    workStart: '09:00',
    workEnd: '17:00',
    meetings: [],
    workTasks: [],
    ...over,
  };
}
const minutesOf = (ws: { startTime: string; endTime: string }[]) => ws.reduce((s, w) => s + toMin(w.endTime) - toMin(w.startTime), 0);

describe('routine', () => {
  it('adds classes, daily meals and commute around the first and last class', () => {
    const r = buildRoutine(answers({ commuteMinutes: 30, classes: [{ title: 'Physics', weekdays: [1], start: '10:00', end: '12:00' }, { title: 'Maths', weekdays: [1], start: '14:00', end: '15:30' }] }));
    const monday = r.filter((x) => x.weekday === 1);
    expect(monday.map((x) => x.title)).toEqual(['🍳 Breakfast', '🚌 Commute', '🎓 Physics', '🥗 Lunch', '🎓 Maths', '🚌 Commute home', '🍲 Dinner']);
    expect(monday.find((x) => x.title === '🚌 Commute')).toMatchObject({ start: '09:30', end: '10:00' });
    expect(monday.find((x) => x.title === '🚌 Commute home')).toMatchObject({ start: '15:30', end: '16:00' });
    // No commute on a day without classes.
    expect(r.some((x) => x.weekday === 2 && x.kind === 'COMMUTE')).toBe(false);
    expect(r.filter((x) => x.kind === 'MEAL')).toHaveLength(21);
  });

  it('handles late sleepers: awake window ends at midnight at the latest', () => {
    expect(awakeWindow({ wakeTime: '09:00', sleepTime: '01:30' })).toEqual([570, 1440]);
    expect(sleepMinutes({ wakeTime: '09:00', sleepTime: '01:30' })).toBe(450);
    expect(sleepMinutes({ wakeTime: '06:30', sleepTime: '22:30' })).toBe(480);
  });
});

describe('study windows follow the energy pattern', () => {
  it('scores mornings for early birds and evenings for night owls', () => {
    expect(energyScore('EARLY_BIRD', 7 * 60)).toBeGreaterThan(energyScore('EARLY_BIRD', 21 * 60));
    expect(energyScore('NIGHT_OWL', 21 * 60)).toBeGreaterThan(energyScore('NIGHT_OWL', 8 * 60));
  });

  it('picks evening windows for a night owl and morning windows for an early bird', () => {
    const free: [number, number][] = [[8 * 60, 23 * 60]];
    const owl = pickWindows(free, 180, 'NIGHT_OWL');
    const bird = pickWindows(free, 180, 'EARLY_BIRD');
    expect(owl[0][0]).toBeGreaterThanOrEqual(17 * 60);
    expect(bird[bird.length - 1][1]).toBeLessThanOrEqual(12 * 60);
    expect(owl.reduce((s, [a, b]) => s + b - a, 0)).toBe(180);
  });

  it('never places study time over classes or meals, and reports packed days', () => {
    const a = answers({
      studyHoursPerDay: 4,
      classes: [{ title: 'Lab', weekdays: [3], start: '08:00', end: '19:30' }],
    });
    const routine = buildRoutine(a);
    const { windows, shortDays } = buildAvailability(a, routine);
    for (const w of windows) {
      for (const r of routine.filter((x) => x.weekday === w.weekday)) {
        expect(toMin(w.endTime) <= toMin(r.start) || toMin(w.startTime) >= toMin(r.end)).toBe(true);
      }
    }
    expect(shortDays.map((d) => d.weekday)).toEqual([3]);
    // Normal days get the goal plus 20% headroom (4h48m), rounded up to 15-minute steps.
    expect(minutesOf(windows.filter((w) => w.weekday === 1))).toBe(300);
  });

  it('keeps days off completely free', () => {
    const { windows } = buildAvailability(answers({ daysOff: [0] }), buildRoutine(answers({ daysOff: [0] })));
    expect(windows.some((w) => w.weekday === 0)).toBe(false);
    expect(windows.some((w) => w.weekday === 6)).toBe(true);
  });
});

describe('workers', () => {
  it('puts task time inside work hours and a personal window for habits outside them', () => {
    const a = answers({ persona: 'WORK', chronotype: 'DAYTIME', habits: [{ title: 'Read', minutes: 30, weekdays: [1, 2, 3, 4, 5] }], meetings: [{ title: 'Standup', weekdays: [1, 2, 3, 4, 5], start: '09:30', end: '09:45' }] });
    const routine = buildRoutine(a);
    const { windows } = buildAvailability(a, routine);
    const monday = windows.filter((w) => w.weekday === 1);
    expect(monday.some((w) => w.startTime === '09:00' && w.endTime === '17:00')).toBe(true);
    const personal = monday.filter((w) => toMin(w.startTime) >= toMin('17:00'));
    expect(minutesOf(personal)).toBeGreaterThanOrEqual(30);
    // Meetings stay fixed events for the engine to avoid.
    expect(routine.some((r) => r.title === '👥 Standup' && r.eventType === 'FIXED')).toBe(true);
  });

  it('turns a work + study shift into a fixed event when there are no work tasks', () => {
    const a = answers({ persona: 'HYBRID', workDays: [6, 0], workStart: '10:00', workEnd: '18:00', studyHoursPerDay: 2 });
    const { windows } = buildAvailability(a, buildRoutine(a));
    for (const w of windows.filter((x) => x.weekday === 6)) {
      expect(toMin(w.endTime) <= 600 || toMin(w.startTime) >= 1080).toBe(true);
    }
  });
});

describe('smart tasks', () => {
  it('spaces exam revision before the exam, in order, harder subjects get more sessions', () => {
    const plan = buildLifePlan(
      answers({ subjects: [{ name: 'Chemistry', difficulty: 3 }, { name: 'History', difficulty: 1 }], exams: [{ subject: 'Chemistry', date: '2026-11-20' }, { subject: 'History', date: '2026-11-20' }] }),
      { now: NOW, tz: TZ },
    );
    const chem = plan.tasks.filter((t) => t.title.includes('Chemistry'));
    const hist = plan.tasks.filter((t) => t.title.includes('History'));
    expect(chem).toHaveLength(5);
    expect(hist).toHaveLength(3);
    const dues = chem.map((t) => Date.parse(t.dueAt!));
    expect([...dues].sort((x, y) => x - y)).toEqual(dues);
    expect(Math.max(...dues)).toBeLessThan(DateTime.fromISO('2026-11-20', { zone: TZ }).toMillis());
    // Each session waits for the previous one.
    chem.slice(1).forEach((t, i) => expect(t.dependsOn).toEqual([chem[i].key]));
    expect(chem[chem.length - 1].title).toContain('Final recap');
    // Subjects with exams don't also get weekly reviews.
    expect(plan.tasks.some((t) => t.kind === 'REVIEW')).toBe(false);
  });

  it('compresses revision when the exam is close', () => {
    const plan = buildLifePlan(answers({ subjects: [{ name: 'Maths', difficulty: 3 }], exams: [{ subject: 'Maths', date: '2026-11-04' }] }), { now: NOW, tz: TZ });
    const maths = plan.tasks.filter((t) => t.kind === 'EXAM_PREP');
    expect(maths).toHaveLength(2); // 2 days and 1 day before
    expect(maths.every((t) => t.priority === 'URGENT')).toBe(true);
  });

  it('splits big assignments into research, draft and polish linked in order', () => {
    const plan = buildLifePlan(answers({ assignments: [{ title: 'History essay', dueDate: '2026-11-10', hours: 6 }, { title: 'Worksheet', dueDate: '2026-11-03', hours: 1 }] }), { now: NOW, tz: TZ });
    const essay = plan.tasks.filter((t) => t.title.includes('History essay'));
    expect(essay.map((t) => t.title)).toEqual(['🔎 Research: History essay', '✍️ Draft: History essay', '✅ Polish & submit: History essay']);
    expect(essay.map((t) => t.estimatedMinutes)).toEqual([90, 180, 90]);
    expect(essay[2].dependsOn).toEqual([essay[1].key]);
    const sheet = plan.tasks.find((t) => t.title === '📝 Worksheet')!;
    expect(sheet.priority).toBe('HIGH'); // due tomorrow evening, ~36h away
  });

  it('skips work that is already past due and says so', () => {
    const plan = buildLifePlan(answers({ assignments: [{ title: 'Old lab', dueDate: '2026-10-01', hours: 2 }] }), { now: NOW, tz: TZ });
    expect(plan.tasks).toHaveLength(0);
    expect(plan.insights.join(' ')).toContain('Old lab');
  });

  it('creates habits only on chosen days within the plan, never on days off', () => {
    const plan = buildLifePlan(answers({ horizon: 'WEEK', daysOff: [0], habits: [{ title: 'Gym', minutes: 45, weekdays: [0, 1, 3, 5] }] }), { now: NOW, tz: TZ });
    const days = plan.tasks.filter((t) => t.kind === 'HABIT').map((t) => DateTime.fromISO(t.dueAt!, { zone: TZ }).weekday % 7);
    expect(days.sort()).toEqual([1, 3, 5]);
  });

  it('a one-day plan has no weekly reviews; a month plan has one per subject per week', () => {
    const subjects = [{ name: 'Biology', difficulty: 2 as const }];
    expect(buildLifePlan(answers({ horizon: 'DAY', subjects }), { now: NOW, tz: TZ }).tasks).toHaveLength(0);
    const month = buildLifePlan(answers({ horizon: 'MONTH', subjects }), { now: NOW, tz: TZ });
    expect(month.tasks.filter((t) => t.kind === 'REVIEW')).toHaveLength(5);
  });

  it('marks overdue work tasks urgent', () => {
    const plan = buildLifePlan(answers({ persona: 'WORK', workTasks: [{ title: 'Q3 report', hours: 3, dueDate: '2026-10-30', priority: 'LOW' }, { title: 'Slides', hours: 2, dueDate: null, priority: 'HIGH' }] }), { now: NOW, tz: TZ });
    expect(plan.tasks.map((t) => [t.title, t.priority, t.dueAt === null])).toEqual([
      ['💼 Q3 report', 'URGENT', true],
      ['💼 Slides', 'HIGH', true],
    ]);
  });
});

describe('insights and events', () => {
  it('explains the plan in a friendly way and warns about short sleep', () => {
    const plan = buildLifePlan(answers({ chronotype: 'NIGHT_OWL', sleepTime: '01:00', wakeTime: '06:30', daysOff: [0] }), { now: NOW, tz: TZ });
    const text = plan.insights.join('\n');
    expect(text).toContain('night owl');
    expect(text).toContain('Sundays stay free');
    expect(text).toContain('5.5 hours of sleep');
  });

  it('expands the routine into dated events in the user timezone, skipping the past', () => {
    const routine = buildRoutine(answers({ meals: {}, classes: [{ title: 'Physics', weekdays: [1], start: '07:00', end: '09:00' }, { title: 'Late lab', weekdays: [2], start: '22:00', end: '24:00' }] }));
    const events = expandRoutine(routine, { now: NOW, tz: TZ, days: 8 });
    // Monday 07:00-09:00 is still running at 08:00, next Monday's is included too.
    expect(events.filter((e) => e.title === '🎓 Physics').map((e) => e.startAt.toISOString())).toEqual(['2026-11-02T01:30:00.000Z', '2026-11-09T01:30:00.000Z']);
    const lab = events.find((e) => e.title === '🎓 Late lab')!;
    expect(lab.endAt.toISOString()).toBe('2026-11-03T18:30:00.000Z'); // 24:00 = next midnight in Kolkata
  });
});
