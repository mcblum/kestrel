import { describe, expect, it } from 'vitest';
import { search } from './search.ts';

const data = {
  sessions: [
    { id: 's1', title: 'Fix login redirect', detail: 'Wren · Claude', updatedAt: 5 },
    { id: 's2', title: 'Release notes', detail: 'Shrike · Claude', updatedAt: 9 },
    { id: 's3', title: 'Wren version check', detail: 'Wren · Codex', updatedAt: 1, tags: ['PLAT-1234', 'release train'] },
  ],
  projects: [{ id: 'p1', name: 'Wren', folders: [{ id: 'f1', path: '/Users/me/Code/Wren' }] }, { id: 'p2', name: 'Scratchpad', folders: [] }],
  groups: [{ id: 'g1', name: 'Login work' }],
};
const ids = (q: string) => search(data, q).map((h) => h.id);

describe('search', () => {
  it('with nothing typed lists sessions newest first, then projects and groups', () => {
    expect(ids('')).toEqual(['s2', 's1', 's3', 'p1', 'p2', 'g1', 'PLAT-1234', 'release train']);
  });
  it('finds sessions, projects and groups by any word, ignoring case', () => {
    expect(ids('LOGIN')).toEqual(['s1', 'g1']);
  });
  it('needs every word, in any order, across title and detail', () => {
    expect(ids('codex wren')).toEqual(['s3']);
    expect(ids('wren shrike')).toEqual([]);
  });
  it('ranks a match in the title above a match only in the detail', () => {
    expect(ids('wren')).toEqual(['s3', 'p1', 's1']);
  });
  it('finds a tag, and the sessions carrying it, in any case', () => {
    expect(ids('plat-1234')).toEqual(['PLAT-1234', 's3']);
    expect(ids('Release Train')).toEqual(['release train', 's3']);
    expect(ids('PLAT-9')).toEqual([]);
  });
  it('lists each tag once, saying how many sessions carry it', () => {
    const two = { ...data, sessions: [...data.sessions, { id: 's4', title: 'Other', detail: 'Wren · Claude', updatedAt: 2, tags: ['PLAT-1234'] }] };
    expect(search(two, 'plat').filter((h) => h.kind === 'tag')).toEqual([{ kind: 'tag', id: 'PLAT-1234', title: 'PLAT-1234', detail: 'Tag · 2 sessions' }]);
    expect(search(data, 'train').find((h) => h.kind === 'tag')).toMatchObject({ detail: 'Tag · 1 session' });
  });
  it('shows a project with no directory as having none yet', () => {
    expect(search(data, 'scratchpad')).toEqual([{ kind: 'project', id: 'p2', title: 'Scratchpad', detail: 'No folder yet' }]);
  });
  it('says what kind each result is', () => {
    expect(search(data, 'login').map((h) => h.kind)).toEqual(['session', 'group']);
  });
});

describe('workstreams in search', () => {
  it('finds a workstream by its name or its objective', () => {
    const data = { sessions: [], projects: [], groups: [], workstreams: [{ id: 'w1', name: 'Invoice export', objective: 'Let customers download invoices as PDF.', sessionIds: ['a', 'b'] }] };
    expect(search(data, 'invoice')).toEqual([{ kind: 'workstream', id: 'w1', title: 'Invoice export', detail: 'Workstream · 2 sessions' }]);
    expect(search(data, 'pdf').map((h) => h.id)).toEqual(['w1']);
    expect(search(data, 'nothing')).toEqual([]);
  });
});

describe('archived workstreams in search', () => {
  const data = {
    sessions: [{ id: 's1', title: 'Invoice totals', detail: 'Wren · Claude', updatedAt: 1 }],
    projects: [],
    groups: [{ id: 'g1', name: 'Export work' }],
    workstreams: [{ id: 'w1', name: 'Receipts', objective: 'Invoice receipts by mail.', sessionIds: ['a'] }],
    archivedWorkstreams: [{ id: 'w2', name: 'Invoice export', objective: 'Let customers download invoices as PDF.', sessionIds: ['a', 'b'] }],
  };

  it('finds an archived workstream by its name or objective, marked as archived', () => {
    expect(search(data, 'pdf')).toEqual([{ kind: 'workstream', id: 'w2', title: 'Invoice export', detail: 'Archived workstream · 2 sessions', archived: true }]);
  });
  it('ranks it below every active result, even one that matches only in its detail', () => {
    expect(search(data, 'invoice').map((h) => h.id)).toEqual(['s1', 'w1', 'w2']);
    expect(search(data, 'export').map((h) => h.id)).toEqual(['g1', 'w2']);
  });
  it('leaves it out while nothing is typed, as the sidebar does', () => {
    expect(search(data, '').map((h) => h.id)).not.toContain('w2');
  });
});

describe('archived sessions in search', () => {
  const data = {
    sessions: [{ id: 's1', title: 'Invoice totals', detail: 'Wren · Claude', updatedAt: 5 }],
    projects: [{ id: 'p1', name: 'Invoices', folders: [{ id: 'f', path: '/w/invoices' }] }],
    groups: [],
    archivedWorkstreams: [{ id: 'w2', name: 'Invoice export', objective: '', sessionIds: ['a'] }],
    archivedSessions: [
      { id: 'old', title: 'Invoice PDF layout', project: 'Wren', updatedAt: 1 },
      { id: 'newer', title: 'Fix rounding', project: 'Invoices', updatedAt: 3 },
      { id: 'other', title: 'Unrelated', project: 'Wren', updatedAt: 9 },
    ],
  };

  it('finds one by its title or its project, marked Archived with the project', () => {
    expect(search(data, 'layout')).toEqual([{ kind: 'session', id: 'old', title: 'Invoice PDF layout', detail: 'Archived · Wren', archived: true }]);
    expect(search(data, 'wren').map((h) => h.id)).toEqual(['s1', 'other', 'old']);
  });
  it('ranks them after everything else, archived workstreams included, most recently active first whatever matched', () => {
    expect(search(data, 'invoice').map((h) => h.id)).toEqual(['s1', 'p1', 'w2', 'newer', 'old']);
  });
  it('leaves them out while nothing is typed', () => {
    expect(search(data, '').some((h) => 'archived' in h)).toBe(false);
  });
});
