// Kestrel Connect's dispatcher: carries out a phone's request, already decrypted, in this process, by
// calling the same functions the HTTP routes call (docs/designs/kestrel-connect.md, sections 3, 4, 6).
// It is never reached through the HTTP listener and adds none: the loopback, token, Origin and Host
// checks in security.ts are untouched. What a phone may ask is the closed list in shared/connect-ops.ts;
// anything else is refused with a reason. Nothing here knows which agent a session runs on.
import { readFile } from 'node:fs/promises';
import { draftRefs, servedType } from '../attachments/api.ts';
import { LIVE_FLUSH_MS, mergePatch } from '../live-channel.ts';
import type { ChatMessage, LivePatch, Session } from '../model.ts';
import { Refused } from '../refused.ts';
import type { SessionRuntime } from '../runtime.ts';
import { checkEnvelope, checkRequest, CONNECT_PROTOCOL_VERSION, isConnectId, versionRefusal, type ConnectOpArgs, type ConnectRequest, type ConnectResponse, type Envelope } from '../shared/connect-ops.ts';
import { pageRefusal, transcriptPage } from '../shared/transcript-page.ts';
import type { Workspace } from '../workspace.ts';

/** A frame pushed to a phone: live output of a session it watches. */
export interface ConnectPush {
  type: 'live';
  sessionId: string;
  patch: LivePatch;
}

export interface ConnectDeps {
  workspace: Workspace;
  runtime: SessionRuntime;
  /** This computer's device id: a frame addressed elsewhere is refused. */
  deviceId: string;
  /** How a refusal names this computer ("your Mac"). */
  here: string;
  /** Sends a frame to a device (encrypted and carried by the link; a test collects them). */
  send: (frame: Envelope<ConnectPush | ConnectResponse>) => void;
  /** Makes frame ids. Default: a counter. */
  newId?: () => string;
}

/** What of a live patch a phone is sent: the conversation as the window shows it, cards and all, and where it stands; never the terminal-side panes. */
function remotePatch(patch: LivePatch): LivePatch | null {
  const out: LivePatch = {
    ...(patch.messages ? { messages: patch.messages } : {}),
    ...(patch.removedMessages ? { removedMessages: patch.removedMessages } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.queue ? { queue: patch.queue } : {}),
    ...(patch.settings ? { settings: patch.settings } : {}),
    ...(patch.replacedBy ? { replacedBy: patch.replacedBy } : {}),
  };
  return Object.keys(out).length > 0 ? out : null;
}

const SOMETHING_WENT_WRONG = (here: string) => `Something went wrong on ${here}. Try again, or look at Kestrel there.`;

export class ConnectDispatcher {
  /** Device id -> the sessions it watches. */
  private readonly watching = new Map<string, Set<string>>();
  private readonly pending = new Map<string, LivePatch>();
  private timer: NodeJS.Timeout | null = null;
  private counter = 0;
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: ConnectDeps) {
    this.unsubscribe = deps.runtime.onLive((sessionId, patch) => this.publish(sessionId, patch));
  }

  /**
   * One frame from the link. A request is answered with a response frame (also sent); a frame that
   * cannot be addressed back (no valid `from` or `id`) is dropped, since there is nobody to tell.
   */
  async receive(raw: unknown): Promise<Envelope<ConnectResponse> | null> {
    const checked = checkEnvelope(raw);
    if (!checked.ok) {
      const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
      return isConnectId(r.from) && isConnectId(r.id) ? this.reply(r.from, r.id, { ok: false, reason: checked.reason }) : null;
    }
    const frame = checked.value;
    const version = versionRefusal(frame.v, this.deps.here);
    if (version) return this.reply(frame.from, frame.id, { ok: false, reason: version });
    if (frame.to !== this.deps.deviceId) return this.reply(frame.from, frame.id, { ok: false, reason: `That was meant for another device, not ${this.deps.here}.` });
    if (frame.kind === 'bye') {
      this.forget(frame.from);
      return null;
    }
    if (frame.kind !== 'request') return this.reply(frame.from, frame.id, { ok: false, reason: `${this.deps.here} takes requests here, not a ${frame.kind}.` });
    return this.reply(frame.from, frame.id, await this.answer(frame.from, frame.body));
  }

  /** Carries out one decrypted request body for a device. Never throws: a refusal is the answer. */
  async answer(device: string, body: unknown): Promise<ConnectResponse> {
    const request = checkRequest(body);
    if (!request.ok) return { ok: false, reason: request.reason };
    try {
      return { ok: true, result: await this.run(device, request.value) };
    } catch (error) {
      if (error instanceof Refused) return { ok: false, reason: error.message };
      console.error('[kestrel] connect request failed', request.value.op, error);
      return { ok: false, reason: SOMETHING_WENT_WRONG(this.deps.here) };
    }
  }

  /** A device went away: it watches nothing any more. */
  forget(device: string): void {
    this.watching.delete(device);
  }

  close(): void {
    this.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.watching.clear();
  }

  private reply(to: string, replyTo: string, body: ConnectResponse): Envelope<ConnectResponse> {
    const frame: Envelope<ConnectResponse> = { v: CONNECT_PROTOCOL_VERSION, from: this.deps.deviceId, to, kind: 'response', id: this.newId(), replyTo, body };
    this.deps.send(frame);
    return frame;
  }

  private newId(): string {
    return this.deps.newId?.() ?? `d${++this.counter}`;
  }

  private run(device: string, request: ConnectRequest): Promise<unknown> {
    switch (request.op) {
      case 'state.read':
        return this.deps.workspace.state();
      case 'session.read':
        return this.read(request.args);
      case 'session.watch':
        return this.watch(device, request.args.sessionId);
      case 'session.unwatch':
        this.watching.get(device)?.delete(request.args.sessionId);
        return Promise.resolve({ watching: false });
      case 'session.attach':
        return this.attach(request.args);
      case 'session.reply':
        return this.replyTo(request.args);
      case 'session.answer':
        return this.answerCard(request.args);
      case 'session.stop':
        return this.stop(request.args.sessionId);
      case 'session.seen':
        return this.seen(request.args.sessionId);
      case 'media.read':
        return this.media(request.args);
      case 'attachment.read':
        return this.attachment(request.args);
      case 'review.post':
        return this.postReview(request.args);
      case 'suggestion.answer':
        return this.suggestion(request.args.sessionId, (s) => s.answer(request.args.sessionId, request.args.suggestionId, request.args.button));
      case 'suggestion.dismiss':
        return this.suggestion(request.args.sessionId, (s) => s.dismiss(request.args.sessionId, request.args.suggestionId));
      case 'suggestion.undo':
        return this.suggestion(request.args.sessionId, (s) => s.undo(request.args.sessionId, request.args.suggestionId));
    }
  }

  /** A session anywhere in the workspace, archived ones too, or refused. */
  private async session(sessionId: string): Promise<Session> {
    const state = await this.deps.workspace.state();
    const session = state.sessions.find((s) => s.id === sessionId) ?? state.archived.sessions.find((s) => s.id === sessionId);
    if (!session) throw new Refused('That session is no longer in Kestrel.');
    return session;
  }

  /** The conversation as GET /api/sessions/:id gives it: what is stored, with the live one over it. */
  private async messages(sessionId: string): Promise<{ messages: ChatMessage[]; queue: unknown }> {
    const detail = await this.deps.workspace.detail(sessionId);
    if (!detail) throw new Refused('That session is no longer in Kestrel.');
    const overlay = this.deps.runtime.overlay(sessionId);
    return { messages: overlay?.messages ?? detail.messages, queue: overlay?.queue ?? detail.queue };
  }

  private async read({ sessionId, page }: ConnectOpArgs['session.read']) {
    const { messages, queue } = await this.messages(sessionId);
    const refusal = pageRefusal(messages, page);
    if (refusal) throw new Refused(refusal);
    const found = transcriptPage(messages, page);
    return { sessionId, ...found, messages: found.messages, ...(queue ? { queue } : {}) };
  }

  private async watch(device: string, sessionId: string) {
    await this.session(sessionId);
    const set = this.watching.get(device) ?? new Set<string>();
    this.watching.set(device, set.add(sessionId));
    return { watching: true };
  }

  private async attach({ draftId, name, mediaType, data }: ConnectOpArgs['session.attach']) {
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length === 0) throw new Refused('That photo is empty.');
    return this.deps.runtime.attachments.saveDraft(draftId, { name, mediaType }, bytes);
  }

  private async replyTo({ sessionId, text, draftId, attachments }: ConnectOpArgs['session.reply']) {
    await this.session(sessionId);
    // No change of model or mode rides on a phone's message: the session goes on as it was set at the desk.
    const outcome = await this.deps.runtime.reply(sessionId, text, {}, { draft: draftRefs({ draftId, attachments }) });
    return { outcome };
  }

  private async answerCard({ sessionId, requestId, optionId, text, answers }: ConnectOpArgs['session.answer']) {
    const { messages } = await this.messages(sessionId);
    const card = messages.find((m) => m.input?.id === requestId)?.input;
    if (!card || card.resolved) throw new Refused('That card is no longer waiting for an answer.');
    if (optionId !== undefined && !card.options.some((o) => o.id === optionId)) throw new Refused('That is not one of the card\'s choices.');
    await this.deps.runtime.answer(sessionId, requestId, { ...(optionId !== undefined ? { optionId } : {}), ...(text !== undefined ? { text } : {}), ...(answers ? { answers } : {}) });
    return { answered: true };
  }

  private async stop(sessionId: string) {
    await this.session(sessionId);
    await this.deps.runtime.stop(sessionId);
    return { stopped: true };
  }

  /** As the window does when a session is opened: its activity counts as looked at (shared/unread.ts). */
  private async seen(sessionId: string) {
    await this.session(sessionId);
    await this.deps.workspace.seen.mark([sessionId]);
    return { seen: true };
  }

  /** A suggestion card's button, x or Undo, as the suggestion route does them (suggestions/api.ts): the settled card comes back. */
  private async suggestion(sessionId: string, act: (suggestions: SessionRuntime['suggestions']) => Promise<unknown>) {
    await this.session(sessionId);
    return { suggestion: await act(this.deps.runtime.suggestions) };
  }

  /** As the review card's Post at the desk: the same edits, the same refusals (review-requests/reply.ts). */
  private async postReview({ sessionId, cardId, verdict, summary, findings, withoutComment }: ConnectOpArgs['review.post']) {
    const edit = { ...(verdict !== undefined ? { verdict } : {}), ...(summary !== undefined ? { summary } : {}), ...(findings !== undefined ? { findings } : {}), ...(withoutComment !== undefined ? { withoutComment } : {}) };
    return { review: await this.deps.runtime.reviewReplies.post(sessionId, cardId, edit) };
  }

  private async media({ sessionId, name }: ConnectOpArgs['media.read']) {
    const media = this.deps.runtime.display.mediaFile(sessionId, name);
    if (!media) throw new Refused('That picture is no longer there.');
    return { type: media.type, data: (await readFile(media.path)).toString('base64') };
  }

  private async attachment({ sessionId, attachmentId }: ConnectOpArgs['attachment.read']) {
    const stored = this.deps.runtime.attachments.file(sessionId, attachmentId);
    if (!stored) throw new Refused('That attachment is no longer there.');
    return { type: servedType(stored.attachment), name: stored.attachment.name, data: (await readFile(stored.path)).toString('base64') };
  }

  // ---- live output ------------------------------------------------------------------------

  private watched(sessionId: string): boolean {
    for (const set of this.watching.values()) if (set.has(sessionId)) return true;
    return false;
  }

  /** Gathered for a moment and sent once per session to each device watching it, as the window's live channel does. */
  private publish(sessionId: string, patch: LivePatch): void {
    if (!this.watched(sessionId)) return;
    const remote = remotePatch(patch);
    if (!remote) return;
    this.pending.set(sessionId, mergePatch(this.pending.get(sessionId) ?? {}, remote));
    this.timer ??= setTimeout(() => this.flush(), LIVE_FLUSH_MS);
  }

  /** Sends what was gathered now. Called by the timer; tests call it so they need not wait. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const [sessionId, patch] of this.pending) {
      for (const [device, ids] of this.watching) {
        if (ids.has(sessionId)) this.deps.send({ v: CONNECT_PROTOCOL_VERSION, from: this.deps.deviceId, to: device, kind: 'push', id: this.newId(), body: { type: 'live', sessionId, patch } });
      }
    }
    this.pending.clear();
  }
}
