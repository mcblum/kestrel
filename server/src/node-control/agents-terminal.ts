// `kestrel node agents` in a real terminal: the checklist (agents-checklist.ts) drawn as `join` is (join-draw.ts),
// questions read from the keyboard one at a time, the agents' own programs run here with the terminal handed to them
// (agents-programs.ts), and the running node asked for its part over its socket. With `--yes`, or when input or
// output is not a terminal, nothing is asked: what is missing is installed and the sign-in commands are printed.
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import { computerName } from '../connect/link/start.ts';
import { nodeAgentsEnv } from '../agents/kestrel-agents.ts';
import type { JoinStep, NodeJoinEvent } from '../shared/node-commands.ts';
import { missingSandboxPackages, sandboxInstallCommand } from '../shared/node-sandbox.ts';
import type { AgentsArgs } from './args.ts';
import type { Agent } from '../model.ts';
import { NODE_AGENT_LABEL } from '../shared/node-agents.ts';
import { runAgentsChecklist, signInHelp, type ChecklistDeps, type ChecklistIo, type SandboxFacts } from './agents-checklist.ts';
import { concludeOwn } from './join-terminal.ts';
import { onScreen as runOnScreen, openWorkerSession } from './worker-onboarding/open.ts';
import type { WorkerSession } from './worker-onboarding/session.ts';
import { agentPins } from './agent-pins.ts';
import { agentPrograms, runProgram } from './agents-programs.ts';
import { askNode, nodeAnswers } from './client.ts';
import { drawJoinEvent, JOIN_DRAW_START, nestedEvent, terminalJoinStyle, type DrawEvent, type JoinStyle } from './join-draw.ts';
import { STOPPED_EXIT } from './join-client.ts';
import { nodeSocketPath } from './socket-path.ts';

type Env = Record<string, string | undefined>;

/** Whether a program is on the PATH the node's agents run with. */
export const onPath = (env: Env) => (program: string): boolean => (env.PATH ?? '').split(delimiter).filter(Boolean).some((dir) => existsSync(join(dir, program)));

/** What the running node says, or null when none answers (or it refuses). Never rejects. */
async function fromNode<T>(path: string, ask: () => Promise<T | null>): Promise<T | null> {
  if (!(await nodeAnswers(path))) return null;
  return ask().catch(() => null);
}

/** The checklist's effects, for real, at `dataDir`. */
export async function terminalDeps(home: string, dataDir: string, env: Env = process.env): Promise<ChecklistDeps> {
  const path = nodeSocketPath(dataDir);
  const status = await fromNode(path, async () => {
    const reply = await askNode(path, 'status');
    return reply.ok && reply.status ? reply.status : null;
  });
  const has = onPath(nodeAgentsEnv(env, dataDir));
  return {
    programs: agentPrograms({ dataDir, env, run: runProgram }),
    pins: agentPins(home),
    node: (recheck) =>
      fromNode(path, async () => {
        const reply = await askNode(path, 'agents', recheck);
        return reply.ok && reply.agents ? reply.agents : null;
      }),
    sandbox: async (): Promise<SandboxFacts> => ({ missing: missingSandboxPackages(has), install: sandboxInstallCommand(has), nodeHasIt: status ? status.sandbox.available : null }),
    name: status?.name ?? computerName(),
    home,
  };
}

/** Draws the checklist's events on this terminal; inside configure's section `section`, under it (`nestedEvent`). */
function drawer(style: JoinStyle, section: JoinStep | null): Pick<ChecklistIo, 'say' | 'ran'> & { prompt(step: JoinStep, prompt: string): string; asked(): void } {
  // Inside configure the section's heading is above: the checklist's first part is set off from it.
  let state = section === null ? JOIN_DRAW_START : { printed: true, blank: false };
  const draw = (given: NodeJoinEvent) => {
    const event: DrawEvent | null = section === null ? given : nestedEvent(given, section);
    if (!event) return { lines: [], toErr: false, prompt: null, state };
    const drawn = drawJoinEvent(event, state, style);
    for (const line of drawn.lines) (drawn.toErr ? console.error : console.log)(line);
    state = drawn.state;
    return drawn;
  };
  return {
    say: draw,
    ran: () => (state = { printed: true, blank: false }),
    prompt: (step, prompt) => draw({ event: 'ask', step, prompt }).prompt ?? prompt,
    asked: () => (state = { printed: true, blank: false }),
  };
}

/** One question, from a reader opened for it and closed after, so an agent's sign-in gets the keyboard to itself. */
function askOnce(prompt: string, terminal: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const lines = createInterface({ input: process.stdin, output: process.stdout, terminal });
    let answered = false;
    const stopped = () => {
      lines.close();
      console.log('');
      console.error('Stopped.');
      process.exit(STOPPED_EXIT);
    };
    lines.on('SIGINT', stopped);
    process.once('SIGINT', stopped);
    lines.once('close', () => {
      process.off('SIGINT', stopped);
      if (!answered) resolve(null);
    });
    lines.question(prompt, (answer) => {
      answered = true;
      lines.close();
      resolve(answer);
    });
  });
}

/**
 * The checklists' terminal: events drawn as `join` draws them, one question at a time from the keyboard. `section`:
 * drawn inside that section of `kestrel node configure`, its title left out and its own parts as subheadings.
 */
export function terminalIo(section: JoinStep | null = null): ChecklistIo {
  const style = terminalJoinStyle();
  const draw = drawer(style, section);
  return {
    say: draw.say,
    ran: draw.ran,
    ask: async (step, prompt) => {
      const answer = await askOnce(draw.prompt(step, prompt), !style.plain && process.stdin.isTTY === true);
      draw.asked();
      return answer;
    },
  };
}

/** An agent's own sign-in has the terminal: the screen lets go first and comes back when it ends. */
function signInOnScreen(deps: ChecklistDeps, screen: WorkerSession): ChecklistDeps {
  const { programs } = deps;
  return { ...deps, programs: { ...programs, signIn: (agent) => screen.handoff(signInNotice(agent), () => programs.signIn(agent)) } };
}

/** What stays above an agent's own sign-in while it has the terminal. */
const signInNotice = (agent: Agent): string => `${NODE_AGENT_LABEL[agent]}'s sign-in has this terminal now. ${signInHelp(agent)} Kestrel sees none of it.`;

/** Where a command run inside configure is drawn: its section's io, and configure's screen when it has one. */
export interface NestedIn {
  io: ChecklistIo;
  screen: WorkerSession | null;
}

/**
 * `nested`: inside `kestrel node configure`, drawn under its section (and on its screen). `sandbox`: whether the command
 * sandbox is reported (configure has dealt with it already, in its System section). Run alone at a terminal that can,
 * with questions to ask, it opens a screen of its own.
 */
export async function agentsFromTerminal(home: string, dataDir: string, args: AgentsArgs, nested: NestedIn | null = null, sandbox = true): Promise<number> {
  const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const unattended = args.yes || !terminal;
  const deps = await terminalDeps(home, dataDir);
  const own = nested || unattended ? null : await openWorkerSession({ name: 'Set up agents', node: deps.name, sections: 'seen', stoppedText: 'Stopped.' });
  const screen = nested?.screen ?? own;
  const io = nested?.io ?? own?.io() ?? terminalIo();
  return runOnScreen(own, async () => {
    const code = await runAgentsChecklist(screen ? signInOnScreen(deps, screen) : deps, io, { only: args.only, unattended, check: args.check, sandbox });
    if (own) await concludeOwn(own, code);
    return code;
  });
}
