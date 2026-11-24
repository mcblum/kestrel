// archive_session (delegation.ts `archiveSession`, shared/session-archive.ts): an agent archives a
// Kestrel session. Its own sessions without asking (itself when its turn ends, those it started, those
// of a workstream it leads), any other on the user's yes; through the user's one archive, with its
// refusals; a line with Undo. Through a real runtime with a scripted agent, and over the MCP endpoint
// Codex and OpenCode call, which serves the same tool definitions Claude is handed in-process.
import { mkdtempSync, realpathSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mcpSessionOf, mcpUrl, serveSessionMcp } from './kestrel-mcp.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { sessionToken } from './security.ts';
import { ALREADY_ARCHIVED, ARCHIVE_SESSION_KIND, archivedElsewhere, archiveScope } from './shared/session-archive.ts';
import { suggestionsIn } from './shared/suggestions.ts';
import { FakeAgents, until, type Turn } from './test-agent.ts';
import { makeRepo } from './test-repo.ts';
import { GIT_TEST_TIMEOUT_MS } from './test-timeouts.ts';
import { Workspace } from './workspace.ts';

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

const SPLIT = 'split the work';
type Result = { text: string; isError?: boolean };

async function world() {
  const workspace = new Workspace(memoryPersistence());
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-archive-tool-')));
  const agents = new FakeAgents();
  const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, data);
  const a = await runtime.registerProject(makeRepo(), 'repoA');
  await runtime.registerProject(makeRepo(), 'repoB');
  const results: Result[] = [];
  /** A child's turn waits on this while held, so it is still working. */
  const gate = { held: false, wait: Promise.resolve(), release: () => undefined as void };
  agents.script = async (turn: Turn) => {
    if (turn.text === SPLIT) await turn.options.tools.delegate({ tasks: [{ project: 'repoB', brief: 'Change B' }], name: 'Invoices' });
    else if (turn.text.startsWith('archive ')) {
      const [, session, ...reason] = turn.text.split(' ');
      results.push(await turn.options.tools.archiveSession({ ...(session === 'me' ? {} : { session }), reason: reason.join(' ') }));
    } else if (turn.text.startsWith('Change B') && gate.held) await gate.wait;
  };
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await agents.settled();
      for (const s of (await workspace.state()).sessions) await runtime.idle(s.id);
    }
  };
  const hold = () => {
    gate.held = true;
    gate.wait = new Promise<void>((resolve) => (gate.release = resolve));
  };
  /** A lead in repoA (Auto, so no card for delegate) that delegated one task to repoB. */
  const lead = await runtime.start({ agent: 'claude', projectId: a.id, prompt: SPLIT, permission: 'auto' });
  const childOf = async () => (await workspace.state()).links.find((l) => l.parentId === lead.id)!.childId;
  const archived = async (id: string) => (await workspace.state()).archived.sessions.some((s) => s.id === id);
  const lines = (id: string) => suggestionsIn(runtime.recordOf(id)?.messages ?? []).filter((s) => s.kind === ARCHIVE_SESSION_KIND);
  /** The approval card an agent's call is waiting on. */
  const card = (id: string) => runtime.overlay(id)?.messages.map((m) => m.input).find((i) => i && !i.resolved && runtime.recordOf(id)?.kestrelRequests.has(i.id));
  /** The agent of `id` calls archive_session in a turn of its own. */
  const ask = async (id: string, session: string, reason = 'done with it') => {
    const before = results.length;
    await runtime.reply(id, `archive ${session} ${reason}`);
    return before;
  };
  return { workspace, runtime, agents, a, results, settle, hold, gate, lead, childOf, archived, lines, card, ask };
}

describe('archive_session', () => {
  it('archives the session itself when its turn ends, leaving a line whose Undo brings it back', async () => {
    const w = await world();
    await w.settle();
    await w.ask(w.lead.id, 'me', 'the work is merged');
    await w.settle();
    expect(w.results.at(-1)!.text).toMatch(/^This session is archived as soon as this turn ends/);
    expect(await w.archived(w.lead.id)).toBe(true);
    const [line] = w.lines(w.lead.id);
    expect(line).toMatchObject({ state: 'answered', line: 'Archived this session: the work is merged', undo: { sessionId: w.lead.id } });
    await w.runtime.suggestions.undo(w.lead.id, line!.id);
    expect(await w.archived(w.lead.id)).toBe(false);
  });

  it('a read-only session with no project may archive itself too', async () => {
    const w = await world();
    await w.settle();
    const loose = await w.runtime.start({ agent: 'claude', projectId: null, prompt: 'Just a question' });
    await w.settle();
    expect((await w.workspace.state()).sessions.find((s) => s.id === loose.id)?.startedIn ?? null).toBeNull();
    await w.ask(loose.id, 'me', 'answered');
    await w.settle();
    expect(await w.archived(loose.id)).toBe(true);
  });

  it('archives a session it started at once, without a card, the line in the caller’s conversation', async () => {
    const w = await world();
    await w.settle();
    const child = await w.childOf();
    await w.ask(w.lead.id, child);
    await w.settle();
    expect(w.results.at(-1)).toEqual({ text: expect.stringMatching(/^Archived “.+” \(.+\)\. The user can undo it/) });
    expect(await w.archived(child)).toBe(true);
    const [line] = w.lines(w.lead.id);
    expect(line!.line).toMatch(/^Archived “.+”: done with it$/);
    await w.runtime.suggestions.undo(w.lead.id, line!.id);
    expect(await w.archived(child)).toBe(false);
  });

  it('asks the user before archiving any other session: a yes archives it, a no leaves it', async () => {
    const w = await world();
    await w.settle();
    const other = await w.runtime.start({ agent: 'claude', projectId: w.a.id, prompt: 'Unrelated' });
    await w.settle();

    await w.ask(w.lead.id, other.id, 'a duplicate of this one');
    await until(() => w.card(w.lead.id) !== undefined, 'the card');
    expect(w.card(w.lead.id)).toMatchObject({ title: 'Archive “Unrelated”?', detail: expect.stringContaining('a duplicate of this one') });
    expect(await w.archived(other.id)).toBe(false);
    await w.runtime.answer(w.lead.id, w.card(w.lead.id)!.id, { optionId: 'deny' });
    await w.settle();
    expect(w.results.at(-1)!.text).toBe('The user chose not to archive that session. Leave it as it is.');
    expect(await w.archived(other.id)).toBe(false);

    await w.ask(w.lead.id, other.id);
    await until(() => w.card(w.lead.id) !== undefined, 'the second card');
    await w.runtime.answer(w.lead.id, w.card(w.lead.id)!.id, { optionId: 'allow' });
    await w.settle();
    expect(await w.archived(other.id)).toBe(true);
    expect(w.lines(w.lead.id).at(-1)).toMatchObject({ undo: { sessionId: other.id } });
  });

  it('is refused in the archive’s own words for a session still working, and says it stops nothing; already archived and unknown sessions are refused too', async () => {
    const w = await world();
    w.hold();
    await until(async () => (await w.workspace.state()).links.length > 0, 'the delegate');
    await w.runtime.idle(w.lead.id);
    const child = await w.childOf();
    await w.ask(w.lead.id, child);
    await until(() => w.results.length > 0, 'the answer');
    expect(w.results.at(-1)).toMatchObject({ isError: true, text: expect.stringMatching(/is still working\. Stop it before archiving\. archive_session never stops, deletes or restores a session/) });
    expect(await w.archived(child)).toBe(false);
    w.gate.release();
    await w.settle();

    await w.ask(w.lead.id, child);
    await w.settle();
    await w.ask(w.lead.id, child);
    await w.settle();
    expect(w.results.at(-1)).toMatchObject({ isError: true, text: ALREADY_ARCHIVED });
    await w.ask(w.lead.id, 'no-such-session');
    await w.settle();
    expect(w.results.at(-1)).toMatchObject({ isError: true, text: expect.stringMatching(/^No such session: no-such-session/) });
  });
});

describe('whose sessions an agent archives without asking (archiveScope)', () => {
  const links = [
    { parentId: 'lead', childId: 'kid', kind: 'delegate' as const },
    { parentId: 'lead', childId: 'took-over', kind: 'handoff' as const },
    { parentId: 'lead', childId: 'copy', kind: 'fork' as const },
  ];
  const workstreams = [{ sessionIds: ['lead', 'kid', 'joined'] }];
  it('itself, its delegates and handoffs, and its workstream’s sessions; anything else is asked for', () => {
    expect(archiveScope('lead', 'lead', links, workstreams)).toBe('self');
    expect(archiveScope('lead', 'kid', links, workstreams)).toBe('started');
    expect(archiveScope('lead', 'took-over', links, workstreams)).toBe('started');
    expect(archiveScope('lead', 'joined', links, workstreams)).toBe('workstream');
    expect(archiveScope('lead', 'copy', links, workstreams)).toBe('ask');
    expect(archiveScope('lead', 'stranger', links, workstreams)).toBe('ask');
    // Not upward, and only the lead speaks for a workstream.
    expect(archiveScope('kid', 'lead', links, workstreams)).toBe('ask');
    expect(archiveScope('kid', 'joined', links, workstreams)).toBe('ask');
  });
});

describe('the window’s toast for an archive it did not make (archivedElsewhere)', () => {
  const s = (id: string) => ({ id, title: id }) as never;
  const ws = (sessions: string[], archived: string[], projects = 0) => ({ sessions: sessions.map(s), archived: { sessions: archived.map(s), projects: Array(projects).fill({}), groups: [] } });
  it('names a session that was in sight and is now archived, unless this window archived it or its project went with it', () => {
    expect(archivedElsewhere(ws(['a', 'b'], []), ws(['b'], ['a']), new Set())).toEqual([s('a')]);
    expect(archivedElsewhere(ws(['a', 'b'], []), ws(['b'], ['a']), new Set(['a']))).toEqual([]);
    expect(archivedElsewhere(ws(['a', 'b'], []), ws([], ['a', 'b'], 1), new Set())).toEqual([]);
    expect(archivedElsewhere(null, ws([], ['a']), new Set())).toEqual([]);
  });
});

// ---- every provider: the shared tool server ------------------------------------------------------

const LAUNCH = 'launch-token-for-tests';
let server: Server | null = null;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

describe('archive_session over the MCP endpoint (Codex and OpenCode; Claude gets the same server in-process)', () => {
  it('is listed, and archives a session the caller started', async () => {
    const w = await world();
    await w.settle();
    const child = await w.childOf();
    server = createServer((req, res) => {
      const id = mcpSessionOf(req.url);
      if (!id) return void res.writeHead(404).end();
      void serveSessionMcp(req, res, id, { token: LAUNCH, allowedOrigins: [], port: (server!.address() as AddressInfo).port }, w.runtime);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const call = async (body: unknown) =>
      (
        await fetch(mcpUrl(port, w.lead.id), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${sessionToken(LAUNCH, w.lead.id)}` },
          body: JSON.stringify(body),
        })
      ).json();
    const listed = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(listed.result.tools.map((t: { name: string }) => t.name)).toContain('archive_session');
    const ran = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'archive_session', arguments: { session: child, reason: 'merged' } } });
    expect(ran.result.content[0].text).toMatch(/^Archived “.+”/);
    expect(await w.archived(child)).toBe(true);
  });
});
