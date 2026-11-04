import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { config } from '../../config.js';
import { parse } from '../../middleware/validate.js';
import { currentUser, signAccessToken } from '../../middleware/auth.js';
import { badRequest, notFound, unauthorized } from '../../utils/errors.js';
import { serializeUser } from '../users/users.routes.js';

/** Account security and privacy: password change, data export, account deletion. */
export const accountRouter = Router();

const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

async function checkPassword(userId: string, password: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('User');
  if (!(await bcrypt.compare(password, user.passwordHash))) throw unauthorized('That password is not right');
  return user;
}

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Password must be at least 8 characters').max(200),
});

/** POST /account/password — signs out every other device and returns fresh tokens for this one. */
accountRouter.post('/password', async (req, res) => {
  const me = currentUser(req);
  const body = parse(passwordSchema, req.body);
  const user = await checkPassword(me.id, body.currentPassword);
  if (body.currentPassword === body.newPassword) throw badRequest('Choose a password different from the current one');
  const passwordHash = await bcrypt.hash(body.newPassword, 10);
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
    prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.refreshToken.create({ data: { userId: user.id, tokenHash: hashToken(refreshToken), expiresAt: new Date(Date.now() + config.refreshTokenTtlDays * 86_400_000) } }),
  ]);
  res.json({ accessToken: signAccessToken(user), refreshToken, expiresIn: config.accessTokenTtlSeconds });
});

/** GET /account/export — everything stored about the user, as a JSON download. */
accountRouter.get('/export', async (req, res) => {
  const me = currentUser(req);
  const user = await prisma.user.findUnique({ where: { id: me.id } });
  if (!user) throw notFound('User');
  const [availability, events, blocks, notifications, memberships] = await Promise.all([
    prisma.availabilityRule.findMany({ where: { userId: me.id } }),
    prisma.calendarEvent.findMany({ where: { userId: me.id }, orderBy: { startAt: 'asc' } }),
    prisma.scheduledBlock.findMany({ where: { userId: me.id }, orderBy: { startAt: 'asc' } }),
    prisma.notification.findMany({ where: { userId: me.id }, orderBy: { createdAt: 'asc' } }),
    prisma.workspaceMember.findMany({ where: { userId: me.id }, include: { workspace: true } }),
  ]);
  const workspaceIds = memberships.map((m) => m.workspaceId);
  const projects = await prisma.project.findMany({
    where: { workspaceId: { in: workspaceIds } },
    include: { milestones: true, tasks: { include: { dependencies: true, comments: { where: { authorId: me.id } } } } },
  });
  const { passwordHash: _omit, calendarFeedToken: _token, ...profile } = user;
  const filename = `smart-scheduling-export-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.json({
    exportedAt: new Date().toISOString(),
    profile: { ...serializeUser(user), lifeProfile: profile.lifeProfile },
    workspaces: memberships.map((m) => ({ id: m.workspace.id, name: m.workspace.name, role: m.role })),
    availability,
    projects,
    calendarEvents: events,
    scheduledBlocks: blocks,
    notifications,
  });
});

/** DELETE /account — permanently deletes the account, its workspaces and everything in them. */
accountRouter.delete('/', async (req, res) => {
  const me = currentUser(req);
  const body = parse(z.object({ password: z.string().min(1), confirm: z.literal('DELETE') }), req.body);
  await checkPassword(me.id, body.password);
  await prisma.$transaction(async (tx) => {
    // Workspaces this user owns (with their projects and tasks) go too; everything else cascades from the user.
    await tx.workspace.deleteMany({ where: { ownerId: me.id } });
    await tx.user.delete({ where: { id: me.id } });
  });
  res.status(204).end();
});
