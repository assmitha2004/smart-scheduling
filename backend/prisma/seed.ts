/**
 * Demo data: the spec's website-launch project plus a study plan.
 * Login: demo@smartscheduling.dev / password123
 */
import bcrypt from 'bcryptjs';
import { DateTime } from 'luxon';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const TZ = process.env.SEED_TIMEZONE ?? 'UTC';
const EMAIL = 'demo@smartscheduling.dev';

async function main() {
  // Re-runnable: workspaces reference their owner, so remove them first.
  await prisma.workspace.deleteMany({ where: { owner: { email: EMAIL } } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  // Day-aligned base so seeded deadlines land on clean times (e.g. 20:00, not 20:18).
  const now = DateTime.now().setZone(TZ).startOf('hour');

  const user = await prisma.user.create({
    data: {
      name: 'Demo User',
      email: EMAIL,
      passwordHash: await bcrypt.hash('password123', 10),
      timezone: TZ,
      onboarded: true,
      focusBlockMinutes: 90,
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
    },
  });
  const ws = await prisma.workspace.create({ data: { name: 'Demo workspace', ownerId: user.id } });
  await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: user.id, role: 'OWNER' } });

  // Spec example: 2h on weekdays, 5h on Saturday — plus a morning slot.
  await prisma.availabilityRule.createMany({
    data: [
      ...[1, 2, 3, 4, 5].map((weekday) => ({ userId: user.id, weekday, startTime: '09:00', endTime: '11:00' })),
      ...[1, 2, 3, 4, 5].map((weekday) => ({ userId: user.id, weekday, startTime: '18:00', endTime: '20:00' })),
      { userId: user.id, weekday: 6, startTime: '10:00', endTime: '15:00' },
    ],
  });

  const web = await prisma.project.create({
    data: {
      workspaceId: ws.id,
      name: 'Website launch',
      description: 'Ship the new marketing site with a backend for sign-ups.',
      color: '#6366f1',
      startDate: now.startOf('day').toJSDate(),
      targetDate: now.plus({ days: 10 }).set({ hour: 20, minute: 0 }).toJSDate(),
    },
  });
  const t = async (title: string, estimatedMinutes: number, extra: Record<string, unknown> = {}) =>
    prisma.task.create({ data: { projectId: web.id, title, estimatedMinutes, assigneeId: user.id, ...extra } });
  const schema = await t('Design database schema', 180, { priority: 'HIGH', description: 'Users, sign-ups, and email preferences tables.' });
  const api = await t('Build backend APIs', 360, { priority: 'HIGH' });
  const fe = await t('Build frontend', 300);
  const it = await t('Integration testing', 180);
  const deploy = await t('Deployment', 60, { priority: 'URGENT', dueAt: now.plus({ days: 10 }).set({ hour: 20, minute: 0 }).toJSDate() });
  await prisma.taskDependency.createMany({
    data: [
      { taskId: api.id, dependsOnTaskId: schema.id },
      { taskId: fe.id, dependsOnTaskId: api.id },
      { taskId: it.id, dependsOnTaskId: api.id },
      { taskId: it.id, dependsOnTaskId: fe.id },
      { taskId: deploy.id, dependsOnTaskId: it.id },
    ],
  });
  await prisma.milestone.create({ data: { projectId: web.id, name: 'API contract frozen', dueAt: now.plus({ days: 5 }).toJSDate() } });

  const study = await prisma.project.create({
    data: { workspaceId: ws.id, name: 'Algorithms exam', color: '#10b981', targetDate: now.plus({ days: 6 }).set({ hour: 9, minute: 0 }).toJSDate() },
  });
  const s1 = await prisma.task.create({ data: { projectId: study.id, title: 'Review graph algorithms', estimatedMinutes: 120, priority: 'MEDIUM' } });
  const s2 = await prisma.task.create({ data: { projectId: study.id, title: 'Practice past papers', estimatedMinutes: 180, priority: 'HIGH', dueAt: now.plus({ days: 5 }).set({ hour: 20, minute: 0 }).toJSDate() } });
  await prisma.taskDependency.create({ data: { taskId: s2.id, dependsOnTaskId: s1.id } });
  // A completed task with logged time, for estimate-accuracy analytics.
  await prisma.task.create({
    data: { projectId: study.id, title: 'Collect lecture notes', estimatedMinutes: 60, actualMinutes: 75, status: 'DONE', completedAt: now.minus({ days: 2 }).toJSDate() },
  });

  const tomorrow = now.plus({ days: 1 }).startOf('day');
  await prisma.calendarEvent.createMany({
    data: [
      { userId: user.id, title: 'Team stand-up', startAt: tomorrow.set({ hour: 9 }).toJSDate(), endAt: tomorrow.set({ hour: 9, minute: 30 }).toJSDate(), eventType: 'FIXED' },
      { userId: user.id, title: 'Dentist', startAt: tomorrow.plus({ days: 1 }).set({ hour: 18 }).toJSDate(), endAt: tomorrow.plus({ days: 1 }).set({ hour: 19 }).toJSDate(), eventType: 'UNAVAILABLE' },
    ],
  });
  console.log(`Seeded demo data. Log in as ${EMAIL} / password123 (timezone ${TZ}).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
