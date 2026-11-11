import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import type { Prisma, Task, User } from '@prisma/client';
import { prisma } from '../../db.js';
import { parse } from '../../middleware/validate.js';
import { currentUser } from '../../middleware/auth.js';
import { badRequest, notFound } from '../../utils/errors.js';
import { emitToUser } from '../../realtime/socket.js';
import { understandClause, understandDay, type Commitment, type FreeWindow } from '../../day/understand.js';
import { applyFeedback, sameTask } from '../../day/feedback.js';
import { understandDayWithAi } from '../ai/ai.client.js';
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

interface Settings {
  dayStart: string;
  dayEnd: string;
  peak: Peak;
  /** Fixed commitments named in words, e.g. "work 9 to 6:30". */
  commitments?: Commitment[];
  /** Free gaps inside commitments, e.g. "11:30-1 in between work". */
  windows?: FreeWindow[];
  breaks?: 'SHORT' | 'NORMAL' | 'LONG';
  maxSession?: number;
}
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
/** Commitments minus the free windows inside them, as local minutes. */
function commitmentBusy(settings: Settings): Busy[] {
  let out: Busy[] = (settings.commitments ?? []).map((c) => ({ title: c.title, start: toMin(c.start), end: c.end === '24:00' ? 1440 : toMin(c.end), kind: 'BUSY' as const }));
  for (const w of settings.windows ?? []) {
    const ws = toMin(w.start);
    const we = w.end === '24:00' ? 1440 : toMin(w.end);
    out = out.flatMap((b) => (we <= b.start || ws >= b.end ? [b] : [
      ...(ws > b.start ? [{ ...b, end: ws }] : []),
      ...(we < b.end ? [{ ...b, start: we }] : []),
    ]));
  }
  return out.filter((b) => b.end > b.start);
}

async function busyFor(u: User, date: string, settings?: Settings): Promise<Busy[]> {
  const start = dayOf(u, date);
  const end = start.plus({ days: 1 });
  const toLocal = (d: Date) => Math.max(0, Math.min(1440, Math.round(DateTime.fromJSDate(d).setZone(u.timezone).diff(start, 'minutes').minutes)));
  const [events, blocks] = await Promise.all([
    prisma.calendarEvent.findMany({ where: { userId: u.id, startAt: { lt: end.toJSDate() }, endAt: { gt: start.toJSDate() } } }),
    prisma.scheduledBlock.findMany({ where: { userId: u.id, status: 'CONFIRMED', startAt: { lt: end.toJSDate() }, endAt: { gt: start.toJSDate() } }, include: { task: { select: { title: true } } } }),
  ]);
  const busy: Busy[] = [
    ...events.map((e) => ({ title: e.title, start: toLocal(e.startAt), end: toLocal(e.endAt), kind: (e.eventType === 'BREAK' ? 'BREAK' : 'BUSY') as Busy['kind'] })),
    ...blocks.map((b) => ({ title: b.task.title, start: toLocal(b.startAt), end: toLocal(b.endAt), kind: 'BUSY' as const })),
    ...(settings ? commitmentBusy(settings) : []),
  ].filter((b) => b.end > b.start);
  const named = settings?.commitments ?? [];
  const insideCommitment = (s: number, e: number) => named.some((c) => s < (c.end === '24:00' ? 1440 : toMin(c.end)) && e > toMin(c.start));
  // No meals on the calendar? Use the saved meal times (or sensible defaults).
  if (!busy.some((b) => b.kind === 'BREAK')) {
    const meals = ((u.lifeProfile ?? {}) as LifeProfileLite).meals;
    const lunch = meals?.lunch === undefined ? '13:00' : meals.lunch;
    const dinner = meals?.dinner === undefined ? '20:00' : meals.dinner;
    // A meal inside work hours happens at work: it isn't a separate block.
    if (lunch && !insideCommitment(toMin(lunch), toMin(lunch) + 45)) busy.push({ title: 'Lunch', start: toMin(lunch), end: toMin(lunch) + 45, kind: 'BREAK' });
    if (dinner && !insideCommitment(toMin(dinner), toMin(dinner) + 45)) busy.push({ title: 'Dinner', start: toMin(dinner), end: toMin(dinner) + 45, kind: 'BREAK' });
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
  notBefore: t.notBefore,
  dueBy: t.dueBy,
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
  notBefore: hm.nullable().optional(),
  dueBy: hm.nullable().optional(),
});
const settingsSchema = z.object({
  dayStart: hm,
  dayEnd: hm,
  peak: z.enum(['MORNING', 'AFTERNOON', 'EVENING']),
  commitments: z.array(z.object({ title: z.string().trim().min(1).max(80), start: hm, end: hm })).max(20).optional(),
  windows: z.array(z.object({ start: hm, end: hm, light: z.boolean().default(false) })).max(20).optional(),
  breaks: z.enum(['SHORT', 'NORMAL', 'LONG']).optional(),
  maxSession: z.number().int().min(20).max(240).optional(),
});
const planSchema = z.object({
  date: z.string().regex(DATE_RE).optional(),
  settings: settingsSchema,
  tasks: z.array(taskSchema).max(40),
  removeIds: z.array(z.string().uuid()).max(100).default([]),
  /** Existing tasks to move to the next day instead of planning them now. */
  deferIds: z.array(z.string().uuid()).max(100).default([]),
  dryRun: z.boolean().default(false),
});

/** `planMinutes` (internal): time to plan today when it differs from the task's estimate, e.g. what's left of a task in progress. */
type TaskIn = z.infer<typeof taskSchema> & { planMinutes?: number; planFixedTime?: string };

/** Plans the day and (unless dryRun) saves tasks, the timeline and what moves to tomorrow. */
async function planAndSave(u: User, date: string, settings: Settings, input: TaskIn[], removeIds: string[], dryRun: boolean, deferIds: string[] = []) {
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
  if (dayEnd - dayStart < 15) throw badRequest(date === today ? 'There’s almost no time left today. Plan tomorrow instead?' : 'The day needs to end after it starts');

  const open = input.filter((t) => !(t.id && doneIds.has(t.id)));
  const keys = open.map((t, i) => t.id ?? `new-${i}`);
  const result = planDay({
    dayStart,
    dayEnd,
    peak: settings.peak,
    windows: (settings.windows ?? []).map((w) => ({ start: toMin(w.start), end: w.end === '24:00' ? 1440 : toMin(w.end), light: w.light })),
    breakScale: settings.breaks === 'SHORT' ? 0.5 : settings.breaks === 'LONG' ? 2 : 1,
    maxSession: settings.maxSession,
    busy: [
      ...(await busyFor(u, date, settings)),
      ...keptItems.map((i) => ({ title: i.title, start: i.start, end: i.end, kind: 'BUSY' as const })),
    ],
    tasks: open.map((t, i): DayTaskInput => ({
      id: keys[i],
      title: t.title,
      minutes: t.planMinutes ?? t.minutes,
      mustDo: t.mustDo,
      top: t.top,
      effort: t.effort,
      fixedTime: t.planFixedTime ?? t.fixedTime ?? null,
      notBefore: t.planFixedTime ? null : t.notBefore ?? null,
      dueBy: t.planFixedTime ? null : t.dueBy ?? null,
      fromEarlier: !!(t.id && byId.get(t.id)?.plannedDate && byId.get(t.id)!.plannedDate! < date),
    })),
  });
  // Tasks already under way keep going now; say so instead of "like you asked".
  const continuing = new Set(open.filter((t) => t.planFixedTime).map((t) => t.id));
  for (const i of result.items) if (i.taskId && continuing.has(i.taskId)) i.reason = '▶ In progress, carrying on now';
  // Done tasks show again as done items; busy copies of them are dropped.
  const items = [...result.items.filter((i) => !(i.kind === 'BUSY' && keptItems.some((k) => k.start === i.start && k.title === i.title))), ...keptItems].sort((a, b) => a.start - b.start);

  if (dryRun) return { preview: { items, overflow: result.overflow, insights: result.insights, stats: result.stats } };

  const projectId = await myDayProject(u.id);
  // A task partly planned today stays on today; whatever isn't done rolls over as usual.
  const overflowKeys = new Set(result.overflow.filter((o) => !o.partial).map((o) => o.taskId));
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
        notBefore: t.notBefore ?? null,
        dueBy: t.dueBy ?? null,
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
    if (deferIds.length) await tx.task.updateMany({ where: { id: { in: deferIds }, assigneeId: u.id, status: { not: 'DONE' } }, data: { plannedDate: tomorrow, rolloverCount: { increment: 1 } } });
    if (removeIds.length) await tx.task.deleteMany({ where: { id: { in: removeIds }, assigneeId: u.id, plannedDate: { not: null }, status: { not: 'DONE' } } });
    const saved = items.map((i) => ({ ...i, taskId: i.taskId ? realId.get(i.taskId) ?? i.taskId : null }));
    const data = { settings: settings as unknown as Prisma.InputJsonValue, items: saved as unknown as Prisma.InputJsonValue, insights: result.insights as unknown as Prisma.InputJsonValue };
    await tx.dayPlan.upsert({ where: { userId_date: { userId: u.id, date } }, create: { userId: u.id, date, ...data }, update: data });
  });
  emitToUser(u.id, 'task:updated', { reason: 'day-plan' });
  // How many task sessions changed time compared with the previous plan.
  const before = new Map(((previous?.items ?? []) as unknown as PlanItem[]).filter((i) => i.kind === 'TASK').map((i) => [`${i.taskId}:${i.part ?? 0}`, `${i.start}-${i.end}`]));
  const day = await dayPayload(u, date);
  const changed = (day.plan?.items ?? []).filter((i) => i.kind === 'TASK' && i.taskId && !doneIds.has(i.taskId) && before.get(`${i.taskId}:${i.part ?? 0}`) !== `${i.start}-${i.end}`).length;
  return { day, moved: result.overflow.map((o) => (o.partial ? `the last ${o.minutes} min of ${o.title}` : o.title)), changed };
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

/**
 * POST /day/understand — "Tell me about your day": reads the description
 * (Claude when enabled and allowed, otherwise the built-in parser), adds
 * leftovers from earlier days, and returns the tasks, settings and a preview.
 */
dayRouter.post('/understand', async (req, res) => {
  const u = await loadUser(req);
  const body = parse(z.object({ text: z.string().trim().min(1, 'Tell me what you need to do').max(5000), date: z.string().regex(DATE_RE).optional() }), req.body);
  let source: 'ai' | 'rules' = 'rules';
  let understood = understandDay(body.text);
  const notes: string[] = [];
  try {
    const ai = await understandDayWithAi(body.text, new Date(), u.aiExternalConsent);
    if (ai) {
      source = 'ai';
      understood = {
        date: ai.date,
        settings: { dayStart: ai.day_start ?? undefined, dayEnd: ai.day_end ?? undefined, peak: ai.peak ?? undefined },
        // Claude reads tasks; commitments and free gaps come from the built-in reader.
        commitments: understood.commitments,
        windows: understood.windows,
        tasks: ai.tasks.map((t) => ({ title: t.title, minutes: t.minutes, minutesGuessed: t.minutes_guessed, mustDo: t.must_do, top: t.top, effort: t.effort, fixedTime: t.fixed_time ?? null, notBefore: t.not_before ?? null, dueBy: t.due_by ?? null })),
        notes: ai.notes,
      };
    }
  } catch {
    if (u.aiExternalConsent) notes.push('Claude wasn’t reachable, so I used the built-in planner to read your day.');
  }
  if (!understood.tasks.length) throw badRequest('I couldn’t find any tasks in that. Try listing what you need to do, like “study 2h, gym, call mom at 7pm”.');

  const today = localNow(u).toISODate()!;
  const date = body.date ?? (understood.date === 'tomorrow' ? nextDate(u, today) : today);
  const defaults = defaultSettings(u, date);
  const settings: Settings = {
    dayStart: understood.settings.dayStart && (date !== today || understood.settings.dayStart > defaults.dayStart) ? understood.settings.dayStart : defaults.dayStart,
    dayEnd: understood.settings.dayEnd ?? defaults.dayEnd,
    peak: understood.settings.peak ?? defaults.peak,
    ...(understood.commitments.length ? { commitments: understood.commitments } : {}),
    ...(understood.windows.length ? { windows: understood.windows } : {}),
  };
  // Free time named earlier than the usual start (e.g. before work) widens the day.
  for (const w of understood.windows) if (toMin(w.start) < toMin(settings.dayStart) && (date !== today || toMin(w.start) >= toMin(defaults.dayStart))) settings.dayStart = w.start;
  if (toMin(settings.dayEnd) <= toMin(settings.dayStart) + 15) settings.dayEnd = defaults.dayEnd;

  // Keep what's already planned for that day and anything left over, unless it was mentioned again.
  const [existing, leftovers] = await Promise.all([
    prisma.task.findMany({ where: { assigneeId: u.id, plannedDate: date, status: { not: 'DONE' } }, orderBy: { createdAt: 'asc' } }),
    date === today ? prisma.task.findMany({ where: { assigneeId: u.id, plannedDate: { lt: date }, status: { in: ['TODO', 'IN_PROGRESS'] } }, take: 20 }) : Promise.resolve([] as Task[]),
  ]);
  const said = [...understood.tasks];
  const tasks: (TaskIn & { minutesGuessed?: boolean; fromEarlier?: boolean })[] = [];
  for (const t of [...existing, ...leftovers]) {
    // "2 leetcode problems" today is the same as yesterday's "Leetcode".
    const i = said.findIndex((x) => sameTask(x.title, t.title));
    const again = i >= 0 ? said.splice(i, 1)[0] : null;
    const src = again && { ...again, minutes: again.minutesGuessed ? t.estimatedMinutes : again.minutes };
    tasks.push({
      id: t.id, title: t.title, minutes: src?.minutes ?? t.estimatedMinutes, mustDo: src?.mustDo ?? (t.mustDo || t.plannedDate! < date), top: src?.top ?? t.dayTop,
      effort: (src?.effort ?? t.effort ?? 'MEDIUM') as Effort, fixedTime: src?.fixedTime ?? t.fixedTime, notBefore: src?.notBefore ?? t.notBefore, dueBy: src?.dueBy ?? t.dueBy,
      fromEarlier: t.plannedDate! < date,
    });
  }
  for (const t of said) tasks.push({ ...t });
  if (tasks.filter((t) => t.top).length > 1) { let seen = false; for (const t of tasks) { if (t.top && seen) t.top = false; seen ||= t.top; } }
  const carried = tasks.filter((t) => t.fromEarlier).length;
  if (carried) notes.push(`I added ${carried} task${carried > 1 ? 's' : ''} left over from before.`);

  const { preview } = (await planAndSave(u, date, settings, tasks, [], true)) as { preview: unknown };
  res.json({ date, settings, tasks, notes: [...understood.notes, ...notes], source, aiAvailable: u.aiExternalConsent, preview });
});

/** POST /day/plan — plan (or preview with dryRun) the day from the answers. */
dayRouter.post('/plan', async (req, res) => {
  const u = await loadUser(req);
  const body = parse(planSchema, req.body);
  const date = resolveDate(u, body.date);
  res.json(await planAndSave(u, date, body.settings, body.tasks, body.removeIds, body.dryRun, body.deferIds));
});

/** POST /day/replan — re-plans the rest of the day from now, e.g. after "I need more time". */
/** Re-plans the open tasks of a day from now, keeping tasks in progress going. */
async function replanDay(u: User, date: string, extend?: { taskId: string; minutes: number }) {
  const plan = await prisma.dayPlan.findUnique({ where: { userId_date: { userId: u.id, date } } });
  const settings = (plan?.settings as unknown as Settings | undefined) ?? defaultSettings(u, date);
  const tasks = await prisma.task.findMany({ where: { assigneeId: u.id, plannedDate: date, status: { not: 'DONE' } }, orderBy: { createdAt: 'asc' } });
  const items = (plan?.items ?? []) as unknown as PlanItem[];
  const n = localNow(u);
  const nowMin = n.hour * 60 + n.minute;
  const input: TaskIn[] = tasks.map((t) => {
    let minutes = t.estimatedMinutes;
    let planMinutes: number | undefined;
    // A task already under way keeps only its remaining time (it isn't restarted from zero).
    const current = items.filter((i) => i.taskId === t.id);
    const running = isToday(u, date) ? current.find((i) => i.start <= nowMin && nowMin < i.end) : undefined;
    let planFixedTime: string | undefined;
    if (running) {
      // ...and carries on right now instead of being moved elsewhere.
      planMinutes = Math.max(5, current.filter((i) => i.end > nowMin).reduce((sum, i) => sum + i.end - Math.max(i.start, nowMin), 0));
      planFixedTime = fromMin(Math.ceil(nowMin / 5) * 5);
    }
    if (extend?.taskId === t.id) {
      minutes = Math.min(720, minutes + extend.minutes);
      planMinutes = Math.min(720, (planMinutes ?? t.estimatedMinutes) + extend.minutes);
    }
    return { id: t.id, title: t.title, minutes, planMinutes, planFixedTime, mustDo: t.mustDo, top: t.dayTop, effort: (t.effort ?? 'MEDIUM') as Effort, fixedTime: t.fixedTime, notBefore: t.notBefore, dueBy: t.dueBy };
  });
  return planAndSave(u, date, settings, input, [], false);
}

dayRouter.post('/replan', async (req, res) => {
  const u = await loadUser(req);
  const body = parse(z.object({ date: z.string().regex(DATE_RE).optional(), extend: z.object({ taskId: z.string().uuid(), minutes: z.number().int().min(5).max(240) }).optional() }), req.body ?? {});
  res.json(await replanDay(u, resolveDate(u, body.date), body.extend));
});

/** POST /day/tasks — add something that came up ("call bank at 4", "gym after work") and fit it into the plan. */
dayRouter.post('/tasks', async (req, res) => {
  const u = await loadUser(req);
  const body = parse(z.object({ date: z.string().regex(DATE_RE).optional(), text: z.string().trim().min(1).max(300), fit: z.boolean().default(true) }), req.body);
  const date = resolveDate(u, body.date);
  const t = understandClause(body.text) ?? (() => { const p = parseTaskLine(body.text); return p && { ...p, mustDo: false, top: false, notBefore: null, dueBy: null }; })();
  if (!t) throw badRequest('Type what you need to do');
  const projectId = await myDayProject(u.id);
  await prisma.task.create({ data: { projectId, assigneeId: u.id, title: t.title, estimatedMinutes: t.minutes, effort: t.effort, fixedTime: t.fixedTime, notBefore: t.notBefore, dueBy: t.dueBy, mustDo: t.mustDo, plannedDate: date } });
  const hasPlan = await prisma.dayPlan.count({ where: { userId: u.id, date } });
  if (body.fit && hasPlan && date >= localNow(u).toISODate()!) {
    const r = await replanDay(u, date);
    res.status(201).json({ ...r, parsed: t });
    return;
  }
  res.status(201).json({ day: await dayPayload(u, date), parsed: t });
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
  if (t.status === 'DONE') throw badRequest('That task is already done.');
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

const feedbackSchema = z.object({
  date: z.string().regex(DATE_RE).optional(),
  text: z.string().trim().min(1, 'Tell me what to change').max(2000),
  /** A plan still being reviewed (not saved yet). Without it, the saved plan is changed. */
  draft: z.object({ settings: settingsSchema, tasks: z.array(taskSchema.extend({ minutesGuessed: z.boolean().optional(), fromEarlier: z.boolean().optional() })).max(40) }).optional(),
});

const FEEDBACK_HELP = 'Try things like “move leetcode to 9pm”, “core takes 2 hours”, “I’m busy 3-4”, “more breaks”, “project first” or “remove gym”.';

/**
 * POST /day/feedback — "Tell me what to change": applies plain-language
 * feedback to a draft plan (returns a new preview) or to the saved plan
 * (re-plans and saves it), and says exactly what changed.
 */
dayRouter.post('/feedback', async (req, res) => {
  const u = await loadUser(req);
  const body = parse(feedbackSchema, req.body);
  const date = resolveDate(u, body.date);

  if (body.draft) {
    const r = applyFeedback(body.text, body.draft.settings, body.draft.tasks.map((t) => ({ ...t, fixedTime: t.fixedTime ?? null })));
    const tasks = r.tasks.map((t) => ({ ...t, notBefore: t.notBefore ?? null, dueBy: t.dueBy ?? null })) as (TaskIn & { minutesGuessed?: boolean; fromEarlier?: boolean })[];
    const preview = tasks.length ? ((await planAndSave(u, date, r.settings as Settings, tasks, [], true)) as { preview: unknown }).preview : null;
    res.json({
      settings: r.settings,
      tasks,
      removed: r.removed.map((x) => ({ id: x.task.id ?? null, title: x.task.title, tomorrow: x.tomorrow })),
      changes: r.changes,
      notUnderstood: r.notUnderstood,
      help: r.changes.length ? null : FEEDBACK_HELP,
      preview,
    });
    return;
  }

  // Change the saved plan.
  const plan = await prisma.dayPlan.findUnique({ where: { userId_date: { userId: u.id, date } } });
  const settings = (plan?.settings as unknown as Settings | undefined) ?? defaultSettings(u, date);
  const open = await prisma.task.findMany({ where: { assigneeId: u.id, plannedDate: date, status: { not: 'DONE' } }, orderBy: { createdAt: 'asc' } });
  const r = applyFeedback(body.text, settings, open.map((t) => ({
    id: t.id, title: t.title, minutes: t.estimatedMinutes, mustDo: t.mustDo, top: t.dayTop, effort: (t.effort ?? 'MEDIUM') as Effort,
    fixedTime: t.fixedTime, notBefore: t.notBefore, dueBy: t.dueBy,
  })));
  if (!r.changes.length) {
    res.json({ day: await dayPayload(u, date), changes: [], notUnderstood: r.notUnderstood, help: FEEDBACK_HELP, moved: [] });
    return;
  }
  const removeIds = r.removed.filter((x) => !x.tomorrow && x.task.id).map((x) => x.task.id!);
  const deferIds = r.removed.filter((x) => x.tomorrow && x.task.id).map((x) => x.task.id!);
  const saved = await planAndSave(u, date, r.settings as Settings, r.tasks.map((t) => ({ ...t, notBefore: t.notBefore ?? null, dueBy: t.dueBy ?? null })), removeIds, false, deferIds) as { day: unknown; moved: string[]; changed: number };
  res.json({ ...saved, changes: r.changes, notUnderstood: r.notUnderstood, help: null });
});
