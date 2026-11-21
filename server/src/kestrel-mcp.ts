// Kestrel's tools over MCP's streamable HTTP, one endpoint per session, for agents that run
// Kestrel's tools out of process (Codex). The tools are the very ones Claude gets in-process
// (agents/claude/tools.ts), built on the session's own KestrelToolHost, so every rule behind them
// (limits, approvals, filing) is the same.
//
//   POST /api/sessions/<id>/mcp     Authorization: Bearer <session token>
//
// The session token is derived from the per-launch token and the session id (security.ts), so it
// opens this one session's tools and nothing else, and it changes on every launch. Requests must
// come from this loopback server's own Host and carry no browser Origin. Stateless: each request
// gets a fresh server and transport, so nothing lingers between calls.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { BROWSER_WRITES, SIM_WRITES } from './agents/claude/options.ts';
import { kestrelMcpServer } from './agents/claude/tools.ts';
import type { KestrelToolHost } from './agents/types.ts';
import { hostAllowed, sameToken, sessionToken, type AccessPolicy } from './security.ts';

/** show_widget takes up to 200 KB of code; JSON escaping can double it. */
const MAX_BODY_BYTES = 1024 * 1024;
const PATH = /^\/api\/sessions\/([A-Za-z0-9-]{1,100})\/mcp\/?$/;

/** The tools a read-only session does not get: the ones that change something (Claude's read-only refuses the same). */
export const READ_ONLY_OMITTED: readonly string[] = [...BROWSER_WRITES, ...SIM_WRITES].map((t) => t.replace(/^mcp__kestrel__/, ''));

/** The session an MCP request is for, or null when the path is not an MCP endpoint. */
export function mcpSessionOf(url: string | undefined): string | null {
  const path = new URL(url ?? '/', 'http://localhost').pathname;
  return PATH.exec(path)?.[1] ?? null;
}

/** The address Kestrel gives an agent for a session's tools. */
export const mcpUrl = (port: number, sessionId: string) => `http://127.0.0.1:${port}/api/sessions/${sessionId}/mcp`;

export interface McpSessions {
  /** The session's tools, and which to leave out; null when no such session is loaded. */
  toolsFor(sessionId: string): { host: KestrelToolHost; omit: readonly string[] } | null;
}

function reply(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Checks and serves one request to a session's MCP endpoint. Never throws. */
export async function serveSessionMcp(req: IncomingMessage, res: ServerResponse, sessionId: string, policy: AccessPolicy, sessions: McpSessions): Promise<void> {
  if (!hostAllowed(req.headers.host, policy.port)) return reply(res, 403, 'Host not allowed');
  if (req.headers.origin !== undefined) return reply(res, 403, 'Origin not allowed');
  const header = req.headers.authorization;
  const given = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!given || !sameToken(given, sessionToken(policy.token, sessionId))) return reply(res, 401, 'Missing or wrong session token');
  // Stateless: no SSE stream to open and no session to end.
  if (req.method !== 'POST') return reply(res, 405, 'Only POST is served here');
  const tools = sessions.toolsFor(sessionId);
  if (!tools) return reply(res, 404, 'No such session is running in Kestrel');
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    return reply(res, 400, 'The body must be JSON of at most 1 MB');
  }
  const server = kestrelMcpServer(tools.host, tools.omit).instance;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport as Parameters<typeof server.connect>[0]);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    console.error('[kestrel] MCP request failed', error);
    if (!res.headersSent) reply(res, 500, 'Kestrel could not handle that MCP request');
  }
}
