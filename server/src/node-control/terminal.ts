// What `kestrel node <command>` and `kestrel upgrade` do in the terminal (shared/node-commands.ts). `start`, `logs`,
// `configure` and `upgrade` are the terminal's alone and work with no node running (`configure` asks a running node only
// `status`); `status`, `stop`,
// `agents` and `uninstall` begin here and ask the running node, over its socket, only what the node alone can answer;
// `join` and `git` are the node's.
// `agents` runs the agents' own programs here, where the person's keyboard and screen are, and asks the node only to
// look again and say what it now tells other devices (agents-terminal.ts).
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { hostPlatform } from '../host.ts';
import { offlineStatusLines } from '../shared/node-host.ts';
import { nodeInstallPaths } from '../shared/node-service.ts';
import type { AgentsArgs, CliCommand, GitArgs, LogOptions } from './args.ts';
import { gitFromTerminal } from './git-terminal.ts';
import { agentsFromTerminal, onPath } from './agents-terminal.ts';
import { nodeAgentsEnv } from '../agents/kestrel-agents.ts';
import { setupSummary } from '../shared/node-configure.ts';
import { missingSandboxPackages, sandboxInstallCommand } from '../shared/node-sandbox.ts';
import { overviewText } from './help.ts';
import { askNode, nodeAnswers, runClient, waitUntil } from './client.ts';
import { hostFacts, hostProbe, runForOutput, serviceState } from './host-facts.ts';
import { joinFromTerminal } from './join-terminal.ts';
import { setupFromTerminal } from './setup-terminal.ts';
import { upgradeFromTerminal } from './upgrade.ts';
import { nodeLogFile } from './log-file.ts';
import { logSourceOf, showLog } from './logs.ts';
import { startPlan, stopPlan, systemctl, unitAction } from './service.ts';
import { nodeSocketPath } from './socket-path.ts';
import { agentSignIns, isKestrelLink, nodeGitKey, removePath, sshPublicKeys, toolSignIns, uninstallFromTerminal } from './uninstall-terminal.ts';

export interface Terminal {
  home: string;
  dataDir: string;
}

const out = (line: string) => console.log(line);
const err = (line: string) => console.error(line);

/** What `status --json` prints when no node answers: the one fact there is. */
export const NOT_RUNNING_JSON = '{"running":false}';

/** `status --json`: the status value as the node built it (shared/node-status.ts), one line, for a script (install.sh). */
async function statusJson(path: string): Promise<number> {
  const reply = (await nodeAnswers(path)) ? await askNode(path, 'status').catch(() => null) : null;
  if (!reply?.ok || !reply.status) return out(NOT_RUNNING_JSON), 1;
  out(JSON.stringify({ running: true, ...reply.status }));
  return 0;
}

async function status(t: Terminal, json: boolean): Promise<number> {
  const path = nodeSocketPath(t.dataDir);
  if (json) return statusJson(path);
  if (await nodeAnswers(path)) return runClient(path, 'status', out, err);
  for (const line of offlineStatusLines(path, await hostFacts(hostProbe(hostPlatform(), t.home, t.dataDir)))) out(line);
  return 1;
}

async function start(t: Terminal): Promise<number> {
  const plan = startPlan(await serviceState({ platform: hostPlatform(), run: runForOutput }), await nodeAnswers(nodeSocketPath(t.dataDir)));
  if (plan.do === 'refuse') return err(plan.reason), 1;
  if (plan.do === 'nothing') return out(plan.text), 0;
  const done = await unitAction('start');
  (done.ok ? out : err)(done.line);
  return done.ok ? 0 : 1;
}

async function stop(t: Terminal): Promise<number> {
  const path = nodeSocketPath(t.dataDir);
  const plan = stopPlan(await serviceState({ platform: hostPlatform(), run: runForOutput }), await nodeAnswers(path));
  if (plan.do === 'nothing') return out(plan.text), 0;
  if (plan.do === 'socket') return runClient(path, 'stop', out, err);
  const done = await unitAction('stop');
  (done.ok ? out : err)(done.line);
  return done.ok ? 0 : 1;
}

async function logs(t: Terminal, options: LogOptions): Promise<number> {
  const logFile = nodeLogFile(t.dataDir);
  const source = logSourceOf({
    service: await serviceState({ platform: hostPlatform(), run: runForOutput }),
    journalctl: (await runForOutput('journalctl', ['--version'])) !== null,
    logFile,
    logFileExists: existsSync(logFile),
  });
  if (source.from === 'none') return err(source.reason), 1;
  return showLog(source, options);
}

/** One question at a time from the keyboard; null when the terminal closed. */
function asker(): { ask(prompt: string): Promise<string | null>; close(): void } {
  const lines = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
  let closed = false;
  lines.once('close', () => (closed = true));
  return {
    ask: (prompt) => (closed ? Promise.resolve(null) : new Promise((resolve) => (lines.once('close', () => resolve(null)), lines.question(prompt, resolve)))),
    close: () => lines.close(),
  };
}

async function uninstall(t: Terminal): Promise<number> {
  const path = nodeSocketPath(t.dataDir);
  const keyboard = asker();
  try {
    return await uninstallFromTerminal(
      {
        paths: nodeInstallPaths(t.home),
        dataDir: t.dataDir,
        askNode: (command) => askNode(path, command),
        service: () => serviceState({ platform: hostPlatform(), run: runForOutput }),
        systemctl,
        waitStopped: (ms) => waitUntil(path, false, ms),
        waitAnswers: (ms) => waitUntil(path, true, ms),
        remove: removePath,
        isLink: isKestrelLink,
        exists: existsSync,
        sshPublicKeys: () => sshPublicKeys(t.home),
        agentSignIns: () => agentSignIns(t.home, existsSync),
        gitKey: () => nodeGitKey(t.dataDir, existsSync),
        toolSignIns: () => toolSignIns(t.dataDir),
      },
      { ask: keyboard.ask, out, err },
    );
  } finally {
    keyboard.close();
  }
}

/** `kestrel` with no command: the commands, and one line of how the node is (shared/node-configure.ts). Exit 0. */
export async function overview(t: Terminal): Promise<number> {
  const path = nodeSocketPath(t.dataDir);
  const reply = (await nodeAnswers(path)) ? await askNode(path, 'status').catch(() => null) : null;
  const has = onPath(nodeAgentsEnv(process.env, t.dataDir));
  out(overviewText(setupSummary(reply?.ok && reply.status ? reply.status : null, { missing: missingSandboxPackages(has), install: sandboxInstallCommand(has) })));
  return 0;
}

/** Runs one command; resolves with the exit code. */
export function runCommand(t: Terminal, command: CliCommand, logOptions?: LogOptions, agents?: AgentsArgs, extra: { git?: GitArgs; json?: boolean; version?: string } = {}): Promise<number> {
  const path = nodeSocketPath(t.dataDir);
  switch (command) {
    case 'status':
      return status(t, extra.json === true);
    case 'git':
      return gitFromTerminal(t.home, t.dataDir, extra.git ?? { yes: false, manual: false });
    case 'start':
      return start(t);
    case 'stop':
      return stop(t);
    case 'logs':
      return logs(t, logOptions ?? { follow: false, lines: 200 });
    case 'uninstall':
      return uninstall(t);
    case 'join':
      return joinFromTerminal(path);
    case 'agents':
      return agentsFromTerminal(t.home, t.dataDir, agents ?? { only: null, yes: false, check: false });
    case 'configure':
      return setupFromTerminal(t.home, t.dataDir);
    case 'upgrade':
      return upgradeFromTerminal(t.home, extra.version);
    default:
      return runClient(path, command, out, err);
  }
}
