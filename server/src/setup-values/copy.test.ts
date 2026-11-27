// The asking computer's side (onboarding.md 19.4 and 19.6): refusals in words the person can act on,
// nothing written from an answer that is not exactly what was asked, and who may reach this code at all.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NEVER_REMOTE } from '../shared/connect-ops.ts';
import type { SetupLine, SetupList } from '../shared/setup-list.ts';
import { copyValues, type CopyDeps } from './copy.ts';

const line = (extra: Partial<SetupLine> = {}): SetupLine => ({ id: 'mcp:ha', group: 'mcp', kind: 'bring', title: 'ha', does: '', from: ['MacBook Pro'], secrets: ['A', 'B'], done: false, action: null, run: 'user', command: null, url: null, page: null, needs: [], dismissed: false, askAgent: false, items: null, copy: { missing: ['A', 'B'], offers: [{ id: 'laptop', name: 'MacBook Pro', names: ['A', 'B'], older: false }] }, ...extra });
const list = (l: SetupLine): SetupList => ({ here: { id: 'mini', name: 'Mac mini', platform: 'mac' }, others: [], lines: [l], problems: [] });

function deps(answer: Awaited<ReturnType<CopyDeps['ask']>>, l = line()) {
  const fill = vi.fn(async (_n: string, values: Readonly<Record<string, string>>) => Object.keys(values));
  const ask = vi.fn(async (_m: string, op: string) => (op === 'setup.values' ? answer : { ok: true as const, result: {} }));
  const d: CopyDeps = { list: async () => list(l), ask, runLine: vi.fn(), mcp: { has: async () => true, fill, clear: vi.fn() }, keepUndo: () => 'undo-1', newId: () => 'r1' };
  return { d, fill, ask };
}

describe('copying, refused', () => {
  it('says an older Kestrel there needs updating, when it answers with its words for anything under setup', async () => {
    const { d, fill } = deps({ ok: false, reached: true, reason: NEVER_REMOTE.setup! });
    await expect(copyValues(d, 'mcp:ha', 'laptop')).rejects.toThrow('Update Kestrel on MacBook Pro to copy values from it.');
    expect(fill).not.toHaveBeenCalled();
  });

  it('says a computer that cannot be reached by name, and takes the request back there', async () => {
    const { d, ask } = deps({ ok: false, reached: false, reason: 'That computer did not answer.' });
    await expect(copyValues(d, 'mcp:ha', 'laptop')).rejects.toThrow('MacBook Pro cannot be reached now. Type the values here, or try again when it is on.');
    expect(ask).toHaveBeenCalledWith('laptop', 'setup.values.withdraw', { requestId: 'r1' }, { timeoutMs: 5_000 });
  });

  it('writes nothing from an answer with a name not asked for', async () => {
    const { d, fill } = deps({ ok: true, result: { values: { A: 'x', C: 'y' }, notThere: ['B'] } });
    await expect(copyValues(d, 'mcp:ha', 'laptop')).rejects.toThrow('The other computer sent C, which was not asked for. Nothing was written.');
    expect(fill).not.toHaveBeenCalled();
  });

  it('asks only for the names on the line, of the computer clicked, and refuses one that has none or is older', async () => {
    const { d, ask } = deps({ ok: true, result: { values: { A: 'x' }, notThere: ['B'] } });
    await copyValues(d, 'mcp:ha', 'laptop');
    expect(ask).toHaveBeenCalledWith('laptop', 'setup.values', { requestId: 'r1', line: 'mcp:ha', names: ['A', 'B'] }, { timeoutMs: 130_000 });
    await expect(copyValues(d, 'mcp:ha', 'studio')).rejects.toThrow("That computer has none of ha's missing values.");
    const old = deps({ ok: true, result: {} }, line({ copy: { missing: ['A'], offers: [{ id: 'laptop', name: 'MacBook Pro', names: ['A'], older: true }] } }));
    await expect(copyValues(old.d, 'mcp:ha', 'laptop')).rejects.toThrow('Update Kestrel on MacBook Pro');
    const none = deps({ ok: true, result: {} }, line({ copy: null }));
    await expect(copyValues(none.d, 'mcp:ha', 'laptop')).rejects.toThrow('ha has no missing values to copy.');
    await expect(copyValues(none.d, 'agent:claude', 'laptop')).rejects.toThrow(/not on this computer's list/);
  });

  it('says when the other computer had none of them, and writes nothing', async () => {
    const { d, fill } = deps({ ok: true, result: { values: {}, notThere: ['A', 'B'] } });
    expect(await copyValues(d, 'mcp:ha', 'laptop')).toMatchObject({ copied: [], notThere: ['A', 'B'], said: 'MacBook Pro had none of them. Not on MacBook Pro: A and B; type them here.', undo: null });
    expect(fill).not.toHaveBeenCalled();
  });
});

describe('who reaches the code that reads and copies values', () => {
  const root = join(import.meta.dirname, '..');
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith('.ts') && !f.endsWith('.test.ts') ? [join(dir, f)] : []));
  const importers = (module: string) =>
    files(root)
      .filter((f) => new RegExp(`from '[./]*(?:\\.\\./)*setup-values/${module}\\.ts'|from '\\./${module}\\.ts'`).test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f))
      .filter((f) => !f.startsWith(`setup-values/${module}`))
      .sort();

  it('only the Connect module and the request holder import the reader; only the Connect module the copy; no tool or route of its own', () => {
    expect(importers('read')).toEqual(['connect/link/connect.ts', 'setup-values/requests.ts']);
    expect(importers('copy')).toEqual(['connect/link/connect.ts']);
    expect(importers('requests')).toEqual(['connect/dispatcher.ts', 'connect/link/connect.ts']);
  });
});
