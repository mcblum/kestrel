// What the held-conversation uploader still owes the service, and what it last sent, kept in a file
// in Kestrel's data folder so it survives a restart (design doc kestrel-connect.md, section 7). It
// holds session and project ids, record ids and content hashes, and the last context-window measurement
// sent per session (token counts and the agent's category names): no conversation text and no key.
import { existsSync, readFileSync } from 'node:fs';
import type { ContextRow, ContextUsage } from '../../shared/context-usage.ts';
import { writeAtomically } from './vault.ts';

/** What one session's records held when they were last sent. */
export interface HeldSession {
  /** The project tag the records were sent with. */
  project: string;
  /** Per chunk, the hash of what was sent. */
  chunks: string[];
  /** Attachment and picture records sent. */
  files: string[];
  /** The session's activity time when it was last read; a different one means read it again. */
  stamp: number;
  /** How many messages the conversation had. */
  count: number;
}

export interface Delivery {
  id: string;
  ok: boolean;
  reason?: string;
  at: number;
}

export interface QueueState {
  v: 1;
  /** Which desk and which id key the records below were made for: a change starts over. */
  scope: string | null;
  /** Sessions to read and send again. */
  dirty: string[];
  /** Sessions and projects whose records are to be deleted. */
  deleteSessions: string[];
  deleteProjects: string[];
  /** Single records to delete (an attachment no longer held). */
  deleteRecords: string[];
  held: Record<string, HeldSession>;
  indexHash: string | null;
  /** Waiting messages taken from the service: never delivered twice. */
  taken: string[];
  deliveries: Delivery[];
  /** The last context-window measurement the index carried per session, so a desk restart does not wipe it. */
  contexts: Record<string, ContextUsage>;
  /** What the held Code reviews and Tickets records last carried, by kind: sent again only when it differs. */
  listHashes: { reviews?: string; tickets?: string };
}

export const EMPTY_QUEUE: QueueState = { v: 1, scope: null, dirty: [], deleteSessions: [], deleteProjects: [], deleteRecords: [], held: {}, indexHash: null, taken: [], deliveries: [], contexts: {}, listHashes: {} };

const ROW_KINDS: readonly ContextRow['kind'][] = ['used', 'free', 'buffer', 'deferred'];
const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** A stored measurement, or null when the file holds something else. */
function asContext(raw: unknown): ContextUsage | null {
  const u = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<ContextUsage>;
  if (typeof u.model !== 'string' || !count(u.usedTokens) || !count(u.windowTokens) || !count(u.at) || !Array.isArray(u.rows)) return null;
  const rows = u.rows.filter((r): r is ContextRow => typeof r?.name === 'string' && count(r.tokens) && ROW_KINDS.includes(r.kind));
  return { model: u.model, usedTokens: u.usedTokens, windowTokens: u.windowTokens, rows, at: u.at };
}

export interface QueueStore {
  read(): Promise<QueueState>;
  write(state: QueueState): Promise<void>;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function asQueue(raw: unknown): QueueState {
  const q = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<QueueState>;
  if (q.v !== 1) return EMPTY_QUEUE;
  const contexts: Record<string, ContextUsage> = {};
  for (const [id, c] of Object.entries(q.contexts ?? {})) {
    const usage = asContext(c);
    if (usage) contexts[id] = usage;
  }
  const held: Record<string, HeldSession> = {};
  for (const [id, h] of Object.entries(q.held ?? {})) {
    if (typeof h?.project === 'string') held[id] = { project: h.project, chunks: strings(h.chunks), files: strings(h.files), stamp: typeof h.stamp === 'number' ? h.stamp : 0, count: typeof h.count === 'number' ? h.count : 0 };
  }
  return {
    v: 1,
    scope: typeof q.scope === 'string' ? q.scope : null,
    dirty: strings(q.dirty),
    deleteSessions: strings(q.deleteSessions),
    deleteProjects: strings(q.deleteProjects),
    deleteRecords: strings(q.deleteRecords),
    held,
    indexHash: typeof q.indexHash === 'string' ? q.indexHash : null,
    taken: strings(q.taken),
    deliveries: Array.isArray(q.deliveries) ? q.deliveries.filter((d): d is Delivery => typeof d?.id === 'string' && typeof d.ok === 'boolean' && typeof d.at === 'number') : [],
    contexts,
    listHashes: { ...(typeof q.listHashes?.reviews === 'string' ? { reviews: q.listHashes.reviews } : {}), ...(typeof q.listHashes?.tickets === 'string' ? { tickets: q.listHashes.tickets } : {}) },
  };
}

export function fileQueueStore(path: string): QueueStore {
  return {
    async read() {
      if (!existsSync(path)) return EMPTY_QUEUE;
      try {
        return asQueue(JSON.parse(readFileSync(path, 'utf8')));
      } catch {
        return EMPTY_QUEUE;
      }
    },
    async write(state) {
      writeAtomically(path, Buffer.from(JSON.stringify(state), 'utf8'));
    },
  };
}

export function memoryQueueStore(initial: QueueState = EMPTY_QUEUE): QueueStore & { current(): QueueState } {
  let state = initial;
  return {
    read: async () => state,
    write: async (next) => void (state = next),
    current: () => state,
  };
}
