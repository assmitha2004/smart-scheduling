/**
 * The scheduling assistant end to end, against the built-in sample Google
 * account, through the real MCP servers (in-process and over HTTP).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, prisma, registerUser, resetDb } from './helpers.js';
import { config } from '../../src/config.js';
import { DemoGoogle } from '../../src/integrations/google/demo.js';
import { createMcpHttpApp } from '../../src/mcp/serve.js';
import { resetAiStatusCache } from '../../src/modules/ai/ai.client.js';

interface Option { id: string; label: string; hint?: string; recommended?: boolean }
interface Question { id: string; kind: string; text: string; options: Option[] }
interface Action { id: string; kind: string; summary: string; status: string; email: { to: string; subject: string; body: string } | null }

beforeEach(async () => {
  await resetDb();
  DemoGoogle.reset();
  resetAiStatusCache();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function setup() {
  const u = await registerUser('Asmitha Gopichander');
  await request(app).patch('/api/v1/users/me').set(u.auth).send({ timezone: 'Asia/Kolkata' }).expect(200);
  await request(app).post('/api/v1/integrations/google/demo').set(u.auth).expect(200);
  return u;
}

const answer = (auth: Record<string, string>, q: Question, optionId: string) => request(app).post(`/api/v1/assistant/questions/${q.id}/answer`).set(auth).send({ optionId });

async function answerProfile(auth: Record<string, string>, questions: Question[]) {
  const pick: Record<string, string> = { 'When do you usually wake up?': '07:00', 'And when do you usually go to sleep?': '23:00', 'What are your working hours?': '9-18', 'When do you do your best focused work?': 'EARLY_BIRD' };
  for (const q of questions.filter((x) => x.kind === 'PROFILE')) await answer(auth, q, pick[q.text]).expect(200);
}

describe('assistant with the sample Google account', () => {
  it('learns the routine, asks about meetings, books with Meet after approval and plans the day', async () => {
    const u = await setup();
    const sync = await request(app).post('/api/v1/assistant/sync').set(u.auth).expect(200);
    expect(sync.body.sync.google).toBe('demo');
    const state = sync.body.state;
    expect(state.google).toMatchObject({ connected: true, mode: 'demo', transport: 'in-process' });
    expect(state.ai.inUse).toBe(false); // no model in tests: built-in rules

    const questions = state.questions as Question[];
    // Routine questions it doesn't know yet.
    expect(questions.filter((q) => q.kind === 'PROFILE').map((q) => q.text)).toEqual([
      'When do you usually wake up?',
      'And when do you usually go to sleep?',
      'What are your working hours?',
      'When do you do your best focused work?',
    ]);
    // Meeting requests found in email; the newsletter and HR reminder are ignored.
    const requests = questions.filter((q) => q.kind === 'MEETING_REQUEST');
    expect(requests.map((q) => q.text).sort()).toEqual([
      'Neha Kapoor wants to meet: “Coffee chat about the design system” (20 min). Which time works?',
      'Rahul Verma wants to meet: “Sync on the API migration” (30 min). Which time works?',
    ]);
    // An unanswered invite in the future becomes a question.
    const vendor = questions.find((q) => q.kind === 'MEETING_INVITE' && q.text.includes('CloudVendor product demo'))!;
    expect(vendor.options.map((o) => o.id)).toContain('accept');
    expect(vendor.options.at(-1)!.id).toBe('decline');

    // Accepted Google events are mirrored as busy time; unanswered ones are not (yet).
    const imported = await prisma.calendarEvent.findMany({ where: { userId: u.userId, source: 'IMPORTED' } });
    expect(imported.map((e) => e.title).sort()).toEqual(['1:1 with Arjun', 'Daily stand-up']);
    expect(imported.every((e) => e.meetUrl?.startsWith('https://meet.google.com/'))).toBe(true);

    await answerProfile(u.auth, questions);
    let s = (await request(app).get('/api/v1/assistant').set(u.auth).expect(200)).body;
    expect(s.questions.filter((q: Question) => q.kind === 'PROFILE')).toHaveLength(0);
    expect(s.profile.routine).toMatchObject({ wakeTime: '07:00', sleepTime: '23:00', workStart: '09:00', workEnd: '18:00', chronotype: 'EARLY_BIRD' });

    // Rahul: pick a time -> a pending action; nothing is sent yet.
    const rahul = requests.find((q) => q.text.startsWith('Rahul'))!;
    const time = rahul.options.find((o) => o.id.startsWith('time:'))!;
    const a1 = await answer(u.auth, rahul, time.id).expect(200);
    const booking = a1.body.actions[0] as Action;
    expect(booking.kind).toBe('SCHEDULE_MEETING');
    expect(booking.status).toBe('PENDING');
    expect(booking.email!.to).toBe('rahul.verma@acme.dev');
    expect(booking.email!.subject).toBe('Re: Sync on the API migration?');
    expect(booking.email!.body).toContain(time.label);
    const demo = new DemoGoogle(u.userId, 'Asia/Kolkata');
    expect(demo.sent).toHaveLength(0);
    await answer(u.auth, rahul, time.id).expect(409);

    // Approve with an edited email: meeting created with Meet link, reply sent in the thread.
    const approved = await request(app).post(`/api/v1/assistant/actions/${booking.id}/approve`).set(u.auth).send({ body: 'Hi Rahul, that works. See you then!\nAsmitha' }).expect(200);
    expect(approved.body.action.status).toBe('DONE');
    const meetUrl = approved.body.action.result.meetUrl as string;
    expect(meetUrl).toMatch(/^https:\/\/meet\.google\.com\//);
    expect(demo.sent).toHaveLength(1);
    expect(demo.sent[0]).toMatchObject({ to: 'rahul.verma@acme.dev', threadId: 't-demo-m1', inReplyTo: '<demo-m1@mail.demo>' });
    expect(demo.sent[0].body).toBe(`Hi Rahul, that works. See you then!\nAsmitha\n\nGoogle Meet: ${meetUrl}`);
    const booked = await prisma.calendarEvent.findFirst({ where: { userId: u.userId, title: 'Sync on the API migration' } });
    expect(booked?.meetUrl).toBe(meetUrl);
    expect(booked?.startAt.toISOString()).toBe(new Date(time.id.slice(5)).toISOString());
    // Can't be sent twice.
    await request(app).post(`/api/v1/assistant/actions/${booking.id}/approve`).set(u.auth).send({}).expect(409);

    // Accept the vendor invite -> RSVP on approval, then it's busy time.
    const a2 = await answer(u.auth, vendor, 'accept').expect(200);
    await request(app).post(`/api/v1/assistant/actions/${a2.body.actions[0].id}/approve`).set(u.auth).send({}).expect(200);
    expect((await demo.listEvents({ timeMin: '2000-01-01T00:00:00Z', timeMax: '2100-01-01T00:00:00Z' })).find((e) => e.id === 'demo-vendor')!.myResponse).toBe('accepted');
    expect(await prisma.calendarEvent.count({ where: { userId: u.userId, externalId: 'demo-vendor' } })).toBe(1);

    // Neha: decline, then reject the drafted email -> nothing sent.
    const neha = requests.find((q) => q.text.startsWith('Neha'))!;
    const a3 = await answer(u.auth, neha, 'decline').expect(200);
    expect(a3.body.actions[0].kind).toBe('SEND_EMAIL');
    expect(a3.body.actions[0].email.body).toContain('Hi Neha');
    await request(app).post(`/api/v1/assistant/actions/${a3.body.actions[0].id}/reject`).set(u.auth).expect(200);
    expect(demo.sent).toHaveLength(1);

    // Syncing again doesn't ask the same things twice.
    const again = await request(app).post('/api/v1/assistant/sync').set(u.auth).expect(200);
    expect(again.body.sync.newQuestions).toBe(0);

    // Plan tomorrow: meetings are busy time in the plan.
    await request(app).post('/api/v1/day/tasks').set(u.auth).send({ text: 'write design doc 2h', date: tomorrow() }).expect(201);
    const plan = await request(app).post('/api/v1/assistant/plan-day').set(u.auth).send({ day: 'tomorrow' }).expect(200);
    expect(plan.body.summary).toMatch(/^I planned tomorrow with \d+ task session/);
    const day = await prisma.dayPlan.findUnique({ where: { userId_date: { userId: u.userId, date: tomorrow() } } });
    const items = day!.items as { kind: string; title: string; start: number }[];
    expect(items.some((i) => i.kind === 'BUSY' && i.title === '1:1 with Arjun' && i.start === 11 * 60)).toBe(true);
    expect(items.some((i) => i.kind === 'TASK' && i.title.toLowerCase().includes('design doc'))).toBe(true);
    // Wakes at 7: nothing before 7:30.
    expect(Math.min(...items.filter((i) => i.kind === 'TASK').map((i) => i.start))).toBeGreaterThanOrEqual(7 * 60 + 30);

    // Decisions are remembered for learning.
    s = (await request(app).get('/api/v1/assistant').set(u.auth).expect(200)).body;
    expect(s.profile.decisions).toBe(2);
    expect(s.history.map((a: Action) => a.status).sort()).toEqual(['DONE', 'DONE', 'REJECTED']);
  });

  it('understands routine facts, agenda questions and new tasks in chat', async () => {
    const u = await setup();
    await request(app).post('/api/v1/assistant/sync').set(u.auth).expect(200);
    const c1 = await request(app).post('/api/v1/assistant/chat').set(u.auth).send({ message: 'I wake up at 6:30, sleep around 11 and work 10 to 7. No meetings before 11 please' }).expect(200);
    expect(c1.body.intent).toBe('PROFILE');
    expect(c1.body.reply).toContain('you wake up at 6:30 AM');
    expect(c1.body.state.profile.routine).toMatchObject({ wakeTime: '06:30', sleepTime: '23:00', workStart: '10:00', workEnd: '19:00' });
    expect(c1.body.state.profile.meetings.earliest).toBe('11:00');
    // Answered in chat -> those routine questions are closed.
    expect(c1.body.state.questions.filter((q: Question) => q.kind === 'PROFILE').map((q: Question) => q.text)).toEqual(['When do you do your best focused work?']);

    const c2 = await request(app).post('/api/v1/assistant/chat').set(u.auth).send({ message: "what's on tomorrow?" }).expect(200);
    expect(c2.body.intent).toBe('AGENDA');
    expect(c2.body.reply).toContain('1:1 with Arjun (Meet)');

    const c3 = await request(app).post('/api/v1/assistant/chat').set(u.auth).send({ message: 'add gym 1h, call mom at 6pm' }).expect(200);
    expect(c3.body.intent).toBe('ADD_TASKS');
    expect(c3.body.reply).toMatch(/^Added “[^”]+”, “[^”]+” to today/);

    const c4 = await request(app).post('/api/v1/assistant/chat').set(u.auth).send({ message: 'hello' }).expect(200);
    expect(c4.body.intent).toBe('HELP');
    expect(c4.body.state.messages).toHaveLength(8);
  });

  it('lists MCP tools and cleans up on disconnect', async () => {
    const u = await setup();
    const tools = await request(app).get('/api/v1/assistant/tools').set(u.auth).expect(200);
    expect(tools.body.tools).toEqual({ mode: 'demo', calendar: ['list_events', 'create_meeting', 'respond_to_invite'], gmail: ['search_messages', 'get_message', 'send_email'] });
    await request(app).post('/api/v1/assistant/sync').set(u.auth).expect(200);
    expect(await prisma.calendarEvent.count({ where: { userId: u.userId, source: 'IMPORTED' } })).toBeGreaterThan(0);
    const off = await request(app).delete('/api/v1/integrations/google').set(u.auth).expect(200);
    expect(off.body.state.google.connected).toBe(false);
    expect(off.body.state.questions.every((q: Question) => q.kind === 'PROFILE')).toBe(true);
    expect(await prisma.calendarEvent.count({ where: { userId: u.userId, source: 'IMPORTED' } })).toBe(0);
  });

  it('keeps users apart and validates input', async () => {
    const a = await setup();
    const b = await registerUser();
    const s = await request(app).post('/api/v1/assistant/sync').set(a.auth).expect(200);
    const q = s.body.state.questions[0] as Question;
    await answer(b.auth, q, q.options[0].id).expect(404);
    await answer(a.auth, q, 'not-an-option').expect(400);
    await request(app).patch('/api/v1/assistant/profile').set(a.auth).send({ workStart: '18:00', workEnd: '09:00' }).expect(400);
    await request(app).patch('/api/v1/assistant/profile').set(a.auth).send({ wakeTime: '7am' }).expect(400);
    await request(app).get('/api/v1/integrations/google/connect').set(a.auth).expect(503); // no Google client configured
    await request(app).get('/api/v1/assistant').expect(401);
  });
});

describe('Google MCP servers over Streamable HTTP', () => {
  let server: http.Server;
  const saved = { ...config.mcp };
  afterEach(async () => {
    Object.assign(config.mcp, saved);
    delete process.env.MCP_INTERNAL_TOKEN;
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  });

  it('syncs through the standalone MCP service, which requires the internal token', async () => {
    process.env.MCP_INTERNAL_TOKEN = 'mcp-secret';
    server = createMcpHttpApp().listen(0);
    const port = (server.address() as AddressInfo).port;
    Object.assign(config.mcp, { calendarUrl: `http://127.0.0.1:${port}/mcp/calendar`, gmailUrl: `http://127.0.0.1:${port}/mcp/gmail`, internalToken: 'mcp-secret' });

    const u = await setup();
    const s = await request(app).post('/api/v1/assistant/sync').set(u.auth).expect(200);
    expect(s.body.state.google.transport).toBe('http');
    expect(s.body.state.questions.some((q: Question) => q.kind === 'MEETING_REQUEST')).toBe(true);

    // Without the token the service refuses.
    const raw = await fetch(`http://127.0.0.1:${port}/mcp/calendar`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-user': u.userId }, body: '{}' });
    expect(raw.status).toBe(401);
  });
});

describe('with a self-hosted model', () => {
  let server: http.Server;
  const seen: string[] = [];
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('uses the local model without external-AI consent, and validates what it returns', async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push(req.url!);
        res.setHeader('content-type', 'application/json');
        const json = body ? JSON.parse(body) : {};
        if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', provider: 'ollama', local: true, model: 'qwen2.5:7b-instruct', ollama: { reachable: true, modelPulled: true } }));
        if (req.url === '/assistant/meeting-requests') {
          return res.end(JSON.stringify({
            provider: 'ollama',
            results: json.emails.map((e: { id: string; date: string }) => ({
              id: e.id,
              is_meeting_request: e.id === 'demo-m1',
              title: 'API migration sync',
              duration_minutes: 45,
              proposed_times: [`${tomorrow()}T15:00:00`],
              summary: 'Rahul wants to sync on the API migration.',
            })).concat([{ id: 'demo-m2', is_meeting_request: true, title: '', duration_minutes: 9999, proposed_times: [], summary: '' }]), // invalid -> dropped
          }));
        }
        if (req.url === '/assistant/draft-reply') return res.end(JSON.stringify({ provider: 'ollama', text: `Hi Rahul, ${json.time_label} works. Invite with a Meet link coming. — Asmitha` }));
        if (req.url === '/assistant/chat') return res.end(JSON.stringify({ provider: 'ollama', result: { intent: 'PROFILE', profile: { chronotype: 'NIGHT_OWL', work_start: '18:00', work_end: '09:00' }, reply: 'Night owl, noted! 🦉' } }));
        res.end(JSON.stringify({ provider: 'rules' }));
      });
    });
    await new Promise<void>((r) => server.listen(4999, '127.0.0.1', () => r()));

    const u = await setup();
    const me = await prisma.user.findUniqueOrThrow({ where: { id: u.userId } });
    expect(me.aiExternalConsent).toBe(false);
    const s = await request(app).post('/api/v1/assistant/sync').set(u.auth).expect(200);
    expect(s.body.state.ai).toMatchObject({ provider: 'ollama', local: true, inUse: true });
    const reqs = (s.body.state.questions as Question[]).filter((q) => q.kind === 'MEETING_REQUEST');
    expect(reqs).toHaveLength(1);
    expect(reqs[0].text).toContain('“API migration sync” (45 min)');
    // "15:00 tomorrow" is read as local (Asia/Kolkata) time.
    expect(reqs[0].options.some((o) => o.id === `time:${new Date(`${tomorrow()}T15:00:00+05:30`).toISOString()}`)).toBe(true);

    const a = await answer(u.auth, reqs[0], reqs[0].options[0].id).expect(200);
    expect(a.body.actions[0].email.body).toContain('Invite with a Meet link coming');

    // Facts from the model are validated: an impossible work window is dropped, the rest kept.
    const c = await request(app).post('/api/v1/assistant/chat').set(u.auth).send({ message: "I'm a night owl" }).expect(200);
    expect(c.body.source).toBe('ai');
    expect(c.body.reply).toBe('Night owl, noted! 🦉');
    expect(c.body.state.profile.routine.chronotype).toBe('NIGHT_OWL');
    expect(c.body.state.profile.routine.workStart).toBeNull();
    expect(seen).toContain('/assistant/meeting-requests');
  });
});

function tomorrow() {
  const d = new Date(Date.now() + 5.5 * 3600_000 + 86_400_000);
  return d.toISOString().slice(0, 10);
}
