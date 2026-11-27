import { describe, expect, it } from 'vitest';
import type { Project } from '../model.ts';
import {
  baseOnlyThereRefusal,
  baseRefusal,
  cloneFailedText,
  clonePlanOf,
  CLONE_OFFERS_MAX,
  cloneRefusal,
  cloneTargetOf,
  cloneUrlOf,
  cloningNote,
  hostSilentRefusal,
  keptOffRefusal,
  keyCannotReadRefusal,
  lowDiskRefusal,
  noKeyRefusal,
  noOriginRefusal,
  offeredClones,
  plainFolderRefusal,
  projectFolderWord,
  unmappedRefusal,
} from './project-clone.ts';

type Elsewhere = NonNullable<Project['elsewhere']>;
const away = (id: string, name: string, elsewhere: Partial<Elsewhere> = {}): Project => ({
  id,
  name,
  folders: [],
  defaultFolderId: null,
  away: true,
  elsewhere: { machines: [{ id: 'mini', name: 'Mac mini', projectId: `${id}-there` }], repos: ['example.test/acme/shop'], folders: [{ name: 'shop', isGit: true, repo: 'example.test/acme/shop' }], ...elsewhere },
});

describe('the words', () => {
  it('says each refusal once, naming the node, the other computer and the repository', () => {
    expect(plainFolderRefusal('Notes', 'Mac mini')).toBe('Notes is a folder on Mac mini, not a repository: there is nothing to clone.');
    expect(noOriginRefusal('Shop', 'Mac mini')).toBe('Shop has no `origin` on Mac mini, so there is nothing to clone it from. Add one there and push it first.');
    expect(unmappedRefusal('Shop', 'Mac mini')).toBe('Mac mini does not say which repository each folder of Shop is. Update Kestrel there, then start the session again.');
    expect(baseOnlyThereRefusal('feature/x', 'Mac mini')).toBe('Push `feature/x` from Mac mini first.');
    expect(keyCannotReadRefusal('Worker node 1', 'github.com/acme/shop')).toBe("Worker node 1's key cannot read `acme/shop`. Run `kestrel-node git` on Worker node 1 to add it at github.com.");
    expect(hostSilentRefusal('Worker node 1', 'github.com/acme/shop')).toBe('github.com did not answer Worker node 1 in 20 seconds about `acme/shop`. Try again in a moment.');
    expect(noKeyRefusal('Worker node 1')).toBe('Worker node 1 has no git key of its own yet. Run `kestrel-node git` on Worker node 1, then start the session again.');
    expect(lowDiskRefusal('Worker node 1', 512 * 1024 ** 2)).toBe('Worker node 1 has 512 MB free, and a new clone wants at least 2.0 GB. Free some space there first.');
    expect(keptOffRefusal('Shop')).toBe('Shop is kept off Kestrel Connect, so it is not cloned on other computers.');
    expect(cloneFailedText('github.com/acme/shop', 'fatal: repository not found\n')).toBe('Could not clone `acme/shop`: fatal: repository not found. Nothing of it was kept.');
    expect(cloneFailedText('github.com/acme/shop', ' ')).toBe('Could not clone `acme/shop`: git did not say why. Nothing of it was kept.');
  });

  it('names what is being cloned on the row', () => {
    expect(cloningNote(['github.com/acme/shop'])).toBe('Cloning acme/shop…');
    expect(cloningNote(['github.com/acme/shop', 'github.com/acme/api', 'gitlab.com/acme/docs'])).toBe('Cloning acme/shop, acme/api and acme/docs…');
  });

  it('clones over ssh with the node key, from the host and path of the repository key', () => {
    expect(cloneUrlOf('github.com/acme/shop')).toBe('git@github.com:acme/shop.git');
    expect(cloneUrlOf('gitlab.example.test/group/sub/repo')).toBe('git@gitlab.example.test:group/sub/repo.git');
  });

  it('makes a folder word of a project name', () => {
    expect(projectFolderWord('My Shop!')).toBe('my-shop');
    expect(projectFolderWord('***')).toBe('project');
  });
});

describe('the clone plan', () => {
  it('clones every repository of a project of several, each into the folder its computer names', () => {
    const project = away('p', 'Shop', {
      repos: ['example.test/acme/shop', 'example.test/acme/api'],
      folders: [
        { name: 'shop', isGit: true, repo: 'example.test/acme/shop' },
        { name: 'api', isGit: true, repo: 'example.test/acme/api' },
        { name: 'notes', isGit: false },
      ],
    });
    expect(clonePlanOf(project)).toEqual({
      ok: true,
      plan: {
        name: 'Shop',
        repos: [
          { key: 'example.test/acme/shop', folder: 'shop', url: 'git@example.test:acme/shop.git' },
          { key: 'example.test/acme/api', folder: 'api', url: 'git@example.test:acme/api.git' },
        ],
      },
    });
  });

  it('two folders of one name get two folders here', () => {
    const plan = clonePlanOf(away('p', 'Shop', { repos: ['example.test/a/web', 'example.test/b/web'], folders: [{ name: 'web', isGit: true, repo: 'example.test/a/web' }, { name: 'web', isGit: true, repo: 'example.test/b/web' }] }));
    expect(plan.ok && plan.plan.repos.map((r) => r.folder)).toEqual(['web', 'web-2']);
  });

  it('understands an older record by its one git folder, and a project known only from its sessions by its first repository', () => {
    const old = clonePlanOf(away('p', 'Shop', { folders: [{ name: 'shop', isGit: true }] }));
    expect(old.ok && old.plan.repos).toEqual([{ key: 'example.test/acme/shop', folder: 'shop', url: 'git@example.test:acme/shop.git' }]);
    const headsOnly = clonePlanOf(away('p', 'Shop', { folders: [] }));
    expect(headsOnly.ok && headsOnly.plan.repos.map((r) => r.folder)).toEqual(['shop']);
  });

  it('refuses a plain folder, a repository with no origin, and an older record of several repositories', () => {
    expect(clonePlanOf(away('p', 'Notes', { repos: [], folders: [{ name: 'notes', isGit: false }] }))).toEqual({ ok: false, reason: plainFolderRefusal('Notes', 'Mac mini') });
    expect(clonePlanOf(away('p', 'Shop', { repos: [], folders: [{ name: 'shop', isGit: true, repo: null }] }))).toEqual({ ok: false, reason: noOriginRefusal('Shop', 'Mac mini') });
    expect(clonePlanOf(away('p', 'Shop', { repos: ['example.test/x/y'], folders: [{ name: 'shop', isGit: true, repo: null }] }))).toEqual({ ok: false, reason: noOriginRefusal('Shop', 'Mac mini') });
    expect(clonePlanOf(away('p', 'Shop', { repos: ['example.test/a/b', 'example.test/c/d'], folders: [{ name: 'a', isGit: true }, { name: 'c', isGit: true }] }))).toEqual({ ok: false, reason: unmappedRefusal('Shop', 'Mac mini') });
  });
});

describe('what a node offers to clone', () => {
  const mine: Project = { id: 'local', name: 'Local', folders: [{ id: 'f', path: '/x/local', isGit: true }], defaultFolderId: 'f' };

  it('offers each account project it does not have by its id there, marked with its ids everywhere', () => {
    const shop = away('shop', 'Shop', { machines: [{ id: 'mini', name: 'Mac mini', projectId: 'p-mini' }, { id: 'laptop', name: 'Laptop', projectId: 'p-laptop' }] });
    expect(offeredClones([mine, shop], [])).toEqual([{ id: 'p-mini', name: 'Shop', folders: [], defaultFolderId: null, clone: { of: ['p-mini', 'p-laptop'] } }]);
  });

  it('never a project it has, a plain folder, a repository with no origin, or one kept off Kestrel Connect', () => {
    const plain = away('notes', 'Notes', { repos: [], folders: [{ name: 'notes', isGit: false }] });
    const noOrigin = away('bare', 'Bare', { repos: [], folders: [{ name: 'bare', isGit: true, repo: null }] });
    const keptOff = away('secret', 'Secret');
    expect(offeredClones([mine, plain, noOrigin, keptOff], ['secret-there'])).toEqual([]);
  });

  it('offers at most a bounded number', () => {
    const many = Array.from({ length: CLONE_OFFERS_MAX + 10 }, (_, i) => away(`p${i}`, `P${i}`, { repos: [`example.test/a/p${i}`], folders: [{ name: `p${i}`, isGit: true, repo: `example.test/a/p${i}` }] }));
    expect(offeredClones(many, [])).toHaveLength(CLONE_OFFERS_MAX);
  });

  it('finds the project a start names by one of its ids elsewhere, and refuses one kept off before anything', () => {
    const shop = away('shop', 'Shop');
    expect(cloneTargetOf([mine, shop], 'shop-there')).toBe(shop);
    expect(cloneTargetOf([mine, shop], 'local')).toBeUndefined();
    expect(cloneRefusal(shop, [])).toBeNull();
    expect(cloneRefusal(shop, ['shop-there'])).toBe(keptOffRefusal('Shop'));
  });

  it('refuses a base branch that is not on origin, naming the computer to push it from', () => {
    expect(baseRefusal('feature/x', ['main'], away('p', 'Shop'))).toBe('Push `feature/x` from Mac mini first.');
    expect(baseRefusal('main', ['main'], away('p', 'Shop'))).toBeNull();
    expect(baseRefusal(undefined, [], away('p', 'Shop'))).toBeNull();
  });
});
