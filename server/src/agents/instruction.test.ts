import { describe, expect, it } from 'vitest';
import { standingInstruction, type InstructionContext } from './instruction.ts';

const base: InstructionContext = {
  toolName: (name) => `mcp__kestrel__${name}`,
  projects: [
    { name: 'Vireo', folders: [{ id: 'f1', path: '/code/vireo', isGit: true }] },
    { name: 'Configuration Management', folders: [{ id: 'f2', path: '/code/configuration-management', isGit: true }] },
  ],
  workspace: { kind: 'worktree', branch: 'kestrel/x' },
};

describe('where a change is made', () => {
  it('tells an editing session to edit a file outside every project itself, and to delegate one inside another project', () => {
    const text = standingInstruction(base);
    expect(text).toMatch(/a file that is in NO registered project .* you edit yourself, from here; do not register a project or start a session just for that/);
    expect(text).toMatch(/A file inside ANOTHER registered project .* is not edited from here: call `mcp__kestrel__delegate` with a brief for that project, even for a small change/);
    // The projects it is to compare a path against are listed.
    expect(text).toContain('- Configuration Management: /code/configuration-management');
  });

  it('never tells a session that cannot edit to edit anything', () => {
    const text = standingInstruction({ ...base, workspace: { kind: 'read-only', noProject: true } });
    expect(text).not.toMatch(/you edit yourself/);
    expect(text).toMatch(/A file inside ANOTHER registered project .* call `mcp__kestrel__delegate`/);
  });

  it('keeps handoff for a task that moves, and registering a project for work of its own', () => {
    const text = standingInstruction(base);
    expect(text).toMatch(/`mcp__kestrel__handoff`\(project, summary\): the whole task MOVES to another project/);
    expect(text).toMatch(/Use it only when the user asks you to hand the task over or move it there/);
    expect(text).toMatch(/A change to a file or two in a folder that is not registered you make yourself/);
  });
});

describe('suggesting a tag', () => {
  it('lists the tags in use and tells the agent to reuse one whenever it covers the work', () => {
    const text = standingInstruction({ ...base, existingTags: ['Argus', 'PROJ-482'] });
    expect(text).toContain('Tags already in use: Argus, PROJ-482.');
    expect(text).toMatch(/Use one of these, written exactly as listed, whenever it covers the work, even loosely/);
    expect(text).toMatch(/Propose a new tag only when none of them covers the work/);
  });

  it('says nothing about tags in use when there are none', () => {
    expect(standingInstruction(base)).not.toContain('Tags already in use');
  });
});

describe('on a worker node (worker-nodes.md 9.3)', () => {
  const notCloned = [{ name: 'Shop', cloned: false as const, repositories: ['example.test/acme/shop'], note: 'It is cloned when a session starts in it.' }];

  it('lists the account’s projects it has not cloned after the registered ones, from the same rows list_projects gives', () => {
    const text = standingInstruction({ ...base, notCloned });
    const listed = text.slice(text.indexOf('Registered projects:'));
    expect(listed).toContain('- Vireo: /code/vireo');
    expect(listed).toContain('Projects of your account not on this computer yet; name one to `mcp__kestrel__handoff`, `mcp__kestrel__delegate`, `mcp__kestrel__spawn` or `mcp__kestrel__move_to_project` and Kestrel clones it first:\n- Shop (example.test/acme/shop): It is cloned when a session starts in it.');
    expect(text.indexOf('- Vireo')).toBeLessThan(text.indexOf('- Shop ('));
  });

  it('says once that it pushes the session’s branch, only where it does', () => {
    const line = 'This computer has no screen and nobody works at it: commit finished work, and Kestrel pushes this session’s branch to `origin` when your turn ends.';
    expect(standingInstruction({ ...base, nodePushes: true }).split(line)).toHaveLength(2);
    expect(standingInstruction(base)).not.toContain(line);
    expect(standingInstruction({ ...base, notCloned: [] })).not.toContain('not on this computer yet');
  });
});
