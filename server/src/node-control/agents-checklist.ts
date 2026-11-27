// `kestrel node agents`: the checklist that gets Claude Code, Codex and OpenCode installed and signed in on a node, and
// says whether the command sandbox is there (docs/designs/worker-nodes.md, section 6). It runs in the terminal, which
// has the person's keyboard and screen: an agent's own sign-in needs a real terminal. It says what happens as the same
// typed events `join` uses (shared/node-commands.ts), drawn by the same function (join-draw.ts): a section per agent,
// one thing per line, a tick when it is done. Nothing is done without a yes typed here, one thing at a time; with
// `--yes` or no terminal, what is missing is installed and the sign-in commands are printed instead of run.
//
// Whether an agent can run is the node's answer, the one it publishes to other devices (the `agents` socket command,
// which also tells the node to forget what it knew of an agent signed in or checked here). Only `--check` spends a
// turn, a short one the person asked for.
import type { Agent } from '../model.ts';
import { whyHere, type JoinSay, type JoinStep, type NodeAgentState, type NodeJoinEvent } from '../shared/node-commands.ts';
import { downgradeNote, pinMoveOf, pinNote, type AgentPins, type PinnedAgent } from '../shared/node-agent-versions.ts';
import { installsItself, nodeAgentReason, NODE_AGENT_LABEL, NODE_AGENT_PACKAGE, NODE_AGENT_PROGRAM, NODE_AGENTS, NODE_AGENTS_COMMAND, NODE_SIGN_IN_ARGS } from '../shared/node-agents.ts';
import { SANDBOX_INSTALL_UNKNOWN, SANDBOX_RESTART, WITHOUT_SANDBOX } from '../shared/node-sandbox.ts';
import { moveCommand, type AgentFacts, type AgentPrograms } from './agents-programs.ts';

export interface AgentsOptions {
  /** One agent only (`kestrel node agents codex`); null for all three and the sandbox. */
  only: Agent | null;
  /** Install what is missing without asking and print the sign-in commands (`--yes`, or no terminal). */
  unattended: boolean;
  /** Run one short turn of each signed-in agent (`--check`). */
  check: boolean;
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
  /** Asks the person; null when the terminal closed. */
  ask(step: JoinStep, prompt: string): Promise<string | null>;
  /** Something other than the checklist printed (an agent's sign-in): the next line starts a new block. */
  ran(): void;
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
  constructor(
    private readonly deps: ChecklistDeps,
    private readonly io: ChecklistIo,
    private readonly options: AgentsOptions,
  ) {}

  private say(step: JoinStep, line: JoinSay): void {
    this.io.say({ event: 'say', step, ...line });
  }

  /** Asks, unless unattended; true on a yes. */
  private async agreed(step: JoinStep, prompt: string): Promise<boolean> {
    return saidYes(await this.io.ask(step, `${prompt} [y/N] `));
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
      if (!this.options.unattended && !(await this.agreed(step, asked))) {
        this.say(step, { kind: 'line', text: `Left at ${move.from ?? 'the version it has'}. To move it later: ${agentCommand(agent)}` });
        return { facts, changed: false };
      }
    } else {
      this.say(step, { kind: 'line', text: 'Not installed.' });
      if (!this.options.unattended && !(await this.agreed(step, `Install ${label} ${pin} into ${folder} with npm?`))) {
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
    this.say(step, { kind: 'code', code: moveCommand(plan, (path) => tilde(path, this.deps.home)) });
    if (!(await this.agreed(step, 'Move it aside now with that command?'))) {
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
    this.say(step, { kind: 'line', text: facts.signedIn === false ? 'Not signed in.' : `${label} could not say whether it is signed in.` });
    if (this.options.unattended) {
      this.say(step, { kind: 'line', text: `To sign in, run ${agentCommand(agent)} in a terminal (it runs \`${signInCommand(agent)}\` there).` });
      return { signedIn: false, changed: false };
    }
    if (!(await this.agreed(step, `Sign in to ${label} now? It runs \`${signInCommand(agent)}\` in this terminal.`))) {
      this.say(step, { kind: 'line', text: `Not signed in. To sign in later: ${agentCommand(agent)}` });
      return { signedIn: false, changed: false };
    }
    this.say(step, { kind: 'wait', text: `${signInHelp(agent)} Kestrel sees none of it.` });
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

  /** What the running node now tells other devices about each agent. */
  async nodeSays(ends: readonly AgentEnd[]): Promise<NodeAgentState[] | null> {
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
      else if (state.problem?.trouble === 'data-version' && (await this.movedAside(0, end.agent))) {
        const again = (await this.deps.node([end.agent]))?.find((s) => s.agent === end.agent);
        if (again) states.splice(states.indexOf(state), 1, again);
        this.say(0, again?.canRun ? { kind: 'done', text: `${NODE_AGENT_LABEL[end.agent]} can run` } : { kind: 'line', text: again ? whyHere(again) : 'The node did not answer again.' });
      } else this.say(0, { kind: 'line', text: whyHere(state) });
    }
    return states;
  }

  async sandbox(): Promise<boolean> {
    const step = SANDBOX_STEP;
    const facts = await this.deps.sandbox();
    this.say(step, { kind: 'heading', text: 'Command sandbox' });
    if (facts.missing.length === 0) {
      this.say(step, { kind: 'done', text: 'bubblewrap and socat are installed' });
      if (facts.nodeHasIt === false) {
        this.say(step, { kind: 'line', text: 'The node started before they were installed. Restart it to use them:' });
        this.say(step, { kind: 'code', code: SANDBOX_RESTART });
        return false;
      }
      return true;
    }
    this.say(step, { kind: 'line', text: `${facts.missing.join(' and ')} ${facts.missing.length === 1 ? 'is' : 'are'} not installed. An administrator installs them with:` });
    this.say(step, { kind: 'code', code: facts.install ?? SANDBOX_INSTALL_UNKNOWN });
    this.say(step, { kind: 'line', text: WITHOUT_SANDBOX });
    this.say(step, { kind: 'line', text: 'After installing them, restart the node:' });
    this.say(step, { kind: 'code', code: SANDBOX_RESTART });
    return false;
  }
}

/** What each agent's own sign-in asks of the person (docs/spike-results.md, "Worker nodes"). */
export function signInHelp(agent: Agent): string {
  if (agent === 'claude') return 'Claude Code prints an address: open it on any device, sign in, and paste the code the page gives back here.';
  if (agent === 'codex') return "Codex prints a code: type it on the provider's device page, on any device. Nothing is pasted back here.";
  return 'OpenCode asks which provider to use, then for its key or sign-in.';
}

/** Runs the checklist; resolves with the exit code: 0 when everything shown is ready, 1 otherwise. */
export async function runAgentsChecklist(deps: ChecklistDeps, io: ChecklistIo, options: AgentsOptions): Promise<number> {
  const list = new Checklist(deps, io, options);
  const agents = options.only ? [options.only] : NODE_AGENTS;
  io.say({ event: 'say', step: 0, kind: 'heading', text: options.only ? `Kestrel worker node: ${NODE_AGENT_LABEL[options.only]} on ${deps.name}` : `Kestrel worker node: agents on ${deps.name}` });
  const ends: AgentEnd[] = [];
  for (const [i, agent] of agents.entries()) ends.push(await list.agent((options.only ? 1 : i + 1) as JoinStep, agent));
  const sandboxReady = options.only ? true : await list.sandbox();
  const states = await list.nodeSays(ends);
  const canRun = states ? ends.filter((e) => states.find((s) => s.agent === e.agent)?.canRun).length : null;
  const ready = ends.every((e) => e.ready) && (states === null || canRun === ends.length) && sandboxReady;
  const count = canRun === null ? `${ends.filter((e) => e.ready).length} of ${ends.length} signed in` : `${canRun} of ${ends.length} can run`;
  io.say({ event: 'end', ok: ready, text: options.only ? `${NODE_AGENT_LABEL[options.only]} on ${deps.name}: ${ready ? 'ready' : 'not ready yet'}.` : `Agents on ${deps.name}: ${count}.`, next: 'kestrel node status' });
  return ready ? 0 : 1;
}
