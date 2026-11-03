import { Router } from 'express';
import { prisma } from '../../db.js';
import { currentUser } from '../../middleware/auth.js';
import { notFound } from '../../utils/errors.js';

export const notificationsRouter = Router();

notificationsRouter.get('/', async (req, res) => {
  const me = currentUser(req);
  const unreadOnly = req.query.unread === 'true';
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: me.id, ...(unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.notification.count({ where: { userId: me.id, readAt: null } }),
  ]);
  res.json({ notifications: items, unreadCount: unread });
});

notificationsRouter.post('/:id/read', async (req, res) => {
  const r = await prisma.notification.updateMany({
    where: { id: req.params.id, userId: currentUser(req).id, readAt: null },
    data: { readAt: new Date() },
  });
  if (!r.count) {
    const exists = await prisma.notification.count({ where: { id: req.params.id, userId: currentUser(req).id } });
    if (!exists) throw notFound('Notification');
  }
  res.status(204).end();
});

notificationsRouter.post('/read-all', async (req, res) => {
  await prisma.notification.updateMany({ where: { userId: currentUser(req).id, readAt: null }, data: { readAt: new Date() } });
  res.status(204).end();
});
