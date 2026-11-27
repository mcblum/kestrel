// `kestrel-node git`'s programs for real, against stub ssh-keygen, ssh, gh and glab on PATH in a temporary HOME. The
// stubs record how they were called; ssh accepts a host key into whatever known-hosts file it is told and answers as a
// host would. No network, and the person's ~/.ssh and git configuration are checked to be untouched.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { JoinStep, NodeGitFacts, NodeJoinEvent } from '../shared/node-commands.ts';
import { toolPinsOf } from '../shared/node-git-tools.ts';
import { hermeticPath, realProgramsOn } from './test-path.ts';
import { runProgram, type ProgramOutput, type RunProgram } from './agents-programs.ts';
import { runGitChecklist } from './git-checklist.ts';
import { gitPrograms } from './git-programs.ts';
import { drawJoinEvent, JOIN_DRAW_START } from './join-draw.ts';

/** What the stubs keep that Kestrel must never print: the private half, and a tool's token. */
const PRIVATE_TEXT = 'PRIVATE-KEY-MATERIAL-not-real';
const TOKEN = 'gho_notARealToken0123456789';

let root: string;
let home: string;
let dataDir: string;
let bin: string;
let calls: string;

function stub(name: string, body: string): void {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\nCALLS="${calls}"\necho "${name} $*" >> "${calls}"\n${body}\n`);
  chmodSync(path, 0o755);
}

// ssh-keygen: makes a key pair; prints a fingerprint; finds and lists a host in a known-hosts file.
const SSH_KEYGEN = `
case "$1" in
  -q) while [ $# -gt 0 ]; do case "$1" in -C) comment="$2"; shift ;; -f) file="$2"; shift ;; esac; shift; done
      echo "${PRIVATE_TEXT}" > "$file"; echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStub $comment" > "$file.pub" ;;
  -l) if [ "$2" = "-F" ]; then echo "# Host $3 found: line 1"; echo "$3 ED25519 SHA256:hostkey-of-$3"; else echo "256 SHA256:stubnodekey kestrel-node (ED25519)"; fi ;;
  -F) grep -q "^$2 " "$4" ;;
esac`;

// ssh -T: takes the host key into the known-hosts file it is given with accept-new; works once the key was added.
const SSH = `
for a in "$@"; do case "$a" in UserKnownHostsFile=*) kh="\${a#UserKnownHostsFile=}" ;; StrictHostKeyChecking=accept-new) accept=1 ;; git@*) host="\${a#git@}" ;; esac; done
if ! grep -q "^$host " "$kh" 2>/dev/null; then
  [ -n "$accept" ] || { echo "Host key verification failed." >&2; exit 255; }
  echo "$host ssh-ed25519 AAAAhostkey" >> "$kh"; echo "Warning: Permanently added '$host' (ED25519) to the list of known hosts." >&2
fi
case "$host" in unreachable.example) echo "ssh: connect to host $host port 22: Connection timed out" >&2; exit 255 ;; esac
if [ -f "$HOME/.added-$host" ]; then echo "Hi sam! You've successfully authenticated, but there is no shell access."; exit 1; fi
echo "git@$host: Permission denied (publickey)." >&2; exit 255`;

// gh and glab: signed in to the hosts listed in a file under HOME (auth login adds the host there); status prints a
// token, as the real ones may. `api` answers the key lists from what `ssh-key add` added, and anything else from a file
// under HOME, or refuses when told to. Adding a key also lets ssh in.
const TOOL = (name: string, hostVar: string, version: string) => `
slug() { echo "$1" | tr / _; }
case "$1" in
  --version) echo "${name} version ${version} (2026-11-20)" ;;
  auth) case "$2" in
    status) host="$4"; echo "Token: ${TOKEN}"; grep -qx "$host" "$HOME/.${name}-hosts" 2>/dev/null ;;
    login) host="$4"; echo "GH_BROWSER=$GH_BROWSER GH_PROMPT_DISABLED=$GH_PROMPT_DISABLED" >> "$CALLS"; echo "$host" >> "$HOME/.${name}-hosts"; echo "Logged in to $host as sam" ;;
  esac ;;
  api) host="$3"; path="$4"
    if [ -f "$HOME/.refuse-$host-$(slug "$path")" ]; then echo "HTTP 403: Resource not accessible by integration (https://api.$host/$path)" >&2; exit 1; fi
    case "$path" in
      user/keys|user/ssh_signing_keys) f="$HOME/.keys-$host-$(slug "$path")"; printf '['; sep=''
        if [ -f "$f" ]; then while IFS='|' read -r key usage; do printf '%s{"id":1,"title":"t","key":"%s","usage_type":"%s"}' "$sep" "$key" "$usage"; sep=','; done < "$f"; fi
        printf ']\\n' ;;
      *) cat "$HOME/.api-$host-$(slug "$path")" 2>/dev/null || echo '[]' ;;
    esac ;;
  ssh-key) file="$3"; host="\${${hostVar}:-github.com}"; usage=auth; list=user/keys
    while [ $# -gt 0 ]; do case "$1" in --type) [ "$2" = signing ] && { usage=signing; list=user/ssh_signing_keys; } ;; --usage-type) usage="$2" ;; esac; shift; done
    echo "$(cut -d' ' -f1,2 "$file")|$usage" >> "$HOME/.keys-$host-$(slug "$list")"
    touch "$HOME/.added-$host"; echo "${TOKEN} added" ;;
esac`;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-git-programs-')));
  home = join(root, 'home');
  dataDir = join(home, '.kestrel');
  bin = join(root, 'bin');
  calls = join(root, 'calls.log');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  mkdirSync(bin);
  // Kestrel's folder is there on any installed node; its git folder is not yet.
  mkdirSync(dataDir, { mode: 0o700 });
  // The person's own ssh set-up and git configuration: Kestrel never reads, uses or changes them.
  writeFileSync(join(home, '.ssh', 'config'), 'Host *\n  IdentityFile ~/.ssh/id_rsa\n');
  writeFileSync(join(home, '.ssh', 'known_hosts'), 'github.com ssh-ed25519 AAAAmine\n');
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Someone Else\n');
  stub('ssh-keygen', SSH_KEYGEN);
  stub('ssh', SSH);
  stub('gh', TOOL('gh', 'GH_HOST', '2.96.0'));
  stub('glab', TOOL('glab', 'GITLAB_HOST', '1.130.0'));
  writeFileSync(join(home, '.gh-hosts'), 'github.com\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const seen: ProgramOutput[] = [];
beforeEach(() => void (seen.length = 0));
const collecting: RunProgram = async (file, args, options) => {
  const done = await runProgram(file, args, { ...options, quiet: true });
  seen.push(done);
  return done;
};

/** Only the stubs and the plain tools they use: a real gh, glab, git, ssh or package manager here never answers. */
const testPath = () => hermeticPath(root, [bin]);
const programs = (path = testPath()) => gitPrograms({ dataDir, env: { HOME: home, PATH: path }, run: collecting, pins: toolPinsOf(), arch: 'x64' });
const log = (): string[] => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : []);
const mode = (path: string) => statSync(path).mode & 0o777;

function untouched(): void {
  expect(readdirSync(join(home, '.ssh')).sort()).toEqual(['config', 'known_hosts']);
  expect(readFileSync(join(home, '.ssh', 'known_hosts'), 'utf8')).toBe('github.com ssh-ed25519 AAAAmine\n');
  expect(readFileSync(join(home, '.gitconfig'), 'utf8')).toBe('[user]\n\tname = Someone Else\n');
  expect(existsSync(join(home, '.config', 'git'))).toBe(false);
}

describe("the node's key", () => {
  test('made by ssh-keygen in Kestrel’s folder, private, with these exact arguments; made once', async () => {
    const p = programs();
    const made = await p.makeKey('kestrel-node Worker node 1');
    expect(made).toEqual({ ok: true, fingerprint: 'SHA256:stubnodekey', made: true });
    const key = join(dataDir, 'git', 'id_ed25519');
    expect(log()).toEqual([`ssh-keygen -q -t ed25519 -N  -C kestrel-node Worker node 1 -f ${key}`, `ssh-keygen -l -f ${key}.pub`]);
    expect(mode(key)).toBe(0o600);
    expect(mode(join(dataDir, 'git'))).toBe(0o700);
    expect(p.publicKey()).toBe('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStub kestrel-node Worker node 1');
    expect(await p.makeKey('again')).toEqual({ ok: true, fingerprint: 'SHA256:stubnodekey', made: false });
    expect(log().filter((l) => l.startsWith('ssh-keygen -q'))).toHaveLength(1);
    untouched();
  });

  test('a private half with no public half is left alone, with what to do', async () => {
    mkdirSync(join(dataDir, 'git'), { recursive: true });
    writeFileSync(join(dataDir, 'git', 'id_ed25519'), 'x');
    expect(await programs().makeKey('c')).toEqual({ ok: false, reason: `${join(dataDir, 'git', 'id_ed25519')} is there without its public half. Move it away, then run kestrel-node git again.` });
    expect(log()).toEqual([]);
  });

  test('no ssh-keygen: says what installs it', async () => {
    rmSync(join(bin, 'ssh-keygen'));
    const p = programs(bin);
    expect(await p.makeKey('c')).toMatchObject({ ok: false, reason: expect.stringMatching(/openssh-client/) });
  });
});

describe('testing the key at a host', () => {
  test('ssh -T with only Kestrel’s key and known hosts; the host key accepted is named; then it works once added', async () => {
    const p = programs();
    await p.makeKey('c');
    const first = await p.test('github.com');
    expect(first).toEqual({ answer: 'not-added', detail: null, accepted: [{ type: 'ED25519', fingerprint: 'SHA256:hostkey-of-github.com' }] });
    const kh = join(dataDir, 'git', 'known_hosts');
    expect(log()).toContain(`ssh -T -F none -i ${join(dataDir, 'git', 'id_ed25519')} -o IdentitiesOnly=yes -o IdentityAgent=none -o UserKnownHostsFile=${kh} -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15 git@github.com`);
    expect(mode(kh)).toBe(0o600);
    writeFileSync(join(home, '.added-github.com'), '');
    // The host key is known now: nothing more is accepted.
    expect(await p.test('github.com')).toEqual({ answer: 'works', detail: null, accepted: [] });
    expect(await p.test('unreachable.example')).toMatchObject({ answer: 'unreachable', detail: 'ssh: connect to host unreachable.example port 22: Connection timed out' });
    untouched();
  });
});

describe('gh and glab', () => {
  test('hermetic: the PATH the programs run with reaches only the stubs and plain tools', () => {
    const path = testPath();
    expect(realProgramsOn(path, [bin])).toEqual([]);
    // Kestrel's tools folder comes first, then the test's PATH; nothing else is added.
    expect(gitPrograms({ dataDir, env: { HOME: home, PATH: path }, run: collecting, pins: toolPinsOf(), arch: 'x64' }).has('gh')).toBe(true);
  });

  test('asked where they are, their version and where they are signed in, by exit code only', async () => {
    const p = programs();
    expect(await p.tool('gh', ['github.com', 'github.example.com'])).toEqual({ installed: true, by: 'elsewhere', version: '2.96.0', signedIn: ['github.com'], notSignedIn: ['github.example.com'] });
    rmSync(join(bin, 'glab'));
    expect(await p.tool('glab', ['gitlab.com'])).toEqual({ installed: false });
    expect(log().filter((l) => l.includes('auth status')).sort()).toEqual(['gh auth status --hostname github.com', 'gh auth status --hostname github.example.com']);
  });

  test('a sign-in is the tool’s own, with exactly these arguments; gh opens no browser and may ask the person', async () => {
    const p = programs();
    expect(await p.signIn('gh', 'github.example.com', true)).toBe(true);
    expect(await p.signIn('glab', 'git.example.org', false)).toBe(true);
    expect(await p.signIn('glab', 'gitlab.com', false)).toBe(true);
    expect(log().filter((l) => l.includes('auth login') || l.startsWith('GH_BROWSER'))).toEqual([
      'gh auth login --hostname github.example.com --git-protocol ssh --skip-ssh-key --web --scopes write:public_key,write:ssh_signing_key,user:email',
      'GH_BROWSER=true GH_PROMPT_DISABLED=',
      'glab auth login --hostname git.example.org --git-protocol ssh',
      'GH_BROWSER= GH_PROMPT_DISABLED=',
      'glab auth login --hostname gitlab.com --git-protocol ssh --device',
      'GH_BROWSER= GH_PROMPT_DISABLED=',
    ]);
  });

  test('the API is read whole as JSON; a refusal is said with the tool’s own last line', async () => {
    const p = programs();
    writeFileSync(join(home, '.api-github.com-user_emails'), JSON.stringify([{ email: 'sam@example.com', verified: true, primary: true }]));
    expect(await p.api('gh', 'github.com', 'user/emails')).toEqual({ ok: true, json: [{ email: 'sam@example.com', verified: true, primary: true }] });
    writeFileSync(join(home, '.refuse-github.com-user_keys'), '');
    expect(await p.api('gh', 'github.com', 'user/keys')).toEqual({ ok: false, reason: 'gh could not read user/keys at github.com: HTTP 403: Resource not accessible by integration (https://api.github.com/user/keys)' });
    expect(log()).toContain('gh api --hostname github.com user/emails');
  });

  test('add the key with the exact command, the host in the tool’s own variable', async () => {
    const p = programs();
    await p.makeKey('c');
    const pub = join(dataDir, 'git', 'id_ed25519.pub');
    expect(await p.addKey('gh', 'github.com', 'Kestrel worker node n', 'signing')).toEqual({ ok: true });
    expect(await p.addKey('glab', 'git.example.org', 'Kestrel worker node n', 'auth_and_signing')).toEqual({ ok: true });
    expect(log().slice(-2)).toEqual([`gh ssh-key add ${pub} --title Kestrel worker node n --type signing`, `glab ssh-key add ${pub} --title Kestrel worker node n --usage-type auth_and_signing`]);
    expect(existsSync(join(home, '.added-git.example.org'))).toBe(true);
    untouched();
  });
});

/** The whole checklist against the stubs: the terminal's answers in turn, drawn plain. */
async function checklist(answers: string[], facts: NodeGitFacts, options = { unattended: false, manual: false }) {
  const lines: string[] = [];
  let state = JOIN_DRAW_START;
  const draw = (event: NodeJoinEvent) => {
    const drawn = drawJoinEvent(event, state, { plain: true, width: 120 });
    lines.push(...drawn.lines);
    state = drawn.state;
    return drawn.prompt;
  };
  const queue = [...answers];
  const io = {
    say: (e: NodeJoinEvent) => void draw(e),
    ask: async (step: JoinStep, prompt: string) => {
      const answer = queue.shift() ?? null;
      lines.push(`${draw({ event: 'ask', step, prompt })}${answer ?? ''}`);
      state = { printed: true, blank: false };
      return answer;
    },
    ran: () => undefined,
  };
  const code = await runGitChecklist({ programs: programs(), pins: toolPinsOf(), node: async () => facts, name: 'this-host', home, now: () => 1, sleep: async () => undefined }, io, options);
  return { code, text: lines.join('\n') };
}

const TWO_HOSTS: NodeGitFacts = { name: 'Worker node 1', repositories: ['github.com/acme/api', 'git.example.org/team/app'], accountUnknown: null, others: [{ computer: 'Mac mini', name: 'Sam Rivera', email: 'sam@example.com', signs: true }], othersUnknown: null };

describe('the whole checklist against the stubs', () => {
  beforeEach(() => {
    writeFileSync(join(home, '.api-github.com-user_emails'), JSON.stringify([{ email: 'sam@example.com', verified: true, primary: true }, { email: 'sam@personal.example', verified: true, primary: false }]));
    writeFileSync(join(home, '.api-git.example.org-user'), JSON.stringify({ id: 1, username: 'sam', email: 'sam@git.example.org', commit_email: null }));
  });

  // key, hosts, signing, name, glab sign-in, yes at git.example.org, yes at github.com, commit email
  const ANSWERS = ['', '', '', '', '', 'y', 'y', ''];

  test('the default path: each use of the key added once, at each host the way it takes it; run again, nothing added twice', async () => {
    const first = await checklist(ANSWERS, TWO_HOSTS);
    expect(first.code).toBe(0);
    const pub = join(dataDir, 'git', 'id_ed25519.pub');
    const adds = () => log().filter((l) => l.includes('ssh-key add'));
    expect(adds()).toEqual([
      `glab ssh-key add ${pub} --title Kestrel worker node Worker node 1 --usage-type auth_and_signing`,
      `gh ssh-key add ${pub} --title Kestrel worker node Worker node 1 --type authentication`,
      `gh ssh-key add ${pub} --title Kestrel worker node Worker node 1 --type signing`,
    ]);
    // glab was not signed in: its own sign-in ran; gh was, so its did not.
    expect(log().filter((l) => l.includes('auth login'))).toEqual(['glab auth login --hostname git.example.org --git-protocol ssh']);
    const second = await checklist(['', '', '', 'y', 'y', ''], TWO_HOSTS);
    expect(second.code).toBe(0);
    expect(adds()).toHaveLength(3);
    expect(second.text).toContain('ok: The key is already at git.example.org');
    expect(second.text).toContain('ok: It is already registered for signing at github.com');
    const settings = JSON.parse(readFileSync(join(dataDir, 'git', 'git.json'), 'utf8'));
    expect(settings.hosts['git.example.org']).toMatchObject({ answer: 'works', signing: 'registered', email: 'sam@git.example.org' });
    expect(settings.hosts['github.com']).toMatchObject({ answer: 'works', signing: 'registered' });
    // The stubs printed a token to Kestrel; it was read for nothing and shown nowhere, and no private half either.
    expect(seen.some((s) => s.output.includes(TOKEN))).toBe(true);
    for (const text of [first.text, second.text, readFileSync(join(dataDir, 'git', 'git.json'), 'utf8')]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(PRIVATE_TEXT);
    }
    untouched();
  });

  test('a refused key list leaves that host by hand: nothing added there, and the still-to-do list says where', async () => {
    writeFileSync(join(home, '.refuse-github.com-user_keys'), '');
    const r = await checklist([...ANSWERS.slice(0, 7), 's', ''], TWO_HOSTS);
    expect(r.code).toBe(1);
    expect(log().filter((l) => l.startsWith('gh ssh-key add'))).toEqual([]);
    expect(r.text).toContain('gh could not read user/keys at github.com: HTTP 403');
    expect(r.text).toMatch(/6 {2}Still to do\n {3}1\. Add the key at github\.com\. At github\.com: Settings -> SSH and GPG keys -> New SSH key/);
  });

  test('unattended: the key made and tested, no sign-in run, nothing read or added at a host', async () => {
    const r = await checklist([], TWO_HOSTS, { unattended: true, manual: false });
    expect(r.code).toBe(1);
    expect(r.text).toContain('ok: Made a key: SHA256:stubnodekey');
    expect(r.text).toContain('glab auth login --hostname git.example.org --git-protocol ssh');
    expect(log().filter((l) => /ssh-key add|auth login| api /.test(l))).toEqual([]);
    expect(r.text).not.toContain(TOKEN);
    expect(mode(join(dataDir, 'git', 'git.json'))).toBe(0o600);
    untouched();
  });
});
