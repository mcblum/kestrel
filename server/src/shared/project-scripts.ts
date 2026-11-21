// A project's lifecycle scripts (0.0.20, matt/kestrel#22): `setup` runs in a new session's
// worktree before its agent starts (install dependencies, prepare services), `archive` runs there
// before the session is archived (stop services, free ports). Each is shell text the user wrote in
// the project's Settings; an empty one runs nothing. Only a session with a worktree runs them: a
// plain folder is the user's own, already set up. Pure: the rules and the words, no processes.

export interface ProjectScripts {
  setup: string;
  archive: string;
}

export type ScriptKind = keyof ProjectScripts;

/** Every project's scripts, by project id; a project with none is absent. */
export type ScriptsByProject = Readonly<Record<string, ProjectScripts>>;

export const NO_SCRIPTS: ProjectScripts = { setup: '', archive: '' };
export const MAX_SCRIPT_CHARS = 8000;
/** A setup script may install dependencies; an archive script only tidies up, and its request waits for it. */
export const SCRIPT_TIMEOUT_MS: Record<ScriptKind, number> = { setup: 15 * 60_000, archive: 2 * 60_000 };
/** How much of a script's output is kept to say why it failed. */
export const SCRIPT_TAIL_CHARS = 1200;

export const SCRIPT_LABEL: Record<ScriptKind, string> = { setup: 'Setup script', archive: 'Archive script' };

/** Why `value` cannot be a script, or null when it can. */
export function scriptProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'A script is text.';
  if (value.length > MAX_SCRIPT_CHARS) return `A script can be at most ${MAX_SCRIPT_CHARS} characters. Put a longer one in a file and run that.`;
  return null;
}

const text = (value: unknown): string => (typeof value === 'string' && value.length <= MAX_SCRIPT_CHARS && value.trim() ? value : '');

export function sanitizeScripts(value: unknown): ProjectScripts {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return { setup: text(v.setup), archive: text(v.archive) };
}

export const hasScripts = (scripts: ProjectScripts): boolean => Boolean(scripts.setup || scripts.archive);

export function sanitizeScriptsByProject(value: unknown): ScriptsByProject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, ProjectScripts> = {};
  for (const [projectId, raw] of Object.entries(value)) {
    const scripts = sanitizeScripts(raw);
    if (projectId.length > 0 && projectId.length <= 200 && hasScripts(scripts)) out[projectId] = scripts;
  }
  return out;
}

/** `all` with the project's scripts replaced; a project left with none is dropped. */
export function withScripts(all: ScriptsByProject, projectId: string, scripts: ProjectScripts): ScriptsByProject {
  const { [projectId]: _old, ...rest } = all;
  return hasScripts(scripts) ? { ...rest, [projectId]: scripts } : rest;
}

/** How a script run ended. `tail` is the end of what it printed. */
export type ScriptOutcome =
  | { status: 'ok'; tail: string }
  | { status: 'failed'; code: number | null; tail: string }
  | { status: 'timed-out'; tail: string }
  | { status: 'stopped'; tail: string }
  | { status: 'not-run'; reason: string; tail: '' };

/** The end of `output`, from the start of a line where it can. */
export function tailOf(output: string, max = SCRIPT_TAIL_CHARS): string {
  const trimmed = output.trimEnd();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(-max);
  const line = cut.indexOf('\n');
  return line >= 0 && line < cut.length - 1 ? cut.slice(line + 1) : cut;
}

const minutes = (ms: number): string => `${Math.round(ms / 60_000)} minutes`;

/** Why the script did not succeed, in one sentence; null when it did. */
export function scriptFailure(kind: ScriptKind, outcome: ScriptOutcome): string | null {
  const label = `The project's ${SCRIPT_LABEL[kind].toLowerCase()}`;
  switch (outcome.status) {
    case 'ok':
      return null;
    case 'failed':
      return outcome.code === null ? `${label} was ended by a signal.` : `${label} failed (exit ${outcome.code}).`;
    case 'timed-out':
      return `${label} was still running after ${minutes(SCRIPT_TIMEOUT_MS[kind])} and was ended.`;
    case 'stopped':
      return `${label} was stopped.`;
    case 'not-run':
      return `${label} could not be run: ${outcome.reason}`;
  }
}

/**
 * What a session whose setup script did not succeed is told. Its agent has not started; a reply
 * runs the script again in the same worktree.
 */
export function setupFailureText(outcome: ScriptOutcome): string {
  return `${scriptFailure('setup', outcome)} The agent was not started. Reply to run the script again, or change it on the project's Settings tab under Scripts.`;
}
