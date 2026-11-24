// The Codex adapter's lifecycle against a fake app-server (fixtures/fake-app-server.mjs) that speaks
// the same JSON-RPC over stdio. No clocks: every wait is for an event.
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { NO_TOOLS } from '../test-support.ts';
import { makeRepo } from '../../test-repo.ts';
import type { AgentEvent, AgentHandle, StartOptions } from '../types.ts';
import { codexAdapter, nodeLauncher } from './index.ts';
import { appliedUnasked, IMPLEMENT_PLAN, LATE_NOTE } from './handle.ts';
import { otherProjectHolding, otherProjectRefusal, otherWorktreeHolding, otherWorktreeRefusal } from '../../shared/project-edits.ts';
import { CodexUnavailable, NOT_INSTALLED, type Launch } from './process.ts';

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-app-server.mjs');

function setup(scenario: string, permission: StartOptions['permission'] = 'ask', extra: { env?: (dir: string) => Record<string, string>; directory?: (dir: string) => string; intercept?: (dir: string) => StartOptions['intercept'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kestrel-codex-'));
  const log = join(dir, 'received.jsonl');
  const adapter = codexAdapter({ launch: nodeLauncher(FAKE), env: { ...process.env, FAKE_CODEX_SCENARIO: scenario, FAKE_CODEX_LOG: log, CODEX_HOME: dir, ...extra.env?.(dir) }, log: () => undefined });
  const options: StartOptions = { directory: extra.directory?.(dir) ?? dir, instruction: 'standing instruction', tools: NO_TOOLS, permission, ...(extra.intercept ? { intercept: extra.intercept(dir) } : {}) };
  const events: AgentEvent[] = [];
  const watchers: { pred: (e: AgentEvent) => boolean; resolve: (e: AgentEvent) => void }[] = [];
  const emit = (e: AgentEvent) => {
    events.push(e);
    for (const w of [...watchers]) if (w.pred(e)) watchers.splice(watchers.indexOf(w), 1) && w.resolve(e);
  };
  /** The next event (from now, or already seen) that matches. */
  const next = <T extends AgentEvent['type']>(type: T, pred: (e: Extract<AgentEvent, { type: T }>) => boolean = () => true, after = 0) =>
    new Promise<Extract<AgentEvent, { type: T }>>((resolve) => {
      const match = (e: AgentEvent) => e.type === type && pred(e as Extract<AgentEvent, { type: T }>);
      const seen = events.slice(after).find(match);
      if (seen) return resolve(seen as Extract<AgentEvent, { type: T }>);
      watchers.push({ pred: match, resolve: resolve as (e: AgentEvent) => void });
    });
  const received = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { adapter, options, events, emit, next, received, dir };
}

/** Resolves once the fake has logged a message that matches: it logs on its own schedule. */
const until = (check: () => boolean) =>
  new Promise<void>((resolve) => {
    const poll = () => (check() ? resolve() : setImmediate(poll));
    poll();
  });

const terminal = (e: AgentEvent) => e.type === 'done' || e.type === 'failed';

describe('Codex adapter, against a fake app-server', () => {
  it('starts a thread, streams the reply and ends the turn', async () => {
    const t = setup('reply');
    const handle = t.adapter.start(t.options, 'hi', t.emit);
    expect(handle.busy()).toBe(true);
    const started = await t.next('started');
    expect(started).toMatchObject({ agentSessionId: 'thread-1', model: 'fake-1', kestrelTools: 'missing' });
    expect(await t.next('done')).toEqual({ type: 'done', reason: 'complete' });
    expect(handle.busy()).toBe(false);
    expect(t.events.filter((e) => e.type === 'message').map((e) => (e as { text: string }).text)).toEqual(['hel', 'hello', 'hello']);
    const sent = t.received();
    const start = sent.find((m) => m.method === 'thread/start');
    expect(start.params).toMatchObject({ cwd: t.dir, approvalPolicy: 'untrusted', sandbox: 'workspace-write', developerInstructions: 'standing instruction' });
    expect(start.params.config).toMatchObject({ 'features.plugins': false, 'features.apps': false });
    expect(sent.find((m) => m.method === 'turn/start').params.input).toEqual([{ type: 'text', text: 'hi', text_elements: [] }]);
    await handle.close!();
  });

  it('keeps one process for the session: a second message reuses the thread', async () => {
    const t = setup('reply');
    const handle = t.adapter.start(t.options, 'one', t.emit);
    await t.next('done');
    const before = t.events.length;
    handle.send('two');
    await t.next('done', () => true, before);
    const sent = t.received();
    expect(sent.filter((m) => m.method === 'initialize')).toHaveLength(1);
    expect(sent.filter((m) => m.method === 'turn/start')).toHaveLength(2);
    await handle.close!();
  });

  it('shows a command approval as a card; Allow runs it', async () => {
    const t = setup('approval');
    const handle = t.adapter.start(t.options, 'touch it', t.emit);
    const card = await t.next('needs-input');
    expect(card.request).toMatchObject({ kind: 'approval', tool: 'Bash', title: 'Run a command', detail: 'touch x' });
    handle.answer(card.request.id, { optionId: 'allow' });
    await t.next('done');
    expect(t.events.some((e) => e.type === 'message' && e.done && e.text === 'ran it')).toBe(true);
    expect(t.received().find((m) => m.id === 100 && !m.method).result).toEqual({ decision: 'accept' });
    await handle.close!();
  });

  it('Deny with a note declines the command and steers the turn with the note', async () => {
    const t = setup('approval');
    const handle = t.adapter.start(t.options, 'touch it', t.emit);
    const card = await t.next('needs-input');
    handle.answer(card.request.id, { optionId: 'deny', text: 'use pnpm' });
    await t.next('done');
    await until(() => t.received().some((m) => m.method === 'turn/steer'));
    const sent = t.received();
    expect(sent.find((m) => m.id === 100 && !m.method).result).toEqual({ decision: 'decline' });
    expect(sent.find((m) => m.method === 'turn/steer').params).toMatchObject({ threadId: 'thread-1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'The user declined that action: use pnpm' }] });
    expect(() => handle.answer(card.request.id, { optionId: 'allow' })).toThrow(/no longer waiting/);
    await handle.close!();
  });

  it('compacts the thread with thread/compact/start, as a turn measured again at its end', async () => {
    const t = setup('reply');
    const handle = t.adapter.start(t.options, 'one', t.emit);
    await t.next('done');
    const before = t.events.length;
    handle.compact!();
    expect(handle.busy()).toBe(true);
    expect(() => handle.compact!()).toThrow('still working');
    expect(await t.next('done', () => true, before)).toEqual({ type: 'done', reason: 'complete' });
    expect(t.received().filter((m) => m.method === 'thread/compact/start').map((m) => m.params)).toEqual([{ threadId: 'thread-1' }]);
    expect(t.events.slice(before).some((e) => e.type === 'status' && e.text === 'Compacting the conversation…')).toBe(true);
    expect(t.events.slice(before).find((e) => e.type === 'context')).toMatchObject({ usage: { usedTokens: 200, windowTokens: 10000 } });
    expect(handle.busy()).toBe(false);
    await handle.close!();
  });

  it('a compaction is stopped like any turn', async () => {
    const t = setup('stop');
    const handle = t.adapter.resume('thread-1', t.options, t.emit);
    handle.compact!();
    await until(() => (handle as unknown as { turnId: string | null }).turnId !== null);
    await handle.stop();
    expect(t.events.filter(terminal)).toEqual([{ type: 'done', reason: 'stopped' }]);
    expect(t.received().some((m) => m.method === 'turn/interrupt')).toBe(true);
    await handle.close!();
  });

  it('stop interrupts the running turn, which ends as stopped', async () => {
    const t = setup('stop');
    const handle = t.adapter.start(t.options, 'wait', t.emit);
    await t.next('started');
    await until(() => t.received().some((m) => m.method === 'turn/start'));
    await handle.stop();
    expect(t.events.filter(terminal)).toEqual([{ type: 'done', reason: 'stopped' }]);
    expect(t.received().some((m) => m.method === 'turn/interrupt')).toBe(true);
    await handle.close!();
  });

  /** Until the handle knows the running turn's id (turn/start answered). */
  const turnKnown = (handle: AgentHandle) => until(() => (handle as unknown as { turnId: string | null }).turnId !== null);

  it('a message sent while it works is steered into the running turn and read when Codex gives it to the model', async () => {
    const t = setup('stop');
    const handle = t.adapter.start(t.options, 'wait', t.emit);
    await t.next('started');
    await turnKnown(handle);
    await expect(handle.sendNow!({ id: 'k1', text: 'also this' })).resolves.toBe(true);
    const steer = t.received().find((m) => m.method === 'turn/steer');
    expect(steer.params).toMatchObject({ threadId: 'thread-1', expectedTurnId: 'turn-1', clientUserMessageId: 'k1', input: [{ type: 'text', text: 'also this', text_elements: [] }] });
    expect(await t.next('picked-up')).toEqual({ type: 'picked-up', ids: ['k1'] });
    // Said once, though Codex reports the item starting and completing.
    expect(t.events.filter((e) => e.type === 'picked-up')).toHaveLength(1);
    // The turn goes on: one turn, nothing ended.
    expect(t.events.filter(terminal)).toEqual([]);
    await handle.stop();
    await handle.close!();
  });

  it('a steer Codex refuses leaves the message to Kestrel (false), and none is tried with no turn running', async () => {
    const t = setup('stop', 'ask', { env: () => ({ FAKE_CODEX_STEER: 'refuse' }) });
    const handle = t.adapter.start(t.options, 'wait', t.emit);
    await t.next('started');
    await turnKnown(handle);
    await expect(handle.sendNow!({ id: 'k1', text: 'too late' })).resolves.toBe(false);
    expect(t.events.some((e) => e.type === 'picked-up')).toBe(false);
    await handle.stop();
    const steers = t.received().filter((m) => m.method === 'turn/steer').length;
    await expect(handle.sendNow!({ id: 'k2', text: 'after' })).resolves.toBe(false);
    expect(t.received().filter((m) => m.method === 'turn/steer')).toHaveLength(steers);
    await handle.close!();
  });

  it('a child that dies mid-turn fails the turn with the end of its stderr', async () => {
    const t = setup('crash');
    t.adapter.start(t.options, 'go', t.emit);
    const failed = await t.next('failed');
    expect(failed.kind).toBe('other');
    expect(failed.reason).toMatch(/Codex stopped unexpectedly: it exited with code 3/);
    expect(failed.reason).toContain('ERROR codex_core: the model connection broke');
    expect(failed.reason).not.toContain('\u001b[');
  });

  it('resumes a stored thread in a new process when the next message is sent', async () => {
    const t = setup('reply');
    const handle = t.adapter.resume('thread-9', t.options, t.emit);
    expect(handle.agentSessionId()).toBe('thread-9');
    expect(t.received()).toEqual([]); // nothing runs until send
    handle.send('again');
    await t.next('done');
    const resume = t.received().find((m) => m.method === 'thread/resume');
    expect(resume.params).toMatchObject({ threadId: 'thread-9', excludeTurns: true });
    expect(t.received().some((m) => m.method === 'thread/start')).toBe(false);
    await handle.close!();
  });

  it('not signed in: the turn fails as a sign-in problem that says what to do', async () => {
    const t = setup('signedout');
    t.adapter.start(t.options, 'hi', t.emit);
    const failed = await t.next('failed');
    expect(failed).toMatchObject({ kind: 'auth' });
    expect(failed.reason).toMatch(/codex login/);
    expect(await t.adapter.availability!()).toMatchObject({ available: false, reason: expect.stringMatching(/not signed in/) });
  });

  it('not installed: the turn fails saying how to install it, and the agent shows as unavailable', async () => {
    const missing: Launch = () => {
      throw new CodexUnavailable(NOT_INSTALLED, 'missing');
    };
    const adapter = codexAdapter({ launch: missing, log: () => undefined });
    const events: AgentEvent[] = [];
    const ended = new Promise<AgentEvent>((resolve) => adapter.start({ directory: tmpdir(), instruction: '', tools: NO_TOOLS, permission: 'ask' }, 'hi', (e) => (events.push(e), terminal(e) && resolve(e))));
    expect(await ended).toEqual({ type: 'failed', reason: NOT_INSTALLED, kind: 'other' });
    expect(await adapter.availability!()).toEqual({ available: false, reason: NOT_INSTALLED });
    expect((await adapter.models()).fromSdk).toBe(false);
  });

  it('a missing binary named by KESTREL_CODEX_BINARY is reported as not installed', async () => {
    const adapter = codexAdapter({ env: { ...process.env, KESTREL_CODEX_BINARY: join(tmpdir(), 'no-such-codex') }, log: () => undefined });
    expect(await adapter.availability!()).toEqual({ available: false, reason: NOT_INSTALLED });
  });

  it('lists the models Codex reports, Default first', async () => {
    const t = setup('reply');
    const { models, fromSdk } = await t.adapter.models();
    expect(fromSdk).toBe(true);
    expect(models.map((m) => m.id)).toEqual(['', 'fake-1']);
    expect(models[1]).toMatchObject({ efforts: ['low', 'high'], fast: true, resolves: 'fake-1' });
    expect(t.adapter.permissions).toHaveLength(6);
  });

  it('sends effort and the fast tier with the turn, and reports the context window when it ends', async () => {
    const t = setup('reply');
    await t.adapter.models();
    const handle = t.adapter.start({ ...t.options, effort: 'high', fast: true }, 'hi', t.emit);
    const context = await t.next('context');
    expect(context.usage).toMatchObject({ model: 'fake-1', usedTokens: 1000, windowTokens: 10000 });
    await t.next('done');
    const turn = t.received().find((m) => m.method === 'turn/start');
    expect(turn.params).toMatchObject({ effort: 'high', serviceTierForTurn: 'priority' });
    expect(turn.params.collaborationMode.settings.reasoning_effort).toBe('high');
    expect(await t.adapter.contextUsage!(handle.agentSessionId()!, t.options)).toEqual(context.usage);
    expect(await t.adapter.contextUsage!('another-thread', t.options)).toBeNull();
    await handle.close?.();
  });

  it('plan mode: the plan is a card; approving it changes the level and implements it in the same turn', async () => {
    const t = setup('plan', 'plan');
    const handle = t.adapter.start(t.options, 'plan it', t.emit);
    const card = await t.next('needs-input');
    expect(card.request).toMatchObject({ tool: 'ExitPlanMode', title: 'Plan ready', detail: '1. Write README.md', markdown: true });
    const first = t.received().find((m) => m.method === 'turn/start').params;
    expect(first).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' }, collaborationMode: { mode: 'plan' } });
    handle.answer(card.request.id, { optionId: 'approve-edits' });
    expect(await t.next('mode')).toEqual({ type: 'mode', permission: 'edits' });
    await t.next('done');
    const second = t.received().filter((m) => m.method === 'turn/start')[1].params;
    expect(second).toMatchObject({ approvalPolicy: 'untrusted', sandboxPolicy: { type: 'workspaceWrite' }, collaborationMode: { mode: 'default' }, input: [{ text: IMPLEMENT_PLAN }] });
    expect(t.events.some((e) => e.type === 'message' && e.done && e.text.startsWith('implemented'))).toBe(true);
    await handle.close!();
  });

  it('stopping while the plan card waits ends the turn as stopped', async () => {
    const t = setup('plan', 'plan');
    const handle: AgentHandle = t.adapter.start(t.options, 'plan it', t.emit);
    await t.next('needs-input');
    await handle.stop();
    expect(t.events.filter(terminal)).toEqual([{ type: 'done', reason: 'stopped' }]);
    await handle.close!();
  });
});

describe('Codex fork, against a fake app-server', () => {
  it('forks the thread with thread/fork in the new folder, runs no turn, and the copy resumes by its new id', async () => {
    const t = setup('reply');
    const id = await t.adapter.fork!('thread-9', { from: '/w/old', to: '/w/new' });
    expect(id).toBe('thread-9-fork');
    const sent = t.received();
    expect(sent.find((m) => m.method === 'thread/fork').params).toEqual({ threadId: 'thread-9', cwd: '/w/new', excludeTurns: true });
    expect(sent.some((m) => m.method === 'turn/start')).toBe(false);
    const handle = t.adapter.resume(id, t.options, t.emit);
    handle.send('carry on');
    await t.next('done');
    expect(t.received().find((m) => m.method === 'thread/resume').params).toMatchObject({ threadId: 'thread-9-fork' });
    await handle.close!();
  });

  it('from an earlier turn, forks through that turn with lastTurnId', async () => {
    const t = setup('reply');
    await t.adapter.fork!('thread-9', { from: '/w/old', to: '/w/new', at: 'turn-1' });
    expect(t.received().find((m) => m.method === 'thread/fork').params).toEqual({ threadId: 'thread-9', cwd: '/w/new', excludeTurns: true, lastTurnId: 'turn-1' });
  });

  it('says where each turn ends (its turn id), before the turn’s end', async () => {
    const t = setup('reply');
    const handle = t.adapter.start(t.options, 'hi', t.emit);
    await t.next('done');
    const points = t.events.filter((e) => e.type === 'turn-point');
    expect(points).toEqual([{ type: 'turn-point', point: 'turn-1' }]);
    expect(t.events.indexOf(points[0]!)).toBeLessThan(t.events.findIndex((e) => e.type === 'done'));
    await handle.close!();
  });

  it('passes Codex’s refusal on as the reason', async () => {
    const t = setup('reply');
    await expect(t.adapter.fork!('missing', { from: '/w/old', to: '/w/new' })).rejects.toThrow(/no rollout found for thread missing/);
  });

  it('not signed in: refused as a sign-in problem, before asking to fork', async () => {
    const t = setup('signedout');
    await expect(t.adapter.fork!('thread-9', { from: '/w/old', to: '/w/new' })).rejects.toBeInstanceOf(CodexUnavailable);
    expect(t.received().some((m) => m.method === 'thread/fork')).toBe(false);
  });
});

// Keeping each project's edits in its own session, for Codex. The layout: the session works in
// project Alpha (`alpha/`); Beta (`beta/`) is another project; `wt/` is another session's worktree;
// `tmp/` stands for the system temp folder Codex's sandbox lets it write, with project Gamma in it.
// The rule is the runtime's (shared/project-edits.ts), wired as `editVerdict` wires it.
describe('Codex adapter, the edit rule (another project, another session’s worktree)', () => {
  const DELEGATE = 'mcp__kestrel__delegate';
  const ASK = 'mcp__kestrel__ask_session';
  const rule = (keepInProject: boolean) => (dir: string): StartOptions['intercept'] => async (action) => {
    const path = action.input.file_path;
    if (typeof path !== 'string' || !keepInProject) return { allow: true };
    const owner = otherWorktreeHolding(path, [{ id: 's-other', title: 'Other work', worktreePath: join(dir, 'wt') }], 's-me');
    if (owner) return { allow: false, message: otherWorktreeRefusal(path, owner, ASK) };
    const projects = [
      { id: 'alpha', name: 'Alpha', folders: [{ path: join(dir, 'alpha') }] },
      { id: 'beta', name: 'Beta', folders: [{ path: join(dir, 'beta') }] },
      { id: 'gamma', name: 'Gamma', folders: [{ path: join(dir, 'tmp', 'gamma') }] },
    ];
    const other = otherProjectHolding(path, projects, 'alpha');
    return other ? { allow: false, message: otherProjectRefusal(path, other.name, DELEGATE) } : { allow: true };
  };
  /** A session in Alpha whose turn applies a patch adding `target` (relative to the test folder). */
  const edit = (permission: StartOptions['permission'], target: string, opts: { keepInProject?: boolean; steer?: 'refuse' } = {}) => {
    const t = setup('edit', permission, {
      env: (dir) => ({ FAKE_CODEX_EDIT: join(dir, target), FAKE_CODEX_TMP: join(dir, 'tmp'), ...(opts.steer ? { FAKE_CODEX_STEER: opts.steer } : {}) }),
      directory: (dir) => {
        for (const sub of ['alpha', 'beta', join('wt', 'src'), join('tmp', 'gamma')]) mkdirSync(join(dir, sub), { recursive: true });
        return join(dir, 'alpha');
      },
      intercept: rule(opts.keepInProject ?? true),
    });
    return { ...t, file: join(t.dir, target) };
  };
  const start = (t: ReturnType<typeof edit>) => t.adapter.start(t.options, 'append to that README', t.emit);
  const toolEvents = (t: ReturnType<typeof edit>) => t.events.filter((e): e is Extract<AgentEvent, { type: 'tool' }> => e.type === 'tool' && e.id.startsWith('patch-'));
  /** The index of the first logged message that matches. */
  const at = (t: ReturnType<typeof edit>, pred: (m: { method?: string; id?: number; result?: unknown }) => boolean) => t.received().findIndex(pred);

  it('Auto: an edit into another project is asked of Kestrel, declined, and the reason reaches the agent before the decline and shows on the change', async () => {
    const t = edit('auto', 'beta/README.md');
    const handle = start(t);
    await t.next('done');
    const reason = otherProjectRefusal(t.file, 'Beta', DELEGATE);
    const sent = t.received();
    expect(sent.find((m) => m.method === 'thread/start').params).toMatchObject({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' });
    expect(sent.find((m) => m.id === 100 && !m.method).result).toEqual({ decision: 'decline' });
    expect(sent.find((m) => m.method === 'turn/steer').params.input).toEqual([{ type: 'text', text: reason, text_elements: [] }]);
    expect(at(t, (m) => m.method === 'turn/steer')).toBeLessThan(at(t, (m) => m.id === 100 && !m.method));
    expect(existsSync(t.file)).toBe(false);
    expect(toolEvents(t).at(-1)).toMatchObject({ status: 'failed', detail: reason, refusal: reason });
    expect(t.events.some((e) => e.type === 'needs-input')).toBe(false);
    await handle.close!();
  });

  it("Auto: an edit into another session's worktree is declined, naming that session and ask_session", async () => {
    const t = edit('auto', 'wt/src/a.ts');
    const handle = start(t);
    await t.next('done');
    const reason = otherWorktreeRefusal(t.file, { id: 's-other', title: 'Other work' }, ASK);
    expect(t.received().find((m) => m.id === 100 && !m.method).result).toEqual({ decision: 'decline' });
    expect(t.received().find((m) => m.method === 'turn/steer').params.input[0].text).toBe(reason);
    expect(toolEvents(t).at(-1)).toMatchObject({ status: 'failed', detail: reason, refusal: reason });
    expect(existsSync(t.file)).toBe(false);
    await handle.close!();
  });

  it('Auto: an edit inside the session’s own folder runs without asking anyone', async () => {
    const t = edit('auto', 'alpha/README.md');
    const handle = start(t);
    await t.next('done');
    expect(t.received().some((m) => m.id === 100)).toBe(false);
    expect(t.events.some((e) => e.type === 'needs-input')).toBe(false);
    expect(readFileSync(t.file, 'utf8')).toBe('x\n');
    expect(toolEvents(t).at(-1)).toMatchObject({ status: 'finished', detail: '' });
    await handle.close!();
  });

  it('Manual: the reason shows on the change even when the turn ends at once, and goes to the agent with the next message', async () => {
    const t = edit('ask', 'beta/README.md', { steer: 'refuse' });
    const handle = start(t);
    await t.next('done');
    const reason = otherProjectRefusal(t.file, 'Beta', DELEGATE);
    expect(t.received().find((m) => m.id === 100 && !m.method).result).toEqual({ decision: 'decline' });
    expect(t.events.some((e) => e.type === 'needs-input')).toBe(false);
    expect(toolEvents(t).at(-1)).toMatchObject({ status: 'failed', detail: reason, refusal: reason });
    const before = t.events.length;
    handle.send('so what now?');
    await t.next('done', () => true, before);
    const second = t.received().filter((m) => m.method === 'turn/start')[1].params.input;
    expect(second.map((i: { text: string }) => i.text)).toEqual(['so what now?', `${LATE_NOTE}${reason}`]);
    await handle.close!();
  });

  it('Bypass: Codex asks about every edit, so one into another project is refused and one at home goes ahead without a card', async () => {
    const away = edit('bypass', 'beta/README.md');
    const h1 = start(away);
    await away.next('done');
    expect(away.received().find((m) => m.method === 'turn/start').params).toMatchObject({ approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } });
    expect(away.received().find((m) => m.id === 100 && !m.method).result).toEqual({ decision: 'decline' });
    expect(toolEvents(away).at(-1)).toMatchObject({ status: 'failed', detail: otherProjectRefusal(away.file, 'Beta', DELEGATE) });
    expect(existsSync(away.file)).toBe(false);
    await h1.close!();

    const home = edit('bypass', 'alpha/README.md');
    const h2 = start(home);
    await home.next('done');
    expect(home.received().find((m) => m.id === 100 && !m.method).result).toEqual({ decision: 'accept' });
    expect(home.events.some((e) => e.type === 'needs-input')).toBe(false);
    expect(readFileSync(home.file, 'utf8')).toBe('x\n');
    await h2.close!();
  });

  it('with the setting off, an edit into another project follows the mode (Auto: let through, no card)', async () => {
    const t = edit('auto', 'beta/README.md', { keepInProject: false });
    const handle = start(t);
    await t.next('done');
    expect(t.received().find((m) => m.id === 100 && !m.method).result).toEqual({ decision: 'accept' });
    expect(t.events.some((e) => e.type === 'needs-input')).toBe(false);
    expect(readFileSync(t.file, 'utf8')).toBe('x\n');
    await handle.close!();
  });

  it('Auto: an edit Codex makes without asking (inside its sandbox: the temp folder) cannot be stopped, and the user and the agent are told why it should not have been made', async () => {
    const t = edit('auto', 'tmp/gamma/README.md');
    const handle = start(t);
    const note = appliedUnasked(otherProjectRefusal(t.file, 'Gamma', DELEGATE));
    const shown = await t.next('tool', (e) => e.detail === note);
    expect(shown).toMatchObject({ status: 'finished', name: 'Write', warning: note });
    await t.next('done');
    expect(t.received().some((m) => m.id === 100)).toBe(false);
    expect(existsSync(t.file)).toBe(true);
    const before = t.events.length;
    handle.send('next');
    await t.next('done', () => true, before);
    const told = [...t.received().filter((m) => m.method === 'turn/steer').map((m) => m.params.input[0].text), ...t.received().filter((m) => m.method === 'turn/start')[1].params.input.map((i: { text: string }) => i.text)];
    expect(told.some((text: string) => text.endsWith(note))).toBe(true);
    await handle.close!();
  });
});

describe('Codex adapter: git in the session’s own checkout', () => {
  const worktreeOf = (repo: string) => {
    const worktree = `${repo}-wt`;
    execFileSync('git', ['worktree', 'add', '-q', worktree, '-b', 'wt'], { cwd: repo, stdio: 'ignore' });
    return worktree;
  };
  const cards = (t: ReturnType<typeof setup>) => t.events.filter((e) => e.type === 'needs-input');
  const said = (t: ReturnType<typeof setup>) => t.events.filter((e) => e.type === 'message').at(-1);

  it.each(['auto', 'bypass'] as const)('%s: a commit in the session’s own repository runs with no card', async (level) => {
    const repo = makeRepo();
    const t = setup('git', level, { directory: () => repo });
    const handle = t.adapter.start(t.options, 'git commit -m x', t.emit);
    await t.next('done');
    expect(cards(t)).toEqual([]);
    expect(said(t)).toMatchObject({ text: 'ran it' });
    await handle.close!();
  });

  it.each(['auto', 'bypass'] as const)('%s: a commit in the session’s own worktree runs with no card', async (level) => {
    const repo = makeRepo();
    const t = setup('git', level, { directory: () => worktreeOf(repo) });
    const handle = t.adapter.start(t.options, 'git commit -m x', t.emit);
    await t.next('done');
    expect(cards(t)).toEqual([]);
    expect(said(t)).toMatchObject({ text: 'ran it' });
    await handle.close!();
  });

  it.each(['auto', 'bypass'] as const)('%s: an edit in the session’s own folder is made with no card', async (level) => {
    const repo = makeRepo();
    const t = setup('edit', level, { directory: () => repo, env: () => ({ FAKE_CODEX_EDIT: join(repo, 'new.txt') }) });
    const handle = t.adapter.start(t.options, 'write it', t.emit);
    await t.next('done');
    expect(cards(t)).toEqual([]);
    expect(existsSync(join(repo, 'new.txt'))).toBe(true);
    await handle.close!();
  });

  it('Auto: the git folders are writable roots of the turn’s sandbox, a worktree’s own and its repository’s', async () => {
    const repo = makeRepo();
    const worktree = worktreeOf(repo);
    const t = setup('git', 'auto', { directory: () => worktree });
    const handle = t.adapter.start(t.options, 'git commit -m x', t.emit);
    await t.next('done');
    expect(t.received().find((m) => m.method === 'turn/start').params.sandboxPolicy).toMatchObject({ type: 'workspaceWrite', writableRoots: [join(repo, '.git'), join(repo, '.git', 'worktrees', basename(worktree))] });
    await handle.close!();
  });

  it('Manual still asks about a commit: every command is a card there by design', async () => {
    const t = setup('git', 'ask', { directory: () => makeRepo() });
    const handle = t.adapter.start(t.options, 'git commit -m x', t.emit);
    const card = await t.next('needs-input');
    handle.answer(card.request.id, { optionId: 'allow' });
    await t.next('done');
    expect(said(t)).toMatchObject({ text: 'ran it' });
    await handle.close!();
  });

  it('Auto: a command Codex asks to run outside its sandbox runs with no card in a session the user started', async () => {
    const t = setup('command', 'auto');
    const handle = t.adapter.start(t.options, 'uv run script.py', t.emit);
    await t.next('done');
    expect(cards(t)).toEqual([]);
    expect(said(t)).toMatchObject({ text: 'ran it' });
    await handle.close!();
  });

  it('Auto: the same command is a card in a session another session started, which is held to its worktree', async () => {
    const t = setup('command', 'auto');
    const handle = t.adapter.start({ ...t.options, confineShell: true }, 'uv run script.py', t.emit);
    const card = await t.next('needs-input');
    expect(card.request).toMatchObject({ tool: 'Bash' });
    handle.answer(card.request.id, { optionId: 'deny' });
    await t.next('done');
    expect(said(t)).toMatchObject({ text: 'skipped it' });
    await handle.close!();
  });
});
