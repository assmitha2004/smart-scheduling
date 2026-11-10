import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import type { Prisma, Task, User } from '@prisma/client';
import { prisma } from '../../db.js';
import { parse } from '../../middleware/validate.js';
import { currentUser } from '../../middleware/auth.js';
import { badRequest, notFound } from '../../utils/errors.js';
import { emitToUser } from '../../realtime/socket.js';
import {
  compliment,
  fromMin,
  parseBrainDump,
  parseTaskLine,
  planDay,
  toMin,
  type Busy,
  type DayTaskInput,
  type Effort,
  type Peak,
  type PlanItem,
} from '../../day/dayPlan.js';

/**
 * "My Day": give it your tasks, answer a few questions, get a realistic plan
 * for the day; tick things off; whatever is left moves to the next day.
 */
export const dayRouter = Router();

const MY_DAY_PROJECT = '📝 My Day';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Use HH:mm');

interface Settings { dayStart: string; dayEnd: string; peak: Peak }
interface LifeProfileLite { wakeTime?: string; sleepTime?: string; chronotype?: string; meals?: { lunch?: string | null; dinner?: string | null; breakfast?: string | null } }

// ---------- helpers ----------
const localNow = (u: User) => DateTime.now().setZone(u.timezone);
const dayOf = (u: User, date: string) => DateTime.fromISO(date, { zone: u.timezone }).startOf('day');
const nextDate = (u: User, date: string) => dayOf(u, date).plus({ days: 1 }).toISODate()!;
const isToday = (u: User, date: string) => date === localNow(u).toISODate();

function resolveDate(u: User, raw: unknown): string {
  const today = localNow(u).toISODate()!;
  if (raw === undefined || raw === null || raw === '') return today;
  if (typeof raw !== 'string' || !DATE_RE.test(raw) || !dayOf(u, raw).isValid) throw badRequest('Use a date like 2026-11-10');
  return raw;
}

/** Sensible day settings from the user's saved routine (if any). */
function defaultSettings(u: User, date: string): Settings {
  const p = (u.lifeProfile ?? {}) as LifeProfileLite;
  const wake = toMin(p.wakeTime ?? '07:00');
  let sleep = toMin(p.sleepTime ?? '23:00');
  if (sleep <= wake) sleep = 1440;
  const peak: Peak = p.chronotype === 'EARLY_BIRD' ? 'MORNING' : p.chronotype === 'NIGHT_OWL' ? 'EVENING' : 'AFTERNOON';
  let start = Math.min(wake + 30, 1380);
  if (isToday(u, date)) {
    const n = localNow(u);
    start = Math.max(start, Math.ceil((n.hour * 60 + n.minute) / 15) * 15);
  }
  const end = Math.max(Math.min(1440, sleep - 60), Math.min(1440, start + 60));
  return { dayStart: fromMin(Math.min(start, 1425)), dayEnd: fromMin(end), peak };
}

async function myDayProject(userId: string): Promise<string> {
  const ws = (await prisma.workspace.findFirst({ where: { ownerId: userId }, orderBy: { createdAt: 'asc' } }))
    ?? (await prisma.workspaceMember.findFirst({ where: { userId }, include: { workspace: true } }))?.workspace;
  if (!ws) throw badRequest('Create a workspace first');
  const existing = await prisma.project.findFirst({ where: { workspaceId: ws.id, name: MY_DAY_PROJECT } });
  if (existing) {
    if (existing.status === 'ARCHIVED' || existing.status === 'COMPLETED') await prisma.project.update({ where: { id: existing.id }, data: { status: 'ACTIVE' } });
    return existing.id;
  }
  return (await prisma.project.create({ data: { workspaceId: ws.id, name: MY_DAY_PROJECT, color: '#f59e0b', description: 'Tasks planned with My Day' } })).id;
}

/** Calendar events, accepted week-plan blocks and meals on that day, as local minutes. */
async function busyFor(u: User, date: string): Promise<Busy[]> {
  const start = dayOf(u, date);
  const end = start.plus({ days: 1 });
  const toLocal = (d: Date) => Math.max(0, Math.min(1440, Math.round(DateTime.fromJSDate(d).setZone(u.timezone).diff(start, 'minutes').minutes)));
  const [events, blocks] = await Promise.all([
    prisma.calendarEvent.findMany({ where: { userId: u.id, startAt: { lt: end.toJSDate() }, endAt: { gt: start.toJSDate() } } }),
    prisma.scheduledBlock.findMany({ where: { userId: u.id, status: 'CONFIRMED', startAt: { lt: end.toJSDate() }, endAt: { gt: start.toJSDate() } }, include: { task: { select: { title: true } } } }),
  ]);
  const busy: Busy[] = [
    ...events.map((e) => ({ title: e.title, start: toLocal(e.startAt), end: toLocal(e.endAt), kind: (e.eventType === 'BREAK' ? 'BREAK' : 'BUSY') as Busy['kind'] })),
    ...blocks.map((b) => ({ title: `📅 ${b.task.title}`, start: toLocal(b.startAt), end: toLocal(b.endAt), kind: 'BUSY' as const })),
  ].filter((b) => b.end > b.start);
  // No meals on the calendar? Use the saved meal times (or sensible defaults).
  if (!busy.some((b) => b.kind === 'BREAK')) {
    const meals = ((u.lifeProfile ?? {}) as LifeProfileLite).meals;
    const lunch = meals?.lunch === undefined ? '13:00' : meals.lunch;
    const dinner = meals?.dinner === undefined ? '20:00' : meals.dinner;
    if (lunch) busy.push({ title: '🥗 Lunch', start: toMin(lunch), end: toMin(lunch) + 45, kind: 'BREAK' });
    if (dinner) busy.push({ title: '🍲 Dinner', start: toMin(dinner), end: toMin(dinner) + 45, kind: 'BREAK' });
  }
  return busy;
}

const serializeTask = (t: Task) => ({
  id: t.id,
  title: t.title,
  minutes: t.estimatedMinutes,
  status: t.status,
  done: t.status === 'DONE',
  mustDo: t.mustDo,
  top: t.dayTop,
  effort: (t.effort ?? 'MEDIUM') as Effort,
  fixedTime: t.fixedTime,
  plannedDate: t.plannedDate,
  rolloverCount: t.rolloverCount,
  completedAt: t.completedAt?.toISOString() ?? null,
});

async function dayPayload(u: User, date: string) {
  const [plan, tasks, leftovers, tomorrowCount] = await Promise.all([
    prisma.dayPlan.findUnique({ where: { userId_date: { userId: u.id, date } } }),
    prisma.task.findMany({ where: { assigneeId: u.id, plannedDate: date }, orderBy: { createdAt: 'asc' } }),
    prisma.task.findMany({ where: { assigneeId: u.id, plannedDate: { lt: date }, status: { in: ['TODO', 'IN_PROGRESS'] } }, orderBy: { plannedDate: 'asc' }, take: 50 }),
    prisma.task.count({ where: { assigneeId: u.id, plannedDate: nextDate(u, date), status: { not: 'DONE' } } }),
  ]);
  const done = tasks.filter((t) => t.status === 'DONE').length;
  return {
    date,
    today: localNow(u).toISODate(),
    timezone: u.timezone,
    defaults: defaultSettings(u, date),
    plan: plan ? { settings: plan.settings as unknown as Settings, items: plan.items as unknown as PlanItem[], insights: plan.insights as unknown as string[], updatedAt: plan.updatedAt.toISOString() } : null,
    tasks: tasks.map(serializeTask),
    leftovers: leftovers.map(serializeTask),
    tomorrowCount,
    progress: { done, total: tasks.length, minutesDone: tasks.filter((t) => t.status === 'DONE').reduce((s, t) => s + t.estimatedMinutes, 0) },
  };
}

async function loadUser(req: Parameters<typeof currentUser>[0]) {
  const u = await prisma.user.findUnique({ where: { id: currentUser(req).id } });
  if (!u) throw notFound('User');
  return u;
}

// ---------- planning ----------
const taskSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(200),
  minutes: z.number().int().min(5).max(12 * 60),
  mustDo: z.boolean().default(false),
  top: z.boolean().default(false),
  effort: z.enum(['EASY', 'MEDIUM', 'HARD']).default('MEDIUM'),
  fixedTime: hm.nullable().optional(),
});
const settingsSchema = z.object({ dayStart: hm, dayEnd: hm, peak: z.enum(['MORNING', 'AFTERNOON', 'EVENING']) });
const planSchema = z.object({
  date: z.string().regex(DATE_RE).optional(),
  settings: settingsSchema,
  tasks: z.array(taskSchema).max(40),
  removeIds: z.array(z.string().uuid()).max(100).default([]),
  dryRun: z.boolean().default(false),
});

type TaskIn = z.infer<typeof taskSchema>;

/** Plans the day and (unless dryRun) saves tasks, the timeline and what moves to tomorrow. */
async function planAndSave(u: User, date: string, settings: Settings, input: TaskIn[], removeIds: string[], dryRun: boolean) {
  const today = localNow(u).toISODate()!;
  if (date < today) throw badRequest('That day is in the past. Plan today or a day ahead.');
  if (input.filter((t) => t.top).length > 1) throw badRequest('Pick only one #1 priority');

  const existingIds = input.map((t) => t.id).filter((x): x is string => !!x);
  const existing = existingIds.length ? await prisma.task.findMany({ where: { id: { in: existingIds }, assigneeId: u.id } }) : [];
  if (existing.length !== existingIds.length) throw notFound('Task');
  const byId = new Map(existing.map((t) => [t.id, t]));

  // Finished tasks keep their place; only open ones are (re)planned.
  const previous = await prisma.dayPlan.findUnique({ where: { userId_date: { userId: u.id, date } } });
  const doneToday = await prisma.task.findMany({ where: { assigneeId: u.id, plannedDate: date, status: 'DONE' }, select: { id: true } });
  const doneIds = new Set(doneToday.map((t) => t.id));
  const keptItems = ((previous?.items ?? []) as unknown as PlanItem[]).filter((i) => i.taskId && doneIds.has(i.taskId));

  let dayStart = toMin(settings.dayStart);
  if (date === today) {
    const n = localNow(u);
    dayStart = Math.max(dayStart, Math.ceil((n.hour * 60 + n.minute) / 5) * 5);
  }
  const dayEnd = toMin(settings.dayEnd);
  if (dayEnd - dayStart < 15) throw badRequest(date === today ? 'There’s almost no time left today. Plan tomorrow instead? 🌙' : 'The day needs to end after it starts');

  const open = input.filter((t) => !(t.id && doneIds.has(t.id)));
  const keys = open.map((t, i) => t.id ?? `new-${i}`);
  const result = planDay({
    dayStart,
    dayEnd,
    peak: settings.peak,
    busy: [
      ...(await busyFor(u, date)),
      ...keptItems.map((i) => ({ title: i.title, start: i.start, end: i.end, kind: 'BUSY' as const })),
    ],
    tasks: open.map((t, i): DayTaskInput => ({
      id: keys[i],
      title: t.title,
      minutes: t.minutes,
      mustDo: t.mustDo,
      top: t.top,
      effort: t.effort,
      fixedTime: t.fixedTime ?? null,
      fromEarlier: !!(t.id && byId.get(t.id)?.plannedDate && byId.get(t.id)!.plannedDate! < date),
    })),
  });
  // Done tasks show again as done items; busy copies of them are dropped.
  const items = [...result.items.filter((i) => !(i.kind === 'BUSY' && keptItems.some((k) => k.start === i.start && k.title === i.title))), ...keptItems].sort((a, b) => a.start - b.start);

  if (dryRun) return { preview: { items, overflow: result.overflow, insights: result.insights, stats: result.stats } };

  const projectId = await myDayProject(u.id);
  const overflowKeys = new Set(result.overflow.map((o) => o.taskId));
  const tomorrow = nextDate(u, date);
  await prisma.$transaction(async (tx) => {
    const realId = new Map<string, string>();
    for (const [i, t] of open.entries()) {
      const moved = overflowKeys.has(keys[i]);
      const data = {
        title: t.title,
        estimatedMinutes: t.minutes,
        mustDo: t.mustDo,
        dayTop: t.top,
        effort: t.effort,
        fixedTime: t.fixedTime ?? null,
        priority: (t.top ? 'URGENT' : t.mustDo ? 'HIGH' : 'MEDIUM') as Task['priority'],
        plannedDate: moved ? tomorrow : date,
      };
      if (t.id) {
        const before = byId.get(t.id)!;
        const carried = moved || (before.plannedDate !== null && before.plannedDate < date);
        await tx.task.update({ where: { id: t.id }, data: { ...data, rolloverCount: carried ? { increment: 1 } : undefined, version: { increment: 1 } } });
        realId.set(keys[i], t.id);
      } else {
        const created = await tx.task.create({ data: { ...data, projectId, assigneeId: u.id, splittable: true, rolloverCount: moved ? 1 : 0 } });
        realId.set(keys[i], created.id);
      }
    }
    if (removeIds.length) await tx.task.deleteMany({ where: { id: { in: removeIds }, assigneeId: u.id, plannedDate: { not: null }, status: { not: 'DONE' } } });
    const saved = items.map((i) => ({ ...i, taskId: i.taskId ? realId.get(i.taskId) ?? i.taskId : null }));
    const data = { settings: settings as unknown as Prisma.InputJsonValue, items: saved as unknown as Prisma.InputJsonValue, insights: result.insights as unknown as Prisma.InputJsonValue };
    await tx.dayPlan.upsert({ where: { userId_date: { userId: u.id, date } }, create: { userId: u.id, date, ...data }, update: data });
  });
  emitToUser(u.id, 'task:updated', { reason: 'day-plan' });
  return { day: await dayPayload(u, date), moved: result.overflow.map((o) => o.title) };
}

// ---------- routes ----------
/** GET /day?date=YYYY-MM-DD — the day's plan, tasks, leftovers and progress. */
dayRouter.get('/', async (req, res) => {
  const u = await loadUser(req);
  res.json(await dayPayload(u, resolveDate(u, req.query.date)));
});

/** POST /day/parse — turns free text (one task per line) into tasks with guessed times. */
dayRouter.post('/parse', async (req, res) => {
  const { text } = parse(z.object({ text: z.string().max(5000) }), req.body);
  res.json({ tasks: parseBrainDump(text) });
});

/** POST /day/plan — plan (or preview with dryRun) the day from the answers. */
dayRouter.post('/plan', async (req, res) => {
  const u = await loadUser(req);
  const body = parse(planSchema, req.body);
  const date = resolveDate(u, body.date);
  res.json(await planAndSave(u, date, body.settings, body.tasks, body.removeIds, body.dryRun));
});

/** POST /day/replan — re-plans the rest of the day from now, e.g. after "I need more time". */
dayRouter.post('/replan', async (req, res) => {
  const u = await loadUser(req);
  const body = parse(z.object({ date: z.string().regex(DATE_RE).optional(), extend: z.object({ taskId: z.string().uuid(), minutes: z.number().int().min(5).max(240) }).optional() }), req.body ?? {});
  const date = resolveDate(u, body.date);
  const plan = await prisma.dayPlan.findUnique({ where: { userId_date: { userId: u.id, date } } });
  const settings = (plan?.settings as unknown as Settings | undefined) ?? defaultSettings(u, date);
  const tasks = await prisma.task.findMany({ where: { assigneeId: u.id, plannedDate: date, status: { not: 'DONE' } }, orderBy: { createdAt: 'asc' } });
  const items = (plan?.items ?? []) as unknown as PlanItem[];
  const n = localNow(u);
  const nowMin = n.hour * 60 + n.minute;
  const input: TaskIn[] = tasks.map((t) => {
    let minutes = t.estimatedMinutes;
    if (body.extend?.taskId === t.id) {
      // Remaining time of a task in progress, plus the extra time asked for.
      const current = items.filter((i) => i.taskId === t.id);
      const running = isToday(u, date) ? current.find((i) => i.start <= nowMin && nowMin < i.end) : undefined;
      const left = running ? current.filter((i) => i.end > nowMin).reduce((s, i) => s + i.end - Math.max(i.start, nowMin), 0) : t.estimatedMinutes;
      minutes = Math.min(720, Math.max(5, left) + body.extend.minutes);
    }
    return { id: t.id, title: t.title, minutes, mustDo: t.mustDo, top: t.dayTop, effort: (t.effort ?? 'MEDIUM') as Effort, fixedTime: t.fixedTime };
  });
  res.json(await planAndSave(u, date, settings, input, [], false));
});

/** POST /day/tasks — quick-add one task to a day (it waits for "fit it in"). */
dayRouter.post('/tasks', async (req, res) => {
  const u = await loadUser(req);
  const body = parse(z.object({ date: z.string().regex(DATE_RE).optional(), text: z.string().trim().min(1).max(300) }), req.body);
  const date = resolveDate(u, body.date);
  const parsed = parseTaskLine(body.text);
  if (!parsed) throw badRequest('Type what you need to do');
  const projectId = await myDayProject(u.id);
  await prisma.task.create({ data: { projectId, assigneeId: u.id, title: parsed.title, estimatedMinutes: parsed.minutes, effort: parsed.effort, fixedTime: parsed.fixedTime, plannedDate: date } });
  res.status(201).json({ day: await dayPayload(u, date), parsed });
});

async function ownDayTask(u: User, id: string) {
  const t = await prisma.task.findFirst({ where: { id, assigneeId: u.id, plannedDate: { not: null } } });
  if (!t) throw notFound('Task');
  return t;
}

/** POST /day/tasks/:id/done — tick a task off (or un-tick it); returns a compliment. */
dayRouter.post('/tasks/:id/done', async (req, res) => {
  const u = await loadUser(req);
  const { done } = parse(z.object({ done: z.boolean().default(true) }), req.body ?? {});
  const t = await ownDayTask(u, req.params.id);
  await prisma.task.update({ where: { id: t.id }, data: { status: done ? 'DONE' : 'TODO', completedAt: done ? new Date() : null, actualMinutes: done && !t.actualMinutes ? t.estimatedMinutes : t.actualMinutes, version: { increment: 1 } } });
  const day = await dayPayload(u, t.plannedDate!);
  const message = done ? compliment({ done: day.progress.done, total: day.progress.total, wasTop: t.dayTop, seed: Date.now() }) : null;
  emitToUser(u.id, 'task:updated', { taskId: t.id });
  res.json({ day, compliment: message });
});

/** POST /day/tasks/:id/tomorrow — not today; move it to the next day. */
dayRouter.post('/tasks/:id/tomorrow', async (req, res) => {
  const u = await loadUser(req);
  const t = await ownDayTask(u, req.params.id);
  if (t.status === 'DONE') throw badRequest('That task is already done 🎉');
  const from = t.plannedDate!;
  await prisma.$transaction(async (tx) => {
    await tx.task.update({ where: { id: t.id }, data: { plannedDate: nextDate(u, from < localNow(u).toISODate()! ? localNow(u).toISODate()! : from), rolloverCount: { increment: 1 }, version: { increment: 1 } } });
    const plan = await tx.dayPlan.findUnique({ where: { userId_date: { userId: u.id, date: from } } });
    if (plan) {
      const items = (plan.items as unknown as PlanItem[]).filter((i) => i.taskId !== t.id);
      await tx.dayPlan.update({ where: { id: plan.id }, data: { items: items as unknown as Prisma.InputJsonValue } });
    }
  });
  res.json({ day: await dayPayload(u, from) });
});

/** DELETE /day/tasks/:id — remove a task you no longer need. */
dayRouter.delete('/tasks/:id', async (req, res) => {
  const u = await loadUser(req);
  const t = await ownDayTask(u, req.params.id);
  await prisma.$transaction(async (tx) => {
    await tx.task.delete({ where: { id: t.id } });
    const plan = await tx.dayPlan.findUnique({ where: { userId_date: { userId: u.id, date: t.plannedDate! } } });
    if (plan) await tx.dayPlan.update({ where: { id: plan.id }, data: { items: (plan.items as unknown as PlanItem[]).filter((i) => i.taskId !== t.id) as unknown as Prisma.InputJsonValue } });
  });
  res.json({ day: await dayPayload(u, t.plannedDate!) });
});
