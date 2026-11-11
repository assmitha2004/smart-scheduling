import { describe, expect, it } from 'vitest';
import { applyFeedback, sameTask, type FeedbackSettings, type FeedbackTask } from '../../src/day/feedback.js';
import { findRanges, understandDay } from '../../src/day/understand.js';

const settings: FeedbackSettings = { dayStart: '08:00', dayEnd: '22:00', peak: 'EVENING', commitments: [{ title: 'Work', start: '09:00', end: '18:30' }] };
const task = (title: string, minutes = 60, extra: Partial<FeedbackTask> = {}): FeedbackTask => ({ title, minutes, mustDo: false, top: false, effort: 'HARD', fixedTime: null, notBefore: null, dueBy: null, ...extra });
const tasks = () => [task('2 leetcode problems'), task('Study new technology', 90), task('Study my project', 90), task('Study core', 90), task('Gym', 60, { effort: 'MEDIUM' })];

describe('reading a work day with gaps', () => {
  it('turns work hours into a commitment, the gaps into free time, and splits a run-on list', () => {
    const u = understandDay('Work 9 to 6:30 today. After work I need to study Do 2 leetcode problems study some new technology and study my project and some core . i can spend 11:30-1:00 and 3-5 imbetween work for light study schedule .');
    expect(u.commitments).toEqual([{ title: 'Work', start: '09:00', end: '18:30' }]);
    expect(u.windows).toEqual([{ start: '11:30', end: '13:00', light: true }, { start: '15:00', end: '17:00', light: true }]);
    expect(u.tasks.map((t) => t.title)).toEqual(['2 leetcode problems', 'Study new technology', 'Study my project', 'Study core']);
    expect(u.tasks.map((t) => t.title)).not.toContain('Work 9 to');
  });

  it('puts "after work" tasks after the work commitment ends', () => {
    const u = understandDay('Office 10am-7pm. After work gym and call mom');
    expect(u.commitments[0]).toMatchObject({ start: '10:00', end: '19:00' });
    expect(u.tasks.map((t) => [t.title, t.notBefore])).toEqual([['Gym', '19:00'], ['Call mom', '19:00']]);
  });

  it('reads ranges the way people say them', () => {
    const r = (s: string) => findRanges(s).map((x) => [x.start, x.end]);
    expect(r('9 to 6:30')).toEqual([['09:00', '18:30']]);
    expect(r('11:30-1:00 and 3-5')).toEqual([['11:30', '13:00'], ['15:00', '17:00']]);
    expect(r('3-5pm')).toEqual([['15:00', '17:00']]);
    expect(r('between 2 and 4')).toEqual([['14:00', '16:00']]);
    expect(r('leetcode 1-2 hours')).toEqual([]);
  });

  it('matches today’s wording to tasks carried over', () => {
    expect(sameTask('2 leetcode problems', 'Leetcode')).toBe(true);
    expect(sameTask('Study my project', 'Projects')).toBe(true);
    expect(sameTask('Study core', 'Core')).toBe(true);
    expect(sameTask('Study new technology', 'Core')).toBe(false);
  });
});

describe('feedback on a plan', () => {
  it('moves, resizes, prioritises and removes tasks named loosely', () => {
    const r = applyFeedback('move leetcode to 9pm. core takes 2 hours, project first and remove gym', settings, tasks());
    const by = (t: string) => r.tasks.find((x) => x.title.toLowerCase().includes(t))!;
    expect(by('leetcode').fixedTime).toBe('21:00');
    expect(by('core').minutes).toBe(120);
    expect(by('project')).toMatchObject({ top: true, mustDo: true });
    expect(r.tasks.find((x) => x.title === 'Gym')).toBeUndefined();
    expect(r.removed).toEqual([{ task: expect.objectContaining({ title: 'Gym' }), tomorrow: false }]);
    expect(r.changes).toHaveLength(4);
    expect(r.notUnderstood).toEqual([]);
  });

  it('handles busy and free time, day hours, breaks and sessions', () => {
    const r = applyFeedback('I’m busy 7-8pm for a call. I’m free 1 to 2. Nothing after 10:30pm. More breaks. Shorter sessions', settings, tasks());
    expect(r.settings.commitments).toContainEqual({ title: 'Call', start: '19:00', end: '20:00' });
    expect(r.settings.windows).toEqual([{ start: '13:00', end: '14:00', light: false }]);
    expect(r.settings.dayEnd).toBe('22:30');
    expect(r.settings.breaks).toBe('LONG');
    expect(r.settings.maxSession).toBe(45);
  });

  it('moves things to tomorrow, lightens the day, adds tasks and admits what it didn’t get', () => {
    const r = applyFeedback('gym tomorrow. add read 30 mins. blah blah', settings, tasks());
    expect(r.removed).toEqual([{ task: expect.objectContaining({ title: 'Gym' }), tomorrow: true }]);
    expect(r.tasks.find((t) => t.title === 'Read')).toMatchObject({ minutes: 30 });
    expect(r.notUnderstood).toEqual(['blah blah']);
    const light = applyFeedback('too much for today', settings, tasks());
    expect(light.removed.length).toBeGreaterThan(0);
    expect(light.removed.every((x) => x.tomorrow)).toBe(true);
  });

  it('moves a task to a part of the day or after work', () => {
    const r = applyFeedback('do core in the morning. leetcode after work', settings, tasks());
    expect(r.tasks.find((t) => t.title === 'Study core')).toMatchObject({ notBefore: '06:00', dueBy: '12:00' });
    expect(r.tasks.find((t) => t.title.includes('leetcode'))!.notBefore).toBe('18:30');
  });
});
