/**
 * The assistant's MCP client for a user's Google Calendar/Meet and Gmail.
 *
 * - MCP_CALENDAR_URL / MCP_GMAIL_URL set: connects to the MCP servers over
 *   Streamable HTTP (the `mcp` service in docker-compose), passing that user's
 *   short-lived Google access token per request. The servers keep no tokens.
 * - Otherwise: runs the same servers in-process over a linked in-memory transport.
 *
 * Everything the assistant does with Google goes through these tools.
 */
import type { User } from '@prisma/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { accessTokenFor, markNeedsReconnect } from '../integrations/google/account.js';
import { DemoGoogle } from '../integrations/google/demo.js';
import { RestGoogle } from '../integrations/google/rest.js';
import type { CreateMeetingInput, GEvent, GMessage, GMessageSummary, GoogleWorkspace, Rsvp, SendEmailInput } from '../integrations/google/types.js';
import { AUTH_ERROR_PREFIX, createCalendarServer, createGmailServer } from './servers.js';

export class GoogleToolError extends Error {
  constructor(message: string, readonly needsReconnect = false) {
    super(message);
  }
}

export interface GoogleTools {
  mode: 'google' | 'demo';
  email: string;
  /** Names of the tools each server offers (shown in the UI). */
  toolNames(): Promise<{ calendar: string[]; gmail: string[] }>;
  listEvents(o: { timeMin: string; timeMax: string; max?: number }): Promise<GEvent[]>;
  createMeeting(o: CreateMeetingInput): Promise<GEvent>;
  respondToInvite(o: { eventId: string; response: Exclude<Rsvp, 'needsAction'> }): Promise<GEvent>;
  searchMessages(o: { query: string; max?: number }): Promise<GMessageSummary[]>;
  getMessage(id: string): Promise<GMessage>;
  sendEmail(o: SendEmailInput): Promise<{ id: string; threadId: string }>;
  close(): Promise<void>;
}

/** The Google implementation behind the tools when they run in-process. */
export function workspaceFor(mode: string, userId: string, timezone: string, accessToken?: string): GoogleWorkspace {
  return mode === 'demo' ? new DemoGoogle(userId, timezone) : new RestGoogle(accessToken!);
}

async function connect(name: string, transport: Transport): Promise<Client> {
  const client = new Client({ name: `smart-scheduling-assistant/${name}`, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

/** Opens MCP sessions to the user's Calendar and Gmail servers, or returns null when no Google account is connected. */
export async function openGoogleTools(user: Pick<User, 'id' | 'timezone'>): Promise<GoogleTools | null> {
  const account = await prisma.googleAccount.findUnique({ where: { userId: user.id } });
  if (!account || account.status !== 'CONNECTED') return null;

  let accessToken: string | undefined;
  if (account.mode === 'google') {
    try {
      accessToken = await accessTokenFor(account);
    } catch (e) {
      throw new GoogleToolError((e as Error).message, (e as Error).name === 'GoogleAuthError' || account.status !== 'CONNECTED');
    }
  }

  let calendar: Client;
  let gmail: Client;
  if (config.mcp.calendarUrl && config.mcp.gmailUrl) {
    const headers: Record<string, string> = {
      ...(config.mcp.internalToken ? { 'x-mcp-token': config.mcp.internalToken } : {}),
      ...(account.mode === 'demo' ? { 'x-demo-user': user.id, 'x-demo-timezone': user.timezone } : { authorization: `Bearer ${accessToken}` }),
    };
    calendar = await connect('calendar', new StreamableHTTPClientTransport(new URL(config.mcp.calendarUrl), { requestInit: { headers } }));
    gmail = await connect('gmail', new StreamableHTTPClientTransport(new URL(config.mcp.gmailUrl), { requestInit: { headers } }));
  } else {
    const api = workspaceFor(account.mode, user.id, user.timezone, accessToken);
    const [calClient, calServer] = InMemoryTransport.createLinkedPair();
    const [mailClient, mailServer] = InMemoryTransport.createLinkedPair();
    await createCalendarServer(api).connect(calServer);
    await createGmailServer(api).connect(mailServer);
    calendar = await connect('calendar', calClient);
    gmail = await connect('gmail', mailClient);
  }

  const call = async <T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> => {
    const r = await client.callTool({ name, arguments: args });
    const text = Array.isArray(r.content) ? r.content.map((c) => (c as { text?: string }).text ?? '').join(' ') : '';
    if (r.isError) {
      if (text.startsWith(AUTH_ERROR_PREFIX)) {
        await markNeedsReconnect(user.id);
        throw new GoogleToolError('Google access expired or was revoked. Please reconnect your Google account.', true);
      }
      throw new GoogleToolError(text || `${name} failed`);
    }
    const structured = r.structuredContent as { result?: unknown } | undefined;
    return (structured?.result ?? JSON.parse(text)) as T;
  };

  return {
    mode: account.mode as 'google' | 'demo',
    email: account.email,
    async toolNames() {
      const [c, g] = await Promise.all([calendar.listTools(), gmail.listTools()]);
      return { calendar: c.tools.map((t) => t.name), gmail: g.tools.map((t) => t.name) };
    },
    listEvents: (o) => call(calendar, 'list_events', o),
    createMeeting: (o) => call(calendar, 'create_meeting', { ...o }),
    respondToInvite: (o) => call(calendar, 'respond_to_invite', o),
    searchMessages: (o) => call(gmail, 'search_messages', o),
    getMessage: (id) => call(gmail, 'get_message', { id }),
    sendEmail: (o) => call(gmail, 'send_email', { ...o }),
    async close() {
      await Promise.allSettled([calendar.close(), gmail.close()]);
    },
  };
}

/** Runs `fn` with the user's Google tools and always closes the sessions. */
export async function withGoogleTools<T>(user: Pick<User, 'id' | 'timezone'>, fn: (tools: GoogleTools | null) => Promise<T>): Promise<T> {
  const tools = await openGoogleTools(user);
  try {
    return await fn(tools);
  } finally {
    await tools?.close();
  }
}
