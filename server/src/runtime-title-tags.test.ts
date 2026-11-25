// The title call also proposes tags: the candidates go through the same path as the suggest tool,
// and a reply with a missing or broken tags part still titles the session.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TitleProvider } from './agents/title-providers.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { Titler } from './runtime/titling.ts';
import { openSuggestions } from './shared/suggestions.ts';
import { FakeAgents } from './test-agent.ts';
import { Workspace } from './workspace.ts';

const PROMPT = 'Please look into why the upload page hangs\nIt is tracked as PROJ-482 in Jira.';
const provider = (reply: string): TitleProvider => ({ name: 'test', agent: 'claude', title: async () => reply });

async function titled(reply: string) {
  const workspace = new Workspace(memoryPersistence());
  const session = await workspace.addSession({ title: 'provisional', agent: 'claude', startedIn: null });
  const candidates: Record<string, unknown>[][] = [];
  const titler = new Titler(workspace, [provider(reply)], async () => undefined, () => undefined, async (_id, tags) => void candidates.push([...tags]));
  titler.begin({ sessionId: session.id, provisional: 'provisional', prompt: PROMPT, agent: 'claude' });
  await titler.settled();
  const title = (await workspace.state()).sessions.find((s) => s.id === session.id)!.title;
  return { title, candidates };
}

describe('the title call proposes tags', () => {
  it('a title-only reply titles the session and proposes nothing', async () => {
    expect(await titled('Debug upload page hang')).toEqual({ title: 'Debug upload page hang', candidates: [] });
  });

  it('a title with tag lines titles the session and hands the candidates on', async () => {
    const { title, candidates } = await titled('Debug upload page hang\ntag: PROJ-482 | ticket | Jira');
    expect(title).toBe('Debug upload page hang');
    expect(candidates).toEqual([[{ tag: 'PROJ-482', category: 'ticket', source: 'Jira', reason: 'Named in your first message' }]]);
  });

  it('the provider is given the tags in use, the most used first', async () => {
    const workspace = new Workspace(memoryPersistence());
    const [a, b, session] = await Promise.all(['a', 'b', 'provisional'].map((title) => workspace.addSession({ title, agent: 'claude', startedIn: null })));
    await workspace.tagSession(a!.id, 'Billing');
    await workspace.tagSession(a!.id, 'Argus');
    await workspace.tagSession(b!.id, 'Argus');
    const given: (readonly string[] | undefined)[] = [];
    const asked: TitleProvider = { name: 'test', agent: 'claude', title: async (_prompt, tags) => (given.push(tags), 'Debug upload page hang') };
    const titler = new Titler(workspace, [asked], async () => undefined, () => undefined);
    titler.begin({ sessionId: session!.id, provisional: 'provisional', prompt: PROMPT, agent: 'claude' });
    await titler.settled();
    expect(given).toEqual([['Argus', 'Billing']]);
  });

  it('a malformed tags part is ignored and never breaks the title', async () => {
    expect(await titled('Debug upload page hang\ntag: PROJ-482 | someday')).toEqual({ title: 'Debug upload page hang', candidates: [] });
  });

  it('candidates become a card through the same grounding; an invented one does not', async () => {
    const workspace = new Workspace(memoryPersistence());
    const agents = new FakeAgents();
    const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-title-tags-')));
    const reply = 'Debug upload page hang\ntag: PROJ-482 | ticket | Jira\ntag: PROJ-999 | ticket | Jira';
    const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, data, { titleProviders: [provider(reply)] });
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt: PROMPT });
    await agents.settled();
    await runtime.titler.settled();
    await runtime.idle(session.id);
    const open = openSuggestions(runtime.recordOf(session.id)!.messages);
    expect(open.map((s) => s.payload.tag)).toEqual(['PROJ-482']);
    expect(open[0]!.reason).toBe('Named in your first message');
  });
});
