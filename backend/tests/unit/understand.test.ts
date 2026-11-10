import { describe, expect, it } from 'vitest';
import { splitClauses, understandDay } from '../../src/day/understand.js';

const byTitle = (u: ReturnType<typeof understandDay>, t: string) => u.tasks.find((x) => x.title.toLowerCase().includes(t))!;

describe('understanding a day described in words', () => {
  it('reads a typical student day', () => {
    const u = understandDay('I wake up at 7. I have to revise maths for 2 hours, that is the most important. Then gym after lunch, call mom at 7pm and maybe buy groceries if I have time. I focus best in the morning. I sleep at 11.');
    expect(u.settings).toEqual({ dayStart: '07:30', dayEnd: '22:30', peak: 'MORNING' });
    expect(u.tasks.map((t) => t.title)).toEqual(['Revise maths', 'Gym', 'Call mom', 'Buy groceries']);
    expect(byTitle(u, 'maths')).toMatchObject({ minutes: 120, mustDo: true, top: true, effort: 'HARD', minutesGuessed: false });
    expect(byTitle(u, 'gym')).toMatchObject({ notBefore: '14:00', mustDo: false });
    expect(byTitle(u, 'call mom')).toMatchObject({ fixedTime: '19:00', minutes: 15 });
    expect(byTitle(u, 'groceries')).toMatchObject({ mustDo: false, top: false });
  });

  it('reads a work day with deadlines and windows', () => {
    const u = understandDay('Need to finish the quarterly report by 5pm, it is urgent. Reply to emails in the morning, quick. Team meeting at 3 for 1 hour. Go for a run in the evening.');
    expect(byTitle(u, 'report')).toMatchObject({ dueBy: '17:00', mustDo: true, effort: 'HARD' });
    expect(byTitle(u, 'emails')).toMatchObject({ notBefore: '06:00', dueBy: '12:00', minutes: 15, effort: 'EASY' });
    expect(byTitle(u, 'meeting')).toMatchObject({ fixedTime: '15:00', minutes: 60 });
    expect(byTitle(u, 'run')).toMatchObject({ notBefore: '17:00', dueBy: '22:00' });
    expect(u.tasks.map((t) => t.title)).not.toContain('Quick');
    const v = understandDay('Reply to emails, quick. Fix the login bug, urgent');
    expect(v.tasks.map((t) => [t.title, t.effort, t.mustDo])).toEqual([['Reply to emails', 'EASY', false], ['Fix the login bug', 'MEDIUM', true]]);
  });

  it('plans tomorrow when asked, but not just because an exam is tomorrow', () => {
    expect(understandDay('Tomorrow I need to clean my room and do laundry').date).toBe('tomorrow');
    expect(understandDay('My exam is tomorrow so I must study physics 3h').date).toBe('today');
  });

  it('splits lists and "and" only between tasks', () => {
    expect(splitClauses('call mom and dad, then study. read a book and go for a walk')).toEqual(['call mom and dad', 'study', 'read a book', 'go for a walk']);
    const u = understandDay('leetcode 1h, projects 1.5h, core subjects 45 mins');
    expect(u.tasks.map((t) => [t.title, t.minutes])).toEqual([['Leetcode', 60], ['Projects', 90], ['Core subjects', 45]]);
  });

  it('keeps only one #1 priority and ignores chit-chat', () => {
    const u = understandDay('Please plan my day. Project demo is my top priority. Also the essay is the most important thing. Thanks!');
    expect(u.tasks.filter((t) => t.top).map((t) => t.title)).toEqual(['Project demo']);
    expect(u.tasks.map((t) => t.title)).toEqual(['Project demo', 'Essay']);
  });

  it('notes guessed durations', () => {
    const u = understandDay('write blog post, do the dishes');
    expect(u.notes[0]).toContain('estimated');
  });
});

describe('"I have all this to do and I don’t know how to organise it"', () => {
  it('pulls the tasks out of a vague list and ignores the feelings', () => {
    const u = understandDay("I have so many things: emails, report, gym, calling the bank. No idea where to start, please help me organise my day");
    expect(u.tasks.map((t) => t.title)).toEqual(['Emails', 'Report', 'Gym', 'Calling the bank']);
    const v = understandDay("i have to do my dbms assignment and os project and also cook and clean my room. I don't know how to organise it");
    expect(v.tasks.map((t) => t.title)).toEqual(['Dbms assignment', 'Os project', 'Cook', 'Clean my room']);
    expect(v.tasks.slice(0, 2).every((t) => t.effort === 'HARD')).toBe(true);
  });
});
