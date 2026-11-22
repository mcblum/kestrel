// A session's Kestrel tools over MCP HTTP (for Codex and OpenCode): who may call them, and that they are the
// session's own tools.
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { NO_TOOLS } from './agents/test-support.ts';
import { KESTREL_TOOLS, loadsWithSession, type KestrelToolHost } from './agents/types.ts';
import { mcpSessionOf, mcpUrl, READ_ONLY_OMITTED, serveSessionMcp } from './kestrel-mcp.ts';
import { sessionToken } from './security.ts';

const LAUNCH = 'launch-token-for-tests';
const host: KestrelToolHost = { ...NO_TOOLS, listProjects: async () => [{ name: 'alpha' }] as never };
let server: Server | null = null;

afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function serve(omit: readonly string[] = []): Promise<number> {
  server = createServer((req, res) => {
    const id = mcpSessionOf(req.url);
    if (!id) return void res.writeHead(404).end();
    const port = (server!.address() as AddressInfo).port;
    void serveSessionMcp(req, res, id, { token: LAUNCH, allowedOrigins: [], port }, { toolsFor: (s) => (s === 'one' ? { host, omit } : null) });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

const call = (port: number, session: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(mcpUrl(port, session), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${sessionToken(LAUNCH, session)}`, ...headers },
    body: JSON.stringify(body),
  });
const rpc = (id: number, method: string, params: unknown = {}) => ({ jsonrpc: '2.0', id, method, params });

describe('session MCP endpoint', () => {
  it('finds the session in the path', () => {
    expect(mcpSessionOf('/api/sessions/abc-1/mcp')).toBe('abc-1');
    expect(mcpSessionOf('/api/sessions/abc-1/mcp/')).toBe('abc-1');
    expect(mcpSessionOf('/api/sessions/abc-1')).toBeNull();
    expect(mcpSessionOf('/api/sessions/../mcp')).toBeNull();
  });

  it("each session's token differs, and differs from the launch token", () => {
    expect(sessionToken(LAUNCH, 'one')).not.toBe(sessionToken(LAUNCH, 'two'));
    expect(sessionToken(LAUNCH, 'one')).not.toContain(LAUNCH);
    expect(sessionToken('another-launch', 'one')).not.toBe(sessionToken(LAUNCH, 'one'));
  });

  it("lists and runs the session's own tools", async () => {
    const port = await serve();
    const listed = await (await call(port, 'one', rpc(1, 'tools/list'))).json();
    expect(listed.result.tools.map((t: { name: string }) => t.name)).toContain('list_projects');
    const ran = await (await call(port, 'one', rpc(2, 'tools/call', { name: 'list_projects', arguments: {} }))).json();
    expect(ran.result.content[0].text).toBe('[{"name":"alpha"}]');
  });

  // Every provider gets every tool (Matt, 2026-11-21): Claude is handed this server in-process, Codex
  // and OpenCode reach it here, so a tool missing from it is missing for all three, and a name in
  // KESTREL_TOOLS that is not served is a tool no agent has.
  it('serves exactly the tools in KESTREL_TOOLS, so no provider is given fewer', async () => {
    const port = await serve();
    const listed = await (await call(port, 'one', rpc(1, 'tools/list'))).json();
    const names: string[] = listed.result.tools.map((t: { name: string }) => t.name);
    expect([...names].sort()).toEqual([...KESTREL_TOOLS].sort());
  });

  it('marks the session tools as always loaded, and leaves the browser and simulator tools to be looked up', async () => {
    const port = await serve();
    const listed = await (await call(port, 'one', rpc(1, 'tools/list'))).json();
    const loaded = (name: string) => listed.result.tools.find((t: { name: string }) => t.name === name)?._meta?.['anthropic/alwaysLoad'] === true;
    const always = KESTREL_TOOLS.filter(loaded);
    expect(always).toEqual(KESTREL_TOOLS.filter(loadsWithSession));
    expect(always).toContain('spawn');
    expect(always).toContain('next_step');
    expect(always).not.toContain('browser_read');
    expect(always).not.toContain('sim_tap');
  });

  it('leaves out the tools a read-only session may not use', async () => {
    const port = await serve(READ_ONLY_OMITTED);
    const listed = await (await call(port, 'one', rpc(1, 'tools/list'))).json();
    const names: string[] = listed.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('browser_read');
    expect(names).not.toContain('browser_click');
    expect(READ_ONLY_OMITTED.length).toBeGreaterThan(0);
  });

  it("refuses another session's token, the launch token, no token, a browser origin and a foreign host", async () => {
    const port = await serve();
    expect((await call(port, 'one', rpc(1, 'tools/list'), { Authorization: `Bearer ${sessionToken(LAUNCH, 'two')}` })).status).toBe(401);
    expect((await call(port, 'one', rpc(1, 'tools/list'), { Authorization: `Bearer ${LAUNCH}` })).status).toBe(401);
    expect((await call(port, 'one', rpc(1, 'tools/list'), { Authorization: '' })).status).toBe(401);
    expect((await call(port, 'one', rpc(1, 'tools/list'), { Origin: 'http://evil.example' })).status).toBe(403);
    // fetch will not send another Host, so this one goes by hand.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/sessions/one/mcp', method: 'POST', headers: { Host: 'evil.example', Authorization: `Bearer ${sessionToken(LAUNCH, 'one')}` } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(403);
  });

  it('answers 404 for a session that is not running and 405 for anything but POST', async () => {
    const port = await serve();
    expect((await call(port, 'two', rpc(1, 'tools/list'))).status).toBe(404);
    const get = await fetch(mcpUrl(port, 'one'), { headers: { Authorization: `Bearer ${sessionToken(LAUNCH, 'one')}` } });
    expect(get.status).toBe(405);
  });
});
