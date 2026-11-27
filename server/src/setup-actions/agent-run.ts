// What a session started by Ask the agent may run, once the person said yes on its card
// (docs/designs/onboarding.md, 18.14). A command the agent worked out runs as the user from its argument
// list, never through a shell Kestrel adds, in a folder inside this home folder, with the step time limit,
// standard input closed and git told never to ask. A step runs through SetupSteps.runLine, the same
// function as the page's Run. Who may call, Bypass and the card are decided before either is reached.
import { Refused } from '../refused.ts';
import { adminCommandRefusal } from '../shared/setup-agent.ts';
import { homePathHere, LIMIT } from './execute.ts';
import type { CommandRunner } from './io.ts';
import { OUTPUT_LINES } from './steps.ts';

export interface AgentCommandDeps {
  home: string;
  run: CommandRunner;
}

/** Checks a command an agent asked to run: why it may not, or the folder it runs in. Pure apart from nothing. */
export function agentCommandPlan(argv: readonly string[], cwd: string | undefined, home: string): { cwd: string } {
  const refused = adminCommandRefusal(argv);
  if (refused) throw new Refused(refused);
  if (cwd === undefined || cwd === '' || cwd === '~') return { cwd: home };
  const full = homePathHere(cwd.startsWith('~') || cwd.startsWith('/') ? cwd : `~/${cwd}`, home);
  if (!full) throw new Refused('cwd must be a folder inside the home folder.');
  return { cwd: full };
}

/** Runs it and answers what the agent is told: the exit code and the last lines of output. */
export async function runAgentCommand(deps: AgentCommandDeps, argv: readonly string[], cwd: string): Promise<string> {
  let output = '';
  const outcome = await deps.run(argv, { cwd, timeoutMs: LIMIT.install, env: { GIT_TERMINAL_PROMPT: '0' }, output: (text) => (output += text) });
  const lines = output.split(/\r?\n/).filter((l, i, all) => l.length > 0 || i < all.length - 1).slice(-OUTPUT_LINES).join('\n');
  const head = outcome.problem ? `It did not finish: ${outcome.problem}` : `It ended with exit code ${outcome.code}.`;
  return lines ? `${head}\nLast output:\n${lines}` : head;
}
