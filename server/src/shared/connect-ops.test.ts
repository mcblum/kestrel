// The closed list of what a phone may ask, and the envelope its frames travel in (shared/connect-ops.ts).
import { describe, expect, it } from 'vitest';
import { checkEnvelope, checkRequest, CONNECT_OP_NAMES, CONNECT_OPS, CONNECT_PROTOCOL_VERSION, NEVER_REMOTE, PAGE_MAX, versionRefusal } from './connect-ops.ts';

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
  'session.seen': { sessionId: 's1' },
  'media.read': { sessionId: 's1', name: 'shot-1.png' },
  'attachment.read': { sessionId: 's1', attachmentId: 'a1' },
  'review.post': { sessionId: 's1', cardId: 'review-1', verdict: 'approve', withoutComment: true },
  'suggestion.answer': { sessionId: 's1', suggestionId: 'g1', button: 'accept' },
  'suggestion.dismiss': { sessionId: 's1', suggestionId: 'g1' },
  'suggestion.undo': { sessionId: 's1', suggestionId: 'g1' },
};

describe('the operations', () => {
  it('are the ones in the spec, each saying what it maps to', () => {
    expect([...CONNECT_OP_NAMES].sort()).toEqual(Object.keys(GOOD).sort());
    for (const op of CONNECT_OP_NAMES) expect(CONNECT_OPS[op].mapsTo).not.toBe('');
  });

  it.each(Object.entries(GOOD))('%s is allowed with good arguments', (op, args) => {
    expect(checkRequest({ op, args })).toMatchObject({ ok: true, value: { op } });
  });

  it.each(Object.entries(GOOD).filter(([, args]) => Object.keys(args).length > 0))('%s refuses a field it does not take', (op, args) => {
    const checked = checkRequest({ op, args: { ...args, permission: 'bypass' } });
    expect(checked).toEqual({ ok: false, reason: `${op} takes no permission.` });
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
  it('starts no session, and edits none by hand (Matt, 2026-11-22)', () => {
    for (const op of ['session.start', 'session.rename', 'session.move', 'session.archive', 'session.model', 'session.permission']) {
      expect(checkRequest({ op, args: {} })).toEqual({ ok: false, reason: NEVER_REMOTE[op] });
    }
    expect(NEVER_REMOTE['session.start']).toMatch(/^Sessions are started at the desk/);
  });

  it.each(Object.keys(NEVER_REMOTE))('refuses %s with its own reason', (op) => {
    expect(checkRequest({ op, args: {} })).toEqual({ ok: false, reason: NEVER_REMOTE[op] });
    expect(checkRequest({ op: `${op}.anything`, args: {} })).toEqual({ ok: false, reason: NEVER_REMOTE[op] });
  });

  it.each(['session.delete', 'session.fork', 'projects.add', 'state.write', '__proto__', 'constructor', 'toString'])('refuses %s, which is not on the list', (op) => {
    const checked = checkRequest({ op, args: {} });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toMatch(/not something Kestrel Connect does/);
  });

  it('refuses a body that is no request', () => {
    expect(checkRequest(null).ok).toBe(false);
    expect(checkRequest({ op: 'state.read', args: [] })).toEqual({ ok: false, reason: 'args must be an object.' });
  });
});
