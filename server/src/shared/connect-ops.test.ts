// The closed list of what a phone may ask, and the envelope its frames travel in (shared/connect-ops.ts).
import { describe, expect, it } from 'vitest';
import { checkEnvelope, checkRequest, checkRequestFrom, CONNECT_OP_NAMES, CONNECT_OPS, deskOnly, CONNECT_PROTOCOL_VERSION, NEVER_REMOTE, PAGE_MAX, phoneRefusal, versionRefusal, BYPASS_FROM_ELSEWHERE } from './connect-ops.ts';

const frame = (over: Record<string, unknown> = {}) => ({ v: CONNECT_PROTOCOL_VERSION, from: 'phone-1', to: 'mac-1', kind: 'request', id: 'f1', body: 'ciphertext', ...over });

describe('the envelope', () => {
  it('takes a well-formed frame of every kind', () => {
    for (const kind of ['request', 'push', 'hello', 'bye']) expect(checkEnvelope(frame({ kind })).ok).toBe(true);
    expect(checkEnvelope(frame({ kind: 'response', replyTo: 'f0' }))).toEqual({ ok: true, value: frame({ kind: 'response', replyTo: 'f0' }) });
  });

  it.each([
    ['not an object', 'frame', /must be an object/],
    ['an array', [], /must be an object/],
    ['no version', frame({ v: undefined }), /protocol version/],
    ['a fractional version', frame({ v: 1.5 }), /protocol version/],
    ['version 0', frame({ v: 0 }), /protocol version/],
    ['no from', frame({ from: undefined }), /from/],
    ['a from that could be a path', frame({ from: '../x' }), /from/],
    ['no to', frame({ to: '' }), /to,/],
    ['an unknown kind', frame({ kind: 'command' }), /kind must be one of/],
    ['no id', frame({ id: undefined }), /needs id/],
    ['a response with no replyTo', frame({ kind: 'response' }), /replyTo/],
    ['a request with replyTo', frame({ replyTo: 'f0' }), /Only a response/],
    ['no body', (({ body: _b, ...f }) => f)(frame()), /needs a body/],
    ['a field it does not know', frame({ admin: true }), /nothing called admin/],
  ])('refuses %s, saying why', (_what, raw, reason) => {
    const checked = checkEnvelope(raw);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toMatch(reason);
  });

  it('refuses another version with a reason naming the side to update', () => {
    expect(versionRefusal(CONNECT_PROTOCOL_VERSION, 'your Mac')).toBeNull();
    expect(versionRefusal(CONNECT_PROTOCOL_VERSION + 1, 'your Mac')).toMatch(/^Update Kestrel on your Mac/);
    expect(versionRefusal(CONNECT_PROTOCOL_VERSION - 1 || 0, 'your Mac')).toMatch(/^Update Kestrel on this device/);
  });
});

/** Good arguments for every operation: the list and this table must name the same ones. */
const GOOD: Record<string, Record<string, unknown>> = {
  'state.read': {},
  'session.read': { sessionId: 's1', last: 20 },
  'session.watch': { sessionId: 's1' },
  'session.unwatch': { sessionId: 's1' },
  'session.attach': { draftId: 'd1', name: 'photo.png', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
  'session.reply': { sessionId: 's1', text: 'carry on' },
  'session.answer': { sessionId: 's1', requestId: 'r1', optionId: 'allow' },
  'session.stop': { sessionId: 's1' },
  'session.archive': { sessionId: 's1', archived: true, skipScript: false },
  'session.compact': { sessionId: 's1' },
  'reviews.read': {},
  'tickets.read': {},
  'autopilot.set': { sessionId: 's1', on: true, merge: false },
  'reviews.seen': { keys: ['github.com/acme/shop#1'], seen: true },
  'reviews.dismiss': { keys: ['github.com/acme/shop#1'], dismissed: false },
  'reviews.start': { key: 'github.com/acme/shop#1' },
  'tickets.seen': { keys: ['jira:acme/PLAT-1'], seen: false },
  'tickets.dismiss': { keys: ['jira:acme/PLAT-1'], dismissed: true },
  'tickets.statuses': { key: 'jira:acme/PLAT-1' },
  'tickets.move': { key: 'jira:acme/PLAT-1', to: 'In Review' },
  'tickets.comment': { key: 'jira:acme/PLAT-1', body: 'Looked at it from my phone.' },
  'tickets.detail': { key: 'jira:acme/PLAT-1' },
  'tickets.work': { key: 'jira:acme/PLAT-1' },
  'session.seen': { sessionId: 's1' },
  'session.start': { projectId: 'p1', text: 'go' },
  'session.startChoices': {},
  'media.read': { sessionId: 's1', name: 'shot-1.png' },
  'attachment.read': { sessionId: 's1', attachmentId: 'a1' },
  'review.post': { sessionId: 's1', cardId: 'review-1', verdict: 'approve', withoutComment: true },
  'suggestion.answer': { sessionId: 's1', suggestionId: 'g1', button: 'accept' },
  'suggestion.dismiss': { sessionId: 's1', suggestionId: 'g1' },
  'suggestion.undo': { sessionId: 's1', suggestionId: 'g1' },
  'pullRequests.read': {},
  'findings.act': { sessionId: 's1', cardId: 'c1', findingId: 'f1', action: 'answer', text: 'Yes, on purpose.' },
  'reviewEnd.act': { sessionId: 's1', cardId: 'c1', action: 'fix', findingIds: ['f1', 'f2'] },
  'setup.values': { requestId: 'r1', line: 'mcp:home-assistant', names: ['HOMEASSISTANT_URL', 'HOMEASSISTANT_TOKEN'] },
  'setup.values.withdraw': { requestId: 'r1' },
  'session.snapshot': { sessionId: 's1' },
  'session.details': { sessionId: 's1', section: 'pull-requests', refresh: true },
  'session.context': { sessionId: 's1' },
  'session.files': { sessionId: 's1', path: 'src' },
  'session.file': { sessionId: 's1', path: 'src/app.ts', folder: 'f1' },
  'session.document': { sessionId: 's1', path: 'README.md' },
  'session.documentPlace': { sessionId: 's1', path: 'README.md' },
  'session.raw': { sessionId: 's1', path: 'docs/shot.png' },
  'session.attachFile': { draftId: 'd1', name: 'notes.txt', mediaType: 'text/plain', data: 'aGk=' },
  'session.rename': { sessionId: 's1', title: 'Fix the login' },
  'session.delete': { sessionId: 's1' },
  'session.tag': { sessionId: 's1', tag: 'release', on: true },
  'session.role': { sessionId: 's1', role: 'build', brief: 'Wire it in.' },
  'session.reviewOf': { sessionId: 's1' },
  'session.review': { sessionId: 's1', comment: true },
  'session.fork': { sessionId: 's1', turn: 'm3' },
  'queue.send': { sessionId: 's1' },
  'queue.remove': { sessionId: 's1', messageId: 'q1' },
  'background.stop': { sessionId: 's1', taskId: 't1' },
  'command.output': { sessionId: 's1', commandId: 'c1' },
  'command.retry': { sessionId: 's1', commandId: 'c1' },
  'command.stop': { sessionId: 's1', commandId: 'c1' },
  'pr.prepare': { sessionId: 's1', generated: true },
  'pr.create': { sessionId: 's1', title: 'Fix', body: '', base: 'main', draft: false },
  'pr.mergePreview': { sessionId: 's1', number: 12 },
  'pr.merge': { sessionId: 's1', number: 12, sha: 'a'.repeat(40), base: 'main', method: 'squash' },
};

/** Every operation only a desktop of the keyring may ask (Matt, 2026-11-27, and onboarding.md 19.6). */
const DESK_ONLY = ['setup.values', 'setup.values.withdraw', 'session.snapshot', 'session.details', 'session.context', 'session.files', 'session.file', 'session.document', 'session.documentPlace', 'session.raw', 'session.attachFile', 'session.rename', 'session.delete', 'session.tag', 'session.role', 'session.reviewOf', 'session.review', 'session.fork', 'queue.send', 'queue.remove', 'background.stop', 'command.output', 'command.retry', 'command.stop', 'pr.prepare', 'pr.create', 'pr.mergePreview', 'pr.merge'];

describe('the operations', () => {
  it('are the ones in the spec, each saying what it maps to', () => {
    expect([...CONNECT_OP_NAMES].sort()).toEqual(Object.keys(GOOD).sort());
    for (const op of CONNECT_OP_NAMES) expect(CONNECT_OPS[op].mapsTo).not.toBe('');
  });

  it.each(Object.entries(GOOD))('%s is allowed with good arguments', (op, args) => {
    expect(checkRequest({ op, args })).toMatchObject({ ok: true, value: { op } });
  });

  it.each(Object.entries(GOOD).filter(([, args]) => Object.keys(args).length > 0))('%s refuses a field it does not take', (op, args) => {
    const checked = checkRequest({ op, args: { ...args, nonsense: 1 } });
    expect(checked).toEqual({ ok: false, reason: `${op} takes no nonsense.` });
  });

  it.each([
    ['session.read', { sessionId: 's1', last: PAGE_MAX + 1 }, /last must be a whole number/],
    ['session.read', { sessionId: 's1', last: 0 }, /last must be a whole number/],
    ['session.read', { sessionId: 's1', limit: 5 }, /limit goes with before/],
    ['session.read', { sessionId: 's1', before: 'm1', limit: 1.5 }, /limit must be a whole number/],
    ['session.read', { sessionId: '../etc' }, /sessionId must be an id/],
    ['session.attach', { draftId: 'd1', name: 'notes.txt', mediaType: 'text/plain', data: 'aGk=' }, /Only photos/],
    ['session.attach', { draftId: 'd1', name: 'p.png', mediaType: 'image/png', data: 'not base64!' }, /base64/],
    ['session.reply', { sessionId: 's1', text: '   ' }, /text must be non-empty/],
    ['session.reply', { sessionId: 's1', text: 'x'.repeat(20_001) }, /at most 20000/],
    ['session.reply', { sessionId: 's1', text: 'hi', attachments: ['a1'] }, /draftId must name the draft/],
    ['session.reply', { sessionId: 's1', text: 'hi', draftId: 'd1' }, /draftId goes with attachments/],
    ['session.answer', { sessionId: 's1', requestId: 'r1', answers: [] }, /answers must be an object/],
    ['review.post', { sessionId: 's1' }, /cardId must be an id/],
    ['reviews.seen', { keys: [], seen: true }, /keys must be a list of 1 to 200 keys/],
    ['reviews.dismiss', { keys: ['a'], dismissed: 'yes' }, /dismissed must be true or false/],
    ['tickets.seen', { keys: Array.from({ length: 201 }, (_, i) => `k${i}`), seen: true }, /keys must be a list/],
    ['tickets.move', { key: 'k1', to: '' }, /to must be non-empty/],
    ['tickets.comment', { key: 'k1', body: 'x'.repeat(20_001) }, /at most 20000/],
    ['tickets.work', { key: 'x'.repeat(301) }, /key must be a key of at most 300/],
    ['findings.act', { sessionId: 's1', cardId: 'c1', findingId: 'f1', action: 'post' }, /action must be one of: answer, fix, dismiss, restore/],
    ['findings.act', { sessionId: 's1', cardId: 'c1', findingId: 'f1', action: 'answer', text: 'x'.repeat(4_001) }, /at most 4000/],
    ['reviewEnd.act', { sessionId: 's1', cardId: 'c1', action: 'archive' }, /action must be one of: fix, close, reopen/],
    ['reviewEnd.act', { sessionId: 's1', cardId: 'c1', action: 'fix', findingIds: Array.from({ length: 51 }, (_, i) => `f${i}`) }, /at most 50 ids/],
  ])('%s refuses bad arguments with a reason', (op, args, reason) => {
    const checked = checkRequest({ op, args });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toMatch(reason);
  });

  it('lets a message with photos have no text', () => {
    expect(checkRequest({ op: 'session.reply', args: { sessionId: 's1', text: '', draftId: 'd1', attachments: ['a1'] } }).ok).toBe(true);
  });

  it('reads a page from its end by default, and N before a message', () => {
    expect(checkRequest({ op: 'session.read', args: { sessionId: 's1' } })).toMatchObject({ value: { args: { sessionId: 's1', page: { last: 50 } } } });
    expect(checkRequest({ op: 'session.read', args: { sessionId: 's1', before: 'm9' } })).toMatchObject({ value: { args: { page: { before: 'm9', limit: 50 } } } });
  });
});

describe('what a phone never does', () => {
  it('edits no session by hand (Matt, 2026-11-22)', () => {
    for (const op of ['session.rename', 'session.move', 'session.model', 'session.permission']) {
      expect(checkRequestFrom({ op, args: {} }, false)).toEqual({ ok: false, reason: NEVER_REMOTE[op] });
    }
    // Nor does a model or mode ride on a phone's message; Bypass is refused to anyone.
    expect(checkRequestFrom({ op: 'session.reply', args: { sessionId: 's1', text: 'go', model: 'opus' } }, false)).toEqual({ ok: false, reason: NEVER_REMOTE['session.model'] });
    expect(checkRequestFrom({ op: 'session.reply', args: { sessionId: 's1', text: 'go', effort: 'high' } }, false)).toEqual({ ok: false, reason: NEVER_REMOTE['session.model'] });
    expect(checkRequestFrom({ op: 'session.reply', args: { sessionId: 's1', text: 'go', permission: 'auto' } }, false)).toEqual({ ok: false, reason: NEVER_REMOTE['session.permission'] });
    expect(checkRequestFrom({ op: 'session.reply', args: { sessionId: 's1', text: 'go', permission: 'bypass' } }, true)).toEqual({ ok: false, reason: BYPASS_FROM_ELSEWHERE });
    expect(checkRequestFrom({ op: 'session.reply', args: { sessionId: 's1', text: 'go', model: 'opus', permission: 'plan', effort: 'high', fast: true } }, true)).toMatchObject({ ok: true });
  });
});

describe('session.archive: from anywhere (Matt, 2026-11-27: "Archive should be allowed from anywhere")', () => {
  it('is no longer what a phone never does, and a phone asks it as a desktop does', () => {
    expect(NEVER_REMOTE['session.archive']).toBeUndefined();
    for (const desktop of [false, true]) {
      expect(checkRequestFrom({ op: 'session.archive', args: { sessionId: 's1', archived: true } }, desktop)).toEqual({ ok: true, value: { op: 'session.archive', args: { sessionId: 's1', archived: true } } });
      expect(checkRequestFrom({ op: 'session.archive', args: { sessionId: 's1', archived: false } }, desktop)).toMatchObject({ ok: true });
    }
  });

  it('says archived or restored in so many words', () => {
    expect(checkRequest({ op: 'session.archive', args: { sessionId: 's1' } })).toEqual({ ok: false, reason: 'archived must be true or false.' });
    expect(checkRequest({ op: 'session.archive', args: { sessionId: 's1', archived: 'yes' } })).toEqual({ ok: false, reason: 'archived must be true or false.' });
    expect(checkRequest({ op: 'session.archive', args: { sessionId: 's1', archived: true, skipScript: 1 } })).toEqual({ ok: false, reason: 'skipScript must be true or false.' });
  });
});

describe('session.start: a new session from a blank page (A8, Matt 2026-11-24)', () => {
  it('is no longer refused as a desk-only thing', () => {
    expect(NEVER_REMOTE['session.start']).toBeUndefined();
  });

  it('takes a project, a preset or an agent, Manual or Auto, and the message with its photos', () => {
    expect(checkRequest({ op: 'session.start', args: { projectId: 'p1', folderId: 'f1', presetId: 'fast', mode: 'auto', text: 'go' } })).toEqual({ ok: true, value: { op: 'session.start', args: { projectId: 'p1', folderId: 'f1', presetId: 'fast', mode: 'auto', text: 'go' } } });
    expect(checkRequest({ op: 'session.start', args: { agent: 'opencode', model: 'anthropic/claude-x', text: 'go' } })).toMatchObject({ ok: true, value: { args: { agent: 'opencode', model: 'anthropic/claude-x' } } });
    expect(checkRequest({ op: 'session.start', args: { agent: 'claude', model: '', text: 'go' } })).toMatchObject({ ok: true, value: { args: { model: '' } } });
    expect(checkRequest({ op: 'session.start', args: { agent: 'codex', text: '', draftId: 'd1', attachments: ['a1'] } })).toMatchObject({ ok: true, value: { args: { agent: 'codex', text: '', draftId: 'd1', attachments: ['a1'] } } });
  });

  it.each([
    [{ text: 'go', mode: 'bypass' }, BYPASS_FROM_ELSEWHERE],
    [{ text: 'go', presetId: 'p', agent: 'claude' }, 'Give a preset or an agent, not both.'],
    [{ text: 'go', presetId: 'p', model: 'm' }, 'Give a preset or an agent, not both.'],
    [{ text: 'go', model: 'm' }, 'Say which agent the model is for.'],
    [{ text: 'go', agent: 'claude', model: 7 }, 'model must be a model id of at most 300 characters.'],
    [{ text: 'go', agent: 'gpt' }, 'agent must be one of: claude, codex, opencode.'],
    [{ text: 'go', mode: 'plan' }, 'mode must be one of: ask, auto.'],
    [{ text: ' ' }, 'text must be non-empty text of at most 20000 characters.'],
    [{ text: 'go', permission: 'auto' }, 'session.start takes no permission.'],
  ])('refuses %j with the reason', (args, reason) => {
    expect(checkRequest({ op: 'session.start', args })).toEqual({ ok: false, reason });
  });

  it.each(Object.keys(NEVER_REMOTE))('refuses %s with its own reason', (op) => {
    expect(checkRequestFrom({ op, args: {} }, false)).toEqual({ ok: false, reason: NEVER_REMOTE[op] });
    expect(checkRequest({ op: `${op}.anything`, args: {} })).toEqual({ ok: false, reason: NEVER_REMOTE[op] });
  });

  it.each(['session.delete', 'session.fork', 'projects.add', 'state.write', '__proto__', 'constructor', 'toString'])('refuses %s to a phone, which may not ask it', (op) => {
    const checked = checkRequestFrom({ op, args: {} }, false);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toMatch(/not something Kestrel Connect does/);
  });

  it('marks only the copying of set-up values desk-only (onboarding.md 19.6)', () => {
    expect(CONNECT_OP_NAMES.filter(deskOnly).sort()).toEqual([...DESK_ONLY].sort());
  });

  it.each(DESK_ONLY)('refuses %s to a phone, even with good arguments, as a phone was refused before', (op) => {
    expect(checkRequestFrom({ op, args: GOOD[op] }, false)).toEqual({ ok: false, reason: phoneRefusal(op as never) });
    expect(checkRequestFrom({ op, args: GOOD[op] }, true)).toMatchObject({ ok: true });
  });

  it('says what a phone was told before for each desk-only operation', () => {
    expect(phoneRefusal('setup.values')).toBe(NEVER_REMOTE.setup);
    expect(phoneRefusal('session.rename')).toBe(NEVER_REMOTE['session.rename']);
    expect(phoneRefusal('session.file')).toBe(NEVER_REMOTE.files);
    expect(phoneRefusal('session.details')).toMatch(/not something Kestrel Connect does/);
  });

  it.each([
    ['session.details', { sessionId: 's1', section: 'secrets' }, /section must be one of/],
    ['session.file', { sessionId: 's1', path: 'a\u0000b' }, /path must be a path/],
    ['session.attachFile', { draftId: 'd1', name: 'a.txt', mediaType: 'text plain', data: 'aGk=' }, /mediaType/],
    ['pr.merge', { sessionId: 's1', number: 1, sha: 'nope', base: 'main', method: 'merge' }, /sha must be/],
    ['pr.mergePreview', { sessionId: 's1', number: 0 }, /number must be/],
    ['session.role', { sessionId: 's1', role: 'review' }, /role must be one of/],
  ])('%s refuses %j', (op, args, reason) => {
    const checked = checkRequest({ op, args });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toMatch(reason);
  });

  it.each([
    [{ requestId: 'r1', line: 'agent:claude', names: ['A'] }, /line must name an MCP server's or a settings file's line/],
    [{ requestId: 'r1', line: 'mcp:x', names: [] }, /names must list 1 to 32/],
    [{ requestId: 'r1', line: 'mcp:x', names: ['A', 'A'] }, /names must list 1 to 32 different/],
    [{ requestId: 'r1', line: 'mcp:x', names: ['not a name'] }, /names must list/],
    [{ requestId: 'r1', line: 'mcp:x', names: Array.from({ length: 33 }, (_, i) => `N${i}`) }, /names must list 1 to 32/],
    [{ requestId: '../r', line: 'mcp:x', names: ['A'] }, /requestId must be an id/],
  ])('setup.values refuses %j', (args, reason) => {
    const checked = checkRequest({ op: 'setup.values', args });
    expect(checked.ok).toBe(false);
    expect(checked.ok ? '' : checked.reason).toMatch(reason);
  });

  it('refuses a body that is no request', () => {
    expect(checkRequest(null).ok).toBe(false);
    expect(checkRequest({ op: 'state.read', args: [] })).toEqual({ ok: false, reason: 'args must be an object.' });
  });
});
