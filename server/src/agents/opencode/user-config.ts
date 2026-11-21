// The names of the MCP servers the user's OpenCode files define, so a Kestrel session can switch
// off the ones not chosen for its project (config.ts), as Codex sessions do with config.toml. Only
// the names are read; nothing is written. The files are where opencode 1.14.25 looks: the global
// folder (~/.config/opencode, or $XDG_CONFIG_HOME/opencode), $OPENCODE_CONFIG, and opencode.json
// or opencode.jsonc (also under .opencode/) in the session's folder and the folders above it.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

type Env = Record<string, string | undefined>;

const FILE_NAMES = ['opencode.json', 'opencode.jsonc', 'config.json'];
const PROJECT_NAMES = ['opencode.json', 'opencode.jsonc', join('.opencode', 'opencode.json'), join('.opencode', 'opencode.jsonc')];

/** JSON with comments and trailing commas (OpenCode's .jsonc) made plain JSON. Strings are left alone. */
export function stripJsonc(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end - 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function stringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '"') return i + 1;
  }
  return text.length;
}

/** The MCP server names in one config file's text; none when it cannot be read. */
export function serverNames(text: string): string[] {
  try {
    const parsed = JSON.parse(stripJsonc(text)) as unknown;
    const mcp = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).mcp : null;
    return typeof mcp === 'object' && mcp !== null && !Array.isArray(mcp) ? Object.keys(mcp) : [];
  } catch {
    return [];
  }
}

const readOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/** The folder and those above it, up to the home folder (or the root). */
function upward(directory: string, home: string): string[] {
  const out: string[] = [];
  for (let dir = directory; ; dir = dirname(dir)) {
    out.push(dir);
    if (dir === home || dirname(dir) === dir) return out;
  }
}

/** Every MCP server name the user's OpenCode files define for a session in `directory`. */
export function configuredServers(directory: string, env: Env = process.env, read: (path: string) => string | null = readOrNull): string[] {
  const home = env.HOME || homedir();
  const global = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode');
  const files = [...FILE_NAMES.map((f) => join(global, f)), ...(env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : []), ...upward(directory, home).flatMap((d) => PROJECT_NAMES.map((f) => join(d, f)))];
  const names = files.flatMap((f) => serverNames(read(f) ?? ''));
  return [...new Set(names)];
}
