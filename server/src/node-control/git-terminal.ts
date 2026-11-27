// `kestrel node git` in a real terminal: the checklist (git-checklist.ts) drawn as `agents` is, questions read from the
// keyboard one at a time, ssh-keygen, ssh, gh and glab run here with their output collected (git-programs.ts) except a
// tool's own sign-in, which has the terminal, and the running node asked for its part over its socket. With `--yes`,
// or when input or output is not a terminal, nothing is asked.
import { computerName } from '../connect/link/start.ts';
import type { NodeGitFacts } from '../shared/node-commands.ts';
import type { GitArgs } from './args.ts';
import { runProgram } from './agents-programs.ts';
import { terminalIo } from './agents-terminal.ts';
import { askNode, nodeAnswers } from './client.ts';
import type { ChecklistIo } from './agents-checklist.ts';
import { runGitChecklist } from './git-checklist.ts';
import { gitPrograms } from './git-programs.ts';
import { nodeSocketPath } from './socket-path.ts';
import { toolPins } from './tool-pins.ts';

/** The node's part, or null when no node answers (or it refuses). Never rejects. */
async function fromNode(path: string): Promise<NodeGitFacts | null> {
  if (!(await nodeAnswers(path))) return null;
  const reply = await askNode(path, 'git').catch(() => null);
  return reply?.ok && reply.git ? reply.git : null;
}

/** `io`: where it is drawn; `kestrel node configure` passes its own (agents-terminal.ts). */
export async function gitFromTerminal(home: string, dataDir: string, args: GitArgs, io: ChecklistIo = terminalIo()): Promise<number> {
  const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const path = nodeSocketPath(dataDir);
  const pins = toolPins(home);
  return runGitChecklist(
    {
      programs: gitPrograms({ dataDir, env: process.env, run: runProgram, pins, arch: process.arch }),
      pins,
      node: () => fromNode(path),
      name: computerName(),
      home,
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    io,
    { unattended: args.yes || !terminal, manual: args.manual },
  );
}
