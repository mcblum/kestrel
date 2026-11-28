// What `kestrel node configure` offers, in order, purely, from what the node reports (`status`) and what the terminal sees of
// the sandbox programs (docs/designs/worker-nodes.md, section 8; docs/designs/worker-terminal-handoff.md). Nothing is
// remembered between runs: a step is done when the node says so, so running it again picks up where it was left. What
// needs an administrator comes first, as one plan offered once (`adminPlanOf`), so it is done before the slow steps.
// The runner is node-control/setup-flow.ts.
import { NODE_AGENT_LABEL } from './node-agents.ts';
import type { NodeStatus } from './node-status.ts';
import { REMOVED_NODE } from './node-status.ts';
import { enableLingerCommand, WITHOUT_LINGERING } from './node-service.ts';
import { SANDBOX_INSTALL_UNKNOWN, SANDBOX_RESTART, WITHOUT_SANDBOX } from './node-sandbox.ts';
import { nodeCommandLine } from './node-commands.ts';

/** The steps, in the order they are offered: what needs an administrator first, then the account, agents and git. */
export const SETUP_STEPS = ['lingering', 'sandbox', 'join', 'agents', 'git'] as const;
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
  /** The section it is drawn in, 1 to 4, whether or not it is left: lingering and the sandbox share 1, System. */
  number: number;
  title: string;
  done: boolean;
  /** One line: how it is when done, what is left when not. */
  left: string;
  /** What to do; null when done. */
  action: SetupAction | null;
}

const TITLES: Record<SetupStepId, string> = {
  lingering: 'Lingering',
  sandbox: 'Command sandbox',
  join: 'Account',
  agents: 'Agents',
  git: 'Git',
};

const SECTIONS: Record<SetupStepId, number> = { lingering: 1, sandbox: 1, join: 2, agents: 3, git: 4 };

/** The sections' headings, by number. */
export const SETUP_SECTIONS: Record<number, string> = { 1: 'System', 2: 'Account', 3: 'Agents', 4: 'Git' };

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

/** One agent that can run is enough: the others are optional, and `kestrel node agents` adds them any time. */
function agentsStep(s: NodeStatus): Omit<SetupStep, 'id' | 'number' | 'title'> {
  const can = s.agents.filter((a) => a.canRun).map((a) => NODE_AGENT_LABEL[a.agent]);
  const cannot = s.agents.filter((a) => !a.canRun).map((a) => NODE_AGENT_LABEL[a.agent]);
  if (can.length === 0) return { done: false, left: 'No agent can run yet. One is enough to start sessions here.', action: { kind: 'run', command: 'agents' } };
  const optional = cannot.length === 0 ? '' : ` ${names(cannot)} ${cannot.length === 1 ? 'is' : 'are'} optional ("${nodeCommandLine('agents')}" adds ${cannot.length === 1 ? 'it' : 'them'}).`;
  return { done: true, left: `${names(can)} can run.${optional}`, action: null };
}

function gitStep(s: NodeStatus): Omit<SetupStep, 'id' | 'number' | 'title'> {
  const left = s.git.key ? (s.git.left ?? 0) : 1;
  if (left === 0) return { done: true, left: `Key made; nothing left at the hosts checked (${s.git.summary}).`, action: null };
  return { done: false, left: s.git.key ? `${left} thing${left === 1 ? '' : 's'} left: ${s.git.summary}.` : 'This node has no git key of its own yet.', action: { kind: 'run', command: 'git' } };
}

function lingeringStep(s: NodeStatus): Omit<SetupStep, 'id' | 'number' | 'title'> {
  if (s.host.lingering === 'on') return { done: true, left: 'Lingering is on.', action: null };
  if (s.host.lingering === 'unknown') return { done: true, left: 'Lingering is not needed: this system has no systemd.', action: null };
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
    lingering: lingeringStep(status),
    sandbox: sandboxStep(status, here),
    join: joinStep(status),
    agents: agentsStep(status),
    git: gitStep(status),
  };
  return SETUP_STEPS.map((id) => ({ id, number: SECTIONS[id], title: TITLES[id], ...of[id] }));
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

/** Who can run an administrator's command here: this is root already, sudo is installed, or neither. */
export type AdminRunner = 'root' | 'sudo' | 'none';

export interface AdminCommand {
  id: 'lingering' | 'sandbox';
  /** As it is shown, and as it would be pasted. */
  text: string;
  /** As it is run: through sudo, or as it is when this is root. */
  argv: string[];
}

/** What the System section offers, once, before the account, agents and git. */
export interface AdminPlan {
  /** What is missing, each said with what happens without it. */
  needs: { id: 'lingering' | 'sandbox'; text: string }[];
  /** The administrator's commands, in order; empty when only a restart is left. */
  commands: AdminCommand[];
  /** The node restarts afterwards (or only that), since it works the sandbox out when it starts. */
  restart: boolean;
  /** False when nothing here can run the commands (no sudo): they are shown for an administrator. */
  canRun: boolean;
  /** What Kestrel cannot do from here at all, with what to do instead (no package manager it knows). */
  cannot: string[];
}

/** Said where no package manager on the list is found. */
export const UNKNOWN_PACKAGE_MANAGER = `Kestrel does not know this system's package manager. Install bubblewrap and socat with it, then run "${nodeCommandLine('configure')}" again.`;

/** Said where sudo is not installed and this is not root. */
export const NO_SUDO = 'sudo is not installed here, so Kestrel cannot run these. Ask an administrator to run them as root:';

/** The command as this computer runs it, or as an administrator types it as root where there is no sudo. */
/** An administrator's command as it is typed here: with sudo where sudo runs it, as root otherwise. Pure. */
export const adminCommandHere = (text: string, runner: AdminRunner): string => (runner === 'sudo' ? text : text.replace(/^sudo /, ''));

const commandOf = (id: AdminCommand['id'], text: string, runner: AdminRunner): AdminCommand => {
  const words = text.split(' ').filter(Boolean);
  const bare = words[0] === 'sudo' ? words.slice(1) : words;
  // Root runs it as it is, and so does an administrator where there is no sudo: it is shown for them as root.
  return runner === 'sudo' ? { id, text, argv: ['sudo', ...bare] } : { id, text: bare.join(' '), argv: bare };
};

/** The System section's plan, from the steps and who can run an administrator's command here. Pure. */
export function adminPlanOf(steps: readonly SetupStep[], runner: AdminRunner): AdminPlan | null {
  const left = steps.filter((s) => (s.id === 'lingering' || s.id === 'sandbox') && !s.done);
  if (left.length === 0) return null;
  const needs: AdminPlan['needs'] = [];
  const commands: AdminCommand[] = [];
  const cannot: string[] = [];
  let restart = false;
  for (const step of left) {
    const id = step.id as AdminCommand['id'];
    const action = step.action!;
    if (action.kind === 'restart') {
      needs.push({ id, text: 'bubblewrap and socat are installed, but the node started before they were.' });
      restart = true;
    } else if (action.kind === 'admin') {
      needs.push({ id, text: step.left });
      if (action.command === null) cannot.push(UNKNOWN_PACKAGE_MANAGER);
      else {
        commands.push(commandOf(id, action.command, runner));
        if (id === 'sandbox') restart = true;
      }
    }
  }
  const canRun = runner !== 'none' || commands.length === 0;
  return { needs, commands, restart, canRun, cannot };
}
