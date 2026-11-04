import crypto from 'node:crypto';
import { Router } from 'express';
import { prisma } from '../../db.js';
import { currentUser } from '../../middleware/auth.js';
import { notFound } from '../../utils/errors.js';
import { buildIcs, type IcsEvent } from '../../utils/ics.js';

const PAST_DAYS = 7;
const FUTURE_DAYS = 60;
export const feedPath = (token: string) => `/api/v1/feed/${token}.ics`;

/** Authenticated: turn the private feed on (or rotate its secret link) and off. */
export const feedSettingsRouter = Router();

feedSettingsRouter.get('/', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: currentUser(req).id } });
  if (!user) throw notFound('User');
  res.json({ enabled: !!user.calendarFeedToken, path: user.calendarFeedToken ? feedPath(user.calendarFeedToken) : null });
});

/** POST /calendar-feed — creates a new secret link; any old link stops working. */
feedSettingsRouter.post('/', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: currentUser(req).id } });
  if (!user) throw notFound('User');
  const token = crypto.randomBytes(24).toString('base64url');
  await prisma.user.update({ where: { id: user.id }, data: { calendarFeedToken: token } });
  res.json({ enabled: true, path: feedPath(token) });
});

feedSettingsRouter.delete('/', async (req, res) => {
  await prisma.user.update({ where: { id: currentUser(req).id }, data: { calendarFeedToken: null } });
  res.json({ enabled: false, path: null });
});

/**
 * Public, read-only: GET /feed/<secret>.ics, polled by calendar apps.
 * The unguessable token is the only credential, like Google's "secret address".
 */
export const publicFeedRouter = Router();

publicFeedRouter.get('/:file', async (req, res) => {
  const token = req.params.file.replace(/\.ics$/, '');
  const user = token.length >= 20 ? await prisma.user.findUnique({ where: { calendarFeedToken: token } }) : null;
  if (!user) {
    res.status(404).type('text/plain').send('Calendar feed not found');
    return;
  }
  const from = new Date(Date.now() - PAST_DAYS * 86_400_000);
  const to = new Date(Date.now() + FUTURE_DAYS * 86_400_000);
  const [blocks, events] = await Promise.all([
    prisma.scheduledBlock.findMany({
      where: { userId: user.id, status: { in: ['CONFIRMED', 'COMPLETED'] }, startAt: { lt: to }, endAt: { gt: from } },
      include: { task: { include: { project: { select: { name: true } } } } },
      orderBy: { startAt: 'asc' },
    }),
    prisma.calendarEvent.findMany({ where: { userId: user.id, startAt: { lt: to }, endAt: { gt: from } }, orderBy: { startAt: 'asc' } }),
  ]);
  const items: IcsEvent[] = [
    ...blocks.map((b) => ({
      uid: `block-${b.id}@smart-scheduling`,
      title: `${b.status === 'COMPLETED' ? '✅ ' : ''}${b.task.title}`,
      start: b.startAt,
      end: b.endAt,
      description: `${b.task.project.name} · planned by Smart Scheduling`,
      categories: [b.task.project.name],
    })),
    ...events.map((e) => ({
      uid: `event-${e.id}@smart-scheduling`,
      title: e.title,
      start: e.startAt,
      end: e.endAt,
      transparent: e.eventType === 'BREAK',
    })),
  ];
  res
    .status(200)
    .type('text/calendar; charset=utf-8')
    .setHeader('Cache-Control', 'private, max-age=300')
    .send(buildIcs({ name: `${user.name.split(' ')[0]}'s plan · Smart Scheduling`, events: items }));
});
