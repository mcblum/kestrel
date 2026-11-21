import { describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_EDIT_PREFS, otherProjectHolding, otherProjectRefusal, otherWorktreeHolding, otherWorktreeRefusal, sanitizeProjectEditPrefs } from './project-edits.ts';

const projects = [
  { id: 'vireo', name: 'Vireo', folders: [{ path: '/code/vireo' }] },
  { id: 'cm', name: 'Configuration Management', folders: [{ path: '/code/configuration-management' }, { path: '/code/cm-secrets' }] },
  { id: 'site', name: 'Vireo site', folders: [{ path: '/code/vireo/site' }] },
];

describe('which project holds a file', () => {
  it('is another registered project when the file is inside one of its folders', () => {
    expect(otherProjectHolding('/code/configuration-management/k8s/vireo.yaml', projects, 'vireo')?.name).toBe('Configuration Management');
    expect(otherProjectHolding('/code/cm-secrets', projects, 'vireo')?.id).toBe('cm');
  });

  it('is none for a file in the session’s own project or in no project', () => {
    expect(otherProjectHolding('/code/vireo/README.md', projects, 'vireo')).toBeNull();
    expect(otherProjectHolding('/Users/me/.zshrc', projects, 'vireo')).toBeNull();
    // A folder whose name only starts the same is not inside it.
    expect(otherProjectHolding('/code/vireo-old/x', projects, 'cm')).toBeNull();
  });

  it('goes by the innermost folder when projects nest', () => {
    expect(otherProjectHolding('/code/vireo/site/index.html', projects, 'vireo')?.id).toBe('site');
    expect(otherProjectHolding('/code/vireo/site/index.html', projects, 'site')).toBeNull();
  });

  it('counts every project as another for a session with no project', () => {
    expect(otherProjectHolding('/code/vireo/README.md', projects, null)?.id).toBe('vireo');
  });
});

describe('the refusal and the setting', () => {
  it('says why, what to do, and where to turn it off', () => {
    const text = otherProjectRefusal('/code/configuration-management/k8s/vireo.yaml', 'Configuration Management', 'mcp__kestrel__delegate');
    expect(text).toMatch(/is in the Kestrel project "Configuration Management"/);
    expect(text).toMatch(/Call mcp__kestrel__delegate with a brief for "Configuration Management"/);
    expect(text).toMatch(/Settings → Workflow/);
  });

  it('is on unless it was switched off', () => {
    expect(DEFAULT_PROJECT_EDIT_PREFS).toEqual({ keepInProject: true });
    expect(sanitizeProjectEditPrefs(null)).toEqual({ keepInProject: true });
    expect(sanitizeProjectEditPrefs({ keepInProject: 'no' })).toEqual({ keepInProject: true });
    expect(sanitizeProjectEditPrefs({ keepInProject: false })).toEqual({ keepInProject: false });
  });
});

describe('another session’s worktree', () => {
  const sessions = [
    { id: 'me', title: 'Mine', worktreePath: '/data/worktrees/me' },
    { id: 'them', title: 'Cache pricing', worktreePath: '/data/worktrees/them' },
    { id: 'none', title: 'No worktree', worktreePath: null },
  ];

  it('belongs to the session it was made for: a file in it is found, the asker’s own is not', () => {
    expect(otherWorktreeHolding('/data/worktrees/them/src/a.ts', sessions, 'me')?.id).toBe('them');
    expect(otherWorktreeHolding('/data/worktrees/me/src/a.ts', sessions, 'me')).toBeNull();
    expect(otherWorktreeHolding('/data/worktrees/them-2/a.ts', sessions, 'me')).toBeNull();
    expect(otherWorktreeHolding('/code/vireo/a.ts', sessions, 'me')).toBeNull();
  });

  it('is refused by naming the session and the tool that asks it', () => {
    const text = otherWorktreeRefusal('/data/worktrees/them/src/a.ts', sessions[1]!, 'mcp__kestrel__ask_session');
    expect(text).toMatch(/is in the worktree of the session "Cache pricing" \(them\)/);
    expect(text).toMatch(/Call mcp__kestrel__ask_session with session "them"/);
  });
});
