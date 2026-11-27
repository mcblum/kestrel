// The only code that reads a value for another computer (docs/designs/onboarding.md, 19.5). Reached only
// from the Allow on a request card (requests.ts), never from the inventory, a route of its own, a tool or
// another operation; a test holds the import graph to that. It reads the one place section 19.2 names for
// the step and picks out exactly the names it is given:
//
//   - an MCP server: the configuration the same discovery the set-up record is built from finds
//     (`~/.claude.json`, a project's `.mcp.json`, Codex's and OpenCode's files, Claude desktop's), the
//     server of that name and scope, its `env` and `headers`; then Kestrel's own sealed list for a name
//     still not found;
//   - a Claude settings file: that file's `env` block.
//
// It never throws, and never says anything that holds text from a file: a parser's error message quotes
// the text near the error, which may be a value, so every failure becomes a fixed sentence here.
import { readFileSync } from 'node:fs';
import { homePathHere } from '../setup-actions/execute.ts';
import type { DiscoveredServer, McpConfig } from '../shared/setup.ts';
import type { SetupRecord } from '../shared/setup-record.ts';
import { copyStepOf, type ValuesAnswer } from '../shared/setup-values.ts';

export interface ValueSources {
  home: string;
  /** The MCP servers this computer has, with their configuration, as the set-up inventory reads them. */
  mcpServers(): DiscoveredServer[] | Promise<DiscoveredServer[]>;
  /** A server of Kestrel's own list with its values; null when there is none of that name. */
  kestrelServer?(name: string): Promise<McpConfig | null>;
  /** A file's text; injected for tests. */
  readText?(path: string): string;
}

/** Why a read failed, said without a word of what was read. */
export class ReadFailed extends Error {}

const record = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The named entries of an `env` or `headers` table that hold text. */
function pick(table: unknown, names: readonly string[], into: Record<string, string>): void {
  const t = record(table);
  for (const name of names) {
    const value = t[name];
    if (into[name] === undefined && typeof value === 'string' && value.length > 0) into[name] = value;
  }
}

async function mcpValues(sources: ValueSources, server: string, scopes: readonly string[], names: readonly string[]): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  let servers: DiscoveredServer[];
  try {
    servers = await sources.mcpServers();
  } catch {
    throw new ReadFailed('Its MCP servers could not be read.');
  }
  for (const s of servers.filter((x) => x.name === server && scopes.includes(x.scope))) {
    pick(s.config.env, names, found);
    pick(s.config.headers, names, found);
  }
  if (names.every((n) => found[n] !== undefined) || !sources.kestrelServer) return found;
  try {
    const own = await sources.kestrelServer(server);
    if (own) {
      pick(own.env, names, found);
      pick(own.headers, names, found);
    }
  } catch {
    // Kestrel's own list could not be opened: what was found in the files still answers.
  }
  return found;
}

function settingsValues(sources: ValueSources, path: string, names: readonly string[]): Record<string, string> {
  const full = homePathHere(path, sources.home);
  if (!full) throw new ReadFailed(`${path} is not in the home folder.`);
  let parsed: unknown;
  try {
    const text = sources.readText ? sources.readText(full) : readFileSync(full, 'utf8');
    parsed = JSON.parse(text);
  } catch {
    throw new ReadFailed(`${path} could not be read.`);
  }
  const found: Record<string, string> = {};
  pick(record(parsed).env, names, found);
  return found;
}

/**
 * Exactly the named values of a step this computer's own record has, and the names it does not have a
 * value for. `record` is this computer's own, read now; the caller has already checked every name against
 * it. Throws only `ReadFailed`, whose message holds no text from a file.
 */
export async function readValues(sources: ValueSources, lineId: string, names: readonly string[], own: Pick<SetupRecord, 'mcp' | 'files'>): Promise<ValuesAnswer> {
  const step = copyStepOf(lineId);
  if (!step) throw new ReadFailed('That step has no values that can be copied.');
  let found: Record<string, string>;
  try {
    found = step.kind === 'mcp' ? await mcpValues(sources, step.server, own.mcp.filter((s) => s.name === step.server).map((s) => s.scope), names) : settingsValues(sources, step.path, names);
  } catch (error) {
    throw error instanceof ReadFailed ? error : new ReadFailed('The values could not be read.');
  }
  const values = Object.fromEntries(names.filter((n) => found[n] !== undefined).map((n) => [n, found[n]!]));
  return { values, notThere: names.filter((n) => found[n] === undefined) };
}

/** Where a step's values would be read from, in words for the request card. Pure. */
export function sourceText(lineId: string, own: Pick<SetupRecord, 'mcp'>): string {
  const step = copyStepOf(lineId);
  if (step?.kind === 'settings') return `from ${step.path} on this computer`;
  const scope = own.mcp.find((s) => s.name === (step?.kind === 'mcp' ? step.server : ''))?.scope;
  const where: Record<string, string> = { user: '~/.claude.json', local: '~/.claude.json', project: "the project's .mcp.json", codex: '~/.codex/config.toml', opencode: "OpenCode's settings", desktop: "Claude desktop's settings", kestrel: "Kestrel's MCP servers" };
  return `from ${(scope && where[scope]) ?? 'its MCP settings'} on this computer`;
}
