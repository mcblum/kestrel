import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { askServer, createQuitGuard, namesText, parseQuitCheck, quitDecision, quitDialog, shellPlatform, SYSTEM_ANSWER_MS, systemEnd } from './quit-guard.mjs';

const s = (id, title = `Task ${id}`) => ({ id, title });
const none = { working: [] };
const PLATFORMS = ['mac', 'windows', 'linux'];

test('nothing working: quit at once, on every platform and for every reason', () => {
  for (const platform of PLATFORMS) for (const purpose of ['quit', 'update', 'system']) assert.deepEqual(quitDecision(none, purpose, platform), { action: 'go' });
});

test('an answer that still lists sessions waiting on the user is read for its working ones alone', () => {
  assert.deepEqual(parseQuitCheck({ working: [], waiting: [s('a')] }), { working: [] });
});

test('the server not answering never traps the user: quit without asking', () => {
  for (const platform of PLATFORMS) assert.deepEqual(quitDecision(null, 'quit', platform), { action: 'go' });
});

test('some working: ask, naming one by title, and Cancel is the default and Escape', () => {
  const decision = quitDecision({ working: [s('a', 'Fix login')] }, 'quit', 'windows');
  assert.equal(decision.action, 'ask');
  assert.equal(decision.timeoutMs, null);
  const { dialog } = decision;
  assert.equal(dialog.message, '“Fix login” is still working. Quit Kestrel?');
  assert.deepEqual(dialog.buttons, ['Cancel', 'Quit anyway']);
  assert.equal(dialog.defaultId, 0);
  assert.equal(dialog.cancelId, 0);
  assert.match(dialog.detail, /Quitting stops it now: the turn is cut off/);
  assert.match(dialog.detail, /Messages you queued are kept/);
});

test('many working: counted in the headline, the first few named, then "and N more"', () => {
  const dialog = quitDialog({ working: ['a', 'b', 'c', 'd', 'e'].map((x) => s(x)) }, 'quit');
  assert.equal(dialog.message, '5 sessions are still working. Quit Kestrel?');
  assert.match(dialog.detail, /^Working: “Task a”, “Task b”, “Task c” and 2 more\./);
  assert.match(dialog.detail, /stops them now/);
});

test('names: one, two, up to three, then a count', () => {
  assert.equal(namesText(['A']), '“A”');
  assert.equal(namesText(['A', 'B']), '“A” and “B”');
  assert.equal(namesText(['A', 'B', 'C']), '“A”, “B” and “C”');
  assert.equal(namesText(['A', 'B', 'C', 'D']), '“A”, “B”, “C” and 1 more');
});

test('an update restart is worded as one, and the other choice is to install later', () => {
  const dialog = quitDialog({ working: [s('a', 'Fix login')] }, 'update');
  assert.equal(dialog.message, '“Fix login” is still working. Restart to update now?');
  assert.deepEqual(dialog.buttons, ['Install later', 'Restart anyway']);
  assert.match(dialog.detail, /^Restarting stops it now/);
  assert.match(dialog.detail, /installed when you next quit Kestrel/);
});

test('logout or shutdown: asked with a time limit on macOS and Windows; Linux quits cleanly, with the reason', () => {
  const working = { working: [s('a')] };
  for (const platform of ['mac', 'windows']) {
    const decision = quitDecision(working, 'system', platform);
    assert.equal(decision.action, 'ask');
    assert.equal(decision.timeoutMs, SYSTEM_ANSWER_MS);
    assert.match(decision.dialog.detail, /Without an answer in 20 seconds, Kestrel quits/);
  }
  assert.deepEqual(quitDecision(working, 'system', 'linux'), { action: 'go' });
  assert.match(systemEnd('linux').reason, /five seconds/);
});

test('the shell names its platform as the server does', () => {
  assert.equal(shellPlatform('darwin'), 'mac');
  assert.equal(shellPlatform('win32'), 'windows');
  assert.equal(shellPlatform('linux'), 'linux');
  assert.equal(shellPlatform('freebsd'), 'linux');
});

test('an answer that is not one is not trusted', () => {
  assert.equal(parseQuitCheck({ working: 'x' }), null);
  assert.equal(parseQuitCheck({ working: [{ id: 1 }]}), null);
  assert.equal(parseQuitCheck(null), null);
  assert.deepEqual(parseQuitCheck({ working: [s('a')], waiting: [], extra: 1 }), { working: [s('a')] });
});

/** A stand-in server that answers /api/quit-check the way `answer` says. */
async function serve(answer) {
  const server = createServer((req, res) => answer(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))) };
}

test('asks the server with the launch token, and reads its answer', async () => {
  const { port, close } = await serve((req, res) => {
    const ok = req.url === '/api/quit-check' && req.headers.authorization === 'Bearer t0k';
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' }).end(JSON.stringify(ok ? { working: [s('a')] } : { error: 'no' }));
  });
  try {
    assert.deepEqual(await askServer({ port, token: 't0k' }), { working: [s('a')] });
    assert.equal(await askServer({ port, token: 'wrong' }), null);
  } finally {
    await close();
  }
});

test('a server that does not answer in time, or is not there, is null', async () => {
  const { port, close } = await serve(() => {}); // never answers
  try {
    const started = Date.now();
    assert.equal(await askServer({ port, token: 't', timeoutMs: 150 }), null);
    assert.ok(Date.now() - started < 2000);
  } finally {
    await close();
  }
  assert.equal(await askServer({ port, token: 't' }), null, 'nothing listens there now');
  assert.equal(await askServer({ port: 0, token: 't' }), null);
});

/** A guard over a fixed server answer; `answers` are what the dialog says, in order. */
function guardWith(check, answers, platform = 'mac') {
  const shown = [];
  const guard = createQuitGuard({
    platform,
    ask: async () => check,
    show: async (dialog, opts) => (shown.push({ dialog, opts }), answers.shift()),
    wait: () => new Promise(() => {}),
  });
  return { guard, shown };
}

test('the guard: nothing working goes without a dialog; Cancel stays; Quit anyway goes', async () => {
  const quiet = guardWith(none, []);
  assert.equal(await quiet.guard.confirm('quit'), true);
  assert.equal(quiet.shown.length, 0);
  const working = { working: [s('a')] };
  assert.equal(await guardWith(working, [{ response: 0 }]).guard.confirm('quit'), false);
  assert.equal(await guardWith(working, [{ response: 1 }]).guard.confirm('quit'), true);
  assert.equal(await guardWith(working, [{ response: 0 }]).guard.confirm('update'), false, 'Install later');
});

test('the guard: unanswered at logout or shutdown, it goes; a second quit shares the open dialog', async () => {
  const working = { working: [s('a')] };
  const system = guardWith(working, [{ timedOut: true }]);
  assert.equal(await system.guard.confirm('system'), true);
  assert.equal(system.shown[0].opts.timeoutMs, SYSTEM_ANSWER_MS);

  let answer;
  const shown = [];
  const guard = createQuitGuard({ platform: 'mac', ask: async () => working, show: (dialog) => (shown.push(dialog), new Promise((r) => (answer = r))), wait: () => new Promise(() => {}) });
  const first = guard.confirm('quit');
  const second = guard.confirm('quit');
  await new Promise((r) => setImmediate(r));
  assert.equal(shown.length, 1);
  answer({ response: 1 });
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
});

test('the guard: the system ending while a quit dialog waits does not wait past its own limit', async () => {
  const guard = createQuitGuard({ platform: 'windows', ask: async () => ({ working: [s('a')] }), show: () => new Promise(() => {}), wait: async () => {} });
  void guard.confirm('quit');
  await new Promise((r) => setImmediate(r));
  assert.equal(await guard.confirm('system'), true);
});
