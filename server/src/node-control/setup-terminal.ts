// `kestrel node configure` in a real terminal: the flow (setup-flow.ts) drawn as `join` is, its questions read from the
// keyboard, each step the very command it names (join-terminal.ts, agents-terminal.ts, git-terminal.ts) drawn under its
// section, and the running node asked only `status`. What needs an administrator runs through sudo on this terminal,
// only after the person's yes: `sudo -v` first, with sudo's own prompt, then each command with its output collected.
// With input or output not a terminal (the install piped from curl with no terminal to open), nothing is asked or
// run: what is left is listed with each command.
import { spawn } from 'node:child_process';
import { nodeAgentsEnv } from '../agents/kestrel-agents.ts';
import { hostPlatform } from '../host.ts';
import type { AdminRunner } from '../shared/node-configure.ts';
import { serviceLine } from '../shared/node-host.ts';
import { missingSandboxPackages, sandboxInstallCommand } from '../shared/node-sandbox.ts';
import { agentsFromTerminal, onPath, terminalIo } from './agents-terminal.ts';
import { askNode, nodeAnswers, waitUntil } from './client.ts';
import { gitFromTerminal } from './git-terminal.ts';
import { runForOutput, serviceState } from './host-facts.ts';
import { joinFromTerminal } from './join-terminal.ts';
import { unitAction } from './service.ts';
import { runSetup, type AdminRun, type SetupDeps, type SetupIo } from './setup-flow.ts';
import { computerName } from '../connect/link/start.ts';
import { nodeCommandLine } from '../shared/node-commands.ts';
import type { NodeStatus } from '../shared/node-status.ts';
import type { ChecklistIo } from './agents-checklist.ts';
import { STOPPED_EXIT } from './join-client.ts';
import { configureOutcomes, configureSteps } from './worker-onboarding/configure-frame.ts';
import type { WorkerDetail } from './worker-onboarding/model.ts';
import { onScreen, openWorkerSession } from './worker-onboarding/open.ts';
import type { WorkerSession } from './worker-onboarding/session.ts';
import { nodeSocketPath } from './socket-path.ts';

/** How long one administrator's command may take (a package install on a slow mirror). */
const ADMIN_TIMEOUT_MS = 15 * 60_000;
/** How many of its last lines are shown when it fails. */
const ADMIN_LAST_LINES = 8;

/** Who can run an administrator's command here. */
export function adminRunnerHere(uid: number | undefined, has: (program: string) => boolean): AdminRunner {
  if (uid === 0) return 'root';
  return has('sudo') ? 'sudo' : 'none';
}

/** sudo's own check, with the terminal: it asks for the password itself, as it always does. */
function sudoValidate(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('sudo', ['-v'], { stdio: 'inherit' });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

/**
 * One command, the keyboard still the terminal's (sudo reads its password from the terminal itself), what it prints
 * collected and its last lines given when it fails.
 */
function runAdmin(argv: readonly string[]): Promise<AdminRun> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (result: AdminRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const lastLines = () => output.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-ADMIN_LAST_LINES);
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['inherit', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const keep = (text: string) => (output = (output + text).slice(-8000));
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => (child.kill('SIGTERM'), finish({ ok: false, reason: `it did not finish in ${ADMIN_TIMEOUT_MS / 60_000} minutes.`, output: lastLines() })), ADMIN_TIMEOUT_MS);
    child.once('error', (error) => finish({ ok: false, reason: `${error.message}.`, output: [] }));
    child.once('close', (code, signal) => finish(code === 0 ? { ok: true, reason: '', output: [] } : { ok: false, reason: code === null ? `it was stopped (${signal}).` : `it ended with exit code ${code}.`, output: lastLines() }));
  });
}

const STOPPED_TEXT = `Stopped. "${nodeCommandLine('configure')}" picks up where you left off.`;
const SUDO_NOTICE = 'sudo has this terminal now. It asks for your password itself if it needs it; Kestrel never reads it.';

export async function setupFromTerminal(home: string, dataDir: string): Promise<number> {
  const path = nodeSocketPath(dataDir);
  const has = onPath(nodeAgentsEnv(process.env, dataDir));
  const hasHere = onPath(process.env);
  const service = () => serviceState({ platform: hostPlatform(), run: runForOutput });
  const sandboxHere = () => ({ missing: missingSandboxPackages(has), install: sandboxInstallCommand(has) });
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  // The node's last status: the screen's progress line and closing outcomes are drawn from it.
  let latest: NodeStatus | null = null;
  // One screen for the whole run; the account, agents and git steps are drawn on it under their sections.
  const screen = interactive
    ? await openWorkerSession({ name: 'Worker setup', node: computerName(), steps: (current, finished) => configureSteps(latest, sandboxHere(), current, finished), stoppedText: STOPPED_TEXT })
    : null;
  const io: SetupIo & Pick<ChecklistIo, 'ran'> = screen?.io() ?? terminalIo();
  const ran = () => io.ran();
  const handoff = <T,>(notice: string, run: () => Promise<T>): Promise<T> => (screen ? screen.handoff(notice, run) : run());
  const deps: SetupDeps = {
    status: async () => {
      if (!(await nodeAnswers(path))) return null;
      const reply = await askNode(path, 'status').catch(() => null);
      if (!reply?.ok || !reply.status) return null;
      latest = reply.status;
      screen?.setNode(reply.status.name);
      return reply.status;
    },
    sandboxHere,
    waitForNode: (ms) => waitUntil(path, true, ms),
    notRunning: async () => serviceLine(await service(), null),
    run: async (command, section) => {
      const nested = { io: screen ? screen.io(section) : terminalIo(section), screen };
      const code =
        command === 'join'
          ? await joinFromTerminal(path, { next: false, section, screen })
          : command === 'agents'
            ? await agentsFromTerminal(home, dataDir, { only: null, yes: false, check: false }, nested, false)
            : await gitFromTerminal(home, dataDir, { yes: false, manual: false }, nested);
      // The command printed on its own: what setup says next starts a new block.
      ran();
      return code;
    },
    restart: async () => {
      const now = await service();
      if (now.manager !== 'systemd' || !now.installed) return { ok: false, line: 'This node was started by hand, so setup cannot restart it. Stop it ("kestrel node stop") and start it again ("kestrel node run").' };
      return unitAction('restart');
    },
    adminRunner: () => adminRunnerHere(process.getuid?.(), hasHere),
    // sudo reads the password from the terminal itself: the screen lets go of it first, for the check and each command.
    sudoValidate: async () => {
      const ok = await handoff(SUDO_NOTICE, sudoValidate);
      ran();
      return ok;
    },
    runAdmin: async (argv) => {
      const done = await handoff(`Running ${argv.join(' ')}`, () => runAdmin(argv));
      ran();
      return done;
    },
  };
  return onScreen(screen, async () => {
    const code = await runSetup(deps, io, { interactive });
    if (screen) await conclude(screen, code, deps, latest === null ? null : () => configureOutcomes(latest!, sandboxHere(), deps.adminRunner()));
    return code;
  });
}

/** The screen at the end: the outcomes from the node's status read once more, or, stopped, let go and said plainly. */
async function conclude(screen: WorkerSession, code: number, deps: SetupDeps, outcomes: (() => WorkerDetail[]) | null): Promise<void> {
  if (screen.stopped || code === STOPPED_EXIT) {
    await screen.close();
    if (screen.ended) process.stderr.write(`${screen.ended.text}\n`);
    return;
  }
  if (!outcomes) return screen.finish();
  await deps.status();
  await screen.finish(outcomes());
}
