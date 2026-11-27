// Keeping the always-allowed list through every persistence provider, its HTTP route, and the
// sandbox card's "Always allow" choices.
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InputCard } from '../model.ts';
import { memoryPersistence } from '../persistence/memory.ts';
import { sqlitePersistence } from '../persistence/sqlite.ts';
import { ALWAYS_COMMAND, ALWAYS_FOLDER } from '../shared/sandbox-allow.ts';
import { ALWAYS_CHILDREN, ALWAYS_CHILDREN_LABEL, INHERIT_UNCONFIRMED } from '../shared/sandbox-inherit.ts';
import { sandboxAllowRoute } from './api.ts';
import { SANDBOX_ALLOW_KEY, SandboxAllowList } from './store.ts';
import type { FolderContext } from './validate.ts';

function machine() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-allow-store-')));
  const home = join(root, 'home');
  mkdirSync(join(home, '.gnupg'), { recursive: true });
  const context: FolderContext = { home, dataDir: join(root, 'data'), projectFolders: [], worktrees: [] };
  return { home, context: async () => context };
}

const card = (offer: InputCard['sandboxOffer']): InputCard => ({ id: 'b1', kind: 'approval', title: 'Run git commit (outside the sandbox)', detail: '', tool: 'Bash', options: [], ...(offer ? { sandboxOffer: offer } : {}) });

describe.each([
  ['sqlite', () => sqlitePersistence(':memory:')],
  ['memory', () => memoryPersistence()],
])('the always-allowed list on %s', (_name, makeDb) => {
  it('is kept across a restart, and a removed entry stays removed', async () => {
    const db = makeDb();
    const m = machine();
    const list = new SandboxAllowList({ settings: db, context: m.context });
    await list.addCommand('git commit');
    await list.addFolder('~/.gnupg', 'read-write');
    const again = new SandboxAllowList({ settings: db, context: m.context });
    expect(await again.entries()).toEqual([
      { kind: 'command', words: ['git', 'commit'] },
      { kind: 'folder', path: join(m.home, '.gnupg'), access: 'read-write' },
    ]);
    await again.remove('command:git commit');
    expect(await new SandboxAllowList({ settings: db }).entries()).toEqual([{ kind: 'folder', path: join(m.home, '.gnupg'), access: 'read-write' }]);
  });

  it('keeps the switch for sessions started by another session across a restart, off by default, and the list with it (issue 74)', async () => {
    const db = makeDb();
    const list = new SandboxAllowList({ settings: db });
    expect((await list.view()).inherit).toBe(false);
    expect(list.inherits()).toBe(false);
    await list.addCommand('gpg');
    await list.setInherit(true);
    const again = new SandboxAllowList({ settings: db });
    expect(await again.view()).toEqual({ entries: [{ kind: 'command', words: ['gpg'] }], inherit: true });
    expect(again.inherits()).toBe(true);
    // An add or a removal leaves it as it is.
    await again.remove('command:gpg');
    expect((await new SandboxAllowList({ settings: db }).view()).inherit).toBe(true);
    await again.setInherit(false);
    expect((await new SandboxAllowList({ settings: db }).view()).inherit).toBe(false);
  });

  it('drops what it cannot read', async () => {
    const db = makeDb();
    await db.putSetting(SANDBOX_ALLOW_KEY, JSON.stringify({ entries: [{ kind: 'command', words: ['gpg'] }, { kind: 'regex', pattern: '.*' }, { kind: 'folder', path: '/x', access: 'all' }] }));
    expect(await new SandboxAllowList({ settings: db }).entries()).toEqual([{ kind: 'command', words: ['gpg'] }]);
    await db.putSetting(SANDBOX_ALLOW_KEY, 'not json');
    expect(await new SandboxAllowList({ settings: db }).entries()).toEqual([]);
  });

  it('never honours an entry stored before the rules refused it: it shows as not applied, with the reason, until removed', async () => {
    const db = makeDb();
    const stale = [{ kind: 'command', words: ['rtk', 'git'] }, { kind: 'command', words: ['rtk', 'proxy'] }, { kind: 'command', words: ['git', 'commit'] }, { kind: 'command', words: ['git'] }];
    await db.putSetting(SANDBOX_ALLOW_KEY, JSON.stringify({ entries: stale }));
    const list = new SandboxAllowList({ settings: db });
    expect(await list.entries()).toEqual([{ kind: 'command', words: ['git', 'commit'] }]);
    expect(list.current()).toEqual([{ kind: 'command', words: ['git', 'commit'] }]);
    const view = await list.view();
    expect(view.inactive?.map((i) => [i.entry, i.reason])).toEqual([
      [{ kind: 'command', words: ['rtk', 'git'] }, expect.stringMatching(/Add the command it wraps instead/)],
      [{ kind: 'command', words: ['rtk', 'proxy'] }, expect.stringMatching(/Add the command it wraps instead/)],
      [{ kind: 'command', words: ['git'] }, expect.stringMatching(/Name the git subcommand/)],
    ]);
    // An add keeps them shown, a removal takes one away.
    await list.addCommand('gpg');
    expect((await list.remove('command:rtk git')).inactive).toHaveLength(2);
    expect(JSON.parse((await db.getSetting(SANDBOX_ALLOW_KEY))!).entries).toEqual([{ kind: 'command', words: ['rtk', 'proxy'] }, { kind: 'command', words: ['git', 'commit'] }, { kind: 'command', words: ['git'] }, { kind: 'command', words: ['gpg'] }]);
  });
});

describe('the list', () => {
  it('holds one entry per command or folder; a folder added again takes the new access', async () => {
    const m = machine();
    const list = new SandboxAllowList({ context: m.context });
    await list.addCommand('gpg');
    await list.addCommand('gpg');
    await list.addFolder('~/.gnupg', 'read');
    expect(await list.addFolder('~/.gnupg', 'read-write')).toEqual({ entries: [{ kind: 'command', words: ['gpg'] }, { kind: 'folder', path: join(m.home, '.gnupg'), access: 'read-write' }], inherit: false });
    expect(list.current()).toHaveLength(2);
    await expect(list.remove('command:nope')).rejects.toThrow(/not on the always-allowed list/);
  });
});

describe('an "Always allow" choice on the sandbox card', () => {
  it('adds the card’s own command and allows the request', async () => {
    const list = new SandboxAllowList({ context: machine().context });
    const forwarded = await list.answerCard(card({ command: ['git', 'commit'] }), { optionId: ALWAYS_COMMAND });
    expect(forwarded).toEqual({ optionId: 'allow' });
    expect(await list.entries()).toEqual([{ kind: 'command', words: ['git', 'commit'] }]);
  });

  it('adds the card’s own folder, checked again, and allows the request', async () => {
    const m = machine();
    const list = new SandboxAllowList({ context: m.context });
    expect(await list.answerCard(card({ folder: { path: join(m.home, '.gnupg'), access: 'read-write' } }), { optionId: ALWAYS_FOLDER })).toEqual({ optionId: 'allow' });
    expect(await list.entries()).toEqual([{ kind: 'folder', path: join(m.home, '.gnupg'), access: 'read-write' }]);
    // A folder that has since become off limits (it is now a registered project, say) is refused.
    const now = { ...(await m.context()), projectFolders: [join(m.home, '.gnupg')] };
    await expect(new SandboxAllowList({ context: async () => now }).answerCard(card({ folder: { path: join(m.home, '.gnupg'), access: 'read' } }), { optionId: ALWAYS_FOLDER })).rejects.toThrow(/registered project/);
  });

  it('cannot add a wrapper, even if a card were to offer one', async () => {
    const list = new SandboxAllowList({ context: machine().context });
    await expect(list.answerCard(card({ command: ['rtk', 'git'] }), { optionId: ALWAYS_COMMAND })).rejects.toThrow(/Add the command it wraps instead/);
    expect(await list.entries()).toEqual([]);
  });

  it('is refused on a card that offers nothing, and other choices pass through untouched', async () => {
    const list = new SandboxAllowList({ context: machine().context });
    await expect(list.answerCard(card(undefined), { optionId: ALWAYS_COMMAND })).rejects.toThrow(/does not offer/);
    await expect(list.answerCard(card({ command: ['gpg'] }), { optionId: ALWAYS_FOLDER })).rejects.toThrow(/does not offer/);
    expect(await list.answerCard(card({ command: ['gpg'] }), { optionId: 'deny', text: 'no' })).toEqual({ optionId: 'deny', text: 'no' });
    expect(await list.entries()).toEqual([]);
  });
});

describe('"Always allow for sessions started by another session" on the sandbox card (issue 74)', () => {
  const offering = (): InputCard => ({ ...card(undefined), options: [{ id: 'allow', label: 'Allow', role: 'allow' }, { id: ALWAYS_CHILDREN, label: ALWAYS_CHILDREN_LABEL, role: 'allow' }, { id: 'deny', label: 'Deny', role: 'deny' }] });

  it('turns the switch on and allows the request, once the person confirmed it where they answered', async () => {
    const list = new SandboxAllowList({ context: machine().context });
    expect(await list.answerCard(offering(), { optionId: ALWAYS_CHILDREN, confirmed: true })).toEqual({ optionId: 'allow', confirmed: true });
    expect(list.inherits()).toBe(true);
    expect(await list.entries()).toEqual([]);
  });

  it('is refused without the confirmation (a phone that did not ask), with the reason, and the switch stays off', async () => {
    const list = new SandboxAllowList({ context: machine().context });
    await expect(list.answerCard(offering(), { optionId: ALWAYS_CHILDREN })).rejects.toThrow(INHERIT_UNCONFIRMED);
    await expect(list.answerCard(offering(), { optionId: ALWAYS_CHILDREN, confirmed: false })).rejects.toThrow(/needs your confirmation/);
    expect(list.inherits()).toBe(false);
    // The card's other choices need none.
    expect(await list.answerCard(offering(), { optionId: 'allow' })).toEqual({ optionId: 'allow' });
  });

  it('is refused on a card that did not offer it, and nothing changes', async () => {
    const list = new SandboxAllowList({ context: machine().context });
    await expect(list.answerCard(card({ command: ['gpg'] }), { optionId: ALWAYS_CHILDREN })).rejects.toThrow(/does not offer to allow commands outside the sandbox for sessions started by another session/);
    await expect(list.answerCard(undefined, { optionId: ALWAYS_CHILDREN })).rejects.toThrow(/does not offer/);
    expect(list.inherits()).toBe(false);
  });
});

describe('the HTTP route', () => {
  it('lists, adds, refuses with a reason, and removes', async () => {
    const m = machine();
    const list = new SandboxAllowList({ context: m.context });
    const route = (method: string, body: Record<string, unknown> = {}) => sandboxAllowRoute(['api', 'sandbox-allow'], method, async () => body, list);
    expect(await route('GET')).toEqual({ status: 200, body: { entries: [], inherit: false } });
    expect(await route('POST', { kind: 'command', command: 'git commit' })).toEqual({ status: 200, body: { entries: [{ kind: 'command', words: ['git', 'commit'] }], inherit: false } });
    expect(await route('POST', { kind: 'folder', path: '~', access: 'read' })).toEqual({ status: 400, body: { error: expect.stringMatching(/home folder/) } });
    expect(await route('POST', { kind: 'command', command: 'sh' })).toEqual({ status: 400, body: { error: expect.stringMatching(/runs other programs/) } });
    for (const wrapper of ['rtk git', 'rtk proxy', 'rtk', 'rtk git commit']) expect(await route('POST', { kind: 'command', command: wrapper })).toEqual({ status: 400, body: { error: expect.stringMatching(/Add the command it wraps instead/) } });
    expect(await route('POST', { kind: 'glob', pattern: '*' })).toEqual({ status: 400, body: { error: expect.stringMatching(/kind must be/) } });
    expect(await route('POST', { kind: 'command', command: 3 })).toEqual({ status: 400, body: { error: expect.stringMatching(/must be text/) } });
    expect(await route('DELETE', {})).toEqual({ status: 400, body: { error: expect.stringMatching(/id must/) } });
    expect(await route('DELETE', { id: 'command:git commit' })).toEqual({ status: 200, body: { entries: [], inherit: false } });
    // The switch for sessions started by another session (issue 74): saved as it is changed.
    expect(await route('PATCH', { inherit: true })).toEqual({ status: 200, body: { entries: [], inherit: true } });
    expect(list.inherits()).toBe(true);
    expect(await route('PATCH', { inherit: 'yes' })).toEqual({ status: 400, body: { error: 'inherit must be true or false.' } });
    expect(await route('PATCH', { inherit: false })).toEqual({ status: 200, body: { entries: [], inherit: false } });
    expect(await route('PUT')).toBeNull();
    expect(await sandboxAllowRoute(['api', 'sandbox-allow', 'x'], 'GET', async () => ({}), list)).toBeNull();
  });
});
