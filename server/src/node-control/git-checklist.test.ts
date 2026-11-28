// `kestrel node git`'s checklist, drawn as the terminal draws it, against fake programs: every line, in both modes.
// The programs themselves (the stubs on PATH) are git-programs.test.ts; the tools' installer is git-tools-install.test.ts.
import { describe, expect, test } from 'vitest';
import type { JoinStep, NodeGitFacts, NodeJoinEvent } from '../shared/node-commands.ts';
import { EMPTY_GIT_SETTINGS, nodeGitPaths, type HostAnswer, type NodeGitSettings, type ToolState } from '../shared/node-git.ts';
import { toolPinsOf, type GitTool, type KeyUse } from '../shared/node-git-tools.ts';
import { hostsPicked, runGitChecklist, type GitOptions } from './git-checklist.ts';
import type { ApiAnswer, GitPrograms } from './git-programs.ts';
import { drawJoinEvent, JOIN_DRAW_START, type JoinStyle } from './join-draw.ts';

const HOME = '/home/me';
const PRETTY: JoinStyle = { plain: false, width: 120 };
const PLAIN: JoinStyle = { plain: true, width: 120 };
const PUBLIC = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExample kestrel-node Worker node 1';
const ASK: GitOptions = { unattended: false, manual: false };
const UNATTENDED: GitOptions = { unattended: true, manual: false };

/** A node: what is on it, and what each host has and answers. */
interface Machine {
  hasKey: boolean;
  settings: NodeGitSettings;
  /** Each tool: on the node or not, and where it is signed in. */
  tools: Record<GitTool, { installed: boolean; by: 'kestrel' | 'elsewhere'; signedIn: string[] }>;
  /** Hosts a sign-in ends signed in at. */
  signIns: string[];
  /** Each host's answer to ssh while the key is not there. */
  hosts: Record<string, HostAnswer>;
  /** Keys listed at each host: this node's, with its use. */
  keys: Record<string, KeyUse[]>;
  signingKeys: Record<string, boolean>;
  /** Canned API answers, by `<host> <path>`. */
  api: Record<string, unknown>;
  /** API calls refused, by `<host> <path>`. */
  refused: string[];
  /** Hosts the person adds the key at by hand when asked to press Enter. */
  pastes: string[];
  node: NodeGitFacts | null;
  /** Answers of the node after the first, in turn (it reads the account meanwhile). */
  later?: (NodeGitFacts | null)[];
}

function play(m: Machine, options: GitOptions, answers: string[], style: JoinStyle) {
  const lines: string[] = [];
  const calls: string[] = [];
  let saved: NodeGitSettings | null = null;
  let state = JOIN_DRAW_START;
  const draw = (event: NodeJoinEvent) => {
    const drawn = drawJoinEvent(event, state, style);
    lines.push(...drawn.lines.map((l) => (drawn.toErr && l !== '' ? `! ${l}` : l)));
    state = drawn.state;
    return drawn.prompt;
  };
  const works = (host: string) => (m.keys[host] ?? []).length > 0;
  let lastTested = '';
  const programs: GitPrograms = {
    paths: nodeGitPaths(`${HOME}/.kestrel`),
    toolsFolder: `${HOME}/.kestrel/tools`,
    has: () => true,
    readSettings: () => m.settings,
    writeSettings: (s) => void (saved = s),
    publicKey: () => (m.hasKey ? PUBLIC : null),
    makeKey: async () => {
      calls.push('make key');
      const made = !m.hasKey;
      m.hasKey = true;
      return { ok: true, fingerprint: 'SHA256:nodekey', made };
    },
    test: async (host) => {
      calls.push(`test ${host}`);
      lastTested = host;
      const first = calls.filter((c) => c === `test ${host}`).length === 1;
      const answer = works(host) ? 'works' : m.hosts[host]!;
      return { answer, detail: answer === 'unreachable' ? 'ssh: connect to host port 22: Connection timed out' : null, accepted: first ? [{ type: 'ED25519', fingerprint: `SHA256:${host}-hostkey` }] : [] };
    },
    tool: async (tool, hosts): Promise<ToolState> => {
      calls.push(`ask ${tool} ${hosts.join(',')}`);
      const t = m.tools[tool];
      if (!t.installed) return { installed: false };
      return { installed: true, by: t.by, version: toolPinsOf()[tool].version, signedIn: hosts.filter((h) => t.signedIn.includes(h)), notSignedIn: hosts.filter((h) => !t.signedIn.includes(h)) };
    },
    install: async (tool) => {
      calls.push(`install ${tool}`);
      m.tools[tool] = { installed: true, by: 'kestrel', signedIn: [] };
      return { ok: true, version: toolPinsOf()[tool].version, path: `${HOME}/.kestrel/tools/bin/${tool}` };
    },
    signIn: async (tool, host, signing) => {
      calls.push(`sign in ${tool} ${host}${signing ? ' signing' : ''}`);
      if (m.signIns.includes(host)) m.tools[tool].signedIn.push(host);
      return m.signIns.includes(host);
    },
    api: async (tool, host, path): Promise<ApiAnswer> => {
      calls.push(`${tool} api ${host} ${path}`);
      if (m.refused.includes(`${host} ${path}`)) return { ok: false, reason: `${tool} could not read ${path} at ${host}: HTTP 403: Resource not accessible by integration` };
      if (path === 'user/keys') return { ok: true, json: (m.keys[host] ?? []).map((usage) => ({ id: 1, key: PUBLIC.split(' ').slice(0, 2).join(' '), title: 't', usage_type: usage })) };
      if (path === 'user/ssh_signing_keys') return { ok: true, json: m.signingKeys[host] ? [{ id: 2, key: PUBLIC }] : [] };
      return { ok: true, json: m.api[`${host} ${path}`] ?? [] };
    },
    addKey: async (tool, host, title, use) => {
      calls.push(`${tool} add ${host} ${use} "${title}"`);
      if (use === 'signing') m.signingKeys[host] = true;
      else m.keys[host] = [...(m.keys[host] ?? []), use];
      return { ok: true };
    },
  };
  const io = {
    say: (event: NodeJoinEvent) => void draw(event),
    ask: async (step: JoinStep, prompt: string) => {
      const shown = draw({ event: 'ask', step, prompt });
      const answer = answers.shift() ?? null;
      // Enter at "check again": the person added the key at that host by hand, when this machine says they do.
      if (answer !== null && /check again/.test(prompt) && answer === '' && m.pastes.includes(lastTested)) m.keys[lastTested] = ['auth'];
      lines.push(`${shown}${answer ?? ''}`);
      state = { printed: true, blank: false };
      return answer;
    },
    ran: () => void calls.push('the tool had the terminal'),
  };
  let asked = 0;
  const node = async () => {
    asked++;
    return asked === 1 ? m.node : m.later && m.later.length > 0 ? m.later.shift()! : m.node;
  };
  const done = runGitChecklist({ programs, pins: toolPinsOf(), node, name: 'this-host', home: HOME, now: () => 1000, sleep: async () => undefined }, io, options);
  return { done, lines, calls, saved: () => saved, asked: () => asked };
}

const FACTS: NodeGitFacts = {
  name: 'Worker node 1',
  repositories: ['github.com/acme/api', 'git.example.org/team/app'],
  accountUnknown: null,
  others: [
    { computer: 'Mac mini', name: 'Sam Rivera', email: 'sam@example.com', signs: true },
    { computer: 'Laptop', name: null, email: null, signs: false },
  ],
  othersUnknown: null,
};

const FRESH = (): Machine => ({
  hasKey: false,
  settings: EMPTY_GIT_SETTINGS,
  tools: { gh: { installed: false, by: 'kestrel', signedIn: [] }, glab: { installed: true, by: 'elsewhere', signedIn: [] } },
  signIns: ['github.com', 'git.example.org'],
  hosts: { 'github.com': 'not-added', 'git.example.org': 'not-added' },
  keys: {},
  signingKeys: {},
  api: {
    'github.com user/emails': [
      { email: 'sam@example.com', verified: true, primary: true, visibility: 'private' },
      { email: 'sam@personal.example', verified: true, primary: false, visibility: null },
      { email: 'old@example.net', verified: false, primary: false, visibility: null },
    ],
    'git.example.org user': { id: 7, username: 'sam', email: 'sam@git.example.org', commit_email: 'sam@git.example.org' },
    'git.example.org user/emails': [],
  },
  refused: [],
  pastes: [],
  node: FACTS,
});

/** The whole default path at a terminal: every answer as the person types it. */
const DEFAULT_ANSWERS = ['', '', '', '', '', '', 'y', '', 'y', ''];

describe('kestrel node git, at a terminal: the default path', () => {
  test('a fresh node: key, both hosts ticked, signing, name, gh installed and signed in, one yes per host, the email read, nothing left', async () => {
    const r = play(FRESH(), ASK, [...DEFAULT_ANSWERS], PRETTY);
    expect(await r.done).toBe(0);
    expect(r.lines.join('\n')).toBe([
      'Kestrel worker node: git on Worker node 1',
      '',
      '1  This node\'s key',
      '   Make an SSH key for Kestrel\'s git on this node? It is used only by Kestrel here and never leaves this node. [Y/n]',
      '   > ',
      '   ✓ Made a key: SHA256:nodekey',
      '   It is kept in ~/.kestrel/git (the private half readable only by you), used only by Kestrel\'s git here, and never',
      '   leaves this node. Its public half:',
      '',
      `       ${PUBLIC}`,
      '',
      '2  Where your repositories are',
      '   Which sites should this node use to reach your repositories? Choosing one signs in to it here with its own tool, then',
      '   offers to add this node\'s public key there.',
      '   1) git.example.org (GitLab, with glab)',
      '   2) github.com (GitHub, with gh)',
      '   a) Both',
      '   s) Skip (add the key by hand later)',
      '   Choose (1-2, a or s) [a]: ',
      '',
      '3  Signing and your name',
      '   Mac mini signs its commits. A key never comes here from another computer, so commits made here are signed with this',
      '   node\'s own key, or not at all.',
      '   Sign commits made on Worker node 1 with this node\'s key? [Y/n] ',
      '   ✓ Commits made here are signed with this node\'s key',
      '   Filled in from Mac mini\'s git settings.',
      '   Commit name [Sam Rivera]: ',
      '   ✓ Commits made here are by Sam Rivera',
      '',
      '4  At your git hosts',
      '   Install GitHub CLI (gh) 2.96.0 into ~/.kestrel/tools, for Kestrel only? [Y/n] ',
      '   Installing gh 2.96.0, checked against its published checksum; nothing is installed for the whole system.',
      '   ✓ Installed gh 2.96.0 in ~/.kestrel/tools',
      '   ✓ glab 1.130.0: found on this node',
      '   git.example.org, with glab:',
      '   glab signs in to git.example.org with a personal access token: make one at',
      '   https://git.example.org/-/user_settings/personal_access_tokens with the api scope, then paste it when glab asks for',
      '   it. Kestrel never sees it.',
      '   Sign glab in to git.example.org now? [Y/n] ',
      '   ✓ glab is signed in to git.example.org',
      '   At git.example.org, Kestrel would run:',
      '',
      '       glab api --hostname git.example.org user/keys  # is the key there already?',
      '',
      '       GITLAB_HOST=git.example.org glab ssh-key add ~/.kestrel/git/id_ed25519.pub --title "Kestrel worker node Worker node 1" --usage-type auth_and_signing  # only if it is not',
      '',
      '       glab api --hostname git.example.org user  # your primary and commit addresses',
      '',
      '       glab api --hostname git.example.org user/emails  # your other confirmed addresses',
      '',
      '       ssh -T git@git.example.org  # with this node\'s key only',
      '',
      '   Run these at git.example.org? [y/N] y',
      '   ✓ Added the key at git.example.org, for authentication and signing',
      '   ✓ Commit email at git.example.org: sam@git.example.org (verified there)',
      '   Accepted git.example.org\'s host key (ED25519 SHA256:git.example.org-hostkey) into Kestrel\'s known hosts. Compare it',
      '   with the fingerprints git.example.org publishes.',
      '   ✓ git.example.org: the key works',
      '   github.com, with gh:',
      '   gh signs in to github.com by a code: it prints the code, you open https://github.com/login/device on any device and',
      '   type it there. It asks for write:public_key (add this node\'s key), write:ssh_signing_key (register it for signing),',
      '   user:email (read your verified email addresses).',
      '   Sign gh in to github.com now? [Y/n] ',
      '   ✓ gh is signed in to github.com',
      '   At github.com, Kestrel would run:',
      '',
      '       gh api --hostname github.com user/keys  # is the key there already?',
      '',
      '       GH_HOST=github.com gh ssh-key add ~/.kestrel/git/id_ed25519.pub --title "Kestrel worker node Worker node 1" --type authentication  # only if it is not',
      '',
      '       gh api --hostname github.com user/ssh_signing_keys  # is it registered for signing?',
      '',
      '       GH_HOST=github.com gh ssh-key add ~/.kestrel/git/id_ed25519.pub --title "Kestrel worker node Worker node 1" --type signing  # only if it is not',
      '',
      '       gh api --hostname github.com user/emails  # your verified addresses, nothing else',
      '',
      '       ssh -T git@github.com  # with this node\'s key only',
      '',
      '   Run these at github.com? [y/N] y',
      '   ✓ Added the key at github.com',
      '   ✓ Registered it for signing at github.com',
      '   ✓ Commit email at github.com: sam@example.com (verified there)',
      '   Accepted github.com\'s host key (ED25519 SHA256:github.com-hostkey) into Kestrel\'s known hosts. Compare it with the',
      '   fingerprints github.com publishes.',
      '   ✓ github.com: the key works',
      '',
      '5  Commit email',
      '   Filled in from what another computer of your account publishes.',
      '   Commit email [sam@example.com]: ',
      '   ✓ Commits made here are from sam@example.com',
      '   ✓ At git.example.org: sam@git.example.org',
      '',
      '6  Still to do',
      '   ✓ Nothing. Git on Worker node 1 is ready.',
      '',
      '✓ Git on Worker node 1: the key works at 2 of 2 hosts; commits as Sam Rivera <sam@example.com>.',
      '',
      'Next: kestrel node status',
    ].join('\n'));
    expect(r.calls.filter((c) => / add |install|sign in/.test(c))).toEqual([
      'install gh',
      'sign in glab git.example.org signing',
      'glab add git.example.org auth_and_signing "Kestrel worker node Worker node 1"',
      'sign in gh github.com signing',
      'gh add github.com auth "Kestrel worker node Worker node 1"',
      'gh add github.com signing "Kestrel worker node Worker node 1"',
    ]);
    expect(r.saved()).toMatchObject({
      name: 'Sam Rivera',
      email: 'sam@example.com',
      signing: 'node-key',
      hosts: { 'github.com': { answer: 'works', addedBy: 'gh', signing: 'registered' }, 'git.example.org': { answer: 'works', addedBy: 'glab', signing: 'registered', email: 'sam@git.example.org' } },
      tools: { gh: { installed: true, by: 'kestrel', signedIn: ['github.com'] }, glab: { installed: true, by: 'elsewhere', signedIn: ['git.example.org'] } },
    });
    expect(r.saved()!.hosts['github.com']!.email).toBeUndefined();
    // The node was asked at the start and again at the end, so it reads what was chosen.
    expect(r.asked()).toBe(2);
    expect(r.lines.join('\n')).not.toMatch(/PRIVATE KEY/);
  });

  test('the same in plain ASCII, as a log or a script reads it', async () => {
    const r = play(FRESH(), ASK, [...DEFAULT_ANSWERS], PLAIN);
    expect(await r.done).toBe(0);
    expect(r.lines.join('\n')).not.toMatch(/[^\x20-\x7e\n]/);
    expect(r.lines).toContain('   ok: Installed gh 2.96.0 in ~/.kestrel/tools');
    expect(r.lines).toContain('   ok: Nothing. Git on Worker node 1 is ready.');
    expect(r.lines.at(-3)).toBe('ok: Git on Worker node 1: the key works at 2 of 2 hosts; commits as Sam Rivera <sam@example.com>.');
  });

  test('run again: the key is found at each host and never added twice', async () => {
    const m = FRESH();
    await play(m, ASK, [...DEFAULT_ANSWERS], PLAIN).done;
    const again = play({ ...m, settings: EMPTY_GIT_SETTINGS }, ASK, ['', '', '', 'y', 'y', ''], PLAIN);
    expect(await again.done).toBe(0);
    expect(again.calls.filter((c) => / add /.test(c))).toEqual([]);
    expect(again.lines).toContain('   ok: The key is already at github.com');
    expect(again.lines).toContain('   ok: It is already registered for signing at github.com');
    expect(again.lines).toContain('   ok: The key is already at git.example.org');
    expect(again.calls).not.toContain('install gh');
  });

  test('without signing: gh is asked for no signing scope and nothing is registered for signing', async () => {
    const r = play(FRESH(), ASK, ['', '', 'n', '', '', '', 'y', '', 'y', ''], PLAIN);
    expect(await r.done).toBe(0);
    expect(r.calls).toContain('sign in gh github.com');
    expect(r.lines.join('\n')).toContain('It asks for write:public_key (add this node\'s key), user:email (read your verified email addresses).');
    expect(r.calls.filter((c) => / add /.test(c))).toEqual(['glab add git.example.org auth "Kestrel worker node Worker node 1"', 'gh add github.com auth "Kestrel worker node Worker node 1"']);
    expect(r.calls).not.toContain('gh api github.com user/ssh_signing_keys');
  });

  test('a host verifying several addresses, none known here: the person picks one, by number', async () => {
    const m = FRESH();
    const r = play({ ...m, node: { ...FACTS, others: [{ computer: 'Mac mini', name: 'Sam Rivera', email: null, signs: false }] } }, ASK, ['', 'github.com', 'n', '', '', '', 'y', '2', 's', 'sam@example.com', ''], PLAIN);
    expect(await r.done).toBe(1);
    const text = r.lines.join('\n');
    expect(text).toContain('   github.com has verified 2 addresses:\n   1. sam@example.com (primary)\n   2. sam@personal.example\n   Which do you commit with at github.com? [sam@example.com] 2\n   ok: Commit email at github.com: sam@personal.example');
    // Never an address the host did not verify.
    expect(text).not.toContain('old@example.net');
    expect(r.saved()).toMatchObject({ email: 'sam@example.com', hosts: { 'github.com': { email: 'sam@personal.example' } } });
  });

  test('a refused permission leaves that step by hand, in the still-to-do list, with where to add the key', async () => {
    const m = { ...FRESH(), refused: ['github.com user/keys'] };
    const r = play(m, ASK, [...DEFAULT_ANSWERS], PLAIN);
    expect(await r.done).toBe(1);
    const text = r.lines.join('\n');
    expect(text).toContain('   gh could not read user/keys at github.com: HTTP 403: Resource not accessible by integration');
    expect(r.calls.filter((c) => c.startsWith('gh add github.com'))).toEqual([]);
    expect(text).toContain(
      '6  Still to do\n   1. Add the key at github.com. At github.com: Settings -> SSH and GPG keys -> New SSH key, and paste the public half.\n   Then run kestrel node git again to check it.\n\n' +
        `       ${PUBLIC}\n`,
    );
    expect(r.lines.at(-3)).toBe('! Git on Worker node 1: the key works at 1 of 2 hosts; commits as Sam Rivera <sam@example.com>. 2 things to do.');
    // The key is not there, so it is not registered for signing either: that is left too, with the address it needs.
    expect(text).toContain('   2. Register the key for signing. At github.com: Settings -> SSH and GPG keys -> New SSH key a second time, with Key');
  });
});

describe('kestrel node git, by hand', () => {
  test('--manual: no tool is installed, signed in or run; where to paste the key, and checked again on Enter', async () => {
    const m = { ...FRESH(), pastes: ['github.com', 'git.example.org'] };
    const r = play(m, { unattended: false, manual: true }, ['', 'n', '', '', '', '', 'sam@git.example.org', ''], PRETTY);
    expect(await r.done).toBe(1);
    expect(r.calls.filter((c) => /install|sign in|api| add /.test(c))).toEqual([]);
    expect(r.lines.slice(r.lines.indexOf('2  Where your repositories are')).join('\n')).toBe([
      '2  Where your repositories are',
      '   By hand (--manual): git.example.org, github.com.',
      '',
      '3  Signing and your name',
      '   Mac mini signs its commits. A key never comes here from another computer, so commits made here are signed with this',
      '   node\'s own key, or not at all.',
      '   Sign commits made on Worker node 1 with this node\'s key? [Y/n] n',
      '   ✓ Commits made here are not signed',
      '   Filled in from Mac mini\'s git settings.',
      '   Commit name [Sam Rivera]: ',
      '   ✓ Commits made here are by Sam Rivera',
      '',
      '4  At your git hosts',
      '   git.example.org, by hand:',
      '   Accepted git.example.org\'s host key (ED25519 SHA256:git.example.org-hostkey) into Kestrel\'s known hosts. Compare it',
      '   with the fingerprints git.example.org publishes.',
      '   At git.example.org: Preferences → SSH Keys → Add new key, and paste the public half.',
      '',
      `       ${PUBLIC}`,
      '',
      '   Press Enter once it is added to check again, or type s to skip: ',
      '   ✓ git.example.org: the key works',
      '   github.com, by hand:',
      '   Accepted github.com\'s host key (ED25519 SHA256:github.com-hostkey) into Kestrel\'s known hosts. Compare it with the',
      '   fingerprints github.com publishes.',
      '   At github.com: Settings → SSH and GPG keys → New SSH key, and paste the public half.',
      '',
      `       ${PUBLIC}`,
      '',
      '   Press Enter once it is added to check again, or type s to skip: ',
      '   ✓ github.com: the key works',
      '',
      '5  Commit email',
      '   Filled in from what another computer of your account publishes.',
      '   Commit email [sam@example.com]: ',
      '   For each host: the same address, unless you commit there with another one.',
      '   Commit email at git.example.org [sam@example.com]: sam@git.example.org',
      '   Commit email at github.com [sam@example.com]: ',
      '   ✓ Commits made here are from sam@example.com',
      '   ✓ At git.example.org: sam@git.example.org',
      '',
      '6  Still to do',
      '   1. Sign glab in to git.example.org, so this node\'s pull requests, review requests and Autopilot work there:',
      '',
      '       glab auth login --hostname git.example.org --git-protocol ssh',
      '',
      '   2. Sign gh in to github.com, so this node\'s pull requests, review requests and Autopilot work there:',
      '',
      '       gh auth login --hostname github.com --git-protocol ssh --skip-ssh-key --web --scopes write:public_key,user:email',
      '',
      '! Git on Worker node 1: the key works at 2 of 2 hosts; commits as Sam Rivera <sam@example.com>. 2 things to do.',
      '',
      '! Next: kestrel node status',
    ].join('\n'));
    expect(r.saved()).toMatchObject({ email: 'sam@example.com', hosts: { 'git.example.org': { answer: 'works', email: 'sam@git.example.org' }, 'github.com': { answer: 'works' } } });
    expect(r.saved()!.hosts['github.com']!.email).toBeUndefined();
  });

  test('one host: the commit email is asked once, and no host is asked for its own', async () => {
    const m = { ...FRESH(), node: { ...FACTS, repositories: ['github.com/acme/api'] }, pastes: ['github.com'] };
    const r = play(m, { unattended: false, manual: true }, ['', 'n', '', '', ''], PLAIN);
    await r.done;
    const text = r.lines.join('\n');
    expect(text).toContain('5  Commit email\n   Filled in from what another computer of your account publishes.\n   Commit email [sam@example.com]: \n   ok: Commits made here are from sam@example.com');
    expect(text).not.toContain('Commit email at');
  });

  test('the other way round in the other style: two hosts drawn plain ask each host, one host drawn with ticks asks once', async () => {
    const two = play({ ...FRESH(), pastes: ['github.com', 'git.example.org'] }, { unattended: false, manual: true }, ['', 'n', '', '', '', '', '', 'sam@users.noreply.github.example'], PLAIN);
    await two.done;
    expect(two.lines.join('\n')).toContain(
      '   For each host: the same address, unless you commit there with another one.\n   Commit email at git.example.org [sam@example.com]: \n   Commit email at github.com [sam@example.com]: sam@users.noreply.github.example\n   ok: Commits made here are from sam@example.com\n   ok: At github.com: sam@users.noreply.github.example',
    );
    const one = play({ ...FRESH(), node: { ...FACTS, repositories: ['github.com/acme/api'] }, pastes: ['github.com'] }, { unattended: false, manual: true }, ['', 'n', '', '', 'sam@example.com'], PRETTY);
    await one.done;
    expect(one.lines.join('\n')).toContain('5  Commit email\n   Filled in from what another computer of your account publishes.\n   Commit email [sam@example.com]: sam@example.com\n   ✓ Commits made here are from sam@example.com\n');
    expect(one.lines.join('\n')).not.toContain('Commit email at');
  });

  test('a name or address git would not take is asked again', async () => {
    const m = { ...FRESH(), node: { ...FACTS, others: [] }, pastes: ['github.com', 'git.example.org'] };
    const r = play(m, { unattended: false, manual: true }, ['', 'n', 'Sam <x>', 'Sam Rivera', '', '', 'sam', 'sam@example.com', '', ''], PLAIN);
    await r.done;
    expect(r.lines).toContain('   Without angle brackets or line breaks.');
    expect(r.lines).toContain('   An email address looks like name@example.com.');
    expect(r.saved()).toMatchObject({ name: 'Sam Rivera', email: 'sam@example.com', signing: 'off' });
  });
});

describe('which sites: one numbered choice of the hosts found, with all and skip and a default shown', () => {
  const HOSTS = ['git.example.org', 'github.com'];
  test('Enter, a, all, both or yes is every one; s, skip, n, no or none is none', () => {
    for (const all of ['', 'a', 'all', 'Both', 'yes']) expect(hostsPicked(all, HOSTS)).toEqual(HOSTS);
    for (const none of ['s', 'skip', 'n', 'no', 'none', ' NONE ']) expect(hostsPicked(none, HOSTS)).toEqual([]);
  });

  test('numbers or the hosts’ own names pick those; anything else is asked again', () => {
    expect(hostsPicked('2', HOSTS)).toEqual(['github.com']);
    expect(hostsPicked('2, 1', HOSTS)).toEqual(HOSTS);
    expect(hostsPicked('github.com', HOSTS)).toEqual(['github.com']);
    expect(hostsPicked('3', HOSTS)).toBeNull();
    expect(hostsPicked('gitlab.com', HOSTS)).toBeNull();
  });

  test('skip at the choice: every host is done by hand, and nothing changes at a host', async () => {
    const r = play(FRESH(), ASK, ['', 'none', '', '', '', ''], PLAIN);
    await r.done;
    expect(r.calls.filter((c) => /^sign in | add /.test(c))).toEqual([]);
    expect(r.lines.join('\n')).toContain('git.example.org, by hand:');
  });

  test('a wrong answer is said, with what to type, and asked again', async () => {
    const r = play(FRESH(), ASK, ['', 'gitlab.com', '1', '', '', '', '', '', ''], PLAIN);
    await r.done;
    const text = r.lines.join('\n');
    expect(text).toContain('Choose (1-2, a or s) [a]: gitlab.com\n   Type a number from 1 to 2, several (like 1 2), a for both, or s to skip.\n   Choose (1-2, a or s) [a]: 1');
  });
});

describe('kestrel node git when the account’s hosts are not known yet', () => {
  test('says why, never "none"; Enter checks again, w waits; once read, the hosts are offered', async () => {
    const unknown = { ...FACTS, repositories: [], accountUnknown: 'The account’s projects are not read yet: the node reads them shortly after it connects.' };
    const m = { ...FRESH(), node: unknown, later: [unknown, unknown, FACTS] };
    const r = play(m, ASK, ['', '', 'w', 'n', '', '', ''], PLAIN);
    await r.done;
    const text = r.lines.join('\n');
    expect(text).toContain(
      "2  Where your repositories are\n   The account's projects are not read yet: the node reads them shortly after it connects.\n   Press Enter to check again, type w to wait for it (up to a minute), or c to carry on without them: \n" +
        "   The account's projects are not read yet: the node reads them shortly after it connects.\n   Press Enter to check again, type w to wait for it (up to a minute), or c to carry on without them: w\n\n" +
        "   Waiting for the node to read your account's projects...\n   Which sites should this node use to reach your repositories?",
    );
    expect(text).not.toMatch(/none of|no repository|0 of 0/i);
  });

  test('carried on without them: the still-to-do list says to add the key at each git host, in general words', async () => {
    const unknown = { ...FACTS, repositories: [], accountUnknown: 'This node is not in an account yet (`kestrel node join`), so the account’s projects are not known.' };
    const r = play({ ...FRESH(), node: unknown }, ASK, ['', 'c', '', 'n', '', ''], PLAIN);
    expect(await r.done).toBe(1);
    const text = r.lines.join('\n');
    expect(text).toContain('4  At your git hosts\n   No host to set up yet.');
    expect(text).toContain('6  Still to do\n   1. Add the key at each git host your account\'s projects use (GitHub: Settings -> SSH and GPG keys -> New SSH key;\n   GitLab: Preferences -> SSH Keys), then run kestrel node git again once the node has read your account.');
    expect(r.lines.at(-3)).toBe("! Git on Worker node 1: your account's hosts are not known yet; commits as Sam Rivera <sam@example.com>. 1 thing to do.");
    expect(text).not.toMatch(/0 of 0/);
  });

  test('the person may type a host the account could not tell', async () => {
    const unknown = { ...FACTS, repositories: [], accountUnknown: 'This node is not in an account yet (`kestrel node join`), so the account’s projects are not known.' };
    const r = play({ ...FRESH(), node: unknown }, ASK, ['', 'c', 'github.com', 'n', '', '', '', 'y', ''], PLAIN);
    await r.done;
    expect(r.calls).toContain('sign in gh github.com');
    expect(r.saved()!.hosts['github.com']).toMatchObject({ answer: 'works', addedBy: 'gh' });
  });
});

describe('kestrel node git with --yes, or with no terminal', () => {
  test('installs the tools, prints the sign-in commands, does nothing at a host, keeps what is chosen, and lists what is left', async () => {
    const r = play(FRESH(), UNATTENDED, [], PLAIN);
    expect(await r.done).toBe(1);
    expect(r.lines.join('\n')).toBe([
      'Kestrel worker node: git on Worker node 1',
      '',
      '1  This node\'s key',
      '   ok: Made a key: SHA256:nodekey',
      '   It is kept in ~/.kestrel/git (the private half readable only by you), used only by Kestrel\'s git here, and never',
      '   leaves this node. Its public half:',
      '',
      `       ${PUBLIC}`,
      '',
      '2  Where your repositories are',
      '   Your account\'s projects use: git.example.org (GitLab, with glab), github.com (GitHub, with gh).',
      '',
      '3  Signing and your name',
      '   Mac mini signs its commits. A key never comes here from another computer, so commits made here are signed with this',
      '   node\'s own key, or not at all.',
      '   Signing is not chosen. Run kestrel node git at a terminal to choose.',
      '   Filled in from Mac mini\'s git settings.',
      '   ok: Commits made here are by Sam Rivera',
      '',
      '4  At your git hosts',
      '   Installing gh 2.96.0, checked against its published checksum; nothing is installed for the whole system.',
      '   ok: Installed gh 2.96.0 in ~/.kestrel/tools',
      '   ok: glab 1.130.0: found on this node',
      '   git.example.org, with glab:',
      '   glab signs in to git.example.org with a personal access token: make one at',
      '   https://git.example.org/-/user_settings/personal_access_tokens with the api scope, then paste it when glab asks for',
      '   it. Kestrel never sees it.',
      '   Sign it in at a terminal with:',
      '',
      '       glab auth login --hostname git.example.org --git-protocol ssh',
      '',
      '   github.com, with gh:',
      '   gh signs in to github.com by a code: it prints the code, you open https://github.com/login/device on any device and',
      '   type it there. It asks for write:public_key (add this node\'s key), user:email (read your verified email addresses).',
      '   Sign it in at a terminal with:',
      '',
      '       gh auth login --hostname github.com --git-protocol ssh --skip-ssh-key --web --scopes write:public_key,user:email',
      '',
      '   git.example.org, by hand:',
      '   Accepted git.example.org\'s host key (ED25519 SHA256:git.example.org-hostkey) into Kestrel\'s known hosts. Compare it',
      '   with the fingerprints git.example.org publishes.',
      '   At git.example.org: Preferences -> SSH Keys -> Add new key, and paste the public half.',
      '',
      `       ${PUBLIC}`,
      '',
      '   git.example.org: the key is not added there yet.',
      '',
      '   github.com, by hand:',
      '   Accepted github.com\'s host key (ED25519 SHA256:github.com-hostkey) into Kestrel\'s known hosts. Compare it with the',
      '   fingerprints github.com publishes.',
      '   At github.com: Settings -> SSH and GPG keys -> New SSH key, and paste the public half.',
      '',
      `       ${PUBLIC}`,
      '',
      '   github.com: the key is not added there yet.',
      '',
      '5  Commit email',
      '   Filled in from what another computer of your account publishes.',
      '   ok: Commits made here are from sam@example.com',
      '',
      '6  Still to do',
      '   1. Add the key at git.example.org. At git.example.org: Preferences -> SSH Keys -> Add new key, and paste the public',
      '   half. Then run kestrel node git again to check it.',
      '',
      `       ${PUBLIC}`,
      '',
      '   2. Add the key at github.com. At github.com: Settings -> SSH and GPG keys -> New SSH key, and paste the public half.',
      '   Then run kestrel node git again to check it.',
      '',
      `       ${PUBLIC}`,
      '',
      '   3. Sign glab in to git.example.org, so this node\'s pull requests, review requests and Autopilot work there:',
      '',
      '       glab auth login --hostname git.example.org --git-protocol ssh',
      '',
      '   4. Sign gh in to github.com, so this node\'s pull requests, review requests and Autopilot work there:',
      '',
      '       gh auth login --hostname github.com --git-protocol ssh --skip-ssh-key --web --scopes write:public_key,user:email',
      '',
      '! Git on Worker node 1: the key works at 0 of 2 hosts; commits as Sam Rivera <sam@example.com>. 4 things to do.',
      '',
      '! Next: kestrel node status',
    ].join('\n'));
    expect(r.calls.filter((c) => /sign in|api| add /.test(c))).toEqual([]);
    expect(r.calls).toContain('install gh');
  });

  test('no node running: the key is made, the hosts are not known and it says so, and the node uses it when it starts', async () => {
    const r = play({ ...FRESH(), node: null }, UNATTENDED, [], PLAIN);
    expect(await r.done).toBe(1);
    const text = r.lines.join('\n');
    expect(text).toContain("The node is not running, so it cannot say which hosts your account's projects use. Start it (kestrel node start).");
    expect(text).toContain("Git on this-host: your account's hosts are not known yet; no commit name and email yet.");
    expect(text).toContain('The node is not running; it uses this when it starts (kestrel node start).');
    expect(text).not.toMatch(/0 of 0/);
    expect(r.asked()).toBe(1);
  });
});
