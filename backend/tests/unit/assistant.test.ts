import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { learn } from '../../src/assistant/learn.js';
import { readMeetingRequest, durationFrom } from '../../src/assistant/emailRules.js';
import { readMessage, toHm } from '../../src/assistant/messageRules.js';
import { applyPatch, missingProfileQuestions, peakOf, readProfile, type MeetingDecision } from '../../src/assistant/profile.js';
import { checkTime, meetingWindow, suggestSlots } from '../../src/assistant/slots.js';
import { buildRawEmail, parsePerson, plainBody, toEvent } from '../../src/integrations/google/rest.js';
import { decryptSecret, encryptSecret } from '../../src/integrations/google/crypto.js';

const TZ = 'Asia/Kolkata';
// Tuesday 17 Nov 2026, 09:00 in India.
const NOW = DateTime.fromISO('2026-11-17T09:00:00', { zone: TZ });
const at = (date: string, hm: string) => DateTime.fromISO(`${date}T${hm}:00`, { zone: TZ }).toUTC().toISO()!;

function profile(memory: object = {}, life: object = {}) {
  return readProfile({ lifeProfile: life, assistantMemory: memory });
}
const routine = { routine: { wakeTime: '07:00', sleepTime: '23:00', workStart: '09:00', workEnd: '18:00', workDays: [1, 2, 3, 4, 5], chronotype: 'EARLY_BIRD' } };

describe('profile', () => {
  it('asks only for what it does not know, most important first', () => {
    expect(missingProfileQuestions(profile()).map((q) => q.key)).toEqual(['profile:wakeTime', 'profile:sleepTime', 'profile:workHours', 'profile:chronotype']);
    expect(missingProfileQuestions(profile(routine))).toEqual([]);
    // Answers from "Plan my time" count as known.
    expect(missingProfileQuestions(profile({}, { wakeTime: '06:00', sleepTime: '22:30', persona: 'WORK', workStart: '09:00', workEnd: '17:00', chronotype: 'DAYTIME' }))).toEqual([]);
  });

  it('prefers what the person told the assistant, then what it learned', () => {
    const p = profile({ ...routine, learned: { peak: 'EVENING' } }, { wakeTime: '05:00' });
    expect(p.routine.wakeTime).toBe('07:00');
    expect(peakOf(p)).toBe('EVENING');
    expect(peakOf(profile(routine))).toBe('MORNING');
    expect(p.meetings).toMatchObject({ earliest: '09:00', latest: '18:00', bufferMinutes: 10, protectFocusTime: true });
  });

  it('merges patches and keeps recent notes', () => {
    const m = applyPatch({}, { wakeTime: '06:30', meetingsEarliest: '11:00', maxMeetingsPerDay: 3 }, 'I wake at 6:30');
    expect(m.routine).toEqual({ wakeTime: '06:30' });
    expect(m.meetings).toEqual({ earliest: '11:00', maxPerDay: 3 });
    expect(applyPatch(m, {}, 'second').notes).toEqual(['second', 'I wake at 6:30']);
  });
});

describe('learning timing style', () => {
  const decisions = (hours: number[], choice: MeetingDecision['choice']) => hours.map((hour) => ({ at: '', hour, weekday: 2, choice, kind: 'REQUEST' as const }));

  it('needs enough evidence before concluding anything', () => {
    const l = learn({ completionMinutes: [9 * 60, 10 * 60], estimates: [{ estimated: 60, actual: 120 }], plannedOutcomes: [true], decisions: decisions([14], 'ACCEPT') });
    expect(l).toMatchObject({ peak: null, estimateFactor: null, completionRate: null, preferredMeetingHours: [], avoidedMeetingHours: [], insights: [] });
  });

  it('finds the real peak, estimate drift, completion rate and meeting habits', () => {
    const l = learn({
      completionMinutes: [...Array(8).fill(9 * 60 + 30), ...Array(3).fill(15 * 60), 21 * 60],
      estimates: [60, 60, 30, 90, 45].map((e) => ({ estimated: e, actual: Math.round(e * 1.5) })),
      plannedOutcomes: [true, true, false, false, true, false, false, false, true, false],
      decisions: [...decisions([14, 14, 15], 'ACCEPT'), ...decisions([18, 18], 'DECLINE')],
    });
    expect(l.peak).toBe('MORNING');
    expect(l.peakEvidence).toBe('You finished 8 of your last 12 tasks in the morning.');
    expect(l.estimateFactor).toBe(1.5);
    expect(l.completionRate).toBe(0.4);
    expect(l.preferredMeetingHours).toEqual([14]);
    expect(l.avoidedMeetingHours).toEqual([18]);
    expect(l.insights).toHaveLength(5);
  });

  it('does not call a peak when work is spread evenly', () => {
    const l = learn({ completionMinutes: [...Array(4).fill(600), ...Array(4).fill(900), ...Array(4).fill(1200)], estimates: [], plannedOutcomes: [], decisions: [] });
    expect(l.peak).toBeNull();
  });
});

describe('meeting slots', () => {
  const p = profile(routine);

  it('stays inside meeting hours, avoids clashes with a buffer, and protects focus time', () => {
    const busy = [{ title: 'Stand-up', start: at('2026-11-17', '14:00'), end: at('2026-11-17', '14:30') }];
    const slots = suggestSlots({ now: NOW, timezone: TZ, durationMinutes: 30, busy, profile: p, days: 1 });
    expect(slots).toHaveLength(3);
    for (const s of slots) {
      const d = DateTime.fromISO(s.start).setZone(TZ);
      const m = d.hour * 60 + d.minute;
      expect(m).toBeGreaterThanOrEqual(9 * 60);
      expect(m + 30).toBeLessThanOrEqual(18 * 60);
      // Early bird: mornings (8-12) are kept for focus.
      expect(m >= 12 * 60 || m + 30 <= 8 * 60).toBe(true);
      // 10 min buffer around the stand-up.
      expect(m + 30 <= 13 * 60 + 50 || m >= 14 * 60 + 40).toBe(true);
    }
    // Next to the stand-up scores well.
    expect(slots.some((s) => s.reasons.includes('next to your other meeting'))).toBe(true);
  });

  it('honours the requested day/part and learned habits, skips full days and weekends', () => {
    const learned = profile({ ...routine, learned: { preferredMeetingHours: [16], avoidedMeetingHours: [15] } });
    const s = suggestSlots({ now: NOW, timezone: TZ, durationMinutes: 20, busy: [], profile: learned, preferDate: '2026-11-18', preferPart: 'AFTERNOON', max: 1 });
    expect(s[0].label).toBe('Wed 18 Nov, 4 PM');
    expect(s[0].reasons).toEqual(expect.arrayContaining(['a time you usually pick', 'the day they asked for']));

    const full = profile({ ...routine, meetings: { maxPerDay: 1 } });
    const busy = [{ title: 'x', start: at('2026-11-17', '09:00'), end: at('2026-11-17', '09:30') }];
    const days = suggestSlots({ now: NOW, timezone: TZ, durationMinutes: 30, busy, profile: full, days: 6, max: 10 }).map((x) => DateTime.fromISO(x.start).setZone(TZ).toISODate());
    expect(days).not.toContain('2026-11-17');
    expect(days).not.toContain('2026-11-21'); // Saturday
    expect(days).not.toContain('2026-11-22'); // Sunday
  });

  it('checks proposed times', () => {
    const busy = [{ title: '1:1', start: at('2026-11-18', '11:00'), end: at('2026-11-18', '11:30') }];
    expect(checkTime(at('2026-11-18', '11:15'), 30, busy, p, TZ, NOW)).toMatchObject({ free: false, conflict: '1:1' });
    expect(checkTime(at('2026-11-18', '19:00'), 30, busy, p, TZ, NOW)).toMatchObject({ free: true, outsideHours: true });
    expect(checkTime(at('2026-11-21', '11:00'), 30, busy, p, TZ, NOW).outsideHours).toBe(true); // Saturday
    expect(checkTime(at('2026-11-16', '15:00'), 30, busy, p, TZ, NOW)).toMatchObject({ free: false, past: true });
    expect(meetingWindow(profile({ routine: { wakeTime: '10:00' }, meetings: { earliest: '08:00' } }))).toEqual({ start: 11 * 60, end: 18 * 60 });
  });
});

describe('reading meeting requests in email', () => {
  const email = (subject: string, body: string, from: { email: string; name: string | null } = { email: 'rahul@acme.dev', name: 'Rahul' }) => ({ subject, body, from, date: '2026-11-17T04:00:00Z' });

  it('finds offered times relative to the email date', () => {
    const r = readMeetingRequest(email('Re: Sync on the API migration?', "Can we get 30 minutes? I'm free tomorrow at 2pm or Thursday at 11am."), TZ);
    expect(r.isMeetingRequest).toBe(true);
    expect(r.title).toBe('Sync on the API migration');
    expect(r.durationMinutes).toBe(30);
    expect(r.proposedTimes).toEqual([at('2026-11-18', '14:00'), at('2026-11-19', '11:00')]);
  });

  it('understands "tomorrow afternoon" and durations', () => {
    const r = readMeetingRequest(email('Coffee chat', 'Would love a quick 20 min call sometime tomorrow afternoon. Let me know!'), TZ);
    expect(r).toMatchObject({ isMeetingRequest: true, durationMinutes: 20, proposedTimes: [], preferDate: '2026-11-18', preferPart: 'AFTERNOON' });
    expect(durationFrom('an hour')).toBe(60);
    expect(durationFrom('1.5 hours')).toBe(90);
    expect(durationFrom('half an hour')).toBe(30);
  });

  it('ignores newsletters, notifications and FYIs', () => {
    expect(readMeetingRequest(email('This week in TS', 'Top stories... join our community call! Unsubscribe anytime.'), TZ).isMeetingRequest).toBe(false);
    expect(readMeetingRequest(email('Timesheet', 'Please submit your timesheet by Friday 6pm.'), TZ).isMeetingRequest).toBe(false);
    expect(readMeetingRequest(email('Invite', 'Can we meet tomorrow at 3pm?', { email: 'no-reply@calendar.com', name: null }), TZ).isMeetingRequest).toBe(false);
  });
});

describe('reading chat messages', () => {
  it('reads routine facts with sensible AM/PM guesses', () => {
    const r = readMessage('I wake up at 6:30, sleep around 11 and work 10 to 7. No meetings before 11 please');
    expect(r.intent).toBe('PROFILE');
    expect(r.patch).toEqual({ wakeTime: '06:30', sleepTime: '23:00', workStart: '10:00', workEnd: '19:00', meetingsEarliest: '11:00' });
    expect(readMessage("I'm a night owl, max 3 meetings a day, 15 min buffer between meetings").patch).toEqual({ chronotype: 'NIGHT_OWL', maxMeetingsPerDay: 3, meetingBufferMinutes: 15 });
    expect(readMessage('I go to bed at 1').patch.sleepTime).toBe('01:00');
    expect(readMessage('I focus in 45 minute sessions').patch.focusMinutes).toBe(45);
    expect(toHm('12', undefined, 'am', 'night')).toBe('00:00');
    expect(toHm('9', '30', 'pm', 'morning')).toBe('21:30');
  });

  it('recognises what the person wants', () => {
    expect(readMessage('plan my day').intent).toBe('PLAN_DAY');
    expect(readMessage('can you schedule tomorrow?')).toMatchObject({ intent: 'PLAN_DAY', day: 'tomorrow' });
    expect(readMessage('any new meeting requests in my inbox?').intent).toBe('CHECK_INBOX');
    expect(readMessage("what's on my calendar today")).toMatchObject({ intent: 'AGENDA', day: 'today' });
    expect(readMessage('add review my meeting notes 30m')).toMatchObject({ intent: 'ADD_TASKS', tasksText: 'review my meeting notes 30m' });
    expect(readMessage('thanks!').intent).toBe('HELP');
    // "set up" is not a wake-up time.
    expect(readMessage('set up 3 calls').patch.wakeTime).toBeUndefined();
  });
});

describe('Google REST mapping', () => {
  it('maps events, RSVP status and the Meet link', () => {
    const e = toEvent({
      id: 'e1',
      summary: 'Design review',
      start: { dateTime: '2026-11-17T15:00:00+05:30' },
      end: { dateTime: '2026-11-17T16:00:00+05:30' },
      organizer: { email: 'priya@acme.dev', displayName: 'Priya' },
      attendees: [{ email: 'priya@acme.dev', responseStatus: 'accepted' }, { email: 'me@x.com', self: true, responseStatus: 'needsAction' }],
      conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }] },
    });
    expect(e).toMatchObject({ start: '2026-11-17T09:30:00.000Z', allDay: false, myResponse: 'needsAction', meetUrl: 'https://meet.google.com/abc-defg-hij', organizer: { name: 'Priya', self: false } });
    expect(toEvent({ id: 'e2', start: { date: '2026-11-18' }, end: { date: '2026-11-19' }, organizer: { self: true } })).toMatchObject({ allDay: true, myResponse: null, title: '(no title)' });
  });

  it('builds a safe RFC 822 reply', () => {
    const raw = buildRawEmail({ to: 'a@b.com\r\nBcc: evil@x.com', subject: 'Re: Café sync', body: 'Hi\nthere', inReplyTo: '<m1@x>' });
    const text = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(text).toContain('To: a@b.com Bcc: evil@x.com\r\n'); // newline stripped: no header injection
    expect(text).not.toMatch(/^Bcc:/m);
    expect(text).toContain('Subject: =?UTF-8?B?');
    expect(text).toContain('In-Reply-To: <m1@x>');
    expect(text.endsWith('\r\n\r\nHi\r\nthere')).toBe(true);
  });

  it('reads plain text from multipart messages and parses senders', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    expect(plainBody({ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64('hello') } }, { mimeType: 'text/html', body: { data: b64('<b>x</b>') } }] })).toBe('hello');
    expect(plainBody({ mimeType: 'text/html', body: { data: b64('<p>Hi<br>there</p><script>x()</script>') } }).trim()).toBe('Hi\nthere');
    expect(parsePerson('"Rahul Verma" <Rahul@Acme.dev>')).toEqual({ name: 'Rahul Verma', email: 'rahul@acme.dev' });
  });
});

describe('token encryption', () => {
  it('round-trips and detects tampering', () => {
    const enc = encryptSecret('1//refresh-token');
    expect(enc).not.toContain('refresh');
    expect(decryptSecret(enc)).toBe('1//refresh-token');
    expect(encryptSecret('x')).not.toBe(encryptSecret('x'));
    const parts = enc.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'))).toThrow();
  });
});
