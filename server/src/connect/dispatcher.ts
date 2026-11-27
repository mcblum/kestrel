// Kestrel Connect's dispatcher: carries out a phone's request, already decrypted, in this process, by
// calling the same functions the HTTP routes call (docs/designs/kestrel-connect.md, sections 3, 4, 6).
// It is never reached through the HTTP listener and adds none: the loopback, token, Origin and Host
// checks in security.ts are untouched. What a phone may ask is the closed list in shared/connect-ops.ts;
// anything else is refused with a reason. Nothing here knows which agent a session runs on.
import { readFile } from 'node:fs/promises';
import { draftRefs, servedType } from '../attachments/api.ts';
import { LIVE_FLUSH_MS, mergePatch } from '../live-channel.ts';
import { AGENT_LABEL, type Agent, type ChatMessage, type LivePatch, type Session } from '../model.ts';
import type { KestrelKind } from '../shared/host-kind.ts';
import { isSetupRunTool, SETUP_AT_DESK } from '../shared/setup-agent.ts';
import { Refused } from '../refused.ts';
import type { SessionRuntime } from '../runtime.ts';
import { setAutopilot } from '../pull-requests/autopilot-api.ts';
import { checkEnvelope, checkRequestFrom, CONNECT_PROTOCOL_VERSION, isConnectId, versionRefusal, type ConnectOpArgs, type ConnectRequest, type ConnectResponse, type Envelope } from '../shared/connect-ops.ts';
import { carriedFiles } from '../shared/remote-carry.ts';
import type { SessionRoute } from '../session-routes.ts';
import { deskSessionOp, isDeskSessionRequest } from './desk-session.ts';
import { pageRefusal, transcriptPage } from '../shared/transcript-page.ts';
import type { PullRequestsAnswer, ReviewsAnswer, StateAnswer, TicketsAnswer } from '../shared/connect-lists.ts';
import { ASIDE_REFUSAL } from '../shared/connect-ops.ts';
import { isComputerKind, type DeviceKind } from '../shared/connect.ts';
import type { Workspace } from '../workspace.ts';
import type { ValueRequests } from '../setup-values/requests.ts';
import { connectLists, type ConnectLists, type ListKind } from './lists.ts';
import { deskLeadChoices } from '../remote-starts/choices.ts';
import { remoteStartsOff } from '../remote-starts/prefs.ts';
import { agentModels, offersNow, offersSource } from '../remote-starts/offers.ts';
import { remoteStartRun, type AgentModels } from '../remote-starts/session-start.ts';
import { checkClone, type CloneProbe } from '../project-clone/checks.ts';
import type { ProjectCloner } from '../project-clone/clone.ts';
import { cloneTargetOf, cloningNote } from '../shared/project-clone.ts';
import { doesNotHave } from '../shared/start-computer.ts';
import type { CloneStart } from '../runtime/workdir.ts';
import { startRequestedReview } from '../review-requests/start-requested.ts';
import type { ReviewRequestStore } from '../review-requests/store.ts';
import { ticketsRoute, type TicketsApi } from '../tickets/api.ts';

/**
 * A frame pushed to a phone: live output of a session it watches, or the Code reviews or Tickets list
 * again when it changed, to a device that read it since its channel opened; and the state again when the
 * seen record changed, to a device that read the state since its channel opened.
 */
export type ConnectPush = { type: 'live'; sessionId: string; patch: LivePatch } | { type: 'state'; state: StateAnswer } | { type: 'reviews'; reviews: ReviewsAnswer } | { type: 'tickets'; tickets: TicketsAnswer } | { type: 'pull-requests'; pullRequests: PullRequestsAnswer };

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
  /** What only another computer, a desktop or a worker node, may ask (`who: 'desk'`); absent: every such operation is refused. */
  desk?: DeskOps | null;
  /** Projects kept off Kestrel Connect: left out of what this computer offers, as its record leaves them out. */
  keptOff: () => readonly string[];
  /** Which kind of server carries the requests out (default the app): a worker node refuses a start its agent cannot take. */
  kind?: KestrelKind;
  /** The session page's routes (session-routes.ts), which another desktop's desk-only operations call; absent, those are refused. */
  sessionRoute?: SessionRoute | null;
  /** On a worker node: how a project it does not have is checked and cloned when a session starts in it (item 64). */
  clones?: NodeClones | null;
}

/** A worker node's clone on demand (project-clone/): the checks before a start is accepted, and the clone after. */
export interface NodeClones {
  cloner: Pick<ProjectCloner, 'projectFor'>;
  probe: CloneProbe;
}

/** What `session.start` answers: the session, and what a desktop that started it draws its row with until its head arrives. */
interface StartAnswer {
  sessionId: string;
  title?: string;
  agent?: Agent;
  note?: string;
}

/** The desk-only operations' part: who a device is, by this computer's keyring, and the set-up value requests. */
export interface DeskOps {
  /** What the keyring this computer accepted says a device is; null when it is not in it. */
  kindOf(device: string): DeviceKind | null;
  values?: Pick<ValueRequests, 'ask' | 'withdraw' | 'dropDevice' | 'close'> | null;
}

/**
 * What of a live patch another device is sent: for a phone, the conversation as the window shows it, cards and all, and
 * where it stands; for a desktop also what its window draws beside the conversation (the changed files as carried, the
 * commands, background work and helpers), so the page there is this page. Never the agent's raw output.
 */
function remotePatch(patch: LivePatch, desk: boolean): LivePatch | null {
  const out: LivePatch = {
    ...(patch.messages ? { messages: patch.messages } : {}),
    ...(patch.removedMessages ? { removedMessages: patch.removedMessages } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.queue ? { queue: patch.queue } : {}),
    ...(patch.settings ? { settings: patch.settings } : {}),
    ...(patch.replacedBy ? { replacedBy: patch.replacedBy } : {}),
    // How full the context window is, as the window's ring shows it; counts and category names only.
    ...(patch.context ? { context: patch.context } : {}),
    ...(desk ? deskPart(patch) : {}),
  };
  return Object.keys(out).length > 0 ? out : null;
}

/** What a device reads and is then sent again when it changes: a list, or the state (only when what was seen changed). */
type ReadKind = ListKind | 'state';
/** What only a desktop is sent of a live patch (`remotePatch`). */
function deskPart(patch: LivePatch): LivePatch {
  return {
    ...(patch.files ? { files: carriedFiles(patch.files) } : {}),
    ...(patch.filesProblem !== undefined ? { filesProblem: patch.filesProblem } : {}),
    ...(patch.subagents ? { subagents: patch.subagents } : {}),
    ...(patch.subagentsAfter !== undefined ? { subagentsAfter: patch.subagentsAfter } : {}),
    ...(patch.backgroundTasks ? { backgroundTasks: patch.backgroundTasks } : {}),
    ...(patch.commands ? { commands: patch.commands } : {}),
    ...(patch.slashCommands ? { slashCommands: patch.slashCommands } : {}),
    ...(patch.kestrelTools ? { kestrelTools: patch.kestrelTools } : {}),
    ...(patch.kestrelMissing ? { kestrelMissing: patch.kestrelMissing } : {}),
    ...(patch.mcpServers ? { mcpServers: patch.mcpServers } : {}),
  };
}

const SOMETHING_WENT_WRONG = (here: string) => `Something went wrong on ${here}. Try again, or look at Kestrel there.`;

export class ConnectDispatcher {
  /** Device id -> the sessions it watches. */
  private readonly watching = new Map<string, Set<string>>();
  private readonly pending = new Map<string, LivePatch>();
  /** Device id -> the lists it has read since its channel opened, and so is sent again when they change. */
  private readonly reading = new Map<string, Set<ReadKind>>();
  private readonly changedLists = new Set<ReadKind>();
  private timer: NodeJS.Timeout | null = null;
  private counter = 0;
  private readonly lists: ConnectLists;
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: ConnectDeps) {
    this.lists = deps.lists ?? connectLists(deps.runtime.reviewPrefs, null, null);
    const offLive = deps.runtime.onLive((sessionId, patch) => this.publish(sessionId, patch));
    const offLists = this.lists.onChange((kind) => this.listChanged(kind));
    // A session read on any window, phone or computer of the account: a phone's unread dots follow at once.
    const offSeen = deps.workspace.seen.onChange(() => this.listChanged('state'));
    this.unsubscribe = () => {
      offLive();
      offLists();
      offSeen();
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
    // Desk-only operations, and a model or mode on a message, only from a computer of this computer's keyring, a desktop or a worker node (onboarding.md 19.6; worker-nodes.md, W2).
    const request = checkRequestFrom(body, isComputerKind(this.deps.desk?.kindOf(device)));
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
    this.deps.desk?.values?.dropDevice(device);
    this.watching.delete(device);
    this.reading.delete(device);
  }

  close(): void {
    this.deps.desk?.values?.close();
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
    // A session's page as another desktop shows it: the route's own function (desk-session.ts).
    if (isDeskSessionRequest(request)) {
      await this.session(request.args.sessionId);
      return deskSessionOp(request, this.deps.sessionRoute ?? null, this.deps.runtime, this.deps.here);
    }
    switch (request.op) {
      case 'state.read':
        this.markRead(device, 'state');
        return this.stateAnswer();
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
        return this.suggestion(request.args.sessionId, (s) => s.answer(request.args.sessionId, request.args.suggestionId, request.args.button, request.args.picks));
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
      // Desk only, checked in `answer` against this computer's keyring (onboarding.md 19.6).
      case 'setup.values':
        return this.setupValues(device, request.args);
      case 'setup.values.withdraw':
        this.deps.desk?.values?.withdraw(device, request.args.requestId);
        return {};
      case 'session.attachFile':
        return this.attach(request.args);
    }
  }

  /**
   * Another computer asks for a set-up step's values: answered only after the person here says Allow
   * (setup-values/requests.ts). What comes back is put in this reply alone, which the channel seals; it is
   * never logged, so every failure here is a refusal in fixed words.
   */
  private async setupValues(device: string, args: ConnectOpArgs['setup.values']): Promise<unknown> {
    const values = this.deps.desk?.values;
    if (!values) throw new Refused(`${this.deps.here} cannot copy set-up values: Set up this computer is not available there.`);
    try {
      return await values.ask(device, args);
    } catch (error) {
      throw error instanceof Refused ? error : new Refused(`${this.deps.here} could not answer.`);
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

  private async attach({ draftId, name, mediaType, data }: ConnectOpArgs['session.attach'] | ConnectOpArgs['session.attachFile']) {
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length === 0) throw new Refused(mediaType.startsWith('image/') ? 'That photo is empty.' : `${name} is empty.`);
    return this.deps.runtime.attachments.saveDraft(draftId, { name, mediaType }, bytes);
  }

  private async replyTo({ sessionId, text, draftId, attachments, model, permission, effort, fast }: ConnectOpArgs['session.reply']) {
    await this.session(sessionId);
    // A desktop's message carries its model, effort, fast mode and mode as the window's route takes them (refused from
    // a phone in `answer`, and Bypass by the list's check); a phone's goes on as the session was set at the desk.
    const settings = { ...(model !== undefined ? { model: model.slice(0, 80) } : {}), ...(permission !== undefined ? { permission } : {}), ...(effort !== undefined ? { effort } : {}), ...(fast !== undefined ? { fast } : {}) };
    const outcome = await this.deps.runtime.reply(sessionId, text, settings, { draft: draftRefs({ draftId, attachments }) });
    return { outcome };
  }

  private async answerCard({ sessionId, requestId, optionId, text, answers }: ConnectOpArgs['session.answer']) {
    const { messages } = await this.messages(sessionId);
    const card = messages.find((m) => m.input?.id === requestId)?.input;
    if (!card || card.resolved) throw new Refused('That card is no longer waiting for an answer.');
    // A set-up command runs on this computer only on the word of the person at it (onboarding.md 18.14).
    if (isSetupRunTool(card.tool)) throw new Refused(SETUP_AT_DESK);
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

  /** From now on the device is sent this again when it changes, until it says bye. */
  private markRead(device: string, kind: ReadKind): void {
    const set = this.reading.get(device) ?? new Set<ReadKind>();
    this.reading.set(device, set.add(kind));
  }

  /** The state as GET /api/state gives it, with the seen record as GET /api/seen gives it. */
  private async stateAnswer(): Promise<StateAnswer> {
    const [state, seen] = await Promise.all([this.deps.workspace.state(), this.deps.workspace.seen.view()]);
    return { ...state, seen };
  }

  /** The list as the window's page has it, or off in the desk's words; and the device is sent it again when it changes. */
  private readList(device: string, kind: ListKind): Promise<ReviewsAnswer | TicketsAnswer | PullRequestsAnswer> {
    this.markRead(device, kind);
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

  /** What a phone may start a session here with: the same value this computer holds as its `offers` record (remote-starts/offers.ts). */
  private startChoices() {
    return offersNow(offersSource(this.deps.runtime, this.deps.workspace, this.deps.here, undefined, undefined, this.deps.kind ?? 'app'), this.deps.keptOff());
  }

  /**
   * A new session here from a blank page on another device (A8): the same start the New session box makes,
   * with the user's typed message, so a ticket it names is taken up. Only while this computer's switch
   * allows it, and never in Bypass. The project and folder are checked by the runtime, as the box's are.
   * With a start id, a repeat (the starting device did not get the first answer in time) is answered with the
   * session the first made, never a second one (item 81). The answer comes once the row exists: a clone and the
   * agent's start come after it.
   */
  private async startSession({ startId, ...args }: ConnectOpArgs['session.start']): Promise<StartAnswer> {
    if (!startId) return this.startOnce(args);
    let first: StartAnswer | null = null;
    const { sessionId } = await this.deps.runtime.remoteStarts.ids.once(startId, async () => (first = await this.startOnce(args)).sessionId);
    return first ?? (await this.answerFor(sessionId));
  }

  /** What a repeated start answers: the session it started, as it is now. */
  private async answerFor(sessionId: string): Promise<StartAnswer> {
    const state = await this.deps.workspace.state();
    const session = [...state.sessions, ...state.archived.sessions].find((s) => s.id === sessionId);
    return session ? { sessionId, title: session.title, agent: session.agent, note: session.note } : { sessionId };
  }

  private async startOnce({ projectId, folderId, presetId, agent, model, mode, text, draftId, attachments, base }: Omit<ConnectOpArgs['session.start'], 'startId'>): Promise<StartAnswer> {
    await this.mayStart();
    const { presets } = await this.deps.runtime.whoDoesWhat.current();
    // The agent's list is asked for only when a model is named, and only the agent named: a start is accepted quickly.
    const agents = model !== undefined && agent !== undefined ? await agentModels(this.deps.runtime, agent) : [];
    const pick = { ...(presetId !== undefined ? { presetId } : {}), ...(agent !== undefined ? { agent } : {}), ...(model !== undefined ? { model } : {}), ...(mode !== undefined ? { mode } : {}) };
    const run = remoteStartRun(pick, presets, await this.deps.workspace.getUiState(), this.deps.here, agents);
    await this.refuseAgentThatCannotRun(run.agent, agents);
    const where = await this.whereToStart(projectId ?? null, base);
    const session = await this.deps.runtime.start({ ...run, projectId: where.projectId, folderId: where.clone ? null : (folderId ?? null), prompt: text, draft: draftRefs({ draftId, attachments }), byUser: true, ...(where.clone ? { clone: where.clone } : {}) });
    // The title, agent and note are for a desktop that started it, to draw its row before the head arrives (issue 52).
    return { sessionId: session.id, title: session.title, agent: session.agent, note: session.note };
  }

  /**
   * The project a start names, as this computer has it: its own project; its own project of the same repository when
   * the start names it by another computer's id; or, on a worker node, one it clones first, checked now so a refusal
   * comes before anything is made (worker-nodes.md section 9). An id it knows nothing of goes to the runtime, which says so.
   */
  private async whereToStart(projectId: string | null, base: string | undefined): Promise<{ projectId: string | null; clone?: CloneStart }> {
    if (projectId === null) return { projectId };
    const { projects } = await this.deps.workspace.view();
    if (projects.some((p) => p.id === projectId && !p.away)) return { projectId };
    const mine = projects.find((p) => !p.away && p.alsoOn?.some((m) => m.projectId === projectId));
    if (mine) return { projectId: mine.id };
    const target = cloneTargetOf(projects, projectId);
    if (!target) return { projectId };
    const clones = this.deps.clones;
    if ((this.deps.kind ?? 'app') !== 'node' || !clones) throw new Refused(doesNotHave(this.deps.here, target.name));
    const plan = await checkClone(target, { node: this.deps.here, keptOff: this.deps.keptOff(), ...(base ? { base } : {}), probe: clones.probe });
    return { projectId: null, clone: { note: cloningNote(plan.repos.map((r) => r.key)), project: (signal) => clones.cloner.projectFor(plan, { ...(base ? { base } : {}), ...(signal ? { signal } : {}) }) } };
  }

  /**
   * On a worker node, a start for an agent that cannot run there is refused with the node's own sentence (which names
   * it and the command to run there; runtime/agent-trouble.ts), instead of a session whose first turn fails. The app
   * lets the session start and says it on the session, as before.
   */
  private async refuseAgentThatCannotRun(agent: Agent, known: readonly AgentModels[]): Promise<void> {
    if ((this.deps.kind ?? 'app') !== 'node') return;
    const here = (known.length > 0 ? known : await agentModels(this.deps.runtime, agent, false)).find((a) => a.agent === agent);
    if (here && !here.available) throw new Refused(here.reason?.trim() || `${AGENT_LABEL[agent]} cannot run on ${this.deps.here} now.`);
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

  private listChanged(kind: ReadKind): void {
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
    this.pending.set(sessionId, mergePatch(this.pending.get(sessionId) ?? {}, patch));
    this.timer ??= setTimeout(() => this.flush(), LIVE_FLUSH_MS);
  }

  /** Sends what was gathered now. Called by the timer; tests call it so they need not wait. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flushLists();
    for (const [sessionId, gathered] of this.pending) {
      // Shaped once per kind of device: a phone gets the conversation's part, a desktop the page's too.
      const shaped = new Map<boolean, LivePatch | null>();
      for (const [device, ids] of this.watching) {
        if (!ids.has(sessionId)) continue;
        const desk = isComputerKind(this.deps.desk?.kindOf(device));
        if (!shaped.has(desk)) shaped.set(desk, remotePatch(gathered, desk));
        const patch = shaped.get(desk);
        if (patch) this.deps.send({ v: CONNECT_PROTOCOL_VERSION, from: this.deps.deviceId, to: device, kind: 'push', id: this.newId(), body: { type: 'live', sessionId, patch } });
      }
    }
    this.pending.clear();
  }

  /** Each changed list (or the state) once, from the view the store already built, to every device that read it. */
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
      else if (kind === 'state') void this.stateAnswer().then((state) => send({ type: 'state', state }), (error) => console.error('[kestrel] connect state push failed', error));
      else if (kind === 'pull-requests') void this.lists.pullRequests().then((pullRequests) => send({ type: 'pull-requests', pullRequests }), (error) => console.error('[kestrel] connect pull-requests push failed', error));
      else void this.lists.reviews().then((reviews) => send({ type: 'reviews', reviews }), (error) => console.error('[kestrel] connect reviews push failed', error));
    }
  }
}
