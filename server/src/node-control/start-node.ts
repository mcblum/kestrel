// A worker node: Kestrel's server with no window, started through the same function as the app's (start-server.ts),
// and the control socket the terminal talks to. Nothing here ends the process: `run.ts` does, so tests start and
// stop a node in process.
import { homedir } from 'node:os';
import { computerName } from '../connect/link/start.ts';
import { hostPlatform } from '../host.ts';
import { hostSandboxSupport, type SandboxSupport } from '../agents/claude/sandbox-support.ts';
import { NODE_SANDBOX_MISSING } from '../shared/node-sandbox.ts';
import { startKestrel, type KestrelHandle, type StartOptions } from '../start-server.ts';
import type { Agent } from '../model.ts';
import { agentStatesOf, nodeStatusOf, type NodeProjects, type NodeStatus, type NodeStatusInputs } from '../shared/node-status.ts';
import { listenControl, type ControlSocket } from './control-socket.ts';
import { nodeSocketPath } from './socket-path.ts';
import { hostFacts, hostProbe, type HostProbe } from './host-facts.ts';
import { leaveAccount } from './uninstall-node.ts';
import { joinFlow } from './join-flow.ts';
import type { JoinRun } from './join-socket.ts';
import { existsSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { CLONES_FOLDER } from '../shared/project-clone.ts';
import { nodeGitFacts } from './git-node.ts';
import { applyNodeGitEnv, readNodeGitSettings } from './node-git-env.ts';
import { gitStatusOf } from '../shared/node-git-status.ts';
import { nodeGitPaths } from '../shared/node-git.ts';

export interface NodeOptions extends Pick<StartOptions, 'dataDir' | 'port' | 'env' | 'persistence' | 'adapters'> {
  /** What the `stop` command does once it has been answered. The entry stops and ends the process (run.ts); default: close the node. */
  onStop?: () => void;
  /** How `status` learns about the machine (host-facts.ts); default: this one. */
  probe?: HostProbe;
}

export interface NodeHandle {
  server: KestrelHandle;
  control: ControlSocket;
  /** The status as `kestrel node status` shows it. */
  status(): Promise<NodeStatus>;
  /** Stops the sessions' turns and the server (the timed shutdown), then closes the control socket. Once. */
  close(): Promise<void>;
}

/** What `status` tells of Kestrel Connect, from the module's real state: signed in, in the account, removed, connected. */
export function connectStatusOf(connect: Pick<KestrelHandle['connect'], 'view' | 'inAccount' | 'wasRemoved'>): NodeStatusInputs['connect'] {
  const view = connect.view();
  return { enabled: view.enabled, unavailable: view.unavailable, account: view.account, link: view.link, inAccount: connect.inAccount(), removed: connect.wasRemoved(), storage: view.storage };
}

/** The sandbox as a node tells it: what to run there, and the restart it needs (shared/node-sandbox.ts). */
export const nodeSandbox = (support: SandboxSupport): SandboxSupport => (support.available ? support : { available: false, reason: NODE_SANDBOX_MISSING });

/** What the running server knows that `status` tells (shared/node-status.ts). */
export async function nodeStatusInputs(server: KestrelHandle, probe: HostProbe): Promise<NodeStatusInputs> {
  const view = server.connect.view();
  return {
    version: server.version,
    kind: server.kind,
    platform: hostPlatform(),
    name: view.computerName || computerName(),
    connect: connectStatusOf(server.connect),
    agents: server.runtime.availableAgents(),
    availability: await server.runtime.agentAvailability(),
    sandbox: nodeSandbox(hostSandboxSupport()),
    git: gitStatusOf(readNodeGitSettings(server.dataDir), existsSync(nodeGitPaths(server.dataDir).key)),
    host: await hostFacts(probe),
    pid: process.pid,
    projects: await nodeProjects(server.workspace, server.dataDir),
  };
}

/** The node's projects for `status`: how many, how many are clones under its projects folder, and where that is. */
export async function nodeProjects(workspace: Pick<KestrelHandle['workspace'], 'state'>, dataDir: string): Promise<NodeProjects> {
  const root = join(dataDir, CLONES_FOLDER);
  const { projects } = await workspace.state();
  const real = realRoot(root);
  const inRoot = (path: string) => [root, real].some((r) => r !== null && path.startsWith(`${r}${sep}`));
  return { count: projects.length, cloned: projects.filter((p) => p.folders.some((f) => inRoot(f.path))).length, where: root };
}

/** The clones folder's real path (a link resolved), or null before it exists. */
function realRoot(root: string): string | null {
  try {
    return realpathSync(root);
  } catch {
    return null;
  }
}

export async function startNode(options: NodeOptions): Promise<NodeHandle> {
  let server: KestrelHandle | null = null;
  let closing: Promise<void> | null = null;
  const probe = options.probe ?? hostProbe(hostPlatform(), homedir(), options.dataDir);
  const status = async (): Promise<NodeStatus> => {
    if (!server) throw new Error('The node is still starting.');
    return nodeStatusOf(await nodeStatusInputs(server, probe));
  };
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      await server?.close();
      await control.close();
    })());
  const join: JoinRun = async (io, signal) => (server ? joinFlow(server.connect, io, signal) : { ok: false, text: 'The node is still starting. Try again in a moment.' });
  // The socket first: a node that cannot keep it private, or finds another running, stops before it starts anything.
  const uninstall = async () => (server ? leaveAccount(server) : { ok: false as const, reason: 'The node is still starting. Try again in a moment.' });
  const agents = async (recheck: readonly Agent[]) => {
    if (!server) throw new Error('The node is still starting. Try again in a moment.');
    return agentStatesOf(server.runtime.availableAgents(), await server.runtime.recheckAgents(recheck));
  };
  // `kestrel node git` changed what Kestrel's git runs with: read again into the node's environment (the one it was
  // started with; a test that gives none changes nothing), then say what only the node knows.
  const git = async () => {
    if (!server) throw new Error('The node is still starting. Try again in a moment.');
    if (options.env) applyNodeGitEnv(options.env, options.dataDir, server.kind);
    return nodeGitFacts(server, server.connect.view().computerName || computerName());
  };
  const control = await listenControl(nodeSocketPath(options.dataDir), { status, join, uninstall, agents, git, stop: () => (options.onStop ?? (() => void close()))() });
  try {
    // No UI origins, no launch file: nothing is a window. The protected store is the file only the user can read.
    server = await startKestrel({ kind: 'node', dataDir: options.dataDir, port: options.port, uiOrigins: [], vaultKey: null, ...(options.env ? { env: options.env } : {}), ...(options.persistence ? { persistence: options.persistence } : {}), ...(options.adapters ? { adapters: options.adapters } : {}) });
  } catch (error) {
    await control.close();
    throw error;
  }
  return { server, control, status, close };
}
