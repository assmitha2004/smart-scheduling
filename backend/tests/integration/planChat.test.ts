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

const today = () => DateTime.utc().toISODate()!;
const plus = (n: number) => DateTime.utc().plus({ days: n }).toISODate()!;

describe('Planner chat and multi-day plans', () => {
  it('chats, finalises a plan starting tomorrow, shows projected days, then makes them real on the day', async () => {
    const u = await registerUser();
    const chat = (message: string, draft: unknown) => request(app).post('/api/v1/day/plan-chat').set(u.auth).send({ message, draft }).expect(200);

    let r = await chat('For 5 days starting tomorrow: leetcode 1h daily, gym 45 min on weekends and reading 30 min every day. I work 9 to 6 on weekdays.', null);
    expect(r.body.source).toBe('rules');
    expect(r.body.draft.spec).toMatchObject({ startDate: plus(1), days: 5 });
    expect(r.body.draft.spec.commitments).toEqual([{ title: 'Work', start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] }]);
    expect(r.body.question).toBeTruthy();
    expect(r.body.preview.days).toHaveLength(5);
    // Answer “you decide” until it is ready.
    for (let i = 0; i < 10 && r.body.question?.id !== 'confirm'; i++) r = await chat('you decide', r.body.draft);
    expect(r.body.ready).toBe(true);
    r = await chat('Finalise', r.body.draft);
    expect(r.body.finalize).toBe(true);
    expect(await prisma.planProgram.count()).toBe(0); // nothing saved by the chat itself

    const fin = await request(app).post('/api/v1/day/plan-chat/finalize').set(u.auth).send({ spec: r.body.draft.spec }).expect(201);
    expect(fin.body.program).toMatchObject({ startDate: plus(1), endDate: plus(5), totalDays: 5, dayNumber: 1 });
    // A later day isn't real yet, but shows what it will look like.
    expect(fin.body.day.tasks).toEqual([]);
    expect(fin.body.day.projected.items.some((i: { title: string }) => i.title === 'Leetcode')).toBe(true);
    expect(fin.body.day.programs[0].title).toContain('plan');

    const progress = await request(app).get('/api/v1/day/progress').query({ from: today(), to: plus(6) }).set(u.auth).expect(200);
    expect(progress.body.days).toHaveLength(7);
    expect(progress.body.days[1]).toMatchObject({ projected: true, inPlan: true });
    expect(progress.body.days[1].planned).toBeGreaterThanOrEqual(2);
    expect(progress.body.days[6].inPlan).toBe(false);
    expect((await request(app).get('/api/v1/day/programs').set(u.auth).expect(200)).body.programs).toHaveLength(1);
  });

  it('a plan starting today becomes tasks right away, once, and counts toward progress', async () => {
    const u = await registerUser();
    let r = await request(app).post('/api/v1/day/plan-chat').set(u.auth).send({ message: 'today: study 1h and call mom 15 min' }).expect(200);
    expect(r.body.draft.spec).toMatchObject({ startDate: today(), days: 1 });
    r = await request(app).post('/api/v1/day/plan-chat').set(u.auth).send({ message: 'finalise', draft: r.body.draft }).expect(200);
    expect(r.body.finalize).toBe(true);
    const fin = await request(app).post('/api/v1/day/plan-chat/finalize').set(u.auth).send({ spec: r.body.draft.spec }).expect(201);
    expect(fin.body.day.tasks.map((t: { title: string }) => t.title).sort()).toEqual(['Call mom', 'Study']);
    // Opening the day again doesn't add them twice.
    const day = await request(app).get('/api/v1/day').set(u.auth).expect(200);
    expect(day.body.tasks).toHaveLength(2);
    await request(app).post(`/api/v1/day/tasks/${day.body.tasks[0].id}/done`).set(u.auth).send({}).expect(200);
    const p = await request(app).get('/api/v1/day/progress').query({ from: today(), to: today() }).set(u.auth).expect(200);
    expect(p.body.totals).toMatchObject({ planned: 2, done: 1, rate: 50 });
    expect(p.body.streak).toBe(1);
  });

  it('a new plan replaces an overlapping one and validates input', async () => {
    const u = await registerUser();
    const spec = { title: '', startDate: plus(1), days: 7, sameEveryDay: true, dayStart: '08:00', dayEnd: '22:00', peak: 'MORNING', tasks: [{ key: 'a', title: 'Gym', minutes: 60 }] };
    await request(app).post('/api/v1/day/plan-chat/finalize').set(u.auth).send({ spec }).expect(201);
    const second = await request(app).post('/api/v1/day/plan-chat/finalize').set(u.auth).send({ spec: { ...spec, startDate: plus(3), days: 3 } }).expect(201);
    expect(second.body.replaced).toBe(1);
    const first = await prisma.planProgram.findFirstOrThrow({ where: { startDate: plus(1) } });
    expect(first.endDate).toBe(plus(2));
    await request(app).post('/api/v1/day/plan-chat/finalize').set(u.auth).send({ spec: { ...spec, tasks: [] } }).expect(400);
    await request(app).post('/api/v1/day/plan-chat/finalize').set(u.auth).send({ spec: { ...spec, days: 400 } }).expect(400);
    await request(app).get('/api/v1/day/progress').query({ from: plus(5), to: plus(1) }).set(u.auth).expect(400);
    const other = await registerUser('Other');
    await request(app).delete(`/api/v1/day/programs/${first.id}`).set(other.auth).expect(404);
    await request(app).delete(`/api/v1/day/programs/${first.id}`).set(u.auth).expect(200);
  });
});
