/**
 * Runs the Google Calendar/Meet and Gmail MCP servers as a standalone HTTP
 * service (Streamable HTTP, stateless):
 *
 *   POST /mcp/calendar   POST /mcp/gmail   GET /health
 *
 * Each request carries the caller's short-lived Google access token
 * (`Authorization: Bearer ...`), so this service stores no credentials. When
 * MCP_INTERNAL_TOKEN is set, requests must also send it in `x-mcp-token`, so
 * only the backend can use the service. The sample account is selected with
 * `x-demo-user` / `x-demo-timezone` (only accepted with a valid internal token).
 *
 *   node dist/mcp/serve.js        (PORT, default 4100)
 */
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DemoGoogle } from '../integrations/google/demo.js';
import { RestGoogle } from '../integrations/google/rest.js';
import type { GoogleWorkspace } from '../integrations/google/types.js';
import { createCalendarServer, createGmailServer } from './servers.js';

const internalToken = () => process.env.MCP_INTERNAL_TOKEN || '';

function sameSecret(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function workspaceFrom(req: express.Request): GoogleWorkspace | null {
  const bearer = /^Bearer (.+)$/.exec(req.header('authorization') ?? '')?.[1];
  if (bearer) return new RestGoogle(bearer);
  const demoUser = req.header('x-demo-user');
  if (demoUser && internalToken()) return new DemoGoogle(demoUser, req.header('x-demo-timezone') || 'UTC');
  return null;
}

export function createMcpHttpApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (_req, res) => res.json({ status: 'ok', servers: ['calendar', 'gmail'] }));

  const mount = (path: string, make: (api: GoogleWorkspace) => McpServer) => {
    app.post(path, async (req, res) => {
      if (internalToken() && !sameSecret(req.header('x-mcp-token') ?? '', internalToken())) {
        res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Invalid MCP token' }, id: null });
        return;
      }
      const api = workspaceFrom(req);
      if (!api) {
        res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Missing Google access token' }, id: null });
        return;
      }
      const server = make(api);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
    // Stateless server: no SSE stream or session to resume/delete.
    app.get(path, (_req, res) => res.status(405).set('allow', 'POST').end());
    app.delete(path, (_req, res) => res.status(405).set('allow', 'POST').end());
  };
  mount('/mcp/calendar', createCalendarServer);
  mount('/mcp/gmail', createGmailServer);
  return app;
}

if (process.argv[1] && /serve\.(js|ts)$/.test(process.argv[1])) {
  const port = Number(process.env.PORT ?? 4100);
  createMcpHttpApp().listen(port, () => console.log(`Google MCP servers listening on :${port} (/mcp/calendar, /mcp/gmail)`));
}
