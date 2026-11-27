// A project's record (account-projects.ts): what is sealed carries no absolute path, what is opened keeps
// only what a record may hold, and the words a window shows for a project not on this computer.
import { describe, expect, test } from 'vitest';
import { asProjectRecord, notHereMark, notHereRefusal, notHereText, projectRecordOf } from './account-projects.ts';

const MINI = { id: 'mini-1', name: 'Mac mini' };

describe('a project record', () => {
  test('names folders under the home folder as ~/…, and no other path', () => {
    const content = projectRecordOf({ id: 'p1', name: 'Shop', folders: [{ id: 'f1', path: '/Users/me/Code/shop', isGit: true }, { id: 'f2', path: '/srv/shared/assets', isGit: false }] }, ['example.test/acme/shop'], MINI, '/Users/me');
    expect(content).toEqual({ v: 1, kind: 'project', machine: MINI, project: { id: 'p1', name: 'Shop', repos: ['example.test/acme/shop'], folders: [{ name: 'shop', isGit: true, path: '~/Code/shop' }, { name: 'assets', isGit: false }] } });
    expect(JSON.stringify(content)).not.toContain('/Users/me');
    expect(JSON.stringify(content)).not.toContain('/srv');
  });

  test('says which repository each git folder is, or that it has no origin, so a node can clone it (item 64)', () => {
    const origins = new Map<string, string | null>([['/Users/me/Code/shop', 'example.test/acme/shop'], ['/Users/me/Code/bare', null]]);
    const content = projectRecordOf({ id: 'p1', name: 'Shop', folders: [{ id: 'f1', path: '/Users/me/Code/shop', isGit: true }, { id: 'f2', path: '/Users/me/Code/bare', isGit: true }, { id: 'f3', path: '/Users/me/notes', isGit: false }] }, ['example.test/acme/shop'], MINI, '/Users/me', origins);
    expect(content.project.folders).toEqual([{ name: 'shop', isGit: true, path: '~/Code/shop', repo: 'example.test/acme/shop' }, { name: 'bare', isGit: true, path: '~/Code/bare', repo: null }, { name: 'notes', isGit: false, path: '~/notes' }]);
    expect(asProjectRecord(JSON.parse(JSON.stringify(content)))!.folders).toEqual(content.project.folders);
    // A plain folder never carries one, whatever is sent.
    expect(asProjectRecord({ kind: 'project', machine: MINI, project: { id: 'p1', name: 'N', repos: [], folders: [{ name: 'n', isGit: false, repo: 'x/y' }] } })!.folders).toEqual([{ name: 'n', isGit: false }]);
  });

  test('is opened through one parser that keeps only what a record may hold', () => {
    expect(asProjectRecord({ kind: 'head' })).toBeNull();
    expect(asProjectRecord({ kind: 'project', machine: MINI, project: { name: 'No id' } })).toBeNull();
    expect(asProjectRecord({ kind: 'project', machine: MINI, project: { id: 'p1', name: 'Shop', repos: ['a', 'a', 3, ''], folders: [{ name: 'x', isGit: true, path: '/etc/passwd' }, { isGit: true }, { name: 'y', path: '~/y' }] } })).toEqual({
      id: 'p1',
      machine: MINI,
      name: 'Shop',
      repos: ['a'],
      folders: [{ name: 'x', isGit: true }, { name: 'y', isGit: false, path: '~/y' }],
    });
  });

  test('says what is missing: a repository can be cloned here, a plain folder is its computer’s', () => {
    const repo = { name: 'Shop', elsewhere: { machines: [MINI], repos: ['github.com/matt/shop'], folders: [] } };
    const plain = { name: 'Notes', elsewhere: { machines: [{ id: 'l', name: 'Blum Laptop' }], repos: [], folders: [] } };
    expect(notHereMark(repo, 'this Mac')).toBe('Not on this Mac');
    expect(notHereMark(plain, 'this Mac')).toBe('Only on Blum Laptop');
    expect(notHereText(repo, 'this Mac')).toBe('To run sessions here, clone `matt/shop` on this Mac, or choose its folder if it is already here.');
    expect(notHereText(plain, 'this Mac')).toBe('Sessions in it run there.');
    expect(notHereRefusal(plain, 'this Mac')).toBe('Notes is only on Blum Laptop. Sessions in it run there.');
    expect(notHereRefusal(repo, 'this Mac')).toBe('Shop is not on this Mac. To run sessions here, clone matt/shop on this Mac, or choose its folder if it is already here.');
    expect(notHereMark({}, 'this Mac')).toBe('');
  });
});
