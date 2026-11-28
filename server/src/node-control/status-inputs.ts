// What `kestrel node status` is made from, read from the running server (shared/node-status.ts). Apart from
// start-node.ts so the server's own start (start-server.ts) can read it too, for the facts a node publishes for its
// page on other screens (node-settings/service.ts), without importing the node's entry.
import { existsSync } from 'node:fs';
import { hostSandboxSupport, type SandboxSupport } from '../agents/claude/sandbox-support.ts';
import { computerName } from '../connect/link/start.ts';
import type { KestrelConnect } from '../connect/link/connect.ts';
import { hostPlatform } from '../host.ts';
import type { SessionRuntime } from '../runtime.ts';
import type { KestrelKind } from '../shared/host-kind.ts';
import { gitStatusOf } from '../shared/node-git-status.ts';
import { nodeGitPaths } from '../shared/node-git.ts';
import { NODE_SANDBOX_MISSING } from '../shared/node-sandbox.ts';
import type { NodeStatusInputs } from '../shared/node-status.ts';
import { hostFacts, type HostProbe } from './host-facts.ts';
import { readNodeGitSettings } from './node-git-env.ts';

/** What of the running server `status` reads. */
export interface NodeStatusParts {
  version: string;
  kind: KestrelKind;
  dataDir: string;
  runtime: Pick<SessionRuntime, 'availableAgents' | 'agentAvailability' | 'nodeProjects' | 'nodeUpdate'>;
  connect: Pick<KestrelConnect, 'view' | 'inAccount' | 'wasRemoved'>;
}

/** What `status` tells of Kestrel Connect, from the module's real state: signed in, in the account, removed, connected. */
export function connectStatusOf(connect: NodeStatusParts['connect']): NodeStatusInputs['connect'] {
  const view = connect.view();
  return { enabled: view.enabled, unavailable: view.unavailable, account: view.account, link: view.link, inAccount: connect.inAccount(), removed: connect.wasRemoved(), storage: view.storage };
}

/** The sandbox as a node tells it: what to run there, and the restart it needs (shared/node-sandbox.ts). */
export const nodeSandbox = (support: SandboxSupport): SandboxSupport => (support.available ? support : { available: false, reason: NODE_SANDBOX_MISSING });

/** What the running server knows that `status` tells (shared/node-status.ts). */
export async function nodeStatusInputs(server: NodeStatusParts, probe: HostProbe): Promise<NodeStatusInputs> {
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
    projects: (await server.runtime.nodeProjects?.status()) ?? undefined,
    ...((updater) => (updater ? { update: { note: updater.note(), line: updater.line() } } : {}))(server.runtime.nodeUpdate),
  };
}
