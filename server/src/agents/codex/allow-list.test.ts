// The always-allowed list for Codex, against the fake app-server: in Auto a command leaving the
// sandbox that the list covers is accepted with no card, a near miss is a card offering to add it,
// and read-and-write folders are writable roots of the sandbox policy each turn is sent.
import { mkdtempSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_TOOLS } from '../test-support.ts';
import type { AgentEvent, SandboxAllowAccess, StartOptions } from '../types.ts';
import type { SandboxAllowEntry } from '../../shared/sandbox-allow.ts';
import { SandboxAllowList } from '../../sandbox-allow/store.ts';
import { unwrapShell } from '../../sandbox-allow/command-line.ts';
import { codexAdapter, nodeLauncher } from './index.ts';
import { listAnswer } from './allow-list.ts';
import { codexPolicy } from './policy.ts';
import { ALWAYS_CHILDREN, ALWAYS_CHILDREN_LABEL } from '../../shared/sandbox-inherit.ts';
import { PROTECTED_REFUSAL, protectedRefusal } from '../../shared/protected-files.ts';

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-app-server.mjs');

function access(entries: SandboxAllowEntry[], offer: Awaited<ReturnType<SandboxAllowAccess['offer']>> = {}): SandboxAllowAccess {
  return { entries: () => entries, offer: async () => offer };
}

function setup(permission: StartOptions['permission'], sandboxAllow: SandboxAllowAccess) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-codex-allow-')));
  const log = join(dir, 'received.jsonl');
  const adapter = codexAdapter({ launch: nodeLauncher(FAKE), env: { ...process.env, FAKE_CODEX_SCENARIO: 'command', FAKE_CODEX_LOG: log, CODEX_HOME: dir }, log: () => undefined });
  // A session another session started: the one that asks before it leaves its sandbox in Auto, so the one the list answers for.
  const options: StartOptions = { directory: dir, instruction: 'x', tools: NO_TOOLS, permission, sandboxAllow, confineShell: true };
  const events: AgentEvent[] = [];
  const waiters: (() => void)[] = [];
  const emit = (e: AgentEvent) => {
    events.push(e);
    waiters.splice(0).forEach((w) => w());
  };
  const next = (type: AgentEvent['type']) =>
    new Promise<AgentEvent>((resolve) => {
      const look = () => {
        const seen = events.find((e) => e.type === type);
        if (seen) resolve(seen);
        else waiters.push(look);
      };
      look();
    });
  const received = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const said = () => events.filter((e) => e.type === 'message' && e.done).map((e) => (e as { text: string }).text);
  return { adapter, options, emit, next, received, said, dir, events };
}

describe('Codex and the always-allowed list', () => {
  it('in Auto, accepts a command leaving the sandbox that the list covers, with no card', async () => {
    const t = setup('auto', access([{ kind: 'command', words: ['git', 'commit'] }]));
    const handle = t.adapter.start(t.options, 'git commit -S -m x', t.emit);
    await t.next('done');
    expect(t.events.some((e) => e.type === 'needs-input')).toBe(false);
    expect(t.said()).toContain('ran it');
    await handle.close!();
  });

  it('in Auto, shows a near miss as a card offering to add it; the choice, passed on as Allow, accepts', async () => {
    const t = setup('auto', access([{ kind: 'command', words: ['git', 'commit'] }], { command: ['git', 'push'] }));
    const handle = t.adapter.start(t.options, 'git push origin main', t.emit);
    const card = (await t.next('needs-input')) as Extract<AgentEvent, { type: 'needs-input' }>;
    expect(card.request.sandboxOffer).toEqual({ command: ['git', 'push'] });
    expect(card.request.options.map((o) => o.id)).toEqual(['allow', 'always-command', 'deny']);
    expect(card.request.options[1]!.label).toBe('Always allow this command: git push');
    // The runtime adds the entry and passes the choice on as Allow (sandbox-allow/store.ts answerCard).
    handle.answer(card.request.id, { optionId: 'allow' });
    await t.next('done');
    expect(t.said()).toContain('ran it');
    await handle.close!();
  });

  it('a child whose starter would not be asked runs the command with no card once the switch lets it (issue 74)', async () => {
    const t = setup('auto', access([]));
    let on = true;
    const handle = t.adapter.start({ ...t.options, outsideInherit: { allows: () => on, offerable: () => !on } }, 'git push origin main', t.emit);
    await t.next('done');
    expect(t.events.some((e) => e.type === 'needs-input')).toBe(false);
    expect(t.said()).toContain('ran it');
    on = false;
    await handle.close!();
  });

  it('a child whose switch is off asks, and its card offers to turn it on; the choice, passed on as Allow, accepts', async () => {
    const t = setup('auto', access([]));
    const handle = t.adapter.start({ ...t.options, outsideInherit: { allows: () => false, offerable: () => true } }, 'git push origin main', t.emit);
    const card = (await t.next('needs-input')) as Extract<AgentEvent, { type: 'needs-input' }>;
    expect(card.request.options.map((o) => o.id)).toEqual(['allow', ALWAYS_CHILDREN, 'deny']);
    expect(card.request.options[1]!.label).toBe(ALWAYS_CHILDREN_LABEL);
    // The runtime turns the switch on and passes the choice on as Allow (sandbox-allow/store.ts answerCard).
    handle.answer(card.request.id, { optionId: 'allow' });
    await t.next('done');
    expect(t.said()).toContain('ran it');
    await handle.close!();
  });

  it("never accepts from the list a command that names Kestrel's credential store: it is refused, with the reason", async () => {
    const t = setup('auto', access([{ kind: 'command', words: ['cat'] }]));
    const files = [join(t.dir, 'trackers.json')];
    const options: StartOptions = { ...t.options, confineShell: true, protectedFiles: files, intercept: async (action) => {
      const refusal = protectedRefusal(action, files, (p) => p);
      return refusal ? { allow: false, message: refusal } : { allow: true };
    } };
    const handle = t.adapter.start(options, `cat ${files[0]}`, t.emit);
    await t.next('done');
    expect(t.events.some((e) => e.type === 'needs-input')).toBe(false);
    expect(t.said()).toContain('skipped it');
    // The agent is told why, with the turn still going.
    expect(JSON.stringify(t.received().filter((r) => r.method === 'turn/steer'))).toContain('credential store');
    await handle.close!();
  });

  it('in Manual, every command is still a card, and it offers nothing it would not honour', async () => {
    const t = setup('ask', access([{ kind: 'command', words: ['git', 'commit'] }], { command: ['git', 'commit'] }));
    const handle = t.adapter.start(t.options, 'git commit -m x', t.emit);
    const card = (await t.next('needs-input')) as Extract<AgentEvent, { type: 'needs-input' }>;
    expect(card.request.options.map((o) => o.id)).toEqual(['allow', 'deny']);
    handle.answer(card.request.id, { optionId: 'deny' });
    await t.next('done');
    await handle.close!();
  });

  it('sends read-and-write folders on the list as writable roots of every turn’s sandbox', async () => {
    const t = setup('auto', access([{ kind: 'folder', path: '/Users/me/.gnupg', access: 'read-write' }, { kind: 'folder', path: '/Users/me/.aws', access: 'read' }]));
    const handle = t.adapter.start(t.options, 'true', t.emit);
    await t.next('needs-input');
    const turn = t.received().find((m) => m.method === 'turn/start');
    expect(turn.params.sandboxPolicy).toMatchObject({ type: 'workspaceWrite', writableRoots: ['/Users/me/.gnupg'] });
    await handle.close!();
  });

  it('adds the card’s offer through the same list and server action as a Claude card', async () => {
    const list = new SandboxAllowList();
    const forwarded = await list.answerCard({ id: 'codex-1', kind: 'approval', title: '', detail: '', tool: 'Bash', options: [], sandboxOffer: { command: ['git', 'push'] } }, { optionId: 'always-command' });
    expect(forwarded).toEqual({ optionId: 'allow' });
    expect(await list.entries()).toEqual([{ kind: 'command', words: ['git', 'push'] }]);
  });
});

describe('what the list answers for Codex', () => {
  const opts = (entries: SandboxAllowEntry[]) => ({ directory: '/w/s', permission: 'auto' as const, sandboxAllow: access(entries) });
  const auto = codexPolicy('auto');

  it('judges the script inside Codex’s shell wrapper by the same rule', () => {
    expect(unwrapShell("/bin/zsh -lc 'git commit -m x'")).toBe('git commit -m x');
    expect(unwrapShell("bash -c 'a; b'")).toBe('a; b');
    expect(unwrapShell("/bin/zsh -lc 'a' extra")).toBe("/bin/zsh -lc 'a' extra");
    expect(unwrapShell('/tmp/zsh -lc x')).toBe('/tmp/zsh -lc x');
    const entries: SandboxAllowEntry[] = [{ kind: 'command', words: ['git', 'commit'] }];
    expect(listAnswer('item/commandExecution/requestApproval', { command: "/bin/zsh -lc 'git commit -m x'" }, auto, opts(entries))).toEqual({ decision: 'accept' });
    expect(listAnswer('item/commandExecution/requestApproval', { command: "/bin/zsh -lc 'git commit -m x; rm -rf ~'" }, auto, opts(entries))).toBeNull();
    expect(listAnswer('item/commandExecution/requestApproval', { command: "/bin/zsh -lc 'git commit'", cwd: '/etc' }, auto, opts(entries))).toBeNull();
    expect(listAnswer('item/commandExecution/requestApproval', { command: 'git commit', kind: 'writeStdin' }, auto, opts(entries))).toBeNull();
    expect(listAnswer('item/commandExecution/requestApproval', { command: 'git commit' }, codexPolicy('ask'), opts(entries))).toBeNull();
  });

  it('judges the real shape Codex sends, and a known wrapper inside it, by the same rule', () => {
    // codex exec_command({cmd:"git add c7.txt", sandbox_permissions:"require_escalated"}) reached Kestrel as this (2026-11-19).
    const entries: SandboxAllowEntry[] = [{ kind: 'command', words: ['git', 'add'] }];
    const ask = (command: string) => listAnswer('item/commandExecution/requestApproval', { command }, auto, opts(entries));
    expect(ask('/bin/zsh -lc "git add c7.txt"')).toEqual({ decision: 'accept' });
    expect(ask('/bin/zsh -lc "rtk git add c7.txt"')).toEqual({ decision: 'accept' });
    expect(ask('/bin/zsh -lc "rtk proxy rm -rf c7.txt"')).toBeNull();
    expect(ask('/bin/zsh -lc "rtk git -c x=y add c7.txt"')).toBeNull();
  });

  it('lets a request for more access through only when every path is in a listed folder and no network is asked', () => {
    const entries: SandboxAllowEntry[] = [{ kind: 'folder', path: '/Users/me/.gnupg', access: 'read-write' }, { kind: 'folder', path: '/Users/me/.aws', access: 'read' }];
    const ask = (fileSystem: unknown, network: unknown = null) => listAnswer('item/permissions/requestApproval', { permissions: { fileSystem, network } }, auto, opts(entries));
    expect(ask({ write: ['/Users/me/.gnupg/S.gpg-agent'], read: ['/Users/me/.aws/config'] })).toEqual({ permissions: { fileSystem: { write: ['/Users/me/.gnupg/S.gpg-agent'], read: ['/Users/me/.aws/config'] } }, scope: 'turn' });
    expect(ask({ write: ['/Users/me/.aws/x'], read: null })).toBeNull();
    expect(ask({ write: ['/Users/me/.gnupg/x'], read: null }, { enabled: true })).toBeNull();
    expect(ask({ write: null, read: null })).toBeNull();
  });
});
