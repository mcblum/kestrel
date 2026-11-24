import { NO_TOOLS } from '../agents/test-support.ts';
import { describe, expect, it } from 'vitest';
import { baseOptions } from '../agents/claude/options.ts';
import { PERMISSION_LEVELS, asksOutsideFolder, childPermission, claudePermission, isPermissionLevel, permissionHint, remoteStartPermission, stickyPermission } from './permissions.ts';

const opts = { directory: '/w', instruction: 'x', tools: NO_TOOLS };

describe('permission levels', () => {
  it("starts a child in its parent's mode, never in Bypass, and in Manual when the parent cannot edit", () => {
    expect(childPermission('ask')).toBe('ask');
    expect(childPermission('edits')).toBe('edits');
    expect(childPermission('auto')).toBe('auto');
    expect(childPermission('plan')).toBe('plan');
    // Bypass is confirmed by the user for one session; a session it starts gets the next mode down.
    expect(childPermission('bypass')).toBe('auto');
    // A read-only parent has no project: its child is the one that edits, and asks first.
    expect(childPermission('readonly')).toBe('ask');
    expect(childPermission(undefined)).toBe('ask');
    for (const l of PERMISSION_LEVELS) expect(['bypass', 'readonly']).not.toContain(childPermission(l.id));
  });

  it('offers the four numbered modes, Bypass on its own row, and keeps Read only out of the menu', () => {
    expect(PERMISSION_LEVELS.filter((l) => l.place === 'listed').map((l) => l.label)).toEqual(['Auto', 'Manual', 'Accept edits', 'Plan']);
    expect(PERMISSION_LEVELS.find((l) => l.place === 'bypass')!.label).toBe('Bypass permissions');
    // Read only is kept for sessions that have it, and not offered in the menu.
    expect(PERMISSION_LEVELS.find((l) => l.id === 'readonly')!.place).toBe('hidden');
  });
  it('maps to SDK modes; only the confirmed level skips prompts', () => {
    expect(claudePermission('auto')).toEqual({ permissionMode: 'auto', readOnly: false });
    expect(claudePermission('ask')).toEqual({ permissionMode: 'default', readOnly: false });
    expect(claudePermission('edits')).toEqual({ permissionMode: 'acceptEdits', readOnly: false });
    expect(claudePermission('readonly')).toEqual({ permissionMode: 'dontAsk', readOnly: true });
    expect(claudePermission('plan')).toEqual({ permissionMode: 'plan', readOnly: false });
    expect(claudePermission('bypass')).toEqual({ permissionMode: 'bypassPermissions', readOnly: false });
    for (const l of PERMISSION_LEVELS) if (l.id !== 'bypass') expect(claudePermission(l.id).permissionMode).not.toBe('bypassPermissions');
  });
  it('starts a new session in the mode last chosen, except that Bypass becomes Auto', () => {
    expect(stickyPermission('auto')).toBe('auto');
    expect(stickyPermission('ask')).toBe('ask');
    expect(stickyPermission('edits')).toBe('edits');
    expect(stickyPermission('plan')).toBe('plan');
    expect(stickyPermission('bypass')).toBe('auto');
    for (const l of PERMISSION_LEVELS) expect(stickyPermission(l.id)).not.toBe('bypass');
  });
  it('asks for an edit outside the session folder only in the modes that would otherwise pass it unasked', () => {
    expect(PERMISSION_LEVELS.filter((l) => asksOutsideFolder(l.id)).map((l) => l.id)).toEqual(['ask', 'edits']);
  });
  it('validates input', () => {
    expect(isPermissionLevel('edits')).toBe(true);
    expect(isPermissionLevel('bypassPermissions')).toBe(false);
    expect(isPermissionLevel('bypass')).toBe(true);
  });
  it('reaches the SDK options', () => {
    expect(baseOptions({ ...opts, permission: 'ask' }, {}).permissionMode).toBe('default');
    const edits = baseOptions({ ...opts, permission: 'edits' }, {});
    expect(edits.permissionMode).toBe('acceptEdits');
    expect(edits.disallowedTools ?? []).not.toContain('Write');
    const ro = baseOptions({ ...opts, permission: 'readonly', readableDirectories: ['/p'] }, {});
    expect(ro).toMatchObject({ permissionMode: 'dontAsk', additionalDirectories: ['/p'] });
    expect(ro.disallowedTools).toEqual(expect.arrayContaining(['Write', 'Edit', 'Bash']));
  });
});

describe('permissionHint', () => {
  const mode = (id: string) => PERMISSION_LEVELS.find((l) => l.id === id)!;

  it('says what the mode does for the agent the session runs on', () => {
    expect(permissionHint(mode('auto'), 'claude')).toBe('Claude handles permission decisions');
    // Since 0.0.16 every Codex approval comes to Kestrel: Codex decides nothing for the user.
    expect(permissionHint(mode('auto'), 'codex')).not.toMatch(/Codex handles/);
    expect(permissionHint(mode('auto'), 'codex')).toMatch(/sandbox/);
    // Auto does not ask (Matt, 2026-11-23): what Codex asks to take outside its sandbox is accepted.
    expect(permissionHint(mode('auto'), 'codex')).toMatch(/without asking/);
    expect(permissionHint(mode('auto'), 'opencode')).toMatch(/without asking/);
    // Codex's Accept edits takes file changes in its folder only; one outside it is still a card.
    expect(permissionHint(mode('edits'), 'codex')).toMatch(/folder/);
    expect(permissionHint(mode('edits'), 'claude')).toBe(mode('edits').hint);
  });

  it('falls back to the common hint for a mode or agent with no wording of its own', () => {
    expect(permissionHint(mode('ask'), 'codex')).toBe(mode('ask').hint);
    expect(permissionHint(mode('auto'))).toBe(mode('auto').hint);
  });
});

describe('remoteStartPermission (A8: never Bypass from another device)', () => {
  it('keeps what the desk would use, and turns Bypass into Auto', () => {
    expect(remoteStartPermission('bypass')).toBe('auto');
    for (const level of ['auto', 'ask', 'edits', 'plan'] as const) expect(remoteStartPermission(level)).toBe(level);
  });
});
