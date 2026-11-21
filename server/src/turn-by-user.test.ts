// A delegate's turn the user started by writing in it (matt/kestrel#14): the parent does not hear
// about it (`parentHears`), so the workstream page must not say the parent is waiting on it. The
// turn's origin is kept on the session (Session.turnByUser), set once as each turn starts.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentHandle } from './agents/types.ts';
import type { Link, Session } from './model.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { sqlitePersistence } from './persistence/sqlite.ts';
import { SessionRuntime } from './runtime.ts';
import { waitsIn } from './shared/waits.ts';
import { awaitedByParent, waitingOn } from './shared/workstreams.ts';
import { Workspace } from './workspace.ts';

type Member = Pick<Session, 'id' | 'title' | 'state' | 'turnByUser'>;
const lead: Member = { id: 'lead', title: 'Lead', state: 'done' };
const child = (over: Partial<Member> = {}): Member => ({ id: 'child', title: 'Child', state: 'running', ...over });
const links: Pick<Link, 'parentId' | 'childId' | 'kind'>[] = [{ parentId: 'lead', childId: 'child', kind: 'delegate' }];

describe('who a lead is waiting on', () => {
  it('counts a delegate at work on what it was given', () => {
    expect(waitingOn([lead, child()], links)).toEqual([{ sessionId: 'lead', title: 'Lead', count: 1 }]);
    expect(waitingOn([lead, child({ state: 'attention' })], links)).toHaveLength(1);
  });

  it('does not count a turn the user typed in the delegate, working or waiting on the user', () => {
    expect(waitingOn([lead, child({ turnByUser: true })], links)).toEqual([]);
    expect(waitingOn([lead, child({ state: 'attention', turnByUser: true })], links)).toEqual([]);
    expect(waitsIn({ id: 'w', sessionIds: ['lead', 'child'] }, [lead, child({ turnByUser: true })], links, [])).toEqual([]);
  });

  it('is the one rule: a finished delegate is never awaited', () => {
    expect(awaitedByParent({ state: 'done' })).toBe(false);
    expect(awaitedByParent({ state: 'running' })).toBe(true);
    expect(awaitedByParent({ state: 'running', turnByUser: true })).toBe(false);
  });
});

describe.each([
  ['sqlite', () => sqlitePersistence(':memory:')],
  ['memory', () => memoryPersistence()],
])('the turn origin on %s', (_name, makeDb) => {
  it('is set as a turn starts and left alone by other changes of state', async () => {
    const db = makeDb();
    const ws = new Workspace(db);
    await ws.addSession({ id: 's', title: 'S', agent: 'claude', startedIn: null });
    await ws.setState('s', 'running', 'Working…', { byUser: true });
    expect((await db.getSession('s'))!.turnByUser).toBe(true);
    await ws.setState('s', 'attention', 'Needs you');
    expect((await db.getSession('s'))!.turnByUser).toBe(true);
    await ws.setState('s', 'running', 'Working…', { byUser: false });
    expect((await db.getSession('s'))!.turnByUser).toBeFalsy();
  });
});

it('an older sqlite store gets the column, every turn counting as not the user’s', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'kestrel-turn-')), 'kestrel.db');
  await sqlitePersistence(path).close();
  const old = new DatabaseSync(path);
  old.exec('ALTER TABLE sessions DROP COLUMN turn_by_user');
  old.prepare('INSERT INTO sessions (id, title, agent, state, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('a', 'A', 'claude', 'running', 'Working…', 1, 2);
  old.close();
  const db = sqlitePersistence(path);
  expect((await db.getSession('a'))!.turnByUser).toBeUndefined();
  await db.close();
});

describe('through the runtime', () => {
  // An agent whose turns run until the test ends them.
  function agent() {
    const emits: ((e: AgentEvent) => void)[] = [];
    const handle = (emit: (e: AgentEvent) => void): AgentHandle => ({ agentSessionId: () => 'a-1', busy: () => false, send: () => void emits.push(emit), answer: () => undefined, stop: async () => undefined });
    const adapter: AgentAdapter = {
      agent: 'claude',
      models: async () => ({ models: [], fromSdk: true }),
      start: (_o, _p, emit) => {
        emit({ type: 'started', agentSessionId: 'a-1', model: 'fake', kestrelTools: 'connected' });
        emits.push(emit);
        return handle(emit);
      },
      resume: (_id, _o, emit) => handle(emit),
    };
    return { adapter, end: () => emits.at(-1)!({ type: 'done', reason: 'complete' }) };
  }

  it("marks the turn a user's message starts, and not the first turn it was given", async () => {
    const a = agent();
    const workspace = new Workspace(memoryPersistence());
    const runtime = new SessionRuntime(workspace, { claude: a.adapter }, realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-tbu-'))));
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'the work' });
    expect((await workspace.state()).sessions.find((s) => s.id === session.id)!.turnByUser).toBeFalsy();
    a.end();
    await runtime.idle(session.id);
    await runtime.reply(session.id, 'and also this');
    expect((await workspace.state()).sessions.find((s) => s.id === session.id)).toMatchObject({ state: 'running', turnByUser: true });
    a.end();
    await runtime.idle(session.id);
  });
});
