import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { memoryPersistence } from './persistence/memory.ts';
import { Workspace } from './workspace.ts';
import { seedSidebar } from './seed-sidebar.ts';

it('seeds a busy workspace with a cross-project workstream and curated navigation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kestrel-demo-sidebar-'));
  try {
    const db = memoryPersistence();
    await seedSidebar(db, dir);
    const state = await new Workspace(db).state();
    expect(state.projects).toHaveLength(12);
    expect(state.sessions).toHaveLength(16);
    // Some terraform work is days old, so the project folds it away.
    const old = state.sessions.filter((s) => s.filing.projectId === 'terraform' && Date.now() - s.updatedAt > 24 * 60 * 60 * 1000);
    expect(old.length).toBeGreaterThanOrEqual(4);
    expect(JSON.parse((await db.getSetting('colours'))!).projects.terraform).toBe('blue');
    expect(state.workstreams).toHaveLength(1);
    expect(state.links.some(link => link.kind === 'delegate')).toBe(true);
    expect(state.pins.some(pin => pin.id === 'asa')).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
