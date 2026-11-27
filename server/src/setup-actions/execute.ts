// What each kind of set-up step does to this computer (docs/designs/onboarding.md, 18.2). One function
// per kind, chosen by the action's kind; each checks its input as if another machine's record could be
// hostile (18.8): paths must stay inside this home folder, an origin may not start with `-`, a command
// is an argument list. A step that Kestrel cannot finish says why; nothing here asks for a password.
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { Platform } from '../shared/platform.ts';
import type { SetupAction } from '../shared/setup-list.ts';
import type { InstallHost } from '../shared/setup-install.ts';
import type { CommandRunner, SetupFs } from './io.ts';
import type { StepContext, StepResult } from './steps.ts';
import { agentInstallStep, installStep, openStep } from './install-steps.ts';
import { knowledgeStep } from './knowledge-step.ts';
import { modelsStep, type ModelsTarget } from './models-step.ts';
import { cloneStep, gitIdentityStep, hostSignInStep, sshHostsStep, sshKeyStep } from './git-steps.ts';

/** What the steps reach on this computer; tests give a temporary home folder and a fake runner. */
export interface ExecuteDeps {
  home: string;
  platform: Platform;
  run: CommandRunner;
  fs: SetupFs;
  host(): InstallHost;
  /** Kestrel's data folder, where a replaced file is kept for Undo. */
  dataDir: string;
  /** Adds a cloned folder to Kestrel (a new project of that name, or a folder of it). Answers how to take it back. */
  addProject?(name: string, path: string): Promise<{ said: string; undo(): Promise<void> }>;
  /** Kestrel's own MCP servers (18.2). */
  mcp?: McpTarget;
  /** Settings → Workflow → Knowledge base, through its own functions (18.15). */
  knowledge?: KnowledgeTarget;
  /** Settings → Models & roles, through its own store (onboarding.md 19). */
  models?: ModelsTarget;
}

export interface KnowledgeTarget {
  /** The knowledge base in use here: its project's id and name; null when none. */
  current(): Promise<{ projectId: string; name: string } | null>;
  /** The registered project here whose repository this is; null when none is. */
  projectOf(repo: string): Promise<{ projectId: string; name: string } | null>;
  /** The same call the Settings control makes; refused with the reason when the project is not a knowledge base. */
  use(projectId: string | null): Promise<void>;
}

export interface McpTarget {
  /** Adds a definition; answers how to take it back. Refused when one of that name is there. */
  add(server: Extract<SetupAction, { kind: 'mcp' }>['server'], home: string): Promise<{ said: string; undo(): Promise<void> }>;
}

/** The time limits of 18.5. */
export const LIMIT = { install: 10 * 60_000, clone: 30 * 60_000, other: 2 * 60_000, signIn: 10 * 60_000 } as const;

/** `~/x` under this home; null when it would leave the home folder (`~/../x`, an absolute path elsewhere). */
export function homePathHere(path: string, home: string): string | null {
  const raw = path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : isAbsolute(path) ? path : null;
  if (raw === null) return null;
  const full = normalize(raw);
  const rel = relative(home, full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) return null;
  return full;
}

/** The same check after following links, so a link cannot carry a write out of the home folder. */
export function realHomePath(path: string, deps: Pick<ExecuteDeps, 'home' | 'fs'>): string | null {
  const full = homePathHere(path, deps.home);
  if (!full) return null;
  const real = deps.fs.real(full);
  const home = deps.fs.real(deps.home);
  const rel = relative(home, real);
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? null : full;
}

export const failed = (reason: string, output = ''): StepResult => ({ state: 'failed', reason, output });

/** Runs an argument list for a step, its output going to the line; the outcome as a result or null when it ended well. */
export async function runFor(deps: ExecuteDeps, ctx: StepContext, argv: readonly string[], timeoutMs: number, extra: { cwd?: string; stdin?: string; env?: Record<string, string> } = {}): Promise<StepResult | null> {
  let output = '';
  const outcome = await deps.run(argv, { cwd: extra.cwd ?? deps.home, timeoutMs, ...(extra.stdin !== undefined ? { stdin: extra.stdin } : {}), ...(extra.env ? { env: extra.env } : {}), output: (text) => ((output += text), ctx.output(text)) });
  if (outcome.problem) return failed(outcome.problem, output);
  if (outcome.code !== 0) return failed(`${argv[0]} ended with code ${outcome.code}.`, output);
  return null;
}

/** Runs an argument list quietly and answers what it printed: for questions a step asks (`git config --get`). */
export async function capture(deps: ExecuteDeps, argv: readonly string[], cwd?: string, env?: Record<string, string>): Promise<{ code: number | null; text: string }> {
  let text = '';
  const outcome = await deps.run(argv, { cwd: cwd ?? deps.home, timeoutMs: LIMIT.other, ...(env ? { env } : {}), output: (t) => (text += t) });
  return { code: outcome.problem ? null : outcome.code, text: text.trim() };
}

/** Carries out one step. The one function the page's Run and an agent's approved `setup_run_step` both reach. */
export function executor(deps: ExecuteDeps) {
  return async (action: SetupAction, ctx: StepContext): Promise<StepResult> => {
    switch (action.kind) {
      case 'git-identity':
        return gitIdentityStep(deps, ctx, action);
      case 'ssh-hosts':
        return sshHostsStep(deps, ctx, action);
      case 'ssh-key':
        return sshKeyStep(deps, ctx, action);
      case 'host-sign-in':
        return hostSignInStep(deps, ctx, action);
      case 'clone':
        return cloneStep(deps, ctx, action);
      case 'install':
        return ctx.line.run === 'open' ? openStep(deps, ctx) : installStep(deps, ctx, action);
      case 'agent-install':
        return agentInstallStep(deps, ctx, action);
      case 'sign-in':
        return failed('Use the Sign in button on the line: the agent signs in in your browser.');
      case 'mcp':
        if (!deps.mcp) return failed('This copy of Kestrel cannot add MCP servers from here.');
        try {
          const added = await deps.mcp.add(action.server, deps.home);
          return { state: 'done', said: added.said, undo: added.undo };
        } catch (error) {
          return failed(error instanceof Error ? error.message : String(error));
        }
      case 'files':
        return (await import('./file-steps.ts')).filesStep(deps, ctx, action);
      case 'knowledge':
        return knowledgeStep(deps, ctx, action);
      case 'models':
        return modelsStep(deps, ctx, action);
    }
  };
}
