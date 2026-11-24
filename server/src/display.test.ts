import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentEvent, StartOptions } from './agents/types.ts';
import { memoryPersistence } from './persistence/memory.ts';
import { SessionRuntime } from './runtime.ts';
import { Workspace } from './workspace.ts';

type Turn = (options: StartOptions, emit: (e: AgentEvent) => void) => Promise<void>;

/** One scripted turn per start; the test awaits `finished` instead of any timer. */
async function setup(turn: Turn) {
  const workspace = new Workspace(memoryPersistence());
  const data = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-display-')));
  let finished: Promise<void> = Promise.resolve();
  let resumes = 0;
  const adapter: AgentAdapter = {
    agent: 'claude',
    models: async () => ({ models: [], fromSdk: false }),
    start: (options, _prompt, emit) => {
      emit({ type: 'started', agentSessionId: 'agent-1', model: 'fake', kestrelTools: 'connected' });
      let busy = true;
      finished = turn(options, emit).then(() => {
        busy = false;
      });
      return { agentSessionId: () => 'agent-1', busy: () => busy, send: () => undefined, answer: () => undefined, stop: async () => undefined };
    },
    resume: () => {
      resumes++;
      throw new Error('not resumed in these tests');
    },
  };
  const runtime = new SessionRuntime(workspace, { claude: adapter }, data);
  const session = await runtime.start({ agent: 'claude', projectId: null, prompt: 'go' });
  await finished;
  await runtime.idle(session.id);
  const messages = () => runtime.overlay(session.id)!.messages;
  return { runtime, workspace, data, session, messages, resumes: () => resumes };
}

describe('show_widget', () => {
  it('adds the widget to the conversation and tells the agent it was shown', async () => {
    let result: unknown;
    const { messages } = await setup(async (o) => {
      result = await o.tools.showWidget({ title: ' Sales ', code: '<svg viewBox="0 0 10 10"></svg>' });
    });
    expect(result).toEqual({ text: 'Shown to the user.' });
    expect(messages().at(-1)).toMatchObject({ author: 'agent', widget: { title: 'Sales', code: '<svg viewBox="0 0 10 10"></svg>' } });
  });

  it('refuses a widget over 200 KB with a reason, shown in the conversation too', async () => {
    let result: unknown;
    const { messages } = await setup(async (o) => {
      result = await o.tools.showWidget({ title: 'Big', code: `<svg>${'x'.repeat(201 * 1024)}</svg>` });
    });
    expect(result).toMatchObject({ isError: true, text: expect.stringMatching(/200 KB/) });
    expect(messages().some((m) => m.widget)).toBe(false);
    expect(messages().at(-1)).toMatchObject({ notice: 'error', text: expect.stringMatching(/refused show_widget/) });
  });
});

describe('send_file', () => {
  it('shows a file in the session folder, by relative path, with its absolute path and size', async () => {
    const { messages, data } = await setup(async (o, emit) => {
      writeFileSync(join(o.directory, 'report.csv'), 'a,b\n1,2\n');
      await o.tools.sendFile({ path: 'report.csv', caption: 'The numbers' });
      emit({ type: 'done', reason: 'complete' });
    });
    expect(messages().at(-1)!.file).toEqual({ path: join(data, 'scratch', 'report.csv'), name: 'report.csv', caption: 'The numbers', bytes: 8 });
  });

  it('refuses a file outside the session folder and the registered projects, and a missing one', async () => {
    const elsewhere = join(realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-outside-'))), 'secret.txt');
    writeFileSync(elsewhere, 'no');
    const results: unknown[] = [];
    const { messages } = await setup(async (o) => {
      results.push(await o.tools.sendFile({ path: elsewhere }));
      results.push(await o.tools.sendFile({ path: '../../etc/hosts' }));
      results.push(await o.tools.sendFile({ path: 'nope.txt' }));
    });
    expect(results[0]).toMatchObject({ isError: true, text: expect.stringMatching(/outside this session's folder/) });
    expect(results[1]).toMatchObject({ isError: true });
    expect(results[2]).toMatchObject({ isError: true, text: expect.stringMatching(/No such file/) });
    expect(messages().some((m) => m.file)).toBe(false);
  });

  it('stays confined though the user may open the same file to read: an agent cannot put another session’s Markdown in front of the user', async () => {
    const theirs = join(realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-other-worktree-'))), 'README.md');
    writeFileSync(theirs, '# Theirs');
    let result: unknown;
    await setup(async (o) => {
      result = await o.tools.sendFile({ path: theirs });
    });
    expect(result).toMatchObject({ isError: true, text: expect.stringMatching(/outside this session's folder/) });
  });
});

describe('next_step', () => {
  it('adds the recap and trimmed replies, and refuses more than three or a long one', async () => {
    const results: unknown[] = [];
    const { messages } = await setup(async (o) => {
      results.push(await o.tools.nextStep({ recap: 'Tests pass.', ask: 'Ship it?', replies: [' Yes, ship ', '', 'Not yet'] }));
      results.push(await o.tools.nextStep({ recap: 'x', replies: ['a', 'b', 'c', 'd'] }));
      results.push(await o.tools.nextStep({ recap: 'x', replies: ['y'.repeat(41)] }));
    });
    expect(results[0]).toEqual({ text: 'Shown to the user.' });
    expect(results[1]).toMatchObject({ isError: true, text: expect.stringMatching(/At most 3/) });
    expect(results[2]).toMatchObject({ isError: true, text: expect.stringMatching(/40 characters/) });
    expect(messages().filter((m) => m.next).map((m) => m.next)).toEqual([{ recap: 'Tests pass.', ask: 'Ship it?', replies: ['Yes, ship', 'Not yet'] }]);
  });
});

describe('pictures from tool results', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');

  it('stores them under the session media folder, one card per tool result, and deletes them with the session', async () => {
    const { runtime, session, messages, data } = await setup(async (_o, emit) => {
      emit({ type: 'image', id: 'tool_1-0', mediaType: 'image/png', data: png });
      emit({ type: 'image', id: 'tool_1-1', mediaType: 'image/jpeg', data: png });
      emit({ type: 'image', id: 'tool_2-0', mediaType: 'application/pdf', data: png });
      emit({ type: 'done', reason: 'complete' });
    });
    const cards = messages().filter((m) => m.images);
    expect(cards.map((m) => [m.id, m.images])).toEqual([['images-tool_1', ['tool_1-0.png', 'tool_1-1.jpg']]]);
    const media = runtime.display.mediaFile(session.id, 'tool_1-0.png')!;
    expect(media.type).toBe('image/png');
    expect(readFileSync(media.path).toString('base64')).toBe(png);
    expect(runtime.display.mediaFile(session.id, '..')).toBeNull();
    expect(runtime.overlay(session.id)!.agentOutput).toMatch(/application\/pdf was not shown/);
    await runtime.idle(session.id);
    await runtime.deleteSession(session.id);
    expect(existsSync(join(data, 'media', session.id))).toBe(false);
  });
});

describe('answers and plan approval', () => {
  it('records a question card answered question by question as "Question → Answer" pairs', async () => {
    const { runtime, session, messages } = await setup(async (_o, emit) => {
      emit({ type: 'needs-input', request: { id: 'q1', kind: 'question', title: 'Claude is asking you', detail: 'Colour?', tool: 'AskUserQuestion', options: [], questions: [{ question: 'Colour?', options: [{ label: 'Red' }] }, { question: 'Sizes?', multi: true, options: [{ label: 'S' }, { label: 'L' }] }] } });
    });
    await runtime.answer(session.id, 'q1', { answers: { 'Colour?': 'Red', 'Sizes?': 'S, L' } });
    expect(messages().find((m) => m.input?.id === 'q1')!.input!.resolved).toBe('Colour? → Red; Sizes? → S, L');
  });

  it('a mode change from an approved plan updates the settings and keeps the running handle', async () => {
    const patches: unknown[] = [];
    let emitLater!: (e: AgentEvent) => void;
    const { runtime, session, resumes } = await setup(async (_o, emit) => {
      emitLater = emit;
    });
    runtime.onLive((_id, patch) => patches.push(patch));
    emitLater({ type: 'mode', permission: 'edits' });
    expect(runtime.overlay(session.id)!.settings).toMatchObject({ permission: 'edits' });
    expect(patches).toContainEqual({ settings: { model: '', permission: 'edits' } });
    expect(runtime.recordOf(session.id)!.handle).not.toBeNull();
    expect(resumes()).toBe(0);
  });
});
