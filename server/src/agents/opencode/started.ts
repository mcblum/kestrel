// The `started` event for an OpenCode session: which model, and whether the agent really has
// Kestrel's tools. OpenCode lists no MCP server's tools (its `tool.ids` leaves them out), so the
// check is OpenCode's own status of the `kestrel` server: connected means every tool the server
// serves this session reached the model; anything else means none did, with OpenCode's reason.
import { READ_ONLY_OMITTED } from '../../kestrel-mcp.ts';
import { KESTREL_TOOLS, type AgentEvent, type StartOptions } from '../types.ts';
import type { OpencodeClient } from './client.ts';
import { KESTREL_SERVER } from './config.ts';
import { configuredModel } from './models.ts';
import { serverStates, type AgentServerReport, type HandedServer, type McpServerState } from '../../shared/mcp-servers.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The Kestrel tools a session at this level should have. */
export function expectedTools(opts: Pick<StartOptions, 'permission'>): string[] {
  const omitted = opts.permission === 'readonly' ? READ_ONLY_OMITTED : [];
  return KESTREL_TOOLS.filter((t) => !omitted.includes(t));
}

/** What `mcp.status` says, as the started event's fields. */
export function toolsStatus(status: unknown, expected: string[]): Pick<Extract<AgentEvent, { type: 'started' }>, 'kestrelTools' | 'missing' | 'detail'> {
  const servers = isObj(status) ? status : {};
  const kestrel = isObj(servers[KESTREL_SERVER]) ? servers[KESTREL_SERVER] : null;
  const detail = Object.entries(servers)
    .filter(([, s]) => isObj(s) && s.status !== 'disabled')
    .map(([name, s]) => `${name}: ${str((s as Obj).status) || 'unknown'}${str((s as Obj).error) ? ` (${str((s as Obj).error)})` : ''}`)
    .join(', ');
  if (kestrel?.status === 'connected') return { kestrelTools: 'connected', missing: [], detail };
  const why = kestrel ? `OpenCode could not reach Kestrel's tools: ${str(kestrel.error) || str(kestrel.status)}.` : 'OpenCode did not load Kestrel\'s tools.';
  return { kestrelTools: 'missing', missing: expected, detail: detail ? `${why} ${detail}` : why };
}

/** OpenCode's word for a server's state (`mcp.status`), as Kestrel's. */
const OPENCODE_STATE: Record<string, AgentServerReport['state']> = { connected: 'connected', failed: 'failed', disabled: 'failed', needs_auth: 'needs-sign-in', needs_client_registration: 'needs-sign-in' };

/** Kestrel's own servers in an OpenCode session, from OpenCode's `mcp.status`. Pure. */
export function opencodeServerStates(status: unknown, handed: readonly HandedServer[]): McpServerState[] {
  const reports = new Map<string, AgentServerReport>();
  for (const [name, s] of Object.entries(isObj(status) ? status : {})) {
    if (!isObj(s)) continue;
    const reason = str(s.error) || (s.status === 'disabled' ? 'OpenCode has it switched off.' : '');
    reports.set(name, { state: OPENCODE_STATE[str(s.status)] ?? 'unknown', ...(reason ? { reason } : {}) });
  }
  return serverStates(handed, 'opencode', reports);
}

export async function startedEvent(client: OpencodeClient, sessionID: string, opts: StartOptions): Promise<AgentEvent> {
  const expected = expectedTools(opts);
  const config = opts.model ? null : await client.config.get().then((r) => r.data, () => null);
  const model = opts.model || configuredModel(config) || '';
  const handed = opts.setup?.kestrelServers;
  const status = opts.kestrelMcp || handed?.length ? await client.mcp.status().then((r) => r.data, () => null) : null;
  const base = { type: 'started' as const, agentSessionId: sessionID, model, ...(handed?.length ? { mcpServers: opencodeServerStates(status, handed) } : {}) };
  if (!opts.kestrelMcp) return { ...base, kestrelTools: 'missing', missing: expected, detail: 'Kestrel did not give this session its tools.' };
  return { ...base, ...toolsStatus(status, expected) };
}
