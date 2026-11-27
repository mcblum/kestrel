// `kestrel node configure`: the node's steps as one flow, in order (docs/designs/worker-nodes.md, section 8). What is left
// comes from the node itself every time (`status`, through shared/node-configure.ts), never from a remembered flag, so a
// second run picks up where the first stopped. Each step is the command it names (`kestrel node join`, `agents`, `git`),
// run in this terminal; what only an administrator can do is shown to paste and checked again on Enter, never run.
// Every step can be skipped. Drawn by `join`'s drawing function, from the same events (join-draw.ts).
import { nodeCommandLine, type JoinSay, type JoinStep, type NodeJoinEvent } from '../shared/node-commands.ts';
import { nextSetupStep, setupActionText, setupStepsOf, type SandboxHere, type SetupCommand, type SetupStep, type SetupStepId } from '../shared/node-configure.ts';
import type { NodeStatus } from '../shared/node-status.ts';
import { STOPPED_EXIT } from './join-client.ts';

export interface SetupDeps {
  /** The running node's status, or null when none answers. */
  status(): Promise<NodeStatus | null>;
  /** What this terminal sees of the sandbox's programs now. */
  sandboxHere(): SandboxHere;
  /** Resolves true once a node answers, false when `ms` passed first. */
  waitForNode(ms: number): Promise<boolean>;
  /** Why no node answers, and what to run (from the service's state). */
  notRunning(): Promise<string>;
  /** Runs `kestrel <command>` here, with the terminal; resolves with its exit code. */
  run(command: SetupCommand): Promise<number>;
  /** Restarts the node's service (no administrator needed). */
  restart(): Promise<{ ok: boolean; line: string }>;
}

export interface SetupIo {
  say(event: NodeJoinEvent): void;
  /** One answer from the keyboard; null when it closed. */
  ask(step: JoinStep, prompt: string): Promise<string | null>;
}

/** How long it waits for a node that does not answer yet (the install has just started it). */
export const SETUP_NODE_WAIT_MS = 30_000;
/** How long it waits for the node to answer again after a step or a restart. */
const AFTER_STEP_WAIT_MS = 30_000;

const SETUP_AGAIN = nodeCommandLine('configure');
const STATUS = nodeCommandLine('status');

type Outcome = 'next' | 'stop';

/** Holds the flow's state: the node's last status and what this run has offered. */
class Setup {
  status: NodeStatus;
  readonly offered = new Set<SetupStepId>();

  constructor(
    private readonly deps: SetupDeps,
    private readonly io: SetupIo,
    status: NodeStatus,
  ) {
    this.status = status;
  }

  steps(): SetupStep[] {
    return setupStepsOf(this.status, this.deps.sandboxHere());
  }

  step(id: SetupStepId): SetupStep {
    return this.steps().find((s) => s.id === id)!;
  }

  say(step: JoinStep, said: JoinSay): void {
    this.io.say({ event: 'say', step, ...said });
  }

  /** Reads the node again; a node that has stopped answering is waited for. False when it does not come back. */
  async refresh(): Promise<boolean> {
    const now = (await this.deps.status()) ?? ((await this.deps.waitForNode(AFTER_STEP_WAIT_MS)) ? await this.deps.status() : null);
    if (!now) return false;
    this.status = now;
    return true;
  }

  async ask(step: SetupStep, prompt: string): Promise<'go' | 'skip' | 'stop'> {
    const answer = await this.io.ask(step.number as JoinStep, prompt);
    if (answer === null) return 'stop';
    const word = answer.trim().toLowerCase();
    return word === 's' || word === 'skip' || word === 'n' || word === 'no' ? 'skip' : word === 'q' || word === 'quit' ? 'stop' : 'go';
  }

  /** A `kestrel` command, run here; then the node is asked whether it is done. */
  async runStep(step: SetupStep, command: SetupCommand): Promise<Outcome> {
    const n = step.number as JoinStep;
    const text = nodeCommandLine(command);
    const answer = await this.ask(step, `Press Enter to start (${text}), or s to skip: `);
    if (answer === 'stop') return 'stop';
    if (answer === 'skip') return this.say(n, { kind: 'line', text: `Skipped. "${text}" does it later.` }), 'next';
    const code = await this.deps.run(command);
    if (code === STOPPED_EXIT) return 'stop';
    if (!(await this.refresh())) return 'stop';
    const now = this.step(step.id);
    this.say(n, now.done ? { kind: 'done', text: `${now.title}: ${now.left}` } : { kind: 'line', text: `Not finished. "${text}" picks it up again.` });
    return 'next';
  }

  /** What only an administrator can do: shown to paste, then checked again each time Enter is pressed. */
  async adminStep(step: SetupStep): Promise<Outcome> {
    const n = step.number as JoinStep;
    this.say(n, { kind: 'line', text: 'This needs an administrator, so Kestrel does not run it. Run it in another terminal, or ask an administrator to:' });
    this.say(n, { kind: 'code', code: setupActionText(step.action!) });
    for (;;) {
      const answer = await this.ask(step, 'Press Enter to check again once it is done, or s to skip: ');
      if (answer === 'stop') return 'stop';
      if (answer === 'skip') return this.say(n, { kind: 'line', text: `Skipped. "${SETUP_AGAIN}" checks it again later.` }), 'next';
      if (!(await this.refresh())) return 'stop';
      const now = this.step(step.id);
      if (now.done) return this.say(n, { kind: 'done', text: now.left }), 'next';
      if (now.action?.kind === 'restart') return this.restartStep(now);
      this.say(n, { kind: 'line', text: `Not yet: ${now.left}` });
    }
  }

  /** bubblewrap and socat are there, but the node worked out the sandbox when it started: it restarts, on a yes. */
  async restartStep(step: SetupStep): Promise<Outcome> {
    const n = step.number as JoinStep;
    const answer = await this.ask(step, 'Restart the node now? Its sessions’ turns are ended cleanly first. [Y/n] ');
    if (answer === 'stop') return 'stop';
    if (answer === 'skip') return this.say(n, { kind: 'line', text: `Skipped. "${setupActionText({ kind: 'restart' })}" restarts it later.` }), 'next';
    const done = await this.deps.restart();
    this.say(n, done.ok ? { kind: 'done', text: done.line } : { kind: 'problem', text: done.line });
    if (!done.ok) return 'next';
    if (!(await this.refresh())) return 'stop';
    const now = this.step(step.id);
    this.say(n, now.done ? { kind: 'done', text: now.left } : { kind: 'line', text: `Not yet: ${now.left}` });
    return 'next';
  }

  async offer(step: SetupStep): Promise<Outcome> {
    this.offered.add(step.id);
    this.say(step.number as JoinStep, { kind: 'heading', text: step.title });
    this.say(step.number as JoinStep, { kind: 'line', text: step.left });
    const action = step.action!;
    if (action.kind === 'run') return this.runStep(step, action.command);
    if (action.kind === 'restart') return this.restartStep(step);
    return this.adminStep(step);
  }

  /** The closing lines: set up, or what is left with each command, and `kestrel node configure` to come back to it. */
  end(): number {
    const left = this.steps().filter((s) => !s.done);
    if (left.length === 0) {
      this.io.say({ event: 'end', ok: true, text: `${this.status.name} is set up.`, next: STATUS });
      return 0;
    }
    for (const s of left) this.say(0, { kind: 'line', text: `Left: ${s.title} (${setupActionText(s.action!)}).` });
    this.io.say({ event: 'end', ok: false, text: `${left.length} step${left.length === 1 ? '' : 's'} left. Run "${SETUP_AGAIN}" again to pick up where you left off.`, next: SETUP_AGAIN });
    return 1;
  }
}

/** With no terminal: nothing is asked; each step done, and for each one left what it is and the command. */
function listOnly(setup: Setup, io: SetupIo): number {
  const steps = setup.steps();
  for (const s of steps) {
    if (s.done) setup.say(0, { kind: 'done', text: `${s.title}: ${s.left}` });
    else {
      setup.say(s.number as JoinStep, { kind: 'heading', text: s.title });
      setup.say(s.number as JoinStep, { kind: 'line', text: s.left });
      setup.say(s.number as JoinStep, { kind: 'code', code: setupActionText(s.action!) });
    }
  }
  const left = steps.filter((s) => !s.done).length;
  if (left === 0) return io.say({ event: 'end', ok: true, text: `${setup.status.name} is set up.`, next: STATUS }), 0;
  setup.say(0, { kind: 'line', text: `Run "${SETUP_AGAIN}" in a terminal on this node to do them one at a time.` });
  io.say({ event: 'end', ok: false, text: `${left} step${left === 1 ? '' : 's'} left.`, next: SETUP_AGAIN });
  return 1;
}

/** Runs the setup. Resolves with the exit code: 0 set up, 1 something left, `STOPPED_EXIT` stopped. Never throws. */
export async function runSetup(deps: SetupDeps, io: SetupIo, options: { interactive: boolean }): Promise<number> {
  let status = await deps.status();
  if (!status) {
    io.say({ event: 'say', step: 0, kind: 'wait', text: 'Waiting for the node to answer…' });
    status = (await deps.waitForNode(SETUP_NODE_WAIT_MS)) ? await deps.status() : null;
  }
  if (!status) {
    io.say({ event: 'end', ok: false, text: `The node does not answer, so setup cannot ask it what is left. ${await deps.notRunning()}` });
    return 1;
  }
  const setup = new Setup(deps, io, status);
  io.say({ event: 'say', step: 0, kind: 'heading', text: `Kestrel worker node: set up ${status.name}` });
  if (!options.interactive) return listOnly(setup, io);
  for (const s of setup.steps()) setup.say(0, s.done ? { kind: 'done', text: `${s.title}: ${s.left}` } : { kind: 'line', text: `- ${s.title}: ${s.left}` });
  for (let step = nextSetupStep(setup.steps(), setup.offered); step; step = nextSetupStep(setup.steps(), setup.offered)) {
    if ((await setup.offer(step)) === 'stop') {
      io.say({ event: 'end', ok: false, text: `Stopped. "${SETUP_AGAIN}" picks up where you left off.` });
      return STOPPED_EXIT;
    }
  }
  return setup.end();
}
