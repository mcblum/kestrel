// Optional actions end to end, through a real runtime with a scripted agent: the `suggest` tool,
// the card in the conversation, each button, Undo, the standing rules, restarts on both backends,
// and that a suggestion never touches the session's state.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolResult } from '../agents/types.ts';
import { memoryPersistence } from '../persistence/memory.ts';
import { sqlitePersistence } from '../persistence/sqlite.ts';
import type { Persistence } from '../persistence/types.ts';
import { SessionRuntime } from '../runtime.ts';
import { openSuggestions, shownSuggestion, suggestionsIn, type Suggestion } from '../shared/suggestions.ts';
import { rowDot } from '../shared/unread.ts';
import { FakeAgents } from '../test-agent.ts';
import { Workspace } from '../workspace.ts';
import { SHOWN_TEXT } from './service.ts';

const PROMPT = 'Fix the upload hang for PROJ-482';
const TAG = { kind: 'tag', tag: 'PROJ-482', category: 'ticket', source: 'Jira', reason: 'The task names PROJ-482.' };

function world(db: Persistence = memoryPersistence()) {
  const workspace = new Workspace(db);
  const agents = new FakeAgents();
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-suggest-')));
  const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, data, { suggestions: { settings: db, testKinds: true } });
  const results: ToolResult[] = [];
  /** Each turn makes these suggestions, in order. */
  let calls: Record<string, unknown>[] = [TAG];
  agents.script = async (turn) => {
    for (const args of calls) results.push(await turn.options.tools.suggest(args as never));
  };
  const start = async (prompt = PROMPT) => {
    const session = await runtime.start({ agent: 'claude', projectId: null, prompt });
    await agents.settled();
    await runtime.idle(session.id);
    return session.id;
  };
  const suggestions = (id: string): Suggestion[] => suggestionsIn(runtime.recordOf(id)?.messages ?? []);
  const row = async (id: string) => (await workspace.state()).sessions.find((s) => s.id === id)!;
  return { db, workspace, runtime, agents, results, start, suggestions, row, setCalls: (next: Record<string, unknown>[]) => (calls = next) };
}

describe('the suggest tool', () => {
  it('shows a card without pausing the turn, and tells the model so', async () => {
    const w = world();
    const id = await w.start();
    expect(w.results).toEqual([{ text: SHOWN_TEXT }]);
    const [card] = openSuggestions(w.runtime.recordOf(id)!.messages);
    expect(card).toMatchObject({ kind: 'tag', title: 'Tag this session PROJ-482?', reason: 'The task names PROJ-482.', state: 'open' });
    expect(card!.buttons.map((b) => b.label)).toEqual(['Tag', 'Always tag sessions with Jira tickets', 'Not right now', "Don't ask again"]);
    expect(w.agents.turns).toHaveLength(1); // the turn ended by itself: nothing waited on the card
  });

  it('never changes the session state: no attention, no yellow dot, no Needs you', async () => {
    const w = world();
    w.agents.hold = true;
    const session = await w.runtime.start({ agent: 'claude', projectId: null, prompt: PROMPT });
    await w.agents.settled();
    await w.runtime.idle(session.id);
    const during = await w.row(session.id);
    expect(during.state).toBe('running');
    expect(w.suggestions(session.id)).toHaveLength(1);
    w.agents.turns[0]!.done();
    await w.runtime.idle(session.id);
    const after = await w.row(session.id);
    expect(after.state).toBe('done');
    expect(rowDot(after.state, after.updatedAt, after.updatedAt)).toBe('none');
    await w.runtime.suggestions.answer(session.id, w.suggestions(session.id)[0]!.id, 'tag');
    const answered = await w.row(session.id);
    expect(answered.state).toBe('done');
    expect(answered.updatedAt).toBe(after.updatedAt); // answering does not make it unread either
  });

  it('refuses an unknown kind and a tag nobody named', async () => {
    const w = world();
    w.setCalls([{ kind: 'reminder', text: 'x' }, { ...TAG, tag: 'PROJ-999' }]);
    const id = await w.start();
    expect(w.results[0]).toMatchObject({ isError: true, text: expect.stringContaining('Unknown suggestion kind "reminder"') });
    expect(w.results[1]).toMatchObject({ isError: true, text: expect.stringContaining('not a tag in this workspace') });
    expect(w.suggestions(id)).toEqual([]);
  });

  it('a second kind needs only a registry entry: the note kind works end to end', async () => {
    const w = world();
    w.setCalls([{ kind: 'note', text: 'Heads up' }, TAG]);
    const id = await w.start();
    expect(w.results.map((r) => r.text)).toEqual([SHOWN_TEXT, SHOWN_TEXT]);
    expect(shownSuggestion(w.runtime.recordOf(id)!.messages)).toMatchObject({ suggestion: { kind: 'note' }, waiting: 1 });
    const note = w.suggestions(id)[0]!;
    const done = await w.runtime.suggestions.answer(id, note.id, 'ok');
    expect(done).toMatchObject({ state: 'answered', line: 'Noted: Heads up' });
    expect(shownSuggestion(w.runtime.recordOf(id)!.messages)?.suggestion.kind).toBe('tag');
  });
});

describe('answering a tag suggestion', () => {
  it('Tag adds the tag, leaves a line, and Undo takes it off', async () => {
    const w = world();
    const id = await w.start();
    const s = w.suggestions(id)[0]!;
    const answered = await w.runtime.suggestions.answer(id, s.id, 'tag');
    expect(answered).toMatchObject({ state: 'answered', answer: 'tag', line: 'Tagged PROJ-482', undo: { removeTag: true } });
    expect((await w.row(id)).tags).toEqual(['PROJ-482']);
    const undone = await w.runtime.suggestions.undo(id, s.id);
    expect(undone.line).toBe('Untagged PROJ-482');
    expect(undone.undo).toBeUndefined();
    expect((await w.row(id)).tags).toEqual([]);
    await expect(w.runtime.suggestions.answer(id, s.id, 'tag')).rejects.toThrow('already been answered');
  });

  it('Always tags and sets the rule; the next session with another id is tagged with no card', async () => {
    const w = world();
    const first = await w.start();
    await w.runtime.suggestions.answer(first, w.suggestions(first)[0]!.id, 'always');
    expect(await w.runtime.suggestions.prefs.tags()).toMatchObject({ rules: { 'ticket:jira': { value: 'always', source: 'Jira' } } });
    w.setCalls([{ ...TAG, tag: 'PROJ-500', reason: '' }]);
    const second = await w.start('Look at PROJ-500 next');
    expect(w.results.at(-1)!.text).toContain('Done without asking');
    expect(openSuggestions(w.runtime.recordOf(second)!.messages)).toEqual([]);
    expect(w.suggestions(second)[0]).toMatchObject({ state: 'answered', auto: true, line: 'Tagged PROJ-500' });
    expect((await w.row(second)).tags).toEqual(['PROJ-500']);
  });

  it('Not right now dismisses it and the same tag is never suggested again in that session', async () => {
    const w = world();
    const id = await w.start();
    const s = w.suggestions(id)[0]!;
    expect(await w.runtime.suggestions.answer(id, s.id, 'not-now')).toMatchObject({ state: 'dismissed', line: 'Tag suggestion dismissed' });
    await w.runtime.reply(id, 'and again PROJ-482');
    await w.agents.settled();
    expect(w.results.at(-1)!.text).toContain('already suggested');
    expect(w.suggestions(id)).toHaveLength(1);
  });

  it("the x is the kind's Not right now", async () => {
    const w = world();
    const id = await w.start();
    expect(await w.runtime.suggestions.dismiss(id, w.suggestions(id)[0]!.id)).toMatchObject({ state: 'dismissed', answer: 'not-now' });
  });

  it("Don't ask again sets the rule to never; the model is told, and Undo restores Ask", async () => {
    const w = world();
    const id = await w.start();
    const s = w.suggestions(id)[0]!;
    await w.runtime.suggestions.answer(id, s.id, 'never');
    w.setCalls([{ ...TAG, tag: 'PROJ-7' }]);
    await w.start('Now PROJ-7 please');
    expect(w.results.at(-1)!.text).toContain('turned off suggestions for jira tickets');
    await w.runtime.suggestions.undo(id, s.id);
    expect((await w.runtime.suggestions.prefs.tags()).rules).toEqual({});
  });

  it('switched off: the tool refuses', async () => {
    const w = world();
    await w.runtime.suggestions.prefs.setTagsEnabled(false);
    await w.start();
    expect(w.results[0]).toMatchObject({ isError: true });
  });
});

describe('across a restart', () => {
  const backends: [string, () => Persistence][] = [
    ['memory', () => memoryPersistence()],
    ['sqlite', () => sqlitePersistence(join(realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-suggest-db-'))), 'k.sqlite'))],
  ];
  for (const [name, open] of backends) {
    it(`an open suggestion and the rules survive (${name})`, async () => {
      const db = open();
      const before = world(db);
      const id = await before.start();
      await before.runtime.suggestions.prefs.setTagRule('release:any', 'never');
      await before.runtime.shutdown();
      const after = world(db);
      const stored = suggestionsIn((await after.workspace.storedDetail(id))!.messages);
      expect(stored).toMatchObject([{ kind: 'tag', state: 'open' }]);
      await after.runtime.suggestions.answer(id, stored[0]!.id, 'tag');
      expect((await after.row(id)).tags).toEqual(['PROJ-482']);
      expect((await after.runtime.suggestions.prefs.tags()).rules).toMatchObject({ 'release:any': { value: 'never' } });
      await after.runtime.shutdown();
      await db.close();
    });
  }
});
