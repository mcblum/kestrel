// Held conversations, the desk's side (design doc kestrel-connect.md, section 7; the contract is
// "Phase 3 as built, part C, and phase 5 as built"). The desk stays the source of truth and keeps an
// encrypted copy on the service so a phone can read while this computer is asleep, and takes the
// messages a phone left for it while it was.
//
// - It reads the conversation through the workspace (Persistence under it) and the runtime's live
//   overlay, as GET /api/sessions/:id does. It is not a Persistence provider and writes nothing there.
// - It never blocks a turn and never runs on the broadcast path: the workspace's change and the live
//   patches only mark what is owed and set a timer; the work runs later, one pass at a time.
// - One second after a turn settles, at most every five seconds while one streams; only chunks whose
//   content changed are sent. What is owed survives a restart (held-queue.ts).
import { heldLists, heldPullRequests } from '../../shared/connect-lists.ts';
import type { ConnectLists } from '../lists.ts';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { ChatMessage, SessionView, WorkspaceState } from '../../model.ts';
import { Refused } from '../../refused.ts';
import type { ContextShown, SessionRuntime } from '../../runtime.ts';
import type { ContextUsage } from '../../shared/context-usage.ts';
import type { Attachment } from '../../shared/attachments.ts';
import type { ConnectHeld } from '../../shared/connect.ts';
import { projectOfSession } from '../../shared/project-groups.ts';
import type { Workspace } from '../../workspace.ts';
import { openRecord, sealRecord, tagOf } from '../account-key.ts';
import type { ReadyKey } from './account-keys.ts';
import type { HeldApi, HeldUsage } from './held-api.ts';
import { EMPTY_QUEUE, type Delivery, type HeldSession, type QueueState, type QueueStore } from './held-queue.ts';
import { ServiceRefusal } from './service.ts';

export const CHUNK_MESSAGES = 50;
export const SETTLE_MS = 1_000;
export const STREAM_MS = 5_000;
export const RETRY_MS = 30_000;
/** Attachments and pictures larger than this are not held. */
export const HELD_FILE_MAX_BYTES = 20 * 1024 * 1024;
const DELIVERIES_KEPT = 50;
const TAKEN_KEPT = 500;
/** Stands for "no project" in the kept-off list and in tags. */
export const NO_PROJECT = 'none';

/** What the user chose (Settings → Connections → Kestrel Connect). */
export interface HeldPrefs {
  /** Project ids kept off Kestrel Connect; `none` for sessions with no project. */
  keptOff: string[];
  /** Hold attachments and tools' pictures (D5); off by default. */
  attachments: boolean;
}

export const DEFAULT_HELD_PREFS: HeldPrefs = { keptOff: [], attachments: false };

/** What of the workspace and runtime this reads, so a test can stand in for them. */
export interface HeldSource {
  state(): Promise<WorkspaceState>;
  messages(sessionId: string): Promise<ChatMessage[] | null>;
  attachment(sessionId: string, id: string): { path: string; type: string; name: string } | null;
  media(sessionId: string, name: string): { path: string; type: string } | null;
  onChange(listener: () => void): () => void;
  onLive(listener: (sessionId: string, streaming: boolean) => void): () => void;
  /** A session's context window was measured again (its live channel's `context`). */
  onContext(listener: () => void): () => void;
  /** How full a session's context window is as known now, asking no agent (`SessionRuntime.contextKnown`). */
  context(session: SessionView): ContextShown;
  /** Sends a waiting message into its session as the user's, as `session.reply` does. */
  reply(sessionId: string, text: string, files: { name: string; mediaType: string; data: Buffer }[], draftId: string): Promise<void>;
  /** The Code reviews and Tickets lists, as a phone reads them (`connect/lists.ts`). */
  lists: ConnectLists;
}

export function heldSource(workspace: Workspace, runtime: SessionRuntime, lists: ConnectLists): HeldSource {
  return {
    lists,
    state: () => workspace.state(),
    async messages(sessionId) {
      const overlay = runtime.overlay(sessionId);
      if (overlay) return overlay.messages;
      return (await workspace.detail(sessionId))?.messages ?? null;
    },
    attachment(sessionId, id) {
      const found = runtime.attachments.file(sessionId, id);
      return found && { path: found.path, type: found.attachment.mediaType, name: found.attachment.name };
    },
    media: (sessionId, name) => runtime.display.mediaFile(sessionId, name),
    onChange: (listener) => workspace.onChange(listener),
    onLive: (listener) => runtime.onLive((sessionId, patch) => {
      if (patch.messages || patch.removedMessages) listener(sessionId, true);
    }),
    onContext: (listener) => runtime.onLive((_sessionId, patch) => {
      if (patch.context) listener();
    }),
    context: (session) => runtime.contextKnown(session),
    async reply(sessionId, text, files, draftId) {
      const ids = files.map((f) => runtime.attachments.saveDraft(draftId, { name: f.name, mediaType: f.mediaType }, f.data).id);
      await runtime.reply(sessionId, text, {}, ids.length > 0 ? { draft: { draftId, ids } } : {});
    },
  };
}

export interface HeldDeps {
  source: HeldSource;
  /** The service, when the link is up; null otherwise. */
  api(): HeldApi | null;
  key(): ReadyKey | null;
  keyFor(generation: number): Buffer;
  /** The account key changed under the uploader: read it again. */
  resync(): Promise<void>;
  desk(): { id: string; name: string } | null;
  prefs(): HeldPrefs;
  queue: QueueStore;
  changed(): void;
  /** How a delivery refusal names this computer. */
  here: string;
  now?(): number;
  settleMs?: number;
  streamMs?: number;
}

const hash = (text: string) => createHash('sha256').update(text).digest('base64url').slice(0, 22);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const activity = (s: SessionView) => Math.max(s.updatedAt, s.lastActivityAt ?? 0);

/** The files a conversation names: attachments by id, pictures by file name. */
function filesOf(messages: readonly ChatMessage[]): { attachments: Attachment[]; images: string[] } {
  const attachments = new Map<string, Attachment>();
  const images = new Set<string>();
  for (const m of messages) {
    for (const a of m.attachments ?? []) attachments.set(a.id, a);
    for (const name of m.images ?? []) images.add(name);
  }
  return { attachments: [...attachments.values()], images: [...images] };
}

export class HeldConversations {
  private q: QueueState = EMPTY_QUEUE;
  private readonly loaded: Promise<void>;
  private readonly dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private dueAt = Infinity;
  private running: Promise<void> | null = null;
  private again = false;
  private delivering: Promise<void> | null = null;
  private lastRunAt = 0;
  private problem: string | null = null;
  private usage: HeldUsage | null = null;
  private lastUploadAt: number | null = null;
  private closed = false;
  private readonly unsubscribe: (() => void)[];

  constructor(private readonly deps: HeldDeps) {
    this.loaded = deps.queue.read().then((q) => {
      this.q = q;
      for (const id of q.dirty) this.dirty.add(id);
    });
    this.unsubscribe = [
      // Cheap on purpose: these run as the workspace broadcasts and as an agent streams.
      deps.source.onChange(() => this.schedule(this.settleMs())),
      deps.source.onLive((sessionId) => {
        this.dirty.add(sessionId);
        this.schedule(Math.max(this.lastRunAt + this.streamMs() - this.now(), this.settleMs()));
      }),
      // A new measurement changes only the index; the pass sends it when it differs.
      deps.source.onContext(() => this.schedule(this.settleMs())),
      // A list changed: the pass sends its record when what it holds differs.
      deps.source.lists.onChange(() => this.schedule(this.settleMs())),
    ];
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private settleMs(): number {
    return this.deps.settleMs ?? SETTLE_MS;
  }

  private streamMs(): number {
    return this.deps.streamMs ?? STREAM_MS;
  }

  view(): ConnectHeld {
    return { ...this.deps.prefs(), problem: this.problem, usage: this.usage, lastUploadAt: this.lastUploadAt };
  }

  /** Runs a pass soon: the link came up, the key opened, a setting changed. */
  kick(delay = 0): void {
    this.schedule(delay);
  }

  private schedule(delay: number): void {
    if (this.closed) return;
    const at = this.now() + Math.max(0, delay);
    if (this.timer && at >= this.dueAt) return;
    if (this.timer) clearTimeout(this.timer);
    this.dueAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.dueAt = Infinity;
      void this.run();
    }, Math.max(0, delay));
    this.timer.unref?.();
  }

  /** One pass, one at a time; a pass asked for during one runs after it. */
  run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.pass()
      .catch((error: unknown) => this.failed(error))
      .finally(() => {
        this.running = null;
        this.lastRunAt = this.now();
        if (this.again) {
          this.again = false;
          this.schedule(this.settleMs());
        }
      });
    return this.running;
  }

  private failed(error: unknown): void {
    if (error instanceof ServiceRefusal && error.code === 'key-changed') {
      void this.deps.resync().then(() => this.schedule(0));
      return;
    }
    this.problem = error instanceof ServiceRefusal ? error.message : `Kestrel Connect could not be reached to hold conversations; trying again. (${message(error)})`;
    this.deps.changed();
    // A full account waits for something to change; anything else is tried again.
    if (!(error instanceof ServiceRefusal && error.code === 'held-full')) this.schedule(RETRY_MS);
  }

  /** The settings changed: what is now kept off, or no longer held, is deleted from the service. */
  async prefsChanged(before: HeldPrefs, after: HeldPrefs): Promise<void> {
    await this.loaded;
    const newlyOff = after.keptOff.filter((p) => !before.keptOff.includes(p));
    this.q = { ...this.q, deleteProjects: [...new Set([...this.q.deleteProjects, ...newlyOff])] };
    if (before.attachments && !after.attachments) {
      const files = Object.values(this.q.held).flatMap((h) => h.files);
      const held = Object.fromEntries(Object.entries(this.q.held).map(([id, h]) => [id, { ...h, files: [] }]));
      this.q = { ...this.q, held, deleteRecords: [...new Set([...this.q.deleteRecords, ...files])] };
    }
    if (!before.attachments && after.attachments) for (const id of Object.keys(this.q.held)) this.dirty.add(id);
    // Dropped from `held` so a project switched back on is sent again in full.
    const held = Object.fromEntries(Object.entries(this.q.held).filter(([, h]) => !newlyOff.some((p) => h.project === this.projectTag(p))));
    this.q = { ...this.q, held };
    await this.save();
    this.kick();
  }

  private projectTag(projectId: string): string {
    const key = this.deps.key();
    const desk = this.deps.desk();
    return key && desk ? tagOf(key.idKey, `project|${desk.id}|${projectId}`) : '';
  }

  private async save(): Promise<void> {
    this.q = { ...this.q, dirty: [...this.dirty] };
    await this.deps.queue.write(this.q);
  }

  private async pass(): Promise<void> {
    await this.loaded;
    const api = this.deps.api();
    const key = this.deps.key();
    const desk = this.deps.desk();
    if (!api || !key || !desk) return;
    const tag = (label: string) => tagOf(key.idKey, label);
    const scope = `${desk.id}|${tag('scope')}`;
    if (this.q.scope !== scope) this.q = { ...EMPTY_QUEUE, scope, taken: this.q.taken, deliveries: this.q.deliveries, contexts: this.q.contexts, listHashes: {} };

    await this.deletions(api, desk.id, tag);

    const prefs = this.deps.prefs();
    const state = await this.deps.source.state();
    const keptOff = new Set(prefs.keptOff);
    // A sidebar is listed nowhere and drawn only in its pane at the desk: never held (kestrel-connect.md, "Sidebars").
    const want = state.sessions.filter((s) => !s.aside && !keptOff.has(projectOfSession(s) ?? NO_PROJECT));
    const wanted = new Set(want.map((s) => s.id));
    for (const id of Object.keys(this.q.held)) {
      if (wanted.has(id)) continue;
      // Deleted, archived, or kept off: its records go.
      await api.deleteRecords({ session: tag(`session|${desk.id}|${id}`) });
      const { [id]: _gone, ...rest } = this.q.held;
      this.q = { ...this.q, held: rest };
      this.dirty.delete(id);
      await this.save();
    }
    for (const session of want) {
      const before = this.q.held[session.id];
      if (before && before.stamp === activity(session) && !this.dirty.has(session.id)) continue;
      this.dirty.delete(session.id);
      const after = await this.uploadSession(api, key, desk.id, session, before, prefs, tag);
      this.q = { ...this.q, held: { ...this.q.held, [session.id]: after } };
      await this.save();
    }
    await this.uploadIndex(api, key, desk, state, want, tag);
    await this.uploadLists(api, key, desk.id, state, want, prefs.keptOff, tag);
    this.problem = null;
    this.deps.changed();
  }

  private async deletions(api: HeldApi, deskId: string, tag: (label: string) => string): Promise<void> {
    for (const project of this.q.deleteProjects) {
      await api.deleteRecords({ project: tag(`project|${deskId}|${project}`) });
      this.q = { ...this.q, deleteProjects: this.q.deleteProjects.filter((p) => p !== project) };
      await this.save();
    }
    for (const id of this.q.deleteRecords) {
      await api.deleteRecord(id).catch((error: unknown) => {
        if (!(error instanceof ServiceRefusal && error.status === 404)) throw error;
      });
      this.q = { ...this.q, deleteRecords: this.q.deleteRecords.filter((r) => r !== id) };
      await this.save();
    }
  }

  private async put(api: HeldApi, key: ReadyKey, id: string, value: unknown, session: string | null, project: string | null): Promise<boolean> {
    try {
      this.usage = (await api.putRecord(id, { generation: key.generation, session, project, body: sealRecord(key.adk, 'record', id, key.generation, value) })) ?? this.usage;
      this.lastUploadAt = this.now();
      return true;
    } catch (error) {
      // One record too big is skipped (and said); anything else ends the pass.
      if (error instanceof ServiceRefusal && error.code === 'record-too-big') {
        this.problem = error.message;
        return false;
      }
      throw error;
    }
  }

  private async uploadSession(api: HeldApi, key: ReadyKey, deskId: string, session: SessionView, before: HeldSession | undefined, prefs: HeldPrefs, tag: (label: string) => string): Promise<HeldSession> {
    const messages = (await this.deps.source.messages(session.id)) ?? [];
    const sessionTag = tag(`session|${deskId}|${session.id}`);
    const project = tag(`project|${deskId}|${projectOfSession(session) ?? NO_PROJECT}`);
    const moved = before !== undefined && before.project !== project;
    const chunks: string[] = [];
    for (let n = 0; n * CHUNK_MESSAGES < messages.length; n++) {
      const body = { v: 1, kind: 'chunk', sessionId: session.id, n, messages: messages.slice(n * CHUNK_MESSAGES, (n + 1) * CHUNK_MESSAGES) };
      const h = hash(JSON.stringify(body));
      chunks.push(h);
      if (!moved && before?.chunks[n] === h) continue;
      await this.put(api, key, tag(`chunk|${deskId}|${session.id}|${n}`), body, sessionTag, project);
    }
    for (let n = chunks.length; n < (before?.chunks.length ?? 0); n++) {
      await api.deleteRecord(tag(`chunk|${deskId}|${session.id}|${n}`)).catch(() => undefined);
    }
    const files = prefs.attachments ? await this.uploadFiles(api, key, deskId, session.id, messages, moved ? [] : (before?.files ?? []), sessionTag, project, tag) : [];
    const dropped = (before?.files ?? []).filter((f) => !files.includes(f));
    for (const id of dropped) await api.deleteRecord(id).catch(() => undefined);
    return { project, chunks, files, stamp: activity(session), count: messages.length };
  }

  private async uploadFiles(api: HeldApi, key: ReadyKey, deskId: string, sessionId: string, messages: readonly ChatMessage[], sent: readonly string[], sessionTag: string, project: string, tag: (label: string) => string): Promise<string[]> {
    const { attachments, images } = filesOf(messages);
    const out: string[] = [];
    for (const a of attachments) {
      const id = tag(`attachment|${deskId}|${sessionId}|${a.id}`);
      if (sent.includes(id)) {
        out.push(id);
        continue;
      }
      const file = this.deps.source.attachment(sessionId, a.id);
      const data = file && (await readSmall(file.path));
      if (!file || !data) continue;
      if (await this.put(api, key, id, { v: 1, kind: 'attachment', sessionId, id: a.id, name: file.name, type: file.type, data: data.toString('base64') }, sessionTag, project)) out.push(id);
    }
    for (const name of images) {
      const id = tag(`media|${deskId}|${sessionId}|${name}`);
      if (sent.includes(id)) {
        out.push(id);
        continue;
      }
      const file = this.deps.source.media(sessionId, name);
      const data = file && (await readSmall(file.path));
      if (!file || !data) continue;
      if (await this.put(api, key, id, { v: 1, kind: 'media', sessionId, name, type: file.type, data: data.toString('base64') }, sessionTag, project)) out.push(id);
    }
    return out;
  }

  private async uploadIndex(api: HeldApi, key: ReadyKey, desk: { id: string; name: string }, state: WorkspaceState, want: readonly SessionView[], tag: (label: string) => string): Promise<void> {
    const projects = new Map(state.projects.map((p) => [p.id, p.name]));
    const contexts: Record<string, ContextUsage> = {};
    const sessions = want.map((s) => {
      const projectId = projectOfSession(s);
      const count = this.q.held[s.id]?.count ?? 0;
      return { id: s.id, title: s.title, agent: s.agent, state: s.state, note: s.note, project: projectId ? { id: projectId, name: projects.get(projectId) ?? '' } : null, ...(s.hostId ? { hostId: s.hostId } : {}), createdAt: s.createdAt, updatedAt: s.updatedAt, lastActivityAt: s.lastActivityAt ?? s.updatedAt, messages: count, chunks: Math.ceil(count / CHUNK_MESSAGES), ...this.contextOf(s, contexts) };
    });
    const content = { v: 1, kind: 'index', desk, sessions, deliveries: this.q.deliveries };
    const h = hash(JSON.stringify(content));
    if (h === this.q.indexHash) return;
    await this.put(api, key, tag(`index|${desk.id}`), { ...content, asOf: this.now() }, null, null);
    this.q = { ...this.q, indexHash: h, contexts };
    await this.save();
  }

  /**
   * The Code reviews and Tickets lists as a phone reads them, for when this computer is away: one record each,
   * replaced when what it holds changes. Nothing of a project kept off, and no ticket pages (`heldLists`).
   */
  private async uploadLists(api: HeldApi, key: ReadyKey, deskId: string, state: WorkspaceState, want: readonly SessionView[], keptOff: readonly string[], tag: (label: string) => string): Promise<void> {
    const projectOf = new Map([...state.sessions, ...state.archived.sessions].map((s) => [s.id, projectOfSession(s) ?? NO_PROJECT]));
    const lists = this.deps.source.lists;
    const held = {
      ...heldLists(await lists.reviews(), lists.tickets(), keptOff, (id) => projectOf.get(id) ?? null),
      // Only the sessions the index holds: no kept-off project, no archived session, no sidebar.
      'pull-requests': heldPullRequests(await lists.pullRequests(), new Set(want.map((s) => s.id))),
    };
    for (const kind of ['reviews', 'tickets', 'pull-requests'] as const) {
      const content = { v: 1, kind, desk: deskId, [kind === 'pull-requests' ? 'pullRequests' : kind]: held[kind] };
      const h = hash(JSON.stringify(content));
      if (h === this.q.listHashes[kind]) continue;
      if (!(await this.put(api, key, tag(`${kind}|${deskId}`), { ...content, asOf: this.now() }, null, null))) continue;
      this.q = { ...this.q, listHashes: { ...this.q.listHashes, [kind]: h } };
      await this.save();
    }
  }

  /**
   * A session's context window for the index: what is known now, else the last measurement sent (the desk
   * restarted, and Codex and OpenCode cannot be asked until their next turn), else the words in its place.
   * Each one carried is noted in `kept`, which becomes what the queue file keeps.
   */
  private contextOf(session: SessionView, kept: Record<string, ContextUsage>): { context: ContextUsage | null; contextNote?: string } {
    const now = this.deps.source.context(session);
    const context = now.context ?? this.q.contexts[session.id] ?? null;
    if (context) {
      kept[session.id] = context;
      return { context };
    }
    return { context: null, contextNote: now.contextNote };
  }

  // ---- messages that waited for this computer ------------------------------------------------

  /** Takes the messages a phone left while this computer was away, each into its session once. */
  deliverWaiting(): Promise<void> {
    this.delivering ??= this.deliver()
      .catch((error: unknown) => console.error(`[kestrel] could not take waiting Kestrel Connect messages: ${message(error)}`))
      .finally(() => (this.delivering = null));
    return this.delivering;
  }

  private async deliver(): Promise<void> {
    await this.loaded;
    const api = this.deps.api();
    if (!api || !this.deps.key()) return;
    const inbox = await api.inbox();
    for (const waiting of inbox.messages) {
      if (!this.q.taken.includes(waiting.id)) {
        // Noted as taken before it is sent, so a crash between the two never sends it twice.
        this.q = { ...this.q, taken: [...this.q.taken, waiting.id].slice(-TAKEN_KEPT) };
        await this.save();
        const delivery = await this.deliverOne(waiting);
        this.q = { ...this.q, deliveries: [...this.q.deliveries, delivery].slice(-DELIVERIES_KEPT) };
        await this.save();
      }
      await api.deleteMessage(waiting.id).catch(() => undefined);
    }
    if (inbox.messages.length > 0) this.kick();
    // The service answers a page at a time: take the next once this one is done.
    if (inbox.more) await this.deliver();
  }

  private async deliverOne(waiting: { id: string; generation: number; body: string }): Promise<Delivery> {
    const at = this.now();
    try {
      const body = openRecord(this.deps.keyFor(waiting.generation), waiting.body, 'message', waiting.id, waiting.generation) as Record<string, unknown>;
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      const text = typeof body.text === 'string' ? body.text : '';
      const files = Array.isArray(body.attachments) ? body.attachments.flatMap((a: Record<string, unknown>) => (typeof a?.name === 'string' && typeof a.mediaType === 'string' && typeof a.data === 'string' ? [{ name: a.name, mediaType: a.mediaType, data: Buffer.from(a.data, 'base64') }] : [])) : [];
      const state = await this.deps.source.state();
      if (!state.sessions.some((s) => s.id === sessionId) && !state.archived.sessions.some((s) => s.id === sessionId)) throw new Refused('That session is no longer in Kestrel.');
      if (!text.trim() && files.length === 0) throw new Refused('The message was empty.');
      await this.deps.source.reply(sessionId, text, files, `held-${createHash('sha256').update(waiting.id).digest('hex').slice(0, 32)}`);
      return { id: waiting.id, ok: true, at };
    } catch (error) {
      return { id: waiting.id, ok: false, reason: error instanceof Refused ? error.message : `The message could not be read on ${this.deps.here}.`, at };
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const off of this.unsubscribe) off();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
    await this.delivering;
  }
}

async function readSmall(path: string): Promise<Buffer | null> {
  try {
    if ((await stat(path)).size > HELD_FILE_MAX_BYTES) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}
