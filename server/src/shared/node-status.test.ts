import { gitStatusOf } from './node-git-status.ts';
import { EMPTY_GIT_SETTINGS } from './node-git.ts';
import { describe, expect, test } from 'vitest';
import { nodeStatusOf, projectsLine, REMOVED_NODE, statusLines, type NodeProjects, type NodeStatusInputs } from './node-status.ts';
import { NO_KEYSTORE_NOTE } from './protected-files.ts';
import { nodeUpdateLine } from './node-update.ts';

const inputs = (change: Partial<NodeStatusInputs> = {}, connect: Partial<NodeStatusInputs['connect']> = {}): NodeStatusInputs => ({
  version: '0.0.34',
  kind: 'node',
  platform: 'linux',
  name: 'Worker node 1',
  connect: { enabled: true, unavailable: null, account: { state: 'signed-out', reason: null }, link: { state: 'off' }, inAccount: false, removed: false, storage: 'file', ...connect },
  agents: ['claude', 'codex', 'opencode'],
  availability: { available: ['claude'], notes: { codex: 'Codex is not signed in.' } },
  sandbox: { available: false, reason: 'the command sandbox on Linux needs bubblewrap and socat installed (then restart Kestrel)' },
  git: gitStatusOf(EMPTY_GIT_SETTINGS, false),
  host: { user: 'kestrel', lingering: 'on', service: { manager: 'systemd', installed: true, active: true, mainPid: 4242 }, disk: { path: '/home/user/.kestrel', freeBytes: 50 * 1024 ** 3 }, bundle: { version: '0.0.34', path: '/home/user/.kestrel/node/0.0.34' } }, pid: 4242,
  ...change,
});

describe('nodeStatusOf', () => {
  test('a node signed out says it is not signed in, not in the account, and why it is not connected', () => {
    const status = nodeStatusOf(inputs());
    expect(status.connect).toEqual({ signedIn: false, email: null, inAccount: false, removed: false, connected: false, notConnected: 'Not signed in to Kestrel Connect. Run "kestrel node join" to sign in and join your account.' });
    expect(status).toMatchObject({ version: '0.0.34', kind: 'node', platform: 'linux', name: 'Worker node 1' });
  });

  test('a node in the account and connected has no reason to give', () => {
    const status = nodeStatusOf(inputs({}, { account: { state: 'signed-in', email: 'a@b.c' }, link: { state: 'connected', since: 1 }, inAccount: true }));
    expect(status.connect).toEqual({ signedIn: true, email: 'a@b.c', inAccount: true, removed: false, connected: true, notConnected: null });
  });

  test('a node removed from the account says so, is not in it, and says how to join again', () => {
    // Arrange: the relay gave up on it (removed), though the sign-in is still kept.
    const removed = inputs({}, { account: { state: 'signed-in', email: 'a@b.c' }, link: { state: 'offline', reason: 'This computer was removed from your Kestrel Connect account.', retryAt: null }, inAccount: true, removed: true });
    // Act
    const status = nodeStatusOf(removed);
    // Assert
    expect(status.connect).toMatchObject({ inAccount: false, removed: true, connected: false, notConnected: REMOVED_NODE });
    expect(statusLines(status).join('\n')).toContain(`In the account: no. ${REMOVED_NODE}`);
    expect(REMOVED_NODE).toContain('kestrel node join');
  });

  test('a node signed in but not let in yet says to run join', () => {
    const text = statusLines(nodeStatusOf(inputs({}, { account: { state: 'signed-in', email: 'a@b.c' }, link: { state: 'connected', since: 1 } }))).join('\n');
    expect(text).toContain('In the account: no. Run "kestrel node join"');
  });

  test('why it is not connected follows what is wrong, in order', () => {
    const why = (connect: Partial<NodeStatusInputs['connect']>) => nodeStatusOf(inputs({}, connect)).connect.notConnected;
    expect(why({ unavailable: 'Kestrel Connect is off while Kestrel runs with sample data.' })).toContain('sample data');
    expect(why({ enabled: false })).toBe('Kestrel Connect is switched off.');
    expect(why({ account: { state: 'signing-in', url: 'x' } })).toBe('Waiting for the sign-in to finish.');
    expect(why({ account: { state: 'signed-in', email: 'a@b.c' }, link: { state: 'offline', reason: 'The relay did not answer.', retryAt: null } })).toBe('The relay did not answer.');
    expect(why({ account: { state: 'signed-in', email: 'a@b.c' }, link: { state: 'connecting' } })).toBe('Connecting to the relay.');
  });

  test('each agent can run, or says why not from what the runtime knows', () => {
    const { agents } = nodeStatusOf(inputs());
    expect(agents).toEqual([
      { agent: 'claude', canRun: true, why: null, problem: null },
      { agent: 'codex', canRun: false, why: 'Codex is not signed in.', problem: null },
      { agent: 'opencode', canRun: false, why: 'Not available.', problem: null },
    ]);
  });

  test('read on the node itself, an agent is worded without "on <node> … there", by the name the checklist uses', () => {
    const elsewhere = 'Claude Code is not signed in on Worker node 1. Run `kestrel node agents` there.';
    const text = statusLines(nodeStatusOf(inputs({ availability: { available: [], notes: { claude: elsewhere }, problems: { claude: { trouble: 'signed-out' }, codex: { trouble: 'missing' }, opencode: { trouble: 'out-of-usage', detail: 'Free usage exceeded' } } } }))).join('\n');
    expect(text).toContain('  Claude Code: cannot run. Claude Code is not signed in. Run `kestrel node agents`.');
    expect(text).toContain('  Codex: cannot run. Codex is not installed. Run `kestrel node agents`.');
    expect(text).toContain("  OpenCode: cannot run. OpenCode's provider refused the last turn (Free usage exceeded). Run `kestrel node agents`.");
    expect(text).not.toContain('there.');
    expect(text).not.toMatch(/^ {2}Claude:/m);
  });

  test('the sandbox says why it is missing, and a present one has no reason', () => {
    expect(nodeStatusOf(inputs()).sandbox).toEqual({ available: false, why: expect.stringContaining('bubblewrap') });
    expect(nodeStatusOf(inputs({ sandbox: { available: true } })).sandbox).toEqual({ available: true, why: null });
  });

  test('where secrets are kept: a file says it in the words Settings uses; a keystore says so', () => {
    expect(nodeStatusOf(inputs()).secrets).toEqual({ storage: 'file', where: NO_KEYSTORE_NOTE });
    expect(nodeStatusOf(inputs({}, { storage: 'keystore' })).secrets.where).toContain('keystore');
  });
});

describe('statusLines', () => {
  test('words the status for a terminal, every line the design asks for', () => {
    const text = statusLines(nodeStatusOf(inputs())).join('\n');
    expect(text).toContain('Worker node 1: worker node, Kestrel 0.0.34 on Linux');
    expect(text).toContain('Signed in to Kestrel Connect: no');
    expect(text).toContain('In the account: no');
    expect(text).toContain('Connected to the relay: no. Not signed in to Kestrel Connect.');
    expect(text).toContain('Claude Code: can run');
    expect(text).toContain('Codex: cannot run. Codex is not signed in.');
    expect(text).toContain('Command sandbox: not available. the command sandbox on Linux needs bubblewrap');
    expect(text).toContain(NO_KEYSTORE_NOTE);
  });

  test('a signed-in, connected node says so with its address', () => {
    const text = statusLines(nodeStatusOf(inputs({}, { account: { state: 'signed-in', email: 'a@b.c' }, link: { state: 'connected', since: 1 }, inAccount: true }))).join('\n');
    expect(text).toContain('Signed in to Kestrel Connect: yes (a@b.c)');
    expect(text).toContain('In the account: yes');
    expect(text).toContain('Connected to the relay: yes');
  });

  test('ends with the machine: the service, lingering, free disk and the installed bundle', () => {
    const lines = statusLines(nodeStatusOf(inputs({ host: { user: 'kestrel', lingering: 'off', service: { manager: 'systemd', installed: true, active: true, mainPid: 4242 }, disk: { path: '/home/user/.kestrel', freeBytes: 1024 }, bundle: { version: '0.0.35', path: '/home/user/.kestrel/node/0.0.35' } } })));
    expect(lines.at(-4)).toBe('Service: running under systemd (kestrel-node.service)');
    expect(lines.at(-3)).toContain('sudo loginctl enable-linger kestrel');
    expect(lines.at(-2)).toContain('Free disk in /home/user/.kestrel: 1.0 KB. Low:');
    expect(lines.at(-1)).toContain('The node runs 0.0.34: restart it to use 0.0.35');
  });
});

describe('the projects line (worker-nodes.md 9.3)', () => {
  const p = (over: Partial<NodeProjects> = {}): NodeProjects => ({ here: 9, notHere: 2, cloning: 1, mode: 'every', notCloned: [], kept: [], lowDisk: null, where: '/home/someone/.kestrel/projects', ...over });

  test('says how many of the account’s projects are cloned, how many are cloning, and why one is not', () => {
    const s = nodeStatusOf(inputs({ projects: p({ notCloned: [{ name: 'Shop', why: "Worker node 1's key cannot read `acme/shop`. Run `kestrel node git` on Worker node 1 to add it at github.com." }] }) }));
    expect(statusLines(s)).toContain("Projects: 9 of 11 cloned, 1 cloning. Not cloned: Shop (Worker node 1's key cannot read `acme/shop`. Run `kestrel node git` on Worker node 1 to add it at github.com.)");
    expect(projectsLine(p({ here: 11, notHere: 0, cloning: 0 }))).toBe('Projects: 11 of 11 cloned.');
    expect(projectsLine(p({ here: 1, notHere: 0, cloning: 0 }))).toBe('Projects: 1 of 1 cloned.');
  });

  test('with clone on start, says where the others go and when', () => {
    expect(projectsLine(p({ here: 2, notHere: 9, cloning: 0, mode: 'on-start' }))).toBe('Projects: 2 of 11 cloned. The others are cloned into /home/someone/.kestrel/projects when a session starts in one.');
  });

  test('says when low disk stopped the clones, and names a clone kept for the work in it', () => {
    const line = projectsLine(p({ cloning: 0, lowDisk: 'Worker node 1 has 512 MB free, and a new clone wants at least 2.0 GB. Free some space there first.', kept: [{ name: 'Old', why: '"Fix it" has work that is not pushed' }] }));
    expect(line).toBe('Projects: 9 of 11 cloned. Cloning stopped: Worker node 1 has 512 MB free, and a new clone wants at least 2.0 GB. Free some space there first. Kept though no other computer has it now: Old ("Fix it" has work that is not pushed).');
  });

  test('is left out where the server says nothing of projects, and status --json carries the same value', () => {
    expect(statusLines(nodeStatusOf(inputs())).some((l) => l.startsWith('Projects:'))).toBe(false);
    expect(nodeStatusOf(inputs({ projects: p() })).projects).toEqual(p());
  });
});

describe('the update line (worker-nodes.md 4.2)', () => {
  test('status says the update in nodeUpdateLine’s words, and --json carries the same value', () => {
    const note = { to: '0.0.35', state: 'waiting' as const, busy: { sessions: ['Fix login'], clones: 0, pushes: 0 } };
    const line = nodeUpdateLine('Worker node 1', '0.0.34', note);
    const status = nodeStatusOf(inputs({ update: { note, line } }));
    expect(statusLines(status)).toContain('Update: Worker node 1 is on 0.0.34; it updates to 0.0.35 when its sessions finish.');
    expect(JSON.parse(JSON.stringify(status)).update).toEqual({ note, line });
  });

  test('on its desktops’ version there is no update line', () => {
    expect(statusLines(nodeStatusOf(inputs({ update: { note: null, line: null } }))).some((l) => l.startsWith('Update:'))).toBe(false);
  });
});
