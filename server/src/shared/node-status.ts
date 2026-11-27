// What `kestrel node status` answers (docs/designs/worker-nodes.md, sections 3 and 4): a typed value built by
// one pure function from what the running server already knows, and a second that words it for a terminal.
// What it says about the machine (the service, lingering, free disk, the installed bundle) is worded in node-host.ts.
import type { Agent } from '../model.ts';
import { NODE_AGENT_LABEL, type NodeAgentProblem } from './node-agents.ts';
import type { ConnectAccount, ConnectLink, ConnectStorage } from './connect.ts';
import { KIND_NAME, type KestrelKind } from './host-kind.ts';
import { whyHere, type NodeAgentState } from './node-commands.ts';
import { gitStatusLines, type NodeGitStatus } from './node-git-status.ts';
import { hostLines, type HostFacts } from './node-host.ts';
import { PLATFORM_NAME, type Platform } from './platform.ts';
import { NO_KEYSTORE_NOTE } from './protected-files.ts';

/** What the server knows, handed over as plain values. */
export interface NodeStatusInputs {
  version: string;
  kind: KestrelKind;
  platform: Platform;
  /** This computer's name as other devices see it. */
  name: string;
  connect: {
    /** Settings → Connections → Kestrel Connect. */
    enabled: boolean;
    /** Why Connect cannot be used at all in this copy (sample data), or null. */
    unavailable: string | null;
    account: ConnectAccount;
    link: ConnectLink;
    /** This computer was let in, by the keyring it holds or last accepted, and not removed since. */
    inAccount: boolean;
    /** Another device removed this computer from the account, and it has not joined again. */
    removed: boolean;
    storage: ConnectStorage;
  };
  /** Every agent Kestrel has an adapter for, and what `agentAvailability` said. */
  agents: readonly Agent[];
  availability: { available: readonly Agent[]; notes: Readonly<Partial<Record<Agent, string>>>; problems?: Readonly<Partial<Record<Agent, NodeAgentProblem>>> };
  sandbox: { available: true } | { available: false; reason: string };
  /** What `kestrel node git` made and found (shared/node-git-status.ts). */
  git: NodeGitStatus;
  /** The machine: the service, lingering, free disk, the installed bundle (node-control/host-facts.ts). */
  host: HostFacts;
  /** The running node's process id, to tell whether systemd started it. */
  pid: number;
  /** The node's projects: how many, how many it cloned, and where clones are kept (worker-nodes.md section 9). */
  projects?: NodeProjects;
}

export interface NodeProjects {
  count: number;
  cloned: number;
  /** Where the projects it clones are kept (`~/.kestrel/projects`). */
  where: string;
}

/** The projects line of `status`. Pure. */
export function projectsLine(p: NodeProjects): string {
  const count = `${p.count} project${p.count === 1 ? '' : 's'}`;
  return `Projects: ${count}${p.cloned > 0 ? `, ${p.cloned} cloned here` : ''}. Projects of your account it does not have are cloned into ${p.where} when a session starts in one.`;
}

export interface NodeStatus {
  version: string;
  kind: KestrelKind;
  platform: Platform;
  name: string;
  connect: {
    signedIn: boolean;
    email: string | null;
    inAccount: boolean;
    /** Removed from the account by another device: it dials nothing until it joins again. */
    removed: boolean;
    /** Connected to the relay now. */
    connected: boolean;
    /** Why not, or null when connected. */
    notConnected: string | null;
  };
  agents: NodeAgentState[];
  sandbox: { available: boolean; why: string | null };
  git: NodeGitStatus;
  secrets: { storage: ConnectStorage; where: string };
  host: HostFacts;
  pid: number;
  projects?: NodeProjects;
}

const KEYSTORE_WHERE = "Secrets are kept in the system's keystore.";

/** What a node removed from the account is told, in `status` and wherever it is not connected. */
export const REMOVED_NODE = 'This node was removed from your account. Run "kestrel node join" to join it again.';
const JOIN_HINT = 'Run "kestrel node join" to sign in and join your account.';

/** Why this computer is not talking to the relay, or null when it is. */
function notConnectedBecause(i: NodeStatusInputs['connect']): string | null {
  if (i.link.state === 'connected') return null;
  if (i.unavailable) return i.unavailable;
  if (i.removed) return REMOVED_NODE;
  if (!i.enabled) return 'Kestrel Connect is switched off.';
  if (i.account.state !== 'signed-in') return i.account.state === 'signing-in' ? 'Waiting for the sign-in to finish.' : `Not signed in to Kestrel Connect. ${JOIN_HINT}`;
  if (i.link.state === 'offline') return i.link.reason;
  if (i.link.state === 'connecting') return 'Connecting to the relay.';
  return 'Not connected to the relay.';
}

/** Each agent as the node tells it: whether it can run, and why not (in the node's words, runtime/agent-trouble.ts). Pure. */
export function agentStatesOf(agents: readonly Agent[], availability: NodeStatusInputs['availability']): NodeAgentState[] {
  return agents.map((agent) => {
    const canRun = availability.available.includes(agent);
    return { agent, canRun, why: canRun ? null : (availability.notes[agent] ?? 'Not available.'), problem: canRun ? null : (availability.problems?.[agent] ?? null) };
  });
}

/** Pure: the status as a value. */
export function nodeStatusOf(i: NodeStatusInputs): NodeStatus {
  return {
    version: i.version,
    kind: i.kind,
    platform: i.platform,
    name: i.name,
    connect: {
      signedIn: i.connect.account.state === 'signed-in',
      email: i.connect.account.state === 'signed-in' ? i.connect.account.email : null,
      inAccount: i.connect.inAccount && !i.connect.removed,
      removed: i.connect.removed,
      connected: i.connect.link.state === 'connected',
      notConnected: notConnectedBecause(i.connect),
    },
    agents: agentStatesOf(i.agents, i.availability),
    sandbox: i.sandbox.available ? { available: true, why: null } : { available: false, why: i.sandbox.reason },
    git: i.git,
    secrets: { storage: i.connect.storage, where: i.connect.storage === 'file' ? NO_KEYSTORE_NOTE : KEYSTORE_WHERE },
    host: i.host,
    pid: i.pid,
    ...(i.projects ? { projects: i.projects } : {}),
  };
}

/** Pure: the status as lines for a terminal. */
export function statusLines(s: NodeStatus): string[] {
  const lines = [
    `${s.name}: ${KIND_NAME[s.kind]}, Kestrel ${s.version || 'unknown version'} on ${PLATFORM_NAME[s.platform]}`,
    `Signed in to Kestrel Connect: ${s.connect.signedIn ? `yes (${s.connect.email})` : 'no'}`,
    `In the account: ${s.connect.removed ? `no. ${REMOVED_NODE}` : s.connect.inAccount ? 'yes' : s.connect.signedIn ? `no. ${JOIN_HINT}` : 'no'}`,
    `Connected to the relay: ${s.connect.connected ? 'yes' : `no. ${s.connect.notConnected ?? ''}`.trim()}`,
    'Agents:',
    ...s.agents.map((a) => `  ${NODE_AGENT_LABEL[a.agent]}: ${a.canRun ? 'can run' : `cannot run. ${whyHere(a)}`}`),
    `Command sandbox: ${s.sandbox.available ? 'available' : `not available. ${s.sandbox.why ?? ''}`.trim()}`,
    ...gitStatusLines(s.git),
    ...(s.projects ? [projectsLine(s.projects)] : []),
    s.secrets.where,
    ...hostLines(s.host, s.pid, s.version || null),
  ];
  return lines;
}
