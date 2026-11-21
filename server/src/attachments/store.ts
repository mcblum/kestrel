// Where attached files live on disk, under the Kestrel data dir:
//   attachments/drafts/<draftId>/<id>/<name>       uploaded, not sent yet (a composer's draft)
//   attachments/sessions/<sessionId>/<id>/<name>   sent with a message (or queued)
// Each file has a `.meta.json` beside it with what the upload said about it. A draft's files move
// to the session when its message is sent (`claim`). Drafts nobody sent are removed when the
// server starts (`cleanDrafts`) and when the composer drops them.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAttachment } from '../agents/types.ts';
import { ATTACHMENT_MAX_FILE_BYTES, formatSize, messageLimitReason, type Attachment } from '../shared/attachments.ts';
import { Refused } from '../workspace.ts';
import { isSafeId, mediaTypeOf, originalPath, sanitizeName, sniffImage } from './naming.ts';

const META = '.meta.json';
/** Session ids as stored (uuids; sample data uses short words). */
const SESSION_ID = /^[\w-]{1,100}$/;

/** What an upload says about itself, before any checks. */
export interface UploadInfo {
  name: string;
  mediaType?: string;
  path?: string;
}

/** A draft's files to send with a message, by id, in the order the user put them. */
export interface DraftRefs {
  draftId: string;
  ids: string[];
}

export const GONE = 'An attachment is no longer there (Kestrel restarted since it was added, or it was removed). Remove it and attach it again.';

export class AttachmentStore {
  readonly root: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, 'attachments');
  }

  private draftDir(draftId: string): string {
    if (!isSafeId(draftId)) throw new Refused('That draft id is not one Kestrel makes.');
    return join(this.root, 'drafts', draftId);
  }

  /** The folder a session's attachments are in; the agent may read it (agents/claude/confine.ts). */
  sessionDir(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Refused('That session id is not one Kestrel makes.');
    return join(this.root, 'sessions', sessionId);
  }

  /** The session's attachments folder, made if need be, for the agent to read. */
  readableDir(sessionId: string): string {
    const dir = this.sessionDir(sessionId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Keep an uploaded file in a draft. Refuses empty and too-large files. */
  saveDraft(draftId: string, info: UploadInfo, bytes: Buffer): Attachment {
    if (bytes.length === 0) throw new Refused('That file is empty. Kestrel does not attach empty files.');
    if (bytes.length > ATTACHMENT_MAX_FILE_BYTES) throw new Refused(`That file is ${formatSize(bytes.length)}; a file can be at most ${formatSize(ATTACHMENT_MAX_FILE_BYTES)}.`);
    const name = sanitizeName(info.name);
    const mediaType = mediaTypeOf(name, info.mediaType, bytes);
    const path = originalPath(info.path);
    const attachment: Attachment = { id: randomUUID(), name, mediaType, size: bytes.length, kind: sniffImage(bytes) ? 'image' : 'file', ...(path ? { path } : {}) };
    const dir = join(this.draftDir(draftId), attachment.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), bytes);
    writeFileSync(join(dir, META), JSON.stringify(attachment));
    return attachment;
  }

  /** Drop one file from a draft. False when it was not there. */
  removeDraftFile(draftId: string, id: string): boolean {
    if (!isSafeId(id)) return false;
    const dir = join(this.draftDir(draftId), id);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /** Drop a whole draft (the composer was cleared or closed). */
  removeDraft(draftId: string): void {
    rmSync(this.draftDir(draftId), { recursive: true, force: true });
  }

  /** Every draft goes: no composer from before this start can still send them. */
  cleanDrafts(): void {
    rmSync(join(this.root, 'drafts'), { recursive: true, force: true });
  }

  /** What a stored file says about itself, or null when it is not there. */
  private readMeta(dir: string): Attachment | null {
    try {
      const meta = JSON.parse(readFileSync(join(dir, META), 'utf8')) as Attachment;
      return existsSync(join(dir, meta.name)) ? meta : null;
    } catch {
      return null;
    }
  }

  /**
   * Move a draft's files to a session, for a message being sent or queued, and return them in the
   * order given. Checks them all before moving any. Refuses a file that is gone or a message over the limits.
   */
  claim(sessionId: string, refs: DraftRefs | null | undefined): Attachment[] {
    if (!refs || refs.ids.length === 0) return [];
    const draft = this.draftDir(refs.draftId);
    const found = refs.ids.map((id) => {
      const meta = isSafeId(id) ? this.readMeta(join(draft, id)) : null;
      if (!meta || meta.id !== id) throw new Refused(GONE);
      return meta;
    });
    const tooMuch = messageLimitReason(found);
    if (tooMuch) throw new Refused(tooMuch);
    const target = this.sessionDir(sessionId);
    mkdirSync(target, { recursive: true });
    for (const a of found) renameSync(join(draft, a.id), join(target, a.id));
    if (existsSync(draft) && readdirSync(draft).length === 0) rmSync(draft, { recursive: true, force: true });
    return found;
  }

  /** A session's stored file, for serving it back. Null when there is no such file. */
  file(sessionId: string, id: string): { path: string; attachment: Attachment } | null {
    if (!SESSION_ID.test(sessionId) || !isSafeId(id)) return null;
    const dir = join(this.sessionDir(sessionId), id);
    const attachment = this.readMeta(dir);
    if (!attachment) return null;
    const path = join(dir, attachment.name);
    return statSync(path).isFile() ? { path, attachment } : null;
  }

  /** The files of a message as an agent gets them: each with where it is stored. Ones gone since are left out. */
  forAgent(sessionId: string, attachments: readonly Attachment[] | undefined): AgentAttachment[] {
    return (attachments ?? []).flatMap((a) => {
      const stored = this.file(sessionId, a.id);
      return stored ? [{ name: a.name, mediaType: a.mediaType, size: a.size, kind: a.kind, file: stored.path }] : [];
    });
  }

  removeSession(sessionId: string): void {
    if (SESSION_ID.test(sessionId)) rmSync(this.sessionDir(sessionId), { recursive: true, force: true });
  }
}
