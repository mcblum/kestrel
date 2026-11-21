import { describe, expect, it } from 'vitest';
import type { Project } from '../model.ts';
import type { HomeSession } from './pinned-homes.ts';
import { projectCardLines } from './project-card.ts';

const web = { id: 'w', path: '/Users/me/code/web', isGit: true };
const notes = { id: 'n', path: '/Users/me/notes', isGit: false };
const live = (id: string, projectId: string | null, status: 'started' | 'hidden' = 'started'): HomeSession => ({ id, filing: { projectId, status } });

describe('the hover card of a project row', () => {
  it('counts every live session in the project, and only those', () => {
    const sessions = [live('a', 'p'), live('b', 'p'), live('c', 'other'), live('d', 'p', 'hidden')];
    expect(projectCardLines({ id: 'p', folders: [web] }, sessions).sessions).toBe('2 sessions');
    expect(projectCardLines({ id: 'p', folders: [web] }, [live('a', 'p')]).sessions).toBe('1 session');
    expect(projectCardLines({ id: 'p', folders: [web] }, []).sessions).toBe('0 sessions');
  });
  it('lists one folder plainly, and marks the default of several in their order', () => {
    expect(projectCardLines({ id: 'p', folders: [web] }, []).folders).toEqual([{ id: 'w', path: web.path, note: '' }]);
    const two: Pick<Project, 'id' | 'folders' | 'defaultFolderId'> = { id: 'p', folders: [web, notes], defaultFolderId: 'n' };
    expect(projectCardLines(two, []).folders).toEqual([
      { id: 'w', path: web.path, note: '' },
      { id: 'n', path: notes.path, note: ' · default · plain folder' },
    ]);
    expect(projectCardLines(two, []).noFolder).toBeNull();
  });
  it('says there is no folder yet when there is none', () => {
    expect(projectCardLines({ id: 'p', folders: [] }, [])).toEqual({ sessions: '0 sessions', folders: [], noFolder: 'No folder yet' });
  });
});
