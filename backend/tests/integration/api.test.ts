import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addDep, app, createProject, createTask, prisma, registerUser, resetDb, setAlwaysAvailable } from './helpers.js';

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await prisma.$disconnect();
});

/** The spec's website-launch project. */
async function launchProject(auth: Record<string, string>) {
  const p = await createProject(auth);
  const schema = await createTask(auth, p.id, 'Design database schema', 180);
  const api = await createTask(auth, p.id, 'Build backend APIs', 360, { dependsOn: [schema.id] });
  const fe = await createTask(auth, p.id, 'Build frontend', 300, { dependsOn: [api.id] });
  const test = await createTask(auth, p.id, 'Integration testing', 180, { dependsOn: [api.id, fe.id] });
  const deploy = await createTask(auth, p.id, 'Deployment', 60, { dependsOn: [test.id] });
  return { project: p, schema, api, fe, test, deploy };
}

describe('auth', () => {
  it('registers, logs in and rotates refresh tokens', async () => {
    const u = await registerUser();
    expect(u.accessToken).toBeTruthy();
    const login = await request(app).post('/api/v1/auth/login').send({ email: u.email, password: 'password123' }).expect(200);
    const r1 = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(200);
    expect(r1.body.refreshToken).not.toBe(login.body.refreshToken);
    // A refresh token is single-use.
    await request(app).post('/api/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(401);
    await request(app).post('/api/v1/auth/login').send({ email: u.email, password: 'wrong-password' }).expect(401);
    await request(app).get('/api/v1/users/me').expect(401);
  });

  it('validates input', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({ name: '', email: 'bad', password: 'x' }).expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });
});

describe('projects, tasks and dependencies', () => {
  it('creates a project with dependent tasks and lists them', async () => {
    const u = await registerUser();
    const { project, api, schema } = await launchProject(u.auth);
    const res = await request(app).get(`/api/v1/projects/${project.id}/tasks`).set(u.auth).expect(200);
    expect(res.body.tasks).toHaveLength(5);
    expect(res.body.tasks.find((t: { id: string }) => t.id === api.id).dependsOn).toEqual([schema.id]);
  });

  it('rejects a dependency cycle with a clear explanation (Scenario A)', async () => {
    const u = await registerUser();
    const p = await createProject(u.auth);
    const a = await createTask(u.auth, p.id, 'A', 60);
    const b = await createTask(u.auth, p.id, 'B', 60);
    const c = await createTask(u.auth, p.id, 'C', 60);
    await addDep(u.auth, a.id, b.id).then((r) => expect(r.status).toBe(201));
    await addDep(u.auth, b.id, c.id).then((r) => expect(r.status).toBe(201));
    const res = await addDep(u.auth, c.id, a.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('DEPENDENCY_CYCLE');
    // Any rotation of the cycle is a correct explanation; it must close on itself.
    const path = res.body.error.details.cycle.map((c: { title: string }) => c.title);
    expect(path[0]).toBe(path[path.length - 1]);
    expect(new Set(path)).toEqual(new Set(['A', 'B', 'C']));
    expect(res.body.error.message).toMatch(/dependency cycle: "\w" → "\w" → "\w" → "\w"/);
    expect(await prisma.taskDependency.count()).toBe(2);
    expect((await addDep(u.auth, a.id, a.id)).status).toBe(422);
    expect((await addDep(u.auth, a.id, b.id)).status).toBe(409);
  });

  it('removes a dependency', async () => {
    const u = await registerUser();
    const p = await createProject(u.auth);
    const a = await createTask(u.auth, p.id, 'A', 60);
    const b = await createTask(u.auth, p.id, 'B', 60, { dependsOn: [a.id] });
    await request(app).delete(`/api/v1/tasks/${b.id}/dependencies/${a.id}`).set(u.auth).expect(204);
    expect(await prisma.taskDependency.count()).toBe(0);
  });

  it('rejects stale task edits (optimistic concurrency)', async () => {
    const u = await registerUser();
    const p = await createProject(u.auth);
    const t = await createTask(u.auth, p.id, 'A', 60);
    await request(app).patch(`/api/v1/tasks/${t.id}`).set(u.auth).send({ title: 'A1', version: t.version }).expect(200);
    const stale = await request(app).patch(`/api/v1/tasks/${t.id}`).set(u.auth).send({ title: 'A2', version: t.version }).expect(409);
    expect(stale.body.error.code).toBe('STALE_TASK');
  });

  it('enforces workspace authorization', async () => {
    const owner = await registerUser('Owner');
    const outsider = await registerUser('Outsider');
    const p = await createProject(owner.auth);
    const t = await createTask(owner.auth, p.id, 'Secret', 60);
    await request(app).get(`/api/v1/projects/${p.id}/tasks`).set(outsider.auth).expect(403);
    await request(app).get(`/api/v1/tasks/${t.id}`).set(outsider.auth).expect(403);
    await request(app).patch(`/api/v1/tasks/${t.id}`).set(outsider.auth).send({ title: 'x' }).expect(403);
    await request(app).post('/api/v1/tasks').set(outsider.auth).send({ projectId: p.id, title: 'x', estimatedMinutes: 10 }).expect(403);
    const mine = await createProject(outsider.auth, 'Mine');
    const other = await createTask(outsider.auth, mine.id, 'Other', 30);
    // Cross-workspace dependencies are rejected.
    expect((await addDep(outsider.auth, other.id, t.id)).status).toBe(400);
    // After being added to the workspace, access works.
    await request(app).post(`/api/v1/workspaces/${owner.workspaceId}/members`).set(owner.auth).send({ email: outsider.email }).expect(201);
    await request(app).get(`/api/v1/tasks/${t.id}`).set(outsider.auth).expect(200);
  });
});

describe('scheduling', () => {
  it('previews, commits and shows a dependency-respecting schedule', async () => {
    const u = await registerUser();
    await setAlwaysAvailable(u.auth);
    const ids = await launchProject(u.auth);
    const preview = await request(app).post('/api/v1/schedules/preview').set(u.auth).expect(200);
    expect(preview.body.ok).toBe(true);
    expect(preview.body.scheduleVersion).toBe(0);
    expect(preview.body.unscheduledTasks).toEqual([]);
    expect(preview.body.explanations.length).toBe(5);
    // Nothing is on the calendar until the user approves.
    expect(await prisma.scheduledBlock.count()).toBe(0);

    const commit = await request(app)
      .post('/api/v1/schedules/commit')
      .set(u.auth)
      .send({ recommendationId: preview.body.recommendationId, expectedVersion: 0 })
      .expect(200);
    expect(commit.body.scheduleVersion).toBe(1);

    const blocks = await prisma.scheduledBlock.findMany({ where: { status: 'CONFIRMED' }, orderBy: { startAt: 'asc' } });
    const span = (taskId: string) => {
      const bs = blocks.filter((b) => b.taskId === taskId);
      return { start: Math.min(...bs.map((b) => +b.startAt)), end: Math.max(...bs.map((b) => +b.endAt)) };
    };
    expect(span(ids.api.id).start).toBeGreaterThanOrEqual(span(ids.schema.id).end);
    expect(span(ids.test.id).start).toBeGreaterThanOrEqual(span(ids.fe.id).end);
    expect(span(ids.deploy.id).start).toBeGreaterThanOrEqual(span(ids.test.id).end);

    const cal = await request(app).get('/api/v1/calendar').set(u.auth).expect(200);
    expect(cal.body.blocks.length).toBe(blocks.length);
    expect(cal.body.scheduleVersion).toBe(1);

    // The same recommendation cannot be committed twice.
    await request(app)
      .post('/api/v1/schedules/commit')
      .set(u.auth)
      .send({ recommendationId: preview.body.recommendationId, expectedVersion: 1 })
      .expect(409);
  });

  it('rejects a stale commit from a second session (Scenario E)', async () => {
    const u = await registerUser();
    await setAlwaysAvailable(u.auth);
    await launchProject(u.auth);
    const s1 = await request(app).post('/api/v1/schedules/preview').set(u.auth).expect(200);
    const s2 = await request(app).post('/api/v1/schedules/preview').set(u.auth).expect(200);
    await request(app).post('/api/v1/schedules/commit').set(u.auth).send({ recommendationId: s1.body.recommendationId, expectedVersion: 0 }).expect(200);
    const stale = await request(app)
      .post('/api/v1/schedules/commit')
      .set(u.auth)
      .send({ recommendationId: s2.body.recommendationId, expectedVersion: 0 })
      .expect(409);
    expect(['STALE_SCHEDULE', 'RECOMMENDATION_RESOLVED']).toContain(stale.body.error.code);
  });

  it('lets exactly one of two concurrent commits win (Scenarios B & E)', async () => {
    const u = await registerUser();
    await setAlwaysAvailable(u.auth);
    await launchProject(u.auth);
    const s1 = await request(app).post('/api/v1/schedules/preview').set(u.auth);
    // Mark s1 as not superseded by creating s2 after; both PENDING with baseVersion 0.
    const s2 = await request(app).post('/api/v1/schedules/preview').set(u.auth);
    const results = await Promise.all(
      [s1, s2].map((s) =>
        request(app).post('/api/v1/schedules/commit').set(u.auth).send({ recommendationId: s.body.recommendationId, expectedVersion: 0 }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const blocks = await prisma.scheduledBlock.findMany({ where: { status: 'CONFIRMED' } });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: u.userId } });
    expect(user.scheduleVersion).toBe(1);
    expect(new Set(blocks.map((b) => b.scheduleVersion))).toEqual(new Set([1]));
  });

  it('database rejects overlapping confirmed blocks (Scenario B, last line of defence)', async () => {
    const u = await registerUser();
    const p = await createProject(u.auth);
    const a = await createTask(u.auth, p.id, 'A', 60);
    const b = await createTask(u.auth, p.id, 'B', 60);
    const start = new Date(Date.now() + 86_400_000);
    await prisma.scheduledBlock.create({ data: { taskId: a.id, userId: u.userId, startAt: start, endAt: new Date(+start + 3_600_000), scheduleVersion: 1 } });
    await expect(
      prisma.scheduledBlock.create({ data: { taskId: b.id, userId: u.userId, startAt: new Date(+start + 1_800_000), endAt: new Date(+start + 5_400_000), scheduleVersion: 1 } }),
    ).rejects.toThrow(/scheduled_blocks_no_overlap|exclusion|23P01/i);
    // Adjacent (touching) blocks are fine.
    await prisma.scheduledBlock.create({ data: { taskId: b.id, userId: u.userId, startAt: new Date(+start + 3_600_000), endAt: new Date(+start + 7_200_000), scheduleVersion: 1 } });
  });

  it('replans only downstream work after a delay and previews before committing (Scenario C)', async () => {
    const u = await registerUser();
    await setAlwaysAvailable(u.auth);
    const ids = await launchProject(u.auth);
    const p2 = await createProject(u.auth, 'Side project');
    const side = await createTask(u.auth, p2.id, 'Unrelated chore', 60, { priority: 'URGENT' });
    const preview = await request(app).post('/api/v1/schedules/preview').set(u.auth);
    await request(app).post('/api/v1/schedules/commit').set(u.auth).send({ recommendationId: preview.body.recommendationId, expectedVersion: 0 }).expect(200);
    const sideBefore = await prisma.scheduledBlock.findMany({ where: { taskId: side.id, status: 'CONFIRMED' } });

    const delayUntil = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const rp = await request(app)
      .post('/api/v1/schedules/replan')
      .set(u.auth)
      .send({ changes: [{ taskId: ids.schema.id, delayUntil }] })
      .expect(200);
    const affected = rp.body.affectedTasks.map((t: { taskId: string }) => t.taskId).sort();
    expect(affected).toEqual([ids.schema.id, ids.api.id, ids.fe.id, ids.test.id, ids.deploy.id].sort());
    expect(rp.body.impactChain[0]).toBe('Design database schema');
    expect(rp.body.impact.shiftMinutes).toBeGreaterThan(0);
    expect(rp.body.diff.find((d: { taskId: string }) => d.taskId === side.id).change).toBe('UNCHANGED');
    // Preview only — nothing changed yet.
    expect((await prisma.task.findUniqueOrThrow({ where: { id: ids.schema.id } })).earliestStartAt).toBeNull();

    await request(app).post('/api/v1/schedules/commit').set(u.auth).send({ recommendationId: rp.body.recommendationId, expectedVersion: 1 }).expect(200);
    const schemaBlocks = await prisma.scheduledBlock.findMany({ where: { taskId: ids.schema.id, status: 'CONFIRMED' } });
    expect(Math.min(...schemaBlocks.map((b) => +b.startAt))).toBeGreaterThanOrEqual(Date.parse(delayUntil));
    expect((await prisma.task.findUniqueOrThrow({ where: { id: ids.schema.id } })).earliestStartAt?.toISOString()).toBe(delayUntil);
    const sideAfter = await prisma.scheduledBlock.findMany({ where: { taskId: side.id, status: 'CONFIRMED' } });
    expect(sideAfter.map((b) => [+b.startAt, +b.endAt])).toEqual(sideBefore.map((b) => [+b.startAt, +b.endAt]));
  });

  it('reports a capacity shortfall instead of scheduling outside availability (Scenario D)', async () => {
    const u = await registerUser();
    // Only one 2-hour slot per week.
    const weekday = (new Date().getUTCDay() + 1) % 7;
    await request(app).put('/api/v1/availability').set(u.auth).send({ rules: [{ weekday, startTime: '10:00', endTime: '12:00' }] }).expect(200);
    const p = await createProject(u.auth);
    const due = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const t = await createTask(u.auth, p.id, 'Write thesis chapter', 300, { dueAt: due, splittable: true });
    const risk = await request(app).get('/api/v1/analytics/deadline-risk').set(u.auth).expect(200);
    const r = risk.body.risks.find((x: { id: string }) => x.id === t.id);
    expect(r.status).toBe('INFEASIBLE');
    expect(r.requiredMinutes).toBe(300);
    expect(r.availableMinutes).toBe(120);
    expect(r.shortfallMinutes).toBe(180);
    expect(r.recommendations.map((x: { type: string }) => x.type)).toEqual(expect.arrayContaining(['REDUCE_SCOPE', 'MOVE_DEADLINE']));

    const preview = await request(app).post('/api/v1/schedules/preview').set(u.auth).expect(200);
    const blocks = preview.body.proposedBlocks as { startAt: string; endAt: string }[];
    for (const b of blocks) {
      expect(new Date(b.startAt).getUTCDay()).toBe(weekday);
      expect(new Date(b.startAt).getUTCHours()).toBeGreaterThanOrEqual(10);
      expect(new Date(b.endAt).getUTCHours() * 60 + new Date(b.endAt).getUTCMinutes()).toBeLessThanOrEqual(12 * 60);
    }
    expect(preview.body.warnings.some((w: { code: string }) => w.code === 'DEADLINE_MISSED')).toBe(true);
  });

  it('validates drag-and-drop moves against fixed events and prerequisites', async () => {
    const u = await registerUser();
    await setAlwaysAvailable(u.auth);
    const ids = await launchProject(u.auth);
    const preview = await request(app).post('/api/v1/schedules/preview').set(u.auth);
    await request(app).post('/api/v1/schedules/commit').set(u.auth).send({ recommendationId: preview.body.recommendationId, expectedVersion: 0 }).expect(200);
    const apiBlock = await prisma.scheduledBlock.findFirstOrThrow({ where: { taskId: ids.api.id, status: 'CONFIRMED' }, orderBy: { startAt: 'asc' } });
    const schemaBlock = await prisma.scheduledBlock.findFirstOrThrow({ where: { taskId: ids.schema.id, status: 'CONFIRMED' }, orderBy: { startAt: 'asc' } });

    // Moving the API work before the schema work finishes breaks a dependency.
    const before = { startAt: schemaBlock.startAt.toISOString(), endAt: new Date(+schemaBlock.startAt + 3_600_000).toISOString() };
    const check = await request(app).post(`/api/v1/calendar/blocks/${apiBlock.id}/check`).set(u.auth).send(before).expect(200);
    expect(check.body.ok).toBe(false);
    expect(check.body.issues.map((i: { type: string }) => i.type)).toEqual(expect.arrayContaining(['DEPENDENCY', 'BLOCK_OVERLAP']));
    await request(app).patch(`/api/v1/calendar/blocks/${apiBlock.id}`).set(u.auth).send(before).expect(409);

    // Fixed events cannot be overwritten.
    const far = new Date(Date.now() + 20 * 86_400_000);
    await request(app).post('/api/v1/calendar/events').set(u.auth).send({ title: 'Exam', startAt: far.toISOString(), endAt: new Date(+far + 7_200_000).toISOString() }).expect(201);
    const clash = await request(app)
      .patch(`/api/v1/calendar/blocks/${apiBlock.id}`)
      .set(u.auth)
      .send({ startAt: far.toISOString(), endAt: new Date(+far + 3_600_000).toISOString(), acknowledgeWarnings: true })
      .expect(409);
    expect(clash.body.error.details.issues.some((i: { type: string }) => i.type === 'FIXED_EVENT')).toBe(true);
  });
});

describe('notifications, briefing and analytics', () => {
  it('notifies when a dependency is unblocked', async () => {
    const u = await registerUser();
    const p = await createProject(u.auth);
    const a = await createTask(u.auth, p.id, 'Run API tests', 60);
    await createTask(u.auth, p.id, 'Create demo slides', 120, { dependsOn: [a.id] });
    const done = await request(app).patch(`/api/v1/tasks/${a.id}`).set(u.auth).send({ status: 'DONE' }).expect(200);
    expect(done.body.task.completedAt).toBeTruthy();
    const n = await request(app).get('/api/v1/notifications').set(u.auth).expect(200);
    expect(n.body.notifications[0].type).toBe('DEPENDENCY_UNBLOCKED');
    expect(n.body.notifications[0].message).toMatch(/Create demo slides/);
    expect(n.body.unreadCount).toBe(1);
    await request(app).post('/api/v1/notifications/read-all').set(u.auth).expect(204);
    expect((await request(app).get('/api/v1/notifications').set(u.auth)).body.unreadCount).toBe(0);
  });

  it('builds a grounded daily briefing', async () => {
    const u = await registerUser();
    await setAlwaysAvailable(u.auth);
    const ids = await launchProject(u.auth);
    const res = await request(app).get('/api/v1/briefings/daily').set(u.auth).expect(200);
    expect(res.body.briefing.suggestedFirstTask.taskId).toBe(ids.schema.id);
    expect(res.body.briefing.blockedTasks.map((b: { taskId: string }) => b.taskId)).toContain(ids.api.id);
    expect(res.body.narrativeSource).toBe('engine');
    expect(res.body.narrative).toMatch(/Design database schema/);
  });

  it('returns analytics overview and timeline with critical path', async () => {
    const u = await registerUser();
    const ids = await launchProject(u.auth);
    await request(app).patch(`/api/v1/tasks/${ids.schema.id}`).set(u.auth).send({ status: 'DONE', actualMinutes: 240 }).expect(200);
    const ov = await request(app).get('/api/v1/analytics/overview').set(u.auth).expect(200);
    expect(ov.body.estimateAccuracy.sampleSize).toBe(1);
    expect(ov.body.estimateAccuracy.medianActualToEstimate).toBeCloseTo(1.33, 2);
    expect(ov.body.workloadByProject[0].remainingMinutes).toBe(900);
    const tl = await request(app).get(`/api/v1/projects/${ids.project.id}/timeline`).set(u.auth).expect(200);
    expect(tl.body.criticalPath).toEqual([ids.api.id, ids.fe.id, ids.test.id, ids.deploy.id]);
    expect(tl.body.tasks.find((t: { id: string }) => t.id === ids.fe.id).flags.blocked).toBe(true);
  });
});

describe('AI task extraction (Scenario F)', () => {
  let server: http.Server;
  let reply: unknown = {};
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply));
    });
    await new Promise<void>((r) => server.listen(4999, '127.0.0.1', () => r()));
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('rejects invalid AI fields but keeps valid drafts', async () => {
    const u = await registerUser();
    const friday = new Date(Date.now() + 3 * 86_400_000).toISOString();
    reply = {
      provider: 'mock',
      warnings: [],
      tasks: [
        { tempId: 't1', title: 'Run API tests', estimatedMinutes: null, dueAt: null, priority: 'MEDIUM' },
        { tempId: 't2', title: 'Create demo slides', estimatedMinutes: 120, dueAt: friday, priority: 'HIGH' },
        { tempId: 't3', title: '', estimatedMinutes: 30, dueAt: null },
        { tempId: 't4', title: 'Bad date', estimatedMinutes: 30, dueAt: 'next-ish friday' },
      ],
      dependencies: [
        { taskTempId: 't2', dependsOnTempId: 't1' },
        { taskTempId: 't2', dependsOnTempId: 't3' },
      ],
    };
    const res = await request(app).post('/api/v1/ai/extract-tasks').set(u.auth).send({ text: 'Prepare the project demo by Friday.' }).expect(200);
    expect(res.body.status).toBe('draft');
    expect(res.body.drafts.map((d: { tempId: string }) => d.tempId)).toEqual(['t1', 't2']);
    expect(res.body.rejected.map((r: { index: number }) => r.index)).toEqual([2, 3]);
    expect(res.body.dependencies).toEqual([{ taskTempId: 't2', dependsOnTempId: 't1' }]);
    // Drafts are not saved until confirmed.
    expect(await prisma.task.count()).toBe(0);

    const p = await createProject(u.auth);
    const confirm = await request(app)
      .post('/api/v1/ai/confirm-tasks')
      .set(u.auth)
      .send({
        projectId: p.id,
        tasks: [
          { tempId: 't1', title: 'Run API tests', estimatedMinutes: 60 },
          { tempId: 't2', title: 'Create demo slides', estimatedMinutes: 120, dueAt: friday, priority: 'HIGH' },
        ],
        dependencies: res.body.dependencies,
      })
      .expect(201);
    expect(confirm.body.tasks).toHaveLength(2);
    expect(await prisma.taskDependency.count()).toBe(1);
  });

  it('falls back to the manual flow when output is malformed', async () => {
    const u = await registerUser();
    reply = { nonsense: true };
    const res = await request(app).post('/api/v1/ai/extract-tasks').set(u.auth).send({ text: 'Do the thing by Friday' }).expect(503);
    expect(res.body.error.code).toBe('AI_INVALID_OUTPUT');
    expect(res.body.error.details.fallback).toBe('manual');
  });
});

describe('serverless entrypoint', () => {
  it('serves the API from the default export without a WebSocket server', async () => {
    const { default: serverlessApp } = await import('../../src/app.js');
    const meta = await request(serverlessApp).get('/api/v1/meta').expect(200);
    expect(meta.body).toEqual({ realtime: false, backgroundJobs: false });
    const u = await registerUser();
    await request(serverlessApp).get('/api/v1/users/me').set(u.auth).expect(200);
  });
});
