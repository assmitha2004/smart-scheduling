import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, createProject, createTask, prisma, registerUser, resetDb, setAlwaysAvailable } from './helpers.js';
import { runBlockReminder, runDailyPlanSweep, runDeadlineRiskSweep } from '../../src/workers/jobs.js';
import { inQuietHours } from '../../src/modules/notifications/notifications.service.js';

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('background jobs', () => {
  it('quiet hours handle windows that wrap midnight', () => {
    const u = { timezone: 'UTC', quietHoursStart: '22:00', quietHoursEnd: '07:00' };
    expect(inQuietHours(u, new Date('2026-11-03T23:30:00Z'))).toBe(true);
    expect(inQuietHours(u, new Date('2026-11-03T06:59:00Z'))).toBe(true);
    expect(inQuietHours(u, new Date('2026-11-03T12:00:00Z'))).toBe(false);
    expect(inQuietHours({ ...u, quietHoursStart: null }, new Date('2026-11-03T23:30:00Z'))).toBe(false);
  });

  it('sends a reminder once, and skips blocks that were moved', async () => {
    const u = await registerUser();
    const p = await createProject(u.auth);
    const t = await createTask(u.auth, p.id, 'Write report', 60);
    const start = new Date(Date.now() + 3_600_000);
    const block = await prisma.scheduledBlock.create({ data: { taskId: t.id, userId: u.userId, startAt: start, endAt: new Date(+start + 3_600_000), scheduleVersion: 1 } });
    expect(await runBlockReminder({ blockId: block.id, startAt: start.toISOString() })).toBe('sent');
    expect(await runBlockReminder({ blockId: block.id, startAt: start.toISOString() })).toBe('sent');
    expect(await prisma.notification.count({ where: { type: 'TASK_REMINDER' } })).toBe(1); // deduplicated
    await prisma.scheduledBlock.update({ where: { id: block.id }, data: { startAt: new Date(+start + 600_000) } });
    expect(await runBlockReminder({ blockId: block.id, startAt: start.toISOString() })).toBe('skipped: block was moved');
  });

  it('alerts on infeasible deadlines once per day', async () => {
    const u = await registerUser();
    await prisma.user.update({ where: { id: u.userId }, data: { onboarded: true } });
    const weekday = (new Date().getUTCDay() + 1) % 7;
    await request(app).put('/api/v1/availability').set(u.auth).send({ rules: [{ weekday, startTime: '10:00', endTime: '11:00' }] }).expect(200);
    const p = await createProject(u.auth);
    await createTask(u.auth, p.id, 'Huge task', 600, { dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString() });
    expect(await runDeadlineRiskSweep()).toBe(1);
    expect(await runDeadlineRiskSweep()).toBe(0);
    const n = await prisma.notification.findFirstOrThrow({ where: { type: 'DEADLINE_RISK' } });
    expect(n.message).toMatch(/not feasible/i);
  });

  it('delivers the daily plan at the user’s chosen local hour', async () => {
    const u = await registerUser();
    await setAlwaysAvailable(u.auth);
    const p = await createProject(u.auth);
    await createTask(u.auth, p.id, 'Plan the week', 30);
    const now = new Date();
    await prisma.user.update({ where: { id: u.userId }, data: { onboarded: true, notificationPrefs: { dailyPlanHour: now.getUTCHours() } } });
    expect(await runDailyPlanSweep(now)).toBe(1);
    expect(await runDailyPlanSweep(now)).toBe(0);
    const other = new Date(+now + 3 * 3_600_000);
    expect(await runDailyPlanSweep(other)).toBe(0); // wrong hour
    const n = await prisma.notification.findFirstOrThrow({ where: { type: 'DAILY_PLAN' } });
    expect(n.message).toMatch(/Plan the week/);
  });
});
