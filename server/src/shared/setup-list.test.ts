// The set-up list (setup-list.ts): what the other machines have and this one lacks, by kind, with each
// line's check run against this machine.
import { describe, expect, it } from 'vitest';
import { setupLeft, setupListOf } from './setup-list.ts';
import { SETUP_RECORD_VERSION, splitArgs, splitRemote, splitUrl, type SetupRecord } from './setup-record.ts';
import type { Platform } from './platform.ts';

function rec(id: string, name: string, platform: Platform, extra: Partial<SetupRecord> = {}): SetupRecord {
  return { v: SETUP_RECORD_VERSION, kind: 'setup', machine: { id, name, platform }, readAt: 1, agents: [], hosts: [], git: { name: null, email: null, signs: false, format: null, signingKey: null }, ssh: { hosts: [], keyFiles: [] }, mcp: [], files: [], tools: [], projects: [], problems: [], ...extra };
}

const laptop = rec('a', 'MacBook Pro', 'mac', {
  agents: [
    { agent: 'claude', state: 'ready' },
    { agent: 'codex', state: 'ready' },
    { agent: 'opencode', state: 'missing' },
  ],
  hosts: [
    { tool: 'gh', host: 'github.com', user: 'octo', protocol: 'ssh', signedIn: true },
    { tool: 'glab', host: 'gitlab.example.com', user: 'octo', protocol: 'ssh', signedIn: false },
  ],
  git: { name: 'Octo', email: 'o@example.com', signs: true, format: 'openpgp', signingKey: 'ABCDEF12' },
  ssh: { hosts: [{ host: 'forge', hostName: 'forge.example.com', user: 'git', port: null, identityFiles: ['id_ed25519'], options: ['UseKeychain'] }], keyFiles: ['id_ed25519'] },
  tools: [
    { name: 'Xcode', why: ["Xcode in Vireo's Package.swift"], found: true },
    { name: 'uv', why: ['the MCP server home-assistant'], found: true },
  ],
  projects: [{ name: 'Wren', folders: [{ name: 'wren', path: '~/Code/wren', origin: 'git@gitlab.example.com:me/wren.git' }] }],
  mcp: [{ name: 'shrike', scope: 'desktop', transport: 'stdio', command: '/Applications/Shrike.app/Contents/MacOS/shrike-mcp', args: [], url: null, env: [], headers: [], blanks: [], appProgram: 'Shrike.app' }],
  files: [
    { agent: 'claude', kind: 'skill', path: '~/.claude/skills/dirty', files: 2, keyAt: { path: '~/.claude/skills/dirty/README.md', line: 3 }, env: [], plugins: [] },
    { agent: 'claude', kind: 'settings', path: '~/.claude/settings.json', files: 1, keyAt: null, env: ['ANTHROPIC_API_KEY'], plugins: [] },
  ],
});

describe('the set-up list', () => {
  it('on a second Mac: sign-ins act, signing cannot come, Already here is done', () => {
    const mini = rec('b', 'Mac mini', 'mac', { agents: [{ agent: 'claude', state: 'ready' }, { agent: 'codex', state: 'signed-out' }, { agent: 'opencode', state: 'missing' }], problems: [{ part: 'hosts', reason: 'glab is not installed.' }] });
    const list = setupListOf(mini, [laptop, mini], { tool: (n) => n === 'uv' });
    const line = (id: string) => list.lines.find((l) => l.id === id)!;
    expect(list.others.map((o) => o.name)).toEqual(['MacBook Pro']);
    expect(line('agent:claude')).toMatchObject({ done: true });
    expect(line('agent:codex')).toMatchObject({ kind: 'here', done: false, action: { kind: 'sign-in', agent: 'codex' } });
    expect(list.lines.some((l) => l.id === 'agent:opencode')).toBe(false);
    expect(line('host:gh:github.com')).toMatchObject({ kind: 'here', title: 'Sign in to gh on github.com as octo', action: null });
    expect(list.lines.some((l) => l.id === 'host:glab:gitlab.example.com')).toBe(false); // signed out there too
    expect(line('git:signing')).toMatchObject({ kind: 'cannot' });
    expect(line('ssh:config').does).not.toContain('without UseKeychain');
    expect(line('tool:Xcode')).toMatchObject({ kind: 'install', done: false });
    expect(line('tool:uv')).toMatchObject({ done: true });
    expect(line('project:git@gitlab.example.com:me/wren.git')).toMatchObject({ kind: 'bring', title: 'Clone Wren' });
    expect(line('mcp:shrike')).toMatchObject({ kind: 'bring' });
    expect(line('file:~/.claude/skills/dirty')).toMatchObject({ kind: 'cannot', does: '~/.claude/skills/dirty/README.md line 3 looks like a key. Remove it there to bring this skill.' });
    expect(line('file:~/.claude/settings.json').secrets).toEqual(['ANTHROPIC_API_KEY']);
    // Groups in the order the work needs them.
    expect([...new Set(list.lines.map((l) => l.group))]).toEqual(['agents', 'git', 'tools', 'projects', 'mcp', 'settings']);
    expect(setupLeft(list)).toBe(list.lines.filter((l) => !l.done && l.kind !== 'cannot').length);
  });

  it('on Linux: Xcode and a Mac app cannot come, and Mac-only SSH options are dropped', () => {
    const box = rec('c', 'worker-1', 'linux');
    const list = setupListOf(box, [laptop], { tool: () => false });
    expect(list.lines.find((l) => l.id === 'tool:Xcode')).toMatchObject({ kind: 'cannot' });
    expect(list.lines.find((l) => l.id === 'mcp:shrike')).toMatchObject({ kind: 'cannot' });
    expect(list.lines.find((l) => l.id === 'ssh:config')!.does).toContain('without UseKeychain');
    expect(list.lines.find((l) => l.id === 'agent:claude')).toMatchObject({ kind: 'install' });
  });

  it('one line for the same thing on two machines, naming both', () => {
    const other = rec('d', 'Studio', 'mac', { agents: [{ agent: 'codex', state: 'ready' }] });
    const list = setupListOf(rec('b', 'Mac mini', 'mac'), [laptop, other], { tool: () => false });
    expect(list.lines.find((l) => l.id === 'agent:codex')!.from).toEqual(['MacBook Pro', 'Studio']);
  });
});

describe('the split', () => {
  it('a URL keeps where it goes and names what it hides', () => {
    expect(splitUrl('https://u:p@host.example:8443/a/b?x=1&token=2#frag')).toEqual({
      url: 'https://host.example:8443/a/b?x=&token=',
      blanks: [
        { kind: 'url-user', name: 'user' },
        { kind: 'url-password', name: 'password' },
        { kind: 'url-query', name: 'x' },
        { kind: 'url-query', name: 'token' },
        { kind: 'url-fragment', name: 'fragment' },
      ],
    });
    expect(splitUrl('not a url')).toEqual({ url: null, blanks: [{ kind: 'url', name: 'address' }] });
  });

  it('a remote keeps git@ and drops any other user', () => {
    expect(splitRemote('git@github.com:me/x.git')).toBe('git@github.com:me/x.git');
    expect(splitRemote('matt@host.example:me/x.git')).toBe('host.example:me/x.git');
    expect(splitRemote('https://oauth2:' + 'glpat' + '-xxxxxxxxxxxxxxxxxxxx@gitlab.com/me/x.git')).toBe('https://gitlab.com/me/x.git');
  });

  it('arguments: flagged, assigned, key-shaped and header values are left out', () => {
    expect(splitArgs(['-y', 'pkg', '--token', 't', '--password=p', 'FOO=bar', '-H', 'X-Key: v', 'plain']).args).toEqual(['-y', 'pkg', '--token', null, '--password=…', 'FOO=…', '-H', null, 'plain']);
  });
});
