// What `kestrel node configure` offers, in order, purely, from what the node reports (`status`) and what the terminal sees of
// the sandbox programs (docs/designs/worker-nodes.md, section 8). Nothing is remembered between runs: a step is done
// when the node says so, so running it again picks up where it was left. The runner is node-control/setup-flow.ts.
import { NODE_AGENT_LABEL } from './node-agents.ts';
import type { NodeStatus } from './node-status.ts';
import { REMOVED_NODE } from './node-status.ts';
import { enableLingerCommand, WITHOUT_LINGERING } from './node-service.ts';
import { SANDBOX_INSTALL_UNKNOWN, SANDBOX_RESTART, WITHOUT_SANDBOX } from './node-sandbox.ts';
import { nodeCommandLine } from './node-commands.ts';

/** The steps, in the order they are offered: what can be done here first, then what needs an administrator. */
export const SETUP_STEPS = ['join', 'agents', 'git', 'lingering', 'sandbox'] as const;
export type SetupStepId = (typeof SETUP_STEPS)[number];

/** The kestrel commands a step runs in this terminal. */
export type SetupCommand = 'join' | 'agents' | 'git';

/** What the terminal itself sees of the sandbox's programs (the node worked out its own answer when it started). */
export interface SandboxHere {
  /** The packages not on PATH, by name. */
  missing: string[];
  /** The command that installs them on this distribution, or null when no package manager on the list is here. */
  install: string | null;
}

export type SetupAction =
  /** A `kestrel` command, run here. */
  | { kind: 'run'; command: SetupCommand }
  /** Only an administrator can do it: shown to paste, never run (null: no package manager on the list is here). */
  | { kind: 'admin'; command: string | null }
  /** The node must restart to take it up, which the person may let setup do. */
  | { kind: 'restart' };

export interface SetupStep {
  id: SetupStepId;
  /** Its number in the list, 1 to 5, whether or not it is left. */
  number: number;
  title: string;
  done: boolean;
  /** One line: how it is when done, what is left when not. */
  left: string;
  /** What to do; null when done. */
  action: SetupAction | null;
}

const TITLES: Record<SetupStepId, string> = {
  join: 'Join your account',
  agents: 'Agents',
  git: 'Git',
  lingering: 'Keep running with nobody logged in',
  sandbox: 'Command sandbox',
};

/** The command a step's action names, as it is typed. */
export function setupActionText(action: SetupAction): string {
  if (action.kind === 'run') return nodeCommandLine(action.command);
  if (action.kind === 'restart') return SANDBOX_RESTART;
  return action.command ?? SANDBOX_INSTALL_UNKNOWN;
}

const names = (items: readonly string[]): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

function joinStep(s: NodeStatus): Omit<SetupStep, 'id' | 'number' | 'title'> {
  if (s.connect.inAccount) return { done: true, left: s.connect.email ? `In your account (signed in as ${s.connect.email}).` : 'In your account.', action: null };
  return { done: false, left: s.connect.removed ? REMOVED_NODE : 'Not in your account yet: sign in and ask to join it.', action: { kind: 'run', command: 'join' } };
}

function agentsStep(s: NodeStatus): Omit<SetupStep, 'id' | 'number' | 'title'> {
  const can = s.agents.filter((a) => a.canRun).length;
  const cannot = s.agents.filter((a) => !a.canRun).map((a) => NODE_AGENT_LABEL[a.agent]);
  const count = `${can} of ${s.agents.length} agents can run.`;
  if (cannot.length === 0) return { done: true, left: count, action: null };
  return { done: false, left: `${count} ${names(cannot)} cannot yet.`, action: { kind: 'run', command: 'agents' } };
}

function gitStep(s: NodeStatus): Omit<SetupStep, 'id' | 'number' | 'title'> {
  const left = s.git.key ? (s.git.left ?? 0) : 1;
  if (left === 0) return { done: true, left: `Key made; nothing left at the hosts checked (${s.git.summary}).`, action: null };
  return { done: false, left: s.git.key ? `${left} thing${left === 1 ? '' : 's'} left: ${s.git.summary}.` : 'This node has no git key of its own yet.', action: { kind: 'run', command: 'git' } };
}

function lingeringStep(s: NodeStatus): Omit<SetupStep, 'id' | 'number' | 'title'> {
  if (s.host.lingering === 'on') return { done: true, left: 'Lingering is on.', action: null };
  if (s.host.lingering === 'unknown') return { done: true, left: 'Not needed here: this system has no systemd.', action: null };
  return { done: false, left: `Lingering is off. ${WITHOUT_LINGERING}`, action: { kind: 'admin', command: enableLingerCommand(s.host.user) } };
}

function sandboxStep(s: NodeStatus, here: SandboxHere | null): Omit<SetupStep, 'id' | 'number' | 'title'> {
  if (s.sandbox.available) return { done: true, left: 'bubblewrap and socat are in use.', action: null };
  const missing = here ? here.missing : ['bubblewrap', 'socat'];
  if (missing.length === 0) return { done: false, left: 'bubblewrap and socat are installed, but the node started before they were: it needs a restart to use them.', action: { kind: 'restart' } };
  return { done: false, left: `${names(missing)} ${missing.length === 1 ? 'is' : 'are'} not installed. ${WITHOUT_SANDBOX}`, action: { kind: 'admin', command: here?.install ?? null } };
}

/** Every step, done or not, from the node's status and what the terminal sees. Pure. */
export function setupStepsOf(status: NodeStatus, here: SandboxHere | null): SetupStep[] {
  const of: Record<SetupStepId, Omit<SetupStep, 'id' | 'number' | 'title'>> = {
    join: joinStep(status),
    agents: agentsStep(status),
    git: gitStep(status),
    lingering: lingeringStep(status),
    sandbox: sandboxStep(status, here),
  };
  return SETUP_STEPS.map((id, i) => ({ id, number: i + 1, title: TITLES[id], ...of[id] }));
}

/** The next step to offer: the first one left that this run has not offered already. */
export const nextSetupStep = (steps: readonly SetupStep[], offered: ReadonlySet<SetupStepId>): SetupStep | null => steps.find((s) => !s.done && !offered.has(s.id)) ?? null;

/** The overview's one line of status (`kestrel` with no command). `status` null: no node answers. */
export function setupSummary(status: NodeStatus | null, here: SandboxHere | null): string {
  if (!status) return `No node answers here. "${nodeCommandLine('status')}" says why, and "${nodeCommandLine('start')}" starts it.`;
  const account = status.connect.inAccount ? `in your account${status.connect.connected ? ' and connected' : ', not connected'}` : 'not in your account';
  const can = status.agents.filter((a) => a.canRun).length;
  const left = setupStepsOf(status, here).filter((s) => !s.done).length;
  const setup = left === 0 ? 'set up' : `${left} setup step${left === 1 ? '' : 's'} left: run "${nodeCommandLine('configure')}"`;
  return `${status.name} (Kestrel ${status.version}): ${account}; ${can} of ${status.agents.length} agents can run; ${setup}.`;
}
