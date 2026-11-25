// A fake `opencode serve` (1.14.25) for the adapter's tests: the HTTP routes and event stream the
// adapter uses, with event shapes copied from recorded exchanges with the real server (ids, paths
// and model names replaced). No model runs; each prompt plays a scenario.
//
// Environment:
//   FAKE_OPENCODE_SCENARIO  comma-separated scenarios, one per prompt (the last repeats)
//   FAKE_OPENCODE_LOG       every request (and the process's config and instruction) as JSON lines
//   FAKE_OPENCODE_STATE     a folder where sessions persist across fake processes (a restart)
//   FAKE_OPENCODE_START     "fail": print an error and exit before listening
//   FAKE_OPENCODE_PROVIDERS "none": no connected provider (not signed in)
//   FAKE_OPENCODE_MCP       "failed": the kestrel MCP server failed to connect
//   FAKE_OPENCODE_EDIT_PATH the file the edit scenarios edit (default <directory>/notes.txt)
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}');
const scenarios = (env.FAKE_OPENCODE_SCENARIO || 'reply').split(',');
const log = (entry) => env.FAKE_OPENCODE_LOG && appendFileSync(env.FAKE_OPENCODE_LOG, JSON.stringify(entry) + '\n');

if (env.FAKE_OPENCODE_START === 'fail') {
  process.stderr.write('Error: Unexpected config key "bogus" in OPENCODE_CONFIG_CONTENT\n');
  process.exit(1);
}

const instructionFile = Array.isArray(config.instructions) ? config.instructions[0] : null;
log({ kind: 'launch', args: process.argv.slice(2), config, instruction: instructionFile && existsSync(instructionFile) ? readFileSync(instructionFile, 'utf8') : null, hasToken: 'KESTREL_TOKEN' in env, autoupdate: env.OPENCODE_DISABLE_AUTOUPDATE });

// ---- sessions (persisted so a second process can resume them) ----------------------------

const stateFile = env.FAKE_OPENCODE_STATE ? join(env.FAKE_OPENCODE_STATE, 'sessions.json') : null;
const sessions = stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
let seq = Object.keys(sessions).length;
const save = () => {
  if (!stateFile) return;
  mkdirSync(env.FAKE_OPENCODE_STATE, { recursive: true });
  writeFileSync(stateFile, JSON.stringify(sessions));
};
const newSession = (directory, extra = {}) => {
  const id = `ses_fake${++seq}`;
  sessions[id] = { id, slug: 'quiet-fox', version: '1.14.25', projectID: 'proj_fake', directory, title: 'New session', permission: [], time: { created: Date.now(), updated: Date.now() }, ...extra };
  save();
  return sessions[id];
};

// ---- the event stream ---------------------------------------------------------------------

const listeners = new Set();
const emit = (type, properties) => {
  const line = `data: ${JSON.stringify({ type, properties })}\n\n`;
  for (const res of listeners) res.write(line);
};

// ---- turns --------------------------------------------------------------------------------

// Which scenario is next carries over to the next process, as a conversation does.
const promptsFile = env.FAKE_OPENCODE_STATE ? join(env.FAKE_OPENCODE_STATE, 'prompts') : null;
let prompts = promptsFile && existsSync(promptsFile) ? Number(readFileSync(promptsFile, 'utf8')) : 0;
const nextScenario = () => {
  const name = scenarios[Math.min(prompts++, scenarios.length - 1)];
  if (promptsFile) mkdirSync(env.FAKE_OPENCODE_STATE, { recursive: true }), writeFileSync(promptsFile, String(prompts));
  return name;
};
let ids = 0;
const id = (prefix) => `${prefix}_fake${++ids}`;
const waiting = new Map(); // requestID -> resolve(reply)
let turn = null; // { sessionID, abort() }

class Aborted extends Error {}

function turnContext(sessionID, directory, parentID) {
  const messageID = id('msg');
  let aborted = false;
  let wake = () => undefined;
  // User messages prompted while this turn runs (as 1.14.25: the loop takes them in at its next step).
  const inbox = [];
  let onInbox = () => undefined;
  const abortable = (promise) =>
    new Promise((resolve, reject) => {
      wake = () => reject(new Aborted());
      if (aborted) return wake();
      promise.then(resolve, reject);
    });
  const info = { id: messageID, parentID, role: 'assistant', mode: 'build', agent: 'build', path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, modelID: 'fake-1', providerID: 'fakeprov', time: { created: Date.now() }, sessionID };
  const part = (p, session = sessionID, message = messageID) => emit('message.part.updated', { sessionID: session, part: { id: id('prt'), messageID: message, sessionID: session, ...p }, time: Date.now() });
  const ctx = {
    sessionID,
    directory,
    messageID,
    get aborted() {
      return aborted;
    },
    abort() {
      aborted = true;
      wake();
    },
    start() {
      emit('session.status', { sessionID, status: { type: 'busy' } });
      emit('message.updated', { sessionID, info });
      part({ type: 'step-start', snapshot: 'fake' });
    },
    text(text, session = sessionID) {
      const partID = id('prt');
      const base = { id: partID, messageID, sessionID: session, type: 'text' };
      emit('message.part.updated', { sessionID: session, part: { ...base, text: '', time: { start: Date.now() } } });
      const half = Math.ceil(text.length / 2);
      for (const delta of [text.slice(0, half), text.slice(half)]) emit('message.part.delta', { sessionID: session, messageID, partID, field: 'text', delta });
      emit('message.part.updated', { sessionID: session, part: { ...base, text, time: { start: Date.now(), end: Date.now() } } });
    },
    tool(tool, input, end = { status: 'completed', output: 'ok' }, session = sessionID) {
      const callID = id('call');
      const base = { type: 'tool', tool, callID };
      part({ ...base, state: { status: 'pending', input: {}, raw: '' } }, session);
      part({ ...base, state: { status: 'running', input, time: { start: Date.now() } } }, session);
      return {
        callID,
        end: (state = end) => part({ ...base, state: { input, title: tool, metadata: {}, time: { start: Date.now(), end: Date.now() }, ...state } }, session),
      };
    },
    /** Raises a permission ask and waits for its reply. */
    ask(permission, patterns, metadata, call, session = sessionID) {
      const requestID = id('per');
      emit('permission.asked', { id: requestID, sessionID: session, permission, patterns, metadata, always: patterns, tool: { messageID, callID: call.callID } });
      return abortable(new Promise((resolve) => waiting.set(requestID, resolve)));
    },
    question(questions) {
      const requestID = id('que');
      emit('question.asked', { id: requestID, sessionID, questions });
      return abortable(new Promise((resolve) => waiting.set(requestID, resolve)));
    },
    hang: () => abortable(new Promise(() => undefined)),
    takeIn(userID) {
      inbox.push(userID);
      onInbox();
    },
    /** The next user message prompted into this turn. */
    nextMessage: () => abortable(new Promise((resolve) => (inbox.length ? resolve(inbox.shift()) : (onInbox = () => resolve(inbox.shift()))))),
    /** A further step of the loop: its assistant message answers `parentID`, the newest user message. */
    step(parentID) {
      emit('message.updated', { sessionID, info: { ...info, id: id('msg'), parentID } });
    },
    finish(tokens = { input: 1200, output: 30, reasoning: 0, cache: { read: 800, write: 0 } }, cost = 0.0042) {
      part({ type: 'step-finish', reason: 'stop', snapshot: 'fake', tokens, cost });
      emit('message.updated', { sessionID, info: { ...info, cost, tokens, finish: 'stop', time: { ...info.time, completed: Date.now() } } });
    },
    fail(error) {
      emit('message.updated', { sessionID, info: { ...info, error } });
      emit('session.error', { sessionID, error });
    },
    idle() {
      emit('session.status', { sessionID, status: { type: 'idle' } });
      emit('session.idle', { sessionID });
    },
  };
  return ctx;
}

const rejected = (reply) => `The user rejected permission to use this specific tool call.${reply.message ? ` With the following feedback: ${reply.message}` : ''}`;
const editPath = (ctx) => env.FAKE_OPENCODE_EDIT_PATH || join(ctx.directory, 'notes.txt');

/** Runs a tool that needs a permission: completed when allowed, failed with OpenCode's words when rejected. */
async function asked(ctx, tool, input, permission, patterns, metadata) {
  const call = ctx.tool(tool, input);
  const reply = await ctx.ask(permission, patterns, metadata, call);
  if (reply.reply === 'reject') call.end({ status: 'error', error: rejected(reply) });
  else call.end({ status: 'completed', output: `${tool} done` });
  return reply;
}

const SCENARIOS = {
  async reply(ctx) {
    ctx.text('hello');
    ctx.finish();
  },
  async tools(ctx) {
    ctx.tool('kestrel_list_projects', {}).end({ status: 'completed', output: '[]' });
    ctx.tool('bash', { command: 'echo hi', description: 'Print hi' }).end({ status: 'completed', output: 'hi\n' });
    ctx.tool('write', { filePath: join(ctx.directory, 'hello.txt'), content: 'hi' }).end();
    const todos = [{ id: '1', content: 'check', status: 'completed', priority: 'medium' }, { id: '2', content: 'report', status: 'in_progress', priority: 'medium' }, { id: '3', content: 'dropped', status: 'cancelled', priority: 'low' }];
    ctx.tool('todowrite', { todos }).end();
    emit('todo.updated', { sessionID: ctx.sessionID, todos });
    ctx.tool('read', { filePath: '/etc/hosts' }).end({ status: 'error', error: 'File not found' });
    ctx.text('DONE');
    ctx.finish();
  },
  async image(ctx) {
    ctx.tool('kestrel_browser_screenshot', {}).end({ status: 'completed', output: 'screenshot', attachments: [{ type: 'file', mime: 'image/png', url: 'data:image/png;base64,iVBORw0KGgo=' }] });
    ctx.text('looked');
    ctx.finish();
  },
  async 'ask-bash'(ctx) {
    const reply = await asked(ctx, 'bash', { command: 'rm -rf build', description: 'Remove build' }, 'bash', ['rm -rf build'], {});
    ctx.text(reply.reply === 'reject' ? `not run: ${reply.message}` : 'removed');
    ctx.finish();
  },
  /** A read outside the folder (FAKE_OPENCODE_READ_PATH): OpenCode's external_directory ask. */
  async 'ask-read'(ctx) {
    const filePath = env.FAKE_OPENCODE_READ_PATH;
    const reply = await asked(ctx, 'read', { filePath }, 'external_directory', [`${filePath.slice(0, filePath.lastIndexOf('/'))}/*`], { filepath: filePath });
    ctx.text(reply.reply === 'reject' ? `not read: ${reply.message}` : 'read it');
    ctx.finish();
  },
  async 'ask-edit'(ctx) {
    const filePath = editPath(ctx);
    const reply = await asked(ctx, 'edit', { filePath, oldString: 'two', newString: 'three' }, 'edit', [filePath.startsWith(ctx.directory) ? filePath.slice(ctx.directory.length + 1) : filePath], { filepath: filePath, diff: '-two\n+three' });
    ctx.text(reply.reply === 'reject' ? `not edited: ${reply.message}` : 'edited');
    ctx.finish();
  },
  async question(ctx) {
    const answers = await ctx.question([{ question: 'Which colour?', header: 'Colour', options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }], multiple: false }]);
    ctx.text(`picked ${JSON.stringify(answers)}`);
    ctx.finish();
  },
  async steer(ctx) {
    ctx.text('working');
    const user = await ctx.nextMessage();
    ctx.step(user);
    ctx.text('read it');
    ctx.finish();
  },
  async hang(ctx) {
    ctx.text('working');
    await ctx.hang();
  },
  async 'api-error'(ctx) {
    ctx.fail({ name: 'APIError', data: { message: 'Not Found: model not found', statusCode: 404, isRetryable: false } });
  },
  async 'auth-error'(ctx) {
    ctx.fail({ name: 'ProviderAuthError', data: { providerID: 'fakeprov', message: 'Invalid API key' } });
  },
  async 'retry-far'(ctx) {
    emit('session.status', { sessionID: ctx.sessionID, status: { type: 'retry', attempt: 1, message: 'Free usage exceeded, subscribe to Go', next: Date.now() + 5 * 3600_000 } });
    await ctx.hang();
  },
  async subagent(ctx) {
    const task = ctx.tool('task', { description: 'Look around', prompt: 'list files', subagent_type: 'explore' });
    const child = newSession(ctx.directory, { parentID: ctx.sessionID, title: 'Look around (@explore subagent)' });
    emit('session.created', { sessionID: child.id, info: child });
    emit('message.updated', { sessionID: child.id, info: { id: 'msg_child', role: 'assistant', sessionID: child.id, path: { cwd: ctx.directory, root: ctx.directory } } });
    ctx.tool('glob', { pattern: '*.ts' }, undefined, child.id).end();
    ctx.text('found 3 files', child.id);
    task.end({ status: 'completed', output: 'found 3 files' });
    ctx.text('the helper found 3 files');
    ctx.finish();
  },
  async plan(ctx) {
    ctx.text('1. Edit notes.txt\n2. Run the tests');
    ctx.finish();
  },
  async crash() {
    // After the prompt was taken, as a real crash mid-turn would be.
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.stderr.write('panic: lost the database\n');
    process.exit(3);
  },
};

async function runTurn(sessionID, directory, body) {
  const name = nextScenario();
  const userID = id('msg');
  emit('message.updated', { sessionID, info: { id: userID, role: 'user', sessionID, agent: body.agent, time: { created: Date.now() } } });
  emit('message.part.updated', { sessionID, part: { id: id('prt'), messageID: userID, sessionID, type: 'text', text: (body.parts ?? []).map((p) => p.text ?? '').join('') } });
  const ctx = turnContext(sessionID, directory, userID);
  turn = ctx;
  ctx.start();
  try {
    await SCENARIOS[name](ctx);
  } catch (error) {
    if (!(error instanceof Aborted)) throw error;
    ctx.fail({ name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } });
  }
  turn = null;
  ctx.idle();
}

/** A prompt while the session is busy: a user message the running loop takes in, no turn of its own. */
function promptInto(ctx, body) {
  const userID = id('msg');
  emit('message.updated', { sessionID: ctx.sessionID, info: { id: userID, role: 'user', sessionID: ctx.sessionID, agent: body.agent, time: { created: Date.now() } } });
  emit('message.part.updated', { sessionID: ctx.sessionID, part: { id: id('prt'), messageID: userID, sessionID: ctx.sessionID, type: 'text', text: (body.parts ?? []).map((p) => p.text ?? '').join('') } });
  ctx.takeIn(userID);
}

/** `POST /session/:id/summarize`, as 1.14.25: a compaction part, `session.compacted`, then idle; answers true once done. */
async function summarize(sessionID, directory, body) {
  const ctx = turnContext(sessionID, directory, id('msg'));
  turn = ctx;
  ctx.start();
  compactPart(ctx, { type: 'compaction', auto: body.auto === true });
  emit('session.compacted', { sessionID });
  ctx.finish({ input: 150, output: 50, reasoning: 0, cache: { read: 0, write: 0 } }, 0.001);
  turn = null;
  ctx.idle();
  return true;
}

const compactPart = (ctx, p) => emit('message.part.updated', { sessionID: ctx.sessionID, part: { id: id('prt'), messageID: ctx.messageID, sessionID: ctx.sessionID, ...p }, time: Date.now() });

// ---- answers ------------------------------------------------------------------------------

const PROVIDERS = {
  all: [
    { id: 'fakeprov', name: 'Fake Provider', source: 'env', env: [], options: {}, models: {
      'fake-1': { id: 'fake-1', providerID: 'fakeprov', name: 'Fake One', status: 'active', capabilities: { toolcall: true, reasoning: true, attachment: true }, cost: { input: 1, output: 2 }, limit: { context: 200000, output: 32000 }, variants: { low: {}, high: {} } },
      'fake-old': { id: 'fake-old', providerID: 'fakeprov', name: 'Fake Old', status: 'deprecated', capabilities: { toolcall: true }, limit: { context: 8000, output: 1000 } },
      'fake-chat': { id: 'fake-chat', providerID: 'fakeprov', name: 'Fake Chat', status: 'active', capabilities: { toolcall: false }, limit: { context: 8000, output: 1000 } },
    } },
    { id: 'other', name: 'Other', source: 'env', env: [], options: {}, models: { 'o-1': { id: 'o-1', providerID: 'other', name: 'Other One', status: 'active', capabilities: { toolcall: true }, limit: { context: 1000, output: 100 } } } },
  ],
  default: { fakeprov: 'fake-1' },
  connected: ['fakeprov'],
};

function mcpStatus() {
  const out = {};
  for (const [name, entry] of Object.entries(config.mcp ?? {})) {
    if (entry.enabled === false) out[name] = { status: 'disabled' };
    else if (name === 'kestrel' && env.FAKE_OPENCODE_MCP === 'failed') out[name] = { status: 'failed', error: 'connect ECONNREFUSED 127.0.0.1:1' };
    else out[name] = { status: 'connected' };
  }
  return out;
}

const COMMANDS = [
  { name: 'init', description: 'create/update AGENTS.md', source: 'command', template: '', hints: [] },
  { name: 'review', description: 'review changes [commit|branch|pr], defaults to uncommitted', source: 'command', template: '', hints: ['$ARGUMENTS'] },
];

function route(method, path, body, directory) {
  const m = (re) => re.exec(path);
  let match;
  if (method === 'GET' && path === '/provider') return env.FAKE_OPENCODE_PROVIDERS === 'none' ? { ...PROVIDERS, connected: [] } : PROVIDERS;
  if (method === 'GET' && path === '/config') return { model: 'fakeprov/fake-1', ...config };
  if (method === 'GET' && path === '/mcp') return mcpStatus();
  if (method === 'GET' && path === '/command') return COMMANDS;
  if (method === 'POST' && path === '/session') return newSession(directory, { title: body.title ?? 'New session', permission: body.permission ?? [] });
  if ((match = m(/^\/session\/([^/]+)$/))) {
    const session = sessions[match[1]];
    if (!session) return [404, { name: 'NotFoundError', data: { message: `Session not found: ${match[1]}` } }];
    if (method === 'PATCH') Object.assign(session, body.permission ? { permission: body.permission } : {}, body.title ? { title: body.title } : {}), save();
    return session;
  }
  if ((match = m(/^\/session\/([^/]+)\/(prompt_async|command|abort|fork|summarize)$/))) {
    const [, sessionID, action] = match;
    if (!sessions[sessionID]) return [404, { name: 'NotFoundError', data: { message: `Session not found: ${sessionID}` } }];
    if (action === 'summarize') return summarize(sessionID, directory, body);
    if (action === 'prompt_async' && turn?.sessionID === sessionID) return void promptInto(turn, body), [204, null];
    if (action === 'prompt_async') return void runTurn(sessionID, directory, body), [204, null];
    if (action === 'command') return runTurn(sessionID, directory, { agent: body.agent, parts: [{ text: `/${body.command} ${body.arguments}` }] }).then(() => ({ info: { id: 'msg_cmd' }, parts: [] }));
    if (action === 'abort') return turn?.sessionID === sessionID && turn.abort(), true;
    return newSession(directory, { title: `${sessions[sessionID].title} (fork #1)`, forkedFrom: sessionID });
  }
  if ((match = m(/^\/(permission|question)\/([^/]+)\/(reply|reject)$/))) {
    const resolve = waiting.get(match[2]);
    if (!resolve) return [404, { name: 'NotFoundError', data: { message: 'no such request' } }];
    waiting.delete(match[2]);
    resolve(match[3] === 'reject' ? { reply: 'reject' } : body);
    return true;
  }
  return [404, { name: 'NotFoundError', data: { message: `no route ${method} ${path}` } }];
}

const expected = `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const directory = decodeURIComponent(req.headers['x-opencode-directory'] ?? url.searchParams.get('directory') ?? '');
  if (req.headers.authorization !== expected) return res.writeHead(401).end('Unauthorized');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  log({ kind: 'request', method: req.method, path: url.pathname, directory, body });
  if (url.pathname === '/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
    listeners.add(res);
    return req.on('close', () => listeners.delete(res));
  }
  const answer = await route(req.method, url.pathname, body, directory);
  const [status, data] = Array.isArray(answer) && typeof answer[0] === 'number' ? answer : [200, answer];
  if (status === 204) return res.writeHead(204).end();
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`opencode server listening on http://127.0.0.1:${server.address().port}\n`);
});
process.on('SIGTERM', () => process.exit(0));
