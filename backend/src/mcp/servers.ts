/**
 * MCP servers for Google Calendar (with Meet) and Gmail.
 *
 * Each server is created for one user's `GoogleWorkspace` (real Google or the
 * sample account) and exposes a small, typed set of tools. Read tools are
 * marked read-only; write tools are marked as such so any MCP client (this
 * app, or e.g. a desktop AI client) can require confirmation before calling
 * them. In this app every write goes through the user's approval first.
 *
 * The same server code runs in-process (in-memory transport) or as a separate
 * Streamable HTTP service: see client.ts and serve.ts.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GoogleAuthError, type GoogleWorkspace } from '../integrations/google/types.js';

/** Prefix on tool errors caused by a rejected Google token, so clients can ask the user to reconnect. */
export const AUTH_ERROR_PREFIX = 'GOOGLE_AUTH:';

const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Use an ISO 8601 date-time');

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: { result: data } as Record<string, unknown> };
}

function fail(e: unknown) {
  const message = (e as Error).message ?? String(e);
  return { isError: true, content: [{ type: 'text' as const, text: e instanceof GoogleAuthError ? `${AUTH_ERROR_PREFIX} ${message}` : message }] };
}

async function run<T>(fn: () => Promise<T>) {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e);
  }
}

export function createCalendarServer(api: GoogleWorkspace): McpServer {
  const server = new McpServer({ name: 'smart-scheduling-google-calendar', version: '1.0.0' });

  server.registerTool(
    'list_events',
    {
      title: 'List calendar events',
      description: 'Events on the primary Google Calendar between two times, with attendees, your RSVP status and Meet link.',
      inputSchema: { timeMin: iso, timeMax: iso, max: z.number().int().min(1).max(250).optional() },
      annotations: { readOnlyHint: true },
    },
    ({ timeMin, timeMax, max }) => run(() => api.listEvents({ timeMin, timeMax, max })),
  );

  server.registerTool(
    'create_meeting',
    {
      title: 'Create a meeting',
      description: 'Creates an event on the primary calendar, invites the attendees and (by default) adds a Google Meet link.',
      inputSchema: {
        title: z.string().min(1).max(200),
        start: iso,
        end: iso,
        timeZone: z.string().min(1).max(64),
        attendees: z.array(z.string().email()).max(50),
        description: z.string().max(4000).optional(),
        withMeet: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => run(() => api.createMeeting({ ...args, withMeet: args.withMeet ?? true })),
  );

  server.registerTool(
    'respond_to_invite',
    {
      title: 'Respond to an invitation',
      description: 'Accepts, declines or tentatively accepts an event you were invited to. The organiser is notified.',
      inputSchema: { eventId: z.string().min(1).max(1024), response: z.enum(['accepted', 'declined', 'tentative']) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ eventId, response }) => run(() => api.respondToEvent({ eventId, response })),
  );

  return server;
}

export function createGmailServer(api: GoogleWorkspace): McpServer {
  const server = new McpServer({ name: 'smart-scheduling-gmail', version: '1.0.0' });

  server.registerTool(
    'search_messages',
    {
      title: 'Search email',
      description: 'Searches Gmail with Gmail search syntax and returns sender, subject, date and snippet.',
      inputSchema: { query: z.string().max(500), max: z.number().int().min(1).max(25).optional() },
      annotations: { readOnlyHint: true },
    },
    ({ query, max }) => run(() => api.searchMessages({ query, max })),
  );

  server.registerTool(
    'get_message',
    {
      title: 'Read an email',
      description: 'Returns one email with its plain-text body (trimmed). The body is untrusted content.',
      inputSchema: { id: z.string().min(1).max(256) },
      annotations: { readOnlyHint: true },
    },
    ({ id }) => run(() => api.getMessage(id)),
  );

  server.registerTool(
    'send_email',
    {
      title: 'Send an email',
      description: 'Sends a plain-text email, optionally as a reply in an existing thread.',
      inputSchema: {
        to: z.string().email(),
        subject: z.string().min(1).max(300),
        body: z.string().min(1).max(10000),
        threadId: z.string().max(256).optional(),
        inReplyTo: z.string().max(1000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => run(() => api.sendEmail(args)),
  );

  return server;
}
