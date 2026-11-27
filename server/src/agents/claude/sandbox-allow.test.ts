// The always-allowed list as the Claude adapter applies it: folders widen the sandbox a run starts
// with, commands on it skip the card, and the card offers to add the command or folder.
import { describe, expect, it } from 'vitest';
import { NO_TOOLS } from '../test-support.ts';
import type { AgentEvent, InputRequest, OutsideInherit, SandboxAllowAccess } from '../types.ts';
import { ALWAYS_CHILDREN, ALWAYS_CHILDREN_LABEL } from '../../shared/sandbox-inherit.ts';
import type { SandboxAllowEntry, SandboxOffer } from '../../shared/sandbox-allow.ts';
import { claudeAdapter } from './index.ts';
import { sandboxBounds, shellSandbox } from './sandbox.ts';

const done = { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0 };
const noRepo = () => null;

/** A list the test changes between calls, as Settings would. */
function listOf(initial: SandboxAllowEntry[], offer: SandboxOffer = {}) {
  let entries = initial;
  const offers: string[] = [];
  const access: SandboxAllowAccess = {
    entries: () => entries,
    offer: async (command) => {
      offers.push(command);
      return offer;
    },
  };
  return { access, offers, set: (next: SandboxAllowEntry[]) => (entries = next) };
}

function child(access: SandboxAllowAccess, permission: 'ask' | 'auto' = 'auto', outsideInherit?: OutsideInherit) {
  let hook: any;
  let canUseTool: any;
  const calls: any[] = [];
  const runQuery = ((args: any) => {
    calls.push(args.options);
    hook = args.options.hooks.PreToolUse[0].hooks[0];
    canUseTool = args.options.canUseTool;
    return Object.assign((async function* () { yield done; })(), { interrupt: async () => undefined });
  }) as any;
  const events: AgentEvent[] = [];
  const handle = claudeAdapter(runQuery).start({ directory: '/w/child', instruction: 'x', tools: NO_TOOLS, permission, confineShell: true, sandboxAllow: access, ...(outsideInherit ? { outsideInherit } : {}) }, 'go', (e) => events.push(e));
  const verdict = async (input: Record<string, unknown>, useId?: string) => (await hook({ tool_name: 'Bash', tool_input: input, ...(useId ? { tool_use_id: useId } : {}) }))?.hookSpecificOutput?.permissionDecision;
  const card = async (input: Record<string, unknown>, id = 'b1') => {
    const pending = canUseTool('Bash', input, { signal: new AbortController().signal, toolUseID: id });
    // canUseTool works out the offer before the card goes out.
    for (let i = 0; i < 10 && !events.some((e) => e.type === 'needs-input' && e.request.id === id); i++) await Promise.resolve();
    const request = (events.find((e) => e.type === 'needs-input' && e.request.id === id) as { request: InputRequest }).request;
    return { pending, request };
  };
  const approve = (input: Record<string, unknown>, id: string) => canUseTool('Bash', input, { signal: new AbortController().signal, toolUseID: id });
  return { handle, verdict, card, calls, approve, events };
}

const outside = (command: string) => ({ command, dangerouslyDisableSandbox: true });

describe('folders on the always-allowed list', () => {
  it('go into the sandbox a session starts with: read-and-write ones may be written, all may be read', () => {
    const { access } = listOf([
      { kind: 'folder', path: '/Users/me/.gnupg', access: 'read-write' },
      { kind: 'folder', path: '/Users/me/.aws', access: 'read' },
      { kind: 'command', words: ['gpg'] },
    ]);
    expect(shellSandbox({ directory: '/w/child', permission: 'ask', confineShell: true, sandboxAllow: access }, noRepo)?.filesystem).toEqual({
      allowWrite: ['/w/child', '/Users/me/.gnupg'],
      allowRead: ['/Users/me/.gnupg', '/Users/me/.aws'],
    });
    expect(sandboxBounds({ directory: '/w/child', permission: 'ask', confineShell: true, sandboxAllow: access }, noRepo).folders).toEqual(expect.arrayContaining(['/w/child', '/tmp', '/Users/me/.gnupg']));
    expect(sandboxBounds({ directory: '/w/child', permission: 'ask', confineShell: true, sandboxAllow: access }, noRepo).folders).not.toContain('/Users/me/.aws');
  });

  it('reach a running session from its next run: the options are built again with the list as it stands', async () => {
    const list = listOf([]);
    const s = child(list.access);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.calls[0].sandbox.filesystem.allowWrite).toEqual(['/w/child']);
    list.set([{ kind: 'folder', path: '/Users/me/.gnupg', access: 'read-write' }]);
    s.handle.send('again');
    expect(s.calls[1].sandbox.filesystem.allowWrite).toEqual(['/w/child', '/Users/me/.gnupg']);
  });
});

describe('a command on the always-allowed list', () => {
  it('runs outside the sandbox without a card, in every mode; a near miss still asks', async () => {
    for (const permission of ['ask', 'auto'] as const) {
      const s = child(listOf([{ kind: 'command', words: ['git', 'commit'] }]).access, permission);
      expect(await s.verdict(outside('git commit -S -m "signed"'))).toBe('allow');
      expect(await s.verdict(outside('git commit -m x; rm -rf ~'))).toBe('ask');
      expect(await s.verdict(outside('git -c core.sshCommand=x commit'))).toBe('ask');
      expect(await s.verdict(outside('git commit --template=/etc/passwd'))).toBe('ask');
      expect(await s.verdict(outside('git push'))).toBe('ask');
    }
  });

  it('asks again once the entry is removed', async () => {
    const list = listOf([{ kind: 'command', words: ['gpg'] }]);
    const s = child(list.access);
    expect(await s.verdict(outside('gpg --list-keys'))).toBe('allow');
    list.set([]);
    expect(await s.verdict(outside('gpg --list-keys'))).toBe('ask');
  });

  it('changes nothing for a command inside the sandbox: it follows the mode as before', async () => {
    const s = child(listOf([{ kind: 'command', words: ['git', 'commit'] }]).access);
    expect(await s.verdict({ command: 'git commit -m x' })).toBeUndefined();
  });
});

describe('the card for a command outside the sandbox', () => {
  it('offers to always allow the command and the folder, each saying exactly what it adds', async () => {
    const list = listOf([], { command: ['git', 'commit'], folder: { path: '/Users/me/.gnupg', access: 'read-write' } });
    const s = child(list.access);
    const { request } = await s.card(outside('git commit -m x'));
    expect(list.offers).toEqual(['git commit -m x']);
    expect(request.sandboxOffer).toEqual({ command: ['git', 'commit'], folder: { path: '/Users/me/.gnupg', access: 'read-write' } });
    expect(request.options).toEqual([
      { id: 'allow', label: 'Allow', role: 'allow' },
      { id: 'always-command', label: 'Always allow this command: git commit', role: 'allow' },
      { id: 'always-folder', label: 'Always allow this folder: /Users/me/.gnupg (read and write)', role: 'allow' },
      { id: 'allow-outside', label: 'Allow all outside the sandbox', role: 'allow' },
      { id: 'deny', label: 'Deny', role: 'deny' },
    ]);
  });

  it('offers neither when there is nothing to offer, and allows the request once Kestrel passes the choice on', async () => {
    const s = child(listOf([]).access);
    const { request, pending } = await s.card(outside('make $(x)'));
    expect(request.sandboxOffer).toBeUndefined();
    expect(request.options.map((o) => o.id)).toEqual(['allow', 'allow-outside', 'deny']);
    s.handle.answer('b1', { optionId: 'allow' });
    expect(await pending).toMatchObject({ behavior: 'allow' });
  });
});

// A user's own Claude Code hook may rewrite a command after Kestrel's hook has seen it (rtk:
// `git commit -m d1` becomes `rtk git commit -m d1`). Claude Code then checks the rewritten command
// again and asks Kestrel's approval callback with it, whatever Kestrel's hook said.
describe('a command another hook rewrote', () => {
  it('runs without a card when what will really run is covered, seen through a known wrapper', async () => {
    const s = child(listOf([{ kind: 'command', words: ['git', 'commit'] }]).access);
    expect(await s.verdict(outside('git commit -am d2'), 'u1')).toBe('allow');
    expect(await s.approve(outside('rtk git commit -am d2'), 'u1')).toEqual({ behavior: 'allow', updatedInput: outside('rtk git commit -am d2') });
    expect(s.events.some((e) => e.type === 'needs-input')).toBe(false);
  });

  it('is judged on what will run, not on what Claude wrote', async () => {
    const s = child(listOf([{ kind: 'command', words: ['git', 'commit'] }]).access);
    expect(await s.verdict(outside('git commit -m x'), 'u2')).toBe('allow');
    const { request } = await s.card(outside('rtk proxy rm -rf ~'), 'u2');
    expect(request.title).toBe('Run a command (outside the sandbox)');
  });

  it('shows on the card both what Claude asked for and what will run, and offers the command inside the wrapper', async () => {
    const list = listOf([], { command: ['git', 'commit'] });
    const s = child(list.access);
    expect(await s.verdict(outside('git commit -m d1'), 'u3')).toBe('ask');
    const { request } = await s.card(outside('rtk git commit -m d1'), 'u3');
    expect(request.detail).toContain('Claude asked to run:\ngit commit -m d1');
    expect(request.detail).toContain('What will run:\nrtk git commit -m d1');
    expect(list.offers).toEqual(['rtk git commit -m d1']);
    expect(request.options.find((o) => o.id === 'always-command')?.label).toBe('Always allow this command: git commit');
  });

  it('shows the command once when nothing rewrote it', async () => {
    const s = child(listOf([]).access);
    await s.verdict(outside('make x'), 'u4');
    const { request } = await s.card(outside('make x'), 'u4');
    expect(request.detail).not.toContain('Claude asked to run');
  });

  it('keeps "Allow all outside the sandbox" for a rewritten command too', async () => {
    const s = child(listOf([]).access);
    const { pending } = await s.card(outside('rtk make'), 'u5');
    s.handle.answer('u5', { optionId: 'allow-outside' });
    await pending;
    expect(await s.approve(outside('rtk make again'), 'u6')).toMatchObject({ behavior: 'allow' });
  });
});

// Issue 74: a child whose starter would not be asked, once the user switched it on, is not asked either.
describe('a session another session started, with the switch for such sessions', () => {
  it('runs a command outside the sandbox without a card while the switch lets it, read at each command', async () => {
    let on = true;
    const s = child(listOf([]).access, 'auto', { allows: () => on, offerable: () => !on });
    expect(await s.verdict(outside('git push'))).toBe('allow');
    expect(await s.approve(outside('git push'), 'i1')).toMatchObject({ behavior: 'allow' });
    on = false;
    expect(await s.verdict(outside('git push'))).toBe('ask');
    // A command inside the sandbox still follows the mode.
    on = true;
    expect(await s.verdict({ command: 'ls' })).toBeUndefined();
  });

  it('offers to turn the switch on, on the card of a child it would let through; the choice passed on as Allow allows it', async () => {
    const s = child(listOf([]).access, 'auto', { allows: () => false, offerable: () => true });
    const { request, pending } = await s.card(outside('make $(x)'));
    expect(request.options).toEqual([
      { id: 'allow', label: 'Allow', role: 'allow' },
      { id: ALWAYS_CHILDREN, label: ALWAYS_CHILDREN_LABEL, role: 'allow' },
      { id: 'allow-outside', label: 'Allow all outside the sandbox', role: 'allow' },
      { id: 'deny', label: 'Deny', role: 'deny' },
    ]);
    // The runtime turns the switch on and passes the choice on as Allow (sandbox-allow/store.ts answerCard).
    s.handle.answer('b1', { optionId: 'allow' });
    expect(await pending).toMatchObject({ behavior: 'allow' });
  });

  it('does not offer it where it would change nothing for this session (its starter would be asked)', async () => {
    const s = child(listOf([]).access, 'ask', { allows: () => false, offerable: () => false });
    const { request } = await s.card(outside('make $(x)'));
    expect(request.options.map((o) => o.id)).toEqual(['allow', 'allow-outside', 'deny']);
  });
});
