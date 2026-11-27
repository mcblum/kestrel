// The steps of Set up this computer (onboarding.md, section 18): how each installs per platform, what
// each line needs first, the section cards' summaries and commands, and dismissing.
import { describe, expect, it } from 'vitest';
import { agentRecipeOf, commandText, installRecipeOf, NO_HOST, versionOf } from './setup-install.ts';
import { copySourceText, missingText, setupActLabel, setupListOf, sshKeyHostEnv, type SetupChecks, type SetupLine } from './setup-list.ts';
import { mcpRunnerTool, unmetNeeds } from './setup-needs.ts';
import { applyDismissals, freshRuns, itemId, nextDismissals, sectionActLabel, sectionCommandOf, setupSectionOf } from './setup-sections.ts';
import { SETUP_RECORD_VERSION, type SetupRecord } from './setup-record.ts';
import type { Platform } from './platform.ts';

function rec(id: string, name: string, platform: Platform, extra: Partial<SetupRecord> = {}): SetupRecord {
  return { v: SETUP_RECORD_VERSION, kind: 'setup', machine: { id, name, platform }, readAt: 1, agents: [], hosts: [], git: { name: null, email: null, signs: false, format: null, signingKey: null }, ssh: { hosts: [], keyFiles: [] }, mcp: [], files: [], tools: [], projects: [], problems: [], ...extra };
}

const laptop = rec('a', 'MacBook Pro', 'mac', {
  agents: [
    { agent: 'claude', state: 'ready' },
    { agent: 'codex', state: 'ready' },
  ],
  hosts: [
    { tool: 'gh', host: 'github.com', user: 'octo', protocol: 'https', signedIn: true },
    { tool: 'glab', host: 'gitlab.example.com', user: 'octo', protocol: 'ssh', signedIn: true },
  ],
  git: { name: "Octo O'Cat", email: 'o@example.com', signs: false, format: null, signingKey: null },
  tools: [
    { name: 'uv', why: ['the MCP server home'], found: true },
    { name: 'pnpm', why: ["pnpm@9.15.0 in Wren's package.json"], found: true },
    { name: 'rtk', why: ["a hook in Claude's settings"], found: true },
    { name: 'gh', why: ['x'], found: true },
  ],
  projects: [
    { name: 'Wren', folders: [{ name: 'wren', path: '~/Code/wren', origin: 'git@gitlab.example.com:me/wren.git' }] },
    { name: 'Site', folders: [{ name: 'site', path: '~/Code/site', origin: 'https://github.com/me/site.git' }] },
  ],
  mcp: [
    { name: 'home', scope: 'user', transport: 'stdio', command: 'uvx', args: ['mcp-home'], url: null, env: ['TOKEN'], headers: [], blanks: [{ kind: 'env', name: 'TOKEN' }], appProgram: null },
    { name: 'kidsafe', scope: 'user', transport: 'stdio', command: 'uv', args: ['run', '--directory', '~/Code/wren', 'kidsafe'], url: null, env: [], headers: [], blanks: [], appProgram: null },
  ],
  files: [
    { agent: 'claude', kind: 'settings', path: '~/.claude/settings.json', files: 1, keyAt: null, env: [], plugins: [] },
    { agent: 'claude', kind: 'skill', path: '~/.claude/skills/one', files: 1, keyAt: null, env: [], plugins: [] },
    { agent: 'claude', kind: 'skill', path: '~/.claude/skills/two', files: 1, keyAt: null, env: [], plugins: [] },
  ],
});

const mini = rec('b', 'Mac mini', 'mac', { agents: [{ agent: 'claude', state: 'ready' }, { agent: 'codex', state: 'missing' }] });
const checks = (extra: Partial<SetupChecks> = {}): SetupChecks => ({ tool: () => false, ...extra });
const byId = (lines: SetupLine[]) => (id: string) => {
  const found = lines.find((l) => l.id === id);
  if (!found) throw new Error(`no line ${id}: ${lines.map((l) => l.id).join(', ')}`);
  return found;
};

describe('installing, per platform', () => {
  it('a Mac with Homebrew installs as the user; without it the install needs Homebrew, which is pasted', () => {
    expect(installRecipeOf('gh', 'mac', { ...NO_HOST, brew: true })).toMatchObject({ run: 'user', argv: ['brew', 'install', 'gh'], needs: null });
    expect(installRecipeOf('gh', 'mac', NO_HOST)).toMatchObject({ run: 'user', needs: 'Homebrew' });
    expect(installRecipeOf('Homebrew', 'mac', NO_HOST)).toMatchObject({ run: 'paste', argv: null });
    expect(installRecipeOf('Xcode', 'mac', NO_HOST)).toMatchObject({ run: 'open', url: expect.stringContaining('macappstores://') });
    expect(installRecipeOf('git', 'mac', NO_HOST)).toMatchObject({ run: 'os-prompt', argv: ['xcode-select', '--install'] });
  });

  it('Linux uses polkit where there is a desktop agent, and otherwise shows sudo to paste, never running it', () => {
    expect(installRecipeOf('gh', 'linux', { ...NO_HOST, packager: 'apt', polkit: true })).toMatchObject({ run: 'os-prompt', argv: ['pkexec', 'apt-get', 'install', '-y', 'gh'] });
    const pasted = installRecipeOf('gh', 'linux', { ...NO_HOST, packager: 'apt' })!;
    expect(pasted).toMatchObject({ run: 'paste', argv: null, command: { shell: 'sh', text: 'sudo apt-get install -y gh' } });
    expect(installRecipeOf('uv', 'linux', NO_HOST)).toMatchObject({ run: 'user', argv: ['/bin/sh', '-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'] });
    expect(installRecipeOf('Xcode', 'linux', NO_HOST)).toBeNull();
  });

  it('Windows uses winget, which raises UAC itself, and shows PowerShell', () => {
    expect(installRecipeOf('gh', 'windows', NO_HOST)).toMatchObject({ run: 'os-prompt', argv: ['winget', 'install', '--id', 'GitHub.cli', '-e', '--source', 'winget'], command: { shell: 'powershell' } });
    expect(installRecipeOf('rtk', 'windows', NO_HOST)).toBeNull();
  });

  it('pnpm from Homebrew on a Mac, and elsewhere at the version a project names, as the user only when npm writes to the user', () => {
    expect(versionOf('pnpm', ["pnpm@9.15.0 in Wren's package.json"])).toBe('9.15.0');
    // One Homebrew pnpm serves projects that pin different versions: no version is picked for them.
    expect(installRecipeOf('pnpm', 'mac', { ...NO_HOST, brew: true }, ["pnpm@9.15.0 in Wren's package.json", "pnpm@12.3.4 in Kestrel's package.json"])).toMatchObject({ run: 'user', argv: ['brew', 'install', 'pnpm'], needs: null });
    expect(installRecipeOf('pnpm', 'mac', NO_HOST, [])).toMatchObject({ run: 'user', argv: ['brew', 'install', 'pnpm'], needs: 'Homebrew' });
    expect(installRecipeOf('pnpm', 'linux', { ...NO_HOST, npmUser: true }, ["pnpm@9.15.0 in Wren's package.json"])).toMatchObject({ run: 'user', argv: ['npm', 'install', '-g', 'pnpm@9.15.0'], needs: 'node' });
    expect(installRecipeOf('pnpm', 'linux', NO_HOST, [])).toMatchObject({ run: 'paste' });
  });

  it('agents install with their own installers', () => {
    expect(agentRecipeOf('codex', 'mac', { ...NO_HOST, brew: true })).toMatchObject({ argv: ['brew', 'install', 'codex'] });
    expect(agentRecipeOf('claude', 'windows', NO_HOST)!.command).toEqual({ shell: 'powershell', text: 'irm https://claude.ai/install.ps1 | iex' });
  });

  it('quotes for each shell, leaving ~/ to the shell', () => {
    expect(commandText(['git', 'config', '--global', 'user.name', "Octo O'Cat"], 'sh')).toBe(`git config --global user.name 'Octo O'\\''Cat'`);
    expect(commandText(['git', 'clone', 'x', '~/Code/wren'], 'sh')).toBe('git clone x ~/Code/wren');
    expect(commandText(['a', "it's"], 'powershell')).toBe(`a 'it''s'`);
  });
});

describe('what each line needs first', () => {
  const lines = setupListOf(mini, [laptop], checks()).lines;
  const line = byId(lines);

  it('a sign-in needs its agent installed, and the install needs what its route runs', () => {
    expect(line('agent:codex').needs).toEqual(['agent:codex:install']);
    expect(line('agent:codex:install').command!.text).toBe('npm install -g @openai/codex');
    expect(line('tool:uv').needs).toEqual([]);
    expect(line('tool:gh').needs).toEqual(['tool:Homebrew']);
    expect(line('tool:Homebrew')).toMatchObject({ run: 'paste', action: null });
  });

  it('a clone over SSH needs this computer key for its host; over HTTPS the host sign-in', () => {
    const identity = "git:identity:Octo O'Cat <o@example.com>";
    expect(line('project:git@gitlab.example.com:me/wren.git').needs).toEqual([identity, 'ssh-key:gitlab.example.com']);
    expect(line('project:https://github.com/me/site.git').needs).toEqual([identity, 'host:gh:github.com']);
    expect(line('ssh-key:gitlab.example.com')).toMatchObject({ kind: 'here', action: { kind: 'ssh-key', host: 'gitlab.example.com', tool: 'glab' } });
    expect(line('ssh-key:gitlab.example.com').needs).toEqual(['host:glab:gitlab.example.com']);
  });

  it('an MCP server needs its runner, and a project its folder is in; settings need their hooks tools', () => {
    expect(mcpRunnerTool('uvx')).toBe('uv');
    expect(line('mcp:home').needs).toEqual(['tool:uv']);
    expect(line('mcp:kidsafe').needs).toEqual(['tool:uv', 'project:git@gitlab.example.com:me/wren.git']);
    expect(line('file:~/.claude/settings.json').needs).toEqual(['tool:rtk']);
    expect(unmetNeeds(line('mcp:home'), lines).map((l) => l.id)).toEqual(['tool:uv']);
  });

  it('no line needs itself, and the needs never go round', () => {
    const ids = new Map(lines.map((l) => [l.id, l]));
    const visit = (id: string, path: string[]): void => {
      expect(path).not.toContain(id);
      for (const next of ids.get(id)?.needs ?? []) visit(next, [...path, id]);
    };
    for (const l of lines) visit(l.id, []);
  });

  it('fully defined steps do not offer Ask the agent; steps that need judgment do', () => {
    expect(line('git:identity:Octo O\'Cat <o@example.com>').askAgent).toBe(false);
    expect(line('mcp:home').askAgent).toBe(true); // a local command may need software
    expect(line('files:claude:skill').askAgent).toBe(false);
    expect(line('tool:uv').askAgent).toBe(true);
    expect(line('project:https://github.com/me/site.git').askAgent).toBe(true);
  });
});

describe('a wait that is over', () => {
  const lines = [{ id: 'a', done: true }, { id: 'b', done: false }, { id: 'c', done: false }];
  it('goes once the step it waited on is done, and stays while it is not', () => {
    const runs = { b: { state: 'waiting' as const, at: 1, on: '"A"', need: 'a' }, c: { state: 'waiting' as const, at: 1, on: '"B"', need: 'b' } };
    expect(Object.keys(freshRuns(runs, lines))).toEqual(['c']);
  });
  it('goes when the step itself is done, and leaves a failure or a finished run alone', () => {
    const runs = { a: { state: 'waiting' as const, at: 1, on: 'you' }, b: { state: 'failed' as const, at: 1, reason: 'no', output: '' }, c: { state: 'done' as const, at: 1, said: 'ok' } };
    expect(Object.keys(freshRuns(runs, lines))).toEqual(['b', 'c']);
  });
  it('is the same object when nothing is stale', () => {
    const runs = { b: { state: 'waiting' as const, at: 1, on: 'you: choose' } };
    expect(freshRuns(runs, lines)).toBe(runs);
  });
});

describe('adding this computer\'s key at a host', () => {
  it('names the host for glab and gh, except the one each goes to by itself', () => {
    expect(sshKeyHostEnv('glab', 'gitlab.example.com')).toEqual({ GITLAB_HOST: 'gitlab.example.com' });
    expect(sshKeyHostEnv('glab', 'gitlab.com')).toBeNull();
    expect(sshKeyHostEnv('gh', 'github.com')).toBeNull();
    expect(sshKeyHostEnv('gh', 'ghe.example.com')).toEqual({ GH_HOST: 'ghe.example.com' });
  });
  it('the shown command for a GitLab of your own carries its host', () => {
    const key = setupListOf(mini, [laptop], checks()).lines.find((l) => l.id === 'ssh-key:gitlab.example.com');
    expect(key?.command?.text).toContain('GITLAB_HOST=gitlab.example.com glab ssh-key add');
  });
});

describe('a project that is already cloned here', () => {
  it('is done when Kestrel has it, whichever way its address is written', () => {
    const here = { ...mini, projects: [{ name: 'Wren', folders: [{ name: 'wren', path: '~/Code/wren', origin: 'https://gitlab.example.com/me/wren' }] }] };
    const wren = setupListOf(here, [laptop], checks()).lines.find((l) => l.id === 'project:git@gitlab.example.com:me/wren.git');
    expect(wren?.done).toBe(true);
  });
  it('is only added to Kestrel, not cloned again, when its folder is there and Kestrel does not have it', () => {
    const wren = setupListOf(mini, [laptop], checks({ originAt: (path) => (path === '~/Code/wren' ? 'https://gitlab.example.com/me/wren.git' : null) })).lines.find((l) => l.id === 'project:git@gitlab.example.com:me/wren.git');
    expect(wren).toMatchObject({ title: 'Add Wren to Kestrel', done: false, command: null });
    expect(wren?.does).toContain('already cloned at ~/Code/wren');
    expect(setupActLabel(wren!)).toBe('Add to Kestrel');
  });
});

describe('what a button says', () => {
  it('Run for a step with a terminal command, and where a copy comes from for one with none', () => {
    const sh = { shell: 'sh' as const, text: 'x' };
    const from = ['MacBook Pro'];
    expect(setupActLabel({ action: { kind: 'clone', origin: 'o', path: 'p', project: 'P', folder: 'f' }, command: sh, run: 'user', from })).toBe('Run');
    expect(setupActLabel({ action: { kind: 'mcp', server: {} as never }, command: null, run: 'user', from })).toBe('Copy from MacBook Pro');
    expect(setupActLabel({ action: { kind: 'files', agent: 'claude', paths: [] }, command: null, run: 'user', from })).toBe('Copy from MacBook Pro');
    expect(setupActLabel({ action: { kind: 'ssh-hosts', hosts: [] }, command: null, run: 'user', from: ['MacBook Pro', 'Studio'] })).toBe('Copy from your other computers');
    expect(setupActLabel({ action: { kind: 'knowledge', repo: 'r', name: 'n' }, command: null, run: 'user', from })).toBe('Use as knowledge base');
    expect(copySourceText(['MacBook Pro', 'MacBook Pro'])).toBe('MacBook Pro');
    expect(sectionActLabel('mcp', from)).toBe('Copy all from MacBook Pro');
    expect(sectionActLabel('settings', ['A', 'B'])).toBe('Copy all from your other computers');
    expect(sectionActLabel('git', from)).toBe('Run');
  });

  it('what is still to be typed here is called what it is', () => {
    expect(missingText(['HOMEASSISTANT_URL', 'HOMEASSISTANT_TOKEN'])).toBe('Missing environment variables');
    expect(missingText(['API_KEY'])).toBe('Missing environment variable');
    expect(missingText(['a personal access token'])).toBe('Missing');
    expect(missingText([])).toBe('');
  });
});

describe('section cards', () => {
  const lines = setupListOf(mini, [laptop], checks({ tool: (n) => n === 'uv' })).lines;

  it('a section says each of its commands once', () => {
    const key = (host: string) => ({ ...lines[0]!, id: `ssh-key:${host}`, group: 'git' as const, done: false, dismissed: false, kind: 'here' as const, command: { shell: 'sh' as const, text: `test -f ~/.ssh/id_ed25519 || ssh-keygen -t ed25519\nadd-key ${host}` } });
    expect(sectionCommandOf('git', [key('a.example.test'), key('b.example.test')])?.text).toBe('test -f ~/.ssh/id_ed25519 || ssh-keygen -t ed25519\nadd-key a.example.test\nadd-key b.example.test');
  });

  it('each section says what is in it and how much is done', () => {
    expect(setupSectionOf('projects', lines).summary).toBe('Clone projects: 2 repositories, 0 done; 2 need an earlier step');
    expect(setupSectionOf('tools', lines)).toMatchObject({ summary: '6 tools, 1 done; 3 need an earlier step', finished: false });
    expect(setupSectionOf('settings', lines).summary).toBe('Claude: 2 skills, 1 other file; 0 of 3 done; 1 needs an earlier step');
    expect(setupSectionOf('projects', lines, { 'project:https://github.com/me/site.git': { state: 'failed', at: 1, reason: 'x', output: '' } }).summary).toContain('1 failed');
  });

  it('one command covers a section where one does: Homebrew installs joined, clones one per line, none for MCP', () => {
    const brew = setupListOf(mini, [laptop], checks({ host: { ...NO_HOST, brew: true } })).lines;
    expect(sectionCommandOf('tools', brew)!.text.split('\n')[0]).toBe('brew install uv pnpm gh');
    // With no Homebrew yet, its own installer comes before anything that needs it.
    const bare = sectionCommandOf('tools', setupListOf(mini, [laptop], checks()).lines)!.text.split('\n');
    expect(bare.findIndex((c) => c.includes('Homebrew/install'))).toBeGreaterThanOrEqual(0);
    expect(bare.findIndex((c) => c.includes('Homebrew/install'))).toBeLessThan(bare.findIndex((c) => c.startsWith('brew install')));
    expect(sectionCommandOf('projects', lines)!.text).toBe('git clone git@gitlab.example.com:me/wren.git ~/Code/wren\ngit clone https://github.com/me/site.git ~/Code/site');
    expect(sectionCommandOf('mcp', lines)).toBeNull();
  });

  it('a section with every line done or dismissed is finished', () => {
    const list = applyDismissals(setupListOf(mini, [laptop], checks()), lines.filter((l) => l.group === 'mcp').map((l) => l.id));
    expect(setupSectionOf('mcp', list.lines)).toMatchObject({ finished: true, left: 0 });
  });
});

describe('dismissing', () => {
  const list = setupListOf(mini, [laptop], checks());

  it('marks the line and keeps ids that match nothing; restoring takes it back out', () => {
    const after = nextDismissals([], ['mcp:home', 'gone:line'], true);
    const marked = applyDismissals(list, after);
    expect(marked.lines.find((l) => l.id === 'mcp:home')!.dismissed).toBe(true);
    expect(after).toContain('gone:line');
    expect(nextDismissals(after, ['mcp:home'], false)).toEqual(['gone:line']);
  });

  it('one skill inside a grouped line can be dismissed, and Run then leaves it out', () => {
    const marked = applyDismissals(list, [itemId('files:claude:skill', 'two')]);
    const skills = marked.lines.find((l) => l.id === 'files:claude:skill')!;
    expect(skills.items!.names.map((n) => n.name)).toEqual(['one']);
    expect(skills.action).toEqual({ kind: 'files', agent: 'claude', paths: ['~/.claude/skills/one'] });
  });

  it('an unchanged list keeps its identity', () => {
    expect(applyDismissals(list, [])).toBe(list);
  });
});
