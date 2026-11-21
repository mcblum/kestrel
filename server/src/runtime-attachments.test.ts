// Files attached to messages, through the runtime: a first message of files alone, a reply, a
// queued message, and the conversation stored and read back on both persistence backends. The
// scripted agent (test-agent.ts) records what each turn got; nothing here depends on timing.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Persistence } from './persistence/types.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { sqlitePersistence } from './persistence/sqlite.ts';
import { SessionRuntime } from './runtime.ts';
import { FakeAgents } from './test-agent.ts';
import { Workspace } from './workspace.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function setup(db: Persistence = memoryPersistence(), data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-att-rt-')))) {
  const workspace = new Workspace(db);
  const agents = new FakeAgents();
  const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, data);
  /** Upload files to a fresh draft, as the composer does, and name them for a message. */
  const draft = (draftId: string, files: { name: string; bytes: Buffer }[]) => ({ draftId, ids: files.map((f) => runtime.attachments.saveDraft(draftId, { name: f.name }, f.bytes).id) });
  return { db, data, workspace, agents, runtime, draft };
}

describe('attachments on messages', () => {
  it('starts a session from files alone, titled by the first file, and the agent gets them stored', async () => {
    const { runtime, agents, draft, workspace } = setup();
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: '', draft: draft('d1', [{ name: 'screen.png', bytes: PNG }, { name: 'notes.txt', bytes: Buffer.from('n') }]) });
    await agents.settled();
    expect(session.title).toBe('screen.png, notes.txt');
    const turn = agents.turns[0]!;
    expect(turn.text).toBe('');
    expect(turn.attachments.map((a) => [a.name, a.kind])).toEqual([['screen.png', 'image'], ['notes.txt', 'file']]);
    expect(turn.attachments[0]!.file.startsWith(runtime.attachments.sessionDir(session.id))).toBe(true);
    const first = runtime.overlay(session.id)!.messages[0]!;
    expect(first).toMatchObject({ author: 'you', text: '' });
    expect(first.attachments!.map((a) => a.name)).toEqual(['screen.png', 'notes.txt']);
    await runtime.idle(session.id);
    expect((await workspace.storedDetail(session.id))!.messages[0]!.attachments).toHaveLength(2);
  });

  it('refuses a message with neither text nor files', async () => {
    const { runtime } = setup();
    await expect(runtime.start({ agent: 'claude', projectId: null, prompt: ' ' })).rejects.toThrow(/Describe the task/);
  });

  it('sends a reply’s files with it, and a queued message’s files when the queue goes', async () => {
    const { runtime, agents, draft } = setup();
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'begin' });
    await agents.settled();
    await runtime.idle(session.id);
    agents.hold = true;
    await runtime.reply(session.id, 'look', {}, { draft: draft('d2', [{ name: 'a.png', bytes: PNG }]) });
    await agents.settled();
    expect(agents.turns[1]!.attachments.map((a) => a.name)).toEqual(['a.png']);
    // While it works, a message with a file waits in the queue, file and all.
    await expect(runtime.reply(session.id, '', {}, { draft: draft('d3', [{ name: 'log.txt', bytes: Buffer.from('log') }]) })).resolves.toBe('queued');
    const queued = runtime.overlay(session.id)!.queue!.items;
    expect(queued).toHaveLength(1);
    expect(queued[0]!.attachments!.map((a) => a.name)).toEqual(['log.txt']);
    agents.hold = false;
    agents.turns.at(-1)!.done();
    await runtime.idle(session.id);
    await agents.settled();
    expect(agents.turns[2]!.attachments.map((a) => a.name)).toEqual(['log.txt']);
    expect(runtime.overlay(session.id)!.messages.filter((m) => m.author === 'you').at(-1)!.attachments![0]!.name).toBe('log.txt');
  });

  it('refuses a reply naming a file that is no longer there', async () => {
    const { runtime, agents } = setup();
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'begin' });
    await agents.settled();
    await runtime.idle(session.id);
    await expect(runtime.reply(session.id, 'x', {}, { draft: { draftId: 'd9', ids: ['gone-id'] } })).rejects.toThrow(/no longer there/);
  });

  it('removes a session’s files with the session', async () => {
    const { runtime, agents, draft } = setup();
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'x', draft: draft('d1', [{ name: 'a.txt', bytes: Buffer.from('a') }]) });
    await agents.settled();
    await runtime.idle(session.id);
    const id = runtime.overlay(session.id)!.messages[0]!.attachments![0]!.id;
    expect(runtime.attachments.file(session.id, id)).not.toBeNull();
    await runtime.deleteSession(session.id);
    expect(runtime.attachments.file(session.id, id)).toBeNull();
  });
});

describe('stored and read back after a restart', () => {
  const backends: [string, () => Persistence][] = [
    ['memory', () => memoryPersistence()],
    ['sqlite', () => sqlitePersistence(join(realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-att-db-'))), 'k.sqlite'))],
  ];
  for (const [name, make] of backends) {
    it(`keeps a message’s attachments and a queued one’s (${name})`, async () => {
      const db = make();
      const first = setup(db);
      const session = await first.runtime.start({ agent: 'claude', projectId: null, prompt: 'see', draft: first.draft('d1', [{ name: 'a.png', bytes: PNG }]) });
      await first.agents.settled();
      await first.runtime.idle(session.id);
      first.agents.hold = true;
      await first.runtime.reply(session.id, 'next');
      await first.agents.settled();
      await first.runtime.reply(session.id, 'later', {}, { draft: first.draft('d2', [{ name: 'q.txt', bytes: Buffer.from('q') }]) });
      await first.runtime.shutdown();

      const again = setup(db, first.data);
      const detail = (await again.workspace.detail(session.id))!;
      expect(detail.messages[0]!.attachments!.map((a) => a.name)).toEqual(['a.png']);
      expect(detail.queue!.items[0]!.attachments!.map((a) => a.name)).toEqual(['q.txt']);
      expect(again.runtime.attachments.file(session.id, detail.messages[0]!.attachments![0]!.id)).not.toBeNull();
      // Older messages without attachments still read as before.
      expect(detail.messages[1]!.attachments).toBeUndefined();
    });
  }
});
