// Running Set up this computer's steps (setup-actions/steps.ts): dismissals kept as a machine setting,
// one line refused with its reason, a section run in need order with its fully defined needs pulled in,
// stopping at what needs the person and carrying on with the rest, and Undo.
import { describe, expect, it } from 'vitest';
import { setupListOf, type SetupAction } from '../shared/setup-list.ts';
import { SETUP_RECORD_VERSION, type SetupRecord } from '../shared/setup-record.ts';
import { SETUP_DISMISSED_KEY, SetupSteps, type Execute } from './steps.ts';

const rec = (id: string, name: string, extra: Partial<SetupRecord> = {}): SetupRecord => ({ v: SETUP_RECORD_VERSION, kind: 'setup', machine: { id, name, platform: 'mac' }, readAt: 1, agents: [], hosts: [], git: { name: null, email: null, signs: false, format: null, signingKey: null }, ssh: { hosts: [], keyFiles: [] }, mcp: [], files: [], tools: [], projects: [], problems: [], ...extra });

const laptop = rec('a', 'MacBook Pro', {
  git: { name: 'Octo', email: 'o@example.com', signs: false, format: null, signingKey: null },
  hosts: [{ tool: 'gh', host: 'github.com', user: 'octo', protocol: 'https', signedIn: true }],
  tools: [{ name: 'uv', why: ['the MCP server home'], found: true }],
  projects: [
    { name: 'Site', folders: [{ name: 'site', path: '~/Code/site', origin: 'https://github.com/me/site.git' }] },
    { name: 'Wren', folders: [{ name: 'wren', path: '~/Code/wren', origin: 'git@gitlab.example.com:me/wren.git' }] },
  ],
  mcp: [{ name: 'home', scope: 'user', transport: 'stdio', command: 'uvx', args: ['mcp-home'], url: null, env: [], headers: [], blanks: [], appProgram: null }],
});

function harness(execute?: Execute, done: Set<string> = new Set()) {
  const settings = new Map<string, string>();
  const here = rec('b', 'Mac mini');
  const steps = new SetupSteps({
    list: async () => {
      const list = setupListOf(here, [laptop], { tool: (n) => n === 'git' || done.has(`tool:${n}`), host: { brew: true, npmUser: true, polkit: false, packager: null } });
      return { ...list, lines: list.lines.map((l) => (done.has(l.id) ? { ...l, done: true } : l)) };
    },
    settings: { getSetting: async (k) => settings.get(k) ?? null, putSetting: async (k, v) => void settings.set(k, v) },
    execute,
    now: () => 5,
  });
  return { steps, settings };
}

describe('dismissing', () => {
  it('is kept in this machine settings, applied to every read, and restored the same way', async () => {
    const { steps, settings } = harness();
    await steps.list();
    const after = await steps.dismiss(['mcp:home'], true);
    expect(after.lines.find((l) => l.id === 'mcp:home')!.dismissed).toBe(true);
    expect(JSON.parse(settings.get(SETUP_DISMISSED_KEY)!)).toEqual(['mcp:home']);
    expect((await steps.list()).lines.find((l) => l.id === 'mcp:home')!.dismissed).toBe(true);
    expect((await steps.dismiss(['mcp:home'], false)).lines.find((l) => l.id === 'mcp:home')!.dismissed).toBe(false);
  });

  it('refuses a request that names nothing', async () => {
    await expect(harness().steps.dismiss([], true)).rejects.toThrow(/ids/);
  });
});

describe('running', () => {
  it('one line: refused with the reason when its needs are not met; run when they are', async () => {
    const ran: SetupAction['kind'][] = [];
    const execute: Execute = async (action) => (ran.push(action.kind), { state: 'done', said: 'ok' });
    await expect(harness(execute).steps.runLine('project:https://github.com/me/site.git')).rejects.toThrow('"Clone Site" needs "Sign in to gh on github.com as octo" first.');
    await expect(harness(execute).steps.runLine('tool:Homebrew')).rejects.toThrow(/not on this computer/); // Homebrew is here
    await expect(harness(execute).steps.runLine('nope')).rejects.toThrow(/not on this computer/);
    const { steps } = harness(execute, new Set(['host:gh:github.com']));
    const report = await steps.runLine('project:https://github.com/me/site.git');
    expect(report).toMatchObject({ done: ['Git identity: Octo <o@example.com>', 'Clone Site'], failed: [], waiting: [], also: ['Git identity: Octo <o@example.com>'] });
    expect(steps.runs()['project:https://github.com/me/site.git']).toEqual({ state: 'done', at: 5, said: 'ok' });
    expect(ran).toEqual(['git-identity', 'clone']);
  });

  it('a section stops at what needs the person, names it, and carries on with the rest', async () => {
    const ran: string[] = [];
    const execute: Execute = async (_a, ctx) => (ran.push(ctx.line.id), { state: 'done', said: 'ok' });
    const { steps } = harness(execute);
    const report = await steps.runSection('projects');
    // The identity is run first; Site needs the gh sign-in (needs you); Wren this computer's SSH key (only on its own click).
    expect(ran).toEqual(['git:identity:Octo <o@example.com>']);
    expect(report.waiting).toEqual(['Clone Site', 'Clone Wren']);
    expect(steps.runs()['project:https://github.com/me/site.git']).toMatchObject({ state: 'waiting', on: '"Sign in to gh on github.com as octo"' });
    const git = await steps.runSection('git');
    expect(git.done).toEqual(['Git identity: Octo <o@example.com>']); // the fake list does not learn it was done
    expect(git.waiting).toEqual(expect.arrayContaining(['Sign in to gh on github.com as octo', "This computer's SSH key for gitlab.example.com"]));
  });

  it('a fully defined need from another section is run first, and said; an install is not pulled in', async () => {
    const ran: string[] = [];
    const execute: Execute = async (_a, ctx) => (ran.push(ctx.line.id), { state: 'done', said: 'ok' });
    const { steps } = harness(execute, new Set(['host:gh:github.com']));
    const report = await steps.runSection('projects');
    expect(ran).toEqual(['git:identity:Octo <o@example.com>', 'project:https://github.com/me/site.git']);
    expect(report.also).toEqual(['Git identity: Octo <o@example.com>']);
    const mcp = await harness(execute).steps.runSection('mcp');
    expect(mcp.waiting).toEqual(['home']);
  });

  it('a failure is recorded with its reason and last output, marks what depends on it, and never stops the rest', async () => {
    const execute: Execute = async (_a, ctx) => {
      ctx.output('line 1\nline 2\n');
      return ctx.line.id === 'tool:uv' ? { state: 'failed', reason: 'brew is not installed', output: '' } : { state: 'done', said: 'ok' };
    };
    const { steps } = harness(execute);
    const report = await steps.runSection('tools');
    expect(report.failed).toEqual(['uv']);
    expect(steps.runs()['tool:uv']).toEqual({ state: 'failed', at: 5, reason: 'brew is not installed', output: 'line 1\nline 2' });
    const git = await steps.runSection('git');
    expect(git.done).toEqual(['Git identity: Octo <o@example.com>']);
  });

  it('Undo takes back what a run did, newest first, once', async () => {
    const undone: string[] = [];
    const execute: Execute = async (_a, ctx) => ({ state: 'done', said: 'ok', undo: async () => void undone.push(ctx.line.id) });
    const { steps } = harness(execute, new Set(['host:gh:github.com']));
    const report = await steps.runSection('projects');
    await steps.undo(report.undo!);
    expect(undone).toEqual(['project:https://github.com/me/site.git', 'git:identity:Octo <o@example.com>']);
    await expect(steps.undo(report.undo!)).rejects.toThrow(/no longer/);
  });
});
