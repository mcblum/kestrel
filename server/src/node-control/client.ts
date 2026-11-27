// The terminal's side of the control socket: `kestrel-node status` and `kestrel-node stop` ask a running node and
// print its answer. When no node is running, a plain sentence and a non-zero exit, never a stack trace.
import { connect } from 'node:net';
import type { Agent } from '../model.ts';
import type { NodeCommand, NodeReply } from '../shared/node-commands.ts';
import { statusLines, type NodeStatus } from '../shared/node-status.ts';

const ANSWER_TIMEOUT_MS = 10_000;
/** Uninstalling asks git about every worktree and the service to remove the node, `agents` starts each agent to ask it, and `git` reads the other computers' records: they are given longer. */
const SLOW_ANSWER_MS: Partial<Record<NodeCommand, number>> = { uninstall: 120_000, agents: 60_000, git: 30_000 };

export const noNodeRunning = (path: string): string => `No worker node is running here: nothing answers at ${path}. Start it with "kestrel-node run".`;

/**
 * Sends one command and resolves with the node's answer, or rejects with a sentence saying why there is none.
 * `recheck` goes with `agents` only: the agents the terminal just changed (shared/node-commands.ts).
 */
export function askNode(path: string, command: NodeCommand, recheck?: readonly Agent[]): Promise<NodeReply<NodeStatus>> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let received = '';
    socket.setEncoding('utf8');
    socket.setTimeout(SLOW_ANSWER_MS[command] ?? ANSWER_TIMEOUT_MS, () => (socket.destroy(), reject(new Error('The node did not answer in time.'))));
    socket.once('connect', () => socket.write(`${JSON.stringify(command === 'agents' && recheck ? { command, recheck } : { command })}\n`));
    socket.on('data', (chunk: string) => (received += chunk));
    socket.once('error', (error: NodeJS.ErrnoException) => reject(new Error(error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? noNodeRunning(path) : `Could not reach the node at ${path}: ${error.message}`)));
    socket.once('close', () => {
      try {
        resolve(JSON.parse(received) as NodeReply<NodeStatus>);
      } catch {
        reject(new Error('The node closed the connection without an answer.'));
      }
    });
  });
}

/** What a command prints and the exit code: 0 when the node answered ok, 1 otherwise. */
export function outcomeOf(reply: NodeReply<NodeStatus>): { lines: string[]; code: number; stderr: boolean } {
  if (!reply.ok) return { lines: [reply.reason], code: 1, stderr: true };
  if (reply.status) return { lines: statusLines(reply.status), code: 0, stderr: false };
  return { lines: [reply.message ?? 'Done.'], code: 0, stderr: false };
}

/** Runs one terminal command against the node at `path`; resolves with the exit code. `out` and `err` are where it prints. */
export async function runClient(path: string, command: NodeCommand, out: (line: string) => void, err: (line: string) => void): Promise<number> {
  try {
    const outcome = outcomeOf(await askNode(path, command));
    for (const line of outcome.lines) (outcome.stderr ? err : out)(line);
    return outcome.code;
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/** Whether a node answers at `path` now. Never rejects. */
export function nodeAnswers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    probe.once('connect', () => (probe.destroy(), resolve(true)));
    probe.once('error', () => resolve(false));
  });
}

const POLL_MS = 250;

/** Resolves once `answers` is `want` (true: a node answers; false: none does), or false when `ms` passed first. */
export async function waitUntil(path: string, want: boolean, ms: number, check: (path: string) => Promise<boolean> = nodeAnswers): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if ((await check(path)) === want) return true;
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
