// `kestrel node configure`: the node's steps as one flow (docs/designs/worker-nodes.md, section 8, and
// docs/designs/worker-terminal-handoff.md). What is left comes from the node itself every time (`status`, through
// shared/node-configure.ts), never from a remembered flag, so a second run picks up where the first stopped.
//
// What needs an administrator comes first, while the person is still at the keyboard: lingering and the sandbox's
// programs are found, said with what happens without them, and offered once, as one yes. On that yes sudo checks the
// password itself (`sudo -v`, its own prompt on this terminal), the commands run at once, and the node restarts when
// it needs to, so the slow steps after it (the account, agents, git) never stand between the person and the password.
// Root runs them without sudo; with no sudo they are shown for an administrator and checked again on Enter. Then each
// of the account, agents and git is the command it names, run in this terminal and drawn under its section. Every
// step can be skipped; with no terminal nothing is asked or run, and what is left is listed with each command.
import { nodeCommandLine, type JoinStep, type NodeJoinEvent } from '../shared/node-commands.ts';
import { adminCommandHere, adminPlanOf, NO_SUDO, SETUP_SECTIONS, setupActionText, setupStepsOf, type AdminPlan, type AdminRunner, type SandboxHere, type SetupCommand, type SetupStep, type SetupStepId } from '../shared/node-configure.ts';
import type { NodeStatus } from '../shared/node-status.ts';
import { STOPPED_EXIT } from './join-client.ts';
import { confirm, type AskHint, type TrustDetail } from './worker-onboarding/ask.ts';
import { NODE_UNIT_NAME } from '../shared/node-service.ts';

/** What the restart runs (service.ts), as shown before the yes. */
const RESTART_COMMAND = `systemctl --user restart ${NODE_UNIT_NAME}`;

export interface AdminRun {
  ok: boolean;
  /** Why it failed, as a sentence; empty when it did not. */
  reason: string;
  /** The last lines it printed, when it failed. */
  output: string[];
}

export interface SetupDeps {
  /** The running node's status, or null when none answers. */
  status(): Promise<NodeStatus | null>;
  /** What this terminal sees of the sandbox's programs now. */
  sandboxHere(): SandboxHere;
  /** Resolves true once a node answers, false when `ms` passed first. */
  waitForNode(ms: number): Promise<boolean>;
  /** Why no node answers, and what to run (from the service's state). */
  notRunning(): Promise<string>;
  /** Runs `kestrel node <command>` here, with the terminal, drawn under section `section`; resolves with its exit code. */
  run(command: SetupCommand, section: JoinStep): Promise<number>;
  /** Restarts the node's service (no administrator needed). */
  restart(): Promise<{ ok: boolean; line: string }>;
  /** Who can run an administrator's command here. */
  adminRunner(): AdminRunner;
  /** sudo's own password check, on this terminal (`sudo -v`). True when it accepted. */
  sudoValidate(): Promise<boolean>;
  /** Runs one administrator's command on this terminal, its output collected. */
  runAdmin(argv: readonly string[]): Promise<AdminRun>;
}

export interface SetupIo {
  say(event: NodeJoinEvent): void;
  /** One answer from the keyboard; null when it closed. `hint`: what kind of question, for the interactive screen. */
  ask(step: JoinStep, prompt: string, hint?: AskHint): Promise<string | null>;
  /** The screen draws a question's choices itself: typing help is left out. */
  readonly drawsChoices?: boolean;
}

/** How long it waits for a node that does not answer yet (the install has just started it). */
export const SETUP_NODE_WAIT_MS = 30_000;
/** How long it waits for the node to answer again after a step or a restart. */
const AFTER_STEP_WAIT_MS = 30_000;

const SETUP_AGAIN = nodeCommandLine('configure');
const STATUS = nodeCommandLine('status');
const SYSTEM: JoinStep = 1;

type Outcome = 'next' | 'stop';
type Answer = 'yes' | 'no' | 'stop';

/** Enter or y is yes; n or s is no; q is quit; a closed keyboard is quit. Anything else is asked again. */
export function answerOf(answer: string | null): Answer | null {
  if (answer === null) return 'stop';
  const word = answer.trim().toLowerCase();
  if (word === '' || word === 'y' || word === 'yes') return 'yes';
  if (word === 'n' || word === 'no' || word === 's' || word === 'skip') return 'no';
  if (word === 'q' || word === 'quit') return 'stop';
  return null;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** No sudo: Enter checks again once an administrator ran the commands. */
const CHECK_AGAIN: AskHint = {
  kind: 'choose',
  choices: [
    { answer: '', label: 'Check again', note: 'once an administrator has run them' },
    { answer: 'n', label: 'Skip', shortcut: 'n' },
  ],
  initial: '',
};

/** What the administrator's commands do, where and why, before the one yes. */
function adminTrust(plan: AdminPlan, runner: AdminRunner): TrustDetail {
  const doing = plan.needs.map((n) => (n.id === 'lingering' ? 'keep the node running after you log out' : 'install bubblewrap and socat for the command sandbox'));
  return {
    label: 'Administrator changes',
    action: `${doing.join(', and ').replace(/^./, (c) => c.toUpperCase())}${plan.restart ? ', then restart the node' : ''}.`,
    destination: runner === 'sudo' ? 'This computer, as root through sudo. sudo asks for your password itself; Kestrel never reads it.' : 'This computer, as root.',
    reason: plan.needs.map((n) => n.text).join(' '),
    commands: [...plan.commands.map((c) => c.text), ...(plan.restart ? [RESTART_COMMAND] : [])],
  };
}

function restartTrust(name: string): TrustDetail {
  return { label: 'Restart the node', action: 'Restart the node so it uses the command sandbox.', destination: `${name}, this computer.`, reason: 'The node works out its sandbox when it starts. Turns that are running end cleanly first.', commands: [RESTART_COMMAND] };
}

function joinTrust(name: string, left: string): TrustDetail {
  return {
    label: 'Connect to your account',
    action: `Sign ${name} in to Kestrel Connect and ask to join your account.`,
    destination: 'Your Kestrel account. A device already in it lets this node in with a code.',
    reason: left,
  };
}

/** Holds the flow's state: the node's last status. */
class Setup {
  status: NodeStatus;

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

  say(step: JoinStep, kind: 'heading' | 'line' | 'wait' | 'done' | 'problem' | 'quote', text: string): void {
    this.io.say({ event: 'say', step, kind, text });
  }

  code(step: JoinStep, code: string): void {
    this.io.say({ event: 'say', step, kind: 'code', code });
  }

  /** Reads the node again; a node that has stopped answering is waited for. False when it does not come back. */
  async refresh(): Promise<boolean> {
    const now = (await this.deps.status()) ?? ((await this.deps.waitForNode(AFTER_STEP_WAIT_MS)) ? await this.deps.status() : null);
    if (!now) return false;
    this.status = now;
    return true;
  }

  /** A question with a yes by default; asked again (up to three times) when the answer is not one. */
  async yes(step: JoinStep, prompt: string, hint: AskHint = confirm(true)): Promise<Answer> {
    for (let i = 0; i < 3; i++) {
      const answer = answerOf(await this.io.ask(step, prompt, hint));
      if (answer) return answer;
      if (!this.io.drawsChoices) this.say(step, 'line', 'Press Enter for yes, n to skip, or q to stop.');
    }
    return 'no';
  }

  /** What the System section's steps are now: a tick each that is done, the reason each that is not. */
  private systemNow(): void {
    for (const s of this.steps().filter((s) => s.number === SYSTEM)) this.say(SYSTEM, s.done ? 'done' : 'line', s.left);
  }

  /** The administrator's commands, run now, one after the other; then the restart, when the plan has one. */
  private async apply(plan: AdminPlan, runner: AdminRunner): Promise<Outcome> {
    if (plan.commands.length > 0 && runner === 'sudo' && !(await this.deps.sudoValidate())) {
      this.say(SYSTEM, 'problem', `sudo did not accept, so nothing was changed. "${SETUP_AGAIN}" offers this again.`);
      return 'next';
    }
    let sandboxInstalled = true;
    for (const command of plan.commands) {
      if (command.id === 'sandbox') this.say(SYSTEM, 'wait', 'Installing bubblewrap and socat…');
      const done = await this.deps.runAdmin(command.argv);
      if (done.ok) continue;
      if (command.id === 'sandbox') sandboxInstalled = false;
      this.say(SYSTEM, 'problem', `${command.text} did not finish: ${done.reason}${done.output.length > 0 ? ' The last lines it printed:' : ''}`);
      for (const line of done.output) this.say(SYSTEM, 'quote', line);
    }
    if (plan.restart && sandboxInstalled && this.deps.sandboxHere().missing.length === 0) {
      this.say(SYSTEM, 'wait', 'Restarting the node…');
      const restarted = await this.deps.restart();
      if (!restarted.ok) this.say(SYSTEM, 'problem', restarted.line);
    }
    if (!(await this.refresh())) return 'stop';
    this.systemNow();
    return 'next';
  }

  /** No sudo: the commands are shown for an administrator, and checked again each time Enter is pressed. */
  private async byAdministrator(plan: AdminPlan): Promise<Outcome> {
    for (;;) {
      const answer = await this.yes(SYSTEM, 'Press Enter to check again once they are done, or n to skip: ', CHECK_AGAIN);
      if (answer === 'stop') return 'stop';
      if (answer === 'no') return this.say(SYSTEM, 'line', `Skipped. "${SETUP_AGAIN}" offers this again.`), 'next';
      if (!(await this.refresh())) return 'stop';
      const now = adminPlanOf(this.steps(), 'none');
      if (!now || now.commands.length === 0) {
        if (!now?.restart) return this.systemNow(), 'next';
        // Installed by the administrator: the restart that is left needs no one else, only a yes.
        const restart = await this.yes(SYSTEM, 'Restart the node now so it uses them? Turns that are running end cleanly first. [Y/n] ', confirm(true, { yes: 'Restart now', no: 'Skip', trust: restartTrust(this.status.name) }));
        if (restart === 'stop') return 'stop';
        if (restart === 'no') return this.say(SYSTEM, 'line', `Skipped. "${SETUP_AGAIN}" offers this again.`), 'next';
        return this.apply(now, 'none');
      }
      if (now.commands.length < plan.commands.length) this.systemNow();
      else this.say(SYSTEM, 'line', 'Not yet.');
    }
  }

  /** 1, System: found first, said with what happens without each, offered once. */
  async system(): Promise<Outcome> {
    const runner = this.deps.adminRunner();
    const plan = adminPlanOf(this.steps(), runner);
    if (!plan) return 'next';
    this.say(SYSTEM, 'heading', SETUP_SECTIONS[SYSTEM]!);
    for (const need of plan.needs) this.say(SYSTEM, 'line', need.text);
    for (const line of plan.cannot) this.say(SYSTEM, 'line', line);
    if (!plan.canRun) {
      this.say(SYSTEM, 'line', NO_SUDO);
      this.code(SYSTEM, plan.commands.map((c) => c.text).join('\n'));
      return this.byAdministrator(plan);
    }
    if (plan.commands.length > 0) {
      this.say(SYSTEM, 'line', plan.commands.length === 1 ? 'Kestrel can run this now:' : 'Kestrel can run these now:');
      this.code(SYSTEM, plan.commands.map((c) => c.text).join('\n'));
    }
    if (plan.commands.length === 0 && !plan.restart) return 'next';
    if (plan.restart) this.say(SYSTEM, 'line', `${plan.commands.length > 0 ? 'Then it restarts' : 'Kestrel can restart'} the node so it uses the sandbox. Turns that are running end cleanly first.`);
    const prompt = plan.commands.length === 0 ? 'Restart the node now? [Y/n] ' : runner === 'sudo' ? `Run ${plan.commands.length === 1 ? 'it' : 'them'} now? sudo asks for your password if it needs it. [Y/n] ` : `Run ${plan.commands.length === 1 ? 'it' : 'them'} now? [Y/n] `;
    const hint = plan.commands.length === 0
      ? confirm(true, { yes: 'Restart now', no: 'Skip', trust: restartTrust(this.status.name) })
      : confirm(true, { yes: runner === 'sudo' ? 'Run them with sudo' : 'Run them now', no: 'Skip', trust: adminTrust(plan, runner) });
    const answer = await this.yes(SYSTEM, prompt, hint);
    if (answer === 'stop') return 'stop';
    if (answer === 'no') return this.say(SYSTEM, 'line', `Skipped. "${SETUP_AGAIN}" offers this again.`), 'next';
    return this.apply(plan, runner);
  }

  /** 2 to 4: the command the step names, run here under its section; asked first only for the account. */
  async run(step: SetupStep, command: SetupCommand): Promise<Outcome> {
    const section = step.number as JoinStep;
    this.say(section, 'heading', SETUP_SECTIONS[section]!);
    if (command === 'join') {
      this.say(section, 'line', step.left);
      const answer = await this.yes(section, 'Sign in and join now? [Y/n] ', confirm(true, { yes: 'Sign in and join', no: 'Skip for now', trust: joinTrust(this.status.name, step.left) }));
      if (answer === 'stop') return 'stop';
      if (answer === 'no') return this.say(section, 'line', `Skipped. "${nodeCommandLine('join')}" does it later.`), 'next';
    }
    const code = await this.deps.run(command, section);
    if (code === STOPPED_EXIT) return 'stop';
    if (!(await this.refresh())) return 'stop';
    return 'next';
  }

  /** The closing lines: set up; or what is left, each with its command, and configure to come back to it. */
  end(): number {
    const left = this.steps().filter((s) => !s.done);
    if (left.length === 0) {
      this.io.say({ event: 'end', ok: true, text: `${this.status.name} is set up.`, next: STATUS });
      return 0;
    }
    this.leftToDo(left);
    this.io.say({ event: 'end', ok: false, text: `${plural(left.length, 'step', 'steps')} left. Run "${SETUP_AGAIN}" again to finish.`, next: SETUP_AGAIN });
    return 1;
  }

  /** What is left, one line each: its name and the command that does it, the commands in one column. */
  leftToDo(left: readonly SetupStep[]): void {
    this.say(0, 'heading', 'Left to do');
    const width = Math.max(...left.map((s) => s.title.length)) + 1;
    const runner = this.deps.adminRunner();
    for (const s of left) this.io.say({ event: 'say', step: 1, kind: 'field', label: s.title.padEnd(width), value: adminCommandHere(setupActionText(s.action!), runner) });
  }

  /** One line for what is done already, when anything is. */
  alreadyDone(): void {
    const done = this.steps().filter((s) => s.done && s.id !== 'lingering' && s.id !== 'sandbox').map((s) => s.title);
    const system = this.steps().filter((s) => s.number === SYSTEM);
    if (system.every((s) => s.done)) done.unshift(SETUP_SECTIONS[SYSTEM]!);
    if (done.length > 0 && done.length < 4) this.say(0, 'done', `Already done: ${done.join(', ')}.`);
  }
}

/** With no terminal: nothing is asked or run; what is left, each with its command. */
function listOnly(setup: Setup, io: SetupIo): number {
  const left = setup.steps().filter((s) => !s.done);
  if (left.length === 0) return io.say({ event: 'end', ok: true, text: `${setup.status.name} is set up.`, next: STATUS }), 0;
  setup.alreadyDone();
  setup.leftToDo(left);
  io.say({ event: 'end', ok: false, text: `${plural(left.length, 'step', 'steps')} left. Run "${SETUP_AGAIN}" in a terminal on this node to do them.`, next: SETUP_AGAIN });
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
  setup.alreadyDone();
  const stopped = () => (io.say({ event: 'end', ok: false, text: `Stopped. "${SETUP_AGAIN}" picks up where you left off.` }), STOPPED_EXIT);
  if ((await setup.system()) === 'stop') return stopped();
  for (const id of ['join', 'agents', 'git'] as const) {
    const step = setup.step(id);
    if (step.done || step.action?.kind !== 'run') continue;
    if ((await setup.run(step, step.action.command)) === 'stop') return stopped();
  }
  return setup.end();
}
