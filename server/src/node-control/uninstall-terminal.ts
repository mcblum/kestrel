// `kestrel-node uninstall` in the terminal. It asks first; asks the running node for its part (refuse while work
// is not pushed, else leave the account: uninstall-node.ts), starting the service for that when it is installed and
// stopped; then stops the node, deletes the unit, the bundles, the link, the agents' programs and the gh and glab it installed, asks separately before deleting the data
// folder, and says what is left on purpose. Every effect is passed in, so the whole flow is tested in a folder.
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeCommand, NodeReply } from '../shared/node-commands.ts';
import { NODE_UNIT_NAME, type NodeInstallPaths, type ServiceState } from '../shared/node-service.ts';
import { agreed, confirmDataPrompt, confirmUninstallPrompt, farewellLines, type AgentSignIn, type FarewellGitKey } from '../shared/node-uninstall.ts';
import { nodeGitPaths } from '../shared/node-git.ts';
import { hostsWithKey, toolSignIns as toolSignInsOf } from '../shared/node-git-status.ts';
import { readNodeGitSettings } from './node-git-env.ts';
import { agentsFolder, toolsFolder } from '../agents/kestrel-agents.ts';
import type { Systemctl } from './service.ts';

export interface UninstallIo {
  ask(prompt: string): Promise<string | null>;
  out(line: string): void;
  err(line: string): void;
}

export interface UninstallDeps {
  paths: NodeInstallPaths;
  dataDir: string;
  /** Asks the running node; rejects when none answers. */
  askNode(command: NodeCommand): Promise<NodeReply>;
  service(): Promise<ServiceState>;
  systemctl: Systemctl;
  /** Resolves true once nothing answers at the socket any more, false when `ms` passed first. */
  waitStopped(ms: number): Promise<boolean>;
  /** Resolves true once a node answers, false when `ms` passed first. */
  waitAnswers(ms: number): Promise<boolean>;
  remove(path: string): void;
  isLink(path: string): boolean;
  exists(path: string): boolean;
  sshPublicKeys(): string[];
  agentSignIns(): AgentSignIn[];
  /** The node's git key, read before it is deleted (`kestrel-node git`); null when it has none. */
  gitKey(): FarewellGitKey | null;
  /** gh's and glab's sign-ins, as `kestrel-node git` last found them, read before the data folder may be deleted. */
  toolSignIns(): AgentSignIn[];
}

const START_WAIT_MS = 60_000;
const STOP_WAIT_MS = 30_000;

export const NOT_RUNNING = 'The node is not running, so it cannot check its sessions for work that is not pushed, or leave your account. Start it ("kestrel-node start", or "kestrel-node run" in another terminal) and run "kestrel-node uninstall" again. Nothing was changed.';

/** Reaches a running node, starting the installed service when nothing answers. False when none can be reached. */
async function reachNode(deps: UninstallDeps, io: UninstallIo): Promise<boolean> {
  if (await deps.waitAnswers(0)) return true;
  const service = await deps.service();
  if (service.manager !== 'systemd' || !service.installed) return false;
  if (!service.active) {
    io.out(`Starting ${NODE_UNIT_NAME} so the node can check its sessions and leave your account…`);
    if (!(await deps.systemctl(['start', NODE_UNIT_NAME])).ok) return false;
  }
  return deps.waitAnswers(START_WAIT_MS);
}

async function stopNode(deps: UninstallDeps, io: UninstallIo): Promise<void> {
  const service = await deps.service();
  if (service.manager === 'systemd' && service.installed) {
    const done = await deps.systemctl(['disable', '--now', NODE_UNIT_NAME]);
    if (!done.ok) io.err(`systemctl --user disable --now ${NODE_UNIT_NAME} failed: ${done.error}`);
  }
  // A node started by hand (or one systemd did not stop) is asked over its socket.
  if (await deps.waitAnswers(0)) {
    await deps.askNode('stop').catch(() => undefined);
    if (!(await deps.waitStopped(STOP_WAIT_MS))) io.err('The node did not stop in time; its files are deleted anyway.');
  }
}

async function deleteInstall(deps: UninstallDeps, managedBySystemd: boolean): Promise<string[]> {
  const done: string[] = [];
  deps.remove(deps.paths.unit);
  if (managedBySystemd) await deps.systemctl(['daemon-reload']);
  done.push(`Deleted the service (${deps.paths.unit}).`);
  if (deps.isLink(deps.paths.link)) {
    deps.remove(deps.paths.link);
    done.push(`Deleted the link ${deps.paths.link}.`);
  }
  deps.remove(deps.paths.bundles);
  done.push(`Deleted the node's program (${deps.paths.bundles}).`);
  // The agents `kestrel-node agents` installed are programs in Kestrel's folder; their sign-ins are each agent's own,
  // in the home folder, and are left alone (the farewell names them).
  const tools = toolsFolder(deps.dataDir);
  if (deps.exists(tools)) {
    deps.remove(tools);
    done.push(`Deleted gh and glab as Kestrel installed them (${tools}). Their sign-ins in your home folder are left as they are.`);
  }
  const agents = agentsFolder(deps.dataDir);
  if (deps.exists(agents)) {
    deps.remove(agents);
    done.push(`Deleted the agents' programs Kestrel installed (${agents}). Their sign-ins and settings in your home folder are left as they are.`);
  }
  // The node's git key is the node's alone: it goes with the node even when the data folder is kept.
  const git = nodeGitPaths(deps.dataDir);
  if (deps.exists(git.key) || deps.exists(git.publicKey)) {
    deps.remove(git.key);
    deps.remove(git.publicKey);
    done.push(`Deleted this node's git key (${git.key}).`);
  }
  return done;
}

/** Resolves with the exit code. */
export async function uninstallFromTerminal(deps: UninstallDeps, io: UninstallIo): Promise<number> {
  if (!agreed(await io.ask(confirmUninstallPrompt('this worker node')))) {
    io.out('Nothing was changed.');
    return 1;
  }
  if (!(await reachNode(deps, io))) {
    io.err(NOT_RUNNING);
    return 1;
  }
  const answer = await deps.askNode('uninstall').catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }));
  if (!answer.ok) {
    io.err(answer.reason);
    return 1;
  }
  if (answer.message) io.out(answer.message);
  const service = await deps.service();
  const gitKey = deps.gitKey();
  const tools = deps.toolSignIns();
  await stopNode(deps, io);
  for (const line of await deleteInstall(deps, service.manager === 'systemd')) io.out(line);
  const deleteData = agreed(await io.ask(confirmDataPrompt(deps.dataDir)));
  if (deleteData) {
    deps.remove(deps.dataDir);
    io.out(`Deleted ${deps.dataDir}.`);
  }
  for (const line of farewellLines({ sshPublicKeys: deps.sshPublicKeys(), agents: deps.agentSignIns(), tools, gitKey, keptData: deleteData ? null : deps.dataDir })) io.out(line);
  return 0;
}

/** The public halves of the user's SSH keys, by path. Names only; no key is read. */
export function sshPublicKeys(home: string): string[] {
  const dir = join(home, '.ssh');
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.pub'))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** Each agent signed in on this machine, by whether the folder its sign-in lives in is there (never opened). */
export function agentSignIns(home: string, exists: (path: string) => boolean): AgentSignIn[] {
  const known: AgentSignIn[] = [
    { label: 'Claude Code', where: join(home, '.claude'), signOut: 'claude auth logout' },
    { label: 'Codex', where: join(home, '.codex'), signOut: 'codex logout' },
    { label: 'OpenCode', where: join(home, '.local', 'share', 'opencode'), signOut: 'opencode auth logout' },
  ];
  return known.filter((agent) => exists(agent.where));
}

/** The node's git key as `kestrel-node git` kept it: its fingerprint and the hosts it reached. Never opens the key. */
export function nodeGitKey(dataDir: string, exists: (path: string) => boolean): FarewellGitKey | null {
  const settings = readNodeGitSettings(dataDir);
  if (!settings.key || !exists(nodeGitPaths(dataDir).publicKey)) return null;
  return { fingerprint: settings.key.fingerprint, hosts: hostsWithKey(settings) };
}

/** gh's and glab's sign-ins `kestrel-node git` found, with their sign-out commands; no file of theirs is opened. */
export const toolSignIns = (dataDir: string): AgentSignIn[] => toolSignInsOf(readNodeGitSettings(dataDir));

export const removePath = (path: string): void => rmSync(path, { recursive: true, force: true });

export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
