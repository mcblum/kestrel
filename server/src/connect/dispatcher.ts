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
import { setAutopilot } from '../pull-requests/autopilot-api.ts';
import { checkEnvelope, checkRequest, CONNECT_PROTOCOL_VERSION, isConnectId, versionRefusal, type ConnectOpArgs, type ConnectRequest, type ConnectResponse, type Envelope } from '../shared/connect-ops.ts';
import { pageRefusal, transcriptPage } from '../shared/transcript-page.ts';
import type { PullRequestsAnswer, ReviewsAnswer, TicketsAnswer } from '../shared/connect-lists.ts';
import { ASIDE_REFUSAL } from '../shared/connect-ops.ts';
import type { Workspace } from '../workspace.ts';
import { connectLists, type ConnectLists, type ListKind } from './lists.ts';
import { deskLeadChoices } from '../remote-starts/choices.ts';
import { remoteStartsOff } from '../remote-starts/prefs.ts';
import { remoteStartChoices, remoteStartRun } from '../remote-starts/session-start.ts';
import { startRequestedReview } from '../review-requests/start-requested.ts';
import type { ReviewRequestStore } from '../review-requests/store.ts';
import { ticketsRoute, type TicketsApi } from '../tickets/api.ts';

/**
 * A frame pushed to a phone: live output of a session it watches, or the Code reviews or Tickets list
 * again when it changed, to a device that read it since its channel opened.
 */
export type ConnectPush = { type: 'live'; sessionId: string; patch: LivePatch } | { type: 'reviews'; reviews: ReviewsAnswer } | { type: 'tickets'; tickets: TicketsAnswer } | { type: 'pull-requests'; pullRequests: PullRequestsAnswer };

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
  /** The Code reviews and Tickets lists. Default: the runtime's review setting and no stores (empty lists). */
  lists?: ConnectLists;
  /** The review requests the pages' buttons act on; absent where Kestrel asks no host. */
  reviewRequests?: ReviewRequestStore | null;
  /** The Tickets routes the pages' buttons call (`tickets/api.ts`); absent where there are none. */
  tickets?: TicketsApi | null;
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
    // How full the context window is, as the window's ring shows it; counts and category names only.
    ...(patch.context ? { context: patch.context } : {}),
  };
  return Object.keys(out).length > 0 ? out : null;
}

const SOMETHING_WENT_WRONG = (here: string) => `Something went wrong on ${here}. Try again, or look at Kestrel there.`;

export class ConnectDispatcher {
  /** Device id -> the sessions it watches. */
  private readonly watching = new Map<string, Set<string>>();
  private readonly pending = new Map<string, LivePatch>();
  /** Device id -> the lists it has read since its channel opened, and so is sent again when they change. */
  private readonly reading = new Map<string, Set<ListKind>>();
  private readonly changedLists = new Set<ListKind>();
  private timer: NodeJS.Timeout | null = null;
  private counter = 0;
  private readonly lists: ConnectLists;
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: ConnectDeps) {
    this.lists = deps.lists ?? connectLists(deps.runtime.reviewPrefs, null, null);
    const offLive = deps.runtime.onLive((sessionId, patch) => this.publish(sessionId, patch));
    const offLists = this.lists.onChange((kind) => this.listChanged(kind));
    this.unsubscribe = () => {
      offLive();
      offLists();
    };
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
    this.reading.delete(device);
  }

  close(): void {
    this.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.watching.clear();
    this.changedLists.clear();
    this.reading.clear();
  }

  private reply(to: string, replyTo: string, body: ConnectResponse): Envelope<ConnectResponse> {
    const frame: Envelope<ConnectResponse> = { v: CONNECT_PROTOCOL_VERSION, from: this.deps.deviceId, to, kind: 'response', id: this.newId(), replyTo, body };
    this.deps.send(frame);
    return frame;
  }

  private newId(): string {
    return this.deps.newId?.() ?? `d${++this.counter}`;
  }

  private async run(device: string, request: ConnectRequest): Promise<unknown> {
    // A sidebar is used only beside its conversation at the desk: no op acts on one (kestrel-connect.md, "Sidebars").
    if ('sessionId' in request.args) await this.notAside(request.args.sessionId);
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
      case 'session.compact':
        return this.compact(request.args.sessionId);
      case 'session.start':
        return this.startSession(request.args);
      case 'session.startChoices':
        return this.startChoices();
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
      case 'autopilot.set':
        return this.autopilotSet(request.args);
      case 'reviews.read':
        return this.readList(device, 'reviews');
      case 'tickets.read':
        return this.readList(device, 'tickets');
      case 'reviews.seen':
        this.reviewStore().markSeen(request.args.keys, request.args.seen);
        return Promise.resolve({ ok: true });
      case 'reviews.dismiss':
        this.reviewStore().dismiss(request.args.keys, request.args.dismissed);
        return Promise.resolve({ ok: true });
      case 'reviews.start':
        return this.startReview(request.args.key);
      case 'tickets.seen':
        return this.ticket('seen', 'PUT', { keys: request.args.keys, seen: request.args.seen });
      case 'tickets.dismiss':
        return this.ticket('dismissed', 'PUT', { keys: request.args.keys, dismissed: request.args.dismissed });
      case 'tickets.statuses':
        return this.ticket('statuses', 'GET', {}, request.args.key);
      case 'tickets.move':
        return this.ticket('move', 'POST', { key: request.args.key, to: request.args.to });
      case 'tickets.comment':
        return this.ticket('comment', 'POST', { key: request.args.key, body: request.args.body });
      case 'tickets.detail':
        return this.ticket('read', 'POST', { key: request.args.key });
      case 'tickets.work':
        return this.workTicket(request.args.key);
      case 'pullRequests.read':
        return this.readList(device, 'pull-requests');
      case 'findings.act':
        return this.findingAct(request.args);
      case 'reviewEnd.act':
        return this.reviewEndAct(request.args);
    }
  }

  /** Refuses a sidebar; any other id (one not in Kestrel too) is left to the op's own check. */
  private async notAside(sessionId: string): Promise<void> {
    const state = await this.deps.workspace.state();
    const session = state.sessions.find((s) => s.id === sessionId) ?? state.archived.sessions.find((s) => s.id === sessionId);
    if (session?.aside) throw new Refused(ASIDE_REFUSAL);
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
    // The page at the end carries how full the window is, by the call the window's ring makes.
    const context = 'before' in page ? {} : await this.deps.runtime.contextShown(sessionId);
    return { sessionId, ...found, messages: found.messages, ...(queue ? { queue } : {}), ...context };
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

  /** As the request pill's Autopilot entry: the same call, the same refusals. */
  private async autopilotSet({ sessionId, on, merge }: ConnectOpArgs['autopilot.set']) {
    await this.session(sessionId);
    return { autopilot: await setAutopilot(this.deps.runtime.autopilot, sessionId, { on, ...(merge === undefined ? {} : { merge }) }) };
  }

  private async stop(sessionId: string) {
    await this.session(sessionId);
    await this.deps.runtime.stop(sessionId);
    return { stopped: true };
  }

  /** As the context popup's Compact button: the agent compacts the conversation as a turn, or the reason it cannot now. */
  private async compact(sessionId: string) {
    await this.session(sessionId);
    await this.deps.runtime.compact(sessionId);
    return { compacting: true };
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

  /** One finding of a review card, as its route does it (finding-actions.ts): the finding as it now is. */
  private async findingAct({ sessionId, cardId, findingId, action, text }: ConnectOpArgs['findings.act']) {
    await this.session(sessionId);
    return { finding: await this.deps.runtime.findingActions.act(sessionId, cardId, findingId, action, text ?? '') };
  }

  /** The review-end card, as its route does it (review-end.ts): the card as it now is. */
  private async reviewEndAct({ sessionId, cardId, action, findingIds }: ConnectOpArgs['reviewEnd.act']) {
    await this.session(sessionId);
    return { reviewEnd: await this.deps.runtime.reviewEnds.act(sessionId, cardId, action, findingIds ?? []) };
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

  /** The list as the window's page has it, or off in the desk's words; and the device is sent it again when it changes. */
  private readList(device: string, kind: ListKind): Promise<ReviewsAnswer | TicketsAnswer | PullRequestsAnswer> {
    const set = this.reading.get(device) ?? new Set<ListKind>();
    this.reading.set(device, set.add(kind));
    if (kind === 'reviews') return this.lists.reviews();
    if (kind === 'pull-requests') return this.lists.pullRequests();
    return Promise.resolve(this.lists.tickets());
  }

  // ---- the pages' buttons (Matt, 2026-11-24; kestrel-connect.md, "Actions") ---------------------

  private reviewStore(): ReviewRequestStore {
    if (!this.deps.reviewRequests) throw new Refused(`Review requests are not available on ${this.deps.here}.`);
    return this.deps.reviewRequests;
  }

  /** A Tickets route, called as the window calls it: its refusals (tickets off, a source off, a ticket not held) are the phone's. */
  private async ticket(what: string, method: string, body: Record<string, unknown>, key?: string): Promise<unknown> {
    const url = new URL(`http://kestrel/api/tickets/${what}`);
    if (key !== undefined) url.searchParams.set('key', key);
    const answer = await ticketsRoute(['api', 'tickets', what], method, url, async () => body, this.deps.tickets ?? undefined);
    if (!answer) throw new Refused(`${this.deps.here} cannot do that with tickets.`);
    if (answer.status >= 400) throw new Refused((answer.body as { error?: string }).error ?? `${this.deps.here} could not do that with the ticket.`);
    return answer.body;
  }

  /** A8: another device starts a session here only while this computer's switch allows it. */
  private async mayStart(): Promise<Set<string>> {
    if (!(await this.deps.runtime.remoteStarts.prefs()).allowed) throw new Refused(remoteStartsOff(this.deps.here));
    return new Set((await this.deps.workspace.state()).sessions.map((s) => s.id));
  }

  /** What a phone may start a session here with: the switch, the agents, the presets and the New session box's choices. */
  private async startChoices() {
    const { allowed } = await this.deps.runtime.remoteStarts.prefs();
    const { presets } = await this.deps.runtime.whoDoesWhat.current();
    return remoteStartChoices(this.deps.here, allowed, remoteStartsOff(this.deps.here), presets, await this.deps.workspace.getUiState());
  }

  /**
   * A new session here from a blank page on another device (A8): the same start the New session box makes,
   * with the user's typed message, so a ticket it names is taken up. Only while this computer's switch
   * allows it, and never in Bypass. The project and folder are checked by the runtime, as the box's are.
   */
  private async startSession({ projectId, folderId, presetId, agent, mode, text, draftId, attachments }: ConnectOpArgs['session.start']) {
    await this.mayStart();
    const { presets } = await this.deps.runtime.whoDoesWhat.current();
    const run = remoteStartRun({ ...(presetId !== undefined ? { presetId } : {}), ...(agent !== undefined ? { agent } : {}), ...(mode !== undefined ? { mode } : {}) }, presets, await this.deps.workspace.getUiState(), this.deps.here);
    const session = await this.deps.runtime.start({ ...run, projectId: projectId ?? null, folderId: folderId ?? null, prompt: text, draft: draftRefs({ draftId, attachments }), byUser: true });
    return { sessionId: session.id };
  }

  /** The request's Start review button: restored, read, and its review started (or given back), never in Bypass. */
  private async startReview(key: string) {
    const before = await this.mayStart();
    const session = await startRequestedReview(this.reviewStore(), (request, opts) => this.deps.runtime.startReview(request, opts), key, { remote: true });
    return { sessionId: session.id, started: !before.has(session.id) };
  }

  /** The ticket's Start work button, with the choices the window's button sends, never in Bypass. */
  private async workTicket(key: string) {
    const before = await this.mayStart();
    const choices = deskLeadChoices(await this.deps.workspace.getUiState());
    const session = (await this.ticket('work', 'POST', { key, ...choices })) as Session;
    return { sessionId: session.id, started: !before.has(session.id) };
  }

  // ---- live output ------------------------------------------------------------------------

  private listChanged(kind: ListKind): void {
    if (![...this.reading.values()].some((kinds) => kinds.has(kind))) return;
    this.changedLists.add(kind);
    this.timer ??= setTimeout(() => this.flush(), LIVE_FLUSH_MS);
  }

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
    this.flushLists();
    for (const [sessionId, patch] of this.pending) {
      for (const [device, ids] of this.watching) {
        if (ids.has(sessionId)) this.deps.send({ v: CONNECT_PROTOCOL_VERSION, from: this.deps.deviceId, to: device, kind: 'push', id: this.newId(), body: { type: 'live', sessionId, patch } });
      }
    }
    this.pending.clear();
  }

  /** Each changed list once, from the view the store already built, to every device that read it. */
  private flushLists(): void {
    const kinds = [...this.changedLists];
    this.changedLists.clear();
    for (const kind of kinds) {
      const devices = [...this.reading].filter(([, read]) => read.has(kind)).map(([device]) => device);
      if (devices.length === 0) continue;
      const send = (body: ConnectPush) => {
        for (const device of devices) if (this.reading.get(device)?.has(kind)) this.deps.send({ v: CONNECT_PROTOCOL_VERSION, from: this.deps.deviceId, to: device, kind: 'push', id: this.newId(), body });
      };
      if (kind === 'tickets') send({ type: 'tickets', tickets: this.lists.tickets() });
      else if (kind === 'pull-requests') void this.lists.pullRequests().then((pullRequests) => send({ type: 'pull-requests', pullRequests }), (error) => console.error('[kestrel] connect pull-requests push failed', error));
      else void this.lists.reviews().then((reviews) => send({ type: 'reviews', reviews }), (error) => console.error('[kestrel] connect reviews push failed', error));
    }
  }
}
