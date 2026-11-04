import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { buildIcs, foldLine, icsDate, icsEscape } from '../../src/utils/ics.js';
import { computeProgress, levelFor, taskXp, xpForLevel, type DoneTask } from '../../src/progress/progress.js';

const day = 86_400_000;
const NOW = Date.parse('2026-11-04T06:00:00Z'); // Wednesday 11:30 in Kolkata

describe('iCalendar feed', () => {
  it('formats UTC times and escapes text', () => {
    expect(icsDate(new Date('2026-11-04T09:30:00.123Z'))).toBe('20261104T093000Z');
    expect(icsEscape('Revise: maths, physics; ch. 3\nbring notes \\ pens')).toBe('Revise: maths\\, physics\\; ch. 3\\nbring notes \\\\ pens');
  });

  it('folds long lines at 75 octets without splitting emoji', () => {
    const line = 'SUMMARY:' + '🧠 Revise Physics '.repeat(10);
    const folded = foldLine(line);
    for (const part of folded.split('\r\n')) expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(75);
    expect(folded.split('\r\n').map((p, i) => (i ? p.slice(1) : p)).join('')).toBe(line);
  });

  it('builds a valid calendar with CRLF line endings', () => {
    const ics = buildIcs({ name: "Asmitha's plan", now: new Date(NOW), events: [
      { uid: 'block-1@x', title: 'Draft essay', start: new Date('2026-11-05T12:30:00Z'), end: new Date('2026-11-05T14:00:00Z'), categories: ['📚 Studies'] },
      { uid: 'event-2@x', title: 'Lunch', start: new Date('2026-11-05T07:30:00Z'), end: new Date('2026-11-05T08:15:00Z'), transparent: true },
    ] });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain('DTSTART:20261105T123000Z');
    expect(ics).toContain('TRANSP:TRANSPARENT');
    expect(ics).toContain("X-WR-CALNAME:Asmitha's plan");
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/\n/);
  });
});

describe('progress: XP, levels, streaks, badges, weekly review', () => {
  const TZ = 'Asia/Kolkata';
  const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toJSDate();
  const task = (id: string, completedAt: string, mins = 60, title = 'Task', projectName = '📚 Studies'): DoneTask => ({ id, title, estimatedMinutes: mins, completedAt: at(completedAt), projectName });

  it('levels need 100 more XP each time', () => {
    expect([1, 2, 3, 4, 5].map(xpForLevel)).toEqual([0, 100, 300, 600, 1000]);
    expect(levelFor(0)).toEqual({ level: 1, xpIntoLevel: 0, xpForNext: 100 });
    expect(levelFor(350)).toEqual({ level: 3, xpIntoLevel: 50, xpForNext: 300 });
    expect(taskXp(60)).toBe(20);
    expect(taskXp(600)).toBe(50); // capped at 4h
  });

  it('counts the current streak through yesterday and the best streak ever', () => {
    const p = computeProgress({
      done: [
        task('a', '2026-10-20T10:00'), task('b', '2026-10-21T10:00'), task('c', '2026-10-22T10:00'), task('d', '2026-10-23T10:00'),
        task('e', '2026-11-02T10:00'), task('f', '2026-11-03T21:00'),
      ],
      blocks: [], firstScheduleAcceptedAt: null, tz: TZ, now: NOW,
    });
    expect(p.streak).toBe(2); // Mon + Tue, nothing yet on Wed morning
    expect(p.bestStreak).toBe(4);
    expect(p.doneToday).toBe(0);
    expect(p.totalDone).toBe(6);
    expect(p.xp).toBe(120);
    expect(p.level).toBe(2);
  });

  it('awards badges with the date they were earned', () => {
    const p = computeProgress({
      done: [
        task('1', '2026-11-01T06:30', 30), // Sunday early: early bird + weekend
        task('2', '2026-11-02T22:30', 150, '⚡ Final recap: Physics'), // night owl, deep diver, exam ready
        task('3', '2026-11-03T15:00', 60, 'Report', '💼 Work'), // balanced with Monday's study task
      ],
      blocks: [], firstScheduleAcceptedAt: new Date(NOW - day), tz: TZ, now: NOW,
    });
    const earned = Object.fromEntries(p.badges.map((b) => [b.id, b.earnedAt]));
    expect(earned['first-step']).toBe(at('2026-11-01T06:30').toISOString());
    expect(earned['early-bird']).not.toBeNull();
    expect(earned['weekend-warrior']).not.toBeNull();
    expect(earned['night-owl']).toBe(at('2026-11-02T22:30').toISOString());
    expect(earned['deep-diver']).toBe(earned['night-owl']);
    expect(earned['exam-ready']).toBe(earned['night-owl']);
    expect(earned['on-a-roll']).not.toBeNull(); // Sun, Mon, Tue
    expect(earned['balanced']).toBe(at('2026-11-03T15:00').toISOString());
    expect(earned['planner-pro']).not.toBeNull();
    expect(earned['ten-down']).toBeNull();
    expect(earned['unstoppable']).toBeNull();
  });

  it('summarises this week against last week', () => {
    const p = computeProgress({
      done: [task('x', '2026-10-28T10:00', 60), task('y', '2026-11-02T10:00', 90, 'Big one'), task('z', '2026-11-03T10:00', 30, 'Small', '💼 Work')],
      blocks: [
        { start: at('2026-11-02T09:00'), end: at('2026-11-02T10:30'), status: 'COMPLETED' },
        { start: at('2026-11-03T09:00'), end: at('2026-11-03T10:00'), status: 'CONFIRMED' }, // missed
        { start: at('2026-11-05T09:00'), end: at('2026-11-05T10:00'), status: 'CONFIRMED' }, // future
      ],
      firstScheduleAcceptedAt: null, tz: TZ, now: NOW,
    });
    const w = p.week.current;
    expect(w.weekStart).toBe('2026-11-02');
    expect(w.tasksDone).toBe(2);
    expect(w.minutesDone).toBe(120);
    expect(w.plannedMinutes).toBe(210);
    expect(w.followThrough).toBe(60); // 90 of 150 past minutes completed
    expect(w.wins[0].title).toBe('Big one');
    expect(w.byProject.map((x) => x.name)).toEqual(['📚 Studies', '💼 Work']);
    expect(p.week.previous.tasksDone).toBe(1);
    expect(p.week.message).toContain('1 more task');
  });
});
