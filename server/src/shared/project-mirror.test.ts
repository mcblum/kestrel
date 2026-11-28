import { describe, expect, it } from 'vitest';
import type { Project, SessionView } from '../model.ts';
import { CLONE_OFFERS_MAX, CLONED_ON_START, cloningNote, keptOffRefusal, notClonedRows, plainFolderRefusal } from './project-clone.ts';
import { fetchDue, keptReason, leavingClone, MIRROR_FETCH_MIN_MS, mirrorOrder, sessionProjectOf } from './project-mirror.ts';

type Elsewhere = NonNullable<Project['elsewhere']>;
const away = (id: string, name: string, elsewhere: Partial<Elsewhere> = {}): Project => ({
  id,
  name,
  folders: [],
  defaultFolderId: null,
  away: true,
  elsewhere: { machines: [{ id: 'mini', name: 'Mac mini', projectId: `${id}-there` }], repos: [`example.test/acme/${id}`], folders: [{ name: id, isGit: true, repo: `example.test/acme/${id}` }], ...elsewhere },
});
const local = (id: string, name: string, alsoOn?: Project['alsoOn']): Project => ({ id, name, folders: [{ id: `${id}-f`, path: `/data/projects/${id}`, isGit: true }], defaultFolderId: `${id}-f`, ...(alsoOn ? { alsoOn } : {}) });
const session = (id: string, projectId: string, at: number, state: SessionView['state'] = 'done'): Pick<SessionView, 'id' | 'startedIn' | 'landedIn' | 'createdAt' | 'updatedAt' | 'lastActivityAt' | 'state'> => ({ id, startedIn: projectId, landedIn: null, createdAt: at, updatedAt: at, lastActivityAt: at, state });

describe('what a node tells its agents of the projects it has not cloned', () => {
  const projects = [local('mine', 'Mine'), away('shop', 'Shop'), away('notes', 'Notes', { repos: [], folders: [{ name: 'notes', isGit: false }] }), away('api', 'Api')];

  it('lists nothing on a desktop: its answer is unchanged', () => {
    expect(notClonedRows('app', projects, [], new Map(), new Set())).toEqual([]);
  });

  it('lists each account project the node lacks, by name, with why or when it is cloned', () => {
    const rows = notClonedRows('node', projects, [], new Map([['api', 'Worker node 1 has no git key of its own yet.']]), new Set());
    expect(rows).toEqual([
      { name: 'Api', cloned: false, repositories: ['example.test/acme/api'], note: 'Worker node 1 has no git key of its own yet.' },
      { name: 'Notes', cloned: false, repositories: [], note: plainFolderRefusal('Notes', 'Mac mini') },
      { name: 'Shop', cloned: false, repositories: ['example.test/acme/shop'], note: CLONED_ON_START },
    ]);
    expect(CLONED_ON_START).toBe('It is cloned when a session starts in it.');
  });

  it('says a project being cloned is being cloned', () => {
    expect(notClonedRows('node', [away('shop', 'Shop')], [], new Map(), new Set(['shop']))[0]!.note).toBe(cloningNote(['example.test/acme/shop']));
  });

  it('leaves out a project kept off Kestrel Connect, by any id it has', () => {
    expect(notClonedRows('node', [away('shop', 'Shop')], ['shop-there'], new Map(), new Set())).toEqual([]);
    expect(keptOffRefusal('Shop')).toContain('kept off');
  });

  it('is bounded however large the account is', () => {
    const many = Array.from({ length: CLONE_OFFERS_MAX + 5 }, (_, i) => away(`p${i}`, `P${i}`));
    expect(notClonedRows('node', many, [], new Map(), new Set())).toHaveLength(CLONE_OFFERS_MAX);
  });
});

describe('the order the mirror clones in', () => {
  it('takes only what can be cloned: never a plain folder, no origin, or kept off', () => {
    const projects = [local('mine', 'Mine'), away('shop', 'Shop'), away('notes', 'Notes', { repos: [], folders: [{ name: 'notes', isGit: false }] }), away('off', 'Off')];
    expect(mirrorOrder(projects, [], ['off-there']).map((p) => p.id)).toEqual(['shop']);
  });

  it('puts the project with the most recent session first, a working one ahead of all, then by name', () => {
    const projects = [away('b', 'Bravo'), away('a', 'Alpha'), away('c', 'Charlie'), away('d', 'Delta')];
    const sessions = [session('s1', 'c', 100), session('s2', 'd', 50, 'running'), session('s3', 'c', 10)];
    expect(mirrorOrder(projects, sessions, []).map((p) => p.name)).toEqual(['Delta', 'Charlie', 'Alpha', 'Bravo']);
  });

  it('reads a session as of the project it landed in, else where it started', () => {
    expect(sessionProjectOf({ startedIn: 'a', landedIn: 'b' })).toBe('b');
    expect(sessionProjectOf({ startedIn: 'a', landedIn: null })).toBe('a');
  });
});

describe('fetching a mirrored clone', () => {
  it('fetches at most once per project per interval', () => {
    expect(MIRROR_FETCH_MIN_MS).toBe(5 * 60_000);
    expect(fetchDue(undefined, 1000)).toBe(true);
    expect(fetchDue(1000, 1000 + MIRROR_FETCH_MIN_MS - 1)).toBe(false);
    expect(fetchDue(1000, 1000 + MIRROR_FETCH_MIN_MS)).toBe(true);
  });
});

describe('a clone the account no longer has', () => {
  it('leaves when no other computer has it, or it is kept off', () => {
    expect(leavingClone(local('shop', 'Shop', [{ id: 'mini', name: 'Mac mini', projectId: 'x' }]), [])).toBe(false);
    expect(leavingClone(local('shop', 'Shop'), [])).toBe(true);
    expect(leavingClone(local('shop', 'Shop', []), [])).toBe(true);
    expect(leavingClone(local('shop', 'Shop', [{ id: 'mini', name: 'Mac mini', projectId: 'x' }]), ['shop'])).toBe(true);
  });
});

describe('why a clone that left the account is kept', () => {
  const work = (title: string, uncommitted: number, unpushed: number) => ({ sessionId: title, title, uncommitted, unpushed });
  it('is deleted only with no session in it', () => {
    expect(keptReason([], [])).toBeNull();
  });
  it('names a running session first, then work not committed or pushed, then the sessions still listed', () => {
    expect(keptReason([{ title: 'Fix it', running: true }, { title: 'Other', running: false }], [work('Other', 1, 0)])).toBe('"Fix it" is running');
    expect(keptReason([{ title: 'Fix it', running: false }], [work('Fix it', 0, 2)])).toBe('"Fix it" has work that is not pushed');
    expect(keptReason([{ title: 'Fix it', running: false }], [work('Fix it', 3, 0)])).toBe('"Fix it" has work that is not committed');
    expect(keptReason([{ title: 'A', running: false }, { title: 'B', running: false }], [work('A', 0, 0)])).toBe('2 sessions are still listed in it');
    expect(keptReason([{ title: 'A', running: false }], [])).toBe('1 session is still listed in it');
  });
});
