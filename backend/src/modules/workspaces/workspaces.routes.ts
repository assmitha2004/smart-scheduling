import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { parse } from '../../middleware/validate.js';
import { currentUser } from '../../middleware/auth.js';
import { badRequest, notFound } from '../../utils/errors.js';
import { assertWorkspaceMember } from '../access.js';
import { logActivity } from '../activity/activity.service.js';

export const workspacesRouter = Router();

workspacesRouter.get('/', async (req, res) => {
  const me = currentUser(req);
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: me.id },
    include: { workspace: { include: { _count: { select: { projects: true, members: true } } } } },
    orderBy: { createdAt: 'asc' },
  });
  res.json({
    workspaces: memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      role: m.role,
      projectCount: m.workspace._count.projects,
      memberCount: m.workspace._count.members,
    })),
  });
});

workspacesRouter.post('/', async (req, res) => {
  const me = currentUser(req);
  const { name } = parse(z.object({ name: z.string().trim().min(1).max(100) }), req.body);
  const ws = await prisma.$transaction(async (tx) => {
    const w = await tx.workspace.create({ data: { name, ownerId: me.id } });
    await tx.workspaceMember.create({ data: { workspaceId: w.id, userId: me.id, role: 'OWNER' } });
    await logActivity({ workspaceId: w.id, actorId: me.id, entityType: 'workspace', entityId: w.id, action: 'workspace.created' }, tx);
    return w;
  });
  res.status(201).json({ workspace: { ...ws, role: 'OWNER' } });
});

workspacesRouter.get('/:id/members', async (req, res) => {
  const me = currentUser(req);
  await assertWorkspaceMember(me.id, req.params.id);
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId: req.params.id },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  res.json({ members: members.map((m) => ({ ...m.user, role: m.role })) });
});

workspacesRouter.post('/:id/members', async (req, res) => {
  const me = currentUser(req);
  await assertWorkspaceMember(me.id, req.params.id, ['OWNER', 'ADMIN']);
  const body = parse(z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER') }), req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  if (!user) throw notFound('User with that email');
  const m = await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: req.params.id, userId: user.id } },
    create: { workspaceId: req.params.id, userId: user.id, role: body.role },
    update: { role: body.role },
  });
  await logActivity({ workspaceId: req.params.id, actorId: me.id, entityType: 'workspace', entityId: req.params.id, action: 'member.added', metadata: { userId: user.id, role: body.role } });
  res.status(201).json({ member: { id: user.id, name: user.name, email: user.email, role: m.role } });
});

workspacesRouter.delete('/:id/members/:userId', async (req, res) => {
  const me = currentUser(req);
  await assertWorkspaceMember(me.id, req.params.id, ['OWNER', 'ADMIN']);
  const target = await assertWorkspaceMember(req.params.userId, req.params.id);
  if (target.role === 'OWNER') throw badRequest('The workspace owner cannot be removed');
  await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: req.params.id, userId: req.params.userId } } });
  res.status(204).end();
});

workspacesRouter.get('/:id/activity', async (req, res) => {
  const me = currentUser(req);
  await assertWorkspaceMember(me.id, req.params.id);
  const items = await prisma.activityLog.findMany({
    where: { workspaceId: req.params.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { actor: { select: { id: true, name: true } } },
  });
  res.json({ activity: items });
});
