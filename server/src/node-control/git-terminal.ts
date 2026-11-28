// `kestrel node git` in a real terminal: the checklist (git-checklist.ts) drawn as `agents` is, questions read from the
// keyboard one at a time, ssh-keygen, ssh, gh and glab run here with their output collected (git-programs.ts) except a
// tool's own sign-in, which has the terminal, and the running node asked for its part over its socket. With `--yes`,
// or when input or output is not a terminal, nothing is asked.
import { computerName } from '../connect/link/start.ts';
import type { NodeGitFacts } from '../shared/node-commands.ts';
import type { GitArgs } from './args.ts';
import { runProgram } from './agents-programs.ts';
import { terminalIo, type NestedIn } from './agents-terminal.ts';
import { askNode, nodeAnswers } from './client.ts';
import type { ChecklistIo } from './agents-checklist.ts';
import { runGitChecklist } from './git-checklist.ts';
import { gitPrograms, type GitPrograms } from './git-programs.ts';
import { nodeSocketPath } from './socket-path.ts';
import { toolPins } from './tool-pins.ts';
import { concludeOwn } from './join-terminal.ts';
import { onScreen as runOnScreen, openWorkerSession } from './worker-onboarding/open.ts';
import type { WorkerSession } from './worker-onboarding/session.ts';
import type { GitTool } from '../shared/node-git-tools.ts';

/** The checklist's parts, as the screen's progress line names them (git-checklist.ts). */
const GIT_SECTIONS = ["This node's key", 'Where your repositories are', 'Signing and your name', 'At your git hosts', 'Commit email', 'Still to do'];

/** What stays above a tool's own sign-in while it has the terminal. */
const signInNotice = (tool: GitTool, host: string): string => `${tool}'s sign-in for ${host} has this terminal now. Kestrel reads no token.`;

/** A tool's own sign-in has the terminal: the screen lets go first and comes back when it ends. */
function signInOnScreen(programs: GitPrograms, screen: WorkerSession | null): GitPrograms {
  if (!screen) return programs;
  return { ...programs, signIn: (tool, host, signing) => screen.handoff(signInNotice(tool, host), () => programs.signIn(tool, host, signing)) };
}

/** The node's part, or null when no node answers (or it refuses). Never rejects. */
async function fromNode(path: string): Promise<NodeGitFacts | null> {
  if (!(await nodeAnswers(path))) return null;
  const reply = await askNode(path, 'git').catch(() => null);
  return reply?.ok && reply.git ? reply.git : null;
}

/**
 * `nested`: inside `kestrel node configure`, drawn under its section (and on its screen; agents-terminal.ts). Run alone
 * at a terminal that can, with questions to ask, it opens a screen of its own.
 */
export async function gitFromTerminal(home: string, dataDir: string, args: GitArgs, nested: NestedIn | null = null): Promise<number> {
  const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const unattended = args.yes || !terminal;
  const path = nodeSocketPath(dataDir);
  const pins = toolPins(home);
  const own = nested || unattended ? null : await openWorkerSession({ name: 'Set up Git', node: computerName(), sections: GIT_SECTIONS, stoppedText: 'Stopped.' });
  const screen = nested?.screen ?? own;
  const io: ChecklistIo = nested?.io ?? own?.io() ?? terminalIo();
  return runOnScreen(own, async () => {
    const code = await runGitChecklist(
      {
        programs: signInOnScreen(gitPrograms({ dataDir, env: process.env, run: runProgram, pins, arch: process.arch }), screen),
        pins,
        node: () => fromNode(path),
        name: computerName(),
        home,
        now: Date.now,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
      io,
      { unattended, manual: args.manual },
    );
    if (own) await concludeOwn(own, code);
    return code;
  });
}
