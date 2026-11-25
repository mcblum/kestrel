// HTTP routes for Kestrel's list of MCP servers (Settings → Agent setup, and a project's Settings tab).
// The UI's only: no Kestrel tool reaches them (an agent's proposing tool is a later stage). No answer
// carries a secret value: a server comes back as `McpServerView`, each secret only "set" or not.
//
//   GET    /api/mcp-servers               200 { servers, storage }
//   POST   /api/mcp-servers               201 McpServerView   (add)
//   GET    /api/mcp-servers/<name>        200 McpServerView
//   PUT    /api/mcp-servers/<name>        200 McpServerView   (change; the name stays)
//   DELETE /api/mcp-servers/<name>        204                 (its values are deleted too)
//   POST   /api/mcp-servers/<name>/test   200 ProbeResult     (starts or reaches it once, lists its tools)
import type { McpServerStore } from './store.ts';
import { probeServer, type ProbeResult } from './probe.ts';

export type McpAnswer = { status: number; body: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

export interface McpServersApi {
  store: McpServerStore;
  /** Settings' Test; replaced in tests. */
  probe?: (config: Record<string, unknown>) => Promise<ProbeResult>;
}

export async function mcpServersRoute(parts: readonly string[], method: string, readBody: ReadBody, api: McpServersApi | undefined): Promise<McpAnswer | null> {
  if (parts[1] !== 'mcp-servers') return null;
  if (!api) return { status: 409, body: { error: 'MCP servers are not available in this copy of Kestrel.' } };
  const { store } = api;
  if (parts.length === 2) {
    if (method === 'GET') return { status: 200, body: await store.list() };
    if (method === 'POST') return { status: 201, body: await store.save(null, await readBody()) };
    return null;
  }
  const name = decodeURIComponent(parts[2]!);
  if (parts.length === 3) {
    if (method === 'GET') return { status: 200, body: await store.view(name) };
    if (method === 'PUT') return { status: 200, body: await store.save(name, await readBody()) };
    if (method === 'DELETE') {
      await store.remove(name);
      return { status: 204, body: null };
    }
    return null;
  }
  if (parts.length === 4 && parts[3] === 'test' && method === 'POST') return { status: 200, body: await (api.probe ?? probeServer)(await store.configOf(name)) };
  return null;
}
