import { describe, expect, it } from 'vitest';
import { tabMenuRow } from './tab-menu.ts';
import type { Tab } from './tabs.ts';

const page = (path: string): Tab => ({ id: 't', kind: 'page', path });

describe('the menu a tab opens on a right-click', () => {
  it("is the session's row menu for a session tab", () => {
    expect(tabMenuRow({ id: 't', kind: 'session', sessionId: 's1' }, null)).toEqual({ kind: 'session', id: 's1' });
  });

  it('is the row menu of what a page holds', () => {
    expect(tabMenuRow(page('#/'), { kind: 'overview' })).toEqual({ kind: 'overview', id: '' });
    expect(tabMenuRow(page('#/project/p'), { kind: 'project', id: 'p', tab: 'settings' })).toEqual({ kind: 'project', id: 'p' });
    expect(tabMenuRow(page('#/group/g'), { kind: 'group', id: 'g' })).toEqual({ kind: 'folder', id: 'g' });
    expect(tabMenuRow(page('#/tag/Argus'), { kind: 'tag', id: 'Argus' })).toEqual({ kind: 'tag', id: 'Argus' });
    expect(tabMenuRow(page('#/workstream/w'), { kind: 'workstream', id: 'w' })).toEqual({ kind: 'workstream', id: 'w' });
    expect(tabMenuRow(page('#/review/k'), { kind: 'review-request', id: 'k' })).toEqual({ kind: 'review', id: 'k' });
  });

  it('is none for a page with no row, or a new session', () => {
    expect(tabMenuRow(page('#/settings'), { kind: 'settings' })).toBeNull();
    expect(tabMenuRow(page('#/nowhere'), null)).toBeNull();
    expect(tabMenuRow({ id: 't', kind: 'new', controls: {} as never }, null)).toBeNull();
  });
});
