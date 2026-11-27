import { describe, expect, it } from 'vitest';
import type { Project } from '../model.ts';
import { CLONE_DISK_MIN_BYTES, hostSilentRefusal, keptOffRefusal, keyCannotReadRefusal, lowDiskRefusal, noKeyRefusal, plainFolderRefusal } from '../shared/project-clone.ts';
import { checkClone, headsOf, type CloneProbe, type LsRemote } from './checks.ts';

const shop: Project = {
  id: 'account|example.test/acme/shop',
  name: 'Shop',
  folders: [],
  defaultFolderId: null,
  away: true,
  elsewhere: {
    machines: [{ id: 'mini', name: 'Mac mini', projectId: 'p-mini' }],
    repos: ['example.test/acme/shop', 'example.test/acme/api'],
    folders: [
      { name: 'shop', isGit: true, repo: 'example.test/acme/shop' },
      { name: 'api', isGit: true, repo: 'example.test/acme/api' },
    ],
  },
};

/** A probe that answers as told, and records what was asked of the git host. */
function probe(over: Partial<{ key: boolean; free: number; ls: (url: string) => LsRemote }> = {}): CloneProbe & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    keyReady: () => over.key ?? true,
    freeBytes: () => over.free ?? CLONE_DISK_MIN_BYTES * 4,
    lsRemote: async (url) => (asked.push(url), over.ls?.(url) ?? { ok: true, heads: ['main'] }),
  };
}

const node = 'Worker node 1';

describe('what a node checks before it accepts a start that clones', () => {
  it('accepts with the plan when every check passes, asking the host once per repository', async () => {
    const p = probe();
    const plan = await checkClone(shop, { node, keptOff: [], probe: p });
    expect(plan.repos.map((r) => r.folder)).toEqual(['shop', 'api']);
    expect(p.asked).toEqual(['git@example.test:acme/shop.git', 'git@example.test:acme/api.git']);
  });

  it('refuses a project kept off, a plain folder, no key, and low disk before the git host is asked', async () => {
    const plain: Project = { ...shop, elsewhere: { ...shop.elsewhere!, repos: [], folders: [{ name: 'notes', isGit: false }] } };
    for (const [project, over, keptOff, words] of [
      [shop, {}, ['p-mini'], keptOffRefusal('Shop')],
      [plain, {}, [], plainFolderRefusal('Shop', 'Mac mini')],
      [shop, { key: false }, [], noKeyRefusal(node)],
      [shop, { free: 1024 }, [], lowDiskRefusal(node, 1024)],
    ] as const) {
      const p = probe(over);
      await expect(checkClone(project, { node, keptOff, probe: p })).rejects.toThrow(words);
      expect(p.asked).toEqual([]);
    }
  });

  it('refuses a repository the key may not read, naming it, and a host that does not answer', async () => {
    await expect(checkClone(shop, { node, keptOff: [], probe: probe({ ls: (url) => (url.includes('api') ? { ok: false, why: 'denied' } : { ok: true, heads: ['main'] }) }) })).rejects.toThrow(keyCannotReadRefusal(node, 'example.test/acme/api'));
    await expect(checkClone(shop, { node, keptOff: [], probe: probe({ ls: () => ({ ok: false, why: 'timeout' }) }) })).rejects.toThrow(hostSilentRefusal(node, 'example.test/acme/shop'));
  });

  it('refuses a base branch that is only on another computer, and takes one that is on origin', async () => {
    const p = probe({ ls: () => ({ ok: true, heads: ['main', 'feature/y'] }) });
    await expect(checkClone(shop, { node, keptOff: [], base: 'feature/x', probe: p })).rejects.toThrow('Push `feature/x` from Mac mini first.');
    await expect(checkClone(shop, { node, keptOff: [], base: 'feature/y', probe: p })).resolves.toMatchObject({ name: 'Shop' });
  });

  it('reads the branches of ls-remote', () => {
    expect(headsOf('abc\trefs/heads/main\ndef\trefs/heads/feature/x\n')).toEqual(['main', 'feature/x']);
  });
});
