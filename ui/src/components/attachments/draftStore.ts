// Files attached in a composer and not sent yet, per composer (its draft key: a session id, or
// `tab:<id>` for a new-session tab). Kept in memory beside the draft text, so they survive
// switching tabs; not an app restart (the server drops unsent uploads when it starts).
// Each file is uploaded as soon as it is added, to a draft on the server (`draftId`); sending the
// message names the uploaded ids in order and the server moves them to the session.
import { useSyncExternalStore } from 'react';
import { ATTACHMENT_MAX_FILE_BYTES, formatSize, messageLimitReason } from '@kestrel/server/attachments';
import type { Attachment } from '@kestrel/server/model';
import { call, sendBytes, type AttachmentRefs } from '../../store.ts';

/** Pictures the composer can preview (the server decides for itself what it sends as a picture). */
const PREVIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export interface DraftFile {
  /** This composer's own id for the file; stays the same through retries. */
  key: string;
  name: string;
  size: number;
  kind: 'image' | 'file';
  /** Where it is on disk, when the shell could say. */
  path?: string;
  /** An object URL of the file itself, for a picture's thumbnail. */
  preview?: string;
  status: 'uploading' | 'ready' | 'error';
  error?: string;
  /** The upload failed on its way (not a file too large or empty): trying again may work. */
  retryable?: boolean;
  /** The server's id once uploaded. */
  id?: string;
  file: File;
}

interface Draft {
  draftId: string;
  files: readonly DraftFile[];
}

const EMPTY: readonly DraftFile[] = [];
let drafts: ReadonlyMap<string, Draft> = new Map();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function draftOf(key: string): Draft {
  return drafts.get(key) ?? { draftId: crypto.randomUUID(), files: EMPTY };
}

function put(key: string, draft: Draft): void {
  drafts = new Map(drafts).set(key, draft);
  listeners.forEach((l) => l());
}

function update(key: string, fileKey: string, change: Partial<DraftFile>): void {
  const draft = drafts.get(key);
  if (!draft || !draft.files.some((f) => f.key === fileKey)) return; // removed meanwhile
  put(key, { ...draft, files: draft.files.map((f) => (f.key === fileKey ? { ...f, ...change } : f)) });
}

/** The files of one composer, re-rendering when they change. */
export function useDraftFiles(key: string): readonly DraftFile[] {
  return useSyncExternalStore(subscribe, () => drafts.get(key)?.files ?? EMPTY);
}

async function upload(key: string, draftId: string, f: DraftFile): Promise<void> {
  const query = new URLSearchParams({ name: f.name, ...(f.path ? { path: f.path } : {}) });
  try {
    const saved = await sendBytes<Attachment>(`/api/attachments/drafts/${draftId}?${query}`, f.file, { 'Content-Type': f.file.type || 'application/octet-stream' });
    update(key, f.key, { status: 'ready', id: saved.id, kind: saved.kind, error: undefined });
  } catch (error) {
    update(key, f.key, { status: 'error', retryable: true, error: error instanceof Error ? error.message : String(error) });
  }
}

function newFile(file: File): DraftFile {
  const path = window.kestrelShell?.pathForFile?.(file) || undefined;
  const image = PREVIEWABLE.has(file.type);
  const base: DraftFile = { key: crypto.randomUUID(), name: file.name || 'pasted', size: file.size, kind: image ? 'image' : 'file', status: 'uploading', file, ...(path ? { path } : {}), ...(image ? { preview: URL.createObjectURL(file) } : {}) };
  if (file.size === 0) return { ...base, status: 'error', error: 'This file is empty.' };
  if (file.size > ATTACHMENT_MAX_FILE_BYTES) return { ...base, status: 'error', error: `${formatSize(file.size)} is too large: a file can be at most ${formatSize(ATTACHMENT_MAX_FILE_BYTES)}.` };
  return base;
}

const release = (f: DraftFile) => f.preview && URL.revokeObjectURL(f.preview);

export const draftFiles = {
  /** Add files (dropped, pasted or chosen) and start uploading each. */
  add(key: string, files: readonly File[]): void {
    if (files.length === 0) return;
    const draft = draftOf(key);
    const added = files.map(newFile);
    put(key, { ...draft, files: [...draft.files, ...added] });
    for (const f of added) if (f.status === 'uploading') void upload(key, draft.draftId, f);
  },
  /** Try a failed upload again. */
  retry(key: string, fileKey: string): void {
    const draft = drafts.get(key);
    const f = draft?.files.find((x) => x.key === fileKey);
    if (!draft || !f || f.status !== 'error' || !f.retryable) return;
    update(key, fileKey, { status: 'uploading', error: undefined, retryable: undefined });
    void upload(key, draft.draftId, { ...f, status: 'uploading' });
  },
  /** Take one file off; the server drops its upload. */
  remove(key: string, fileKey: string): void {
    const draft = drafts.get(key);
    const f = draft?.files.find((x) => x.key === fileKey);
    if (!draft || !f) return;
    release(f);
    put(key, { ...draft, files: draft.files.filter((x) => x.key !== fileKey) });
    if (f.id) void call(`/api/attachments/drafts/${draft.draftId}/${f.id}`, { method: 'DELETE' }).catch(() => undefined);
  },
  /** Move a file beside another (drag to reorder). */
  move(key: string, fileKey: string, targetKey: string, after: boolean): void {
    const draft = drafts.get(key);
    const moving = draft?.files.find((f) => f.key === fileKey);
    if (!draft || !moving || fileKey === targetKey) return;
    const rest = draft.files.filter((f) => f.key !== fileKey);
    const at = rest.findIndex((f) => f.key === targetKey);
    if (at < 0) return;
    put(key, { ...draft, files: [...rest.slice(0, at + (after ? 1 : 0)), moving, ...rest.slice(at + (after ? 1 : 0))] });
  },
  /** The message was sent: the files now belong to the session. A new draft starts. */
  sent(key: string): void {
    drafts.get(key)?.files.forEach(release);
    const next = new Map(drafts);
    next.delete(key);
    drafts = next;
    listeners.forEach((l) => l());
  },
  /** What to send with the message, or null for no files. */
  refs(key: string): AttachmentRefs | null {
    const draft = drafts.get(key);
    const ready = draft?.files.filter((f) => f.status === 'ready' && f.id) ?? [];
    return draft && ready.length ? { draftId: draft.draftId, attachments: ready.map((f) => f.id!) } : null;
  },
};

/** Why the message cannot be sent yet because of its files, or null. */
export function blockedReason(files: readonly DraftFile[]): string | null {
  if (files.some((f) => f.status === 'uploading')) return 'Wait for the files to finish uploading.';
  if (files.some((f) => f.status === 'error')) return 'Remove or retry the files that did not upload.';
  return messageLimitReason(files);
}
