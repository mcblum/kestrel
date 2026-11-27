// OpenCode programs start one at a time per data folder (one-at-a-time.ts), across Kestrel's processes. The stub
// `opencode` here fails as the real one did on a fresh database when another starts at the same moment.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { agentPrograms, runProgram } from '../../node-control/agents-programs.ts';
import { LOCK_STALE_MS, opencodeDataFolder, opencodeDatabase, opencodeLocks, OpencodeBusy, startGate } from './one-at-a-time.ts';
import { opencodeLauncher, type OpencodeServer } from './process.ts';
import { hermeticPath, realProgramsOn } from '../../node-control/test-path.ts';

let root: string;
let home: string;
let dataDir: string;
let bin: string;
let plain: string;
const servers: OpencodeServer[] = [];

/** Starting takes a moment; a second program starting meanwhile fails the way OpenCode's migration did. */
const STUB = (mark: string) => `#!/bin/sh
if ! mkdir "${mark}" 2>/dev/null; then echo "DrizzleError: Failed to run the query 'CREATE TABLE \\\`project\\\` ( \\\`id\\\` text PRIMARY KEY )'" >&2; exit 1; fi
sleep 0.3
rmdir "${mark}"
case "$1" in
  serve) echo "opencode server listening on http://127.0.0.1:1"; exec sleep 5 ;;
  auth) echo "└  1 credentials" ;;
  --version) echo "1.14.25" ;;
esac
`;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kn-oc-gate-')));
  home = join(root, 'home');
  dataDir = join(home, '.kestrel');
  bin = join(dataDir, 'agents', 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  plain = hermeticPath(root, []);
  writeFileSync(join(bin, 'opencode'), STUB(join(root, 'starting')));
  chmodSync(join(bin, 'opencode'), 0o755);
});
afterEach(() => {
  servers.splice(0).forEach((s) => s.kill());
  rmSync(root, { recursive: true, force: true });
});

const env = () => ({ HOME: home, PATH: `${bin}:${plain}` });
const cli = (args: string[]) => runProgram(join(bin, 'opencode'), args, { env: env(), cwd: root, quiet: true, timeoutMs: 10_000 });

describe('OpenCode programs start one at a time', () => {
  test('hermetic: only the stub opencode and plain tools are reachable', () => {
    expect(realProgramsOn(env().PATH, [bin])).toEqual([]);
  });

  test('the stub really fails when two start at once (what the gate prevents)', async () => {
    const both = await Promise.all([cli(['auth', 'list']), cli(['auth', 'list'])]);
    expect(both.map((r) => r.code).sort()).toEqual([0, 1]);
  });

  test('the node’s `opencode serve` and the checklist’s status program, in two processes’ gates, never overlap', async () => {
    // Two gates on one lock folder stand for the server and the `kestrel-node` terminal: they share only the lock file.
    const launch = opencodeLauncher(startGate(opencodeLocks(dataDir)));
    const checklist = agentPrograms({ dataDir, env: { HOME: home, PATH: plain }, run: runProgram, nodeBinary: join(root, 'node'), exists: (p) => p.startsWith(root) && existsSync(p), platform: 'linux' });
    const [server, facts, second] = await Promise.all([
      launch({ env: env(), config: {}, pure: false, onExit: () => undefined }),
      checklist.facts('opencode'),
      launch({ env: env(), config: {}, pure: false, onExit: () => undefined }),
    ]);
    servers.push(server, second);
    expect(server.url).toBe('http://127.0.0.1:1');
    expect(facts).toMatchObject({ version: '1.14.25', signedIn: true });
  });

  test('a lock left by a process that is gone is taken over; a live one is waited for, then refused in words', async () => {
    const locks = opencodeLocks(dataDir);
    mkdirSync(locks, { recursive: true });
    const taken = await (async () => {
      const gate = startGate(locks, { alive: () => true, waitMs: 300, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
      const first = gate.run(env(), () => new Promise((r) => setTimeout(() => r('first'), 50)));
      return first;
    })();
    expect(taken).toBe('first');
    // A lock file held by a live other process: wait, then give up with words.
    const holder = startGate(locks, { alive: () => true, waitMs: 200 });
    let release!: () => void;
    const held = holder.run(env(), () => new Promise<void>((r) => (release = r)));
    while (!release) await new Promise((r) => setTimeout(r, 5));
    await expect(startGate(locks, { alive: () => true, waitMs: 200 }).run(env(), async () => 'second')).rejects.toBeInstanceOf(OpencodeBusy);
    // The same lock when its process is gone is taken over at once.
    await expect(startGate(locks, { alive: () => false, waitMs: 200 }).run(env(), async () => 'after a crash')).resolves.toBe('after a crash');
    release();
    await held;
    // And one older than the stale limit, whoever holds it.
    let clock = 0;
    const old = startGate(locks, { alive: () => true, now: () => clock, waitMs: 200 });
    const stuck = startGate(locks, { alive: () => true }).run(env(), () => new Promise<void>((r) => setTimeout(r, 400)));
    await new Promise((r) => setTimeout(r, 20));
    clock = Date.now() + LOCK_STALE_MS + 1;
    await expect(old.run(env(), async () => 'stale taken')).resolves.toBe('stale taken');
    await stuck;
  });

  test('names OpenCode’s data folder and database by XDG_DATA_HOME, else ~/.local/share', () => {
    expect(opencodeDataFolder({ HOME: '/home/someone' })).toBe('/home/someone/.local/share/opencode');
    expect(opencodeDataFolder({ HOME: '/home/someone', XDG_DATA_HOME: '/data/someone' })).toBe('/data/someone/opencode');
    expect(opencodeDatabase({ HOME: '/home/someone' })).toBe('/home/someone/.local/share/opencode/opencode.db');
  });
});
