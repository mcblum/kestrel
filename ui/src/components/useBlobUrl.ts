// A picture the server holds, fetched with the token in a header and shown through an object URL.
// One object URL per picture however many places show it (a thumbnail in the conversation and the
// same picture in the viewer), counted, and revoked when the last of them goes.
import { useEffect, useState } from 'react';
import { fetchBlob } from '../store.ts';

/**
 * `media`: a file under the session's media folder, by name. `raw`: a path inside the session folder.
 * `attachment`: a file the user attached to a message, by its id. `local`: an object URL the page
 * already has (a picture attached in the composer, not sent yet), shown as it is.
 */
export type BlobKind = 'media' | 'raw' | 'attachment' | 'local';

export interface BlobState {
  url: string | null;
  failed: boolean;
}

/** A picture a component can show: where it is, and what it is called. */
export interface PictureRef {
  sessionId: string;
  kind: BlobKind;
  name: string;
  alt?: string;
}

function pathFor(sessionId: string, kind: BlobKind, name: string): string {
  const session = `/api/sessions/${encodeURIComponent(sessionId)}`;
  if (kind === 'attachment') return `${session}/attachments/${encodeURIComponent(name)}`;
  return kind === 'media' ? `${session}/media/${encodeURIComponent(name)}` : `${session}/raw?path=${encodeURIComponent(name)}`;
}

interface Shared {
  users: number;
  url: string | null;
  failed: boolean;
  waiting: Set<(state: BlobState) => void>;
}

const shared = new Map<string, Shared>();

/** Hold a picture's object URL; `got` is told once it is there (at once if it already is). Returns the release. */
function hold(path: string, got: (state: BlobState) => void): () => void {
  let entry = shared.get(path);
  if (!entry) {
    const fresh: Shared = { users: 0, url: null, failed: false, waiting: new Set() };
    shared.set(path, fresh);
    fetchBlob(path).then(
      (blob) => {
        if (shared.get(path) !== fresh) return; // released meanwhile
        fresh.url = URL.createObjectURL(blob);
        fresh.waiting.forEach((tell) => tell({ url: fresh.url, failed: false }));
        fresh.waiting.clear();
      },
      () => {
        if (shared.get(path) !== fresh) return;
        // Not kept: the next one to ask tries again (a picture still being written, a restarted server).
        shared.delete(path);
        fresh.failed = true;
        fresh.waiting.forEach((tell) => tell({ url: null, failed: true }));
        fresh.waiting.clear();
      },
    );
    entry = fresh;
  }
  const current = entry;
  current.users += 1;
  if (current.url) got({ url: current.url, failed: false });
  else current.waiting.add(got);
  return () => {
    current.waiting.delete(got);
    current.users -= 1;
    if (current.users > 0 || shared.get(path) !== current) return;
    shared.delete(path);
    if (current.url) URL.revokeObjectURL(current.url);
  };
}

/** The object URL for a picture, released when the component goes or asks for another one. `enabled: false` asks for nothing yet. */
export function useBlobUrl(sessionId: string, kind: BlobKind, name: string, enabled = true): BlobState {
  const [state, setState] = useState<BlobState>({ url: null, failed: false });
  useEffect(() => {
    setState({ url: kind === 'local' ? name : null, failed: false });
    if (!enabled || kind === 'local') return;
    return hold(pathFor(sessionId, kind, name), setState);
  }, [sessionId, kind, name, enabled]);
  return state;
}
