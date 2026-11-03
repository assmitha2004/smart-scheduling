import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { parse } from '../../middleware/validate.js';
import { currentUser } from '../../middleware/auth.js';
import { unprocessable } from '../../utils/errors.js';
import { assertProjectAccess } from '../access.js';
import { findCycle } from '../../engine/index.js';
import { logActivity } from '../activity/activity.service.js';
import { extractTasks } from './ai.client.js';
import { serializeTask } from '../tasks/tasks.routes.js';
import { emitToUser } from '../../realtime/socket.js';

export const aiRouter = Router();

/**
 * POST /ai/extract-tasks — turns free text into DRAFT tasks. Nothing is
 * saved; the user reviews and confirms via /ai/confirm-tasks.
 */
aiRouter.post('/extract-tasks', async (req, res) => {
  const me = currentUser(req);
  const { text } = parse(z.object({ text: z.string().trim().min(3).max(5000) }), req.body);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
  const result = await extractTasks(text, { timezone: user.timezone, allowExternal: user.aiExternalConsent });
  res.json({ status: 'draft', ...result, externalAiUsed: result.provider !== 'rules', consentGiven: user.aiExternalConsent });
});

const confirmSchema = z.object({
  projectId: z.string().uuid(),
  tasks: z
    .array(
      z.object({
        tempId: z.string().min(1).max(64),
        title: z.string().trim().min(1).max(300),
        description: z.string().max(5000).nullable().optional(),
        estimatedMinutes: z.number().int().min(1, 'Confirm an estimate').max(10_000),
        dueAt: z.coerce.date().nullable().optional(),
        priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
      }),
    )
    .min(1)
    .max(50),
  dependencies: z.array(z.object({ taskTempId: z.string(), dependsOnTempId: z.string() })).max(200).default([]),
});

/** POST /ai/confirm-tasks — persist user-approved drafts (with their dependencies) atomically. */
aiRouter.post('/confirm-tasks', async (req, res) => {
  const me = currentUser(req);
  const body = parse(confirmSchema, req.body);
  const project = await assertProjectAccess(me.id, body.projectId);
  const ids = new Set(body.tasks.map((t) => t.tempId));
  if (ids.size !== body.tasks.length) throw unprocessable('DUPLICATE_TEMP_ID', 'Duplicate draft ids');
  const deps = body.dependencies.filter((d) => ids.has(d.taskTempId) && ids.has(d.dependsOnTempId));
  const cycle = findCycle(ids, deps.map((d) => ({ taskId: d.taskTempId, dependsOnTaskId: d.dependsOnTempId })));
  if (cycle) throw unprocessable('DEPENDENCY_CYCLE', 'These dependencies form a cycle', { cycle });

  const created = await prisma.$transaction(async (tx) => {
    const map = new Map<string, string>();
    for (const t of body.tasks) {
      const row = await tx.task.create({
        data: {
          projectId: project.id,
          title: t.title,
          description: t.description ?? null,
          estimatedMinutes: t.estimatedMinutes,
          dueAt: t.dueAt ?? null,
          priority: t.priority,
        },
      });
      map.set(t.tempId, row.id);
    }
    for (const d of deps) {
      await tx.taskDependency.create({ data: { taskId: map.get(d.taskTempId)!, dependsOnTaskId: map.get(d.dependsOnTempId)! } });
    }
    await logActivity({ workspaceId: project.workspaceId, actorId: me.id, entityType: 'project', entityId: project.id, action: 'ai.tasks_confirmed', metadata: { count: body.tasks.length } }, tx);
    return tx.task.findMany({ where: { id: { in: [...map.values()] } }, include: { dependencies: true } });
  });
  emitToUser(me.id, 'task:updated', {});
  res.status(201).json({ tasks: created.map(serializeTask) });
});
