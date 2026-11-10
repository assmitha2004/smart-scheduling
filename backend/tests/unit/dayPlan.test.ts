import { describe, expect, it } from 'vitest';
import { compliment, energyAt, parseBrainDump, parseTaskLine, planDay, sessions, toMin, type DayTaskInput } from '../../src/day/dayPlan.js';

const task = (id: string, minutes: number, over: Partial<DayTaskInput> = {}): DayTaskInput => ({ id, title: id, minutes, mustDo: false, top: false, effort: 'MEDIUM', fixedTime: null, ...over });
const tasksOf = (r: ReturnType<typeof planDay>) => r.items.filter((i) => i.kind === 'TASK');
const noOverlap = (r: ReturnType<typeof planDay>) => {
  const xs = r.items.filter((i) => i.kind !== 'BREAK').sort((a, b) => a.start - b.start);
  for (let i = 1; i < xs.length; i++) expect(xs[i].start).toBeGreaterThanOrEqual(xs[i - 1].end);
};

describe('parsing a brain dump', () => {
  it('reads durations, fixed times and bullet points', () => {
    expect(parseTaskLine('finish report 2h')).toEqual({ title: 'Finish report', minutes: 120, minutesGuessed: false, effort: 'HARD', fixedTime: null });
    expect(parseTaskLine('- gym for 45 mins')).toMatchObject({ title: 'Gym', minutes: 45, minutesGuessed: false });
    expect(parseTaskLine('call mom at 6pm')).toMatchObject({ title: 'Call mom', minutes: 15, minutesGuessed: true, fixedTime: '18:00', effort: 'EASY' });
    expect(parseTaskLine('team meeting 10:30 1 hour')).toMatchObject({ title: 'Team meeting', minutes: 60, fixedTime: '10:30' });
    expect(parseTaskLine('study physics 1.5 hrs')).toMatchObject({ minutes: 90, effort: 'HARD' });
    expect(parseTaskLine('read half an hour')).toMatchObject({ title: 'Read', minutes: 30 });
    expect(parseTaskLine('dentist 9am')).toMatchObject({ title: 'Dentist', fixedTime: '09:00' });
    expect(parseTaskLine('2. buy milk')).toMatchObject({ title: 'Buy milk', minutes: 30, minutesGuessed: true });
    expect(parseTaskLine('   ')).toBeNull();
  });

  it('splits lines and comma lists, ignores blanks', () => {
    const tasks = parseBrainDump('study maths 2h\n\nlaundry, groceries, call bank\nreply emails 20m');
    expect(tasks.map((t) => t.title)).toEqual(['Study maths', 'Laundry', 'Groceries', 'Call bank', 'Reply emails']);
    expect(tasks.map((t) => t.minutes)).toEqual([120, 30, 45, 15, 20]);
  });
});

describe('planning a day', () => {
  it('puts the #1 priority first and never overlaps meals or meetings', () => {
    const r = planDay({
      dayStart: toMin('09:00'), dayEnd: toMin('18:00'), peak: 'MORNING',
      busy: [{ title: 'Lunch', start: toMin('13:00'), end: toMin('13:45'), kind: 'BREAK' }, { title: 'Standup', start: toMin('10:00'), end: toMin('10:15'), kind: 'BUSY' }],
      tasks: [task('emails', 15, { effort: 'EASY' }), task('report', 90, { top: true, effort: 'HARD' }), task('gym', 60)],
    });
    noOverlap(r);
    // 9:00-10:00 is too short for 90 minutes, so the #1 task takes the first slot that fits.
    expect(tasksOf(r).find((i) => i.taskId === 'report')).toMatchObject({ start: toMin('10:15'), end: toMin('11:45') });
    expect(r.overflow).toEqual([]);
    expect(r.insights[0]).toContain('#1 priority');
  });

  it('puts hard work at peak energy and easy work outside it', () => {
    const r = planDay({
      dayStart: toMin('08:00'), dayEnd: toMin('23:00'), peak: 'EVENING', busy: [],
      tasks: [task('essay', 60, { effort: 'HARD' }), task('laundry', 30, { effort: 'EASY' })],
    });
    const essay = tasksOf(r).find((i) => i.taskId === 'essay')!;
    const laundry = tasksOf(r).find((i) => i.taskId === 'laundry')!;
    expect(energyAt('EVENING', (essay.start + essay.end) / 2)).toBe(10);
    expect(energyAt('EVENING', laundry.start)).toBeLessThan(10);
    expect(essay.reason).toContain('full brain');
  });

  it('splits long tasks into sessions with breaks, in order', () => {
    expect(sessions(200, 90)).toEqual([70, 65, 65]);
    expect(sessions(60, 90)).toEqual([60]);
    const r = planDay({ dayStart: toMin('09:00'), dayEnd: toMin('20:00'), peak: 'DAYTIME' as never, busy: [], tasks: [task('thesis', 180, { mustDo: true, effort: 'HARD' })] });
    const parts = tasksOf(r);
    expect(parts.map((p) => p.part)).toEqual([1, 2]);
    expect(parts[1].start).toBeGreaterThanOrEqual(parts[0].end + 15);
    expect(r.items.some((i) => i.kind === 'BREAK')).toBe(true);
  });

  it('keeps fixed-time tasks at their time', () => {
    const r = planDay({ dayStart: toMin('09:00'), dayEnd: toMin('21:00'), peak: 'MORNING', busy: [], tasks: [task('call mom', 15, { fixedTime: '18:00' }), task('study', 120, { effort: 'HARD' })] });
    expect(tasksOf(r).find((i) => i.taskId === 'call mom')).toMatchObject({ start: toMin('18:00'), end: toMin('18:15') });
    noOverlap(r);
  });

  it('moves what does not fit to tomorrow and says so honestly', () => {
    const r = planDay({
      dayStart: toMin('17:00'), dayEnd: toMin('20:00'), peak: 'AFTERNOON', busy: [],
      tasks: [task('a', 90, { mustDo: true }), task('b', 90, { mustDo: true }), task('c', 60)],
    });
    expect(r.overflow.map((o) => o.taskId).sort()).toEqual(expect.arrayContaining(r.overflow.map((o) => o.taskId)));
    expect(r.overflow.length).toBeGreaterThanOrEqual(1);
    expect(tasksOf(r).every((i) => i.end <= toMin('20:00'))).toBe(true);
    // Must-dos are placed before the optional task gets a slot.
    const placed = new Set(tasksOf(r).map((i) => i.taskId));
    expect(placed.has('a')).toBe(true);
    expect(r.insights.join(' ')).toMatch(/tomorrow/);
  });

  it('a fixed time outside the day goes to tomorrow', () => {
    const r = planDay({ dayStart: toMin('09:00'), dayEnd: toMin('17:00'), peak: 'MORNING', busy: [], tasks: [task('party', 60, { fixedTime: '20:00' })] });
    expect(r.overflow.map((o) => o.taskId)).toEqual(['party']);
  });

  it('carried-over tasks come before ordinary ones', () => {
    const r = planDay({ dayStart: toMin('09:00'), dayEnd: toMin('12:00'), peak: 'MORNING', busy: [], tasks: [task('new', 60), task('old', 60, { fromEarlier: true })] });
    expect(tasksOf(r)[0].taskId).toBe('old');
  });
});

describe('compliments', () => {
  it('celebrates the right moment', () => {
    expect(compliment({ done: 4, total: 4, wasTop: false, seed: 0 })).toMatch(/done|complete/i);
    expect(compliment({ done: 2, total: 5, wasTop: true, seed: 0 })).toMatch(/priority|Biggest/);
    expect(compliment({ done: 1, total: 5, wasTop: false, seed: 1 })).toMatch(/start/i);
  });
});

describe('fitting must-dos into small gaps', () => {
  it('splits a must-do into shorter sessions rather than dropping it for an optional task', () => {
    const r = planDay({
      dayStart: toMin('18:10'), dayEnd: toMin('20:00'), peak: 'AFTERNOON',
      busy: [{ title: 'Call', start: toMin('19:00'), end: toMin('19:20'), kind: 'BUSY' }],
      tasks: [task('lab', 60, { mustDo: true, effort: 'HARD' }), task('groceries', 45, { effort: 'EASY' })],
    });
    const lab = r.items.filter((i) => i.taskId === 'lab');
    expect(lab.length).toBe(2);
    expect(lab.reduce((s, i) => s + i.end - i.start, 0)).toBe(60);
    expect(r.overflow.map((o) => o.taskId)).toEqual(['groceries']);
    noOverlap(r);
  });
});

describe('time windows from the prompt', () => {
  it('respects "after lunch" and "by 5pm"', () => {
    const r = planDay({
      dayStart: toMin('09:00'), dayEnd: toMin('21:00'), peak: 'MORNING',
      busy: [{ title: 'Lunch', start: toMin('13:00'), end: toMin('13:45'), kind: 'BREAK' }],
      tasks: [task('groceries', 45, { effort: 'EASY', notBefore: '14:00' }), task('report', 120, { effort: 'HARD', mustDo: true, dueBy: '17:00' })],
    });
    const g = tasksOf(r).find((i) => i.taskId === 'groceries')!;
    expect(g.start).toBeGreaterThanOrEqual(toMin('14:00'));
    expect(tasksOf(r).filter((i) => i.taskId === 'report').every((i) => i.end <= toMin('17:00'))).toBe(true);
    expect(g.reason).toContain('After 2pm');
  });

  it('places a task anyway (and says so) when its window is impossible', () => {
    const r = planDay({ dayStart: toMin('18:00'), dayEnd: toMin('22:00'), peak: 'EVENING', busy: [], tasks: [task('emails', 30, { dueBy: '12:00' })] });
    expect(tasksOf(r)).toHaveLength(1);
    expect(r.insights.join(' ')).toContain('couldn’t fit “emails” before 12pm');
  });
});
