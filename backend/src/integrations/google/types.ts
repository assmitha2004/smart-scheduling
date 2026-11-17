/**
 * The slice of Google Calendar (with Meet) and Gmail the assistant uses.
 *
 * Two implementations: `RestGoogle` calls Google's REST APIs with a user's
 * access token; `DemoGoogle` is a built-in sample calendar and inbox, so the
 * assistant can be tried (and tested) without a Google account. The MCP servers
 * in src/mcp/ expose either one as tools.
 */

export type Rsvp = 'needsAction' | 'accepted' | 'declined' | 'tentative';

export interface Person {
  email: string;
  name: string | null;
}

export interface GEvent {
  id: string;
  title: string;
  /** ISO timestamps (UTC). All-day events use the day's midnight UTC. */
  start: string;
  end: string;
  allDay: boolean;
  organizer: Person & { self: boolean };
  attendees: (Person & { self: boolean; responseStatus: Rsvp })[];
  /** The signed-in user's answer to the invite, or null when they organise it / aren't listed. */
  myResponse: Rsvp | null;
  meetUrl: string | null;
  description: string | null;
}

export interface GMessageSummary {
  id: string;
  threadId: string;
  from: Person;
  subject: string;
  /** ISO timestamp the message was received. */
  date: string;
  snippet: string;
}

export interface GMessage extends GMessageSummary {
  to: string;
  /** Plain-text body, trimmed to a few thousand characters. Untrusted content. */
  body: string;
  /** RFC 822 Message-ID, used to thread replies. */
  messageId: string | null;
}

export interface CreateMeetingInput {
  title: string;
  start: string;
  end: string;
  timeZone: string;
  attendees: string[];
  description?: string;
  withMeet: boolean;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
}

export interface GoogleWorkspace {
  readonly mode: 'google' | 'demo';
  listEvents(o: { timeMin: string; timeMax: string; max?: number }): Promise<GEvent[]>;
  createMeeting(o: CreateMeetingInput): Promise<GEvent>;
  respondToEvent(o: { eventId: string; response: Exclude<Rsvp, 'needsAction'> }): Promise<GEvent>;
  searchMessages(o: { query: string; max?: number }): Promise<GMessageSummary[]>;
  getMessage(id: string): Promise<GMessage>;
  sendEmail(o: SendEmailInput): Promise<{ id: string; threadId: string }>;
}

/** Thrown when Google rejects the token (revoked, expired grant). */
export class GoogleAuthError extends Error {
  override name = 'GoogleAuthError';
}
