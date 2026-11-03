import type { Prisma, Task, User } from '@prisma/client';
import { prisma } from '../../db.js';
import { config } from '../../config.js';
import {
  analyzeDeadline,
  deadlineTargets,
  descendants,
  findOverlaps,
  generateSchedule,
  overlaps,
  replan,
  type DeadlineRisk,
  type EngineDependency,
  type EngineTask,
  type ExistingBlock,
  type ReplanResult,
  type ScheduleInput,
  type ScheduleResult,
} from '../../engine/index.js';
import { conflict, notFound, unprocessable } from '../../utils/errors.js';
import { iso, ms } from '../../utils/time.js';
import { userWorkspaceIds } from '../access.js';
import { logActivity } from '../activity/activity.service.js';
import { emitToUser } from '../../realtime/socket.js';
import { scheduleBlockReminders } from '../../queues/index.js';
import { resolvePrefs } from '../notifications/notifications.service.js';

export interface ScheduleContext {
  user: User;
  input: ScheduleInput;
  tasks: Map<string, Task & { project: { id: string; name: string; color: string; workspaceId: string } }>;
  projects: { id: string; name: string; targetDate: number | null; color: string }[];
  /** Confirmed blocks that start in the future (candidates to be replaced). */
  futureBlocks: ExistingBlock[];
}

export interface TaskChange {
  taskId: string;
  /** Task cannot start before this instant (models "slipped to Tuesday"). */
  delayUntil?: string;
  estimatedMinutes?: number;
  priority?: Task['priority'];
}

const OPEN_STATUSES = ['TODO', 'IN_PROGRESS'] as const;

export function toEngineTask(t: Task): EngineTask {
  return {
    id: t.id,
    title: t.title,
    projectId: t.projectId,
    estimatedMinutes: t.estimatedMinutes,
    actualMinutes: t.actualMinutes,
    priority: t.priority,
    status: t.status,
    earliestStartAt: ms(t.earliestStartAt),
    dueAt: ms(t.dueAt),
    createdAt: t.createdAt.getTime(),
    splittable: t.splittable,
  };
}

/**
 * Loads everything the engine needs for one user's personal schedule:
 * their open tasks (assigned to them, or unassigned in their workspaces),
 * completed prerequisites, teammates' prerequisites (as external
 * constraints), availability, fixed events and in-progress blocks.
 */
export async function loadScheduleContext(userId: string, now = Date.now()): Promise<ScheduleContext> {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { availabilityRules: true } });
  if (!user) throw notFound('User');
  const workspaceIds = await userWorkspaceIds(userId);
  const horizonEnd = new Date(now + config.planningHorizonDays * 86_400_000);
  const projectSelect = { select: { id: true, name: true, color: true, workspaceId: true } } as const;

  const scopeWhere: Prisma.TaskWhereInput = {
    project: { workspaceId: { in: workspaceIds }, status: { notIn: ['ARCHIVED', 'COMPLETED'] } },
    OR: [{ assigneeId: userId }, { assigneeId: null }],
  };
  const openTasks = await prisma.task.findMany({
    where: { ...scopeWhere, status: { in: [...OPEN_STATUSES] } },
    include: { project: projectSelect },
  });
  const openIds = openTasks.map((t) => t.id);
  const deps = await prisma.taskDependency.findMany({
    where: { OR: [{ taskId: { in: openIds } }, { dependsOnTaskId: { in: openIds } }] },
  });

  const tasks = new Map(openTasks.map((t) => [t.id, t]));
  // Prerequisites outside the open set: completed ones, or other people's.
  const missingPrereqIds = [...new Set(deps.filter((d) => tasks.has(d.taskId) && !tasks.has(d.dependsOnTaskId)).map((d) => d.dependsOnTaskId))];
  const prereqRows = await prisma.task.findMany({ where: { id: { in: missingPrereqIds } }, include: { project: projectSelect } });
  const external = new Map<string, { title: string; readyAt: number | null }>();
  const externalOpen = prereqRows.filter((p) => p.status === 'TODO' || p.status === 'IN_PROGRESS');
  if (externalOpen.length) {
    const extBlocks = await prisma.scheduledBlock.groupBy({
      by: ['taskId'],
      where: { taskId: { in: externalOpen.map((p) => p.id) }, status: 'CONFIRMED' },
      _max: { endAt: true },
    });
    const readyBy = new Map(extBlocks.map((b) => [b.taskId, ms(b._max.endAt)]));
    for (const p of externalOpen) external.set(p.id, { title: p.title, readyAt: readyBy.get(p.id) ?? null });
  }
  for (const p of prereqRows) if (!external.has(p.id)) tasks.set(p.id, p); // completed prerequisites

  const engineTasks = [...tasks.values()].map(toEngineTask);
  for (const et of engineTasks) {
    const ext = deps
      .filter((d) => d.taskId === et.id && external.has(d.dependsOnTaskId))
      .map((d) => ({ taskId: d.dependsOnTaskId, ...external.get(d.dependsOnTaskId)! }));
    if (ext.length) et.externalPrereqs = ext;
  }
  const engineDeps: EngineDependency[] = deps
    .filter((d) => tasks.has(d.taskId) && tasks.has(d.dependsOnTaskId))
    .map((d) => ({ taskId: d.taskId, dependsOnTaskId: d.dependsOnTaskId }));

  const [events, blocks] = await Promise.all([
    prisma.calendarEvent.findMany({
      where: { userId, startAt: { lt: horizonEnd }, endAt: { gt: new Date(now) } },
    }),
    prisma.scheduledBlock.findMany({
      where: { userId, status: 'CONFIRMED', endAt: { gt: new Date(now) } },
    }),
  ]);
  // Blocks already under way are treated as busy time and left alone.
  const inProgress = blocks.filter((b) => b.startAt.getTime() < now);
  const futureBlocks = blocks
    .filter((b) => b.startAt.getTime() >= now)
    .map((b) => ({ id: b.id, taskId: b.taskId, start: b.startAt.getTime(), end: b.endAt.getTime() }));

  const projectMap = new Map<string, { id: string; name: string; targetDate: number | null; color: string }>();
  const projectRows = await prisma.project.findMany({
    where: { id: { in: [...new Set(openTasks.map((t) => t.projectId))] } },
  });
  for (const p of projectRows) projectMap.set(p.id, { id: p.id, name: p.name, targetDate: ms(p.targetDate), color: p.color });

  return {
    user,
    tasks,
    projects: [...projectMap.values()],
    futureBlocks,
    input: {
      now,
      timezone: user.timezone,
      tasks: engineTasks,
      dependencies: engineDeps,
      availability: user.availabilityRules.map((r) => ({
        weekday: r.weekday,
        startTime: r.startTime,
        endTime: r.endTime,
        isActive: r.isActive,
      })),
      events: [
        ...events.map((e) => ({ id: e.id, title: e.title, start: e.startAt.getTime(), end: e.endAt.getTime(), eventType: e.eventType })),
        ...inProgress.map((b) => ({ id: b.id, title: 'In-progress block', start: b.startAt.getTime(), end: b.endAt.getTime(), eventType: 'FIXED' as const })),
      ],
      options: {
        allowSplitting: user.allowTaskSplitting,
        maxBlockMinutes: user.focusBlockMinutes,
        minBlockMinutes: Math.min(30, user.focusBlockMinutes),
        horizonDays: config.planningHorizonDays,
      },
    },
  };
}

export function computeRisks(ctx: ScheduleContext, schedule?: ScheduleResult): DeadlineRisk[] {
  const targets = deadlineTargets(ctx.input.tasks, ctx.projects);
  return targets.map((t) => analyzeDeadline(ctx.input, t, schedule)).sort((a, b) => riskOrder(a) - riskOrder(b) || a.dueAt - b.dueAt);
}

function riskOrder(r: DeadlineRisk): number {
  return { OVERDUE: 0, INFEASIBLE: 1, AT_RISK: 2, ON_TRACK: 3, DONE: 4 }[r.status];
}

/** Serialises engine output (epoch ms) into the public API shape (ISO strings + titles). */
export function serializeSchedule(result: ScheduleResult, ctx: ScheduleContext) {
  const t = (id: string) => ctx.tasks.get(id);
  return {
    ok: result.ok,
    proposedBlocks: result.proposedBlocks.map((b) => ({
      taskId: b.taskId,
      title: t(b.taskId)?.title ?? b.taskId,
      projectId: t(b.taskId)?.projectId ?? null,
      projectName: t(b.taskId)?.project.name ?? null,
      color: t(b.taskId)?.project.color ?? null,
      startAt: iso(b.startAt)!,
      endAt: iso(b.endAt)!,
      locked: !!b.locked,
    })),
    unscheduledTasks: result.unscheduledTasks.map((u) => ({ ...u, title: t(u.taskId)?.title ?? u.taskId })),
    warnings: result.warnings.map((w) => ({ ...w, title: t(w.taskId)?.title ?? w.taskId })),
    conflicts: result.conflicts,
    explanations: result.explanations.map((e) => ({
      ...e,
      earliestPossibleStart: iso(e.earliestPossibleStart),
      plannedStart: iso(e.plannedStart),
      plannedFinish: iso(e.plannedFinish),
    })),
    criticalPath: result.criticalPath.map((id) => ({ taskId: id, title: t(id)?.title ?? id })),
    summary: {
      ...result.summary,
      horizonStart: iso(result.summary.horizonStart),
      horizonEnd: iso(result.summary.horizonEnd),
      projectedFinish: iso(result.summary.projectedFinish),
    },
  };
}

export function serializeRisk(r: DeadlineRisk) {
  return { ...r, dueAt: iso(r.dueAt), plannedFinish: iso(r.plannedFinish) };
}

interface StoredPayload {
  kind: 'preview' | 'replan';
  blocks: { taskId: string; startAt: number; endAt: number; locked?: boolean }[];
  taskUpdates?: TaskChange[];
}

async function storeRecommendation(
  userId: string,
  baseVersion: number,
  type: 'SCHEDULE_PREVIEW' | 'REPLAN',
  reason: string,
  payload: StoredPayload,
) {
  return prisma.scheduleRecommendation.create({
    data: {
      userId,
      recommendationType: type,
      reason,
      baseVersion,
      payload: payload as unknown as Prisma.InputJsonValue,
    },
  });
}

/** POST /schedules/preview — runs the engine and stores a pending recommendation. */
export async function previewSchedule(userId: string, now = Date.now()) {
  const ctx = await loadScheduleContext(userId, now);
  const result = generateSchedule(ctx.input);
  const risks = computeRisks(ctx, result.ok ? result : undefined);
  let recommendationId: string | null = null;
  if (result.ok) {
    const rec = await storeRecommendation(userId, ctx.user.scheduleVersion, 'SCHEDULE_PREVIEW', 'Full schedule generated on request', {
      kind: 'preview',
      blocks: result.proposedBlocks.map((b) => ({ taskId: b.taskId, startAt: b.startAt, endAt: b.endAt })),
    });
    recommendationId = rec.id;
  }
  return {
    recommendationId,
    scheduleVersion: ctx.user.scheduleVersion,
    ...serializeSchedule(result, ctx),
    risks: risks.map(serializeRisk),
  };
}

/** Applies proposed task changes in memory (for previewing a replan). */
function applyChanges(input: ScheduleInput, changes: TaskChange[]): ScheduleInput {
  const byId = new Map(changes.map((c) => [c.taskId, c]));
  return {
    ...input,
    tasks: input.tasks.map((t) => {
      const c = byId.get(t.id);
      if (!c) return t;
      return {
        ...t,
        earliestStartAt: c.delayUntil ? Math.max(new Date(c.delayUntil).getTime(), t.earliestStartAt ?? 0) : t.earliestStartAt,
        estimatedMinutes: c.estimatedMinutes ?? t.estimatedMinutes,
        priority: c.priority ?? t.priority,
      };
    }),
  };
}

/** POST /schedules/replan — recalculates only affected work and returns a before/after preview. */
export async function previewReplan(
  userId: string,
  params: { changes?: TaskChange[]; taskIds?: string[]; full?: boolean },
  now = Date.now(),
) {
  const ctx = await loadScheduleContext(userId, now);
  const changes = (params.changes ?? []).filter((c) => ctx.tasks.has(c.taskId));
  const unknown = (params.changes ?? []).filter((c) => !ctx.tasks.has(c.taskId)).map((c) => c.taskId);
  if (unknown.length) throw unprocessable('UNKNOWN_TASK', 'Some tasks are not part of your schedule', unknown);
  const input = applyChanges(ctx.input, changes);
  const changedTaskIds = [...new Set([...changes.map((c) => c.taskId), ...(params.taskIds ?? [])])];
  const r: ReplanResult = replan({ input, previousBlocks: ctx.futureBlocks, changedTaskIds, full: params.full });
  const scopedCtx = { ...ctx, input };
  const risks = computeRisks(scopedCtx, r.schedule.ok ? r.schedule : undefined);

  let recommendationId: string | null = null;
  if (r.schedule.ok) {
    const rec = await storeRecommendation(
      userId,
      ctx.user.scheduleVersion,
      'REPLAN',
      changes.length
        ? `Replan after changes to ${changes.map((c) => `"${ctx.tasks.get(c.taskId)!.title}"`).join(', ')}`
        : 'Replan requested',
      {
        kind: 'replan',
        blocks: r.schedule.proposedBlocks.map((b) => ({ taskId: b.taskId, startAt: b.startAt, endAt: b.endAt, locked: b.locked })),
        taskUpdates: changes,
      },
    );
    recommendationId = rec.id;
  }
  const projectName = (id: string) => ctx.projects.find((p) => p.id === id)?.name ?? id;
  return {
    recommendationId,
    scheduleVersion: ctx.user.scheduleVersion,
    changedTaskIds: r.changedTaskIds,
    affectedTasks: r.affectedTaskIds.map((id) => ({ taskId: id, title: ctx.tasks.get(id)?.title ?? id })),
    impactChain: r.impactChain,
    diff: r.diff.map((d) => ({
      ...d,
      before: d.before.map((b) => ({ startAt: iso(b.startAt), endAt: iso(b.endAt) })),
      after: d.after.map((b) => ({ startAt: iso(b.startAt), endAt: iso(b.endAt) })),
    })),
    impact: {
      previousFinish: iso(r.impact.previousFinish),
      newFinish: iso(r.impact.newFinish),
      shiftMinutes: r.impact.shiftMinutes,
      byProject: r.impact.byProject.map((p) => ({
        projectId: p.projectId,
        projectName: projectName(p.projectId),
        previousFinish: iso(p.previousFinish),
        newFinish: iso(p.newFinish),
      })),
    },
    ...serializeSchedule(r.schedule, scopedCtx),
    risks: risks.map(serializeRisk),
  };
}

/**
 * POST /schedules/commit — atomically replaces the user's future blocks with
 * an approved recommendation.
 *
 * Concurrency: the user's `scheduleVersion` is bumped with a compare-and-set
 * (`UPDATE ... WHERE schedule_version = expected`). If another session
 * committed first, zero rows match and the commit is rejected with 409
 * (Scenario E). The Postgres exclusion constraint on scheduled_blocks is a
 * second line of defence against overlapping blocks (Scenario B).
 */
export async function commitRecommendation(
  userId: string,
  params: { recommendationId: string; expectedVersion: number; excludeTaskIds?: string[] },
  now = Date.now(),
) {
  const result = await prisma.$transaction(async (tx) => {
    const rec = await tx.scheduleRecommendation.findFirst({ where: { id: params.recommendationId, userId } });
    if (!rec) throw notFound('Recommendation');
    if (rec.status !== 'PENDING') {
      throw conflict('RECOMMENDATION_RESOLVED', `This recommendation was already ${rec.status.toLowerCase()}. Generate a new preview.`);
    }
    if (rec.baseVersion !== params.expectedVersion) {
      throw conflict('STALE_SCHEDULE', 'This preview was generated for a different schedule version.', {
        expectedVersion: params.expectedVersion,
        recommendationVersion: rec.baseVersion,
      });
    }
    const cas = await tx.user.updateMany({
      where: { id: userId, scheduleVersion: params.expectedVersion },
      data: { scheduleVersion: { increment: 1 } },
    });
    if (cas.count === 0) {
      const u = await tx.user.findUnique({ where: { id: userId }, select: { scheduleVersion: true } });
      throw conflict('STALE_SCHEDULE', 'Your schedule was changed in another session since this preview was generated. Review the latest plan and try again.', {
        expectedVersion: params.expectedVersion,
        currentVersion: u?.scheduleVersion,
      });
    }
    const newVersion = params.expectedVersion + 1;
    const payload = rec.payload as unknown as StoredPayload;

    // Rejecting a task also rejects everything downstream of it.
    const deps = await tx.taskDependency.findMany({
      where: { taskId: { in: payload.blocks.map((b) => b.taskId) } },
      select: { taskId: true, dependsOnTaskId: true },
    });
    const excluded = new Set(params.excludeTaskIds ?? []);
    for (const d of descendants([...excluded], deps)) excluded.add(d);

    const existingTasks = await tx.task.findMany({
      where: { id: { in: payload.blocks.map((b) => b.taskId) }, status: { in: [...OPEN_STATUSES] } },
      select: { id: true, project: { select: { workspaceId: true } } },
    });
    const live = new Set(existingTasks.map((t) => t.id));
    const blocks = payload.blocks.filter((b) => !excluded.has(b.taskId) && live.has(b.taskId) && b.endAt > now);

    // Re-validate against the current calendar: events may have been added after the preview.
    const internal = findOverlaps(blocks.map((b) => ({ ...b, start: b.startAt, end: b.endAt })));
    if (internal.length) throw conflict('SCHEDULE_CONFLICT', 'Proposed blocks overlap each other.');
    if (blocks.length) {
      const minStart = new Date(Math.min(...blocks.map((b) => b.startAt)));
      const maxEnd = new Date(Math.max(...blocks.map((b) => b.endAt)));
      const events = await tx.calendarEvent.findMany({ where: { userId, startAt: { lt: maxEnd }, endAt: { gt: minStart } } });
      const inProgress = await tx.scheduledBlock.findMany({
        where: { userId, status: 'CONFIRMED', startAt: { lt: new Date(now) }, endAt: { gt: new Date(now) } },
      });
      const busy = [
        ...events.map((e) => ({ title: e.title, start: e.startAt.getTime(), end: e.endAt.getTime() })),
        ...inProgress.map((b) => ({ title: 'a block in progress', start: b.startAt.getTime(), end: b.endAt.getTime() })),
      ];
      const clashes = blocks.flatMap((b) =>
        busy.filter((e) => overlaps({ start: b.startAt, end: b.endAt }, e)).map((e) => ({ taskId: b.taskId, with: e.title })),
      );
      if (clashes.length) {
        throw conflict('SCHEDULE_CONFLICT', 'Your calendar changed since this preview: some blocks now clash with fixed events. Generate a new preview.', clashes);
      }
    }

    // Apply task changes that were part of a replan (e.g. a delay).
    for (const c of payload.taskUpdates ?? []) {
      if (!live.has(c.taskId) || excluded.has(c.taskId)) continue;
      await tx.task.update({
        where: { id: c.taskId },
        data: {
          ...(c.delayUntil ? { earliestStartAt: new Date(c.delayUntil) } : {}),
          ...(c.estimatedMinutes != null ? { estimatedMinutes: c.estimatedMinutes } : {}),
          ...(c.priority ? { priority: c.priority } : {}),
          version: { increment: 1 },
        },
      });
    }

    const cancelled = await tx.scheduledBlock.updateMany({
      where: { userId, status: 'CONFIRMED', startAt: { gte: new Date(now) } },
      data: { status: 'CANCELLED' },
    });
    await tx.scheduledBlock.createMany({
      data: blocks.map((b) => ({
        taskId: b.taskId,
        userId,
        startAt: new Date(b.startAt),
        endAt: new Date(b.endAt),
        status: 'CONFIRMED' as const,
        scheduleVersion: newVersion,
      })),
    });
    await tx.scheduleRecommendation.update({ where: { id: rec.id }, data: { status: 'ACCEPTED', resolvedAt: new Date() } });
    await tx.scheduleRecommendation.updateMany({
      where: { userId, status: 'PENDING', id: { not: rec.id } },
      data: { status: 'SUPERSEDED', resolvedAt: new Date() },
    });
    const workspaceIds = [...new Set(existingTasks.map((t) => t.project.workspaceId))];
    for (const ws of workspaceIds.length ? workspaceIds : [null]) {
      await logActivity(
        {
          workspaceId: ws,
          actorId: userId,
          entityType: 'schedule',
          entityId: rec.id,
          action: 'schedule.committed',
          metadata: { version: newVersion, blocks: blocks.length, cancelled: cancelled.count, excluded: [...excluded] },
        },
        tx,
      );
    }
    const created = await tx.scheduledBlock.findMany({
      where: { userId, scheduleVersion: newVersion, status: 'CONFIRMED' },
      select: { id: true, startAt: true },
    });
    return { scheduleVersion: newVersion, committedBlocks: blocks.length, cancelledBlocks: cancelled.count, excludedTaskIds: [...excluded], created };
  });

  const user = await prisma.user.findUnique({ where: { id: userId } });
  await scheduleBlockReminders(result.created, resolvePrefs(user?.notificationPrefs).reminderLeadMinutes).catch((e) =>
    console.warn('[queue] could not schedule reminders:', (e as Error).message),
  );
  emitToUser(userId, 'schedule:updated', { scheduleVersion: result.scheduleVersion });
  const { created: _created, ...rest } = result;
  return rest;
}

export async function dismissRecommendation(userId: string, recommendationId: string) {
  const r = await prisma.scheduleRecommendation.updateMany({
    where: { id: recommendationId, userId, status: 'PENDING' },
    data: { status: 'DISMISSED', resolvedAt: new Date() },
  });
  if (!r.count) throw notFound('Pending recommendation');
}
