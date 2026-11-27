import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { NodeCommand, NodeReply } from '../shared/node-commands.ts';
import { nodeInstallPaths, type ServiceState } from '../shared/node-service.ts';
import { EMPTY_GIT_SETTINGS, nodeGitPaths, nodeGitSettingsText } from '../shared/node-git.ts';
import { agentSignIns, isSymlink, nodeGitKey, NOT_RUNNING, removePath, sshPublicKeys, toolSignIns, uninstallFromTerminal, type UninstallDeps } from './uninstall-terminal.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kn-un-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** An installed node in `home`: the bundle, `current`, the link, the unit and some data. */
function installed() {
  const paths = nodeInstallPaths(home);
  mkdirSync(join(paths.bundles, '0.0.34', 'bin'), { recursive: true });
  symlinkSync(join(paths.bundles, '0.0.34'), paths.current);
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  symlinkSync(join(paths.current, 'bin', 'kestrel-node'), paths.link);
  mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(paths.unit, '[Unit]\n');
  writeFileSync(join(paths.kestrel, 'kestrel.sqlite'), '');
  return paths;
}

interface World {
  answers: (string | null)[];
  service: ServiceState;
  running: boolean;
  reply: NodeReply;
  /** systemctl starts the node when asked to start. */
  startWorks?: boolean;
}

function run(world: World) {
  const paths = nodeInstallPaths(home);
  const asked: NodeCommand[] = [];
  const systemctl: string[][] = [];
  const lines: string[] = [];
  const deps: UninstallDeps = {
    paths,
    dataDir: paths.kestrel,
    askNode: async (command) => {
      if (!world.running) throw new Error('nothing answers');
      asked.push(command);
      if (command === 'stop') world.running = false;
      return command === 'uninstall' ? world.reply : { ok: true, command, message: 'Stopping.' };
    },
    service: async () => world.service,
    systemctl: async (args) => {
      systemctl.push([...args]);
      if (args[0] === 'start' && world.startWorks) world.running = true;
      if (args[0] === 'disable') world.running = false;
      return { ok: true, error: '' };
    },
    waitStopped: async () => !world.running,
    waitAnswers: async () => world.running,
    remove: removePath,
    isLink: isSymlink,
    exists: existsSync,
    sshPublicKeys: () => sshPublicKeys(home),
    agentSignIns: () => agentSignIns(home, existsSync),
    gitKey: () => nodeGitKey(paths.kestrel, existsSync),
    toolSignIns: () => toolSignIns(paths.kestrel),
  };
  const io = { ask: async () => world.answers.shift() ?? null, out: (l: string) => lines.push(l), err: (l: string) => lines.push(`! ${l}`) };
  return { done: uninstallFromTerminal(deps, io), asked, systemctl, lines, paths };
}

const SERVICE_RUNNING: ServiceState = { manager: 'systemd', installed: true, active: true, mainPid: 5 };

describe('kestrel-node uninstall', () => {
  test('asks first; anything but yes changes nothing', async () => {
    const paths = installed();
    const r = run({ answers: ['y'], service: SERVICE_RUNNING, running: true, reply: { ok: true, command: 'uninstall', message: 'left' } });
    expect(await r.done).toBe(1);
    expect(r.lines).toEqual(['Nothing was changed.']);
    expect(r.asked).toEqual([]);
    expect(existsSync(paths.unit) && existsSync(paths.current)).toBe(true);
  });

  test('refused by the node while work is not pushed: says why and deletes nothing', async () => {
    const paths = installed();
    const r = run({ answers: ['yes'], service: SERVICE_RUNNING, running: true, reply: { ok: false, reason: 'Not uninstalled: 1 session has work that is not pushed' } });
    expect(await r.done).toBe(1);
    expect(r.lines).toEqual(['! Not uninstalled: 1 session has work that is not pushed']);
    expect(r.systemctl).toEqual([]);
    expect(existsSync(paths.unit) && existsSync(paths.bundles) && isSymlink(paths.link)).toBe(true);
  });

  test('leaves the account, stops and disables the service, deletes the unit, the bundles and the link, and keeps the data unless told', async () => {
    const paths = installed();
    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.ssh', 'id_ed25519.pub'), 'ssh-ed25519 AAAA');
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'private');
    mkdirSync(join(home, '.codex'));
    const r = run({ answers: ['yes', 'no'], service: SERVICE_RUNNING, running: true, reply: { ok: true, command: 'uninstall', message: 'Removed this node from your Kestrel Connect account.' } });
    expect(await r.done).toBe(0);
    expect(r.asked).toEqual(['uninstall']);
    expect(r.systemctl).toEqual([['disable', '--now', 'kestrel-node.service'], ['daemon-reload']]);
    expect(existsSync(paths.unit) || existsSync(paths.bundles) || isSymlink(paths.link)).toBe(false);
    expect(existsSync(join(paths.kestrel, 'kestrel.sqlite'))).toBe(true);
    const text = r.lines.join('\n');
    expect(text).toContain('Removed this node from your Kestrel Connect account.');
    expect(text).toContain(`Its data folder was kept: ${paths.kestrel}`);
    expect(text).toContain(join(home, '.ssh', 'id_ed25519.pub'));
    expect(text).not.toContain(`${join(home, '.ssh', 'id_ed25519')}\n`);
    expect(text).toContain('codex logout');
  });

  test("deletes the agents' programs Kestrel installed, and never an agent's sign-in or settings in the home folder", async () => {
    const paths = installed();
    const bin = join(paths.kestrel, 'agents', 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\n');
    for (const own of ['.codex', '.claude', join('.local', 'share', 'opencode')]) {
      mkdirSync(join(home, own), { recursive: true });
      writeFileSync(join(home, own, 'auth.json'), '{}');
    }
    const r = run({ answers: ['yes', 'no'], service: SERVICE_RUNNING, running: true, reply: { ok: true, command: 'uninstall', message: 'left' } });
    expect(await r.done).toBe(0);
    expect(existsSync(join(paths.kestrel, 'agents'))).toBe(false);
    expect(existsSync(join(paths.kestrel, 'kestrel.sqlite'))).toBe(true);
    for (const own of ['.codex', '.claude', join('.local', 'share', 'opencode')]) expect(existsSync(join(home, own, 'auth.json'))).toBe(true);
    expect(r.lines).toContain(`Deleted the agents' programs Kestrel installed (${join(paths.kestrel, 'agents')}). Their sign-ins and settings in your home folder are left as they are.`);
  });

  test('deletes gh and glab as Kestrel installed them, and names their sign-ins with the sign-out commands', async () => {
    const paths = installed();
    const tools = join(paths.kestrel, 'tools', 'bin');
    mkdirSync(tools, { recursive: true });
    writeFileSync(join(tools, 'gh'), '#!/bin/sh\n');
    const git = nodeGitPaths(paths.kestrel);
    mkdirSync(git.folder, { recursive: true });
    const tool = (signedIn: string[]) => ({ installed: true as const, by: 'kestrel' as const, signedIn, notSignedIn: [] });
    writeFileSync(git.settings, nodeGitSettingsText({ ...EMPTY_GIT_SETTINGS, tools: { gh: tool(['github.com']), glab: tool(['gitlab.example.test']) } }));
    mkdirSync(join(home, '.config', 'gh'), { recursive: true });
    writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'github.com: {}\n');
    const r = run({ answers: ['yes', 'yes'], service: SERVICE_RUNNING, running: true, reply: { ok: true, command: 'uninstall', message: 'left' } });
    expect(await r.done).toBe(0);
    expect(existsSync(join(paths.kestrel, 'tools'))).toBe(false);
    expect(existsSync(join(home, '.config', 'gh', 'hosts.yml'))).toBe(true);
    expect(r.lines).toContain(`Deleted gh and glab as Kestrel installed them (${join(paths.kestrel, 'tools')}). Their sign-ins in your home folder are left as they are.`);
    expect(r.lines).toContain('  gh at github.com (~/.config/gh): gh auth logout --hostname github.com');
    expect(r.lines).toContain('  glab at gitlab.example.test (~/.config/glab-cli): glab auth logout --hostname gitlab.example.test');
  });

  test('says nothing of the agents folder when Kestrel installed no agent', async () => {
    installed();
    const r = run({ answers: ['yes', 'no'], service: SERVICE_RUNNING, running: true, reply: { ok: true, command: 'uninstall', message: 'left' } });
    expect(await r.done).toBe(0);
    expect(r.lines.join('\n')).not.toContain("agents' programs");
    expect(r.lines.join('\n')).not.toContain('gh and glab');
  });

  test('a yes to the second question deletes the data folder too', async () => {
    const paths = installed();
    const r = run({ answers: ['yes', 'yes'], service: SERVICE_RUNNING, running: true, reply: { ok: true, command: 'uninstall', message: 'left' } });
    expect(await r.done).toBe(0);
    expect(existsSync(paths.kestrel)).toBe(false);
    expect(r.lines).toContain(`Deleted ${paths.kestrel}.`);
  });

  test('starts the installed service when no node answers, so the node can do its part', async () => {
    installed();
    const r = run({ answers: ['yes', 'no'], service: { manager: 'systemd', installed: true, active: false, mainPid: null }, running: false, startWorks: true, reply: { ok: true, command: 'uninstall', message: 'left' } });
    expect(await r.done).toBe(0);
    expect(r.systemctl[0]).toEqual(['start', 'kestrel-node.service']);
    expect(r.asked).toEqual(['uninstall']);
  });

  test('a node started by hand is stopped over its socket', async () => {
    installed();
    const r = run({ answers: ['yes', 'no'], service: { manager: 'none' }, running: true, reply: { ok: true, command: 'uninstall', message: 'left' } });
    expect(await r.done).toBe(0);
    expect(r.asked).toEqual(['uninstall', 'stop']);
    expect(r.systemctl).toEqual([]);
  });

  test('with no node running and no service to start, it is refused and nothing changes', async () => {
    const paths = installed();
    const r = run({ answers: ['yes'], service: { manager: 'none' }, running: false, reply: { ok: true, command: 'uninstall', message: 'left' } });
    expect(await r.done).toBe(1);
    expect(r.lines).toEqual([`! ${NOT_RUNNING}`]);
    expect(existsSync(paths.bundles)).toBe(true);
  });

  test('a link on PATH that is not Kestrel’s own symlink is left alone', async () => {
    const paths = installed();
    rmSync(paths.link);
    writeFileSync(paths.link, '#!/bin/sh\n');
    const r = run({ answers: ['yes', 'no'], service: SERVICE_RUNNING, running: true, reply: { ok: true, command: 'uninstall', message: 'left' } });
    expect(await r.done).toBe(0);
    expect(existsSync(paths.link)).toBe(true);
  });

  test("deletes the node's git key even when the data folder is kept, and names its fingerprint and the hosts it was added to", async () => {
    const paths = installed();
    const git = nodeGitPaths(paths.kestrel);
    mkdirSync(git.folder, { recursive: true });
    writeFileSync(git.key, 'PRIVATE KEY TEXT');
    writeFileSync(git.publicKey, 'ssh-ed25519 AAAA kestrel-node n');
    writeFileSync(git.settings, nodeGitSettingsText({ ...EMPTY_GIT_SETTINGS, key: { fingerprint: 'SHA256:abc', madeAt: 1 }, hosts: { 'github.com': { answer: 'works', addedBy: 'gh', at: 1 }, 'git.example.org': { answer: 'not-added', at: 1 } } }));
    // A key of the user's own in ~/.ssh is never touched.
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'the user’s own');
    const r = run({ answers: ['yes', 'no'], service: SERVICE_RUNNING, running: true, reply: { ok: true, command: 'uninstall', message: 'Removed.' } });
    expect(await r.done).toBe(0);
    expect(existsSync(git.key) || existsSync(git.publicKey)).toBe(false);
    expect(existsSync(join(home, '.ssh', 'id_ed25519'))).toBe(true);
    expect(r.lines).toContain(`Deleted this node's git key (${git.key}).`);
    expect(r.lines).toContain("This node's git key (SHA256:abc) was deleted from this computer. It was added at github.com: delete it there too (GitHub: Settings → SSH and GPG keys; GitLab: Preferences → SSH Keys), by this fingerprint.");
    expect(r.lines.join('\n')).not.toContain('PRIVATE KEY TEXT');
  });
});
