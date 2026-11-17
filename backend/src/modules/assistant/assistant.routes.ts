import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import { currentUser } from '../../middleware/auth.js';
import { parse } from '../../middleware/validate.js';
import { badRequest } from '../../utils/errors.js';
import {
  answerQuestion,
  approveAction,
  assistantState,
  chat,
  dismissQuestion,
  planDay,
  rejectAction,
  resetMemory,
  syncAndAsk,
  updateProfile,
} from '../../assistant/service.js';
import { buildAuthUrl, completeConnect, connectDemo, disconnect, verifyState } from '../../integrations/google/account.js';
import { DemoGoogle } from '../../integrations/google/demo.js';
import { withGoogleTools } from '../../mcp/client.js';

/**
 * The scheduling assistant: learns your routine, reads Google Calendar/Meet and
 * Gmail through MCP, asks you about meetings, and plans your day.
 */
export const assistantRouter = Router();

// Model calls and Google round-trips are comparatively expensive.
const heavy = rateLimit({ windowMs: 60_000, limit: config.isTest ? 10_000 : 30, standardHeaders: 'draft-8', legacyHeaders: false });
const id = z.string().uuid();

/** GET /assistant — everything the Assistant page shows. */
assistantRouter.get('/', async (req, res) => {
  res.json(await assistantState(currentUser(req).id));
});

/** POST /assistant/sync — learn, read calendar + inbox via MCP, ask what's needed. */
assistantRouter.post('/sync', heavy, async (req, res) => {
  const me = currentUser(req).id;
  const sync = await syncAndAsk(me);
  res.json({ sync, state: await assistantState(me) });
});

/** POST /assistant/plan-day — sync, then plan today (or tomorrow) around meetings. */
assistantRouter.post('/plan-day', heavy, async (req, res) => {
  const me = currentUser(req).id;
  const body = parse(z.object({ day: z.enum(['today', 'tomorrow']).default('today') }), req.body ?? {});
  const r = await planDay(me, body.day);
  res.json({ summary: r.summary, sync: r.sync, moved: r.moved, state: await assistantState(me) });
});

/** POST /assistant/chat — one message to the assistant. */
assistantRouter.post('/chat', heavy, async (req, res) => {
  const me = currentUser(req).id;
  const body = parse(z.object({ message: z.string().trim().min(1).max(2000) }), req.body);
  const r = await chat(me, body.message);
  res.json({ ...r, state: await assistantState(me) });
});

assistantRouter.post('/questions/:id/answer', async (req, res) => {
  const me = currentUser(req).id;
  const body = parse(z.object({ optionId: z.string().min(1).max(200) }), req.body);
  const r = await answerQuestion(me, parse(id, req.params.id), body.optionId);
  res.json({ ...r, state: await assistantState(me) });
});

assistantRouter.post('/questions/:id/dismiss', async (req, res) => {
  const me = currentUser(req).id;
  await dismissQuestion(me, parse(id, req.params.id));
  res.json({ state: await assistantState(me) });
});

/** POST /assistant/actions/:id/approve — performs the action on Google (optionally with an edited email). */
assistantRouter.post('/actions/:id/approve', heavy, async (req, res) => {
  const me = currentUser(req).id;
  const action = await approveAction(me, parse(id, req.params.id), req.body);
  res.json({ action, state: await assistantState(me) });
});

assistantRouter.post('/actions/:id/reject', async (req, res) => {
  const me = currentUser(req).id;
  await rejectAction(me, parse(id, req.params.id));
  res.json({ state: await assistantState(me) });
});

/** PATCH /assistant/profile — edit routine and meeting preferences. */
assistantRouter.patch('/profile', async (req, res) => {
  const me = currentUser(req).id;
  await updateProfile(me, req.body);
  res.json({ state: await assistantState(me) });
});

/** DELETE /assistant/memory — forget what the assistant learned and was told. */
assistantRouter.delete('/memory', async (req, res) => {
  const me = currentUser(req).id;
  await resetMemory(me);
  res.json({ state: await assistantState(me) });
});

/** GET /assistant/tools — the MCP tools available for the connected account. */
assistantRouter.get('/tools', async (req, res) => {
  const me = await prisma.user.findUniqueOrThrow({ where: { id: currentUser(req).id } });
  const tools = await withGoogleTools(me, async (t) => (t ? { mode: t.mode, ...(await t.toolNames()) } : null));
  res.json({ tools });
});

// ---------- Google connection ----------

export const integrationsRouter = Router();

/** GET /integrations/google/connect — the Google consent URL to open. */
integrationsRouter.get('/google/connect', async (req, res) => {
  res.json({ url: buildAuthUrl(currentUser(req).id) });
});

/** POST /integrations/google/demo — use the built-in sample calendar and inbox. */
integrationsRouter.post('/google/demo', async (req, res) => {
  if (!config.assistantDemo) throw badRequest('The sample inbox is turned off on this server');
  const me = currentUser(req).id;
  DemoGoogle.reset(me);
  await connectDemo(me);
  res.json({ state: await assistantState(me) });
});

/** DELETE /integrations/google — disconnect (and revoke at Google). Synced meetings are removed from your plan. */
integrationsRouter.delete('/google', async (req, res) => {
  const me = currentUser(req).id;
  await disconnect(me);
  await prisma.calendarEvent.deleteMany({ where: { userId: me, source: 'IMPORTED', externalId: { not: null } } });
  await prisma.assistantQuestion.updateMany({ where: { userId: me, status: 'OPEN', kind: { not: 'PROFILE' } }, data: { status: 'DISMISSED' } });
  await prisma.assistantAction.updateMany({ where: { userId: me, status: 'PENDING' }, data: { status: 'REJECTED' } });
  res.json({ state: await assistantState(me) });
});

/**
 * GET /integrations/google/callback — Google redirects here after consent.
 * Public (Google can't send our login), protected by the signed `state`.
 */
export const googleCallbackRouter = Router();
googleCallbackRouter.get('/google/callback', async (req, res) => {
  const back = (q: Record<string, string>) => res.redirect(`${config.appUrl.replace(/\/$/, '')}/app/assistant?${new URLSearchParams(q)}`);
  const { code, state, error } = req.query as Record<string, string | undefined>;
  if (error) return back({ google: 'error', message: error === 'access_denied' ? 'Google access was not granted.' : error });
  if (!code || !state) return back({ google: 'error', message: 'Missing code from Google.' });
  try {
    const userId = verifyState(state);
    const email = await completeConnect(userId, code);
    return back({ google: 'connected', email });
  } catch (e) {
    return back({ google: 'error', message: (e as Error).message.slice(0, 200) });
  }
});
