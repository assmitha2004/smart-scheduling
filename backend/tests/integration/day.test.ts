import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { DateTime } from 'luxon';
import { app, prisma, registerUser, resetDb } from './helpers.js';

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await prisma.$disconnect();
});

type Item = { kind: string; title: string; start: number; end: number; taskId: string | null };
const tomorrow = () => DateTime.utc().plus({ days: 1 }).toISODate()!;
const EXAMPLE = 'Work 9 to 6:30 today. After work I need to study Do 2 leetcode problems study some new technology and study my project and some core . i can spend 11:30-1:00 and 3-5 imbetween work for light study schedule .';

describe('My Day: work hours, free gaps and feedback', () => {
  it('keeps work hours free except the gaps, then applies feedback to the draft and the saved plan', async () => {
    const u = await registerUser();
    const date = tomorrow();
    const und = await request(app).post('/api/v1/day/understand').set(u.auth).send({ text: EXAMPLE, date }).expect(200);
    expect(und.body.settings.commitments).toEqual([{ title: 'Work', start: '09:00', end: '18:30' }]);
    expect(und.body.tasks.map((t: { title: string }) => t.title)).toEqual(['2 leetcode problems', 'Study new technology', 'Study my project', 'Study core']);
    const items: Item[] = und.body.preview.items;
    const work = items.filter((i) => i.kind === 'BUSY' && i.title === 'Work');
    expect(work.map((w) => [w.start, w.end])).toEqual([[540, 690], [780, 900], [1020, 1110]]);
    const tasks = items.filter((i) => i.kind === 'TASK');
    for (const t of tasks) for (const w of work) expect(t.start >= w.end || t.end <= w.start).toBe(true);
    // Some study happens in the gaps at work.
    expect(tasks.some((t) => t.start >= 690 && t.end <= 780)).toBe(true);

    // Feedback on the draft: nothing is saved yet.
    const fb = await request(app).post('/api/v1/day/feedback').set(u.auth)
      .send({ date, text: 'move leetcode to 9pm, core takes 2 hours. more breaks', draft: { settings: und.body.settings, tasks: und.body.tasks } }).expect(200);
    expect(fb.body.changes).toHaveLength(3);
    expect(fb.body.settings.breaks).toBe('LONG');
    const leet = (fb.body.preview.items as Item[]).find((i) => i.kind === 'TASK' && /leetcode/i.test(i.title))!;
    expect(leet.start).toBe(21 * 60);
    expect(await prisma.task.count()).toBe(0);

    // Save, then give feedback on the saved plan.
    await request(app).post('/api/v1/day/plan').set(u.auth).send({ date, settings: fb.body.settings, tasks: fb.body.tasks }).expect(200);
    const saved = await request(app).post('/api/v1/day/feedback').set(u.auth).send({ date, text: 'study new technology tomorrow' }).expect(200);
    expect(saved.body.changes).toEqual(['Moved “Study new technology” to tomorrow.']);
    const moved = await prisma.task.findFirstOrThrow({ where: { title: 'Study new technology' } });
    expect(moved.plannedDate).toBe(DateTime.fromISO(date).plus({ days: 1 }).toISODate());
    const nope = await request(app).post('/api/v1/day/feedback').set(u.auth).send({ date, text: 'hmm whatever' }).expect(200);
    expect(nope.body.changes).toEqual([]);
    expect(nope.body.notUnderstood).toEqual(['hmm whatever']);
    expect(nope.body.help).toContain('Try');
  });
});
