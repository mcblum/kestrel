// The Agent settings group of the set-up list (setup-list.ts, `fileLines`): each agent's skills are one
// line and its rules files one line, with the names inside; a file where a key was found, or one that
// needs a value entered here, stays a line of its own. Presentation only: the record is unchanged.
import { describe, expect, it } from 'vitest';
import type { Agent } from '../model.ts';
import { setupListOf, type SetupLine } from './setup-list.ts';
import { SETUP_RECORD_VERSION, type SetupFile, type SetupRecord } from './setup-record.ts';

function rec(id: string, name: string, files: SetupFile[] = []): SetupRecord {
  return { v: SETUP_RECORD_VERSION, kind: 'setup', machine: { id, name, platform: 'mac' }, readAt: 1, agents: [], hosts: [], git: { name: null, email: null, signs: false, format: null, signingKey: null }, ssh: { hosts: [], keyFiles: [] }, mcp: [], files, tools: [], projects: [], problems: [] };
}

const DIRS: Record<Agent, string> = { claude: '~/.claude', codex: '~/.codex', opencode: '~/.config/opencode' };
const skill = (agent: Agent, name: string, extra: Partial<SetupFile> = {}): SetupFile => ({ agent, kind: 'skill', path: `${DIRS[agent]}/skills/${name}`, files: 2, keyAt: null, env: [], plugins: [], ...extra });
const skills = (agent: Agent, n: number) => Array.from({ length: n }, (_, i) => skill(agent, `s${String(i).padStart(3, '0')}`));
const single = (agent: Agent, kind: SetupFile['kind'], path: string, extra: Partial<SetupFile> = {}): SetupFile => ({ agent, kind, path, files: 1, keyAt: null, env: [], plugins: [], ...extra });

const settingsOf = (lines: SetupLine[]) => lines.filter((l) => l.group === 'settings');
const lineOf = (lines: SetupLine[], id: string) => lines.find((l) => l.id === id)!;

describe('agent settings files in the set-up list', () => {
  it('hundreds of skills and rules files come to about a dozen lines', () => {
    const laptop = rec('a', 'MacBook Pro', [
      single('claude', 'instructions', '~/.claude/CLAUDE.md'),
      single('claude', 'rules', '~/.claude/rules', { files: 12 }),
      single('claude', 'settings', '~/.claude/settings.json'),
      ...skills('claude', 143),
      single('codex', 'instructions', '~/.codex/AGENTS.md'),
      single('codex', 'settings', '~/.codex/config.toml'),
      ...skills('codex', 40),
      single('opencode', 'settings', '~/.config/opencode/opencode.json'),
      ...skills('opencode', 20),
    ]);
    const lines = settingsOf(setupListOf(rec('b', 'Mac mini'), [laptop], { tool: () => false }).lines);
    expect(lines.map((l) => l.title)).toEqual([
      'Claude instructions: ~/.claude/CLAUDE.md',
      'Claude: 12 rules files',
      'Claude settings: ~/.claude/settings.json',
      'Claude: 143 skills',
      'Codex instructions: ~/.codex/AGENTS.md',
      'Codex settings: ~/.codex/config.toml',
      'Codex: 40 skills',
      'OpenCode settings: ~/.config/opencode/opencode.json',
      'OpenCode: 20 skills',
    ]);
    const claudeSkills = lineOf(lines, 'files:claude:skill');
    expect(claudeSkills).toMatchObject({ kind: 'bring', done: false, secrets: [], from: ['MacBook Pro'] });
    expect(claudeSkills.items).toMatchObject({ here: 0, total: 143, progress: null });
    expect(claudeSkills.items!.names).toHaveLength(143);
    expect(claudeSkills.items!.names[0]).toEqual({ name: 's000', done: false });
    expect(claudeSkills.does).toContain('~/.claude/skills');
    expect(lineOf(lines, 'files:claude:rules').items).toMatchObject({ total: 12, names: [{ name: '~/.claude/rules (12 files)', done: false }] });
    // Single files stay single lines with no items.
    expect(lineOf(lines, 'file:~/.claude/CLAUDE.md').items).toBeNull();
  });

  it('a group that is partly here says how many are, and is done only when all are', () => {
    const laptop = rec('a', 'MacBook Pro', skills('claude', 143));
    const partly = setupListOf(rec('b', 'Mac mini', skills('claude', 131)), [laptop], { tool: () => false });
    expect(lineOf(partly.lines, 'files:claude:skill')).toMatchObject({ done: false, items: { here: 131, total: 143, progress: '131 of 143 here' } });
    const all = setupListOf(rec('b', 'Mac mini', skills('claude', 143)), [laptop], { tool: () => false });
    expect(lineOf(all.lines, 'files:claude:skill')).toMatchObject({ done: true, items: { here: 143, total: 143, progress: null } });
  });

  it('a skill with a key, or one that needs a value here, stays a line of its own outside the group', () => {
    const laptop = rec('a', 'MacBook Pro', [
      skill('claude', 'clean'),
      skill('claude', 'dirty', { keyAt: { path: '~/.claude/skills/dirty/README.md', line: 3 } }),
      skill('claude', 'needs-env', { env: ['SERVICE_URL'] }),
      single('claude', 'rules', '~/.claude/rules', { files: 4, keyAt: { path: '~/.claude/rules/x.md', line: 9 } }),
    ]);
    const lines = settingsOf(setupListOf(rec('b', 'Mac mini'), [laptop], { tool: () => false }).lines);
    expect(lineOf(lines, 'files:claude:skill')).toMatchObject({ title: 'Claude: 1 skill', items: { total: 1, names: [{ name: 'clean', done: false }] } });
    expect(lineOf(lines, 'file:~/.claude/skills/dirty')).toMatchObject({ kind: 'cannot', does: '~/.claude/skills/dirty/README.md line 3 looks like a key. Remove it there to bring this skill.', items: null });
    expect(lineOf(lines, 'file:~/.claude/skills/needs-env')).toMatchObject({ kind: 'bring', secrets: ['SERVICE_URL'], items: null });
    expect(lineOf(lines, 'file:~/.claude/rules')).toMatchObject({ kind: 'cannot', items: null });
    // The rules folder was the only rules entry and it has a key: no rules group.
    expect(lines.some((l) => l.id === 'files:claude:rules')).toBe(false);
  });

  it('an agent with no skills has no skills line', () => {
    const laptop = rec('a', 'MacBook Pro', [single('codex', 'instructions', '~/.codex/AGENTS.md'), ...skills('claude', 3)]);
    const lines = settingsOf(setupListOf(rec('b', 'Mac mini'), [laptop], { tool: () => false }).lines);
    expect(lines.map((l) => l.id)).toEqual(['file:~/.codex/AGENTS.md', 'files:claude:skill']);
  });

  it('two machines make one group: their skills together, naming both machines', () => {
    const laptop = rec('a', 'MacBook Pro', [skill('claude', 'one'), skill('claude', 'two')]);
    const studio = rec('c', 'Studio', [skill('claude', 'two'), skill('claude', 'three')]);
    const here = rec('b', 'Mac mini', [skill('claude', 'one')]);
    const group = lineOf(setupListOf(here, [laptop, studio], { tool: () => false }).lines, 'files:claude:skill');
    expect(group).toMatchObject({ title: 'Claude: 3 skills', from: ['MacBook Pro', 'Studio'], done: false, items: { here: 1, total: 3, progress: '1 of 3 here' } });
    expect(group.items!.names).toEqual([
      { name: 'one', done: true },
      { name: 'three', done: false },
      { name: 'two', done: false },
    ]);
  });
});
