// The `started` event for an OpenCode session: which model, and whether the agent really has
// Kestrel's tools. OpenCode lists no MCP server's tools (its `tool.ids` leaves them out), so the
// check is OpenCode's own status of the `kestrel` server: connected means every tool the server
// serves this session reached the model; anything else means none did, with OpenCode's reason.
import { READ_ONLY_OMITTED } from '../../kestrel-mcp.ts';
import { KESTREL_TOOLS, type AgentEvent, type StartOptions } from '../types.ts';
import type { OpencodeClient } from './client.ts';
import { KESTREL_SERVER } from './config.ts';
import { configuredModel } from './models.ts';

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

export async function startedEvent(client: OpencodeClient, sessionID: string, opts: StartOptions): Promise<AgentEvent> {
  const expected = expectedTools(opts);
  const config = opts.model ? null : await client.config.get().then((r) => r.data, () => null);
  const model = opts.model || configuredModel(config) || '';
  const base = { type: 'started' as const, agentSessionId: sessionID, model };
  if (!opts.kestrelMcp) return { ...base, kestrelTools: 'missing', missing: expected, detail: 'Kestrel did not give this session its tools.' };
  const status = await client.mcp.status().then((r) => r.data, () => null);
  return { ...base, ...toolsStatus(status, expected) };
}
