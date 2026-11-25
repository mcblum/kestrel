// HTTP routes for What's new. Behind the same token, Origin and Host checks as every route; no
// Kestrel tool reaches them, so only the user changes the switch.
//
//   GET   /api/whats-new                          200 WhatsNewView
//   GET   /api/whats-new/notes/<release>          200 WhatsNewNotes | 404 { error }
//   GET   /api/whats-new/images/<name>            the picture's bytes | 404 { error }
//   GET   /api/whats-new/drawings/<name>.svg      200 { name, svg } (sanitized markup) | 404 { error }
//   PATCH /api/whats-new  { enabled: boolean }    200 WhatsNewView | 400 { error }
//   POST  /api/whats-new/shown { release, hash }  200 WhatsNewView | 400 { error }
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRelease, NOTES_PICTURE } from '../shared/whats-new.ts';
import { NOTES_DRAWING, sanitizeSvg } from '../shared/whats-new-svg.ts';
import type { NotesSource } from './notes.ts';
import type { WhatsNew } from './store.ts';

export type WhatsNewAnswer = { status: number; body: unknown } | { status: 200; bytes: Buffer; type: string };
type ReadBody = () => Promise<Record<string, unknown>>;

const PICTURE_TYPE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

async function picture(notes: NotesSource, name: string): Promise<WhatsNewAnswer> {
  if (!NOTES_PICTURE.test(name)) return { status: 404, body: { error: 'There is no such picture in the notes.' } };
  try {
    const bytes = await readFile(join(notes.dir, 'images', name));
    return { status: 200, bytes, type: PICTURE_TYPE[name.split('.').pop()!.toLowerCase()]! };
  } catch {
    return { status: 404, body: { error: `The notes have no picture ${name}.` } };
  }
}

/**
 * A drawing of the notes, as markup the page puts inline (so it follows the theme). Never served as an
 * SVG document, which a browser would run; only as sanitized text inside JSON.
 */
async function drawing(notes: NotesSource, name: string): Promise<WhatsNewAnswer> {
  if (!NOTES_DRAWING.test(name)) return { status: 404, body: { error: 'There is no such drawing in the notes.' } };
  let source: string;
  try {
    source = await readFile(join(notes.dir, 'images', name), 'utf8');
  } catch {
    return { status: 404, body: { error: `The notes have no drawing ${name}.` } };
  }
  const svg = sanitizeSvg(source);
  return svg === null ? { status: 404, body: { error: `${name} is not a plain SVG drawing, so it is not shown.` } } : { status: 200, body: { name, svg } };
}

export async function whatsNewRoute(parts: readonly string[], method: string, readBody: ReadBody, whatsNew: WhatsNew, notes: NotesSource): Promise<WhatsNewAnswer | null> {
  if (parts[1] !== 'whats-new') return null;
  if (parts.length === 2 && method === 'GET') return { status: 200, body: await whatsNew.view() };
  if (parts.length === 2 && method === 'PATCH') {
    const body = await readBody();
    if (typeof body.enabled !== 'boolean') return { status: 400, body: { error: 'enabled must be true or false.' } };
    return { status: 200, body: await whatsNew.setEnabled(body.enabled) };
  }
  if (parts.length === 3 && parts[2] === 'shown' && method === 'POST') {
    const body = await readBody();
    const { release, hash } = body;
    if (!isRelease(release) || typeof hash !== 'string') return { status: 400, body: { error: 'Give the release and hash of the notes that were shown.' } };
    const read = await notes.read(release);
    if (!read || read.hash !== hash) return { status: 400, body: { error: `Those are not the notes this copy has for ${release}.` } };
    return { status: 200, body: await whatsNew.markShown({ release, hash }) };
  }
  if (parts.length === 4 && parts[2] === 'notes' && method === 'GET') {
    const release = decodeURIComponent(parts[3]!);
    const read = isRelease(release) ? await notes.read(release) : null;
    return read ? { status: 200, body: read } : { status: 404, body: { error: `This copy of Kestrel has no notes for ${release}.` } };
  }
  if (parts.length === 4 && parts[2] === 'images' && method === 'GET') return picture(notes, decodeURIComponent(parts[3]!));
  if (parts.length === 4 && parts[2] === 'drawings' && method === 'GET') return drawing(notes, decodeURIComponent(parts[3]!));
  return null;
}
