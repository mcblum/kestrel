// The demo workspace (`pnpm demo`, seed-demo.ts): it seeds without being refused, and every part
// of the app it is there to show has something in it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { memoryPersistence } from './persistence/memory.ts';
import { SavedActionsPrefs } from './saved-actions/prefs.ts';
import { seedFakeWorkspace } from './seed.ts';
import { makeDemoProjects, seedDemoExtras } from './seed-demo.ts';
import { Workspace } from './workspace.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'kestrel-demo-test-'));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe('the demo workspace', () => {
  it('makes real folders for its projects: git repositories with one commit, and one plain folder', () => {
    const paths = makeDemoProjects(dataDir);
    expect(Object.keys(paths).sort()).toEqual(['bellbird', 'docs', 'field-notes', 'platform']);
    expect(execFileSync('git', ['log', '--oneline'], { cwd: paths.platform!, encoding: 'utf8' }).trim().split('\n')).toHaveLength(1);
    expect(existsSync(join(paths['field-notes']!, '.git'))).toBe(false);
    // A second start leaves what is there alone.
    expect(makeDemoProjects(dataDir)).toEqual(paths);
  });

  it('has something in every part of the sidebar and the pages behind it', async () => {
    const ws = new Workspace(memoryPersistence());
    const actions = new SavedActionsPrefs();
    await seedFakeWorkspace(ws, makeDemoProjects(dataDir));
    await seedDemoExtras(ws, actions);
    const state = await ws.state();

    expect(state.projects.map((p) => p.folders[0]?.path)).toEqual(expect.arrayContaining([join(dataDir, 'projects', 'bellbird')]));
    expect(state.pins.map((p) => p.kind).sort()).toEqual(['project', 'session']);
    expect(state.groups.some((g) => g.projectId === 'platform')).toBe(true);
    expect(state.groups.some((g) => !g.projectId)).toBe(true);
    expect(state.archived.sessions.map((s) => s.id)).toContain('old-spike');
    expect(new Set(state.sessions.flatMap((s) => s.tags))).toEqual(new Set(['perf', 'PROJ-482', 'v2.3']));
    expect(state.workstreams.map((w) => w.status).sort()).toEqual(['active', 'complete']);
    expect(state.waits).toHaveLength(1);
    expect(new Set(state.links.map((l) => l.kind))).toEqual(new Set(['delegate', 'handoff']));
    expect(new Set(state.sessions.map((s) => s.agent))).toEqual(new Set(['claude', 'codex', 'opencode']));
    expect(new Set(state.sessions.map((s) => s.state))).toEqual(new Set(['running', 'attention', 'done']));
    expect(state.sessions.some((s) => s.request)).toBe(true);
    expect(Object.keys(await actions.all()).sort()).toEqual(['bellbird', 'platform']);
  });
});
