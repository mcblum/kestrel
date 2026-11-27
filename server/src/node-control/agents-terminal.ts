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
import { runAgentsChecklist, type ChecklistDeps, type ChecklistIo, type SandboxFacts } from './agents-checklist.ts';
import { agentPins } from './agent-pins.ts';
import { agentPrograms, runProgram } from './agents-programs.ts';
import { askNode, nodeAnswers } from './client.ts';
import { drawJoinEvent, JOIN_DRAW_START, joinStyleOf, type JoinStyle } from './join-draw.ts';
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

/** Draws the checklist's events on this terminal. */
function drawer(style: JoinStyle): Pick<ChecklistIo, 'say' | 'ran'> & { prompt(step: JoinStep, prompt: string): string; asked(): void } {
  let state = JOIN_DRAW_START;
  return {
    say: (event: NodeJoinEvent) => {
      const drawn = drawJoinEvent(event, state, style);
      for (const line of drawn.lines) (drawn.toErr ? console.error : console.log)(line);
      state = drawn.state;
    },
    ran: () => (state = { printed: true, blank: false }),
    prompt: (step, prompt) => drawJoinEvent({ event: 'ask', step, prompt }, state, style).prompt ?? prompt,
    asked: () => (state = { printed: true, blank: false }),
  };
}

/** One question, from a reader opened for it and closed after, so an agent's sign-in gets the keyboard to itself. */
function askOnce(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const lines = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let answered = false;
    lines.on('SIGINT', () => {
      lines.close();
      console.log('');
      console.error('Stopped.');
      process.exit(STOPPED_EXIT);
    });
    lines.once('close', () => !answered && resolve(null));
    lines.question(prompt, (answer) => {
      answered = true;
      lines.close();
      resolve(answer);
    });
  });
}

/** The checklists' terminal: events drawn as `join` draws them, one question at a time from the keyboard. */
export function terminalIo(): ChecklistIo {
  const style = joinStyleOf({ isTTY: process.stdout.isTTY === true, columns: process.stdout.columns }, process.env);
  const draw = drawer(style);
  return {
    say: draw.say,
    ran: draw.ran,
    ask: async (step, prompt) => {
      const answer = await askOnce(draw.prompt(step, prompt));
      draw.asked();
      return answer;
    },
  };
}

/** `io`: where it is drawn; `kestrel node configure` passes its own, which leaves out the "Next:" line (setup says what is next). */
export async function agentsFromTerminal(home: string, dataDir: string, args: AgentsArgs, io: ChecklistIo = terminalIo()): Promise<number> {
  const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
  return runAgentsChecklist(await terminalDeps(home, dataDir), io, { only: args.only, unattended: args.yes || !terminal, check: args.check });
}
