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
import { planChatWithAi, understandDayWithAi } from '../ai/ai.client.js';
import { expandProgram, mealsFor, planExpandedDay, plannedOn, endDate, MAX_DAYS, type ProgramSpec } from '../../day/program.js';
import { chatPreview, chatTurn, emptySpec, fillDefaults, type ChatContext, type ChatDraft } from '../../day/planChat.js';
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
  const programs = await programsOn(u.id, date);
  // A later day of a multi-day plan, not started yet: show what it will look like.
  let projected: { items: PlanItem[]; insights: string[]; overflow: { title: string; minutes: number }[] } | null = null;
  if (!plan && programs.length && date > localNow(u).toISODate()!) {
    const day = combinedDay(programs, date);
    if (day && day.tasks.length) {
      const r = planExpandedDay(day, { busy: mealsFor(day.settings, mealsOf(u)) });
      projected = { items: r.items, insights: r.insights, overflow: r.overflow.map((o) => ({ title: o.title, minutes: o.minutes })) };
    }
  }
  return {
    programs: programs.map((p) => programInfo(p, date)),
    projected,
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
  const date = resolveDate(u, req.query.date);
  // Today's part of a multi-day plan becomes real tasks the first time today is opened.
  if (isToday(u, date)) await materialize(u, date);
  res.json(await dayPayload(u, date));
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

// ======================================================================
// Multi-day plans: the planner chat, finalising, and progress over time.
// ======================================================================
type Program = Awaited<ReturnType<typeof prisma.planProgram.findMany>>[number];

const mealsOf = (u: User) => {
  const meals = ((u.lifeProfile ?? {}) as LifeProfileLite).meals;
  const lunch = meals?.lunch === undefined ? '13:00' : meals.lunch;
  const dinner = meals?.dinner === undefined ? '20:00' : meals.dinner;
  return [
    ...(lunch ? [{ title: 'Lunch', start: lunch, minutes: 45 }] : []),
    ...(dinner ? [{ title: 'Dinner', start: dinner, minutes: 45 }] : []),
  ];
};

function programsOn(userId: string, date: string) {
  return prisma.planProgram.findMany({ where: { userId, status: 'ACTIVE', startDate: { lte: date }, endDate: { gte: date } }, orderBy: { createdAt: 'asc' } });
}

function programInfo(p: Program, date?: string) {
  const spec = p.spec as unknown as ProgramSpec;
  const totalDays = spec.days ?? 1;
  const dayNumber = date ? Math.round(DateTime.fromISO(date).diff(DateTime.fromISO(p.startDate), 'days').days) + 1 : null;
  return { id: p.id, title: p.title, startDate: p.startDate, endDate: p.endDate, totalDays, dayNumber, status: p.status, createdAt: p.createdAt.toISOString() };
}

/** What all active plans put on a date, combined into one day (the newest plan's settings win). */
function combinedDay(programs: Program[], date: string) {
  let out: ReturnType<typeof expandProgram>[number] | null = null;
  for (const p of programs) {
    const d = expandProgram(p.spec as unknown as ProgramSpec).find((x) => x.date === date);
    if (!d) continue;
    if (!out) { out = { ...d, tasks: [...d.tasks] }; continue; }
    const commitments: { title: string; start: string; end: string }[] = [...(out.settings.commitments ?? []), ...(d.settings.commitments ?? [])];
    out = { ...d, settings: { ...d.settings, ...(commitments.length ? { commitments } : {}) }, tasks: [...out.tasks, ...d.tasks.filter((t) => !out!.tasks.some((x) => sameTask(x.title, t.title)))] };
  }
  if (out) { let top = false; for (const t of out.tasks) { if (t.top && top) t.top = false; top ||= t.top; } }
  return out;
}

/**
 * Turns the plans' tasks for a date into real tasks and a saved day plan,
 * together with what's already on that day and anything left over from before.
 * Each plan does this once per date.
 */
async function materialize(u: User, date: string, programIds?: string[]): Promise<boolean> {
  const all = await programsOn(u.id, date);
  const fresh = all.filter((p) => !(p.days as Record<string, unknown>)[date] && (!programIds || programIds.includes(p.id)));
  if (!fresh.length) return false;
  // Claim the date first so two requests at once don't add the tasks twice.
  const claimed: Program[] = [];
  for (const p of fresh) {
    const r = await prisma.planProgram.updateMany({ where: { id: p.id, updatedAt: p.updatedAt }, data: { days: { ...(p.days as Record<string, unknown>), [date]: true } as Prisma.InputJsonValue } });
    if (r.count) claimed.push(p);
  }
  const day = combinedDay(claimed, date);
  if (!day || !day.tasks.length) return claimed.length > 0;

  const [existing, leftovers, plan] = await Promise.all([
    prisma.task.findMany({ where: { assigneeId: u.id, plannedDate: date, status: { not: 'DONE' } }, orderBy: { createdAt: 'asc' } }),
    prisma.task.findMany({ where: { assigneeId: u.id, plannedDate: { lt: date }, status: { in: ['TODO', 'IN_PROGRESS'] } }, take: 20 }),
    prisma.dayPlan.findUnique({ where: { userId_date: { userId: u.id, date } } }),
  ]);
  const input: TaskIn[] = [...existing, ...leftovers].map((t) => ({
    id: t.id, title: t.title, minutes: t.estimatedMinutes, mustDo: t.mustDo || t.plannedDate! < date, top: t.dayTop, effort: (t.effort ?? 'MEDIUM') as Effort,
    fixedTime: t.fixedTime, notBefore: t.notBefore, dueBy: t.dueBy,
  }));
  for (const t of day.tasks) {
    if (input.some((x) => sameTask(x.title, t.title))) continue;
    input.push({ title: t.title, minutes: t.minutes, mustDo: t.mustDo, top: t.top, effort: t.effort, fixedTime: t.fixedTime, notBefore: t.notBefore ?? null, dueBy: t.dueBy ?? null });
  }
  if (input.filter((t) => t.top).length > 1) { let seen = false; for (const t of input) { if (t.top && seen) t.top = false; seen ||= t.top; } }
  const prev = plan?.settings as unknown as Settings | undefined;
  const settings: Settings = { ...(day.settings as Settings), ...(prev?.commitments && !day.settings.commitments ? { commitments: prev.commitments } : {}) };
  try {
    await planAndSave(u, date, settings, input.slice(0, 40), [], false);
  } catch {
    // Too late in the day to plan: keep the tasks on the day anyway.
    const projectId = await myDayProject(u.id);
    for (const t of input.filter((x) => !x.id)) {
      await prisma.task.create({ data: { projectId, assigneeId: u.id, title: t.title, estimatedMinutes: t.minutes, effort: t.effort, fixedTime: t.fixedTime ?? null, notBefore: t.notBefore ?? null, dueBy: t.dueBy ?? null, mustDo: t.mustDo, dayTop: t.top, plannedDate: date } });
    }
  }
  return true;
}

function chatContext(u: User): ChatContext {
  const n = localNow(u);
  const today = n.toISODate()!;
  const routine = defaultSettings(u, nextDate(u, today));
  return { today, nowMin: n.hour * 60 + n.minute, defaults: { dayStart: routine.dayStart, dayEnd: routine.dayEnd, peak: routine.peak }, meals: mealsOf(u) };
}

const DATE = z.string().regex(DATE_RE);
const weekday = z.number().int().min(1).max(7);
const programTaskSchema = z.object({
  key: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(200),
  minutes: z.number().int().min(5).max(720),
  minutesGuessed: z.boolean().optional(),
  effort: z.enum(['EASY', 'MEDIUM', 'HARD']).default('MEDIUM'),
  top: z.boolean().default(false),
  mustDo: z.boolean().default(false),
  fixedTime: hm.nullable().default(null),
  notBefore: hm.nullable().default(null),
  dueBy: hm.nullable().default(null),
  repeat: z.enum(['ONCE', 'DAILY', 'WEEKDAYS', 'WEEKENDS', 'DAYS', 'WEEKLY']).nullable().default(null),
  days: z.array(weekday).max(7).optional(),
  timesPerWeek: z.number().int().min(1).max(7).optional(),
  date: DATE.nullable().optional(),
  until: DATE.nullable().optional(),
  totalMinutes: z.number().int().min(15).max(200_000).nullable().optional(),
});
export const programSpecSchema = z.object({
  title: z.string().trim().max(120).default(''),
  startDate: DATE.nullable(),
  days: z.number().int().min(1).max(MAX_DAYS).nullable(),
  sameEveryDay: z.boolean().nullable().default(null),
  dayStart: hm,
  dayEnd: hm,
  peak: z.enum(['MORNING', 'AFTERNOON', 'EVENING']),
  breaks: z.enum(['SHORT', 'NORMAL', 'LONG']).optional(),
  maxSession: z.number().int().min(20).max(240).optional(),
  commitments: z.array(z.object({ title: z.string().trim().min(1).max(80), start: hm, end: hm, days: z.array(weekday).min(1).max(7) })).max(20).default([]),
  windows: z.array(z.object({ start: hm, end: hm, light: z.boolean().default(false), days: z.array(weekday).min(1).max(7) })).max(20).default([]),
  restDays: z.array(weekday).max(6).default([]),
  tasks: z.array(programTaskSchema).max(40).default([]),
});
const questionSchema = z.object({ id: z.string().max(100), text: z.string().max(500), options: z.array(z.string().max(120)).max(8) });
const draftSchema = z.object({ spec: programSpecSchema, pending: questionSchema.nullable().default(null), asked: z.array(z.string().max(100)).max(200).default([]), ready: z.boolean().default(false) });

/**
 * POST /day/plan-chat — one turn of the planner chat. Send the message and the
 * draft from the last turn; get a reply, the next question (with quick
 * answers), suggestions, the updated draft and a preview of the schedule.
 * Uses Claude when enabled and allowed, otherwise the built-in chat.
 */
dayRouter.post('/plan-chat', async (req, res) => {
  const u = await loadUser(req);
  const body = parse(z.object({
    message: z.string().trim().min(1, 'Say something').max(4000),
    draft: draftSchema.nullable().optional(),
    history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(4000) })).max(40).default([]),
  }), req.body);
  const ctx = chatContext(u);
  const draftIn = (body.draft ?? null) as ChatDraft | null;
  let source: 'ai' | 'rules' = 'rules';
  let turn = null as ReturnType<typeof chatTurn> | null;
  let note: string | null = null;
  try {
    const ai = await planChatWithAi({ history: body.history.slice(-20), message: body.message, spec: draftIn?.spec ?? emptySpec(ctx), today: ctx.today, now: localNow(u).toISO()!, defaults: ctx.defaults }, u.aiExternalConsent);
    if (ai) {
      const spec = programSpecSchema.safeParse(ai.spec);
      if (spec.success) {
        const s = spec.data as ProgramSpec;
        if (ai.finalize) fillDefaults(s, ctx);
        const question = ai.question ? { id: 'ai', text: ai.question.text, options: ai.question.options } : ai.ready && !ai.finalize ? { id: 'confirm', text: 'Shall I finalise this into your schedule?', options: ['Finalise', 'Make changes'] } : null;
        const draft: ChatDraft = { spec: s, pending: question, asked: draftIn?.asked ?? [], ready: ai.ready || ai.finalize };
        turn = { reply: ai.reply, draft, question, suggestions: ai.suggestions, ready: draft.ready, finalize: ai.finalize && s.tasks.length > 0, changes: [] };
        source = 'ai';
      }
    }
  } catch {
    if (u.aiExternalConsent) note = 'Claude wasn’t reachable, so the built-in planner answered.';
  }
  turn ??= chatTurn(body.message, draftIn, ctx);
  res.json({ ...turn, source, note, preview: chatPreview(turn.draft.spec, ctx) });
});

/** POST /day/plan-chat/preview — another stretch of days of a draft plan (for paging through a long plan). */
dayRouter.post('/plan-chat/preview', async (req, res) => {
  const u = await loadUser(req);
  const body = parse(z.object({ spec: programSpecSchema, from: z.number().int().min(0).max(MAX_DAYS).default(0), count: z.number().int().min(1).max(31).default(14) }), req.body);
  res.json({ preview: chatPreview(body.spec as ProgramSpec, chatContext(u), body.from, body.count) });
});

/**
 * POST /day/plan-chat/finalize — saves the plan. Today's part (if the plan
 * starts today) becomes tasks right away; later days are added as they come.
 * An older plan that overlaps ends where the new one starts.
 */
dayRouter.post('/plan-chat/finalize', async (req, res) => {
  const u = await loadUser(req);
  const { spec: raw } = parse(z.object({ spec: programSpecSchema }), req.body);
  const spec = raw as ProgramSpec;
  const ctx = chatContext(u);
  if (!spec.tasks.length) throw badRequest('Tell me at least one thing to do first.');
  fillDefaults(spec, ctx);
  if (spec.startDate! < ctx.today) throw badRequest('That plan starts in the past. Start it today or later.');
  const end = endDate(spec)!;
  const overlapping = await prisma.planProgram.findMany({ where: { userId: u.id, status: 'ACTIVE', startDate: { lte: end }, endDate: { gte: spec.startDate! } } });
  const program = await prisma.$transaction(async (tx) => {
    for (const p of overlapping) {
      if (p.startDate >= spec.startDate!) await tx.planProgram.update({ where: { id: p.id }, data: { status: 'REPLACED' } });
      else await tx.planProgram.update({ where: { id: p.id }, data: { endDate: DateTime.fromISO(spec.startDate!).minus({ days: 1 }).toISODate()! } });
    }
    return tx.planProgram.create({ data: { userId: u.id, title: spec.title, startDate: spec.startDate!, endDate: end, spec: spec as unknown as Prisma.InputJsonValue } });
  });
  if (spec.startDate === ctx.today) await materialize(u, ctx.today, [program.id]);
  emitToUser(u.id, 'task:updated', { reason: 'plan-program' });
  res.status(201).json({ program: programInfo(program, spec.startDate!), replaced: overlapping.length, day: await dayPayload(u, spec.startDate!) });
});

/** GET /day/programs — your multi-day plans (active first). */
dayRouter.get('/programs', async (req, res) => {
  const u = await loadUser(req);
  const today = localNow(u).toISODate()!;
  const list = await prisma.planProgram.findMany({ where: { userId: u.id, status: 'ACTIVE', endDate: { gte: today } }, orderBy: { startDate: 'asc' }, take: 20 });
  res.json({ programs: list.map((p) => ({ ...programInfo(p, today), spec: p.spec })) });
});

/** DELETE /day/programs/:id — stop a plan (days already planned stay as they are). */
dayRouter.delete('/programs/:id', async (req, res) => {
  const u = await loadUser(req);
  const p = await prisma.planProgram.findFirst({ where: { id: req.params.id, userId: u.id } });
  if (!p) throw notFound('Plan');
  await prisma.planProgram.update({ where: { id: p.id }, data: { status: 'ENDED' } });
  res.json({ ok: true });
});

/**
 * GET /day/progress?from=YYYY-MM-DD&to=YYYY-MM-DD — per-day progress for a
 * week, month or any range: planned vs done, minutes, and (for days ahead)
 * what the plans will put there. Also totals and the current streak.
 */
dayRouter.get('/progress', async (req, res) => {
  const u = await loadUser(req);
  const q = parse(z.object({ from: DATE, to: DATE }), req.query);
  if (q.to < q.from) throw badRequest('“to” must be on or after “from”');
  if (DateTime.fromISO(q.to).diff(DateTime.fromISO(q.from), 'days').days > 400) throw badRequest('Ask for at most about a year at a time');
  const today = localNow(u).toISODate()!;
  const streakFrom = DateTime.fromISO(today).minus({ days: 120 }).toISODate()!;
  const lo = q.from < streakFrom ? q.from : streakFrom;
  const [tasks, programs] = await Promise.all([
    prisma.task.findMany({ where: { assigneeId: u.id, plannedDate: { gte: lo, lte: q.to > today ? q.to : today } }, select: { plannedDate: true, status: true, estimatedMinutes: true } }),
    prisma.planProgram.findMany({ where: { userId: u.id, status: { in: ['ACTIVE', 'ENDED'] }, startDate: { lte: q.to }, endDate: { gte: q.from } } }),
  ]);
  const byDate = new Map<string, { planned: number; done: number; minutes: number; minutesDone: number }>();
  for (const t of tasks) {
    const d = byDate.get(t.plannedDate!) ?? { planned: 0, done: 0, minutes: 0, minutesDone: 0 };
    d.planned += 1;
    d.minutes += t.estimatedMinutes;
    if (t.status === 'DONE') { d.done += 1; d.minutesDone += t.estimatedMinutes; }
    byDate.set(t.plannedDate!, d);
  }
  const days: { date: string; planned: number; done: number; minutes: number; minutesDone: number; projected: boolean; missed: boolean; inPlan: boolean }[] = [];
  for (let d = q.from; d <= q.to; d = DateTime.fromISO(d).plus({ days: 1 }).toISODate()!) {
    const actual = byDate.get(d);
    let fromPlan = null as { count: number; minutes: number } | null;
    for (const p of programs) {
      if (d < p.startDate || d > p.endDate) continue;
      const x = plannedOn(p.spec as unknown as ProgramSpec, d);
      if (x) fromPlan = { count: (fromPlan?.count ?? 0) + x.count, minutes: (fromPlan?.minutes ?? 0) + x.minutes };
    }
    if (actual) days.push({ date: d, ...actual, projected: false, missed: false, inPlan: !!fromPlan });
    else if (fromPlan && fromPlan.count) days.push({ date: d, planned: fromPlan.count, done: 0, minutes: fromPlan.minutes, minutesDone: 0, projected: d >= today, missed: d < today, inPlan: true });
    else days.push({ date: d, planned: 0, done: 0, minutes: 0, minutesDone: 0, projected: false, missed: false, inPlan: !!fromPlan });
  }
  const past = days.filter((x) => x.date <= today && !x.projected);
  const totals = {
    planned: past.reduce((s, x) => s + x.planned, 0),
    done: past.reduce((s, x) => s + x.done, 0),
    minutes: past.reduce((s, x) => s + x.minutes, 0),
    minutesDone: past.reduce((s, x) => s + x.minutesDone, 0),
    activeDays: past.filter((x) => x.done > 0).length,
  };
  // Streak: days in a row (up to today) with at least one task done; today doesn't break it yet.
  let streak = 0;
  for (let d = today, first = true; d >= streakFrom; d = DateTime.fromISO(d).minus({ days: 1 }).toISODate()!, first = false) {
    const x = byDate.get(d);
    if (x && x.done > 0) streak += 1;
    else if (!first) break;
  }
  res.json({ from: q.from, to: q.to, today, days, totals: { ...totals, rate: totals.planned ? Math.round((totals.done / totals.planned) * 100) : 0 }, streak, programs: programs.filter((p) => p.status === 'ACTIVE').map((p) => programInfo(p, today)) });
});
