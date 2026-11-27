// A stand-in for `codex app-server` for the adapter's lifecycle tests: the same JSON-RPC over stdio,
// with behaviour picked by FAKE_CODEX_SCENARIO. Every message it receives is appended to
// FAKE_CODEX_LOG (one JSON per line) so a test can check what Kestrel sent. Nothing here waits on a
// clock: each step answers a message.
//
// Scenarios:
//   reply      a turn streams "hel" + "lo" and completes
//   approval   a turn asks to run `touch x` and completes with the decision as text
//   command    a turn asks to run the message's text, wrapped as Codex wraps it (`/bin/zsh -lc '…'`),
//              as a command leaving the sandbox; it completes with "ran it" or "skipped it"
//   git        a turn runs the message's text as a command that writes the checkout's git folders
//              (`git commit`). As codex-cli 0.167.2 does: under `untrusted` it asks; in workspace-write
//              it runs without asking only when every git folder of the working folder is a writable
//              root (`.git` is read-only otherwise, even inside the folder), else it asks to leave the
//              sandbox; with full access it runs.
//   stop       a turn starts and only ends when interrupted
//   crash      the process writes to stderr and exits during the turn
//   signedout  account/read says nobody is signed in
//   plan       a turn writes a plan item; the next turn (default mode) says "implemented"
//   edit       a turn applies a patch adding FAKE_CODEX_EDIT (an absolute path). Whether Codex asks
//              first follows its own rules, as codex-cli 0.167.2 does (`assessPatch` below): the
//              recorded exchanges in this folder (manual.jsonl, outside.jsonl) show the shapes.
//              FAKE_CODEX_TMP stands for the system temp folder workspace-write lets it write.
// A steer when no turn is running is refused, as Codex refuses it; FAKE_CODEX_STEER=refuse refuses
// every steer (a turn that ended before the steer arrived). A steer that is taken is given to the
// model at once: a `userMessage` item with the steer's clientUserMessageId as its clientId.
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

/** The account's plan, as `account/rateLimits/read` answers it (codex-cli 0.167.2's RateLimitSnapshot). */
const RATE_LIMITS = { limitId: 'codex', limitName: null, normalModelSlug: null, primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1795010000 }, secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1795400000 }, credits: null, individualLimit: null, spendControlReached: null, planType: 'plus', rateLimitReachedType: null };
const scenario = process.env.FAKE_CODEX_SCENARIO ?? 'reply';
const logFile = process.env.FAKE_CODEX_LOG;
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const notify = (method, params) => send({ method, params });
let THREAD = 'thread-1';
let turnSeq = 0;
let serverRequestId = 100;
const waiting = new Map();
let currentTurn = null;
let cwd = null;

const within = (path, root) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);

/**
 * What Codex does with a patch, given the turn's settings: 'ask' the client, have its own reviewer
 * 'review' it (the client is never asked), 'apply' it without asking (inside the sandbox), or 'reject'.
 * Under `untrusted` every patch is asked about; otherwise one inside the writable folders just runs.
 */
function assessPatch(path, p) {
  if (p.approvalPolicy === 'untrusted') return 'ask';
  const sandbox = p.sandboxPolicy ?? {};
  const tmp = process.env.FAKE_CODEX_TMP;
  const roots = [cwd, ...(sandbox.writableRoots ?? []), ...(sandbox.excludeTmpdirEnvVar || !tmp ? [] : [tmp])].filter(Boolean);
  if (sandbox.type === 'dangerFullAccess' || (sandbox.type === 'workspaceWrite' && roots.some((r) => within(path, r)))) return 'apply';
  if (p.approvalPolicy === 'never') return 'reject';
  return p.approvalsReviewer === 'auto_review' ? 'review' : 'ask';
}

/** The folders git writes for the checkout in `dir`: its `.git`, or a linked worktree's own git folder and the repository's. */
function gitFoldersOf(dir) {
  const own = join(dir, '.git');
  if (!existsSync(own)) return [];
  if (statSync(own).isDirectory()) return [realpathSync(own)];
  const gitDir = realpathSync(resolve(dir, /^gitdir:\s*(.+)$/m.exec(readFileSync(own, 'utf8'))[1].trim()));
  return [gitDir, dirname(dirname(gitDir))];
}

/** Whether a command that writes the git folders runs without asking, given the turn's settings. */
function gitRunsUnasked(p) {
  if (p.approvalPolicy === 'untrusted') return false;
  const sandbox = p.sandboxPolicy ?? {};
  if (sandbox.type === 'dangerFullAccess') return true;
  const roots = sandbox.writableRoots ?? [];
  return sandbox.type === 'workspaceWrite' && gitFoldersOf(cwd).every((folder) => roots.some((r) => within(folder, r)));
}

async function patchTurn(turnId, params) {
  const path = process.env.FAKE_CODEX_EDIT;
  const itemId = `patch-${turnId}`;
  const item = (status) => ({ type: 'fileChange', id: itemId, changes: [{ path, kind: { type: 'add' }, diff: 'x\n' }], status });
  notify('item/started', { threadId: THREAD, turnId, item: item('inProgress') });
  const how = assessPatch(path, params);
  let applied = how === 'apply' || how === 'review';
  if (how === 'review') notify('item/autoApprovalReview/started', { threadId: THREAD, turnId, reviewId: 'r-1', targetItemId: itemId, review: { status: 'inProgress' } });
  if (how === 'ask') {
    const answer = await ask('item/fileChange/requestApproval', { threadId: THREAD, turnId, itemId, startedAtMs: 0, reason: null, grantRoot: null });
    applied = answer.result?.decision === 'accept';
  }
  if (applied) writeFileSync(path, 'x\n');
  notify('item/completed', { threadId: THREAD, turnId, item: item(applied ? 'completed' : 'declined') });
  // The turn ends at once, as it did live: the model only says the patch was rejected.
  message(turnId, `msg-${turnId}`, applied ? 'wrote it' : 'patch rejected by user');
  return complete(turnId, 'completed');
}

function ask(method, params) {
  const id = serverRequestId++;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

function complete(turnId, status, items = []) {
  notify('turn/completed', { threadId: THREAD, turn: { id: turnId, items, status, error: null } });
  currentTurn = null;
}

function message(turnId, id, text) {
  notify('item/started', { threadId: THREAD, turnId, item: { type: 'agentMessage', id, text: '' } });
  notify('item/agentMessage/delta', { threadId: THREAD, turnId, itemId: id, delta: text });
  notify('item/completed', { threadId: THREAD, turnId, item: { type: 'agentMessage', id, text } });
}

async function runTurn(turnId, params) {
  const text = params.input?.[0]?.text ?? '';
  if (scenario === 'crash') {
    process.stderr.write('\u001b[31mERROR\u001b[0m codex_core: the model connection broke\n');
    process.exit(3);
  }
  if (scenario === 'stop') return; // ends on turn/interrupt
  if (scenario === 'edit') return patchTurn(turnId, params);
  if (scenario === 'git') {
    const command = `/bin/zsh -lc '${text}'`;
    const unasked = gitRunsUnasked(params);
    const answer = unasked ? null : await ask('item/commandExecution/requestApproval', { threadId: THREAD, turnId, itemId: `exec-${turnId}`, command, cwd, reason: 'Allow Git to write its index and create the commit?' });
    message(turnId, `msg-${turnId}`, unasked || answer.result?.decision === 'accept' ? 'ran it' : 'skipped it');
    return complete(turnId, 'completed');
  }
  if (scenario === 'command') {
    const command = `/bin/zsh -lc '${text}'`;
    const answer = await ask('item/commandExecution/requestApproval', { threadId: THREAD, turnId, itemId: `exec-${turnId}`, command, cwd, reason: 'needs to write outside the sandbox' });
    message(turnId, `msg-${turnId}`, answer.result?.decision === 'accept' ? 'ran it' : 'skipped it');
    return complete(turnId, 'completed');
  }
  if (scenario === 'approval') {
    notify('item/started', { threadId: THREAD, turnId, item: { type: 'commandExecution', id: 'exec-1', command: "/bin/zsh -lc 'touch x'", commandActions: [{ type: 'unknown', command: 'touch x' }], status: 'inProgress' } });
    const answer = await ask('item/commandExecution/requestApproval', { threadId: THREAD, turnId, itemId: 'exec-1', command: "/bin/zsh -lc 'touch x'", commandActions: [{ type: 'unknown', command: 'touch x' }] });
    const accepted = answer.result?.decision === 'accept';
    notify('item/completed', { threadId: THREAD, turnId, item: { type: 'commandExecution', id: 'exec-1', command: "/bin/zsh -lc 'touch x'", commandActions: [{ type: 'unknown', command: 'touch x' }], status: accepted ? 'completed' : 'declined', exitCode: accepted ? 0 : null, aggregatedOutput: '' } });
    message(turnId, 'msg-a', accepted ? 'ran it' : 'skipped it');
    return complete(turnId, 'completed');
  }
  if (scenario === 'plan' && params.collaborationMode?.mode === 'plan') {
    notify('item/completed', { threadId: THREAD, turnId, item: { type: 'plan', id: `${turnId}-plan`, text: '1. Write README.md' } });
    return complete(turnId, 'completed');
  }
  if (scenario === 'plan') {
    message(turnId, `msg-${turnId}`, `implemented: ${text}`);
    return complete(turnId, 'completed');
  }
  notify('item/started', { threadId: THREAD, turnId, item: { type: 'agentMessage', id: 'msg-1', text: '' } });
  notify('item/agentMessage/delta', { threadId: THREAD, turnId, itemId: 'msg-1', delta: 'hel' });
  notify('item/agentMessage/delta', { threadId: THREAD, turnId, itemId: 'msg-1', delta: 'lo' });
  notify('item/completed', { threadId: THREAD, turnId, item: { type: 'agentMessage', id: 'msg-1', text: 'hello' } });
  const usage = { totalTokens: 1000, inputTokens: 990, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 };
  notify('thread/tokenUsage/updated', { threadId: THREAD, turnId, tokenUsage: { total: usage, last: usage, modelContextWindow: 10000 } });
  // A sparse rate-limit update, as codex-cli 0.167 sends one while a turn runs (RateLimitSnapshot): the 5-hour window only.
  notify('account/rateLimits/updated', { rateLimits: { ...RATE_LIMITS, secondary: null, primary: { ...RATE_LIMITS.primary, usedPercent: 38 } } });
  complete(turnId, 'completed');
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (logFile) appendFileSync(logFile, `${line}\n`);
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method) {
    const resolve = waiting.get(msg.id);
    waiting.delete(msg.id);
    return resolve?.(msg);
  }
  const reply = (result) => send({ id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return reply({ userAgent: 'fake/0.0.0', codexHome: '/nonexistent', platformFamily: 'unix', platformOs: 'macos' });
    case 'initialized':
      return;
    case 'account/rateLimits/read':
      return reply({ ordinaryUsageAllowed: true, rateLimits: RATE_LIMITS, rateLimitsByLimitId: { codex: RATE_LIMITS }, rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null });
    case 'account/read':
      return reply(scenario === 'signedout' ? { account: null, requiresOpenaiAuth: true } : { account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true });
    case 'model/list':
      return reply({
        data: [
          {
            id: 'fake-1',
            model: 'fake-1',
            displayName: 'Fake One',
            description: 'The only one.',
            hidden: false,
            isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'high', description: '' }],
            defaultReasoningEffort: 'low',
            serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }],
          },
        ],
        nextCursor: null,
      });
    case 'config/read':
      return reply({ config: { model: null }, origins: {}, layers: null });
    case 'thread/start':
    case 'thread/resume':
      THREAD = msg.params?.threadId ?? THREAD;
      cwd = msg.params?.cwd ?? cwd;
      return reply({ thread: { id: THREAD }, model: 'fake-1' });
    case 'thread/fork':
      if (msg.params?.threadId === 'missing') return send({ id: msg.id, error: { code: -32600, message: 'no rollout found for thread missing' } });
      return reply({ thread: { id: `${msg.params?.threadId}-fork` }, model: 'fake-1', cwd: msg.params?.cwd });
    case 'mcpServerStatus/list':
      return reply({ data: [], nextCursor: null });
    case 'turn/start': {
      const turnId = `turn-${++turnSeq}`;
      currentTurn = turnId;
      reply({ turn: { id: turnId, items: [], status: 'inProgress', error: null } });
      notify('turn/started', { threadId: THREAD, turn: { id: turnId, items: [], status: 'inProgress' } });
      return void runTurn(turnId, msg.params);
    }
    case 'thread/compact/start': {
      // As codex-cli 0.167.2: an empty answer, then a turn of its own with a contextCompaction item.
      if (msg.params?.threadId !== THREAD) return send({ id: msg.id, error: { code: -32600, message: `thread not found: ${msg.params?.threadId}` } });
      const turnId = `turn-${++turnSeq}`;
      currentTurn = turnId;
      reply({});
      notify('turn/started', { threadId: THREAD, turn: { id: turnId, items: [], status: 'inProgress' } });
      if (scenario === 'stop') return; // ends on turn/interrupt
      const item = { type: 'contextCompaction', id: `compact-${turnId}` };
      notify('item/started', { threadId: THREAD, turnId, item });
      notify('item/completed', { threadId: THREAD, turnId, item });
      const usage = { totalTokens: 200, inputTokens: 200, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
      notify('thread/tokenUsage/updated', { threadId: THREAD, turnId, tokenUsage: { total: usage, last: usage, modelContextWindow: 10000 } });
      return complete(turnId, 'completed');
    }
    case 'turn/steer':
      if (process.env.FAKE_CODEX_STEER === 'refuse' || currentTurn !== msg.params.expectedTurnId) return send({ id: msg.id, error: { code: -32600, message: 'no active turn to steer' } });
      reply({ turnId: msg.params.expectedTurnId });
      if (msg.params.clientUserMessageId) {
        const item = { type: 'userMessage', id: `user-${msg.id}`, clientId: msg.params.clientUserMessageId, content: msg.params.input };
        notify('item/started', { threadId: THREAD, turnId: currentTurn, item });
        notify('item/completed', { threadId: THREAD, turnId: currentTurn, item });
      }
      return;
    case 'turn/interrupt':
      reply({});
      if (currentTurn) complete(currentTurn, 'interrupted');
      return;
    default:
      return send({ id: msg.id, error: { code: -32601, message: `fake does not know ${msg.method}` } });
  }
});
