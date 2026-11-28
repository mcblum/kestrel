// `kestrel node agents`: the checklist that gets Claude Code, Codex and OpenCode installed and signed in on a node, and
// says whether the command sandbox is there (docs/designs/worker-nodes.md, section 6). It runs in the terminal, which
// has the person's keyboard and screen: an agent's own sign-in needs a real terminal. It says what happens as the same
// typed events `join` uses (shared/node-commands.ts), drawn by the same function (join-draw.ts): a section per agent,
// one thing per line, a tick when it is done. Every agent is optional (one is enough to start sessions), so at a
// terminal it first says which are not ready and asks once which to set up (Enter for all of them, names, all or
// none); that answer is the yes for installing and signing in the ones named. Moving an install to another version
// and moving OpenCode's data aside still ask on their own. With `--yes` or no terminal, what is missing is installed
// and the sign-in commands are printed instead of run.
//
// Whether an agent can run is the node's answer, the one it publishes to other devices (the `agents` socket command,
// which also tells the node to forget what it knew of an agent signed in or checked here). Only `--check` spends a
// turn, a short one the person asked for.
import type { Agent } from '../model.ts';
import { nodeCommandLine, whyHere, type JoinSay, type JoinStep, type NodeAgentState, type NodeJoinEvent } from '../shared/node-commands.ts';
import { downgradeNote, pinMoveOf, pinNote, type AgentPins, type PinnedAgent } from '../shared/node-agent-versions.ts';
import { installsItself, nodeAgentReason, NODE_AGENT_LABEL, NODE_AGENT_PACKAGE, NODE_AGENT_PROGRAM, NODE_AGENTS, NODE_AGENTS_COMMAND, NODE_SIGN_IN_ARGS } from '../shared/node-agents.ts';
import { SANDBOX_INSTALL_UNKNOWN, SANDBOX_RESTART, WITHOUT_SANDBOX } from '../shared/node-sandbox.ts';
import { moveCommand, type AgentFacts, type AgentPrograms } from './agents-programs.ts';
import { confirm, type AskHint, type TrustDetail } from './worker-onboarding/ask.ts';

const SETUP_COMMAND = nodeCommandLine('configure');

export interface AgentsOptions {
  /** One agent only (`kestrel node agents codex`); null for all three and the sandbox. */
  only: Agent | null;
  /** Install what is missing without asking and print the sign-in commands (`--yes`, or no terminal). */
  unattended: boolean;
  /** Run one short turn of each signed-in agent (`--check`). */
  check: boolean;
  /** Report the command sandbox (default true; `kestrel node configure` has dealt with it in its System section). */
  sandbox?: boolean;
}

/** What the command sandbox has here, from the terminal's PATH and the running node. */
export interface SandboxFacts {
  /** The packages missing, by name (bubblewrap, socat). */
  missing: string[];
  /** The install command for this distribution, or null when its package manager is not one Kestrel knows. */
  install: string | null;
  /** What the running node said at its start, or null when no node answered. */
  nodeHasIt: boolean | null;
}

export interface ChecklistDeps {
  programs: Pick<AgentPrograms, 'folder' | 'facts' | 'install' | 'newest' | 'signIn' | 'check' | 'moveAsidePlan' | 'moveAside'>;
  /** Asks the running node to ask its agents again, forgetting those in `recheck`; null when no node answers. */
  node(recheck: readonly Agent[]): Promise<NodeAgentState[] | null>;
  sandbox(): Promise<SandboxFacts>;
  /** The versions this node installs Codex and OpenCode at (its bundle's `agents.json`). */
  pins: AgentPins;
  /** This node's name, as other devices see it. */
  name: string;
  /** The home folder, written as `~` in what is said. */
  home: string;
}

export interface ChecklistIo {
  say(event: NodeJoinEvent): void;
  /**
   * Asks the person; null when the terminal closed. `hint` says what kind of question it is, for the interactive screen
   * (worker-onboarding/ask.ts); the plain transcript reads the typed prompt only.
   */
  ask(step: JoinStep, prompt: string, hint?: AskHint): Promise<string | null>;
  /** Something other than the checklist printed (an agent's sign-in): the next line starts a new block. */
  ran(): void;
  /** The screen draws a question's choices itself: the transcript's numbered lines and typing help are left out. */
  readonly drawsChoices?: boolean;
}

/** A yes typed: y or yes. Anything else is no. */
export const saidYes = (answer: string | null): boolean => /^\s*y(es)?\s*$/i.test(answer ?? '');

export const SANDBOX_STEP: JoinStep = 4;

const tilde = (path: string, home: string): string => (home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

/** What one agent's section ended as. */
interface AgentEnd {
  agent: Agent;
  /** Installed and signed in, as far as this terminal can tell. */
  ready: boolean;
  /** Installed, signed in or checked here: the node forgets what it knew of it. */
  changed: boolean;
}

/** The command that does one agent's part of the checklist, as printed. */
export const agentCommand = (agent: Agent): string => `${NODE_AGENTS_COMMAND} ${agent}`;

const signInCommand = (agent: Agent): string => [NODE_AGENT_PROGRAM[agent], ...NODE_SIGN_IN_ARGS[agent]].join(' ');

class Checklist {
  /** The person chose the agents to set up: installing and signing them in is not asked again. */
  chosen = false;

  constructor(
    private readonly deps: ChecklistDeps,
    private readonly io: ChecklistIo,
    private readonly options: AgentsOptions,
  ) {}

  private say(step: JoinStep, line: JoinSay): void {
    this.io.say({ event: 'say', step, ...line });
  }

  /** Asks, unless unattended; true on a yes. */
  private async agreed(step: JoinStep, prompt: string, hint: AskHint = confirm(false)): Promise<boolean> {
    return saidYes(await this.io.ask(step, `${prompt} [y/N] `, hint));
  }

  private installedLine(agent: Agent, facts: AgentFacts): string {
    const where = agent === 'claude' ? 'comes with Kestrel' : facts.program?.startsWith(this.deps.programs.folder) ? `in ${tilde(this.deps.programs.folder, this.deps.home)}` : `at ${tilde(facts.program ?? '', this.deps.home)}`;
    return `Installed: ${NODE_AGENT_LABEL[agent]} ${facts.version ?? '(version unknown)'} (${where})`;
  }

  /** Installed, or installed now (at its pin). Null when it is not, and the section ends. */
  private async installed(step: JoinStep, agent: Agent): Promise<{ facts: AgentFacts; changed: boolean } | null> {
    const label = NODE_AGENT_LABEL[agent];
    const facts = await this.deps.programs.facts(agent);
    if (!installsItself(agent)) {
      if (facts.program) return (this.say(step, { kind: 'done', text: this.installedLine(agent, facts) }), { facts, changed: false });
      this.say(step, { kind: 'problem', text: `${label}'s program is missing from this node's bundle. Install the node again (the install command upgrades in place and keeps Kestrel's data).` });
      return null;
    }
    const pin = this.deps.pins[agent];
    const folder = tilde(this.deps.programs.folder, this.deps.home);
    if (facts.program) {
      const move = pinMoveOf(facts.version, pin);
      if (!move.move) return (this.say(step, { kind: 'done', text: this.installedLine(agent, facts) }), { facts, changed: false });
      this.say(step, { kind: 'line', text: `${this.installedLine(agent, facts)}. This Kestrel runs ${label} ${pin}.` });
      if (move.down && move.from) this.say(step, { kind: 'line', text: downgradeNote(label, move.from, pin) });
      const asked = `Install ${label} ${pin} into ${folder} with npm? The node uses that one from then on.`;
      if (!this.options.unattended && !(await this.agreed(step, asked, confirm(false, { yes: `Install ${pin}`, no: 'Leave it' })))) {
        this.say(step, { kind: 'line', text: `Left at ${move.from ?? 'the version it has'}. To move it later: ${agentCommand(agent)}` });
        return { facts, changed: false };
      }
    } else {
      if (!this.chosen) this.say(step, { kind: 'line', text: 'Not installed.' });
      if (!this.options.unattended && !this.chosen && !(await this.agreed(step, `Install ${label} ${pin} into ${folder} with npm?`, confirm(false, { yes: 'Install', no: 'Not now' })))) {
        this.say(step, { kind: 'line', text: `Not installed. To install it later: ${agentCommand(agent)}` });
        return null;
      }
    }
    return this.install(step, agent, pin, folder);
  }

  /** npm installs the pinned version; a wait line meanwhile, nothing of npm's on success, its last lines when it failed. */
  private async install(step: JoinStep, agent: PinnedAgent, pin: string, folder: string): Promise<{ facts: AgentFacts; changed: boolean } | null> {
    const label = NODE_AGENT_LABEL[agent];
    const note = pinNote(agent, pin, await this.deps.programs.newest(agent));
    if (note) this.say(step, { kind: 'line', text: note });
    this.say(step, { kind: 'wait', text: `Installing ${label} ${pin} (npm install --prefix ${folder} ${NODE_AGENT_PACKAGE[agent]}@${pin})…` });
    const done = await this.deps.programs.install(agent, pin);
    if (!done.ok) {
      this.say(step, { kind: 'problem', text: `${done.reason} The last lines it printed:` });
      for (const line of done.output) this.say(step, { kind: 'quote', text: line });
      this.say(step, { kind: 'line', text: `To try again: ${agentCommand(agent)}` });
      return null;
    }
    const now = await this.deps.programs.facts(agent);
    if (!now.program) return (this.say(step, { kind: 'problem', text: `npm finished, but ${label}'s program is not in ${folder}. Run ${agentCommand(agent)} again.` }), null);
    if (now.version === null) return (this.say(step, { kind: 'problem', text: `${label} ${pin} was installed, but its program does not run (it did not say its version). Run \`${now.program} --version\` to see why.` }), null);
    this.say(step, { kind: 'done', text: this.installedLine(agent, now) });
    return { facts: now, changed: true };
  }

  /**
   * OpenCode's own database was made by another OpenCode version: said in plain words, and moving it aside offered, the
   * exact command shown, done only on a yes typed here (never unattended: Kestrel does not move OpenCode's data on its own).
   * True when it was moved.
   */
  private async movedAside(step: JoinStep, agent: Agent): Promise<boolean> {
    const plan = this.deps.programs.moveAsidePlan();
    const database = tilde(plan.moves[0]?.from ?? '', this.deps.home);
    this.say(step, { kind: 'problem', text: nodeAgentReason(agent, { trouble: 'data-version', ...(database ? { database } : {}) }, 'here') });
    if (plan.moves.length === 0 || this.options.unattended) return false;
    const command = moveCommand(plan, (path) => tilde(path, this.deps.home));
    this.say(step, { kind: 'code', code: command });
    const trust: TrustDetail = {
      label: `Move ${NODE_AGENT_LABEL[agent]}'s data`,
      action: `Move ${NODE_AGENT_LABEL[agent]}'s database aside; it makes a new one when it next starts.`,
      destination: database || 'Its data folder on this node.',
      reason: 'Another version of it made that database, so it cannot run until it is moved.',
      commands: command.split('\n'),
    };
    if (!(await this.agreed(step, 'Move it aside now with that command?', confirm(false, { yes: 'Move it aside', no: 'Leave it', trust })))) {
      this.say(step, { kind: 'line', text: `Left where it is. ${NODE_AGENT_LABEL[agent]} cannot run until it is moved.` });
      return false;
    }
    const done = this.deps.programs.moveAside(plan);
    if (!done.ok) return (this.say(step, { kind: 'problem', text: done.reason }), false);
    this.say(step, { kind: 'done', text: `Moved aside; ${NODE_AGENT_LABEL[agent]} makes a new database when it next starts` });
    return true;
  }

  /** Signed in, or signed in now. */
  private async signedIn(step: JoinStep, agent: Agent, given: AgentFacts): Promise<{ signedIn: boolean; changed: boolean }> {
    const label = NODE_AGENT_LABEL[agent];
    let facts = given;
    if (facts.dataVersion) {
      if (!(await this.movedAside(step, agent))) return { signedIn: false, changed: false };
      facts = await this.deps.programs.facts(agent);
    }
    if (facts.signedIn === true) return (this.say(step, { kind: 'done', text: 'Signed in' }), { signedIn: true, changed: false });
    if (!this.chosen || facts.signedIn === null) this.say(step, { kind: 'line', text: facts.signedIn === false ? 'Not signed in.' : `${label} could not say whether it is signed in.` });
    if (this.options.unattended) {
      this.say(step, { kind: 'line', text: `To sign in, run ${agentCommand(agent)} in a terminal (it runs \`${signInCommand(agent)}\` there).` });
      return { signedIn: false, changed: false };
    }
    if (!this.chosen && !(await this.agreed(step, `Sign in to ${label} now? It runs \`${signInCommand(agent)}\` in this terminal.`, confirm(false, { yes: 'Sign in now', no: 'Not now', trust: signInTrust(agent) })))) {
      this.say(step, { kind: 'line', text: `Not signed in. To sign in later: ${agentCommand(agent)}` });
      return { signedIn: false, changed: false };
    }
    this.say(step, { kind: 'wait', text: `Signing in with \`${signInCommand(agent)}\`. ${signInHelp(agent)} Kestrel sees none of it.` });
    await this.deps.programs.signIn(agent);
    this.io.ran();
    const after = await this.deps.programs.facts(agent);
    if (after.signedIn === true) return (this.say(step, { kind: 'done', text: 'Signed in' }), { signedIn: true, changed: true });
    this.say(step, { kind: 'problem', text: `${label} still says it is not signed in. Run ${agentCommand(agent)} to try again.` });
    return { signedIn: false, changed: false };
  }

  /** `--check`: one short turn, said first, since it spends a little usage. True when it ran. */
  private async checked(step: JoinStep, agent: Agent): Promise<boolean> {
    const label = NODE_AGENT_LABEL[agent];
    this.say(step, { kind: 'wait', text: `Checking that ${label} can run: one short turn, a little of your usage…` });
    const done = await this.deps.programs.check(agent);
    if (done.ok) this.say(step, { kind: 'done', text: 'A turn ran' });
    else this.say(step, { kind: 'problem', text: `A turn did not run: ${done.reason}.` });
    return done.ok;
  }

  async agent(step: JoinStep, agent: Agent): Promise<AgentEnd> {
    this.say(step, { kind: 'heading', text: NODE_AGENT_LABEL[agent] });
    const has = await this.installed(step, agent);
    if (!has) return { agent, ready: false, changed: false };
    const signed = await this.signedIn(step, agent, has.facts);
    // A turn is tried only when the agent did not say it is signed out.
    const ran = this.options.check && (signed.signedIn || has.facts.signedIn === null) ? await this.checked(step, agent) : false;
    return { agent, ready: signed.signedIn, changed: has.changed || signed.changed || ran };
  }

  /**
   * At a terminal, with every agent asked for: which are not ready, said in one line, and one question for which of
   * them to set up. The answer is the yes for installing and signing in those; the rest are left as they are.
   */
  async choose(agents: readonly Agent[]): Promise<Agent[]> {
    const ready: Agent[] = [];
    const notReady: Agent[] = [];
    const why = new Map<Agent, string>();
    for (const agent of agents) {
      const facts = await this.deps.programs.facts(agent);
      const reason = notReadyReason(facts, installsItself(agent) ? this.deps.pins[agent] : null);
      if (reason) why.set(agent, reason);
      (reason ? notReady : ready).push(agent);
    }
    if (notReady.length === 0) return [];
    const label = (list: readonly Agent[]) => names(list.map((a) => NODE_AGENT_LABEL[a]));
    const folder = tilde(this.deps.programs.folder, this.deps.home);
    this.say(0, { kind: 'line', text: `${ready.length > 0 ? `${label(ready)} ${ready.length === 1 ? 'is' : 'are'} ready. ` : ''}${label(notReady)} ${notReady.length === 1 ? 'is' : 'are'} not set up yet. Each agent is optional: one is enough to start sessions here.` });
    this.say(0, { kind: 'line', text: `Setting one up installs it into ${folder} with npm when it is missing, then runs its own sign-in in this terminal.` });
    const prompt = notReady.length === 1 ? `Set up ${label(notReady)}? [Y/n] ` : `Set up which? Enter for all of them, or type names (${notReady.join(', ')}), or none: `;
    const trust: TrustDetail = {
      label: 'Before setting up agents',
      action: 'Install each one chosen with npm when it is missing, then run its own sign-in in this terminal. Neither is asked again.',
      destination: `${folder} on ${this.deps.name}, and each agent's provider for its sign-in.`,
      reason: `${label(notReady)} ${notReady.length === 1 ? 'is' : 'are'} not set up yet. Each agent is optional: one that can run is enough to start sessions here.`,
      commands: notReady.flatMap((a) => [...(installsItself(a) && why.get(a) === NOT_INSTALLED ? [`npm install --prefix ${folder} ${NODE_AGENT_PACKAGE[a]}@${this.deps.pins[a]}`] : []), signInCommand(a)]),
    };
    const hint: AskHint = notReady.length === 1
      ? confirm(true, { label: `Set up ${label(notReady)}?`, yes: 'Set it up', no: 'Not now', trust })
      : {
          kind: 'pick',
          label: 'Which agents should be set up here?',
          choices: notReady.map((a) => ({ answer: a, label: NODE_AGENT_LABEL[a], note: why.get(a)! })),
          initial: notReady,
          answer: (chosen) => (chosen.length === 0 ? 'none' : chosen.join(' ')),
          trust,
        };
    for (let i = 0; i < 3; i++) {
      const answer = await this.io.ask(0, prompt, hint);
      if (answer === null) return [];
      const picked = agentsPicked(answer, notReady);
      if (picked) {
        this.chosen = true;
        if (picked.length === 0) this.say(0, { kind: 'line', text: `None set up. To add one later: ${NODE_AGENTS_COMMAND}` });
        return picked;
      }
      this.say(0, { kind: 'line', text: `Type ${notReady.length === 1 ? 'y or n' : `agent names (${notReady.join(', ')}), all, or none`}.` });
    }
    return [];
  }

  /** What the running node now tells other devices about each agent. */
  /** `leftOut`: the agents the person chose not to set up this time; not being installed or signed in is no failure for them. */
  async nodeSays(ends: readonly AgentEnd[], leftOut: readonly Agent[] = []): Promise<NodeAgentState[] | null> {
    const states = await this.deps.node(ends.filter((e) => e.changed).map((e) => e.agent));
    this.say(0, { kind: 'heading', text: `What ${this.deps.name} tells your other devices` });
    if (!states) {
      this.say(0, { kind: 'line', text: 'The node is not running, so it has not said which agents can run. Start it with kestrel node start; then kestrel node status says.' });
      return null;
    }
    for (const end of ends) {
      const state = states.find((s) => s.agent === end.agent);
      if (!state) continue;
      if (state.canRun) this.say(0, { kind: 'done', text: `${NODE_AGENT_LABEL[end.agent]} can run` });
      else if (leftOut.includes(end.agent) && isNotSetUp(state)) this.say(0, { kind: 'line', text: `${NODE_AGENT_LABEL[end.agent]}: left out, not set up here.` });
      else if (state.problem?.trouble === 'data-version' && (await this.movedAside(0, end.agent))) {
        const again = (await this.deps.node([end.agent]))?.find((s) => s.agent === end.agent);
        if (again) states.splice(states.indexOf(state), 1, again);
        this.say(0, again?.canRun ? { kind: 'done', text: `${NODE_AGENT_LABEL[end.agent]} can run` } : { kind: 'line', text: again ? whyHere(again) : 'The node did not answer again.' });
      } else this.say(0, { kind: 'line', text: whyHere(state) });
    }
    return states;
  }

  async sandbox(step: JoinStep = SANDBOX_STEP): Promise<boolean> {
    const facts = await this.deps.sandbox();
    // Optional: agents run without it, and its own section says what is missing; the agents' closing line never counts it.
    this.say(step, { kind: 'heading', text: 'Command sandbox (optional)' });
    if (facts.missing.length === 0) {
      this.say(step, { kind: 'done', text: 'bubblewrap and socat are installed' });
      if (facts.nodeHasIt === false) {
        this.say(step, { kind: 'line', text: 'The node started before they were installed. Restart it to use them:' });
        this.say(step, { kind: 'code', code: SANDBOX_RESTART });
        return false;
      }
      return true;
    }
    this.say(step, { kind: 'line', text: `${names(facts.missing)} ${facts.missing.length === 1 ? 'is' : 'are'} not installed. ${WITHOUT_SANDBOX}` });
    if (facts.install === null) {
      this.say(step, { kind: 'line', text: `Install them with ${SANDBOX_INSTALL_UNKNOWN}, then restart the node: ${SANDBOX_RESTART}` });
      return false;
    }
    this.say(step, { kind: 'line', text: `"${SETUP_COMMAND}" installs them with sudo and restarts the node. Or an administrator runs this, and then you restart the node (${SANDBOX_RESTART}):` });
    this.say(step, { kind: 'code', code: facts.install });
    return false;
  }
}

/** Not installed or not signed in: what an agent left out is expected to be. Anything else is a real failure, said as it is. */
const isNotSetUp = (state: NodeAgentState): boolean => state.problem?.trouble === 'missing' || state.problem?.trouble === 'signed-out';

const names = (items: readonly string[]): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

const AGENT_WORDS: Record<string, Agent> = { claude: 'claude', 'claude-code': 'claude', claudecode: 'claude', codex: 'codex', opencode: 'opencode' };

/**
 * The agents an answer picks from `offered`: Enter, y, yes or all is every one; n, no or none is none; otherwise the
 * names typed (claude, codex, opencode), each one offered. Null when the answer is none of those.
 */
export function agentsPicked(answer: string, offered: readonly Agent[]): Agent[] | null {
  const typed = answer.trim().toLowerCase();
  if (typed === '' || typed === 'all' || (offered.length === 1 && /^y(es)?$/.test(typed))) return [...offered];
  if (typed === 'none' || /^no?$/.test(typed)) return [];
  const words = typed.split(/[\s,]+/).filter(Boolean);
  const picked = words.map((w) => AGENT_WORDS[w]);
  if (picked.some((a) => !a || !offered.includes(a))) return null;
  return offered.filter((a) => picked.includes(a));
}

const NOT_INSTALLED = 'not installed';

/** Why an agent is not ready here, in a few words; null when it is (installed at the version this Kestrel uses, signed in, its data readable). */
function notReadyReason(facts: AgentFacts, pin: string | null): string | null {
  if (!facts.program) return NOT_INSTALLED;
  if (facts.dataVersion) return 'data from another version';
  if (pin && pinMoveOf(facts.version, pin).move) return `not at ${pin}`;
  if (facts.signedIn !== true) return 'not signed in';
  return null;
}

/** Who an agent's own sign-in talks to. */
const SIGN_IN_AT: Record<Agent, string> = {
  claude: "Anthropic, through Claude Code's own sign-in.",
  codex: "OpenAI, through Codex's own sign-in.",
  opencode: 'The provider you choose in OpenCode.',
};

/** Before an agent's own sign-in takes the terminal: what runs, where it signs in, and why. */
export function signInTrust(agent: Agent): TrustDetail {
  return {
    label: 'Provider sign-in',
    action: `Run ${NODE_AGENT_LABEL[agent]}'s own sign-in in this terminal. Kestrel sees none of it.`,
    destination: SIGN_IN_AT[agent],
    reason: signInHelp(agent),
    commands: [signInCommand(agent)],
  };
}

/** What each agent's own sign-in asks of the person (docs/spike-results.md, "Worker nodes"). */
export function signInHelp(agent: Agent): string {
  if (agent === 'claude') return 'Claude Code prints an address: open it on any device, sign in, and paste the code the page gives back here.';
  if (agent === 'codex') return "Codex prints a code: type it on the provider's device page, on any device. Nothing is pasted back here.";
  return 'OpenCode asks which provider to use, then for its key or sign-in.';
}

/** Runs the checklist; resolves with the exit code: 0 when the agents are ready (the optional sandbox aside), 1 otherwise. */
export async function runAgentsChecklist(deps: ChecklistDeps, io: ChecklistIo, options: AgentsOptions): Promise<number> {
  const list = new Checklist(deps, io, options);
  const agents = options.only ? [options.only] : NODE_AGENTS;
  io.say({ event: 'say', step: 0, kind: 'heading', text: options.only ? `Kestrel worker node: ${NODE_AGENT_LABEL[options.only]} on ${deps.name}` : `Kestrel worker node: agents on ${deps.name}` });
  // Named on the command line, or chosen at the terminal: that is the yes. Unattended, every one is walked.
  if (options.only && !options.unattended) list.chosen = true;
  const walked = options.only || options.unattended ? agents : await list.choose(agents);
  const ends: AgentEnd[] = [];
  // Numbered in the order they are done: only what is set up here gets a section.
  for (const agent of agents) {
    const at = walked.indexOf(agent);
    if (at >= 0) ends.push(await list.agent((at + 1) as JoinStep, agent));
    else ends.push({ agent, ready: (await deps.programs.facts(agent)).signedIn === true, changed: false });
  }
  if (!options.only && options.sandbox !== false) await list.sandbox((walked.length + 1) as JoinStep);
  const leftOut = agents.filter((agent) => !walked.includes(agent));
  const states = await list.nodeSays(ends, leftOut);
  const canRun = states ? ends.filter((e) => states.find((s) => s.agent === e.agent)?.canRun).length : null;
  // Every agent is optional: ready is the ones set up here ready, and at least one that can run. The sandbox is optional
  // too and is said apart: it never turns the agents' line into a failure, nor the exit code.
  const runs = (agent: Agent) => states?.find((s) => s.agent === agent)?.canRun === true;
  const set = ends.filter((e) => walked.includes(e.agent));
  const ready = set.every((e) => e.ready && (states === null || runs(e.agent))) && (states === null ? ends.some((e) => e.ready) : ends.some((e) => runs(e.agent)));
  const count = canRun === null ? `${ends.filter((e) => e.ready).length} of ${ends.length} signed in` : `${canRun} of ${ends.length} can run`;
  io.say({ event: 'end', ok: ready, text: options.only ? `${NODE_AGENT_LABEL[options.only]} on ${deps.name}: ${ready ? 'ready' : 'not ready yet'}.` : `Agents on ${deps.name}: ${count}.`, next: 'kestrel node status' });
  return ready ? 0 : 1;
}
