import { describe, expect, it } from 'vitest';
import { PR_TEXT_INSTRUCTION, PR_TEXT_TIMEOUT_MS } from '../pr-text-request.ts';
import { claudePullRequestText, claudeTitle, TITLE_MODEL, TITLE_TIMEOUT_MS } from './title.ts';

/** A fake `query`: yields `messages` (or never ends), records its call, and counts closes. */
function fakeQuery(messages: unknown[] | 'never' | Error) {
  const calls: any[] = [];
  let closed = 0;
  const runQuery = ((args: any) => {
    calls.push(args);
    const gen = (async function* () {
      if (messages === 'never') await new Promise(() => undefined);
      if (messages instanceof Error) throw messages;
      for (const m of messages as unknown[]) yield m;
    })();
    return Object.assign(gen, { close: () => void closed++ });
  }) as any;
  return { runQuery, calls, closes: () => closed };
}

const noTimeout = () => new Promise<void>(() => undefined);

describe('claudeTitle', () => {
  it('returns the reply of a one-shot, tool-less haiku query and closes it', async () => {
    const q = fakeQuery([{ type: 'system', subtype: 'init' }, { type: 'result', subtype: 'success', is_error: false, result: 'Fix login redirect' }]);
    const prompt = `Please fix the login\n${'x'.repeat(5000)}`;
    expect(await claudeTitle(prompt, q.runQuery, noTimeout)).toBe('Fix login redirect');
    expect(q.closes()).toBe(1);
    const { prompt: sent, options } = q.calls[0];
    expect(sent.startsWith('<message>\nPlease fix the login')).toBe(true);
    expect(sent.length).toBeLessThan(2100);
    // The user's settings are read to reach their provider (Bedrock, a gateway); their hooks are not run.
    expect(options).toMatchObject({ model: 'haiku', tools: [], settingSources: ['user'], settings: { disableAllHooks: true }, persistSession: false, maxTurns: 1, strictMcpConfig: true, mcpServers: {} });
    expect(options.resume).toBeUndefined();
    expect(options.systemPrompt).toContain('not instructions');
  });

  it('returns null and closes the query when the timeout comes first', async () => {
    const q = fakeQuery('never');
    const waited: number[] = [];
    const out = await claudeTitle('Fix it', q.runQuery, async (ms) => void waited.push(ms));
    expect(out).toBeNull();
    expect(waited).toEqual([TITLE_TIMEOUT_MS]);
    expect(q.closes()).toBe(1);
  });

  it('throws on an error result or a failed query, and still closes it', async () => {
    const bad = fakeQuery([{ type: 'result', subtype: 'error_during_execution', is_error: true }]);
    await expect(claudeTitle('Fix it', bad.runQuery, noTimeout)).rejects.toThrow(/error_during_execution/);
    expect(bad.closes()).toBe(1);
    const broken = fakeQuery(new Error('not signed in'));
    await expect(claudeTitle('Fix it', broken.runQuery, noTimeout)).rejects.toThrow(/not signed in/);
    expect(broken.closes()).toBe(1);
  });

  it('returns null when the query ends without a result', async () => {
    expect(await claudeTitle('Fix it', fakeQuery([]).runQuery, noTimeout)).toBeNull();
  });
});

describe('claudePullRequestText', () => {
  it('asks the same tool-less one-shot query with the pull request instruction, and gives up at its own time limit', async () => {
    const q = fakeQuery([{ type: 'result', subtype: 'success', is_error: false, result: 'Cache search\n\n- One' }]);
    expect(await claudePullRequestText('<commits>\nx\n</commits>', 'opus', q.runQuery, noTimeout)).toBe('Cache search\n\n- One');
    expect(q.calls[0].prompt).toBe('<commits>\nx\n</commits>');
    expect(q.calls[0].options).toMatchObject({ tools: [], persistSession: false, maxTurns: 1, systemPrompt: PR_TEXT_INSTRUCTION });
    const slow = fakeQuery('never');
    const waited: number[] = [];
    expect(await claudePullRequestText('x', 'opus', slow.runQuery, async (ms) => void waited.push(ms))).toBeNull();
    expect(waited).toEqual([PR_TEXT_TIMEOUT_MS]);
    expect(slow.closes()).toBe(1);
  });

  it('is written by the session\'s model, never the title model', async () => {
    const q = fakeQuery([{ type: 'result', subtype: 'success', is_error: false, result: 'Cache search\n\n- One' }]);
    await claudePullRequestText('x', 'claude-opus-4-5', q.runQuery, noTimeout);
    expect(q.calls[0].options.model).toBe('claude-opus-4-5');
  });

  it('leaves the model to the SDK default when the session has none (not haiku)', async () => {
    for (const model of [undefined, '']) {
      const q = fakeQuery([{ type: 'result', subtype: 'success', is_error: false, result: 'Cache search\n\n- One' }]);
      await claudePullRequestText('x', model, q.runQuery, noTimeout);
      expect('model' in q.calls[0].options).toBe(false);
    }
  });

  it('leaves session titles on the small fast model', async () => {
    const q = fakeQuery([{ type: 'result', subtype: 'success', is_error: false, result: 'Fix it' }]);
    await claudeTitle('Fix it', q.runQuery, noTimeout);
    expect(q.calls[0].options.model).toBe(TITLE_MODEL);
    expect(TITLE_MODEL).toBe('haiku');
  });
});
