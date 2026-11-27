// The terminal's way into a running worker node: a Unix domain socket in Kestrel's data folder that only the
// user can open (mode 600), speaking the closed list in shared/node-commands.ts. It is not the HTTP listener and
// carries none of its routes. One request per connection, one line of JSON each way; `join` alone goes on as a
// conversation of typed lines after its request (join-socket.ts).
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { Agent } from '../model.ts';
import { NODE_COMMANDS, NODE_REQUEST_MAX_BYTES, notBuiltReason, parseNodeRequest, parseRecheck, type NodeAgentState, type NodeGitFacts, type NodeReply } from '../shared/node-commands.ts';
import type { NodeStatus } from '../shared/node-status.ts';
import { Refused } from '../refused.ts';
import { checkSocketPathLength } from './socket-path.ts';
import { converse, type JoinRun } from './join-socket.ts';

const REQUEST_TIMEOUT_MS = 5000;
const OWNER_ONLY = 0o600;

/** What the commands that are built do. */
export interface ControlHandlers {
  status(): Promise<NodeStatus>;
  /** Begin stopping the node. Called after the reply has been sent. */
  stop(): void;
  /** Sign in and ask to join the account, as a conversation with the terminal (node-control/join-flow.ts). */
  join: JoinRun;
  /** The node's part of uninstalling: refuse while work is not pushed, else leave the account (uninstall-node.ts). */
  uninstall(): Promise<{ ok: true; message: string } | { ok: false; reason: string }>;
  /** The node's part of `kestrel node agents`: forget what it knew of `recheck`, ask every agent again, and say what it now tells other devices. */
  agents(recheck: readonly Agent[]): Promise<NodeAgentState[]>;
  /** The node's part of `kestrel node git`: read its git settings again, and say what only it knows (git-node.ts). */
  git(): Promise<NodeGitFacts>;
}

export interface ControlSocket {
  path: string;
  close(): Promise<void>;
}

/** Whether something answers a connection at `path`. */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    probe.once('connect', () => (probe.destroy(), resolve(true)));
    probe.once('error', () => resolve(false));
  });
}

/**
 * Makes `path` ready to listen on, or throws `Refused` saying why the node must not start: its folder can be
 * changed by other users, something that is not a socket is in the way, or another node is running. A socket
 * left by a node that died is removed.
 */
async function prepare(path: string): Promise<void> {
  checkSocketPathLength(path);
  const folder = lstatSync(dirname(path));
  // A folder others may write to (and without the sticky bit) lets them replace the socket.
  if ((folder.mode & 0o022) !== 0 && (folder.mode & 0o1000) === 0) throw new Refused(`${dirname(path)} can be changed by other users, so its control socket could not be kept private. Make it yours alone (chmod 700).`);
  if (!existsSync(path)) return;
  const found = lstatSync(path);
  if (!found.isSocket()) throw new Refused(`${path} is in the way and is not a socket. Remove it, then start the node again.`);
  if (await answers(path)) throw new Refused(`A node is already running here: something answers at ${path}.`);
  unlinkSync(path);
}

/** The socket really is the user's alone, or throws. */
function checkPrivate(path: string): void {
  const found = lstatSync(path);
  const mine = typeof process.getuid !== 'function' || found.uid === process.getuid();
  if (!mine || (found.mode & 0o077) !== 0) throw new Refused(`The control socket at ${path} could not be made private to you, so the node will not start.`);
}

function reply(socket: Socket, answer: NodeReply, then?: () => void): void {
  socket.end(`${JSON.stringify(answer)}\n`, then);
}

async function answer(line: string, handlers: ControlHandlers): Promise<{ reply: NodeReply; after?: () => void }> {
  const parsed = parseNodeRequest(line);
  if (!parsed.ok) return { reply: { ok: false, reason: parsed.reason } };
  const { command } = parsed;
  if (!NODE_COMMANDS[command].built) return { reply: { ok: false, reason: notBuiltReason(command) } };
  if (command === 'status') return { reply: { ok: true, command, status: await handlers.status() } };
  if (command === 'stop') return { reply: { ok: true, command, message: 'Stopping.' }, after: handlers.stop };
  if (command === 'agents') {
    const asked = parseRecheck(line);
    if (!asked.ok) return { reply: { ok: false, reason: asked.reason } };
    return { reply: { ok: true, command, agents: await handlers.agents(asked.recheck) } };
  }
  if (command === 'git') return { reply: { ok: true, command, git: await handlers.git() } };
  if (command === 'uninstall') {
    const done = await handlers.uninstall();
    return { reply: done.ok ? { ok: true, command, message: done.message } : { ok: false, reason: done.reason } };
  }
  // `join` is a conversation and never reaches here (serve).
  return { reply: { ok: false, reason: notBuiltReason(command) } };
}

function serve(socket: Socket, handlers: ControlHandlers): void {
  let received = '';
  let handled = false;
  socket.setEncoding('utf8');
  socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
  socket.on('error', () => socket.destroy());
  socket.on('data', (chunk: string) => {
    if (handled) return;
    received += chunk;
    if (Buffer.byteLength(received) > NODE_REQUEST_MAX_BYTES) {
      handled = true;
      return reply(socket, { ok: false, reason: 'That request is too long.' });
    }
    const end = received.indexOf('\n');
    if (end === -1) return;
    handled = true;
    const line = received.slice(0, end);
    const parsed = parseNodeRequest(line);
    if (parsed.ok && parsed.command === 'join') return converse(socket, received.slice(end + 1), handlers.join);
    // The request is in: the answer may take a while (uninstall asks git and the service), and the terminal waits for it.
    socket.setTimeout(0);
    answer(line, handlers).then(
      (done) => reply(socket, done.reply, done.after),
      (error: unknown) => reply(socket, { ok: false, reason: error instanceof Error ? error.message : String(error) }),
    );
  });
}

/** Listens at `path`, private to the user, or throws `Refused`. */
export async function listenControl(path: string, handlers: ControlHandlers): Promise<ControlSocket> {
  await prepare(path);
  const server: Server = createServer((socket) => serve(socket, handlers));
  // Made under a umask that leaves the socket the user's alone from the first moment; checked after.
  const before = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => resolve());
    });
  } finally {
    process.umask(before);
  }
  try {
    chmodSync(path, OWNER_ONLY);
    checkPrivate(path);
  } catch (error) {
    server.close();
    if (existsSync(path)) unlinkSync(path);
    throw error;
  }
  return {
    path,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.unref();
        if (existsSync(path)) unlinkSync(path);
      }),
  };
}
