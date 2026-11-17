/**
 * A built-in sample Google calendar and inbox, so anyone can try the assistant
 * without connecting a real account (and so the whole flow is testable).
 *
 * The data is generated relative to "today" in the user's timezone, and changes
 * (accepted invites, new meetings, sent emails) are kept in memory per user for
 * the life of the process. Nothing here touches the network.
 */
import { DateTime } from 'luxon';
import type { CreateMeetingInput, GEvent, GMessage, GMessageSummary, GoogleWorkspace, Rsvp, SendEmailInput } from './types.js';

interface DemoState {
  day: string;
  events: GEvent[];
  messages: GMessage[];
  sent: (SendEmailInput & { id: string; at: string })[];
}

const states = new Map<string, DemoState>();
const ME = 'you@demo.smart-scheduling.app';

function seed(timezone: string, now: DateTime): DemoState {
  const today = now.setZone(timezone).startOf('day');
  const at = (days: number, hm: string) => {
    const [h, m] = hm.split(':').map(Number);
    return today.plus({ days }).set({ hour: h, minute: m }).toUTC().toISO()!;
  };
  const weekdayName = (days: number) => today.plus({ days }).toFormat('cccc');
  const ev = (id: string, title: string, d: number, s: string, e: string, organizer: { email: string; name: string } | null, mine: Rsvp | null, extra: Partial<GEvent> = {}): GEvent => ({
    id,
    title,
    start: at(d, s),
    end: at(d, e),
    allDay: false,
    organizer: organizer ? { ...organizer, self: false } : { email: ME, name: 'You', self: true },
    attendees: organizer ? [{ email: organizer.email, name: organizer.name, self: false, responseStatus: 'accepted' }, { email: ME, name: 'You', self: true, responseStatus: mine ?? 'needsAction' }] : [],
    myResponse: organizer ? mine : null,
    meetUrl: `https://meet.google.com/demo-${id.slice(-3)}-xyz`,
    description: null,
    ...extra,
  });
  const priya = { email: 'priya.sharma@acme.dev', name: 'Priya Sharma' };
  const lead = { email: 'arjun.mehta@acme.dev', name: 'Arjun Mehta' };
  const vendor = { email: 'demos@cloudvendor.io', name: 'CloudVendor Team' };
  const msg = (id: string, from: { email: string; name: string }, subject: string, hoursAgo: number, body: string): GMessage => ({
    id,
    threadId: `t-${id}`,
    from,
    to: ME,
    subject,
    date: now.minus({ hours: hoursAgo }).toUTC().toISO()!,
    snippet: body.replace(/\s+/g, ' ').slice(0, 120),
    body,
    messageId: `<${id}@mail.demo>`,
  });
  return {
    day: today.toISODate()!,
    events: [
      ev('demo-standup', 'Daily stand-up', 0, '10:00', '10:15', lead, 'accepted'),
      ev('demo-design-review', 'Design review: onboarding flow', 0, '15:00', '16:00', priya, 'needsAction'),
      ev('demo-one-on-one', '1:1 with Arjun', 1, '11:00', '11:30', lead, 'accepted'),
      ev('demo-vendor', 'CloudVendor product demo', 1, '16:30', '17:30', vendor, 'needsAction'),
    ],
    messages: [
      msg('demo-m1', { email: 'rahul.verma@acme.dev', name: 'Rahul Verma' }, 'Sync on the API migration?', 3,
        `Hi,\n\nCan we get 30 minutes to sync on the API migration plan? I'm free tomorrow at 2pm or ${weekdayName(2)} at 11am.\n\nThanks,\nRahul`),
      msg('demo-m2', { email: 'neha.k@designhub.co', name: 'Neha Kapoor' }, 'Coffee chat about the design system', 20,
        'Hey! Would love a quick 20 min call sometime tomorrow afternoon to talk about the design system. Let me know what works.\n\nNeha'),
      msg('demo-m3', { email: 'newsletter@devweekly.io', name: 'Dev Weekly' }, 'This week in TypeScript', 8,
        'Top stories this week: TypeScript 7 performance, new React compiler tips, and more. Unsubscribe anytime.'),
      msg('demo-m4', { email: 'hr@acme.dev', name: 'Acme HR' }, 'Reminder: submit your timesheet', 30,
        'Please submit your timesheet by Friday 6pm. Thank you!'),
    ],
    sent: [],
  };
}

export class DemoGoogle implements GoogleWorkspace {
  readonly mode = 'demo' as const;
  private readonly state: DemoState;

  constructor(key: string, timezone: string, now: DateTime = DateTime.now()) {
    const day = now.setZone(timezone).toISODate()!;
    let s = states.get(key);
    if (!s || s.day !== day) {
      s = seed(timezone, now);
      states.set(key, s);
    }
    this.state = s;
  }

  static reset(key?: string) {
    if (key) states.delete(key);
    else states.clear();
  }

  /** Emails "sent" from the demo account (for the UI and tests). */
  get sent() {
    return this.state.sent;
  }

  async listEvents(o: { timeMin: string; timeMax: string; max?: number }) {
    return this.state.events
      .filter((e) => e.end > o.timeMin && e.start < o.timeMax)
      .sort((a, b) => a.start.localeCompare(b.start))
      .slice(0, o.max ?? 100)
      .map((e) => structuredClone(e));
  }

  async createMeeting(o: CreateMeetingInput) {
    const id = `demo-new-${this.state.events.length + 1}`;
    const e: GEvent = {
      id,
      title: o.title,
      start: new Date(o.start).toISOString(),
      end: new Date(o.end).toISOString(),
      allDay: false,
      organizer: { email: ME, name: 'You', self: true },
      attendees: o.attendees.map((email) => ({ email, name: null, self: false, responseStatus: 'needsAction' as Rsvp })),
      myResponse: null,
      meetUrl: o.withMeet ? `https://meet.google.com/demo-${id.slice(-3)}-new` : null,
      description: o.description ?? null,
    };
    this.state.events.push(e);
    return structuredClone(e);
  }

  async respondToEvent(o: { eventId: string; response: Exclude<Rsvp, 'needsAction'> }) {
    const e = this.state.events.find((x) => x.id === o.eventId);
    if (!e) throw new Error('Event not found');
    e.myResponse = o.response;
    for (const a of e.attendees) if (a.self) a.responseStatus = o.response;
    return structuredClone(e);
  }

  async searchMessages(o: { query: string; max?: number }): Promise<GMessageSummary[]> {
    return this.state.messages.slice(0, o.max ?? 10).map(({ id, threadId, from, subject, date, snippet }) => ({ id, threadId, from, subject, date, snippet }));
  }

  async getMessage(id: string) {
    const m = this.state.messages.find((x) => x.id === id);
    if (!m) throw new Error('Message not found');
    return structuredClone(m);
  }

  async sendEmail(o: SendEmailInput) {
    const id = `demo-sent-${this.state.sent.length + 1}`;
    this.state.sent.push({ ...o, id, at: new Date().toISOString() });
    return { id, threadId: o.threadId ?? `t-${id}` };
  }
}

export const DEMO_EMAIL = ME;
