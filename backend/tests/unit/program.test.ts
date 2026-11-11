import { describe, expect, it } from 'vitest';
import { expandProgram, plannedOn, programPreview, taskDates, type ProgramSpec, type ProgramTask } from '../../src/day/program.js';
import { chatTurn, parsePeriod, readPlanText, readRepeat, type ChatDraft } from '../../src/day/planChat.js';

const task = (over: Partial<ProgramTask>): ProgramTask => ({
  key: over.title ?? 'k', title: 'Task', minutes: 60, effort: 'MEDIUM', top: false, mustDo: false, fixedTime: null, notBefore: null, dueBy: null, repeat: 'DAILY', ...over,
});
// Mon 16 Nov 2026 .. Sun 29 Nov 2026
const spec = (over: Partial<ProgramSpec> = {}): ProgramSpec => ({
  title: 'Two weeks', startDate: '2026-11-16', days: 14, sameEveryDay: false, dayStart: '07:00', dayEnd: '22:00', peak: 'MORNING',
  commitments: [], windows: [], restDays: [], tasks: [], ...over,
});

describe('multi-day plans', () => {
  it('puts each task on the right days', () => {
    const s = spec({ restDays: [7] });
    expect(taskDates(s, task({ repeat: 'DAILY' }))).toHaveLength(12);
    expect(taskDates(s, task({ repeat: 'WEEKDAYS' }))).toHaveLength(10);
    expect(taskDates(s, task({ repeat: 'WEEKENDS' }))).toEqual(['2026-11-21', '2026-11-28']);
    expect(taskDates(s, task({ repeat: 'DAYS', days: [1, 4] }))).toEqual(['2026-11-16', '2026-11-19', '2026-11-23', '2026-11-26']);
    expect(taskDates(s, task({ repeat: 'WEEKLY', timesPerWeek: 3 }))).toHaveLength(6);
    expect(taskDates(s, task({ repeat: 'ONCE', date: '2026-11-20' }))).toEqual(['2026-11-20']);
    expect(taskDates(s, task({ repeat: 'DAILY', until: '2026-11-18' }))).toEqual(['2026-11-16', '2026-11-17', '2026-11-18']);
  });

  it('spreads a total goal over the days and keeps commitments to their weekdays', () => {
    const s = spec({
      tasks: [task({ title: 'Project', repeat: 'WEEKDAYS', totalMinutes: 20 * 60 })],
      commitments: [{ title: 'Work', start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] }],
    });
    const days = expandProgram(s);
    expect(days[0].tasks[0].minutes).toBe(120); // 20h over 10 weekdays
    expect(days[0].settings.commitments).toEqual([{ title: 'Work', start: '09:00', end: '18:00' }]);
    expect(days[5].settings.commitments).toBeUndefined(); // Saturday
    expect(plannedOn(s, '2026-11-21')).toEqual({ count: 0, minutes: 0 }); // Saturday: weekdays only
    expect(plannedOn(s, '2026-11-30')).toBeNull();
    const p = programPreview(s, { count: 7 });
    expect(p.days).toHaveLength(7);
    const mon = p.days[0].items.filter((i) => i.kind === 'TASK');
    for (const i of mon) expect(i.end <= 540 || i.start >= 1080).toBe(true);
    expect(p.summary!.perTask[0]).toMatchObject({ times: 10, minutesEach: 120, totalMinutes: 1200 });
  });

  it('reports days that don’t fit', () => {
    const s = spec({ days: 1, dayStart: '18:00', dayEnd: '20:00', tasks: [task({ title: 'A', minutes: 120 }), task({ title: 'B', minutes: 120 })] });
    expect(programPreview(s).summary!.overloaded).toHaveLength(1);
  });
});

describe('planner chat (built in)', () => {
  const ctx = { today: '2026-11-11', nowMin: 600, defaults: { dayStart: '07:30', dayEnd: '22:00', peak: 'MORNING' as const } };

  it('reads periods and repeats', () => {
    expect(parsePeriod('plan this week', ctx.today)).toMatchObject({ startDate: '2026-11-11', days: 5 });
    expect(parsePeriod('next 10 days', ctx.today)).toMatchObject({ days: 10 });
    expect(parsePeriod('monday to friday', ctx.today)).toMatchObject({ startDate: '2026-11-16', days: 5 });
    expect(parsePeriod('for 2 weeks starting monday', ctx.today)).toMatchObject({ startDate: '2026-11-16', days: 14 });
    expect(parsePeriod('this year', ctx.today)).toMatchObject({ days: 51 });
    expect(parsePeriod('leetcode 3 times a week', ctx.today)).toBeNull();
    expect(readRepeat('gym on mondays and thursdays').ann).toEqual({ repeat: 'DAYS', days: [1, 4] });
    expect(readRepeat('call mom on friday').ann).toEqual({ repeat: 'ONCE', onceWeekday: 5 });
  });

  it('keeps each task’s own repeat and the commitment’s weekdays', () => {
    const r = readPlanText('Plan my next 2 weeks: daily leetcode 1h, gym on weekdays at 7am, project 30 hours total and call mom on sunday. I work 9 to 6.', ctx);
    expect(r.period).toMatchObject({ startDate: '2026-11-11', days: 14 });
    expect(r.tasks.map((t) => [t.title, t.repeat])).toEqual([['Leetcode', 'DAILY'], ['Gym', 'WEEKDAYS'], ['Project', 'DAILY'], ['Call mom', 'ONCE']]);
    expect(r.tasks[1].fixedTime).toBe('07:00');
    expect(r.tasks[2].totalMinutes).toBe(1800);
    expect(r.tasks[3].date).toBe('2026-11-15');
    expect(r.commitments).toEqual([{ title: 'Work', start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] }]);
  });

  it('asks one question at a time, accepts “you decide”, takes changes and finalises', () => {
    let d: ChatDraft | null = null;
    const say = (m: string) => { const t = chatTurn(m, d, ctx); d = t.draft; return t; };
    let t = say('I need to study DSA, do gym and work on my project');
    expect(t.question!.id).toBe('period');
    t = say('This month');
    expect(t.draft.spec.days).toBe(20);
    expect(t.question!.id).toBe('same');
    t = say('Different days');
    expect(t.question!.id).toMatch(/^repeat:/);
    say('Every day');
    t = say('3 times a week');
    expect(t.draft.spec.tasks[1]).toMatchObject({ title: 'Gym', repeat: 'WEEKLY', timesPerWeek: 3 });
    t = say('you decide');
    expect(t.draft.spec.tasks[2].repeat).not.toBeNull();
    for (let i = 0; i < 12 && t.question?.id !== 'confirm'; i++) t = say(t.question!.id === 'top' ? 'DSA' : t.question!.id === 'fixed' ? 'Work 9am–6pm on weekdays' : t.question!.id === 'rest' ? 'Sundays off' : 'you decide');
    expect(t.ready).toBe(true);
    expect(t.draft.spec.tasks.find((x) => x.top)!.title).toBe('Study DSA');
    expect(t.draft.spec.restDays).toEqual([7]);
    t = say('gym only on weekends');
    expect(t.draft.spec.tasks[1].repeat).toBe('WEEKENDS');
    t = say('add reading 30 min daily');
    expect(t.draft.spec.tasks.at(-1)).toMatchObject({ title: 'Reading', minutes: 30, repeat: 'DAILY' });
    t = say('project takes 45 min');
    expect(t.draft.spec.tasks.find((x) => x.title === 'Project')!.minutes).toBe(45);
    t = say('leetcode 45 min');
    expect(t.changes).toEqual(['Added Leetcode.']); // a new task
    t = say('hmm whatever');
    expect(t.changes).toEqual([]);
    expect(t.question!.id).toMatch(/^repeat:/); // asks how often the new task happens
    expect(t.reply).toMatch(/didn’t/);
    t = say('make it 2 weeks');
    expect(t.draft.spec.days).toBe(14);
    t = say('Finalise');
    expect(t.finalize).toBe(true);
  });
});
