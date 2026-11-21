// HTTP routes for attached files. Shaped like organize-api.ts: the caller hands over the path
// parts and the request, and gets an answer, or null when the path is not one of these.
//
//   POST   /api/attachments/drafts/:draftId?name=…&path=…
//                                                 body: the file's bytes; Content-Type its type;
//                                                 `name` its name, `path` where it came from (optional)
//                                                 → 201 Attachment
// Name and path ride in the query, not in headers of our own: a server too old to have this route
// then answers 404 (which the UI reads as "restart Kestrel") instead of failing the CORS preflight.
//   DELETE /api/attachments/drafts/:draftId/:id   drops one file from the draft; 204
//   DELETE /api/attachments/drafts/:draftId       drops the whole draft; 204
//   GET    /api/sessions/:id/attachments/:attId   the stored file's bytes
//
// A message names its files as `{ draftId, attachments: [id, …] }` on reply and on start; `draftRefs` reads that.
import type { IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { ATTACHMENT_MAX_FILE_BYTES, ATTACHMENT_MAX_PER_MESSAGE, formatSize } from '../shared/attachments.ts';
import { Refused } from '../workspace.ts';
import { isSafeId } from './naming.ts';
import type { AttachmentStore, DraftRefs } from './store.ts';

export type AttachmentAnswer = { status: number; body?: unknown } | { status: 200; bytes: Buffer; type: string };

const TOO_LARGE = `That file is larger than ${formatSize(ATTACHMENT_MAX_FILE_BYTES)}, the most one file can be.`;

/** The body's bytes, or null when it is over the limit (read to the end and dropped, so the answer still arrives). */
async function readBytes(req: IncomingMessage, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= max) chunks.push(chunk as Buffer);
  }
  return size > max ? null : Buffer.concat(chunks);
}

async function upload(req: IncomingMessage, url: URL, draftId: string, store: AttachmentStore): Promise<AttachmentAnswer> {
  const name = url.searchParams.get('name');
  if (!name?.trim()) return { status: 400, body: { error: 'The file needs a name (?name=).' } };
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > ATTACHMENT_MAX_FILE_BYTES) req.resume();
  const bytes = declared > ATTACHMENT_MAX_FILE_BYTES ? null : await readBytes(req, ATTACHMENT_MAX_FILE_BYTES);
  if (!bytes) return { status: 413, body: { error: TOO_LARGE } };
  const attachment = store.saveDraft(draftId, { name, mediaType: req.headers['content-type'], path: url.searchParams.get('path') ?? undefined }, bytes);
  return { status: 201, body: attachment };
}

/** Answers an attachment route, or null when the path is not one. Refusals are thrown as `Refused` (409). */
export async function attachmentRoute(parts: readonly string[], method: string, req: IncomingMessage, url: URL, store: AttachmentStore): Promise<AttachmentAnswer | null> {
  if (parts[1] === 'sessions' && parts[3] === 'attachments' && parts.length === 5 && method === 'GET') {
    const stored = store.file(parts[2]!, parts[4]!);
    if (!stored) return { status: 404, body: { error: 'No such attachment' } };
    // Only pictures are served as what they are; anything else is plain bytes, never run or rendered.
    const type = stored.attachment.kind === 'image' ? stored.attachment.mediaType : 'application/octet-stream';
    return { status: 200, bytes: readFileSync(stored.path), type };
  }
  if (parts[1] !== 'attachments' || parts[2] !== 'drafts' || parts.length < 4) return null;
  const draftId = parts[3]!;
  if (!isSafeId(draftId)) return { status: 400, body: { error: 'That draft id is not one Kestrel makes.' } };
  if (method === 'POST' && parts.length === 4) return upload(req, url, draftId, store);
  if (method === 'DELETE' && parts.length === 5) return store.removeDraftFile(draftId, parts[4]!) ? { status: 204 } : { status: 404, body: { error: 'No such attachment' } };
  if (method === 'DELETE' && parts.length === 4) {
    store.removeDraft(draftId);
    return { status: 204 };
  }
  return null;
}

/** The files a message names (`draftId` and `attachments`, ids in order), checked; null when it names none. */
export function draftRefs(body: Record<string, unknown>): DraftRefs | null {
  const ids = body.attachments;
  if (ids === undefined || ids === null) return null;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !isSafeId(id))) throw new Refused('attachments must be a list of attachment ids.');
  if (ids.length === 0) return null;
  if (ids.length > ATTACHMENT_MAX_PER_MESSAGE) throw new Refused(`At most ${ATTACHMENT_MAX_PER_MESSAGE} files on one message.`);
  if (new Set(ids).size !== ids.length) throw new Refused('The same attachment is named twice.');
  if (typeof body.draftId !== 'string' || !isSafeId(body.draftId)) throw new Refused('draftId must name the draft the files were uploaded to.');
  return { draftId: body.draftId, ids: ids as string[] };
}
