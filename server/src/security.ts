// Server access rules from the design doc: loopback only, a random token per launch on every
// HTTP and WebSocket request, and no Origin other than the app's own.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const LOOPBACK_HOST = '127.0.0.1';

export interface AccessPolicy {
  token: string;
  /** Origins the UI is served from. Anything else is refused. */
  allowedOrigins: readonly string[];
  port: number;
}

export function newLaunchToken(): string {
  return randomBytes(32).toString('hex');
}

export type AccessResult = { ok: true } | { ok: false; status: 401 | 403; reason: string };

/**
 * A token good for one session's MCP endpoint only (kestrel-mcp.ts), derived from the launch token:
 * an agent process holding it can reach its own session's tools and nothing else of the server.
 */
export function sessionToken(launchToken: string, sessionId: string): string {
  return createHmac('sha256', launchToken).update(`kestrel-mcp:${sessionId}`).digest('hex');
}

export function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The Host header must name this loopback server; this is what stops DNS rebinding. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function originAllowed(origin: string | undefined, policy: AccessPolicy): boolean {
  // Non-browser clients send no Origin; they still need the token.
  return origin === undefined || policy.allowedOrigins.includes(origin);
}

function tokenFrom(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);
  // Browsers cannot set headers on a WebSocket, so the socket carries it in the query string.
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.searchParams.get('token');
}

/** Checks one request. Preflight (OPTIONS) carries no token and is checked on Host and Origin only. */
export function checkAccess(req: IncomingMessage, policy: AccessPolicy): AccessResult {
  if (!hostAllowed(req.headers.host, policy.port)) return { ok: false, status: 403, reason: 'Host not allowed' };
  if (!originAllowed(req.headers.origin, policy)) return { ok: false, status: 403, reason: 'Origin not allowed' };
  if (req.method === 'OPTIONS') return { ok: true };
  const token = tokenFrom(req);
  if (!token || !sameToken(token, policy.token)) return { ok: false, status: 401, reason: 'Missing or wrong launch token' };
  return { ok: true };
}
