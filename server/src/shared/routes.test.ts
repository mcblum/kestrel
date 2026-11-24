import { describe, expect, it } from 'vitest';
import { containerOf, parseViewPath, projectTabOf, selectsRow, viewPath, type View } from './routes.ts';

const every: View[] = [
  { kind: 'overview' },
  { kind: 'attention' },
  { kind: 'all' },
  { kind: 'all', filter: 'done' },
  { kind: 'unscoped' },
  { kind: 'settings' },
  { kind: 'settings', section: 'agent-setup' },
  { kind: 'move', sessionId: 's/1', projectId: 'p 2' },
  { kind: 'move', sessionId: 's/1', projectId: 'p 2', groupId: 'g 3' },
  { kind: 'group', id: 'g' },
  { kind: 'project', id: 'p/x' },
  { kind: 'project', id: 'p/x', tab: 'settings' },
  { kind: 'project', id: 'p/x', tab: 'settings', section: 'folders' },
  { kind: 'tag', id: 'needs review' },
  { kind: 'new-project' },
  { kind: 'new-project', from: 'folder' },
  { kind: 'pull-requests' },
  { kind: 'pull-requests', filter: 'draft' },
  { kind: 'code', sessionId: 's/1', messageId: 'm 2', at: 0 },
  { kind: 'code', sessionId: 's/1', messageId: 'm 2', at: 4821 },
];

describe('page routes', () => {
  it('turns every view into a path and back', () => {
    for (const view of every) expect(parseViewPath(viewPath(view))).toEqual(view);
  });

  it("gives a project's Settings tab its own path, Sessions none", () => {
    expect(viewPath({ kind: 'project', id: 'p1', tab: 'settings' })).toBe('#/project/p1/settings');
    expect(viewPath({ kind: 'project', id: 'p1', tab: 'settings', section: 'agent-setup' })).toBe('#/project/p1/settings/agent-setup');
    expect(parseViewPath('#/project/p1')).toEqual({ kind: 'project', id: 'p1' });
    expect(parseViewPath('#/project/p1/other')).toEqual({ kind: 'project', id: 'p1' });
    expect(parseViewPath('#/project/p1/settings/nowhere')).toEqual({ kind: 'project', id: 'p1', tab: 'settings' });
  });

  it('Create project and adding several from a folder are one page with two ways in', () => {
    expect(viewPath({ kind: 'new-project', from: 'folder' })).toBe('#/new-project/folder');
    expect(parseViewPath('#/new-project/other')).toEqual({ kind: 'new-project' });
    expect(containerOf({ kind: 'new-project', from: 'folder' })).toEqual({ kind: 'new-project' });
  });

  it('sends the old folders page to Settings → Folders', () => {
    expect(parseViewPath('#/project/p1/folders')).toEqual({ kind: 'project', id: 'p1', tab: 'settings', section: 'folders' });
  });

  it("sends a project's old section of the global Settings to its Settings tab", () => {
    expect(parseViewPath(`#/settings/${encodeURIComponent('project:p 1')}`)).toEqual({ kind: 'project', id: 'p 1', tab: 'settings', section: 'agent-setup' });
    expect(parseViewPath('#/settings/project:')).toEqual({ kind: 'settings', section: 'project:' });
  });

  it('reads anything unknown as the Overview', () => {
    expect(parseViewPath('#/nowhere')).toEqual({ kind: 'overview' });
    expect(parseViewPath('#/project/')).toEqual({ kind: 'overview' });
  });
});

describe('the Pull requests page', () => {
  it('keeps its filter in the path, with none for the default', () => {
    expect(viewPath({ kind: 'pull-requests' })).toBe('#/pull-requests');
    expect(viewPath({ kind: 'pull-requests', filter: 'attention' })).toBe('#/pull-requests/attention');
    expect(parseViewPath('#/pull-requests/nowhere')).toEqual({ kind: 'pull-requests' });
    expect(parseViewPath('#/pull-requests/open')).toEqual({ kind: 'pull-requests' });
  });

  it('is one destination under every filter', () => {
    expect(containerOf({ kind: 'pull-requests', filter: 'ready' })).toEqual({ kind: 'pull-requests' });
    expect(selectsRow({ kind: 'pull-requests', filter: 'finished' }, { kind: 'pull-requests' })).toBe(true);
  });
});

describe('the destination a view belongs to', () => {
  it('is the same project on its Sessions and Settings tabs, so the workspace tab keeps its name', () => {
    expect(containerOf({ kind: 'project', id: 'a', tab: 'settings', section: 'folders' })).toEqual(containerOf({ kind: 'project', id: 'a' }));
    expect(containerOf({ kind: 'group', id: 'g' })).toEqual({ kind: 'group', id: 'g' });
  });

  it('knows which local tab a project view shows', () => {
    expect(projectTabOf({ kind: 'project', id: 'a' })).toBe('sessions');
    expect(projectTabOf({ kind: 'project', id: 'a', tab: 'settings' })).toBe('settings');
    expect(projectTabOf({ kind: 'group', id: 'a' })).toBe('sessions');
  });
});

describe('the sidebar row an open page selects', () => {
  it('selects the row of the same project, group or tag only', () => {
    expect(selectsRow({ kind: 'project', id: 'a' }, { kind: 'project', id: 'a' })).toBe(true);
    expect(selectsRow({ kind: 'project', id: 'a' }, { kind: 'project', id: 'b' })).toBe(false);
    expect(selectsRow({ kind: 'group', id: 'a' }, { kind: 'project', id: 'a' })).toBe(false);
    expect(selectsRow({ kind: 'tag', id: 'x' }, { kind: 'tag', id: 'x' })).toBe(true);
    expect(selectsRow({ kind: 'overview' }, { kind: 'overview' })).toBe(true);
    expect(selectsRow(null, { kind: 'overview' })).toBe(false);
  });

  it('keeps a project selected on its Settings tab', () => {
    expect(selectsRow({ kind: 'project', id: 'a', tab: 'settings' }, { kind: 'project', id: 'a' })).toBe(true);
    expect(selectsRow({ kind: 'project', id: 'a', tab: 'settings' }, { kind: 'project', id: 'b' })).toBe(false);
  });
});

describe('the workstream page', () => {
  it('has a path of its own that reads back, and selects its sidebar row', () => {
    expect(viewPath({ kind: 'workstream', id: 'w 1' })).toBe('#/workstream/w%201');
    expect(parseViewPath('#/workstream/w%201')).toEqual({ kind: 'workstream', id: 'w 1' });
    expect(selectsRow({ kind: 'workstream', id: 'w' }, { kind: 'workstream', id: 'w' })).toBe(true);
    expect(selectsRow({ kind: 'workstream', id: 'w' }, { kind: 'workstream', id: 'x' })).toBe(false);
  });
});

describe('the recovery page', () => {
  it('sits under Connections and round-trips; the old pairing page is gone', () => {
    expect(parseViewPath('#/settings/connections/pair')).not.toEqual({ kind: 'settings', section: 'connections/pair' });
    expect(parseViewPath('#/settings/connections/recovery')).toEqual({ kind: 'settings', section: 'connections/recovery' });
    expect(viewPath({ kind: 'settings', section: 'connections/recovery' })).toBe('#/settings/connections/recovery');
  });
});
