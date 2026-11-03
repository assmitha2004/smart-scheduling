import request from 'supertest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db.js';

export const app = createApp();
export { prisma };

export async function resetDb() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`);
}

let counter = 0;
export async function registerUser(name = 'Test User') {
  const email = `user${Date.now()}${counter++}@example.com`;
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ name, email, password: 'password123', timezone: 'UTC' })
    .expect(201);
  const token = res.body.accessToken as string;
  const auth = { Authorization: `Bearer ${token}` };
  const ws = await request(app).get('/api/v1/workspaces').set(auth).expect(200);
  return { ...res.body, auth, email, workspaceId: ws.body.workspaces[0].id as string, userId: res.body.user.id as string };
}

/** Works every day 00:00–24:00 UTC so tests are independent of when they run. */
export async function setAlwaysAvailable(auth: Record<string, string>) {
  await request(app)
    .put('/api/v1/availability')
    .set(auth)
    .send({ rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '00:00', endTime: '24:00' })) })
    .expect(200);
}

export async function createProject(auth: Record<string, string>, name = 'Website launch', extra: object = {}) {
  const res = await request(app).post('/api/v1/projects').set(auth).send({ name, ...extra }).expect(201);
  return res.body.project as { id: string; workspaceId: string };
}

export async function createTask(auth: Record<string, string>, projectId: string, title: string, estimatedMinutes: number, extra: object = {}) {
  const res = await request(app).post('/api/v1/tasks').set(auth).send({ projectId, title, estimatedMinutes, ...extra });
  if (res.status !== 201) throw new Error(`createTask failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.task as { id: string; version: number };
}

export async function addDep(auth: Record<string, string>, taskId: string, dependsOnTaskId: string) {
  return request(app).post(`/api/v1/tasks/${taskId}/dependencies`).set(auth).send({ dependsOnTaskId });
}
