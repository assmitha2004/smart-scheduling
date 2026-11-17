/**
 * Google Calendar (with Meet) and Gmail over plain REST + fetch, using one
 * user's short-lived access token. No Google SDK: the few endpoints used are
 * small, and keeping them visible makes the data flow easy to audit.
 */
import { randomUUID } from 'node:crypto';
import {
  GoogleAuthError,
  type CreateMeetingInput,
  type GEvent,
  type GMessage,
  type GMessageSummary,
  type GoogleWorkspace,
  type Person,
  type Rsvp,
  type SendEmailInput,
} from './types.js';

const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_BODY = 4000;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export class RestGoogle implements GoogleWorkspace {
  readonly mode = 'google' as const;
  constructor(private readonly accessToken: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async req(url: string, init: RequestInit = {}): Promise<Json> {
    const res = await this.fetchImpl(url, {
      ...init,
      headers: { authorization: `Bearer ${this.accessToken}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401) throw new GoogleAuthError('Google rejected the access token');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Google API ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  async listEvents(o: { timeMin: string; timeMax: string; max?: number }): Promise<GEvent[]> {
    const q = new URLSearchParams({ timeMin: o.timeMin, timeMax: o.timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: String(o.max ?? 100) });
    const data = await this.req(`${CAL}/events?${q}`);
    return ((data.items ?? []) as Json[]).filter((e) => e.status !== 'cancelled' && e.transparency !== 'transparent').map(toEvent);
  }

  async createMeeting(o: CreateMeetingInput): Promise<GEvent> {
    const body: Json = {
      summary: o.title,
      description: o.description,
      start: { dateTime: o.start, timeZone: o.timeZone },
      end: { dateTime: o.end, timeZone: o.timeZone },
      attendees: o.attendees.map((email) => ({ email })),
    };
    if (o.withMeet) body.conferenceData = { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
    const data = await this.req(`${CAL}/events?conferenceDataVersion=1&sendUpdates=all`, { method: 'POST', body: JSON.stringify(body) });
    return toEvent(data);
  }

  async respondToEvent(o: { eventId: string; response: Exclude<Rsvp, 'needsAction'> }): Promise<GEvent> {
    const id = encodeURIComponent(o.eventId);
    const event = await this.req(`${CAL}/events/${id}`);
    const attendees = ((event.attendees ?? []) as Json[]).map((a) => (a.self ? { ...a, responseStatus: o.response } : a));
    if (!attendees.some((a) => a.self)) throw new Error('You are not on the guest list of this event');
    const data = await this.req(`${CAL}/events/${id}?sendUpdates=all`, { method: 'PATCH', body: JSON.stringify({ attendees }) });
    return toEvent(data);
  }

  async searchMessages(o: { query: string; max?: number }): Promise<GMessageSummary[]> {
    const q = new URLSearchParams({ q: o.query, maxResults: String(o.max ?? 10) });
    const list = await this.req(`${GMAIL}/messages?${q}`);
    const ids = ((list.messages ?? []) as Json[]).map((m) => m.id as string);
    const out: GMessageSummary[] = [];
    for (const id of ids) {
      const m = await this.req(`${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
      out.push(toSummary(m));
    }
    return out;
  }

  async getMessage(id: string): Promise<GMessage> {
    const m = await this.req(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`);
    const headers = headerMap(m);
    return { ...toSummary(m), to: headers.to ?? '', messageId: headers['message-id'] ?? null, body: plainBody(m.payload).slice(0, MAX_BODY) };
  }

  async sendEmail(o: SendEmailInput): Promise<{ id: string; threadId: string }> {
    const raw = buildRawEmail(o);
    const data = await this.req(`${GMAIL}/messages/send`, { method: 'POST', body: JSON.stringify({ raw, ...(o.threadId ? { threadId: o.threadId } : {}) }) });
    return { id: data.id, threadId: data.threadId };
  }
}

// ---------- mapping helpers (exported for tests) ----------

export function toEvent(e: Json): GEvent {
  const allDay = !e.start?.dateTime;
  const start = allDay ? new Date(`${e.start?.date}T00:00:00Z`).toISOString() : new Date(e.start.dateTime).toISOString();
  const end = allDay ? new Date(`${e.end?.date}T00:00:00Z`).toISOString() : new Date(e.end.dateTime).toISOString();
  const attendees = ((e.attendees ?? []) as Json[]).map((a) => ({
    email: String(a.email ?? ''),
    name: a.displayName ?? null,
    self: !!a.self,
    responseStatus: (a.responseStatus ?? 'needsAction') as Rsvp,
  }));
  const me = attendees.find((a) => a.self);
  const organizerSelf = !!e.organizer?.self;
  const meet = e.hangoutLink ?? ((e.conferenceData?.entryPoints ?? []) as Json[]).find((p) => p.entryPointType === 'video')?.uri ?? null;
  return {
    id: String(e.id),
    title: String(e.summary ?? '(no title)'),
    start,
    end,
    allDay,
    organizer: { email: String(e.organizer?.email ?? ''), name: e.organizer?.displayName ?? null, self: organizerSelf },
    attendees,
    myResponse: organizerSelf ? null : me?.responseStatus ?? null,
    meetUrl: meet,
    description: e.description ? String(e.description).slice(0, 1000) : null,
  };
}

function headerMap(m: Json): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of (m.payload?.headers ?? []) as Json[]) out[String(h.name).toLowerCase()] = String(h.value);
  return out;
}

export function parsePerson(value: string): Person {
  const m = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim().toLowerCase() };
  return { name: null, email: value.trim().toLowerCase() };
}

function toSummary(m: Json): GMessageSummary {
  const h = headerMap(m);
  return {
    id: String(m.id),
    threadId: String(m.threadId),
    from: parsePerson(h.from ?? ''),
    subject: h.subject ?? '(no subject)',
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : new Date(h.date ?? Date.now()).toISOString(),
    snippet: decodeEntities(String(m.snippet ?? '')),
  };
}

const decodeEntities = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const b64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

/** First text/plain part (or text/html stripped of tags). */
export function plainBody(part: Json): string {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return b64url(part.body.data);
  for (const p of (part.parts ?? []) as Json[]) {
    const t = plainBody(p);
    if (t) return t;
  }
  if (part.mimeType === 'text/html' && part.body?.data) {
    return decodeEntities(b64url(part.body.data).replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ');
  }
  return '';
}

const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const noNewlines = (s: string) => s.replace(/[\r\n]+/g, ' ');

/** RFC 822 message, base64url-encoded as Gmail expects. Header values are stripped of newlines (no header injection). */
export function buildRawEmail(o: SendEmailInput): string {
  const lines = [
    `To: ${noNewlines(o.to)}`,
    `Subject: ${encodeHeader(noNewlines(o.subject))}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ];
  if (o.inReplyTo) lines.push(`In-Reply-To: ${noNewlines(o.inReplyTo)}`, `References: ${noNewlines(o.inReplyTo)}`);
  const msg = `${lines.join('\r\n')}\r\n\r\n${o.body.replace(/\r?\n/g, '\r\n')}`;
  return Buffer.from(msg, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
