// Kestrel's own list of MCP servers (docs/designs/mcp-servers.md). Pure: the types, the checks on
// what the user typed, the one split between a server's definition (kept in the database) and its
// secret values (kept in the sealed store, mcp-servers/secrets.ts), what the UI and other code may
// see of a server (never a secret value), which servers a session gets, and what each agent made of
// them for the session header.
//
// A server applies to every project (the default set) or to one project. A server for every project
// is switched on per project by the same lists as the servers found in the agents' own files
// (`ProjectSetup.mcpServers`); a project's own server is on in that project's sessions. When a name
// is in both Kestrel's list and an agent's own file, Kestrel's wins.
import { Refused } from '../refused.ts';
import type { McpConfig, McpServerInfo } from './setup.ts';

export type McpKind = 'stdio' | 'http' | 'sse';
export const MCP_KINDS: readonly McpKind[] = ['stdio', 'http', 'sse'];

/** Where a value goes: a local command's environment, or an address's request headers. */
export type McpValuePlace = 'env' | 'header';

/** One environment variable or header. Secret unless the user switched that off; a secret's value is never here. */
export interface McpValueDef {
  key: string;
  secret: boolean;
  /** The value, for one that is not secret only. */
  value?: string;
}

/** A server as the database keeps it: every value that is not secret, and the names of the secret ones. */
export interface McpServerDef {
  name: string;
  kind: McpKind;
  /** A local command: what runs, and its arguments. */
  command?: string;
  args?: string[];
  /** An HTTP or SSE server's address. */
  url?: string;
  env: McpValueDef[];
  headers: McpValueDef[];
  /** Null: every project (the default set). Otherwise the one project it is for. */
  projectId: string | null;
}

/** Secret values of one server, by slot (`slotOf`). Held only by the sealed store and at session start. */
export type McpSecretValues = Record<string, string>;
/** Every server's secret values, by server name. */
export type McpSecrets = Record<string, McpSecretValues>;

export const slotOf = (place: McpValuePlace, key: string): string => `${place}:${key}`;

/** What anyone but a session's agent may see of a value: whether a secret is set, never what it is. */
export interface McpValueView {
  key: string;
  secret: boolean;
  /** Not secret: the value. */
  value?: string;
  /** Has a value (a secret: in the sealed store on this computer). */
  set: boolean;
}

/** What the UI, the onboarding record and logs may see of a server: no secret value. */
export interface McpServerView {
  name: string;
  kind: McpKind;
  command?: string;
  args?: string[];
  url?: string;
  env: McpValueView[];
  headers: McpValueView[];
  projectId: string | null;
  /** What it runs, or the host it connects to. */
  where: string;
  /** Why an agent cannot be handed it, by agent; absent when every agent can. */
  cannot?: Partial<Record<McpAgent, string>>;
}

export type McpAgent = 'claude' | 'codex' | 'opencode';

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** An HTTP header name (RFC 9110 token). */
const HEADER_KEY = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
/** Kestrel's own tools' server: no user server may take its name. */
export const RESERVED_NAME = 'kestrel';
const MAX_VALUE = 8000;
const MAX_ARGS = 100;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The words for each kind, for the UI and refusals. */
export const KIND_LABEL: Record<McpKind, string> = { stdio: 'Local command', http: 'HTTP', sse: 'SSE' };

/** Why Codex cannot be handed a server of this kind, or null. Codex 0.167.2 speaks stdio and streamable HTTP only. */
export function codexCannot(server: Pick<McpServerDef, 'name' | 'kind'>): string | null {
  return server.kind === 'sse' ? `Codex cannot reach ${server.name}: it speaks only SSE, and Codex speaks only streamable HTTP. Claude and OpenCode can.` : null;
}

export function whereOf(server: Pick<McpServerDef, 'kind' | 'command' | 'url'>): string {
  if (server.kind === 'stdio') return (server.command ?? '').split('/').pop() || server.command || '';
  try {
    return new URL(server.url ?? '').host;
  } catch {
    return 'a remote server';
  }
}

/** What a server typed in Settings looks like as it arrives: values given in clear, secret or not. */
export interface McpServerInput {
  def: McpServerDef;
  /** Secret values typed this time, by slot. A secret not here keeps what the store has. */
  typed: McpSecretValues;
  /** Secret slots the user cleared. */
  cleared: string[];
}

function values(raw: unknown, place: McpValuePlace): { defs: McpValueDef[]; typed: McpSecretValues; cleared: string[] } {
  if (raw === undefined) return { defs: [], typed: {}, cleared: [] };
  if (!Array.isArray(raw)) throw new Refused(`${place === 'env' ? 'Environment variables' : 'Headers'} must be a list.`);
  const defs: McpValueDef[] = [];
  const typed: McpSecretValues = {};
  const cleared: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isObj(item)) throw new Refused('Each variable or header needs a name.');
    const key = str(item.key).trim();
    if (!key && !str(item.value)) continue; // an empty row
    if (place === 'env' && !ENV_KEY.test(key)) throw new Refused(`"${key}" is not a usable environment variable name: letters, digits and _, not starting with a digit.`);
    if (place === 'header' && !HEADER_KEY.test(key)) throw new Refused(`"${key}" is not a usable header name.`);
    const folded = place === 'header' ? key.toLowerCase() : key;
    if (seen.has(folded)) throw new Refused(`${key} is given twice.`);
    seen.add(folded);
    const secret = item.secret !== false;
    const value = item.value;
    if (value !== undefined && value !== null && typeof value !== 'string') throw new Refused(`The value of ${key} must be text.`);
    if (typeof value === 'string' && value.length > MAX_VALUE) throw new Refused(`The value of ${key} is too long.`);
    if (secret) {
      defs.push({ key, secret: true });
      if (typeof value === 'string' && value !== '') typed[slotOf(place, key)] = value;
      if (item.clear === true) cleared.push(slotOf(place, key));
    } else {
      defs.push({ key, secret: false, value: typeof value === 'string' ? value : '' });
    }
  }
  return { defs, typed, cleared };
}

/**
 * A server as typed, checked and split: the definition (no secret value) and the secret values typed.
 * Refused, with the reason, when it cannot be used. `projectIds`: the projects that exist.
 */
export function parseServerInput(raw: unknown, projectIds: readonly string[]): McpServerInput {
  if (!isObj(raw)) throw new Refused('Give the server: its name, kind, and command or address.');
  const name = str(raw.name).trim();
  if (!NAME.test(name)) throw new Refused('A server name is 1 to 64 letters, digits, - or _, so every agent can use it.');
  if (name.toLowerCase() === RESERVED_NAME) throw new Refused('"kestrel" is the name of Kestrel\'s own tools. Choose another name.');
  if (name === 'new') throw new Refused('"new" is taken by the Add a server page. Choose another name.');
  const kind = raw.kind as McpKind;
  if (!MCP_KINDS.includes(kind)) throw new Refused('The kind is a local command, HTTP or SSE.');
  const projectId = raw.projectId === null || raw.projectId === undefined || raw.projectId === '' ? null : str(raw.projectId);
  if (projectId !== null && !projectIds.includes(projectId)) throw new Refused('No such project.');
  const env = values(raw.env, 'env');
  const headers = values(raw.headers, 'header');
  const base = { name, kind, projectId };
  if (kind === 'stdio') {
    const command = str(raw.command).trim();
    if (!command) throw new Refused('A local command needs the command to run.');
    if (raw.args !== undefined && (!Array.isArray(raw.args) || !raw.args.every((a) => typeof a === 'string'))) throw new Refused('Arguments must be a list of text.');
    const args = ((raw.args as string[] | undefined) ?? []).filter((a) => a !== '');
    if (args.length > MAX_ARGS) throw new Refused('Too many arguments.');
    if (headers.defs.length) throw new Refused('A local command takes environment variables, not headers.');
    return { def: { ...base, command, args, env: env.defs, headers: [] }, typed: env.typed, cleared: env.cleared };
  }
  const url = str(raw.url).trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Refused('The address must be a full URL, such as https://example.com/mcp.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Refused('The address must start with https:// or http://.');
  if (parsed.username || parsed.password) throw new Refused('Put credentials in a secret header, not in the address.');
  if (env.defs.length) throw new Refused('An address takes headers, not environment variables.');
  return { def: { ...base, url, env: [], headers: headers.defs }, typed: headers.typed, cleared: headers.cleared };
}

/** The secret slots a definition has. */
export const secretSlots = (def: McpServerDef): string[] => [...def.env.filter((v) => v.secret).map((v) => slotOf('env', v.key)), ...def.headers.filter((v) => v.secret).map((v) => slotOf('header', v.key))];

/** A server's stored values after a save: what was kept, what was typed, minus what was cleared or is no longer secret. */
export function nextSecrets(def: McpServerDef, before: McpSecretValues, typed: McpSecretValues, cleared: readonly string[]): McpSecretValues {
  const slots = secretSlots(def);
  return Object.fromEntries(slots.flatMap((slot) => {
    const value = typed[slot] ?? (cleared.includes(slot) ? undefined : before[slot]);
    return value ? [[slot, value]] : [];
  }));
}

/** A stored definition, checked: anything malformed reads as no server. */
export function asServerDef(raw: unknown): McpServerDef | null {
  if (!isObj(raw)) return null;
  const valueList = (v: unknown): McpValueDef[] =>
    Array.isArray(v) ? v.filter(isObj).filter((x) => typeof x.key === 'string' && x.key).map((x) => (x.secret === false ? { key: x.key as string, secret: false, value: str(x.value) } : { key: x.key as string, secret: true })) : [];
  const name = str(raw.name);
  const kind = raw.kind as McpKind;
  if (!NAME.test(name) || !MCP_KINDS.includes(kind)) return null;
  const projectId = typeof raw.projectId === 'string' && raw.projectId ? raw.projectId : null;
  if (kind === 'stdio') {
    if (!str(raw.command)) return null;
    return { name, kind, command: str(raw.command), args: Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : [], env: valueList(raw.env), headers: [], projectId };
  }
  if (!str(raw.url)) return null;
  return { name, kind, url: str(raw.url), env: [], headers: valueList(raw.headers), projectId };
}

export const asServerDefs = (raw: unknown): McpServerDef[] => (Array.isArray(raw) ? raw.map(asServerDef).filter((d): d is McpServerDef => d !== null) : []);

/** What may be shown of a server: the names of its secrets and whether each is set, never a value. */
export function serverView(def: McpServerDef, stored: McpSecretValues = {}): McpServerView {
  const view = (place: McpValuePlace) => (v: McpValueDef): McpValueView => (v.secret ? { key: v.key, secret: true, set: Boolean(stored[slotOf(place, v.key)]) } : { key: v.key, secret: false, value: v.value ?? '', set: (v.value ?? '') !== '' });
  const codex = codexCannot(def);
  return {
    name: def.name,
    kind: def.kind,
    ...(def.kind === 'stdio' ? { command: def.command, args: def.args ?? [] } : { url: def.url }),
    env: def.env.map(view('env')),
    headers: def.headers.map(view('header')),
    projectId: def.projectId,
    where: whereOf(def),
    ...(codex ? { cannot: { codex } } : {}),
  };
}

/** The values a server needs that have none, by name, so the header can say "needs …". */
export function missingValues(def: McpServerDef, stored: McpSecretValues): string[] {
  return [...def.env.map((v) => ({ v, slot: slotOf('env', v.key) })), ...def.headers.map((v) => ({ v, slot: slotOf('header', v.key) }))].filter(({ v, slot }) => (v.secret ? !stored[slot] : !v.value)).map(({ v }) => v.key);
}

/**
 * A server with its values, in the shape the Claude Agent SDK takes (and the other adapters
 * translate): a value goes only into this server's own entry. A value with none is left out.
 */
export function serverConfig(def: McpServerDef, stored: McpSecretValues): McpConfig {
  const filled = (place: McpValuePlace, list: readonly McpValueDef[]): Record<string, string> | undefined => {
    const entries = list.flatMap((v) => {
      const value = v.secret ? stored[slotOf(place, v.key)] : v.value;
      return value ? [[v.key, value] as const] : [];
    });
    return entries.length ? Object.fromEntries(entries) : undefined;
  };
  if (def.kind === 'stdio') {
    const env = filled('env', def.env);
    return { command: def.command, args: def.args ?? [], ...(env ? { env } : {}) };
  }
  const headers = filled('header', def.headers);
  return { type: def.kind, url: def.url, ...(headers ? { headers } : {}) };
}

// ---- which servers a session gets -------------------------------------------------------

/** A server of Kestrel's list handed to a session, for the header: what it is and what it lacks. Never a value. */
export interface HandedServer {
  name: string;
  kind: McpKind;
  /** Values it needs that have none on this computer. */
  missing: string[];
}

/**
 * Kestrel's servers a session gets, by the rule of section 9: the default set's servers switched on
 * in `switchedOn` (the project's own setup, or the defaults), and, in a project, that project's own.
 * `projectId` null: the default set alone (no project, or a review of somebody else's pull request).
 */
export function kestrelServersFor(defs: readonly McpServerDef[], switchedOn: readonly string[], projectId: string | null): McpServerDef[] {
  return defs.filter((d) => (d.projectId === null ? switchedOn.includes(d.name) : projectId !== null && d.projectId === projectId));
}

/** The session's servers: the found ones switched on, then Kestrel's, which win on a shared name. */
export function mergeServers(found: Record<string, McpConfig>, kestrel: readonly McpServerDef[], secrets: McpSecrets): { mcpServers: Record<string, McpConfig>; handed: HandedServer[] } {
  const mcpServers: Record<string, McpConfig> = { ...found };
  for (const def of kestrel) mcpServers[def.name] = serverConfig(def, secrets[def.name] ?? {});
  const handed = kestrel.map((def) => ({ name: def.name, kind: def.kind, missing: missingValues(def, secrets[def.name] ?? {}) }));
  return { mcpServers, handed };
}

// ---- what the agent made of them --------------------------------------------------------

export type McpServerStateKind = 'connected' | 'starting' | 'failed' | 'needs-sign-in' | 'not-for-agent' | 'unknown';

/** One of Kestrel's servers in a session, as the agent reported it. Shown in the session header. */
export interface McpServerState {
  name: string;
  state: McpServerStateKind;
  /** The agent's reason, or why this agent was not given it. */
  reason?: string;
  /** Values it needed that had none. */
  missing?: string[];
}

/** What an agent said of one server, in its own words, reduced. */
export interface AgentServerReport {
  state: Exclude<McpServerStateKind, 'not-for-agent'>;
  reason?: string;
}

/** The header's line per handed server, from the agent's own report (`reports`, by name). Pure. */
export function serverStates(handed: readonly HandedServer[] | undefined, agent: McpAgent, reports: ReadonlyMap<string, AgentServerReport>): McpServerState[] {
  return (handed ?? []).map((h) => {
    const missing = h.missing.length ? { missing: h.missing } : {};
    const cannot = agent === 'codex' ? codexCannot(h) : null;
    if (cannot) return { name: h.name, state: 'not-for-agent', reason: cannot };
    const report = reports.get(h.name);
    return { name: h.name, state: report?.state ?? 'unknown', ...(report?.reason ? { reason: report.reason } : {}), ...missing };
  });
}

/** Words for one server's state, for the header. */
export function serverStateText(s: McpServerState): string {
  const needs = s.missing?.length ? ` (needs ${s.missing.join(', ')} on this computer)` : '';
  switch (s.state) {
    case 'connected':
      return `${s.name}: connected`;
    case 'starting':
      return `${s.name}: starting`;
    case 'needs-sign-in':
      return `${s.name}: needs signing in`;
    case 'not-for-agent':
      return s.reason ?? `${s.name}: not for this agent`;
    case 'failed':
      return `${s.name}: failed${s.reason ? `: ${s.reason}` : ''}${needs}`;
    default:
      return `${s.name}: the agent did not say${needs}`;
  }
}

/**
 * The servers a setup's switches offer: Kestrel's own for every project first, then those found in the
 * agents' files whose name Kestrel's list does not take (Kestrel's wins). A project's own servers are
 * not switched: they are on in that project. Pure.
 */
export function switchableServers(found: readonly McpServerInfo[], defs: readonly McpServerDef[]): McpServerInfo[] {
  const taken = new Set(defs.map((d) => d.name));
  const own = defs.filter((d) => d.projectId === null).map((d): McpServerInfo => ({ name: d.name, scope: 'kestrel', kind: d.kind, where: whereOf(d) }));
  return [...own, ...found.filter((s) => !taken.has(s.name))];
}
