import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryPersistence } from '../persistence/memory.ts';
import { SessionRuntime } from '../runtime.ts';
import { openSuggestions } from '../shared/suggestions.ts';
import { FakeAgents } from '../test-agent.ts';
import { Workspace } from '../workspace.ts';
import { suggestionRoute } from './api.ts';

async function world() {
  const workspace = new Workspace(memoryPersistence());
  const agents = new FakeAgents();
  agents.script = async (turn) => void (await turn.options.tools.suggest({ kind: 'tag', tag: 'PROJ-1', category: 'ticket', source: 'Linear' }));
  const runtime = new SessionRuntime(workspace, { claude: agents.adapter() }, realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-suggest-api-'))));
  const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'Work on PROJ-1' });
  await agents.settled();
  await runtime.idle(session.id);
  const route = (parts: string[], method: string, body: Record<string, unknown> = {}) => suggestionRoute(['api', ...parts], method, async () => body, runtime.suggestions);
  return { runtime, id: session.id, route };
}

describe('suggestion routes', () => {
  it('answers with a button and validates it', async () => {
    const { runtime, id, route } = await world();
    const s = openSuggestions(runtime.recordOf(id)!.messages)[0]!;
    expect(await route(['sessions', id, 'suggestions', s.id, 'answer'], 'POST', { button: '../x' })).toMatchObject({ status: 400 });
    expect(await route(['sessions', id, 'suggestions', s.id, 'answer'], 'POST', { button: 'always' })).toMatchObject({ status: 200, body: { suggestion: { state: 'answered' } } });
    expect(await route(['suggestion-prefs', 'tags'], 'GET')).toEqual({ status: 200, body: { enabled: true, rules: [{ key: 'ticket:linear', label: 'Linear tickets', value: 'always' }] } });
  });

  it('takes the tags chosen on the card with the answer, and refuses picks that are not a list of names', async () => {
    const { runtime, id, route } = await world();
    const s = openSuggestions(runtime.recordOf(id)!.messages)[0]!;
    expect(await route(['sessions', id, 'suggestions', s.id, 'answer'], 'POST', { button: 'tag', picks: 'PROJ-1' })).toMatchObject({ status: 400 });
    expect(await route(['sessions', id, 'suggestions', s.id, 'answer'], 'POST', { button: 'tag', picks: ['PROJ-1', 7] })).toMatchObject({ status: 400 });
    expect(await route(['sessions', id, 'suggestions', s.id, 'answer'], 'POST', { button: 'tag', picks: ['PROJ-1', 'Uploads'] })).toMatchObject({ status: 200, body: { suggestion: { state: 'answered', line: 'Tagged PROJ-1, Uploads' } } });
  });

  it('changes a rule or the switch, and refuses anything else', async () => {
    const { route } = await world();
    expect(await route(['suggestion-prefs', 'tags'], 'PATCH', { rule: { key: 'ticket:jira', value: 'sometimes' } })).toMatchObject({ status: 400 });
    expect(await route(['suggestion-prefs', 'tags'], 'PATCH', { rule: { key: 'nope', value: 'never' } })).toMatchObject({ status: 400 });
    expect(await route(['suggestion-prefs', 'tags'], 'PATCH', { enabled: 'yes' })).toMatchObject({ status: 400 });
    expect(await route(['suggestion-prefs', 'tags'], 'PATCH', { enabled: false, rule: { key: 'release:any', value: 'never' } })).toEqual({ status: 200, body: { enabled: false, rules: [{ key: 'release:any', label: 'Releases', value: 'never' }] } });
  });

  it('is not one of these routes otherwise', async () => {
    const { id, route } = await world();
    expect(await route(['sessions', id, 'tags'], 'POST')).toBeNull();
    expect(await route(['sessions', id, 'suggestions', 'x', 'explode'], 'POST')).toBeNull();
  });

  it('lists the standing answers to ticket changes and sets one back to Ask', async () => {
    const { route } = await world();
    expect(await route(['suggestion-prefs', 'tickets'], 'PATCH', { change: 'done', source: 'jira', answer: 'always' })).toMatchObject({ status: 400 });
    expect(await route(['suggestion-prefs', 'tickets'], 'PATCH', { change: 'comment', source: 'jira', answer: 'never' })).toEqual({ status: 200, body: { answers: [{ change: 'comment', source: 'jira', answer: 'never' }] } });
    expect(await route(['suggestion-prefs', 'tickets'], 'PATCH', { change: 'comment', source: 'jira', answer: 'ask' })).toEqual({ status: 200, body: { answers: [] } });
    expect(await route(['suggestion-prefs', 'tickets'], 'GET')).toEqual({ status: 200, body: { answers: [] } });
  });
});
