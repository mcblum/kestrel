// The OpenCode adapter's lifecycle against a fake `opencode serve` (fixtures/fake-opencode-serve.mjs)
// that speaks the same HTTP and event stream. No clocks: every wait is for an event or a logged request.
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { otherProjectHolding, otherProjectRefusal } from '../../shared/project-edits.ts';
import { PROTECTED_REFUSAL, protectedRefusal } from '../../shared/protected-files.ts';
import { NO_TOOLS } from '../test-support.ts';
import { KESTREL_TOOLS, type AgentEvent, type StartOptions } from '../types.ts';
import { STOPPED } from './asks.ts';
import { CHANGES_NOTHING, DECLINED } from './decide.ts';
import { IMPLEMENT_PLAN } from './handle.ts';
import { nodeLauncher, opencodeAdapter } from './index.ts';
import { NOT_INSTALLED, NOT_SIGNED_IN, OpencodeUnavailable, type Launch } from './process.ts';

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-opencode-serve.mjs');
// Every fake server a test starts is ended when that test is over. The adapter ends its servers when
// the process exits, but a test worker that is torn down never gets that far, so a server a test left
// open (a turn that failed, say) ran on after the tests: two per run, for days.
const servers: Awaited<ReturnType<Launch>>[] = [];
const fakeLaunch: Launch = async (options) => {
  const server = await nodeLauncher(FAKE)(options);
  servers.push(server);
  return server;
};
afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
});

const KESTREL_MCP = { url: 'http://127.0.0.1:1/mcp/s-1', token: 'session-token' };

interface Extra {
  env?: (dir: string) => Record<string, string>;
  directory?: (dir: string) => string;
  options?: (dir: string) => Partial<StartOptions>;
}

function setup(scenario: string, permission: StartOptions['permission'] = 'ask', extra: Extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kestrel-opencode-'));
  const log = join(dir, 'received.jsonl');
  // HOME points at the scratch folder so the user's own OpenCode files are never read.
  const env = { PATH: process.env.PATH, HOME: dir, FAKE_OPENCODE_SCENARIO: scenario, FAKE_OPENCODE_LOG: log, FAKE_OPENCODE_STATE: join(dir, 'state'), KESTREL_TOKEN: 'launch-token', ...extra.env?.(dir) };
  const adapter = opencodeAdapter({ launch: fakeLaunch, env, probeDirectory: dir, log: () => undefined });
  const options: StartOptions = { directory: extra.directory?.(dir) ?? dir, instruction: 'Standing instruction: call mcp__kestrel__delegate.', tools: NO_TOOLS, permission, kestrelMcp: KESTREL_MCP, ...extra.options?.(dir) };
  const events: AgentEvent[] = [];
  const watchers: { pred: (e: AgentEvent) => boolean; resolve: (e: AgentEvent) => void }[] = [];
  const emit = (e: AgentEvent) => {
    events.push(e);
    for (const w of [...watchers]) if (w.pred(e)) watchers.splice(watchers.indexOf(w), 1) && w.resolve(e);
  };
  /** The next event (from `after`, or already seen) that matches. */
  const next = <T extends AgentEvent['type']>(type: T, pred: (e: Extract<AgentEvent, { type: T }>) => boolean = () => true, after = 0) =>
    new Promise<Extract<AgentEvent, { type: T }>>((resolve) => {
      const match = (e: AgentEvent) => e.type === type && pred(e as Extract<AgentEvent, { type: T }>);
      const seen = events.slice(after).find(match);
      if (seen) return resolve(seen as Extract<AgentEvent, { type: T }>);
      watchers.push({ pred: match, resolve: resolve as (e: AgentEvent) => void });
    });
  const received = (): Record<string, any>[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const requests = (method: string, path: RegExp) => received().filter((m) => m.kind === 'request' && m.method === method && path.test(m.path));
  return { adapter, options, events, emit, next, received, requests, dir };
}

const terminal = (e: AgentEvent): e is Extract<AgentEvent, { type: 'done' | 'failed' }> => e.type === 'done' || e.type === 'failed';
const lastTerminal = (events: AgentEvent[]) => events.filter(terminal).at(-1);
const until = (check: () => boolean) =>
  new Promise<void>((resolve) => {
    const poll = () => (check() ? resolve() : setImmediate(poll));
    poll();
  });

describe('OpenCode adapter, against a fake opencode serve', () => {
  it('starts a session, streams the reply and ends the turn with its cost and context', async () => {
    const t = setup('reply');
    const handle = t.adapter.start(t.options, 'hi', t.emit);
    expect(handle.busy()).toBe(true);
    const started = await t.next('started');
    expect(started).toMatchObject({ agentSessionId: 'ses_fake1', model: 'fakeprov/fake-1', kestrelTools: 'connected', missing: [] });
    expect(await t.next('done')).toEqual({ type: 'done', reason: 'complete', costUsd: 0.0042 });
    expect(handle.busy()).toBe(false);
    expect(t.events.filter((e) => e.type === 'message').map((e) => (e as { text: string }).text)).toEqual(['hel', 'hello', 'hello']);
    expect(await t.next('context')).toMatchObject({ usage: { model: 'fakeprov/fake-1', usedTokens: 2030, windowTokens: 200000 } });
    expect(await t.adapter.contextUsage!('ses_fake1', t.options)).toMatchObject({ usedTokens: 2030 });
    const prompt = t.requests('POST', /prompt_async$/)[0]!;
    expect(prompt.body).toEqual({ agent: 'build', parts: [{ type: 'text', text: 'hi' }] });
    expect(prompt.directory).toBe(t.dir);
    expect(t.requests('POST', /^\/session$/)[0]!.body).toEqual({ title: 'Kestrel', permission: [] });
    await handle.close!();
  });

  it('compacts with session.summarize and the session\'s model, as a turn measured again at its end', async () => {
    const t = setup('reply');
    const handle = t.adapter.start({ ...t.options, model: 'fakeprov/fake-1' }, 'hi', t.emit);
    await t.next('done');
    const before = t.events.length;
    handle.compact!();
    expect(handle.busy()).toBe(true);
    expect(() => handle.compact!()).toThrow('still working');
    expect(await t.next('done', () => true, before)).toMatchObject({ type: 'done', reason: 'complete' });
    expect(t.requests('POST', /\/summarize$/).map((r) => r.body)).toEqual([{ providerID: 'fakeprov', modelID: 'fake-1', auto: false }]);
    expect(t.events.slice(before).find((e) => e.type === 'context')).toMatchObject({ usage: { usedTokens: 200, windowTokens: 200000 } });
    expect(handle.busy()).toBe(false);
    await handle.close!();
  });

  it('serves Kestrel tools to the process and gives it the standing instruction, without the launch token', async () => {
    const t = setup('reply', 'ask', { options: () => ({ model: 'fakeprov/fake-1', effort: 'high', setup: { loadSettings: false, inProject: true, mcpServers: {} } }) });
    const handle = t.adapter.start(t.options, 'hi', t.emit);
    await t.next('done');
    const launch = t.received().find((m) => m.kind === 'launch' && m.config.mcp?.kestrel)!;
    expect(launch.config.mcp.kestrel).toMatchObject({ type: 'remote', url: KESTREL_MCP.url, enabled: true, headers: { Authorization: 'Bearer session-token' } });
    expect(launch.config.permission).toMatchObject({ '*': 'ask', read: 'allow', 'kestrel_*': 'allow', kestrel_browser_click: 'ask' });
    expect(launch.config).toMatchObject({ autoupdate: false, share: 'disabled' });
    expect(launch.instruction).toBe('Standing instruction: call kestrel_delegate.');
    expect(launch.hasToken).toBe(false);
    expect(launch.autoupdate).toBe('1');
    expect(launch.args).toEqual(['serve', '--hostname=127.0.0.1', '--port=0', '--pure']);
    expect(t.requests('POST', /prompt_async$/)[0]!.body).toMatchObject({ model: { providerID: 'fakeprov', modelID: 'fake-1' }, variant: 'high' });
    await handle.close!();
    // The instruction file goes with the process.
    expect(existsSync(launch.config.instructions[0])).toBe(false);
  });

  it('reports Kestrel tools missing, with the reason, when OpenCode could not reach them', async () => {
    const t = setup('reply', 'ask', { env: () => ({ FAKE_OPENCODE_MCP: 'failed' }) });
    const handle = t.adapter.start(t.options, 'hi', t.emit);
    const started = await t.next('started');
    expect(started.kestrelTools).toBe('missing');
    expect(started.missing).toEqual([...KESTREL_TOOLS]);
    expect(started.detail).toMatch(/could not reach Kestrel's tools: connect ECONNREFUSED/);
    await handle.close!();
  });

  it('keeps one process for the session: a second message reuses it', async () => {
    const t = setup('reply');
    const handle = t.adapter.start(t.options, 'one', t.emit);
    await t.next('done');
    const before = t.events.length;
    handle.send('two');
    await t.next('done', () => true, before);
    expect(t.received().filter((m) => m.kind === 'launch' && m.config.mcp?.kestrel)).toHaveLength(1);
    expect(t.requests('POST', /prompt_async$/)).toHaveLength(2);
    await handle.close!();
  });

  it('maps tool calls: commands, file writes, Kestrel tools, todos and a failed read', async () => {
    const t = setup('tools', 'auto');
    const handle = t.adapter.start(t.options, 'go', t.emit);
    await t.next('done');
    const tools = t.events.filter((e): e is Extract<AgentEvent, { type: 'tool' }> => e.type === 'tool');
    const finished = tools.filter((e) => e.status !== 'started');
    expect(finished.map((e) => [e.name, e.status])).toEqual([
      ['mcp__kestrel__list_projects', 'finished'],
      ['Bash', 'finished'],
      ['Write', 'finished'],
      ['TodoWrite', 'finished'],
      ['Read', 'failed'],
    ]);
    expect(finished[1]).toMatchObject({ command: 'echo hi', label: 'Print hi', detail: 'hi\n' });
    expect(finished[2]).toMatchObject({ paths: ['hello.txt'] });
    expect(finished[4]).toMatchObject({ detail: 'File not found' });
    expect(t.events.find((e) => e.type === 'todos')).toEqual({ type: 'todos', items: [{ id: '1', text: 'check', status: 'completed' }, { id: '2', text: 'report', status: 'in_progress' }] });
    expect(t.events.some((e) => e.type === 'files-changed')).toBe(true);
    await handle.close!();
  });

  it('shows pictures a tool returned', async () => {
    const t = setup('image', 'auto');
    const handle = t.adapter.start(t.options, 'look', t.emit);
    await t.next('done');
    expect(t.events.find((e) => e.type === 'image')).toMatchObject({ mediaType: 'image/png', data: 'iVBORw0KGgo=' });
    await handle.close!();
  });

  it('shows what a sub-agent does beside the conversation, not in it', async () => {
    const t = setup('subagent', 'auto');
    const handle = t.adapter.start(t.options, 'explore', t.emit);
    await t.next('done');
    const task = t.events.find((e) => e.type === 'tool' && e.name === 'Agent' && e.status === 'started') as Extract<AgentEvent, { type: 'tool' }>;
    const helper = t.events.filter((e) => e.type === 'subagent-output');
    expect(helper.map((e) => (e as { text: string }).text)).toEqual([expect.stringMatching(/\*\.ts/), 'found 3 files']);
    expect(helper.every((e) => (e as { id: string }).id === task.id)).toBe(true);
    expect(t.events.filter((e) => e.type === 'message' && e.done).map((e) => (e as { text: string }).text)).toEqual(['the helper found 3 files']);
    await handle.close!();
  });

  it('Manual: a command is a card; Allow runs it', async () => {
    const t = setup('ask-bash', 'ask');
    const handle = t.adapter.start(t.options, 'clean', t.emit);
    const card = await t.next('needs-input');
    expect(card.request).toMatchObject({ kind: 'approval', tool: 'bash', options: [{ id: 'allow' }, { id: 'deny' }] });
    expect(card.request.detail).toContain('rm -rf build');
    handle.answer(card.request.id, { optionId: 'allow' });
    await t.next('done');
    expect(t.requests('POST', /^\/permission\//)[0]!.body).toEqual({ reply: 'once' });
    expect(t.events.find((e) => e.type === 'message' && e.done)).toMatchObject({ text: 'removed' });
    await handle.close!();
  });

  it('Manual: Deny answers the ask with a message, so the agent carries on and reads why', async () => {
    const t = setup('ask-bash', 'ask');
    const handle = t.adapter.start(t.options, 'clean', t.emit);
    const card = await t.next('needs-input');
    handle.answer(card.request.id, { optionId: 'deny', text: 'keep the build' });
    expect(await t.next('done')).toMatchObject({ reason: 'complete' });
    expect(t.requests('POST', /^\/permission\//)[0]!.body).toEqual({ reply: 'reject', message: 'The user declined this: keep the build' });
    expect(t.events.find((e) => e.type === 'tool' && e.status === 'failed')).toMatchObject({ name: 'Bash' });
    await handle.close!();
  });

  it('Accept edits: an edit in the folder runs without a card; a command still asks', async () => {
    const t = setup('ask-edit,ask-bash', 'edits');
    const handle = t.adapter.start(t.options, 'edit', t.emit);
    await t.next('done');
    expect(t.events.some((e) => e.type === 'needs-input')).toBe(false);
    expect(t.requests('POST', /^\/permission\//)[0]!.body).toEqual({ reply: 'once' });
    handle.send('clean');
    const card = await t.next('needs-input');
    handle.answer(card.request.id, { optionId: 'deny' });
    await until(() => t.events.filter(terminal).length === 2);
    expect(t.requests('POST', /^\/permission\//)[1]!.body).toEqual({ reply: 'reject', message: DECLINED });
    await handle.close!();
  });

  it('Read only: the session is created with edits and commands denied, and an ask is refused with the reason', async () => {
    const t = setup('ask-edit', 'readonly');
    const handle = t.adapter.start(t.options, 'edit', t.emit);
    await t.next('done');
    const rules = t.requests('POST', /^\/session$/)[0]!.body.permission as { permission: string; action: string }[];
    expect(rules).toEqual(expect.arrayContaining([{ permission: 'edit', pattern: '*', action: 'deny' }, { permission: 'bash', pattern: '*', action: 'deny' }, { permission: 'kestrel_browser_click', pattern: '*', action: 'deny' }]));
    expect(t.requests('POST', /^\/permission\//)[0]!.body).toEqual({ reply: 'reject', message: CHANGES_NOTHING });
    const started = t.events.find((e) => e.type === 'started') as Extract<AgentEvent, { type: 'started' }>;
    expect(started.kestrelTools).toBe('connected');
    await handle.close!();
  });

  it('answers a question card with the chosen option', async () => {
    const t = setup('question', 'ask');
    const handle = t.adapter.start(t.options, 'ask me', t.emit);
    const card = await t.next('needs-input');
    expect(card.request).toMatchObject({ kind: 'question', questions: [{ question: 'Which colour?', header: 'Colour', multi: false }] });
    handle.answer(card.request.id, { optionId: '1' });
    await t.next('done');
    expect(t.requests('POST', /^\/question\//)[0]!.body).toEqual({ answers: [['Blue']] });
    await handle.close!();
  });

  it('Stop ends a turn waiting on a card: the ask is refused, the turn aborted, and the session can go on', async () => {
    const t = setup('ask-bash,reply', 'ask');
    const handle = t.adapter.start(t.options, 'clean', t.emit);
    await t.next('needs-input');
    await handle.stop();
    expect(lastTerminal(t.events)).toMatchObject({ type: 'done', reason: 'stopped' });
    expect(t.requests('POST', /^\/permission\//)[0]!.body).toEqual({ reply: 'reject', message: STOPPED });
    expect(t.requests('POST', /\/abort$/)).toHaveLength(1);
    const before = t.events.length;
    handle.send('again');
    expect(await t.next('done', () => true, before)).toMatchObject({ reason: 'complete' });
    await handle.close!();
  });

  it('Stop ends a running turn', async () => {
    const t = setup('hang', 'ask');
    const handle = t.adapter.start(t.options, 'work', t.emit);
    await t.next('message');
    await handle.stop();
    expect(lastTerminal(t.events)).toEqual({ type: 'done', reason: 'stopped' });
    expect(handle.busy()).toBe(false);
    await handle.close!();
  });

  it('resumes a stored session in a new process after a restart', async () => {
    const t = setup('reply');
    const first = t.adapter.start(t.options, 'one', t.emit);
    await t.next('done');
    await first.close!();
    const again = opencodeAdapter({ launch: fakeLaunch, env: { PATH: process.env.PATH, HOME: t.dir, FAKE_OPENCODE_SCENARIO: 'reply', FAKE_OPENCODE_LOG: join(t.dir, 'received.jsonl'), FAKE_OPENCODE_STATE: join(t.dir, 'state') }, log: () => undefined });
    const before = t.events.length;
    const handle = again.resume('ses_fake1', t.options, t.emit);
    expect(handle.agentSessionId()).toBe('ses_fake1');
    handle.send('two');
    expect(await t.next('started', () => true, before)).toMatchObject({ agentSessionId: 'ses_fake1' });
    await t.next('done', () => true, before);
    // Two session processes (the probe for the context window starts its own, without Kestrel's tools).
    expect(t.received().filter((m) => m.kind === 'launch' && m.config.mcp?.kestrel)).toHaveLength(2);
    expect(t.requests('POST', /^\/session$/)).toHaveLength(1);
    expect(t.requests('GET', /^\/session\/ses_fake1$/)).toHaveLength(1);
    expect(t.requests('PATCH', /^\/session\/ses_fake1$/)).toHaveLength(1);
    await handle.close!();
  });

  it('a session OpenCode no longer has fails with a plain reason', async () => {
    const t = setup('reply');
    const handle = t.adapter.resume('ses_gone', t.options, t.emit);
    handle.send('hi');
    expect(await t.next('failed')).toMatchObject({ reason: expect.stringMatching(/no conversation ses_gone any more/) });
  });

  it('a process that will not start fails the turn with what it printed', async () => {
    const t = setup('reply', 'ask', { env: () => ({ FAKE_OPENCODE_START: 'fail' }) });
    t.adapter.start(t.options, 'hi', t.emit);
    const failed = await t.next('failed');
    expect(failed.reason).toMatch(/OpenCode stopped while starting \(exit code 1\)/);
    expect(failed.reason).toContain('Unexpected config key');
  });

  it('a process that dies mid-turn fails the turn with its output; the next message starts a new one', async () => {
    const t = setup('crash,reply');
    const handle = t.adapter.start(t.options, 'hi', t.emit);
    const failed = await t.next('failed');
    expect(failed.reason).toMatch(/OpenCode stopped unexpectedly: it exited with code 3/);
    expect(failed.reason).toContain('lost the database');
    const before = t.events.length;
    handle.send('again');
    expect(await t.next('done', () => true, before)).toMatchObject({ reason: 'complete' });
    await handle.close!();
  });

  it("a provider's error fails the turn with OpenCode's words; a sign-in error is marked as auth", async () => {
    const api = setup('api-error');
    api.adapter.start(api.options, 'hi', api.emit);
    expect(await api.next('failed')).toEqual({ type: 'failed', reason: 'OpenCode: Not Found: model not found', kind: 'other' });
    const auth = setup('auth-error');
    auth.adapter.start(auth.options, 'hi', auth.emit);
    expect(await auth.next('failed')).toMatchObject({ kind: 'auth', reason: 'OpenCode: Invalid API key' });
  });

  it('a retry hours away (a used-up free tier) ends the turn with the reason instead of waiting', async () => {
    const t = setup('retry-far');
    const handle = t.adapter.start(t.options, 'hi', t.emit);
    const failed = await t.next('failed');
    expect(failed.reason).toMatch(/^Free usage exceeded, subscribe to Go \(OpenCode would only try again at /);
    expect(t.requests('POST', /\/abort$/)).toHaveLength(1);
    await handle.close!();
  });

  it('Plan: runs the plan agent, shows the plan as a card, and approving it switches the level and implements it', async () => {
    const t = setup('plan,reply', 'plan');
    const handle = t.adapter.start(t.options, 'plan it', t.emit);
    const card = await t.next('needs-input');
    expect(card.request).toMatchObject({ id: 'opencode-plan', title: 'Plan ready', detail: '1. Edit notes.txt\n2. Run the tests' });
    expect(t.requests('POST', /prompt_async$/)[0]!.body.agent).toBe('plan');
    expect(t.requests('POST', /^\/session$/)[0]!.body.permission).toEqual([{ permission: 'edit', pattern: '*', action: 'deny' }]);
    handle.answer('opencode-plan', { optionId: 'approve-edits' });
    await t.next('done');
    expect(t.events.find((e) => e.type === 'mode')).toEqual({ type: 'mode', permission: 'edits' });
    const second = t.requests('POST', /prompt_async$/)[1]!.body;
    expect(second).toMatchObject({ agent: 'build', parts: [{ type: 'text', text: IMPLEMENT_PLAN }] });
    expect(t.requests('PATCH', /^\/session\//).at(-1)!.body).toEqual({ permission: [] });
    await handle.close!();
  });

  it('runs a listed slash command as an OpenCode command', async () => {
    const t = setup('reply,reply');
    const handle = t.adapter.start(t.options, 'hi', t.emit);
    await t.next('done');
    expect(t.events.find((e) => e.type === 'slash-commands')).toMatchObject({ commands: [{ name: 'init' }, { name: 'review', argumentHint: '$ARGUMENTS' }] });
    const before = t.events.length;
    handle.send('/review main');
    await t.next('done', () => true, before);
    expect(t.requests('POST', /\/command$/)[0]!.body).toMatchObject({ command: 'review', arguments: 'main', agent: 'build' });
    await handle.close!();
  });

  it('forks a conversation with OpenCode itself and resumes the copy', async () => {
    const t = setup('reply');
    const handle = t.adapter.start(t.options, 'hi', t.emit);
    await t.next('done');
    await handle.close!();
    const forked = await t.adapter.fork!('ses_fake1', { from: t.dir, to: join(t.dir, 'copy') });
    expect(forked).toBe('ses_fake2');
    await expect(t.adapter.fork!('ses_nope', { from: t.dir, to: t.dir })).rejects.toThrow(/OpenCode could not fork the conversation: Session not found: ses_nope/);
  });
});

describe('OpenCode adapter, the edit rule', () => {
  const DELEGATE = 'mcp__kestrel__delegate';
  const rule = (dir: string): StartOptions['intercept'] => async (action) => {
    const path = action.input.file_path;
    if (typeof path !== 'string') return { allow: true };
    const other = otherProjectHolding(path, [{ id: 'alpha', name: 'Alpha', folders: [{ path: join(dir, 'alpha') }] }, { id: 'beta', name: 'Beta', folders: [{ path: join(dir, 'beta') }] }], 'alpha');
    return other ? { allow: false, message: otherProjectRefusal(path, other.name, DELEGATE) } : { allow: true };
  };

  for (const level of ['bypass', 'auto', 'edits', 'ask'] as const) {
    it(`${level}: an edit into another project is refused with the shared reason, with no card`, async () => {
      const t = setup('ask-edit', level, {
        env: (dir) => ({ FAKE_OPENCODE_EDIT_PATH: join(dir, 'beta', 'README.md') }),
        directory: (dir) => {
          for (const sub of ['alpha', 'beta']) mkdirSync(join(dir, sub), { recursive: true });
          return join(dir, 'alpha');
        },
        options: (dir) => ({ intercept: rule(dir) }),
      });
      const handle = t.adapter.start(t.options, 'edit beta', t.emit);
      await t.next('done');
      const file = join(t.dir, 'beta', 'README.md');
      const reason = otherProjectRefusal(file, 'Beta', 'kestrel_delegate');
      expect(t.requests('POST', /^\/permission\//)[0]!.body).toEqual({ reply: 'reject', message: reason });
      expect(t.events.some((e) => e.type === 'needs-input')).toBe(false);
      expect(t.events.find((e) => e.type === 'tool' && e.status === 'failed')).toMatchObject({ name: 'Edit', detail: reason, refusal: reason });
      await handle.close!();
    });
  }
});

describe("OpenCode adapter, Kestrel's credential store", () => {
  it('a confined session reading it is refused with the reason, with no card, in Auto', async () => {
    const files = (dir: string) => [join(dir, 'data', 'trackers.json')];
    const t = setup('ask-read', 'auto', {
      env: (dir) => ({ FAKE_OPENCODE_READ_PATH: files(dir)[0]! }),
      options: (dir) => ({ confineShell: true, protectedFiles: files(dir), intercept: async (action) => {
        const refusal = protectedRefusal(action, files(dir), (p) => p);
        return refusal ? { allow: false, message: refusal } : { allow: true };
      } }),
    });
    const handle = t.adapter.start(t.options, 'read it', t.emit);
    await t.next('done');
    expect(t.requests('POST', /^\/permission\//)[0]!.body).toEqual({ reply: 'reject', message: PROTECTED_REFUSAL });
    expect(t.events.some((e) => e.type === 'needs-input')).toBe(false);
    await handle.close!();
  });
});

describe('OpenCode adapter, availability and models', () => {
  it('lists connected providers’ tool-calling models, Default first, with their variants as efforts', async () => {
    const t = setup('reply');
    const { models, fromSdk } = await t.adapter.models();
    expect(fromSdk).toBe(true);
    expect(models.map((m) => m.id)).toEqual(['', 'fakeprov/fake-1']);
    expect(models[1]).toMatchObject({ label: 'Fake One', description: 'Fake Provider', efforts: ['low', 'high'] });
    expect(await t.adapter.availability!()).toEqual({ available: true });
  });

  it('not signed in: unavailable with what to run', async () => {
    const t = setup('reply', 'ask', { env: () => ({ FAKE_OPENCODE_PROVIDERS: 'none' }) });
    expect(await t.adapter.availability!()).toEqual({ available: false, reason: NOT_SIGNED_IN });
    expect((await t.adapter.models()).fromSdk).toBe(false);
  });

  it('not installed: unavailable with how to install', async () => {
    const missing: Launch = () => Promise.reject(new OpencodeUnavailable(NOT_INSTALLED, 'missing'));
    const adapter = opencodeAdapter({ launch: missing, env: {}, log: () => undefined });
    expect(await adapter.availability!()).toEqual({ available: false, reason: NOT_INSTALLED });
  });

  it('a session started without OpenCode installed fails with the install note', async () => {
    const missing: Launch = () => Promise.reject(new OpencodeUnavailable(NOT_INSTALLED, 'missing'));
    const adapter = opencodeAdapter({ launch: missing, env: {}, log: () => undefined });
    const events: AgentEvent[] = [];
    const handle = adapter.start({ directory: tmpdir(), instruction: '', tools: NO_TOOLS, permission: 'ask' }, 'hi', (e) => events.push(e));
    await until(() => !handle.busy());
    expect(events.at(-1)).toEqual({ type: 'failed', reason: NOT_INSTALLED, kind: 'other' });
  });

  it('lists slash commands without running a turn', async () => {
    const t = setup('reply');
    const commands = await t.adapter.slashCommands!(t.options);
    expect(commands!.map((c) => c.name)).toEqual(['init', 'review']);
    expect(t.requests('POST', /prompt_async$/)).toHaveLength(0);
  });
});

// A message while the agent works (0.0.18 for Claude and Codex; OpenCode since notes, 0.0.33): another
// prompt on the busy session, taken in by OpenCode's running loop (spike/opencode-note.ts showed it).
describe('OpenCode, a message into a running turn', () => {
  it('goes in as another prompt, is read once a step answers it, and the turn stays one turn', async () => {
    const t = setup('steer');
    const handle = t.adapter.start(t.options, 'hi', t.emit);
    await t.next('message', (e) => e.text === 'working');
    await expect(handle.sendNow!({ id: 'k-1', text: 'A note: the port is 8443.' })).resolves.toBe(true);
    expect(await t.next('picked-up')).toEqual({ type: 'picked-up', ids: ['k-1'] });
    expect(await t.next('done')).toMatchObject({ type: 'done', reason: 'complete' });
    const prompts = t.requests('POST', /prompt_async$/).map((r) => r.body.parts[0].text);
    expect(prompts).toEqual(['hi', 'A note: the port is 8443.']);
    expect(t.events.some((e) => e.type === 'unread')).toBe(false);
    expect(t.events.filter(terminal)).toHaveLength(1);
    await handle.close!();
  });

  it('is refused when no turn runs, and one never read is reported unread when the turn is stopped', async () => {
    const t = setup('hang');
    const handle = t.adapter.start(t.options, 'hi', t.emit);
    await t.next('message', (e) => e.text === 'working');
    await expect(handle.sendNow!({ id: 'k-2', text: 'too late' })).resolves.toBe(true);
    await handle.stop();
    expect(await t.next('unread')).toEqual({ type: 'unread', ids: ['k-2'] });
    expect(lastTerminal(t.events)).toMatchObject({ type: 'done', reason: 'stopped' });
    await expect(handle.sendNow!({ id: 'k-3', text: 'idle now' })).resolves.toBe(false);
    await handle.close!();
  });
});
