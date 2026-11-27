import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { gitStatusOf } from '../shared/node-git-status.ts';
import { EMPTY_GIT_SETTINGS } from '../shared/node-git.ts';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askNode, noNodeRunning, outcomeOf, runClient } from './client.ts';
import { listenControl, type ControlSocket } from './control-socket.ts';
import { checkSocketPathLength, nodeSocketPath, SOCKET_PATH_MAX_BYTES } from './socket-path.ts';
import { nodeStatusOf, type NodeStatus } from '../shared/node-status.ts';
import type { Agent } from '../model.ts';
import { notBuiltReason, NODE_COMMAND_NAMES, NODE_COMMANDS, type NodeAgentState } from '../shared/node-commands.ts';

// A short folder: a Unix socket's path is limited to about a hundred bytes.
let dir: string;
let control: ControlSocket | null;
let stops: number;
const noJoin = async () => ({ ok: false, text: 'not in this test' });
const noGit = async () => ({ name: 'Worker node 1', repositories: [], others: [], accountUnknown: null, othersUnknown: null });
const noUninstall = async () => ({ ok: false as const, reason: 'not in this test' });
const rechecked: Agent[][] = [];
const noAgents = async (recheck: readonly Agent[]): Promise<NodeAgentState[]> => {
  rechecked.push([...recheck]);
  return [{ agent: 'claude', canRun: true, why: null }, { agent: 'opencode', canRun: false, why: 'OpenCode is not signed in on Worker node 1. Run `kestrel-node agents` there.' }];
};

const status: NodeStatus = nodeStatusOf({
  version: '0.0.34',
  kind: 'node',
  platform: 'linux',
  name: 'Worker node 1',
  connect: { enabled: true, unavailable: null, account: { state: 'signed-out', reason: null }, link: { state: 'off' }, inAccount: false, removed: false, storage: 'file' },
  agents: ['claude'],
  availability: { available: ['claude'], notes: {} },
  sandbox: { available: true },
  git: gitStatusOf(EMPTY_GIT_SETTINGS, false),
  host: { user: 'kestrel', lingering: 'on', service: { manager: 'systemd', installed: true, active: true, mainPid: 4242 }, disk: { path: '/home/user/.kestrel', freeBytes: 50 * 1024 ** 3 }, bundle: { version: '0.0.34', path: '/home/user/.kestrel/node/0.0.34' } }, pid: 4242,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kn-'));
  stops = 0;
  control = null;
  rechecked.length = 0;
});
afterEach(async () => {
  await control?.close();
  rmSync(dir, { recursive: true, force: true });
});

const start = async (path = nodeSocketPath(dir)) => (control = await listenControl(path, { status: async () => status, stop: () => void stops++, join: noJoin, uninstall: noUninstall, agents: noAgents, git: noGit }));

/** One raw line out, everything the node says back. */
const raw = (path: string, line: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = connect(path);
    let received = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(line));
    socket.on('data', (chunk: string) => (received += chunk));
    socket.once('error', reject);
    socket.once('close', () => resolve(received));
  });

describe('the control socket', () => {
  test('is created so that only the user can open it (mode 600)', async () => {
    const { path } = await start();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('answers status with the status of the node', async () => {
    const { path } = await start();
    const reply = await askNode(path, 'status');
    expect(reply).toEqual({ ok: true, command: 'status', status });
  });

  test('stop is answered first and then the node is asked to stop', async () => {
    const { path } = await start();
    const reply = await askNode(path, 'stop');
    expect(reply).toEqual({ ok: true, command: 'stop', message: 'Stopping.' });
    expect(stops).toBe(1);
  });

  test('uninstall answers with what the node did, or its refusal, and stops nothing itself', async () => {
    let answer: { ok: true; message: string } | { ok: false; reason: string } = { ok: false, reason: 'Not uninstalled: "Fix login" has 2 uncommitted files.' };
    control = await listenControl(nodeSocketPath(dir), { status: async () => status, stop: () => void stops++, join: noJoin, uninstall: async () => answer, agents: noAgents, git: noGit });
    expect(await askNode(control.path, 'uninstall')).toEqual({ ok: false, reason: 'Not uninstalled: "Fix login" has 2 uncommitted files.' });
    answer = { ok: true, message: 'Removed this node from your Kestrel Connect account.' };
    expect(await askNode(control.path, 'uninstall')).toEqual({ ok: true, command: 'uninstall', message: 'Removed this node from your Kestrel Connect account.' });
    expect(stops).toBe(0);
  });

  test('the terminal’s own commands are not taken on the socket', async () => {
    const { path } = await start();
    for (const command of ['start', 'logs']) expect(JSON.parse(await raw(path, `${JSON.stringify({ command })}\n`))).toMatchObject({ ok: false, reason: expect.stringContaining('is not a kestrel-node command') });
  });

  test('every other command on the list is refused as not built yet, with its reason', async () => {
    const { path } = await start();
    const unbuilt = NODE_COMMAND_NAMES.filter((name) => !NODE_COMMANDS[name].built);
    expect(unbuilt.length).toBeGreaterThan(0);
    for (const command of unbuilt) expect(await askNode(path, command)).toEqual({ ok: false, reason: notBuiltReason(command) });
    expect(stops).toBe(0);
  });

  test('agents: the node asks its agents again, forgetting those named in recheck, and says what it tells other devices', async () => {
    const { path } = await start();
    const reply = JSON.parse(await raw(path, `${JSON.stringify({ command: 'agents', recheck: ['codex', 'codex', 'opencode'] })}\n`));
    expect(reply).toEqual({ ok: true, command: 'agents', agents: [{ agent: 'claude', canRun: true, why: null }, { agent: 'opencode', canRun: false, why: 'OpenCode is not signed in on Worker node 1. Run `kestrel-node agents` there.' }] });
    expect(rechecked).toEqual([['codex', 'opencode']]);
    expect(JSON.parse(await raw(path, '{"command":"agents"}\n'))).toMatchObject({ ok: true });
    expect(rechecked.at(-1)).toEqual([]);
  });

  test('agents: a recheck that names something other than an agent is refused, and nothing is asked', async () => {
    const { path } = await start();
    for (const recheck of ['codex', ['shell'], ['claude', 'codex', 'opencode', 'claude'], [1]]) {
      expect(JSON.parse(await raw(path, `${JSON.stringify({ command: 'agents', recheck })}\n`))).toEqual({ ok: false, reason: '"recheck" names agents: claude, codex, opencode.' });
    }
    expect(rechecked).toEqual([]);
  });

  test('git: the node reads its git settings again and answers what only it knows', async () => {
    const { path } = await start();
    expect(JSON.parse(await raw(path, `${JSON.stringify({ command: 'git' })}\n`))).toEqual({ ok: true, command: 'git', git: { name: 'Worker node 1', repositories: [], accountUnknown: null, others: [], othersUnknown: null } });
    expect(stops).toBe(0);
  });

  test('an unknown command is refused, saying which commands there are', async () => {
    const { path } = await start();
    const reply = JSON.parse(await raw(path, '{"command":"shell"}\n'));
    expect(reply).toMatchObject({ ok: false });
    expect(reply.reason).toContain('is not a kestrel-node command');
  });

  test('a request that is not JSON, or too long, is refused and never reaches a command', async () => {
    const { path } = await start();
    expect(JSON.parse(await raw(path, 'status\n'))).toMatchObject({ ok: false });
    expect(JSON.parse(await raw(path, `${'x'.repeat(2000)}`))).toEqual({ ok: false, reason: 'That request is too long.' });
    expect(stops).toBe(0);
  });

  test('a node that fails to answer status gives its reason, not a crash', async () => {
    control = await listenControl(nodeSocketPath(dir), { status: async () => Promise.reject(new Error('The node is still starting.')), stop: () => undefined, join: noJoin, uninstall: noUninstall, agents: noAgents, git: noGit });
    expect(await askNode(control.path, 'status')).toEqual({ ok: false, reason: 'The node is still starting.' });
  });

  test('is removed when it is closed', async () => {
    const { path } = await start();
    await control!.close();
    control = null;
    expect(() => statSync(path)).toThrow();
  });
});

describe('a node that must not start', () => {
  test('refuses when another node is already answering at the socket', async () => {
    await start();
    await expect(listenControl(nodeSocketPath(dir), { status: async () => status, stop: () => undefined, join: noJoin, uninstall: noUninstall, agents: noAgents, git: noGit })).rejects.toThrow(/already running/);
  });

  test('takes over a socket a dead node left behind', async () => {
    const path = nodeSocketPath(dir);
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(path, () => resolve()));
    // The listener is gone but its file stays: kill the server without letting it unlink.
    (dead as unknown as { _handle: { close(): void } })._handle.close();
    await expect(start(path)).resolves.toMatchObject({ path });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('refuses when something that is not a socket is in the way', async () => {
    writeFileSync(nodeSocketPath(dir), 'not a socket');
    await expect(start()).rejects.toThrow(/not a socket/);
  });

  test('refuses when its folder can be changed by other users', async () => {
    const shared = join(dir, 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    await expect(start(join(shared, 'node.sock'))).rejects.toThrow(/can be changed by other users/);
  });

  test('refuses a path too long for a Unix socket, saying so', async () => {
    const long = join(dir, 'x'.repeat(SOCKET_PATH_MAX_BYTES));
    expect(() => checkSocketPathLength(long)).toThrow(/too long for a Unix socket/);
    await expect(start(long)).rejects.toThrow(/too long/);
  });
});

describe('the terminal’s side', () => {
  test('says plainly that no node is running, and exits non-zero', async () => {
    const path = nodeSocketPath(dir);
    const out: string[] = [];
    const err: string[] = [];
    const code = await runClient(path, 'status', (l) => out.push(l), (l) => err.push(l));
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([noNodeRunning(path)]);
  });

  test('prints the status and exits 0', async () => {
    const { path } = await start();
    const out: string[] = [];
    const code = await runClient(path, 'status', (l) => out.push(l), () => undefined);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('Worker node 1: worker node, Kestrel 0.0.34 on Linux');
  });

  test('a refusal goes to the error output with a non-zero exit', async () => {
    const { path } = await start();
    const err: string[] = [];
    const code = await runClient(path, 'setup', () => undefined, (l) => err.push(l));
    expect(code).toBe(1);
    expect(err).toEqual([notBuiltReason('setup')]);
  });

  test('outcomeOf words each kind of answer', () => {
    expect(outcomeOf({ ok: true, command: 'stop', message: 'Stopping.' })).toEqual({ lines: ['Stopping.'], code: 0, stderr: false });
    expect(outcomeOf({ ok: false, reason: 'no' })).toEqual({ lines: ['no'], code: 1, stderr: true });
  });
});
