/**
 * The scheduling assistant.
 *
 *  1. Learns about the person: asks for routine facts it doesn't know, reads
 *     facts from chat, and learns timing style from their history (learn.ts).
 *  2. Syncs Google Calendar through the Calendar/Meet MCP server: meetings
 *     become busy time in their plan; invites they haven't answered become
 *     questions ("Will you attend?").
 *  3. Reads recent email through the Gmail MCP server and finds meeting
 *     requests (local model, or the built-in rules) and asks which time works,
 *     offering times that fit their routine.
 *  4. Turns answers into actions (RSVP, book a meeting with a Meet link,
 *     send a reply). Nothing is sent until the person approves the action.
 *  5. Plans the day around all of it with the My Day planner.
 */
import type { AssistantAction, AssistantQuestion, Prisma, User } from '@prisma/client';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { emitToUser } from '../realtime/socket.js';
import { badRequest, conflict, notFound, serviceUnavailable } from '../utils/errors.js';
import { parse } from '../middleware/validate.js';
import { googleConfigured } from '../integrations/google/account.js';
import type { GEvent } from '../integrations/google/types.js';
import { GoogleToolError, withGoogleTools, type GoogleTools } from '../mcp/client.js';
import {
  aiStatus,
  assistantChatWithAi,
  draftReplyWithAi,
  meetingRequestsWithAi,
  modelAllowed,
  type AssistantChatResult,
} from '../modules/ai/ai.client.js';
import { addTasksFromText, dayPayload, planDayForAssistant } from '../modules/day/day.routes.js';
import { readMeetingRequest, type MeetingRequest } from './emailRules.js';
import { learn } from './learn.js';
import { readMessage, type Intent } from './messageRules.js';
import {
  applyPatch,
  describeProfile,
  label12,
  missingProfileQuestions,
  profilePatchSchema,
  readMemory,
  readProfile,
  type MeetingDecision,
  type Profile,
  type ProfilePatch,
} from './profile.js';
import { checkTime, slotLabel, suggestSlots, type BusyTime } from './slots.js';

const SYNC_DAYS = 7;
const INBOX_QUERY = 'in:inbox newer_than:3d -category:promotions -category:social';
const MAX_EMAILS = 8;

export interface QuestionOption {
  id: string;
  label: string;
  hint?: string;
  recommended?: boolean;
}

const localNow = (u: User) => DateTime.now().setZone(u.timezone);
const firstName = (name: string | null | undefined) => (name ?? '').trim().split(/\s+/)[0] || 'there';
const local = (u: User, iso: string) => DateTime.fromISO(iso).setZone(u.timezone);
const timeRange = (u: User, start: string, end: string) => `${slotLabel(local(u, start))}–${local(u, end).toFormat(local(u, end).minute ? 'h:mm a' : 'h a')}`;

async function getUser(id: string): Promise<User> {
  const u = await prisma.user.findUnique({ where: { id } });
  if (!u) throw notFound('User');
  return u;
}

async function saveMemory(userId: string, memory: unknown) {
  await prisma.user.update({ where: { id: userId }, data: { assistantMemory: memory as Prisma.InputJsonValue } });
}

// ---------- learning ----------

/** Re-learns the person's timing style from the last six weeks of activity. */
export async function relearn(u: User): Promise<Profile> {
  const since = localNow(u).minus({ weeks: 6 });
  const today = localNow(u).toISODate()!;
  const [done, planned] = await Promise.all([
    prisma.task.findMany({ where: { assigneeId: u.id, status: 'DONE', completedAt: { gte: since.toJSDate() } }, select: { completedAt: true, estimatedMinutes: true, actualMinutes: true }, take: 500 }),
    prisma.task.findMany({ where: { assigneeId: u.id, plannedDate: { gte: since.toISODate()!, lt: today } }, select: { status: true, plannedDate: true, completedAt: true, rolloverCount: true }, take: 500 }),
  ]);
  const mem = readMemory(u.assistantMemory);
  const learned = learn(
    {
      completionMinutes: done.map((t) => {
        const d = DateTime.fromJSDate(t.completedAt!).setZone(u.timezone);
        return d.hour * 60 + d.minute;
      }),
      estimates: done.filter((t) => t.actualMinutes > 0).map((t) => ({ estimated: t.estimatedMinutes, actual: t.actualMinutes })),
      plannedOutcomes: planned.map((t) => t.status === 'DONE' && t.rolloverCount === 0),
      decisions: mem.decisions,
    },
    new Date(),
  );
  const memory = { ...mem, learned };
  await saveMemory(u.id, memory);
  u.assistantMemory = memory as unknown as Prisma.JsonValue;
  return readProfile(u);
}

function recordDecision(u: User, d: Omit<MeetingDecision, 'at'>) {
  const mem = readMemory(u.assistantMemory);
  const memory = { ...mem, decisions: [{ ...d, at: new Date().toISOString() }, ...mem.decisions].slice(0, 200) };
  u.assistantMemory = memory as unknown as Prisma.JsonValue;
  return saveMemory(u.id, memory);
}

// ---------- questions ----------

async function ask(u: User, q: { kind: string; dedupeKey: string; text: string; detail?: string; options: QuestionOption[]; context: Record<string, unknown> }): Promise<boolean> {
  const existing = await prisma.assistantQuestion.findUnique({ where: { userId_dedupeKey: { userId: u.id, dedupeKey: q.dedupeKey } } });
  if (existing) {
    // Still open: refresh the options (free/busy may have changed).
    if (existing.status === 'OPEN') {
      await prisma.assistantQuestion.update({ where: { id: existing.id }, data: { text: q.text, detail: q.detail ?? null, options: q.options as unknown as Prisma.InputJsonValue, context: q.context as Prisma.InputJsonValue } });
    }
    return false;
  }
  await prisma.assistantQuestion.create({
    data: { userId: u.id, kind: q.kind, dedupeKey: q.dedupeKey, text: q.text, detail: q.detail ?? null, options: q.options as unknown as Prisma.InputJsonValue, context: q.context as Prisma.InputJsonValue },
  });
  return true;
}

async function askProfileQuestions(u: User, p: Profile): Promise<number> {
  let n = 0;
  for (const q of missingProfileQuestions(p)) {
    const created = await ask(u, {
      kind: 'PROFILE',
      dedupeKey: q.key,
      text: q.text,
      detail: q.detail,
      options: q.options.map((o) => ({ id: o.id, label: o.label })),
      context: { patches: Object.fromEntries(q.options.map((o) => [o.id, o.patch])) },
    });
    if (created) n++;
  }
  // Facts learned another way (e.g. from chat) close the matching questions.
  const missing = new Set(missingProfileQuestions(p).map((q) => q.key));
  await prisma.assistantQuestion.updateMany({ where: { userId: u.id, kind: 'PROFILE', status: 'OPEN', dedupeKey: { notIn: [...missing] } }, data: { status: 'DISMISSED' } });
  return n;
}

// ---------- calendar & inbox sync ----------

/** Busy times for suggestions: Google events (not declined) plus the person's own calendar entries. */
async function busyTimes(u: User, events: GEvent[]): Promise<BusyTime[]> {
  const from = localNow(u).startOf('day');
  const own = await prisma.calendarEvent.findMany({
    where: { userId: u.id, source: { not: 'IMPORTED' }, eventType: { not: 'BREAK' }, endAt: { gt: from.toJSDate() }, startAt: { lt: from.plus({ days: SYNC_DAYS + 1 }).toJSDate() } },
  });
  return [
    ...events.filter((e) => e.myResponse !== 'declined' && !e.allDay).map((e) => ({ title: e.title, start: e.start, end: e.end })),
    ...own.map((e) => ({ title: e.title, start: e.startAt.toISOString(), end: e.endAt.toISOString() })),
  ];
}

/** Mirrors Google events the person is going to (accepted, tentative or their own) as busy time for planning. */
async function mirrorEvents(u: User, events: GEvent[], from: DateTime, to: DateTime): Promise<number> {
  const keep = events.filter((e) => !e.allDay && (e.myResponse === null || e.myResponse === 'accepted' || e.myResponse === 'tentative'));
  for (const e of keep) {
    const data = { title: e.title.slice(0, 200), startAt: new Date(e.start), endAt: new Date(e.end), eventType: 'FIXED' as const, source: 'IMPORTED' as const, meetUrl: e.meetUrl };
    await prisma.calendarEvent.upsert({ where: { userId_externalId: { userId: u.id, externalId: e.id } }, create: { userId: u.id, externalId: e.id, ...data }, update: data });
  }
  // Gone from Google, declined or not answered yet: no longer busy.
  await prisma.calendarEvent.deleteMany({
    where: { userId: u.id, source: 'IMPORTED', externalId: { notIn: keep.map((e) => e.id) }, startAt: { gte: from.toJSDate(), lt: to.toJSDate() } },
  });
  return keep.length;
}

async function askAboutInvites(u: User, p: Profile, events: GEvent[], busy: BusyTime[]): Promise<number> {
  const now = localNow(u);
  let n = 0;
  for (const e of events.filter((x) => x.myResponse === 'needsAction' && !x.allDay && Date.parse(x.start) > now.toMillis())) {
    const minutes = Math.round((Date.parse(e.end) - Date.parse(e.start)) / 60000);
    const others = busy.filter((b) => !(b.start === e.start && b.end === e.end && b.title === e.title));
    const check = checkTime(e.start, minutes, others, p, u.timezone, now);
    const startHour = local(u, e.start).hour;
    const disliked = p.learned?.avoidedMeetingHours.includes(startHour);
    const problem = check.conflict ? `Clashes with “${check.conflict}”` : check.outsideHours ? 'Outside your meeting hours' : disliked ? 'A time you usually turn down' : null;
    const alternatives = suggestSlots({ now, timezone: u.timezone, durationMinutes: minutes, busy: others, profile: p, max: 2 });
    const who = e.organizer.name ?? e.organizer.email;
    const options: QuestionOption[] = [
      { id: 'accept', label: 'Yes, I’ll attend', hint: problem ?? 'You’re free then', recommended: !problem },
      ...alternatives.map((s, i) => ({ id: `propose:${s.start}`, label: `Ask to move it to ${s.label}`, hint: s.reasons.slice(0, 2).join(', ') || undefined, recommended: !!problem && i === 0 })),
      { id: 'decline', label: 'No, decline' },
    ];
    const created = await ask(u, {
      kind: 'MEETING_INVITE',
      dedupeKey: `invite:${e.id}:${e.start}`,
      text: `${who} invited you to “${e.title}” — ${timeRange(u, e.start, e.end)}. Will you attend?`,
      detail: problem ?? (e.meetUrl ? 'Google Meet call.' : undefined),
      options,
      context: { eventId: e.id, title: e.title, start: e.start, end: e.end, minutes, organizerEmail: e.organizer.email, organizerName: e.organizer.name, meetUrl: e.meetUrl },
    });
    if (created) n++;
  }
  return n;
}

function fromAi(r: { title: string; duration_minutes: number; proposed_times: string[]; prefer_date?: string | null; prefer_part?: MeetingRequest['preferPart'] | null; summary: string }, timezone: string): MeetingRequest {
  return {
    isMeetingRequest: true,
    title: r.title,
    durationMinutes: r.duration_minutes,
    // The model returns local wall-clock times; anchor them in the user's timezone.
    proposedTimes: r.proposed_times
      .map((t) => DateTime.fromISO(t.slice(0, 19), { zone: timezone }))
      .filter((d) => d.isValid)
      .map((d) => d.toUTC().toISO()!),
    preferDate: r.prefer_date ?? null,
    preferPart: r.prefer_part ?? null,
    summary: r.summary,
  };
}

interface RequestContext {
  messageId: string;
  threadId: string;
  rfcMessageId: string | null;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  title: string;
  minutes: number;
  snippet: string;
  request: MeetingRequest;
}

/** The question for a meeting request: offered times (checked against the day) or suggested ones, plus decline. */
function requestQuestion(u: User, p: Profile, busy: BusyTime[], ctx: RequestContext) {
  const r = ctx.request;
  const now = localNow(u);
  const options: QuestionOption[] = [];
  let recommended = false;
  for (const t of r.proposedTimes) {
    if (Date.parse(t) < now.toMillis()) continue;
    const c = checkTime(t, r.durationMinutes, busy, p, u.timezone, now);
    const good = c.free && !c.outsideHours;
    options.push({ id: `time:${t}`, label: slotLabel(local(u, t)), hint: c.conflict ? `Clashes with “${c.conflict}”` : c.outsideHours ? 'Outside your meeting hours' : 'You’re free', recommended: good && !recommended });
    if (good) recommended = true;
  }
  if (!recommended) {
    const slots = suggestSlots({ now, timezone: u.timezone, durationMinutes: r.durationMinutes, busy, profile: p, preferDate: r.preferDate, preferPart: r.preferPart, max: 3 });
    slots.forEach((s, i) => options.push({ id: `time:${s.start}`, label: s.label, hint: s.reasons.slice(0, 2).join(', ') || 'Fits your day', recommended: i === 0 }));
  }
  options.push({ id: 'decline', label: 'Decline politely' });
  return {
    kind: 'MEETING_REQUEST',
    dedupeKey: `email:${ctx.messageId}`,
    text: `${ctx.fromName ?? ctx.fromEmail} wants to meet: “${r.title}” (${r.durationMinutes} min). Which time works?`,
    detail: r.summary || ctx.snippet.slice(0, 200),
    options,
    context: ctx as unknown as Record<string, unknown>,
  };
}

/** Re-checks the options of unanswered meeting requests (the calendar or routine may have changed). */
async function refreshOpenRequests(u: User, p: Profile, busy: BusyTime[]) {
  const open = await prisma.assistantQuestion.findMany({ where: { userId: u.id, kind: 'MEETING_REQUEST', status: 'OPEN' } });
  for (const q of open) {
    const ctx = q.context as unknown as RequestContext;
    if (ctx?.request) await ask(u, requestQuestion(u, p, busy, ctx));
  }
}

async function askAboutEmails(u: User, p: Profile, tools: GoogleTools, busy: BusyTime[], useModel: boolean, notes: string[]): Promise<number> {
  const list = await tools.searchMessages({ query: INBOX_QUERY, max: 15 });
  const seen = new Set(
    (await prisma.assistantQuestion.findMany({ where: { userId: u.id, dedupeKey: { in: list.map((m) => `email:${m.id}`) } }, select: { dedupeKey: true } })).map((q) => q.dedupeKey),
  );
  const checked = new Set<string>(readMemory(u.assistantMemory).checkedEmails);
  const fresh = list.filter((m) => !seen.has(`email:${m.id}`) && !checked.has(m.id) && m.from.email !== tools.email).slice(0, MAX_EMAILS);
  if (!fresh.length) return 0;
  const emails = await Promise.all(fresh.map((m) => tools.getMessage(m.id)));

  const found = new Map<string, MeetingRequest>();
  let aiUsed = false;
  if (useModel) {
    try {
      const ai = await meetingRequestsWithAi(
        { emails: emails.map((m) => ({ id: m.id, from_name: m.from.name, from_email: m.from.email, subject: m.subject, body: m.body, date: m.date })), timezone: u.timezone, now: localNow(u).toISO()! },
        u.aiExternalConsent,
      );
      if (ai) {
        aiUsed = true;
        for (const r of ai.results) if (r.is_meeting_request) found.set(r.id, fromAi(r, u.timezone));
      }
    } catch {
      notes.push('The AI model wasn’t reachable, so I used the built-in email reader.');
    }
  }
  if (!aiUsed) {
    for (const m of emails) {
      const r = readMeetingRequest(m, u.timezone);
      if (r.isMeetingRequest) found.set(m.id, r);
    }
  }

  let n = 0;
  for (const m of emails) {
    const r = found.get(m.id);
    if (!r) continue;
    const ctx: RequestContext = { messageId: m.id, threadId: m.threadId, rfcMessageId: m.messageId, fromEmail: m.from.email, fromName: m.from.name, subject: m.subject, title: r.title, minutes: r.durationMinutes, snippet: m.body.slice(0, 600), request: r };
    if (await ask(u, requestQuestion(u, p, busy, ctx))) n++;
  }
  // Remember which emails were already read so they aren't sent to the model again.
  const mem = readMemory(u.assistantMemory);
  const memory = { ...mem, checkedEmails: [...fresh.map((m) => m.id), ...checked].slice(0, 300) };
  u.assistantMemory = memory as unknown as Prisma.JsonValue;
  await saveMemory(u.id, memory);
  return n;
}

export interface SyncResult {
  meetings: number;
  newQuestions: number;
  notes: string[];
  google: 'google' | 'demo' | null;
}

/** Learns, syncs calendar + inbox through MCP, and asks what it needs to know. */
export async function syncAndAsk(userId: string): Promise<SyncResult> {
  const u = await getUser(userId);
  const p = await relearn(u);
  const notes: string[] = [];
  let newQuestions = await askProfileQuestions(u, p);
  let meetings = 0;
  let mode: SyncResult['google'] = null;
  const useModel = await modelAllowed(u);
  try {
    await withGoogleTools(u, async (tools) => {
      if (!tools) return;
      mode = tools.mode;
      const from = localNow(u).startOf('day');
      const to = from.plus({ days: SYNC_DAYS });
      const events = await tools.listEvents({ timeMin: from.toUTC().toISO()!, timeMax: to.toUTC().toISO()! });
      meetings = await mirrorEvents(u, events, from, to);
      const busy = await busyTimes(u, events);
      newQuestions += await askAboutInvites(u, p, events, busy);
      await refreshOpenRequests(u, p, busy);
      newQuestions += await askAboutEmails(u, p, tools, busy, useModel, notes);
      await prisma.googleAccount.update({ where: { userId: u.id }, data: { lastSyncAt: new Date() } });
    });
  } catch (e) {
    if (e instanceof GoogleToolError) notes.push(e.needsReconnect ? 'Google access expired. Please reconnect your Google account.' : `Couldn’t reach Google: ${e.message}`);
    else throw e;
  }
  if (newQuestions) emitToUser(u.id, 'assistant:updated', { reason: 'questions' });
  return { meetings, newQuestions, notes, google: mode };
}

// ---------- answers -> actions ----------

const replyDefaults = {
  CONFIRM: (to: string | null, me: string, time: string) => `Hi ${firstName(to)},\n\n${time} works for me. I’ve sent you a calendar invite with a Google Meet link.\n\nBest,\n${firstName(me)}`,
  DECLINE: (to: string | null, me: string) => `Hi ${firstName(to)},\n\nThanks for reaching out. Unfortunately I can’t make time for this right now.\n\nBest,\n${firstName(me)}`,
  PROPOSE: (to: string | null, me: string, title: string, alt: string) => `Hi ${firstName(to)},\n\nThe current time for “${title}” doesn’t work well for me. Would ${alt} work instead?\n\nThanks,\n${firstName(me)}`,
};

async function draftReply(u: User, kind: 'CONFIRM' | 'DECLINE' | 'PROPOSE', ctx: { toName: string | null; subject: string; original: string; time?: string; alt?: string; title?: string }): Promise<{ body: string; by: string }> {
  if (await modelAllowed(u)) {
    try {
      const text = await draftReplyWithAi(
        { kind, to_name: ctx.toName, my_name: u.name, subject: ctx.subject, original: ctx.original, time_label: ctx.time ?? null, alternatives: ctx.alt ? [ctx.alt] : [] },
        u.aiExternalConsent,
      );
      if (text) return { body: text, by: 'ai' };
    } catch {
      // fall through to the template
    }
  }
  const body = kind === 'CONFIRM' ? replyDefaults.CONFIRM(ctx.toName, u.name, ctx.time!) : kind === 'DECLINE' ? replyDefaults.DECLINE(ctx.toName, u.name) : replyDefaults.PROPOSE(ctx.toName, u.name, ctx.title ?? ctx.subject, ctx.alt!);
  return { body, by: 'template' };
}

const reSubject = (s: string) => (/^\s*re:/i.test(s) ? s : `Re: ${s}`);

async function createAction(u: User, q: AssistantQuestion, kind: string, summary: string, payload: Record<string, unknown>) {
  return prisma.assistantAction.create({ data: { userId: u.id, questionId: q.id, kind, summary, payload: payload as Prisma.InputJsonValue } });
}

export async function answerQuestion(userId: string, questionId: string, optionId: string) {
  const u = await getUser(userId);
  const q = await prisma.assistantQuestion.findFirst({ where: { id: questionId, userId } });
  if (!q) throw notFound('Question');
  if (q.status !== 'OPEN') throw conflict('ALREADY_ANSWERED', 'This question was already answered.');
  const options = q.options as unknown as QuestionOption[];
  if (!options.some((o) => o.id === optionId)) throw badRequest('Pick one of the options');
  const ctx = q.context as Record<string, unknown>;
  const actions: AssistantAction[] = [];
  let message = '';
  let resyncAfterProfile = false;

  if (q.kind === 'PROFILE') {
    const patch = profilePatchSchema.parse((ctx.patches as Record<string, ProfilePatch>)[optionId]);
    await saveMemory(u.id, applyPatch(u.assistantMemory, patch));
    message = 'Got it, I’ll plan around that.';
    resyncAfterProfile = true;
  } else if (q.kind === 'MEETING_INVITE') {
    const c = ctx as { eventId: string; title: string; start: string; end: string; minutes: number; organizerEmail: string; organizerName: string | null };
    const when = timeRange(u, c.start, c.end);
    const hour = local(u, c.start).hour;
    const weekday = local(u, c.start).weekday % 7;
    if (optionId === 'accept' || optionId === 'decline') {
      const response = optionId === 'accept' ? 'accepted' : 'declined';
      actions.push(await createAction(u, q, 'RSVP', `${optionId === 'accept' ? 'Accept' : 'Decline'} “${c.title}” (${when})`, { eventId: c.eventId, response, title: c.title, start: c.start, end: c.end }));
      await recordDecision(u, { hour, weekday, choice: optionId === 'accept' ? 'ACCEPT' : 'DECLINE', kind: 'INVITE' });
    } else {
      const slot = optionId.slice('propose:'.length);
      const alt = slotLabel(local(u, slot));
      const draft = await draftReply(u, 'PROPOSE', { toName: c.organizerName, subject: c.title, original: '', alt, title: c.title });
      actions.push(await createAction(u, q, 'RSVP', `Mark “${c.title}” as tentative`, { eventId: c.eventId, response: 'tentative', title: c.title, start: c.start, end: c.end }));
      actions.push(await createAction(u, q, 'SEND_EMAIL', `Ask ${c.organizerName ?? c.organizerEmail} to move “${c.title}” to ${alt}`, { to: c.organizerEmail, subject: `Can we move “${c.title}”?`, body: draft.body, draftedBy: draft.by }));
      await recordDecision(u, { hour: local(u, slot).hour, weekday: local(u, slot).weekday % 7, choice: 'RESCHEDULE', kind: 'INVITE' });
    }
    message = 'Ready for your approval below.';
  } else if (q.kind === 'MEETING_REQUEST') {
    const c = ctx as { threadId: string; rfcMessageId: string | null; fromEmail: string; fromName: string | null; subject: string; title: string; minutes: number; snippet: string };
    if (optionId === 'decline') {
      const draft = await draftReply(u, 'DECLINE', { toName: c.fromName, subject: c.subject, original: c.snippet });
      actions.push(await createAction(u, q, 'SEND_EMAIL', `Reply to ${c.fromName ?? c.fromEmail}: decline “${c.title}”`, { to: c.fromEmail, subject: reSubject(c.subject), body: draft.body, threadId: c.threadId, inReplyTo: c.rfcMessageId ?? undefined, draftedBy: draft.by }));
    } else {
      const start = optionId.slice('time:'.length);
      const end = DateTime.fromISO(start).plus({ minutes: c.minutes }).toUTC().toISO()!;
      const label = slotLabel(local(u, start));
      const draft = await draftReply(u, 'CONFIRM', { toName: c.fromName, subject: c.subject, original: c.snippet, time: label });
      actions.push(
        await createAction(u, q, 'SCHEDULE_MEETING', `Book “${c.title}” with ${c.fromName ?? c.fromEmail} on ${label} (Google Meet) and reply`, {
          title: c.title,
          start,
          end,
          timeZone: u.timezone,
          attendees: [c.fromEmail],
          reply: { to: c.fromEmail, subject: reSubject(c.subject), body: draft.body, threadId: c.threadId, inReplyTo: c.rfcMessageId ?? undefined },
          draftedBy: draft.by,
        }),
      );
      await recordDecision(u, { hour: local(u, start).hour, weekday: local(u, start).weekday % 7, choice: 'ACCEPT', kind: 'REQUEST' });
    }
    message = 'Ready for your approval below.';
  }

  await prisma.assistantQuestion.update({ where: { id: q.id }, data: { status: 'ANSWERED', answer: { optionId } as Prisma.InputJsonValue, answeredAt: new Date() } });
  // Routine complete: meeting suggestions made before are re-checked against it.
  if (resyncAfterProfile && !(await prisma.assistantQuestion.count({ where: { userId, kind: 'PROFILE', status: 'OPEN' } }))) {
    await syncAndAsk(userId).catch(() => undefined);
  }
  emitToUser(u.id, 'assistant:updated', { reason: 'answer' });
  return { message, actions: actions.map(serializeAction) };
}

export async function dismissQuestion(userId: string, questionId: string) {
  const r = await prisma.assistantQuestion.updateMany({ where: { id: questionId, userId, status: 'OPEN' }, data: { status: 'DISMISSED', answeredAt: new Date() } });
  if (!r.count) throw notFound('Question');
}

// ---------- approving actions ----------

const emailEdit = z.object({ body: z.string().trim().min(1).max(10000).optional(), subject: z.string().trim().min(1).max(300).optional() });

async function replanAffected(u: User, isoStart: string) {
  const date = local(u, isoStart).toISODate()!;
  if (date < localNow(u).toISODate()!) return;
  const has = await prisma.dayPlan.count({ where: { userId: u.id, date } });
  if (has) await planDayForAssistant(u, date, readProfile(u).learned?.estimateFactor ?? null).catch(() => undefined);
}

export async function approveAction(userId: string, actionId: string, edits: unknown) {
  const u = await getUser(userId);
  const edit = parse(emailEdit, edits ?? {});
  // Claim the action atomically so a double click can't send twice.
  const claimed = await prisma.assistantAction.updateMany({ where: { id: actionId, userId, status: 'PENDING' }, data: { status: 'RUNNING' } });
  if (!claimed.count) {
    const exists = await prisma.assistantAction.findFirst({ where: { id: actionId, userId } });
    if (!exists) throw notFound('Action');
    throw conflict('ALREADY_HANDLED', 'This action was already approved or rejected.');
  }
  const a = (await prisma.assistantAction.findUnique({ where: { id: actionId } }))!;
  const p = a.payload as Record<string, unknown>;
  try {
    const result = await withGoogleTools(u, async (tools) => {
      if (!tools) throw new GoogleToolError('Connect Google first.');
      if (a.kind === 'RSVP') {
        const e = await tools.respondToInvite({ eventId: String(p.eventId), response: p.response as 'accepted' | 'declined' | 'tentative' });
        if (e.myResponse === 'declined') await prisma.calendarEvent.deleteMany({ where: { userId: u.id, externalId: e.id } });
        else {
          const data = { title: e.title.slice(0, 200), startAt: new Date(e.start), endAt: new Date(e.end), eventType: 'FIXED' as const, source: 'IMPORTED' as const, meetUrl: e.meetUrl };
          await prisma.calendarEvent.upsert({ where: { userId_externalId: { userId: u.id, externalId: e.id } }, create: { userId: u.id, externalId: e.id, ...data }, update: data });
        }
        await replanAffected(u, e.start);
        return { eventId: e.id, response: e.myResponse };
      }
      if (a.kind === 'SEND_EMAIL') {
        const sent = await tools.sendEmail({ to: String(p.to), subject: edit.subject ?? String(p.subject), body: edit.body ?? String(p.body), threadId: p.threadId as string | undefined, inReplyTo: p.inReplyTo as string | undefined });
        return { emailId: sent.id };
      }
      if (a.kind === 'SCHEDULE_MEETING') {
        const e = await tools.createMeeting({ title: String(p.title), start: String(p.start), end: String(p.end), timeZone: String(p.timeZone), attendees: p.attendees as string[], withMeet: true, description: 'Scheduled with Smart Scheduling.' });
        await prisma.calendarEvent.upsert({
          where: { userId_externalId: { userId: u.id, externalId: e.id } },
          create: { userId: u.id, externalId: e.id, title: e.title.slice(0, 200), startAt: new Date(e.start), endAt: new Date(e.end), source: 'IMPORTED', meetUrl: e.meetUrl },
          update: { title: e.title.slice(0, 200), startAt: new Date(e.start), endAt: new Date(e.end), meetUrl: e.meetUrl },
        });
        const reply = p.reply as { to: string; subject: string; body: string; threadId?: string; inReplyTo?: string };
        let body = edit.body ?? reply.body;
        if (e.meetUrl && !body.includes(e.meetUrl)) body += `\n\nGoogle Meet: ${e.meetUrl}`;
        const sent = await tools.sendEmail({ ...reply, subject: edit.subject ?? reply.subject, body });
        await replanAffected(u, e.start);
        return { eventId: e.id, meetUrl: e.meetUrl, emailId: sent.id };
      }
      throw new Error(`Unknown action ${a.kind}`);
    });
    const done = await prisma.assistantAction.update({ where: { id: a.id }, data: { status: 'DONE', result: result as Prisma.InputJsonValue, executedAt: new Date(), ...(edit.body ? { payload: { ...p, edited: true } as Prisma.InputJsonValue } : {}) } });
    emitToUser(u.id, 'assistant:updated', { reason: 'action' });
    emitToUser(u.id, 'task:updated', { reason: 'assistant' });
    return serializeAction(done);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Back to PENDING so the person can retry after reconnecting.
    await prisma.assistantAction.update({ where: { id: a.id }, data: { status: 'PENDING', error: msg.slice(0, 500) } });
    throw serviceUnavailable('GOOGLE_ACTION_FAILED', `Couldn’t complete this on Google: ${msg}`);
  }
}

export async function rejectAction(userId: string, actionId: string) {
  const r = await prisma.assistantAction.updateMany({ where: { id: actionId, userId, status: 'PENDING' }, data: { status: 'REJECTED', executedAt: new Date() } });
  if (!r.count) throw notFound('Action');
}

// ---------- planning ----------

export async function planDay(userId: string, day: 'today' | 'tomorrow' = 'today') {
  const sync = await syncAndAsk(userId);
  const u = await getUser(userId);
  const p = readProfile(u);
  const date = localNow(u).plus({ days: day === 'tomorrow' ? 1 : 0 }).toISODate()!;
  if (day === 'today' && localNow(u).hour * 60 + localNow(u).minute > 23 * 60 + 30) throw badRequest('There’s almost no time left today. Plan tomorrow instead?');
  const result = await planDayForAssistant(u, date, p.learned?.estimateFactor ?? null);
  const items = result.day.plan?.items ?? [];
  const open = await prisma.assistantQuestion.count({ where: { userId, status: 'OPEN' } });
  const tasks = items.filter((i) => i.kind === 'TASK').length;
  const busy = items.filter((i) => i.kind === 'BUSY').length;
  const parts = [`I planned ${day} with ${tasks} task session${tasks === 1 ? '' : 's'} around ${busy} meeting${busy === 1 ? '' : 's'}/commitment${busy === 1 ? '' : 's'}.`];
  if (result.moved.length) parts.push(`${result.moved.length} thing${result.moved.length === 1 ? '' : 's'} didn’t fit and moved to the next day.`);
  if (open) parts.push(`${open} question${open === 1 ? '' : 's'} need${open === 1 ? 's' : ''} your answer; I’ll re-plan once you approve any changes.`);
  return { summary: parts.join(' '), sync, day: result.day, moved: result.moved };
}

// ---------- chat ----------

function patchFromAi(r: AssistantChatResult['profile']): ProfilePatch {
  const raw = {
    wakeTime: r.wake_time ?? undefined,
    sleepTime: r.sleep_time ?? undefined,
    workStart: r.work_start ?? undefined,
    workEnd: r.work_end ?? undefined,
    workDays: r.work_days ?? undefined,
    chronotype: r.chronotype ?? undefined,
    focusMinutes: r.focus_minutes ?? undefined,
    meetingsEarliest: r.meetings_earliest ?? undefined,
    meetingsLatest: r.meetings_latest ?? undefined,
    maxMeetingsPerDay: r.max_meetings_per_day ?? undefined,
    meetingBufferMinutes: r.meeting_buffer_minutes ?? undefined,
  };
  const parsed = profilePatchSchema.safeParse(Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)));
  const patch = parsed.success ? parsed.data : {};
  if (patch.workStart && patch.workEnd && patch.workEnd <= patch.workStart) {
    delete patch.workStart;
    delete patch.workEnd;
  }
  return patch;
}

function describePatch(patch: ProfilePatch): string[] {
  const out: string[] = [];
  if (patch.wakeTime) out.push(`you wake up at ${label12(patch.wakeTime)}`);
  if (patch.sleepTime) out.push(`you sleep at ${label12(patch.sleepTime)}`);
  if (patch.workStart && patch.workEnd) out.push(`you work ${label12(patch.workStart)}–${label12(patch.workEnd)}`);
  if (patch.chronotype) out.push(`you focus best in the ${patch.chronotype === 'EARLY_BIRD' ? 'morning' : patch.chronotype === 'NIGHT_OWL' ? 'evening' : 'afternoon'}`);
  if (patch.focusMinutes) out.push(`focus sessions of ${patch.focusMinutes} min`);
  if (patch.meetingsEarliest) out.push(`no meetings before ${label12(patch.meetingsEarliest)}`);
  if (patch.meetingsLatest) out.push(`no meetings after ${label12(patch.meetingsLatest)}`);
  if (patch.maxMeetingsPerDay) out.push(`at most ${patch.maxMeetingsPerDay} meetings a day`);
  if (patch.meetingBufferMinutes !== undefined) out.push(`${patch.meetingBufferMinutes} min between meetings`);
  return out;
}

async function agendaLines(u: User, day: 'today' | 'tomorrow'): Promise<string[]> {
  const from = localNow(u).startOf('day').plus({ days: day === 'tomorrow' ? 1 : 0 });
  const to = from.plus({ days: 1 });
  const events = await prisma.calendarEvent.findMany({ where: { userId: u.id, startAt: { lt: to.toJSDate() }, endAt: { gt: from.toJSDate() } }, orderBy: { startAt: 'asc' } });
  return events.map((e) => `${DateTime.fromJSDate(e.startAt).setZone(u.timezone).toFormat('h:mm a')}–${DateTime.fromJSDate(e.endAt).setZone(u.timezone).toFormat('h:mm a')} ${e.title}${e.meetUrl ? ' (Meet)' : ''}`);
}

const HELP =
  'I can plan your day around your meetings, check your inbox and calendar for meeting requests, and learn your routine. Try “plan my day”, “what’s on tomorrow?”, “check my inbox”, “I wake up at 7 and work 10 to 6”, or “add gym 1h”.';

export async function chat(userId: string, message: string) {
  const u = await getUser(userId);
  await prisma.assistantMessage.create({ data: { userId, role: 'user', text: message } });
  const rules = readMessage(message);
  let intent: Intent = rules.intent;
  let patch: ProfilePatch = rules.patch;
  let day = rules.day;
  let tasksText = rules.tasksText;
  let aiReply: string | null = null;
  let source: 'ai' | 'rules' = 'rules';
  let note: string | null = null;

  if (await modelAllowed(u)) {
    try {
      const history = (await prisma.assistantMessage.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 9 })).reverse().slice(0, -1);
      const ai = await assistantChatWithAi(
        {
          message,
          history: history.map((h) => ({ role: h.role as 'user' | 'assistant', text: h.text.slice(0, 1000) })),
          profile: describeProfile(readProfile(u)),
          agenda: [...(await agendaLines(u, 'today')).map((l) => `today ${l}`), ...(await agendaLines(u, 'tomorrow')).map((l) => `tomorrow ${l}`)],
          now: localNow(u).toISO()!,
        },
        u.aiExternalConsent,
      );
      if (ai) {
        source = 'ai';
        intent = ai.result.intent;
        // The rules catch explicit facts the model might miss; the model's facts win where both found one.
        patch = { ...rules.patch, ...patchFromAi(ai.result.profile) };
        if (Object.keys(patch).length && intent === 'HELP') intent = 'PROFILE';
        day = ai.result.day ?? rules.day;
        tasksText = ai.result.tasks_text ?? rules.tasksText;
        aiReply = ai.result.reply;
      }
    } catch {
      note = 'The AI model wasn’t reachable, so I answered with the built-in assistant.';
    }
  }

  let reply = '';
  let data: Record<string, unknown> = {};
  if (Object.keys(patch).length) {
    const memory = applyPatch(u.assistantMemory, patch, message.slice(0, 200));
    await saveMemory(u.id, memory);
    u.assistantMemory = memory as unknown as Prisma.JsonValue;
    await askProfileQuestions(u, readProfile(u));
  }
  switch (intent) {
    case 'PROFILE':
      reply = `Got it: ${describePatch(patch).join(', ') || 'noted'}. I’ll plan around that.`;
      break;
    case 'PLAN_DAY': {
      const r = await planDay(userId, day ?? 'today');
      reply = r.summary;
      data = { planned: r.day.date };
      break;
    }
    case 'CHECK_INBOX': {
      const r = await syncAndAsk(userId);
      reply = r.google
        ? r.newQuestions
          ? `I checked your calendar and inbox and have ${r.newQuestions} new question${r.newQuestions === 1 ? '' : 's'} for you above.`
          : 'I checked your calendar and inbox. Nothing new needs your answer.'
        : 'Connect your Google account (or try the sample inbox) and I’ll check your invites and emails for meeting requests.';
      if (r.notes.length) reply += ` ${r.notes.join(' ')}`;
      break;
    }
    case 'AGENDA': {
      const d = day ?? 'today';
      const lines = await agendaLines(u, d);
      reply = lines.length ? `Here’s ${d}:\n${lines.map((l) => `• ${l}`).join('\n')}` : `Nothing on your calendar ${d}.`;
      break;
    }
    case 'ADD_TASKS': {
      const date = localNow(u).toISODate()!;
      const added = tasksText ? await addTasksFromText(u, date, tasksText) : [];
      if (added.length) {
        const plan = await prisma.dayPlan.count({ where: { userId, date } });
        if (plan) await planDayForAssistant(u, date, readProfile(u).learned?.estimateFactor ?? null);
        reply = `Added ${added.map((t) => `“${t}”`).join(', ')} to today${plan ? ' and fitted it into your plan' : ''}.`;
      } else reply = 'Tell me what to add, like “add gym 1h, call mom at 6pm”.';
      break;
    }
    default:
      reply = aiReply ?? HELP;
  }
  // A model's friendly wording for profile updates, when it has one.
  if (intent === 'PROFILE' && aiReply) reply = aiReply;

  await prisma.assistantMessage.create({ data: { userId, role: 'assistant', text: reply } });
  return { reply, intent, source, note, ...data };
}

// ---------- state for the UI ----------

const serializeQuestion = (q: AssistantQuestion) => ({ id: q.id, kind: q.kind, text: q.text, detail: q.detail, options: q.options as unknown as QuestionOption[], createdAt: q.createdAt.toISOString() });
const serializeAction = (a: AssistantAction) => {
  const p = a.payload as Record<string, unknown>;
  const email = a.kind === 'SEND_EMAIL' ? { to: p.to, subject: p.subject, body: p.body } : a.kind === 'SCHEDULE_MEETING' ? (p.reply as Record<string, unknown>) : null;
  return {
    id: a.id,
    kind: a.kind,
    summary: a.summary,
    status: a.status,
    error: a.error,
    email: email ? { to: String(email.to), subject: String(email.subject), body: String(email.body), draftedBy: (p.draftedBy as string) ?? 'template' } : null,
    result: a.result,
    createdAt: a.createdAt.toISOString(),
    executedAt: a.executedAt?.toISOString() ?? null,
  };
};

export async function assistantState(userId: string) {
  const u = await getUser(userId);
  const [account, questions, pending, recent, messages, ai] = await Promise.all([
    prisma.googleAccount.findUnique({ where: { userId } }),
    prisma.assistantQuestion.findMany({ where: { userId, status: 'OPEN' }, orderBy: { createdAt: 'asc' }, take: 30 }),
    prisma.assistantAction.findMany({ where: { userId, status: { in: ['PENDING', 'RUNNING'] } }, orderBy: { createdAt: 'asc' } }),
    prisma.assistantAction.findMany({ where: { userId, status: { in: ['DONE', 'REJECTED'] } }, orderBy: { executedAt: 'desc' }, take: 8 }),
    prisma.assistantMessage.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 40 }),
    aiStatus(),
  ]);
  const p = readProfile(u);
  const date = localNow(u).toISODate()!;
  const day = await dayPayload(u, date);
  return {
    ai: { provider: ai.provider, model: ai.model, local: ai.local, reachable: ai.reachable, inUse: await modelAllowed(u) },
    google: {
      configured: googleConfigured(),
      demoAvailable: config.assistantDemo,
      connected: !!account && account.status === 'CONNECTED',
      mode: account?.mode ?? null,
      email: account?.email ?? null,
      status: account?.status ?? null,
      lastSyncAt: account?.lastSyncAt?.toISOString() ?? null,
      transport: config.mcp.calendarUrl && config.mcp.gmailUrl ? 'http' : 'in-process',
    },
    profile: {
      summary: describeProfile(p),
      routine: p.routine,
      meetings: p.meetings,
      learned: p.learned,
      decisions: p.decisions.length,
      notes: p.notes.slice(0, 5),
    },
    questions: questions.map(serializeQuestion),
    actions: pending.map(serializeAction),
    history: recent.map(serializeAction),
    messages: messages.reverse().map((m) => ({ id: m.id, role: m.role, text: m.text, at: m.createdAt.toISOString() })),
    today: { date, plan: day.plan, tasks: day.tasks.length, done: day.progress.done },
  };
}

/** Saves routine/meeting preferences edited in the UI. */
export async function updateProfile(userId: string, body: unknown) {
  const u = await getUser(userId);
  const patch = parse(profilePatchSchema.strict(), body);
  if (patch.workStart && patch.workEnd && patch.workEnd <= patch.workStart) throw badRequest('Work must end after it starts');
  if (patch.meetingsEarliest && patch.meetingsLatest && patch.meetingsLatest <= patch.meetingsEarliest) throw badRequest('Meeting hours must end after they start');
  const memory = applyPatch(u.assistantMemory, patch);
  await saveMemory(userId, memory);
  u.assistantMemory = memory as unknown as Prisma.JsonValue;
  await askProfileQuestions(u, readProfile(u));
  return readProfile(u);
}

/** Forgets what was learned and told (keeps the Google connection). */
export async function resetMemory(userId: string) {
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { assistantMemory: {} } }),
    prisma.assistantQuestion.deleteMany({ where: { userId, kind: 'PROFILE' } }),
    prisma.assistantMessage.deleteMany({ where: { userId } }),
  ]);
}
