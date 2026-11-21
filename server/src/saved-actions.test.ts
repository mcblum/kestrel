// A project's saved actions (shared/saved-actions.ts, saved-actions/*, Terminals.runAction): the
// rules, which action an id names for a scope and where it runs, its terminal, and its preview.
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryPersistence } from './persistence/memory.ts';
import { savedActionsRoute } from './saved-actions/api.ts';
import { SavedActionsPrefs } from './saved-actions/prefs.ts';
import { resolveAction, waitForPreview, type ActionDeps } from './saved-actions/run.ts';
import { actionFolderProblem, actionsProblem, previewUrlProblem, sanitizeActionsByProject, type SavedAction } from './shared/saved-actions.ts';
import { fakePty } from './terminal-test-support.ts';
import { Terminals } from './terminals.ts';
import { Refused, Workspace } from './workspace.ts';

const tempDir = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `kestrel-${name}-`)));
const dev: SavedAction = { id: 'dev', name: 'Dev server', command: 'pnpm dev', folder: 'ui', previewUrl: 'http://localhost:5173' };
const test: SavedAction = { id: 'test', name: 'Test', command: 'pnpm test', folder: '', previewUrl: '' };

describe('the rules', () => {
  it('accepts a list of named one-line commands', () => {
    expect(actionsProblem([dev, test])).toBeNull();
    expect(actionsProblem([{ name: 'Lint', command: 'pnpm lint' }])).toBeNull();
  });

  it('refuses what it cannot run, naming the action and the reason', () => {
    expect(actionsProblem('x')).toBe('Send the actions as a list.');
    expect(actionsProblem([{ name: '', command: 'x' }])).toBe('Give every action a name.');
    expect(actionsProblem([{ name: 'Build', command: ' ' }])).toBe('Build: give it a command to run.');
    expect(actionsProblem([{ name: 'Build', command: 'a\nb' }])).toBe('Build: the command is one line. Put a longer one in a script file and run that.');
    expect(actionsProblem([{ ...dev, folder: '../other' }])).toBe('Dev server: The folder cannot reach outside the session\'s working folder.');
    expect(actionsProblem([{ ...dev, previewUrl: 'localhost:5173' }])).toBe('Dev server: The preview address must start with http:// or https://.');
    expect(actionsProblem([test, { ...test, id: 't2', name: 'test' }])).toBe('Two actions are called "test". Give each its own name.');
    expect(actionsProblem(Array.from({ length: 21 }, (_, i) => ({ name: `A${i}`, command: 'x' })))).toBe('A project can have at most 20 actions.');
  });

  it('keeps a folder inside the working folder and a preview on http or https', () => {
    expect(actionFolderProblem('packages/api')).toBeNull();
    expect(actionFolderProblem('/etc')).toMatch(/relative to the session's working folder/);
    expect(previewUrlProblem('')).toBeNull();
    expect(previewUrlProblem('nonsense')).toBe('Give the preview address in full, like http://localhost:5173.');
  });

  it('drops stored actions it cannot read', () => {
    expect(sanitizeActionsByProject({ p: [dev, { name: 'no id', command: 'x' }, { id: 'bad', name: 'Bad', command: '' }], q: 'nope', r: [] })).toEqual({ p: [dev] });
  });
});

describe('storing them', () => {
  it('gives a new action an id, keeps the ids of the others, and forgets a project left with none', async () => {
    const prefs = new SavedActionsPrefs();
    const stored = (await prefs.set('p', [dev, { name: ' Lint ', command: 'pnpm lint', folder: 'ui/' }])).p!;
    expect(stored[0]).toEqual(dev);
    expect(stored[1]).toMatchObject({ name: 'Lint', command: 'pnpm lint', folder: 'ui', previewUrl: '' });
    expect(stored[1]!.id).toMatch(/^[0-9a-f]{8}$/);
    expect(await prefs.set('p', [])).toEqual({});
  });

  it('serves and stores a project’s actions over HTTP, and refuses an unknown project or a bad list', async () => {
    const workspace = new Workspace(memoryPersistence());
    await workspace.addProject({ id: 'p', name: 'P', path: '/p', isGit: true });
    const prefs = new SavedActionsPrefs();
    const route = (method: string, body: Record<string, unknown> = {}) => savedActionsRoute(['api', 'saved-actions'], method, async () => body, workspace, prefs);
    expect(await route('GET')).toEqual({ status: 200, body: { actions: {} } });
    expect(await route('PUT', { projectId: 'nope', actions: [] })).toEqual({ status: 400, body: { error: 'No such project.' } });
    expect(await route('PUT', { projectId: 'p', actions: [{ name: 'x' }] })).toEqual({ status: 400, body: { error: 'x: give it a command to run.' } });
    expect(await route('PUT', { projectId: 'p', actions: [dev] })).toEqual({ status: 200, body: { actions: { p: [dev] } } });
    expect(await savedActionsRoute(['api', 'other'], 'GET', async () => ({}), workspace, prefs)).toBeNull();
  });
});

describe('which action runs, and where', () => {
  function world() {
    const worktree = tempDir('wt');
    mkdirSync(join(worktree, 'ui'));
    const root = tempDir('root');
    const deps: ActionDeps = {
      state: async () => ({ sessions: [{ id: 's1', startedIn: 'p', startedFolderId: 'f1' }], projects: [{ id: 'p', name: 'Bellbird', folders: [{ id: 'f1', path: root, isGit: true }] }] }) as never,
      actions: async () => ({ p: [dev, test] }),
      env: async () => ({ p: { vars: 'PORT=4000', files: [], copy: [] } }),
      folderOf: async (key) => (key === 's1' ? worktree : key === 'project:p' ? root : null),
    };
    return { deps, worktree, root };
  }

  it('runs a session’s action in its worktree, in the action’s folder, with the project’s variables', async () => {
    const { deps, worktree } = world();
    expect(await resolveAction(deps, 's1', 'dev')).toEqual({ action: dev, cwd: join(worktree, 'ui'), env: { PORT: '4000' } });
    expect(await resolveAction(deps, 's1', 'test')).toMatchObject({ cwd: worktree });
  });

  it('runs a project page’s action in the project’s own folder', async () => {
    const { deps, root } = world();
    expect(await resolveAction(deps, 'project:p', 'test')).toMatchObject({ action: test, cwd: root });
  });

  it('says why when there is no project, no such action, no such folder, or the folder leads outside', async () => {
    const { deps, worktree } = world();
    expect(await resolveAction(deps, 'group:g', 'dev')).toEqual({ refused: 'Actions belong to a project, and there is none here.' });
    expect(await resolveAction(deps, 's1', 'gone')).toEqual({ refused: 'Bellbird no longer has that action.' });
    expect(await resolveAction(deps, 'project:p', 'dev')).toEqual({ refused: 'Dev server runs in "ui", which is not a folder here.' });
    symlinkSync(tempDir('elsewhere'), join(worktree, 'out'));
    const outside = { ...deps, actions: async () => ({ p: [{ ...dev, folder: 'out' }] }) };
    expect(await resolveAction(outside, 's1', 'dev')).toEqual({ refused: 'Dev server runs in "out", which leads outside the working folder.' });
  });
});

describe('an action’s terminal', () => {
  const make = () => {
    const { spawn, spawned } = fakePty();
    return { terms: new Terminals(spawn, { SHELL: '/bin/zsh', KESTREL_TOKEN: 'secret' }, { titleCheckMs: 0, titlePollMs: 0 }), spawned };
  };

  it('opens a terminal named after the action, in its folder with its variables, and types the command', () => {
    const { terms, spawned } = make();
    const id = terms.runAction('s1', '/work/ui', dev, { PORT: '4000' }, { cols: 90, rows: 20 });
    expect(spawned[0]!.options).toMatchObject({ cwd: '/work/ui', cols: 90, rows: 20 });
    expect(spawned[0]!.options.env).toMatchObject({ PORT: '4000' });
    expect(spawned[0]!.options.env.KESTREL_TOKEN).toBeUndefined();
    expect(spawned[0]!.written).toEqual(['pnpm dev\r']);
    expect(terms.list('s1')).toEqual([expect.objectContaining({ id, title: 'Dev server', runner: false })]);
    terms.closeAll();
  });

  it('refuses while the action still runs, and starts over in a new terminal once its shell is free', () => {
    const { terms, spawned } = make();
    const id = terms.runAction('s1', '/work', test, {}, {});
    spawned[0]!.process = 'node';
    expect(() => terms.runAction('s1', '/work', test, {}, {})).toThrow(new Refused('Test is already running. Stop it in its terminal first.'));
    spawned[0]!.process = 'zsh';
    const again = terms.runAction('s1', '/elsewhere', test, { PORT: '5000' }, {});
    expect(again).not.toBe(id);
    expect(spawned[0]!.killed).toBe(true);
    expect(spawned[1]!.options).toMatchObject({ cwd: '/elsewhere', env: expect.objectContaining({ PORT: '5000' }) });
    expect(terms.list('s1')).toHaveLength(1);
    terms.closeAll();
  });

  it('opens a new terminal when the action’s old one has exited, and one per action', () => {
    const { terms, spawned } = make();
    const first = terms.runAction('s1', '/work', test, {}, {});
    spawned[0]!.end(0);
    const second = terms.runAction('s1', '/work', test, {}, {});
    expect(second).not.toBe(first);
    terms.runAction('s1', '/work', dev, {}, {});
    expect(terms.list('s1').map((t) => t.title)).toEqual(['Test', 'Dev server']);
    terms.closeAll();
  });
});

describe('waiting for a preview address', () => {
  it('is ready as soon as the address answers', async () => {
    let asked = 0;
    expect(await waitForPreview('http://localhost:1', { probe: async () => ++asked >= 3, everyMs: 1, waitMs: 1000 })).toBe(true);
    expect(asked).toBe(3);
  });

  it('gives up when it never answers in time, or the wait is ended', async () => {
    expect(await waitForPreview('http://localhost:1', { probe: async () => false, everyMs: 1, waitMs: 20 })).toBe(false);
    const ended = new AbortController();
    ended.abort();
    expect(await waitForPreview('http://localhost:1', { probe: async () => true, signal: ended.signal })).toBe(false);
  });
});
