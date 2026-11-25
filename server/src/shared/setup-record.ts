// A machine's set-up record (docs/designs/onboarding.md, sections 3 and 5): its configuration with
// every secret left out, sealed onto Kestrel Connect so another machine of the account can build its
// set-up list. "Credentials are not copied, it's just too risky" (Matt, O1): no value that grants
// access is ever in a record, sealed or not.
//
// One function, `setupRecordOf`, splits what the readers found (`MachineInventory`, which may hold
// values) into the record (names only), and `KEY_SHAPES` is the one list of what a key looks like.
// When in doubt it is a secret (O3): every value of an environment variable or a header is left out
// whatever its name; a URL keeps scheme, host, port and path, and its user, password, query values and
// fragment are left out; a flagged or key-shaped argument is left out. Each left-out value becomes a
// named blank. A file in which a key is found is not carried at all, and says where (O11). Pure.
import type { Agent } from '../model.ts';
import type { McpScope } from './setup.ts';
import type { Platform } from './platform.ts';

export const SETUP_RECORD_VERSION = 1;

/** The seal label of a machine's record: `tag("setup|<machine id>")`. */
export const setupLabel = (machineId: string): string => `setup|${machineId}`;

// ---- what a key looks like ----------------------------------------------------------------------

/** Known shapes of a key, token or private key. Used for every value Kestrel cannot place, and for files. */
export const KEY_SHAPES: readonly { name: string; pattern: RegExp }[] = [
  { name: 'a GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { name: 'a GitLab token', pattern: /\b(?:glpat|gloas|glrt|glptt|gldt)-[A-Za-z0-9_-]{16,}/ },
  { name: 'an API key', pattern: /\b(?:sk|rk|pk)[-_](?:live_|test_|proj-|ant-)?[A-Za-z0-9_-]{20,}/ },
  { name: 'a Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}|\bxapp-[A-Za-z0-9-]{10,}/ },
  { name: 'an AWS key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'a Google key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b|\bya29\.[0-9A-Za-z_-]{20,}/ },
  { name: 'a package registry token', pattern: /\b(?:npm_[A-Za-z0-9]{30,}|pypi-[A-Za-z0-9_-]{30,}|hf_[A-Za-z0-9]{30,}|shp(?:at|ss|ca)_[a-f0-9]{32})/ },
  { name: 'a JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: 'a private key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/ },
  { name: 'a bearer token', pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/ },
  // `token = "…"`, `api_key: …`: a value given to a name that says it is one. A placeholder (<…>, ${…}, $X) is not.
  { name: 'a secret given a value', pattern: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|password|passwd)\b["']?\s*[:=]\s*["']?(?![<${]|process\.env)[^\s"',;]{8,}/i },
];

/** A match that is a documentation example, not a key: AWS's `…EXAMPLE`, `sk-xxxx`, `your-token-here`. */
const PLACEHOLDER = /example|x{4,}|your[_-]?(?:api|key|token|secret|pass)|placeholder|dummy|redacted|\*{3,}|<[^>]*>/i;

/** Which key shape the text has, or null. */
export function keyShapeIn(text: string): string | null {
  for (const shape of KEY_SHAPES) {
    const global = new RegExp(shape.pattern.source, shape.pattern.flags.includes('g') ? shape.pattern.flags : `${shape.pattern.flags}g`);
    for (const match of text.matchAll(global)) if (!PLACEHOLDER.test(match[0])) return shape.name;
  }
  return null;
}

/** A long string of mixed letters and digits with no spaces: likely random, so likely a key. */
export function looksRandom(text: string): boolean {
  if (text.length < 24 || /[\s/\\]/.test(text) || /^[./~]/.test(text)) return false;
  if (!/^[A-Za-z0-9_\-+=.:]+$/.test(text)) return false;
  if (/^[0-9a-f]{32,}$/i.test(text)) return true;
  return /[0-9]/.test(text) && /[a-z]/.test(text) && /[A-Z]/.test(text);
}

/** A single value Kestrel cannot place: a key shape, or random-looking. */
export const looksLikeKey = (value: string): boolean => keyShapeIn(value) !== null || looksRandom(value);

/** The first line of a file with a key shape in it, counted from 1, or null. */
export function keyLineIn(text: string): number | null {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((line) => keyShapeIn(line) !== null);
  return at < 0 ? null : at + 1;
}

/** A flag whose value grants access or is a header (`--token`, `-api-key`, `--password=`, `--header`, `-H`). */
const SECRET_FLAG = /^(?:--?[A-Za-z0-9_-]*(?:key|token|secret|password|pass|auth|header)[A-Za-z0-9_-]*|-H)$/i;
const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;

// ---- named blanks -------------------------------------------------------------------------------

export type BlankKind = 'env' | 'header' | 'argument' | 'url-user' | 'url-password' | 'url-query' | 'url-fragment' | 'url-path' | 'url';

/** A value left out, by name and where it goes. Never the value. */
export interface SetupBlank {
  kind: BlankKind;
  /** The variable, header or query name; for an argument or a path segment, its position from 1. */
  name: string;
}

/** The words for a blank, as the list names it. Pure. */
export function blankText(blank: SetupBlank): string {
  switch (blank.kind) {
    case 'env':
      return blank.name;
    case 'header':
      return `the ${blank.name} header`;
    case 'argument':
      return `argument ${blank.name}`;
    case 'url-user':
      return 'the user name in its address';
    case 'url-password':
      return 'the password in its address';
    case 'url-query':
      return `the ${blank.name} query value`;
    case 'url-fragment':
      return 'the part after # in its address';
    case 'url-path':
      return `part ${blank.name} of its address`;
    case 'url':
      return 'its address';
  }
}

/** A URL with its user, password, query values, fragment and key-shaped path parts left out. */
export function splitUrl(raw: string): { url: string | null; blanks: SetupBlank[] } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { url: null, blanks: [{ kind: 'url', name: 'address' }] };
  }
  const blanks: SetupBlank[] = [];
  if (parsed.username) blanks.push({ kind: 'url-user', name: 'user' });
  if (parsed.password) blanks.push({ kind: 'url-password', name: 'password' });
  const segments = parsed.pathname.split('/').map((segment, i) => {
    if (!segment || !looksLikeKey(decodeURIComponent(segment))) return segment;
    blanks.push({ kind: 'url-path', name: String(i) });
    return '…';
  });
  const names = [...new Set([...parsed.searchParams.keys()])];
  for (const name of names) blanks.push({ kind: 'url-query', name });
  if (parsed.hash) blanks.push({ kind: 'url-fragment', name: 'fragment' });
  const query = names.length > 0 ? `?${names.map((n) => `${encodeURIComponent(n)}=`).join('&')}` : '';
  const host = parsed.host ? `//${parsed.host}` : '';
  return { url: `${parsed.protocol}${host}${segments.join('/')}${query}`, blanks };
}

/** A git remote: an `scp`-style address keeps the conventional `git@`; any other user, and everything a URL hides, is left out. */
export function splitRemote(raw: string): string | null {
  const scp = /^(?:([^@/:\s]+)@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(raw.trim());
  if (scp && !raw.includes('://')) {
    const [, user, host, path] = scp;
    if (looksLikeKey(path ?? '')) return null;
    return `${user === 'git' ? 'git@' : ''}${host}:${path}`;
  }
  const { url } = splitUrl(raw.trim());
  return url;
}

/** A command's arguments with every flagged, key-shaped or assigned value left out. */
export function splitArgs(args: readonly string[]): { args: (string | null)[]; blanks: SetupBlank[] } {
  const blanks: SetupBlank[] = [];
  const out = args.map((arg, i): string | null => {
    const position = String(i + 1);
    const previous = i > 0 ? (args[i - 1] ?? '') : '';
    if (SECRET_FLAG.test(previous) && !arg.startsWith('-')) {
      blanks.push({ kind: 'argument', name: position });
      return null;
    }
    const eq = arg.indexOf('=');
    if (arg.startsWith('-') && eq > 0 && SECRET_FLAG.test(arg.slice(0, eq))) {
      blanks.push({ kind: 'argument', name: position });
      return `${arg.slice(0, eq + 1)}…`;
    }
    const assigned = ENV_ASSIGNMENT.exec(arg);
    if (assigned) {
      blanks.push({ kind: 'env', name: assigned[1]! });
      return `${assigned[1]}=…`;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) {
      const split = splitUrl(arg);
      blanks.push(...split.blanks);
      return split.url;
    }
    if (looksLikeKey(arg)) {
      blanks.push({ kind: 'argument', name: position });
      return null;
    }
    return arg;
  });
  return { args: out, blanks };
}

// ---- the record ---------------------------------------------------------------------------------

export type SetupAgentState = 'ready' | 'signed-out' | 'missing';
export interface SetupAgent {
  agent: Agent;
  state: SetupAgentState;
}

export type HostTool = 'gh' | 'glab';
export interface SetupHost {
  tool: HostTool;
  host: string;
  user: string | null;
  protocol: string | null;
  signedIn: boolean;
}

export interface SetupGit {
  name: string | null;
  email: string | null;
  signs: boolean;
  /** `openpgp`, `ssh` or `x509`. */
  format: string | null;
  /** The signing key's fingerprint when git names one by fingerprint; `set` when it names it otherwise. */
  signingKey: string | null;
}

export interface SetupSshHost {
  host: string;
  hostName: string | null;
  user: string | null;
  port: string | null;
  /** The identity files it names, by file name only. */
  identityFiles: string[];
  /** Other option names it sets (`UseKeychain`): names only. */
  options: string[];
}

export interface SetupMcpServer {
  name: string;
  scope: McpScope;
  transport: 'stdio' | 'http' | 'sse';
  command: string | null;
  args: (string | null)[];
  url: string | null;
  env: string[];
  headers: string[];
  blanks: SetupBlank[];
  /** It runs a program inside an app on the source machine (`/Applications/…`). */
  appProgram: string | null;
}

export type SetupFileKind = 'instructions' | 'rules' | 'skill' | 'settings';
export interface SetupFile {
  agent: Agent;
  kind: SetupFileKind;
  /** Under the home folder as `~/…`. */
  path: string;
  /** How many files it is (a skill or a rules folder is several). */
  files: number;
  /** Where a key shape was found: the file is not carried (O11). */
  keyAt: { path: string; line: number } | null;
  /** The names in a settings file's `env` block; their values are left out. */
  env: string[];
  /** Plugins a settings file switches on, by name. */
  plugins: string[];
}

export interface SetupTool {
  name: string;
  /** Why it is needed: "pnpm@9.1.0 in Kestrel's package.json". */
  why: string[];
  /** Whether this machine has it. */
  found: boolean;
}

export interface SetupProject {
  name: string;
  folders: { name: string; path: string; origin: string | null }[];
}

export type SetupPart = 'agents' | 'hosts' | 'git' | 'ssh' | 'mcp' | 'files' | 'tools' | 'projects';

export interface SetupRecord {
  v: typeof SETUP_RECORD_VERSION;
  kind: 'setup';
  machine: { id: string; name: string; platform: Platform };
  /** When this machine last read itself. */
  readAt: number;
  agents: SetupAgent[];
  hosts: SetupHost[];
  git: SetupGit;
  ssh: { hosts: SetupSshHost[]; keyFiles: string[] };
  mcp: SetupMcpServer[];
  files: SetupFile[];
  tools: SetupTool[];
  projects: SetupProject[];
  /** A part that could not be read, and why ("gh is not installed"). Never a value. */
  problems: { part: SetupPart; reason: string }[];
}

// ---- what the readers found, which may hold values ----------------------------------------------

export interface FoundFile {
  agent: Agent;
  kind: SetupFileKind;
  /** The file or folder, absolute. */
  path: string;
  /** Each file's text (a folder's files), read to be checked and never carried. */
  texts: { path: string; text: string }[];
}

export interface MachineInventory {
  machine: { id: string; name: string; platform: Platform };
  home: string;
  readAt: number;
  agents: SetupAgent[];
  hosts: SetupHost[];
  git: { name: string | null; email: string | null; signs: boolean; format: string | null; signingKey: string | null };
  /** `~/.ssh/config`'s text, and the file names in `~/.ssh` (never opened). */
  ssh: { config: string | null; keyFiles: string[] };
  mcp: { name: string; scope: McpScope; config: Record<string, unknown> }[];
  files: FoundFile[];
  tools: SetupTool[];
  projects: { name: string; folders: { name: string; path: string; origin: string | null }[] }[];
  problems: { part: SetupPart; reason: string }[];
}

const record = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** A path under the home folder as `~/…`, with `/` between parts; any other path as it is. */
export function homePath(path: string, home: string): string {
  const norm = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '');
  const h = norm(home);
  const p = norm(path);
  if (p === h) return '~';
  return p.startsWith(`${h}/`) ? `~/${p.slice(h.length + 1)}` : p;
}

/** Text that is not a key: itself; anything else is left out. */
const safe = (value: string | null | undefined): string | null => (value && !looksLikeKey(value) ? value : null);

function splitMcp(found: MachineInventory['mcp'][number], home: string): SetupMcpServer {
  const config = found.config;
  const blanks: SetupBlank[] = [];
  const env = Object.keys(record(config.env));
  for (const name of env) blanks.push({ kind: 'env', name });
  const headers = Object.keys(record(config.headers));
  for (const name of headers) blanks.push({ kind: 'header', name });
  let url: string | null = null;
  if (typeof config.url === 'string') {
    const split = splitUrl(config.url);
    url = split.url;
    blanks.push(...split.blanks);
  }
  const rawCommand = typeof config.command === 'string' ? config.command : null;
  const command = rawCommand && !looksLikeKey(rawCommand) ? homePath(rawCommand, home) : null;
  const split = splitArgs(strings(config.args));
  blanks.push(...split.blanks);
  const transport = url ? (config.type === 'sse' ? 'sse' : 'http') : 'stdio';
  const appProgram = rawCommand && /\.app\//.test(rawCommand) ? (/([^/]+\.app)\//.exec(rawCommand)?.[1] ?? null) : null;
  return { name: found.name, scope: found.scope, transport, command, args: split.args.map((a) => (a === null ? null : homePath(a, home))), url, env, headers, blanks, appProgram };
}

function splitFile(found: FoundFile, home: string): SetupFile {
  let keyAt: SetupFile['keyAt'] = null;
  for (const { path, text } of found.texts) {
    const line = keyLineIn(text);
    if (line !== null) {
      keyAt = { path: homePath(path, home), line };
      break;
    }
  }
  let env: string[] = [];
  let plugins: string[] = [];
  if (found.kind === 'settings' && found.texts.length === 1) {
    try {
      const parsed = record(JSON.parse(found.texts[0]!.text));
      env = Object.keys(record(parsed.env));
      const enabled = record(parsed.enabledPlugins);
      plugins = Object.keys(enabled).filter((k) => enabled[k] === true);
    } catch {
      // Not JSON (Codex's TOML): names are not read from it in this stage.
    }
  }
  return { agent: found.agent, kind: found.kind, path: homePath(found.path, home), files: found.texts.length, keyAt, env, plugins };
}

/** `~/.ssh/config` into its hosts: names, addresses, users, ports and identity file names. Never a key. */
export function sshHostsOf(config: string): SetupSshHost[] {
  const hosts: SetupSshHost[] = [];
  let current: SetupSshHost | null = null;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const match = /^(\S+)\s*(?:=\s*|\s+)(.+)$/.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      current = { host: value, hostName: null, user: null, port: null, identityFiles: [], options: [] };
      hosts.push(current);
      continue;
    }
    if (key === 'match') {
      current = null;
      continue;
    }
    if (!current) continue;
    if (key === 'hostname') current.hostName = safe(value);
    else if (key === 'user') current.user = safe(value);
    else if (key === 'port') current.port = /^\d+$/.test(value) ? value : null;
    else if (key === 'identityfile') current.identityFiles.push(value.replaceAll('\\', '/').split('/').pop() ?? value);
    else if (!current.options.includes(match[1]!)) current.options.push(match[1]!);
  }
  return hosts;
}

/** A signing key named by fingerprint is carried; any other way of naming it (a path, a literal key) only as `set`. */
const signingKeyOf = (key: string | null): string | null => (!key ? null : /^(?:0x)?[0-9A-F]{8,40}!?$/i.test(key) ? key : 'set');

/** The one split: what the readers found, with every secret left out. Pure. */
export function setupRecordOf(found: MachineInventory): SetupRecord {
  const home = found.home;
  return {
    v: SETUP_RECORD_VERSION,
    kind: 'setup',
    machine: found.machine,
    readAt: found.readAt,
    agents: found.agents.map((a) => ({ agent: a.agent, state: a.state })),
    hosts: found.hosts.flatMap((h) => (safe(h.host) ? [{ tool: h.tool, host: h.host, user: safe(h.user), protocol: h.protocol === 'ssh' || h.protocol === 'https' ? h.protocol : null, signedIn: h.signedIn }] : [])),
    git: { name: safe(found.git.name), email: safe(found.git.email), signs: found.git.signs, format: found.git.format, signingKey: signingKeyOf(found.git.signingKey) },
    ssh: { hosts: found.ssh.config && keyLineIn(found.ssh.config) === null ? sshHostsOf(found.ssh.config) : [], keyFiles: found.ssh.keyFiles.filter((n) => !looksLikeKey(n)) },
    mcp: found.mcp.map((m) => splitMcp(m, home)),
    files: found.files.map((f) => splitFile(f, home)),
    tools: found.tools.filter((t) => t.name.length <= 64 && !looksLikeKey(t.name)).map((t) => ({ name: t.name, why: t.why.map((w) => homePath(w, home)), found: t.found })),
    projects: found.projects.map((p) => ({ name: p.name, folders: p.folders.map((f) => ({ name: f.name, path: homePath(f.path, home), origin: f.origin ? splitRemote(f.origin) : null })) })),
    problems: found.problems,
  };
}

/** A record read back from the service, checked for shape; anything else is null. */
export function asSetupRecord(value: unknown): SetupRecord | null {
  const r = record(value);
  const machine = record(r.machine);
  if (r.v !== SETUP_RECORD_VERSION || r.kind !== 'setup' || typeof machine.id !== 'string' || typeof machine.name !== 'string') return null;
  const lists = ['agents', 'hosts', 'mcp', 'files', 'tools', 'projects', 'problems'] as const;
  if (lists.some((k) => !Array.isArray(r[k])) || typeof r.git !== 'object' || typeof r.ssh !== 'object') return null;
  return value as SetupRecord;
}
