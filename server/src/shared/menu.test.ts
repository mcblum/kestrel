import { describe, expect, it } from 'vitest';
import { commandMenu, copyResponseMenu, item, sidebarMenu } from './menu.ts';

const labels = (items: { label: string }[]) => items.map((i) => i.label);

describe('sidebar menu', () => {
  it('on empty space offers new session, new folder, add project', () => {
    expect(labels(sidebarMenu({ kind: 'empty' }))).toEqual(['New session', 'New group', 'Create project…']);
  });
  it('every sidebar item offers "Open in new tab"', () => {
    const groups = [{ id: 'g1', name: 'One' }];
    const cases = [
      [sidebarMenu({ kind: 'overview' }), { kind: 'overview' }],
      [sidebarMenu({ kind: 'session', sessionId: 's', running: false, groupId: null, groups }), { kind: 'session', id: 's' }],
      [sidebarMenu({ kind: 'folder', groupId: 'g', name: 'Launch', sessionCount: 0 }), { kind: 'group', id: 'g' }],
      [sidebarMenu({ kind: 'project', projectId: 'p', name: 'Wren', sessionCount: 0 }), { kind: 'project', id: 'p' }],
      [sidebarMenu({ kind: 'tag', tag: 'PLAT-1' }), { kind: 'tag', id: 'PLAT-1' }],
    ] as const;
    for (const [menu, open] of cases) expect(menu.find((m) => m.id === 'open-new-tab')!.action).toEqual({ type: 'open-new-tab', item: open });
    expect(labels(sidebarMenu({ kind: 'overview' }))).toEqual(['Open in new tab']);
    expect(labels(sidebarMenu({ kind: 'empty' }))).not.toContain('Open in new tab');
  });
  it('on a tag: its page, then a new tab, as on a project', () => {
    const menu = sidebarMenu({ kind: 'tag', tag: 'PLAT-1' });
    expect(labels(menu)).toEqual(['Open tag page', 'Open in new tab']);
    expect(menu[0]!.action).toEqual({ type: 'open-tag', tag: 'PLAT-1' });
  });
  it('offers Show in Finder only where something can show a folder; Copy path everywhere', () => {
    const browser = labels(sidebarMenu({ kind: 'project', projectId: 'p', name: 'Wren', sessionCount: 0, path: '/code/p', canReveal: false }));
    expect(browser).not.toContain('Show in Finder');
    expect(browser).toContain('Copy path');
    const session = labels(sidebarMenu({ kind: 'session', sessionId: 's', running: false, groupId: null, groups: [], path: '/w/s', canReveal: false }));
    expect(session).not.toContain('Show in Finder');
    expect(session).toContain('Copy path');
  });
  it('on a project: new session and group in it, its page, a new tab, rename, on disk, settings, archive, remove', () => {
    const empty = sidebarMenu({ kind: 'project', projectId: 'p', name: 'Wren', sessionCount: 0, path: '/code/p' });
    expect(labels(empty)).toEqual(['New session in Wren', 'New group in Wren', 'Open project page', 'Open in new tab', 'Rename Wren', 'Show in Finder', 'Copy path', 'Settings…', 'Archive', 'Remove']);
    expect(empty.filter((m) => m.separatorBefore).map((m) => m.label)).toEqual(['Open project page', 'Rename Wren', 'Settings…', 'Archive']);
    expect(empty[0]!.action).toEqual({ type: 'new-session', projectId: 'p' });
    expect(empty[1]!.action).toEqual({ type: 'new-folder', projectId: 'p' });
    expect(empty[3]!.action).toEqual({ type: 'open-new-tab', item: { kind: 'project', id: 'p' } });
    expect(empty[4]!.action).toEqual({ type: 'rename', kind: 'project', id: 'p' });
    expect(empty[6]!.action).toEqual({ type: 'copy', text: '/code/p', what: 'path' });
    expect(empty[7]!.action).toEqual({ type: 'project-settings', projectId: 'p' });
    expect(empty.at(-1)!.disabled).toBe(false);
    const busy = sidebarMenu({ kind: 'project', projectId: 'p', name: 'Wren', sessionCount: 2, running: true });
    expect(labels(busy)).toEqual(['New session in Wren', 'New group in Wren', 'Open project page', 'Open in new tab', 'Rename Wren', 'Settings…', 'Archive', 'Remove']);
    expect(busy.find((m) => m.id === 'archive')).toMatchObject({ disabled: true });
    expect(busy.at(-1)).toMatchObject({ disabled: true });
    // Archive, remove and delete carry no helper text; removing asks for confirmation instead.
    for (const m of [...empty, ...busy]) if (['archive', 'remove-project'].includes(m.id)) expect(m.hint).toBeUndefined();
    // On its own page the way there is left out, and Open in new tab starts that part.
    const onPage = sidebarMenu({ kind: 'project', projectId: 'p', name: 'Wren', sessionCount: 0, onPage: true });
    expect(onPage.find((m) => m.id === 'open-new-tab')).toMatchObject({ separatorBefore: true });
  });
  it("leaves out the way to the page it is opened from (a page header's …)", () => {
    expect(labels(sidebarMenu({ kind: 'project', projectId: 'p', name: 'Wren', sessionCount: 0, onPage: true }))).not.toContain('Open project page');
    expect(labels(sidebarMenu({ kind: 'folder', groupId: 'g', name: 'Launch', sessionCount: 0, onPage: true }))).not.toContain('Open group page');
    expect(labels(sidebarMenu({ kind: 'project', projectId: 'p', name: 'Wren', sessionCount: 0 }))).toContain('Open project page');
  });
  it('on a group: a new session in it, its page and a new tab, rename, archive, delete', () => {
    const menu = sidebarMenu({ kind: 'folder', groupId: 'g', name: 'Launch', sessionCount: 3 });
    expect(labels(menu)).toEqual(['New session in Launch', 'Open group page', 'Open in new tab', 'Rename Launch', 'Archive', 'Delete']);
    expect(menu.filter((m) => m.separatorBefore).map((m) => m.label)).toEqual(['Open group page', 'Rename Launch', 'Archive']);
    expect(menu[0]!.action).toEqual({ type: 'new-session', groupId: 'g' });
    expect(menu.find((m) => m.id === 'archive')!.action).toEqual({ type: 'archive', kind: 'group', id: 'g' });
    expect(menu.at(-1)!.hint).toBeUndefined();
  });
  it('on a session: a new tab and read state, rename, tag and moves, on disk, archive, delete', () => {
    const groups = [{ id: 'g1', name: 'One' }, { id: 'g2', name: 'Two' }];
    const idle = sidebarMenu({ kind: 'session', sessionId: 's', running: false, groupId: 'g1', groups, branch: 'kestrel/x', path: '/wt/x', unread: false });
    expect(labels(idle)).toEqual(['Open in new tab', 'Mark as unread', 'Rename', 'Tag…', 'Move to group', 'Show in Finder', 'Copy path', 'Copy branch name', 'Archive', 'Delete…']);
    expect(idle.filter((m) => m.separatorBefore).map((m) => m.label)).toEqual(['Rename', 'Show in Finder', 'Archive']);
    const move = idle.find((m) => m.id === 'move')!;
    expect(labels(move.children!)).toEqual(['No group', 'Two']);
    expect(move.children![1]!.action).toEqual({ type: 'move-session', sessionId: 's', groupId: 'g2' });
    expect(idle.find((m) => m.id === 'mark-unread')!.action).toEqual({ type: 'mark-unread', sessionId: 's', unread: true });
    expect(idle.find((m) => m.id === 'copy-branch')!.action).toEqual({ type: 'copy', text: 'kestrel/x', what: 'branch name' });
    expect(sidebarMenu({ kind: 'session', sessionId: 's', running: false, groupId: null, groups, unread: true }).find((m) => m.id === 'mark-unread')!.label).toBe('Mark as read');
  });
  it('a working session can be stopped, but not archived or deleted', () => {
    const running = sidebarMenu({ kind: 'session', sessionId: 's', running: true, groupId: null, groups: [{ id: 'g1', name: 'One' }] });
    expect(labels(running)).toEqual(['Open in new tab', 'Rename', 'Tag…', 'Move to group', 'Stop', 'Archive', 'Delete…']);
    expect(running.filter((m) => m.separatorBefore).map((m) => m.label)).toEqual(['Rename', 'Stop', 'Archive']);
    expect(running.find((m) => m.id === 'archive')).toMatchObject({ disabled: true });
    expect(running.find((m) => m.id === 'delete')).toMatchObject({ disabled: true });
  });
  it('disables "Move to group" when there is nowhere to move', () => {
    const menu = sidebarMenu({ kind: 'session', sessionId: 's', running: false, groupId: null, groups: [] });
    expect(menu.find((m) => m.id === 'move')).toMatchObject({ disabled: true });
  });
  it('shares its items with the + buttons', () => {
    expect(sidebarMenu({ kind: 'empty' })[1]).toEqual(item.newFolder());
    expect(sidebarMenu({ kind: 'empty' })[2]).toEqual(item.addProject());
  });
});

describe('delegation entries', () => {
  it('a folder can stop everything in it and has no per-folder delegation setting', () => {
    const menu = sidebarMenu({ kind: 'folder', groupId: 'g', name: 'Launch', sessionCount: 2, running: true });
    expect(menu.map((m) => m.label)).toEqual(['New session in Launch', 'Open group page', 'Open in new tab', 'Rename Launch', 'Stop all sessions', 'Archive', 'Delete']);
    expect(menu.find((x) => x.id === 'stop-folder')!.action).toEqual({ type: 'stop-folder', groupId: 'g' });
    expect(menu.find((x) => x.id === 'archive')).toMatchObject({ disabled: true });
  });
  it('a session can be moved to another project', () => {
    const menu = sidebarMenu({ kind: 'session', sessionId: 's', running: false, groupId: null, groups: [], projects: [{ id: 'p', name: 'repoB' }] });
    const move = menu.find((m) => m.id === 'move-project')!;
    expect(move.label).toBe('Move to project…');
    expect(move.children![0]).toMatchObject({ label: 'repoB', action: { type: 'move-to-project', sessionId: 's', projectId: 'p' } });
    expect(sidebarMenu({ kind: 'session', sessionId: 's', running: false, groupId: null, groups: [], projects: [] }).find((m) => m.id === 'move-project')).toMatchObject({ disabled: true });
  });

  it('offers Pin or Unpin on a session and a group beside Open in new tab; a project pins from its card', () => {
    const session = sidebarMenu({ kind: 'session', sessionId: 's', running: false, groupId: null, groups: [], pinned: false });
    expect(labels(session).slice(0, 3)).toEqual(['Open in new tab', 'Pin', 'Rename']);
    expect(session[1]!.action).toEqual({ type: 'pin', kind: 'session', id: 's', pinned: true });
    expect(labels(sidebarMenu({ kind: 'project', projectId: 'p', name: 'Wren', sessionCount: 0, pinned: true }))).not.toContain('Unpin');
    const group = sidebarMenu({ kind: 'folder', groupId: 'g', name: 'Launch', sessionCount: 0, pinned: false });
    expect(labels(group).slice(0, 4)).toEqual(['New session in Launch', 'Open group page', 'Open in new tab', 'Pin']);
    expect(group[3]).toMatchObject({ action: { type: 'pin', kind: 'group', id: 'g', pinned: true } });
  });
  it('a project offers New group in it', () => {
    const menu = sidebarMenu({ kind: 'project', projectId: 'p', name: 'Wren', sessionCount: 0 });
    expect(menu.find((m) => m.id === 'new-folder')!.action).toEqual({ type: 'new-folder', projectId: 'p' });
  });

  it('a project’s group starts sessions in its project, and cannot move to another', () => {
    const menu = sidebarMenu({ kind: 'folder', groupId: 'g', name: 'Launch', sessionCount: 0, projectId: 'p', projects: [{ id: 'q', name: 'Q' }] });
    expect(menu.find((m) => m.id === 'new-session')).toMatchObject({ label: 'New session in Launch', action: { type: 'new-session', groupId: 'g', projectId: 'p' } });
    // A group holds no group: New group is on the project.
    expect(labels(menu)).not.toContain('New group');
    expect(labels(menu)).not.toContain('Move to project');
  });

  it('a Sessions-list group can be moved into a project', () => {
    const menu = sidebarMenu({ kind: 'folder', groupId: 'g', name: 'Launch', sessionCount: 1, projects: [{ id: 'q', name: 'Q' }] });
    const move = menu.find((m) => m.id === 'move-group-project')!;
    expect(menu[menu.indexOf(move) - 1]!.label).toBe('Rename Launch');
    expect(move.children![0]!.action).toEqual({ type: 'move-group-to-project', groupId: 'g', projectId: 'q' });
  });
});

describe('a workstream’s menu', () => {
  const ids = (target: Parameters<typeof sidebarMenu>[0]) => sidebarMenu(target).map((i) => i.id);
  it('opens, renames and deletes; offers Stop only while something runs; has no New session', () => {
    expect(ids({ kind: 'workstream', workstreamId: 'w', name: 'Invoices' })).toEqual(['open-workstream', 'open-new-tab', 'rename-workstream', 'complete-workstream', 'archive-workstream', 'archive-workstream-all', 'delete-workstream', 'delete-workstream-all']);
    expect(ids({ kind: 'workstream', workstreamId: 'w', name: 'Invoices', running: true })).toContain('stop-workstream');
    expect(ids({ kind: 'workstream', workstreamId: 'w', name: 'Invoices', onPage: true })).not.toContain('open-workstream');
  });

  it('marks complete or not, and archives or restores, as it stands; archiving is disabled, with the reason, while sessions are at work', () => {
    const base = { kind: 'workstream' as const, workstreamId: 'w', name: 'Invoices' };
    const find = (target: Parameters<typeof sidebarMenu>[0], id: string) => sidebarMenu(target).find((i) => i.id === id);
    expect(find(base, 'complete-workstream')).toMatchObject({ label: 'Mark complete', action: { type: 'set-workstream-status', workstreamId: 'w', status: 'complete' } });
    expect(find({ ...base, complete: true }, 'reopen-workstream')).toMatchObject({ label: 'Mark as not complete', action: { type: 'set-workstream-status', status: 'active' } });
    expect(find(base, 'archive-workstream')).toMatchObject({ label: 'Archive workstream', action: { type: 'archive-workstream', workstreamId: 'w', archived: true } });
    expect(find(base, 'archive-workstream')!.hint).toBeUndefined();
    // The full clean-up in one go: the workstream and its sessions, archived or deleted.
    expect(find(base, 'archive-workstream-all')).toMatchObject({ label: 'Archive workstream and sessions', action: { type: 'archive-workstream', workstreamId: 'w', archived: true, withSessions: true } });
    expect(find(base, 'delete-workstream-all')).toMatchObject({ label: 'Delete workstream and sessions', action: { type: 'delete-workstream', workstreamId: 'w', withSessions: true } });
    const busy = find({ ...base, running: true, members: [{ id: 'a', title: 'Export', state: 'running' }, { id: 'b', title: 'Button', state: 'done' }] }, 'archive-workstream')!;
    expect(busy).toMatchObject({ label: 'Archive workstream', disabled: true });
    expect(busy.action).toBeUndefined();
    expect(busy.hint).toContain('“Export” is still working or waiting on you');
    // Nothing is archived or deleted with its sessions while one is still at work; the grouping alone can go.
    const busyBase = { ...base, running: true, members: [{ id: 'a', title: 'Export', state: 'running' as const }] };
    expect(find(busyBase, 'archive-workstream-all')).toMatchObject({ disabled: true });
    expect(find(busyBase, 'delete-workstream-all')).toMatchObject({ disabled: true });
    expect(find(busyBase, 'delete-workstream')!.disabled).toBeUndefined();
    expect(find({ ...base, members: [{ id: 'b', title: 'Button', state: 'interrupted' }] }, 'archive-workstream')).toMatchObject({ action: { type: 'archive-workstream', archived: true } });
    expect(find({ ...base, archived: true }, 'restore-workstream')).toMatchObject({ label: 'Restore workstream', action: { type: 'archive-workstream', archived: false } });
    expect(find({ ...base, archived: true }, 'archive-workstream')).toBeUndefined();
  });

  it('lets a session in one be taken out of it, by name', () => {
    const base = { kind: 'session' as const, sessionId: 's', running: false, groupId: null, groups: [] };
    expect(ids(base)).not.toContain('leave-workstream');
    const leave = sidebarMenu({ ...base, workstream: { id: 'w', name: 'Invoices' } }).find((i) => i.id === 'leave-workstream')!;
    expect(leave).toMatchObject({ label: 'Remove from Invoices', action: { type: 'remove-from-workstream', workstreamId: 'w', sessionId: 's' } });
  });

  it('greys out Remove from on the lead, with the reason', () => {
    const base = { kind: 'session' as const, sessionId: 'o', running: false, groupId: null, groups: [] };
    const leave = sidebarMenu({ ...base, workstream: { id: 'w', name: 'Invoices', refusal: 'It leads this workstream: delete the workstream instead' } }).find((i) => i.id === 'leave-workstream')!;
    expect(leave).toMatchObject({ disabled: true, hint: expect.stringContaining('leads') });
    expect(leave.action).toBeUndefined();
  });

  it("opens the workstream's page from a session in one (its row, its tab), right after the session's own opening items", () => {
    const base = { kind: 'session' as const, sessionId: 's', running: false, groupId: null, groups: [] };
    expect(ids(base)).not.toContain('open-workstream');
    const items = ids({ ...base, workstream: { id: 'w', name: 'Invoices' } });
    expect(items.slice(0, 2)).toEqual(['open-new-tab', 'open-workstream']);
    const open = sidebarMenu({ ...base, workstream: { id: 'w', name: 'Invoices' } }).find((i) => i.id === 'open-workstream')!;
    expect(open).toMatchObject({ label: 'Open workstream page', action: { type: 'open-workstream', workstreamId: 'w' } });
  });

});

describe('Fork in a session’s menu', () => {
  const base = { kind: 'session' as const, sessionId: 's', running: false, groupId: null, groups: [] };
  const fork = (extra: object) => sidebarMenu({ ...base, ...extra }).find((i) => i.id === 'fork');

  it('forks any session of an agent that can, in a workstream or not', () => {
    expect(fork({ agent: 'claude' })).toEqual({ id: 'fork', label: 'Fork', action: { type: 'fork-session', sessionId: 's' } });
    expect(fork({ agent: 'codex', workstream: { id: 'w', name: 'Invoices' } })).toMatchObject({ action: { type: 'fork-session', sessionId: 's' } });
  });
  it('is disabled with the reason while a turn runs, and for an agent that cannot fork', () => {
    expect(fork({ agent: 'claude', running: true })).toEqual({ id: 'fork', label: 'Fork', disabled: true, hint: 'Wait for the turn to end' });
    expect(fork({ agent: 'opencode' })).toEqual({ id: 'fork', label: 'Fork', disabled: true, hint: 'OpenCode cannot fork a conversation' });
  });
  it('is not offered where the agent is not known', () => {
    expect(fork({})).toBeUndefined();
  });
});

describe('a command’s menu in the Commands pane', () => {
  it('names its first item by how the command stands: Stop while it runs, Retry when it failed, Re-run otherwise', () => {
    const again = { type: 'retry-command', sessionId: 's', commandId: 'c' };
    expect(commandMenu('s', { id: 'c', status: 'completed' }, 'pnpm test')[0]).toEqual({ id: 'retry-command', label: 'Re-run command', action: again });
    expect(commandMenu('s', { id: 'c', status: 'stopped' }, 'pnpm test')[0]).toEqual({ id: 'retry-command', label: 'Re-run command', action: again });
    expect(commandMenu('s', { id: 'c', status: 'failed' }, 'pnpm test')[0]).toEqual({ id: 'retry-command', label: 'Retry command', action: again });
    expect(commandMenu('s', { id: 'c', status: 'running' }, 'pnpm test')[0]).toEqual({ id: 'stop-command', label: 'Stop command', action: { type: 'stop-command', sessionId: 's', commandId: 'c' } });
  });

  it('says why a running command cannot be stopped on its own', () => {
    const stop = commandMenu('s', { id: 'c', status: 'running', noStop: 'It ends with the turn' }, 'pnpm test')[0]!;
    expect(stop).toEqual({ id: 'stop-command', label: 'Stop command', disabled: true, hint: 'It ends with the turn' });
  });

  it('copies the command as it was run, and its output, running or not', () => {
    for (const status of ['running', 'completed']) {
      const [, copy, output] = commandMenu('s', { id: 'c', status }, 'pnpm test');
      expect(copy).toMatchObject({ id: 'copy-command', label: 'Copy command', action: { type: 'copy', text: 'pnpm test' } });
      expect(output).toEqual({ id: 'copy-command-output', label: 'Copy command output', action: { type: 'copy-command-output', sessionId: 's', commandId: 'c' } });
    }
  });

  it('says why a command with no command line cannot be copied', () => {
    const copy = commandMenu('s', { id: 'c', status: 'completed' }, null)[1]!;
    expect(copy).toMatchObject({ disabled: true, hint: 'It has no command line' });
    expect(copy.action).toBeUndefined();
  });

  describe('Open in, from a session or a project in the sidebar', () => {
    const apps = [
      { id: 'vscode', label: 'VS Code', kind: 'editor' as const, icon: 'data:x' },
      { id: 'finder', label: 'Finder', kind: 'finder' as const },
      { id: 'iterm', label: 'iTerm', kind: 'terminal' as const },
    ];
    const session = { kind: 'session' as const, sessionId: 's1', running: false, groupId: null, groups: [], path: '/w/s1' };
    const project = { kind: 'project' as const, projectId: 'p1', name: 'Bellbird', sessionCount: 0, path: '/code/bellbird' };
    const openItems = (items: ReturnType<typeof sidebarMenu>) => items.filter((i) => i.id.startsWith('open-in'));

    it('offers the default app by name and every app under "Open in…", before Show in Finder', () => {
      const items = sidebarMenu({ ...session, openIn: { apps, defaultId: 'vscode' } });
      const [byDefault, more] = openItems(items);
      expect(byDefault).toMatchObject({ id: 'open-in-default', label: 'Open in VS Code', separatorBefore: true, action: { type: 'open-folder', scope: 's1', appId: 'vscode' } });
      // No icon on the default's own item, like the items around it; the apps in the list keep theirs.
      expect(byDefault!.icon).toBeUndefined();
      expect(more!.children![0]!.icon).toBe('data:x');
      expect(more).toMatchObject({ id: 'open-in', label: 'Open in…' });
      expect(more!.children!.map((c) => [c.label, c.action])).toEqual([
        ['VS Code', { type: 'open-folder', scope: 's1', appId: 'vscode' }],
        ['Finder', { type: 'open-folder', scope: 's1', appId: 'finder' }],
        ['iTerm', { type: 'open-folder', scope: 's1', appId: 'iterm' }],
      ]);
      const ids = items.map((i) => i.id);
      expect(ids.indexOf('open-in')).toBe(ids.indexOf('reveal') - 1);
      // The path group still starts with one separator, now on the first Open in item.
      expect(items.find((i) => i.id === 'reveal')!.separatorBefore).toBeUndefined();
    });

    it('a project opens its own folder, by its scope', () => {
      const [byDefault, more] = openItems(sidebarMenu({ ...project, openIn: { apps, defaultId: 'iterm' } }));
      expect(byDefault).toMatchObject({ label: 'Open in iTerm', action: { type: 'open-folder', scope: 'project:p1', appId: 'iterm' } });
      expect(more!.children).toHaveLength(3);
    });

    it('offers nothing without a folder on disk, without apps, or when the apps are not known', () => {
      expect(openItems(sidebarMenu({ ...session, path: null, openIn: { apps, defaultId: 'vscode' } }))).toEqual([]);
      expect(openItems(sidebarMenu({ ...session, openIn: { apps: [], defaultId: null } }))).toEqual([]);
      expect(openItems(sidebarMenu(session))).toEqual([]);
    });

    it('with no default it still offers the list', () => {
      expect(openItems(sidebarMenu({ ...project, openIn: { apps, defaultId: null } })).map((i) => i.id)).toEqual(['open-in']);
    });
  });
});
