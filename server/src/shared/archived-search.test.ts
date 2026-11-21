import { describe, expect, it } from 'vitest';
import { matchingArchived } from './archived-search.ts';

const rows = [
  { kind: 'session', name: 'Fix sidebar archive button', detail: 'Kestrel' },
  { kind: 'session', name: 'Review Vireo README', detail: 'Vireo' },
  { kind: 'project', name: 'Field notes', detail: '~/Code/field-notes' },
  { kind: 'group', name: 'November launch', detail: '' },
];
const names = (query: string) => matchingArchived(rows, query).map((r) => r.name);

describe('searching the archived list', () => {
  it('shows everything, in order, when nothing is typed', () => {
    expect(names('')).toEqual(rows.map((r) => r.name));
    expect(names('   ')).toHaveLength(4);
  });

  it('matches a name, a project, a folder or a kind, whatever the case', () => {
    expect(names('readme')).toEqual(['Review Vireo README']);
    expect(names('KESTREL')).toEqual(['Fix sidebar archive button']);
    expect(names('field-notes')).toEqual(['Field notes']);
    expect(names('group')).toEqual(['November launch']);
  });

  it('needs every word typed, in any order', () => {
    expect(names('vireo review')).toEqual(['Review Vireo README']);
    expect(names('vireo sidebar')).toEqual([]);
  });
});
