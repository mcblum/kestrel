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
