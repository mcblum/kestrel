// Environment for a project's sessions (0.0.20, matt/kestrel#23): variables, .env files to read
// them from, and files git does not track (a local .env, a credentials file) to copy into each new
// worktree. One set applies to every project (`GLOBAL_ENV`) and each project adds its own, which
// wins where both name a variable. Pure and browser-safe: the rules and the words; reading files
// and copying them is project-env/.

export interface EnvSettings {
  /** `NAME=value` lines, as typed; blank lines and `#` comments are kept. */
  vars: string;
  /** .env files read when a session starts: absolute, `~/…`, or relative to the project's folder. */
  files: string[];
  /** Files to copy into a new worktree, as git patterns relative to the project's folder. */
  copy: string[];
}

/** The scope of the settings every project gets. */
export const GLOBAL_ENV = '*';
/** Every scope's settings, by project id or `GLOBAL_ENV`; a scope with nothing set is absent. */
export type EnvByScope = Readonly<Record<string, EnvSettings>>;

export const NO_ENV: EnvSettings = { vars: '', files: [], copy: [] };
export const MAX_VARS_CHARS = 16_000;
export const MAX_ENV_FILES = 20;
export const MAX_COPY_PATTERNS = 50;
const MAX_LINE = 500;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Kestrel's own variables (its launch token, what a script is told) are never the user's to set. */
const RESERVED = 'KESTREL_';

const unquote = (value: string): string => (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) ? value.slice(1, -1) : value);

/** The variables `text` sets, and why any line of it cannot be used. A later line wins. */
export function parseVars(text: string): { vars: Record<string, string>; problems: string[] } {
  const vars: Record<string, string> = {};
  const problems: string[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) return;
    const at = line.indexOf('=');
    const name = at < 0 ? line : line.slice(0, at).trim();
    if (at < 0) return void problems.push(`Line ${i + 1}: write it as NAME=value.`);
    if (!NAME.test(name)) return void problems.push(`Line ${i + 1}: "${name}" is not a variable name (letters, digits and _, not starting with a digit).`);
    if (name.startsWith(RESERVED)) return void problems.push(`Line ${i + 1}: ${name} is one of Kestrel's own variables and cannot be set here.`);
    vars[name] = unquote(line.slice(at + 1).trim());
  });
  return { vars, problems };
}

/** Variables from a parsed .env file that may be used: Kestrel's own names are left out. */
export function usableVars(vars: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars)) if (value !== undefined && NAME.test(name) && !name.startsWith(RESERVED)) out[name] = value;
  return out;
}

/** Why `pattern` cannot say which files to copy, or null when it can. */
export function copyPatternProblem(pattern: string): string | null {
  if (pattern.startsWith('/') || pattern.startsWith('~')) return `"${pattern}" must be relative to the project's folder.`;
  if (pattern.split('/').includes('..')) return `"${pattern}" reaches outside the project's folder.`;
  return null;
}

const lines = (value: unknown, max: number): string[] => (Array.isArray(value) ? [...new Set(value.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => x.length > 0 && x.length <= MAX_LINE))].slice(0, max) : []);

/** Why these settings cannot be saved, or null when they can. `value` is what a client sent. */
export function envProblem(value: unknown): string | null {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  if (typeof v.vars !== 'string' || !Array.isArray(v.files) || !Array.isArray(v.copy)) return 'Send vars (text), files (a list) and copy (a list).';
  if (v.vars.length > MAX_VARS_CHARS) return `The variables can be at most ${MAX_VARS_CHARS} characters. Put more in a .env file and list it.`;
  if (v.files.length > MAX_ENV_FILES) return `List at most ${MAX_ENV_FILES} .env files.`;
  if (v.copy.length > MAX_COPY_PATTERNS) return `List at most ${MAX_COPY_PATTERNS} files to copy.`;
  return parseVars(v.vars).problems[0] ?? lines(v.copy, MAX_COPY_PATTERNS).map(copyPatternProblem).find((p) => p !== null) ?? null;
}

export function sanitizeEnv(value: unknown): EnvSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return { vars: typeof v.vars === 'string' && v.vars.length <= MAX_VARS_CHARS && v.vars.trim() ? v.vars : '', files: lines(v.files, MAX_ENV_FILES), copy: lines(v.copy, MAX_COPY_PATTERNS).filter((p) => copyPatternProblem(p) === null) };
}

export const hasEnv = (env: EnvSettings): boolean => Boolean(env.vars || env.files.length || env.copy.length);

export function sanitizeEnvByScope(value: unknown): EnvByScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, EnvSettings> = {};
  for (const [scope, raw] of Object.entries(value)) {
    const env = sanitizeEnv(raw);
    if (scope.length > 0 && scope.length <= 200 && hasEnv(env)) out[scope] = env;
  }
  return out;
}

/** `all` with one scope's settings replaced; a scope left with nothing is dropped. */
export function withEnv(all: EnvByScope, scope: string, env: EnvSettings): EnvByScope {
  const { [scope]: _old, ...rest } = all;
  return hasEnv(env) ? { ...rest, [scope]: env } : rest;
}

/** What applies to a project (or to a session with none): the app-wide settings, then its own. */
export function scopesFor(all: EnvByScope, projectId: string | null): EnvSettings[] {
  return [all[GLOBAL_ENV], projectId ? all[projectId] : undefined].filter((s): s is EnvSettings => s !== undefined);
}

/** One per line, as the settings page shows and reads a list. */
export const listText = (list: readonly string[]): string => list.join('\n');
export const textList = (text: string): string[] => text.split('\n').map((x) => x.trim()).filter(Boolean);
