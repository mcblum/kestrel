// Each set-up step against a temporary home folder and a fake command runner: never the real home
// folder, git settings or the network (onboarding.md 18.9).
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupListOf, type SetupAction, type SetupLine, type SetupList } from '../shared/setup-list.ts';
import { NO_HOST } from '../shared/setup-install.ts';
import { SETUP_RECORD_VERSION, type SetupRecord } from '../shared/setup-record.ts';
import { executor, homePathHere, realHomePath, type ExecuteDeps } from './execute.ts';
import { cloneableOrigin, sshBlock, sshHostWritable } from './git-steps.ts';
import { nodeSetupFs, type RunOptions, type RunOutcome } from './io.ts';
import type { StepContext } from './steps.ts';
import type { SetupFileRecord } from '../shared/setup-files.ts';
import { blankKey } from './file-steps.ts';

type Answer = { code?: number; out?: string; problem?: string; then?: () => void };
let home: string;
let calls: { argv: string[]; options: RunOptions }[];
let answer: (argv: string[], options: RunOptions) => Answer;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kestrel-setup-'));
  calls = [];
  answer = () => ({});
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function deps(extra: Partial<ExecuteDeps> = {}): ExecuteDeps {
  return {
    home,
    platform: 'mac',
    dataDir: join(home, '.kestrel-data'),
    fs: nodeSetupFs,
    host: () => ({ ...NO_HOST, brew: true }),
    run: async (argv, options): Promise<RunOutcome> => {
      calls.push({ argv: [...argv], options });
      const a = answer([...argv], options);
      if (a.out) options.output?.(a.out);
      a.then?.();
      return { code: a.problem ? null : (a.code ?? 0), problem: a.problem ?? null };
    },
    ...extra,
  };
}

const rec = (extra: Partial<SetupRecord> = {}): SetupRecord => ({ v: SETUP_RECORD_VERSION, kind: 'setup', machine: { id: 'a', name: 'MacBook Pro', platform: 'mac' }, readAt: 1, agents: [], hosts: [], git: { name: null, email: null, signs: false, format: null, signingKey: null }, ssh: { hosts: [], keyFiles: [] }, mcp: [], files: [], tools: [], projects: [], problems: [], ...extra });
const listFrom = (other: SetupRecord): SetupList => setupListOf({ ...rec(), machine: { id: 'b', name: 'Mac mini', platform: 'mac' } }, [other], { tool: () => false, host: { ...NO_HOST, brew: true } });

let fileRecord: SetupFileRecord | null = null;

function ctxFor(list: SetupList, id: string, input: Record<string, string> = {}): StepContext & { said: string[] } {
  const line = list.lines.find((l) => l.id === id) as SetupLine;
  const said: string[] = [];
  return { line, list, input, output: () => undefined, say: (on) => void said.push(on), files: async () => fileRecord, said };
}
const run = (d: ExecuteDeps, list: SetupList, id: string, input: Record<string, string> = {}) => {
  const ctx = ctxFor(list, id, input);
  return { result: executor(d)(ctx.line.action as SetupAction, ctx), ctx };
};

describe('paths stay in this home folder', () => {
  it('refuses a path that climbs out or is elsewhere, and one a link carries out', () => {
    expect(homePathHere('~/Code/x', home)).toBe(join(home, 'Code/x'));
    expect(homePathHere('~/../etc/passwd', home)).toBeNull();
    expect(homePathHere('/etc/passwd', home)).toBeNull();
    expect(homePathHere('Code/x', home)).toBeNull();
    const outside = mkdtempSync(join(tmpdir(), 'kestrel-outside-'));
    symlinkSync(outside, join(home, 'escape'));
    expect(realHomePath('~/escape/file', { home, fs: nodeSetupFs })).toBeNull();
    rmSync(outside, { recursive: true, force: true });
  });

  it('a git address may not start with - and must be one', () => {
    expect(cloneableOrigin('git@gitlab.example.com:me/wren.git')).toBe(true);
    expect(cloneableOrigin('https://github.com/me/site.git')).toBe(true);
    expect(cloneableOrigin('--upload-pack=touch /tmp/x')).toBe(false);
    expect(cloneableOrigin('ext::sh -c touch')).toBe(false);
  });
});

describe('git identity', () => {
  it('sets user.name and user.email only, and Undo puts back what was there', async () => {
    const list = listFrom(rec({ git: { name: 'Octo', email: 'o@example.com', signs: false, format: null, signingKey: null } }));
    answer = (argv) => (argv.includes('--get') ? (argv.at(-1) === 'user.name' ? { out: 'Old Name\n' } : { code: 1 }) : {});
    const { result } = run(deps(), list, 'git:identity:Octo <o@example.com>');
    const done = await result;
    expect(done).toMatchObject({ state: 'done', said: 'Set user.name and user.email in your global git settings.' });
    expect(calls.filter((c) => !c.argv.includes('--get')).map((c) => c.argv)).toEqual([
      ['git', 'config', '--global', 'user.name', 'Octo'],
      ['git', 'config', '--global', 'user.email', 'o@example.com'],
    ]);
    calls = [];
    await (done as { undo: () => Promise<void> }).undo();
    expect(calls.map((c) => c.argv)).toEqual([
      ['git', 'config', '--global', 'user.name', 'Old Name'],
      ['git', 'config', '--global', '--unset', 'user.email'],
    ]);
  });
});

describe('SSH hosts', () => {
  const hosts = [
    { host: 'forge', hostName: 'gitlab.example.com', user: 'git', port: '2222', identityFiles: ['id_ed25519', 'id_rsa'], options: ['UseKeychain'] },
    { host: 'old', hostName: 'old.example.com', user: null, port: null, identityFiles: [], options: [] },
    { host: 'bad host\nProxyCommand x', hostName: 'x', user: null, port: null, identityFiles: [], options: [] },
  ];

  it('adds only the missing hosts, plain values only, IdentityFile where the file is here; Undo takes the block out', async () => {
    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.ssh', 'config'), 'Host old\n  HostName old.example.com\n');
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'not read');
    const list = listFrom(rec({ ssh: { hosts, keyFiles: [] } }));
    const done = await run(deps(), list, 'ssh:config').result;
    const text = readFileSync(join(home, '.ssh', 'config'), 'utf8');
    expect(text).toBe('Host old\n  HostName old.example.com\n\n# Added by Kestrel from MacBook Pro\nHost forge\n  HostName gitlab.example.com\n  User git\n  Port 2222\n  IdentityFile ~/.ssh/id_ed25519\n# End of what Kestrel added\n');
    expect(done).toMatchObject({ state: 'done', said: 'Added 1 host to ~/.ssh/config.' });
    await (done as { undo: () => Promise<void> }).undo();
    expect(readFileSync(join(home, '.ssh', 'config'), 'utf8')).toBe('Host old\n  HostName old.example.com\n');
  });

  it('writes a Host line with several names, and refuses one with other characters', () => {
    const several = { host: 'forge forge.example.com 10.0.0.2 !bad.example.com', hostName: 'forge.example.com', user: 'git', port: null, identityFiles: [], options: [] };
    expect(sshBlock([several], [], 'x', () => false)).toContain('Host forge forge.example.com 10.0.0.2 !bad.example.com\n  HostName forge.example.com');
    expect(sshHostWritable('forge  two')).toBe(false);
    expect(sshHostWritable('a;b')).toBe(false);
  });

  it('never writes a host whose name is not a plain word', () => {
    expect(sshBlock([hosts[2]!], [], 'x', () => false)).toBeNull();
  });
});

describe('installing', () => {
  it('runs the route as the user with Homebrew; never runs one that needs a password', async () => {
    const list = listFrom(rec({ tools: [{ name: 'uv', why: ['x'], found: true }] }));
    expect(await run(deps(), list, 'tool:uv').result).toMatchObject({ state: 'done' });
    expect(calls[0]).toMatchObject({ argv: ['brew', 'install', 'uv'], options: { timeoutMs: 600000 } });
    calls = [];
    const linux = deps({ platform: 'linux', host: () => ({ ...NO_HOST, packager: 'apt' }) });
    const ctx = ctxFor(list, 'tool:uv');
    const result = await executor(linux)({ kind: 'install', tool: 'gh', why: [] }, ctx);
    expect(result).toMatchObject({ state: 'failed', reason: expect.stringContaining('needs an administrator') });
    expect(calls).toEqual([]);
  });

  it('a failure carries its reason and output', async () => {
    const list = listFrom(rec({ tools: [{ name: 'uv', why: ['x'], found: true }] }));
    answer = () => ({ code: 1, out: 'Error: no bottle\n' });
    expect(await run(deps(), list, 'tool:uv').result).toEqual({ state: 'failed', reason: 'brew ended with code 1.', output: 'Error: no bottle\n' });
  });
});

describe('host sign-ins', () => {
  const other = rec({ hosts: [{ tool: 'gh', host: 'github.com', user: 'octo', protocol: 'https', signedIn: true }, { tool: 'glab', host: 'git.example.io', user: 'octo', protocol: 'ssh', signedIn: true }] });

  it('gh shows its one-time code on the line while it waits for the browser', async () => {
    answer = () => ({ out: '! First copy your one-time code: ABCD-1234\nOpen this URL to continue in your web browser: https://github.com/login/device\n' });
    const { result, ctx } = run(deps(), listFrom(other), 'host:gh:github.com');
    expect(await result).toMatchObject({ state: 'done' });
    expect(calls[0]!.argv).toEqual(['gh', 'auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https']);
    expect(ctx.said).toEqual(['you: enter ABCD-1234 at https://github.com/login/device']);
  });

  it('a glab token goes to glab standard input once, and nowhere in what the step answers', async () => {
    const token = 'glpat' + '-abcdefghijklmnopqrstu';
    const { result } = run(deps(), listFrom(other), 'host:glab:git.example.io', { token });
    const done = await result;
    expect(calls[0]!.argv).toEqual(['glab', 'auth', 'login', '--hostname', 'git.example.io', '--stdin', '--git-protocol', 'ssh']);
    expect(calls[0]!.options.stdin).toBe(`${token}\n`);
    expect(JSON.stringify(done)).not.toContain(token);
    expect(await run(deps(), listFrom(other), 'host:glab:git.example.io').result).toMatchObject({ state: 'waiting' });
  });
});

describe('this computer SSH key', () => {
  const other = rec({ hosts: [{ tool: 'glab', host: 'gitlab.example.com', user: 'octo', protocol: 'ssh', signedIn: true }], projects: [{ name: 'Wren', folders: [{ name: 'wren', path: '~/Code/wren', origin: 'git@gitlab.example.com:me/wren.git' }] }] });

  it('makes a key with no passphrase when there is none, adds its public half through glab, and checks git reaches the host', async () => {
    answer = (argv) => (argv[0] === 'ssh-keygen' && argv.includes('-F') ? { out: 'gitlab.example.com ED25519 SHA256:abc123=\n' } : {});
    const done = await run(deps(), listFrom(other), 'ssh-key:gitlab.example.com').result;
    expect(calls.map((c) => c.argv.slice(0, 3))).toEqual([['ssh-keygen', '-t', 'ed25519'], ['glab', 'ssh-key', 'add'], ['git', 'ls-remote', '--heads'], ['ssh-keygen', '-l', '-F']]);
    expect(calls[0]!.argv).toEqual(['ssh-keygen', '-t', 'ed25519', '-N', '', '-C', 'Mac mini', '-f', join(home, '.ssh', 'id_ed25519')]);
    expect(calls[2]!.options.env).toMatchObject({ GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new' });
    expect(done).toMatchObject({ state: 'done', said: expect.stringContaining('SHA256:abc123=') });
  });

  it('uses the key that is there', async () => {
    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'x');
    await run(deps(), listFrom(other), 'ssh-key:gitlab.example.com').result;
    expect(calls.some((c) => c.argv[0] === 'ssh-keygen' && c.argv.includes('-t'))).toBe(false);
  });
});

describe('cloning', () => {
  const other = rec({ projects: [{ name: 'Site', folders: [{ name: 'site', path: '~/Code/site', origin: 'https://github.com/me/site.git' }] }] });
  const added: string[] = [];
  const addProject = async (name: string, path: string) => (added.push(`${name}:${path}`), { said: `added ${name} to Kestrel.`, undo: async () => void added.pop() });

  it('clones after --, adds the project, and Undo removes both while the clone is untouched', async () => {
    answer = (argv) => (argv[1] === 'clone' ? { then: () => mkdirSync(argv[4]!, { recursive: true }) } : {});
    const done = await run(deps({ addProject }), listFrom(other), 'project:https://github.com/me/site.git').result;
    expect(calls[0]!.argv).toEqual(['git', 'clone', '--', 'https://github.com/me/site.git', join(home, 'Code/site')]);
    expect(added).toEqual([`Site:${join(home, 'Code/site')}`]);
    expect(done).toMatchObject({ state: 'done' });
    await (done as { undo: () => Promise<void> }).undo();
    expect(added).toEqual([]);
    expect(existsSync(join(home, 'Code/site'))).toBe(false);
  });

  it('refuses a folder that is there and is not that clone; only adds one that is', async () => {
    mkdirSync(join(home, 'Code/site'), { recursive: true });
    answer = () => ({ out: 'https://example.com/other.git' });
    expect(await run(deps({ addProject }), listFrom(other), 'project:https://github.com/me/site.git').result).toMatchObject({ state: 'failed', reason: expect.stringContaining('is not a clone of') });
    answer = () => ({ out: 'https://github.com/me/site.git' });
    expect(await run(deps({ addProject }), listFrom(other), 'project:https://github.com/me/site.git').result).toMatchObject({ state: 'done', said: expect.stringContaining('already a clone') });
    expect(calls.some((c) => c.argv[1] === 'clone')).toBe(false);
  });
});

describe('Bring over of agent files', () => {
  const laptop = rec({
    files: [
      { agent: 'claude', kind: 'instructions', path: '~/.claude/CLAUDE.md', files: 1, keyAt: null, env: [], plugins: [] },
      { agent: 'claude', kind: 'settings', path: '~/.claude/settings.json', files: 1, keyAt: null, env: ['TOKEN'], plugins: [] },
    ],
  });
  const record = (line: string, files: { path: string; text: string }[], blanks: SetupFileRecord['blanks'] = []): SetupFileRecord => ({ v: 1, kind: 'setup-files', machine: 'a', line, agent: 'claude', files, blanks, skipped: [] });

  it('says plainly when no computer holds the files yet', async () => {
    fileRecord = null;
    const { result } = run(deps(), listFrom(laptop), 'file:~/.claude/CLAUDE.md');
    expect(await result).toMatchObject({ state: 'failed', reason: expect.stringContaining('No other computer holds these files yet') });
  });

  it('writes a missing file, and Undo removes it', async () => {
    fileRecord = record('file:~/.claude/CLAUDE.md', [{ path: '~/.claude/CLAUDE.md', text: '# mine\n' }]);
    const done = await run(deps(), listFrom(laptop), 'file:~/.claude/CLAUDE.md').result;
    expect(done).toMatchObject({ state: 'done', said: 'Wrote one file.' });
    expect(readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8')).toBe('# mine\n');
    if (done.state === 'done') await done.undo?.();
    expect(existsSync(join(home, '.claude/CLAUDE.md'))).toBe(false);
  });

  it('never overwrites a file that differs without asking; Replace keeps a copy and Undo puts it back; Keep writes nothing over it', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude/CLAUDE.md'), 'theirs here');
    fileRecord = record('file:~/.claude/CLAUDE.md', [{ path: '~/.claude/CLAUDE.md', text: 'from laptop' }]);
    const asked = await run(deps(), listFrom(laptop), 'file:~/.claude/CLAUDE.md').result;
    expect(asked).toMatchObject({ state: 'waiting', ask: 'replace-or-keep' });
    expect(readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8')).toBe('theirs here');
    const kept = await run(deps(), listFrom(laptop), 'file:~/.claude/CLAUDE.md', { differ: 'keep' }).result;
    expect(kept).toMatchObject({ state: 'done', said: expect.stringContaining('Kept your file') });
    expect(readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8')).toBe('theirs here');
    const replaced = await run(deps(), listFrom(laptop), 'file:~/.claude/CLAUDE.md', { differ: 'replace' }).result;
    expect(readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8')).toBe('from laptop');
    if (replaced.state === 'done') await replaced.undo?.();
    expect(readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8')).toBe('theirs here');
  });

  it('refuses a record that writes outside the agent folder or the line, and writes nothing', async () => {
    fileRecord = record('file:~/.claude/CLAUDE.md', [{ path: '~/.claude/CLAUDE.md', text: 'ok' }, { path: '~/.zshrc', text: 'evil' }]);
    expect(await run(deps(), listFrom(laptop), 'file:~/.claude/CLAUDE.md').result).toMatchObject({ state: 'failed', reason: expect.stringContaining('Nothing was written') });
    expect(existsSync(join(home, '.zshrc'))).toBe(false);
    expect(existsSync(join(home, '.claude/CLAUDE.md'))).toBe(false);
  });

  it('puts a value typed here into a settings file, and names the ones left empty', async () => {
    const blanks = [{ path: '~/.claude/settings.json', name: 'TOKEN', at: ['env', 'TOKEN'] }, { path: '~/.claude/settings.json', name: 'OTHER', at: ['env', 'OTHER'] }];
    fileRecord = record('file:~/.claude/settings.json', [{ path: '~/.claude/settings.json', text: JSON.stringify({ env: { TOKEN: '', OTHER: '' } }) }], blanks);
    const done = await run(deps(), listFrom(laptop), 'file:~/.claude/settings.json', { [blankKey(blanks[0]!)]: 'typed-here' }).result;
    expect(JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'))).toEqual({ env: { TOKEN: 'typed-here', OTHER: '' } });
    expect(done).toMatchObject({ state: 'done', said: expect.stringContaining('OTHER in ~/.claude/settings.json') });
  });
});
