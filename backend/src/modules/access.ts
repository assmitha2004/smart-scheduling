import type { WorkspaceRole } from '@prisma/client';
import { prisma } from '../db.js';
import { forbidden, notFound } from '../utils/errors.js';

/**
 * Authorization helpers. Every protected resource is resolved to its
 * workspace and the caller's membership is checked on each request.
 */
export async function assertWorkspaceMember(userId: string, workspaceId: string, roles?: WorkspaceRole[]) {
  const m = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
  if (!m) throw forbidden('You are not a member of this workspace');
  if (roles && !roles.includes(m.role)) throw forbidden('Your role does not allow this action');
  return m;
}

export async function assertProjectAccess(userId: string, projectId: string, roles?: WorkspaceRole[]) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw notFound('Project');
  await assertWorkspaceMember(userId, project.workspaceId, roles);
  return project;
}

export async function assertTaskAccess(userId: string, taskId: string) {
  const task = await prisma.task.findUnique({ where: { id: taskId }, include: { project: true } });
  if (!task) throw notFound('Task');
  await assertWorkspaceMember(userId, task.project.workspaceId);
  return task;
}

export async function userWorkspaceIds(userId: string): Promise<string[]> {
  const ms = await prisma.workspaceMember.findMany({ where: { userId }, select: { workspaceId: true } });
  return ms.map((m) => m.workspaceId);
}
