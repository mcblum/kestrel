// Runs one of a project's scripts (shared/project-scripts.ts) in a session's worktree: the user's
// login shell, as a terminal would run it (cmd.exe on Windows: host.ts), in a process group of its
// own so that stopping it or its time running out ends everything it started. It never throws: how it ended is the answer.
import { spawn } from 'node:child_process';
import { endTree, scriptShell } from '../host.ts';
import { SCRIPT_TIMEOUT_MS, tailOf, type ScriptKind, type ScriptOutcome } from '../shared/project-scripts.ts';
import { terminalEnv } from '../terminals.ts';

/** Output kept while it runs, to say why it failed: the tail only. */
const KEEP_CHARS = 16_000;
/** After it is asked to end, how long before it is killed outright. */
const KILL_AFTER_MS = 3000;

export interface ScriptRun {
  kind: ScriptKind;
  script: string;
  /** The session's worktree: where it runs. */
  cwd: string;
  /** What the script is told about where it is (`scriptEnv`). */
  vars: Record<string, string>;
  signal?: AbortSignal;
  onOutput?: (delta: string) => void;
  /** Tests pass a short one. */
  timeoutMs?: number;
  /** Kestrel's own environment; tests pass one. */
  env?: Record<string, string | undefined>;
}

/** What a script can read to find its way: the project's own checkout, its worktree and branch. */
export function scriptVars(where: { root: string; worktree: string; branch: string | null; projectName: string; sessionId: string }): Record<string, string> {
  return { KESTREL_ROOT_PATH: where.root, KESTREL_WORKTREE_PATH: where.worktree, KESTREL_BRANCH: where.branch ?? '', KESTREL_PROJECT_NAME: where.projectName, KESTREL_SESSION_ID: where.sessionId };
}

export type RunScript = (run: ScriptRun) => Promise<ScriptOutcome>;

export const runScript: RunScript = (run) =>
  new Promise((resolve) => {
    if (run.signal?.aborted) return resolve({ status: 'stopped', tail: '' });
    const base = run.env ?? process.env;
    const shell = scriptShell(base, run.script);
    let output = '';
    let ending: 'timed-out' | 'stopped' | null = null;
    let child: ReturnType<typeof spawn>;
    try {
      // Kestrel's own variables (its launch token among them) are taken out; the script's are added after.
      child = spawn(shell.file, shell.args, { cwd: run.cwd, env: { ...terminalEnv(base), ...run.vars }, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: shell.verbatim, windowsHide: true });
    } catch (error) {
      return resolve({ status: 'not-run', reason: error instanceof Error ? error.message : String(error), tail: '' });
    }
    const take = (chunk: Buffer): void => {
      const delta = chunk.toString('utf8');
      output = (output + delta).slice(-KEEP_CHARS);
      run.onOutput?.(delta);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid !== undefined) endTree(child.pid, signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM'); // the whole group: what the script started goes with it
    };
    let killer: NodeJS.Timeout | undefined;
    const end = (why: 'timed-out' | 'stopped'): void => {
      if (ending) return;
      ending = why;
      signalGroup('SIGTERM');
      killer = setTimeout(() => signalGroup('SIGKILL'), KILL_AFTER_MS);
    };
    const timer = setTimeout(() => end('timed-out'), run.timeoutMs ?? SCRIPT_TIMEOUT_MS[run.kind]);
    const onAbort = (): void => end('stopped');
    run.signal?.addEventListener('abort', onAbort, { once: true });

    let settled = false;
    const settle = (outcome: ScriptOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killer);
      run.signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    child.on('error', (error) => settle({ status: 'not-run', reason: error.message, tail: '' }));
    child.on('close', (code) => {
      const tail = tailOf(output);
      if (ending) return settle({ status: ending, tail });
      settle(code === 0 ? { status: 'ok', tail } : { status: 'failed', code, tail });
    });
  });
