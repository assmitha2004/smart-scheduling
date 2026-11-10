import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, prisma, registerUser, resetDb, setAlwaysAvailable } from './helpers.js';
import { carryOverMissed } from '../../src/modules/day/day.routes.js';

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await prisma.$disconnect();
});

type DayTask = { id: string; title: string; estimatedMinutes: number; priority: string; dueAt: string | null };

async function planToday(auth: Record<string, string>, energy?: string) {
  const preview = await request(app).post('/api/v1/schedules/preview').set(auth).send({ horizon: 'DAY', ...(energy ? { energy } : {}) }).expect(200);
  return preview.body as { recommendationId: string; scheduleVersion: number; proposedBlocks: { taskId: string; startAt: string; endAt: string }[] };
}

describe('my day', () => {
  it('saves brain-dump tasks (with and without a time) into "My tasks" and updates existing ones', async () => {
    const u = await registerUser();
    const res = await request(app)
      .post('/api/v1/day/tasks')
      .set(u.auth)
      .send({ tasks: [
        { title: 'Finish OS assignment', minutes: 120, priority: 'URGENT', due: 'TODAY' },
        { title: 'Pay electricity bill', minutes: 15, priority: 'MEDIUM', due: 'NONE' },
      ] })
      .expect(201);
    const [os, bill] = res.body.tasks as DayTask[];
    expect(os.estimatedMinutes).toBe(120);
    expect(os.dueAt).not.toBeNull();
    expect(bill.dueAt).toBeNull();
    const project = await prisma.project.findFirstOrThrow({ where: { tasks: { some: { id: os.id } } } });
    expect(project.name).toBe('📝 My tasks');

    // Re-answering the questions updates the same task instead of duplicating it.
    await prisma.task.update({ where: { id: os.id }, data: { actualMinutes: 30 } });
    const upd = await request(app)
      .post('/api/v1/day/tasks')
      .set(u.auth)
      .send({ tasks: [{ id: os.id, title: 'Finish OS assignment', minutes: 60, priority: 'HIGH', due: 'TOMORROW' }] })
      .expect(201);
    expect(upd.body.tasks[0].estimatedMinutes).toBe(90); // 30 logged + 60 still needed
    expect(upd.body.tasks[0].priority).toBe('HIGH');
    expect(await prisma.task.count()).toBe(2);
  });

  // Needs a few hours left in the (UTC) day to place today's sessions.
  it.skipIf(new Date().getUTCHours() >= 21)('plans the day, tracks sessions (done / partly / skip / undo) and finishes tasks', async () => {
    const u = await registerUser();
    await setAlwaysAvailable(u.auth);
    const created = await request(app).post('/api/v1/day/tasks').set(u.auth)
      .send({ tasks: [{ title: 'Study DBMS', minutes: 60, priority: 'HIGH', due: 'NONE' }, { title: 'Read', minutes: 30, priority: 'LOW', due: 'NONE' }] }).expect(201);
    const [study, read] = created.body.tasks as DayTask[];
    const preview = await planToday(u.auth, 'LOW');
    // Low energy: sessions are at most 30 minutes.
    for (const b of preview.proposedBlocks) expect(Date.parse(b.endAt) - Date.parse(b.startAt)).toBeLessThanOrEqual(30 * 60_000);
    await request(app).post('/api/v1/schedules/commit').set(u.auth).send({ recommendationId: preview.recommendationId, expectedVersion: preview.scheduleVersion }).expect(200);

    const day = await request(app).get('/api/v1/day').set(u.auth).expect(200);
    expect(day.body.blocks.length).toBeGreaterThan(0);
    const studyBlocks = day.body.blocks.filter((b: { taskId: string }) => b.taskId === study.id);
    expect(studyBlocks.length).toBeGreaterThanOrEqual(2);

    // Partly done: 10 of 30 minutes.
    const p = await request(app).post(`/api/v1/day/blocks/${studyBlocks[0].id}`).set(u.auth).send({ action: 'partial', minutes: 10 }).expect(200);
    expect(p.body.loggedMinutes).toBe(10);
    expect(p.body.task.actualMinutes).toBe(10);
    expect(p.body.task.status).toBe('IN_PROGRESS');
    // Undo, then mark done.
    await request(app).post(`/api/v1/day/blocks/${studyBlocks[0].id}`).set(u.auth).send({ action: 'undo' }).expect(200);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: study.id } })).actualMinutes).toBe(0);
    await request(app).post(`/api/v1/day/blocks/${studyBlocks[0].id}`).set(u.auth).send({ action: 'done' }).expect(200);
    // Tracking twice is rejected.
    await request(app).post(`/api/v1/day/blocks/${studyBlocks[0].id}`).set(u.auth).send({ action: 'done' }).expect(400);

    // Finishing the whole task early cancels its other upcoming sessions.
    const fin = await request(app).post(`/api/v1/day/blocks/${studyBlocks[1].id}`).set(u.auth).send({ action: 'finish' }).expect(200);
    expect(fin.body.taskDone).toBe(true);
    expect(await prisma.scheduledBlock.count({ where: { taskId: study.id, status: 'CONFIRMED' } })).toBe(0);

    // Skipping keeps the work on the task.
    const readBlock = day.body.blocks.find((b: { taskId: string }) => b.taskId === read.id);
    await request(app).post(`/api/v1/day/blocks/${readBlock.id}`).set(u.auth).send({ action: 'skip' }).expect(200);
    const after = await request(app).get('/api/v1/day').set(u.auth).expect(200);
    const openRead = after.body.openTasks.find((t: { id: string }) => t.id === read.id);
    expect(openRead.remainingMinutes).toBe(30);
    expect(after.body.stats.sessionsDone).toBe(2);
  });

  it('carries sessions missed on earlier days over to the next plan', async () => {
    const u = await registerUser();
    await setAlwaysAvailable(u.auth);
    const created = await request(app).post('/api/v1/day/tasks').set(u.auth)
      .send({ tasks: [{ title: 'Write report', minutes: 90, priority: 'HIGH', due: 'NONE' }] }).expect(201);
    const task = created.body.tasks[0] as DayTask;
    // Yesterday: one session done (30 min), one never checked off.
    const y = Date.now() - 86_400_000;
    const startOfYesterday = new Date(new Date(y).toISOString().slice(0, 10) + 'T09:00:00Z').getTime();
    await prisma.scheduledBlock.createMany({ data: [
      { taskId: task.id, userId: u.userId, startAt: new Date(startOfYesterday), endAt: new Date(startOfYesterday + 30 * 60_000), status: 'COMPLETED', scheduleVersion: 0 },
      { taskId: task.id, userId: u.userId, startAt: new Date(startOfYesterday + 60 * 60_000), endAt: new Date(startOfYesterday + 120 * 60_000), status: 'CONFIRMED', scheduleVersion: 0 },
    ] });
    await prisma.task.update({ where: { id: task.id }, data: { actualMinutes: 30, status: 'IN_PROGRESS' } });

    const day = await request(app).get('/api/v1/day').set(u.auth).expect(200);
    expect(day.body.missed.blocks).toBe(1);
    expect(day.body.missed.tasks[0].title).toBe('Write report');
    expect(day.body.openTasks[0].carried).toBe(true);

    const carried = await request(app).post('/api/v1/day/carry-over').set(u.auth).expect(200);
    expect(carried.body.blocks).toBe(1);
    expect((await request(app).get('/api/v1/day').set(u.auth)).body.missed.blocks).toBe(0);
    expect((await carryOverMissed(u.userId, 'UTC')).blocks).toBe(0);

    // Only the remaining 60 minutes are planned again.
    const preview = await planToday(u.auth);
    const planned = preview.proposedBlocks.filter((b) => b.taskId === task.id).reduce((s, b) => s + (Date.parse(b.endAt) - Date.parse(b.startAt)) / 60_000, 0);
    // Late in the UTC day there may be less than an hour left; never more than what remains.
    expect(planned).toBeLessThanOrEqual(60);
  });

  it('plans inside a "free from … until …" window for today instead of the usual working hours', async () => {
    const u = await registerUser();
    // Usual working hours: none at all.
    await request(app).put('/api/v1/availability').set(u.auth).send({ rules: [] }).expect(200);
    await request(app).post('/api/v1/day/tasks').set(u.auth).send({ tasks: [{ title: 'Revise', minutes: 30, priority: 'HIGH', due: 'NONE' }] }).expect(201);
    const none = await request(app).post('/api/v1/schedules/preview').set(u.auth).send({ horizon: 'DAY' }).expect(200);
    expect(none.body.proposedBlocks).toHaveLength(0);
    const withWindow = await request(app).post('/api/v1/schedules/preview').set(u.auth).send({ horizon: 'DAY', window: { from: '00:00', until: '24:00' } }).expect(200);
    if (Date.now() % 86_400_000 < 86_400_000 - 45 * 60_000) expect(withWindow.body.proposedBlocks.length).toBeGreaterThan(0);
    await request(app).post('/api/v1/schedules/preview').set(u.auth).send({ horizon: 'DAY', window: { from: '18:00', until: '09:00' } }).expect(400);
  });
});
