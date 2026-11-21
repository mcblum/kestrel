// The attachments store: what an upload may be, where it lands, how a draft becomes a session's,
// and what is cleaned up. Everything on a temporary data dir.
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTACHMENT_MAX_FILE_BYTES, ATTACHMENT_MAX_MESSAGE_BYTES } from '../shared/attachments.ts';
import { GONE, AttachmentStore } from './store.ts';
import { mediaTypeOf, sanitizeName, sniffImage } from './naming.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const store = () => new AttachmentStore(realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-attach-'))));

describe('upload checks', () => {
  it('refuses an empty file and one over the per-file limit', () => {
    const s = store();
    expect(() => s.saveDraft('d1', { name: 'a.txt' }, Buffer.alloc(0))).toThrow(/empty/);
    expect(() => s.saveDraft('d1', { name: 'big.bin' }, Buffer.alloc(ATTACHMENT_MAX_FILE_BYTES + 1))).toThrow(/at most 20 MB/);
  });

  it('keeps only a safe last path segment as the name', () => {
    expect(sanitizeName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeName('C:\\Users\\me\\notes.txt')).toBe('notes.txt');
    expect(sanitizeName('..')).toBe('attachment');
    expect(sanitizeName('.hidden')).toBe('hidden');
    expect(sanitizeName('a\u0000b:c.txt')).toBe('a_b_c.txt');
    const long = sanitizeName(`${'x'.repeat(300)}.png`);
    expect(long).toHaveLength(120);
    expect(long.endsWith('.png')).toBe(true);
  });

  it('stores a traversal name inside the draft, never outside', () => {
    const s = store();
    const a = s.saveDraft('d1', { name: '../../../outside.txt' }, Buffer.from('hi'));
    expect(a.name).toBe('outside.txt');
    expect(readdirSync(join(s.root, 'drafts', 'd1', a.id))).toContain('outside.txt');
    expect(existsSync(join(s.root, 'outside.txt'))).toBe(false);
  });

  it('refuses draft ids and file ids that could be paths', () => {
    const s = store();
    expect(() => s.saveDraft('../x', { name: 'a.txt' }, Buffer.from('a'))).toThrow(/draft id/);
    expect(s.removeDraftFile('d1', '../../sessions')).toBe(false);
    expect(s.file('s1', '..')).toBeNull();
    expect(s.file('../s1', 'x')).toBeNull();
  });

  it('believes the bytes, not the declared type, about what is a picture', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(mediaTypeOf('x.png', 'image/png', Buffer.from('not a picture'))).toBe('application/octet-stream');
    expect(mediaTypeOf('x.bin', 'text/plain', PNG)).toBe('image/png');
    expect(mediaTypeOf('report.pdf', undefined, Buffer.from('%PDF'))).toBe('application/pdf');
    const s = store();
    expect(s.saveDraft('d1', { name: 'fake.png', mediaType: 'image/png' }, Buffer.from('text')).kind).toBe('file');
    expect(s.saveDraft('d1', { name: 'shot.png', mediaType: 'image/png' }, PNG).kind).toBe('image');
  });

  it('keeps an absolute original path and drops anything else', () => {
    const s = store();
    expect(s.saveDraft('d1', { name: 'a.txt', path: '/Users/me/a.txt' }, Buffer.from('a')).path).toBe('/Users/me/a.txt');
    expect(s.saveDraft('d1', { name: 'a.txt', path: 'relative/a.txt' }, Buffer.from('a')).path).toBeUndefined();
  });
});

describe('a draft becomes a session’s', () => {
  it('moves the named files to the session, in the order given, and drops the empty draft', () => {
    const s = store();
    const a = s.saveDraft('d1', { name: 'a.txt' }, Buffer.from('aaa'));
    const b = s.saveDraft('d1', { name: 'b.png' }, PNG);
    const claimed = s.claim('sess-1', { draftId: 'd1', ids: [b.id, a.id] });
    expect(claimed.map((x) => x.name)).toEqual(['b.png', 'a.txt']);
    expect(existsSync(join(s.root, 'drafts', 'd1'))).toBe(false);
    const stored = s.file('sess-1', a.id)!;
    expect(stored.path).toBe(join(s.sessionDir('sess-1'), a.id, 'a.txt'));
    expect(readFileSync(stored.path, 'utf8')).toBe('aaa');
    expect(s.forAgent('sess-1', claimed).map((f) => f.file)).toEqual([join(s.sessionDir('sess-1'), b.id, 'b.png'), stored.path]);
  });

  it('refuses a file that is gone, and moves nothing then', () => {
    const s = store();
    const a = s.saveDraft('d1', { name: 'a.txt' }, Buffer.from('a'));
    expect(() => s.claim('sess-1', { draftId: 'd1', ids: [a.id, 'missing-id'] })).toThrow(GONE);
    expect(s.file('sess-1', a.id)).toBeNull();
    expect(s.removeDraftFile('d1', a.id)).toBe(true);
  });

  it('refuses a message over the total limit', () => {
    const s = store();
    const ids = Array.from({ length: 3 }, (_, i) => s.saveDraft('d1', { name: `f${i}.bin` }, Buffer.alloc(ATTACHMENT_MAX_MESSAGE_BYTES / 3 + 1)).id);
    expect(() => s.claim('sess-1', { draftId: 'd1', ids })).toThrow(/at most 50 MB/);
  });

  it('removes orphaned drafts on start and a discarded draft at once, but never a session’s files', () => {
    const s = store();
    const kept = s.saveDraft('d1', { name: 'kept.txt' }, Buffer.from('k'));
    s.claim('sess-1', { draftId: 'd1', ids: [kept.id] });
    s.saveDraft('d2', { name: 'orphan.txt' }, Buffer.from('o'));
    s.saveDraft('d3', { name: 'discarded.txt' }, Buffer.from('d'));
    s.removeDraft('d3');
    expect(readdirSync(join(s.root, 'drafts'))).toEqual(['d2']);
    s.cleanDrafts();
    expect(existsSync(join(s.root, 'drafts'))).toBe(false);
    expect(s.file('sess-1', kept.id)).not.toBeNull();
    s.removeSession('sess-1');
    expect(s.file('sess-1', kept.id)).toBeNull();
  });
});
