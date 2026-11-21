import { describe, expect, it } from 'vitest';
import { filterProjects, tildePath } from './project-search.ts';

const one = (id: string, name: string, path: string) => ({ id, name, folders: [{ id, path, isGit: true }] });
const projects = [one('1', 'Wren', '/Users/m/Code/Wren'), one('2', 'Bellbird-metronome', '/Users/m/Code/Bellbird-metronome'), one('3', 'Shrike', '/Users/m/Code/Shrike'), { id: '4', name: 'Empty', folders: [] }];

describe('project search', () => {
  it('returns everything for an empty query', () => expect(filterProjects(projects, '  ')).toHaveLength(4));
  it('matches name or path, any case, every word', () => {
    expect(filterProjects(projects, 'WREN').map((p) => p.id)).toEqual(['1']);
    expect(filterProjects(projects, 'code bell').map((p) => p.id)).toEqual(['2']);
    expect(filterProjects(projects, 'nothing')).toEqual([]);
    expect(filterProjects(projects, 'empty').map((p) => p.id)).toEqual(['4']);
  });
  it('shows home as a tilde', () => {
    expect(tildePath('/Users/m/Code/Wren')).toBe('~/Code/Wren');
    expect(tildePath('/home/m')).toBe('~');
    expect(tildePath('/opt/x')).toBe('/opt/x');
  });
});
