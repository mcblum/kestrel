// Optional actions end to end: the `suggest` tool, the title call's tag candidates, and the user's
// answer, dismissal or undo. The kind decides (registry.ts); this file only runs the steps in order,
// one at a time per session, and puts the result in the conversation. It never changes a session's
// state, so a suggestion never makes it need the user, never turns its dot yellow and never counts
// under Needs you, and the turn never waits on it.
// A card about a session's pull request (shared/request-cards.ts) is shown where that rule says: a delegate
// child's on the top of its tree, naming the child (`about`), and its kind acts on the child as it would
// there. Such a card goes by itself once its request is merged or closed (`withdrawGone`), and one found
// gone when a button is pressed leaves its line instead of acting.
import { randomUUID } from 'node:crypto';
import type { KestrelToolHost, ToolResult } from '../agents/types.ts';
import type { ChatMessage } from '../model.ts';
import { cardSession, isRequestCard } from '../shared/request-cards.ts';
import { openSuggestions, suggestionsIn, type Suggestion } from '../shared/suggestions.ts';
import { Refused } from '../workspace.ts';
import type { SuggestionPrefs } from './prefs.ts';
import type { Draft, KindContext, Pressed, SuggestionKind, SuggestionRegistry } from './registry.ts';

/** What the model reads when its suggestion is shown. */
export const SHOWN_TEXT = 'Shown to the user as an optional suggestion. It does not wait for them: carry on with the work, and do not ask about it in your reply.';

/** What the suggestions need from the runtime. */
export interface SuggestionHost {
  /** The session's conversation (a stored session is loaded); null when it has none (sample data, deleted). */
  messages(sessionId: string): Promise<readonly ChatMessage[] | null>;
  /** Put the suggestion's message into the conversation, or replace it where it already is. */
  show(sessionId: string, suggestion: Suggestion): void;
}

export interface SuggestionDeps {
  registry: SuggestionRegistry;
  workspace: KindContext['workspace'];
  prefs: SuggestionPrefs;
  /** Where a card about this session's pull request is shown (`requestCardHome`). The session itself when absent. */
  homeOf?: (sessionId: string) => Promise<string>;
  /** Why a card about a pull request no longer applies (`requestCardGone` over the PR store); null while it does. */
  gone?: (suggestion: Suggestion) => string | null;
  now?: () => number;
  newId?: () => string;
  log?: (line: string) => void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class Suggestions {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly log: (line: string) => void;

  constructor(
    private readonly host: SuggestionHost,
    private readonly deps: SuggestionDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
    this.log = deps.log ?? ((line) => console.log(`[kestrel] ${line}`));
  }

  get prefs(): SuggestionPrefs {
    return this.deps.prefs;
  }

  hostFor(sessionId: string): Pick<KestrelToolHost, 'suggest'> {
    return {
      suggest: (args) => {
        const kind = this.deps.registry.get(args.kind);
        if (!('reason' in kind) && kind.kestrelOnly) return Promise.resolve({ isError: true, text: `Kestrel raises "${kind.kind}" suggestions itself; an agent cannot.` });
        return this.suggest(sessionId, args);
      },
    };
  }

  /** The `suggest` tool: shown, applied by a standing rule, not shown (and why), or refused. Never throws. */
  suggest(sessionId: string, args: Record<string, unknown>): Promise<ToolResult> {
    return this.homeFor(args.kind, sessionId)
      .then((home) => this.serial(home, () => this.propose(home, sessionId, args)))
      .catch((error) => ({ isError: true, text: `Kestrel could not take the suggestion: ${message(error)}` }));
  }

  /**
   * Something Kestrel does at once and records as a line with Undo (a kind whose proposal presses a
   * button straight away): the settled suggestion. Unlike `suggest`, a refusal is thrown as it is and
   * nothing is shown, so the caller can say why in its own words.
   */
  async act(sessionId: string, args: Record<string, unknown>): Promise<Suggestion> {
    const home = await this.homeFor(args.kind, sessionId);
    return this.serial(home, async () => {
      const kind = this.deps.registry.get(args.kind);
      if ('reason' in kind) throw new Refused(kind.reason);
      const ctx = await this.context(home, sessionId);
      if (!ctx) throw new Refused('This session cannot take suggestions.');
      const payload = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'kind'));
      const proposal = await kind.propose(ctx, payload);
      if (proposal.type === 'refuse') throw new Refused(proposal.reason);
      if (proposal.type === 'skip') throw new Refused(proposal.text);
      if (!proposal.apply) throw new Error(`Suggestion kind "${kind.kind}" does not act at once.`);
      return this.pressAndShow(ctx, kind, await this.newSuggestion(home, ctx, kind, proposal.draft), proposal.apply, true);
    });
  }

  /** Tag candidates the title call proposed: the same path as the tool. What is refused is only logged. */
  async fromTitle(sessionId: string, candidates: readonly Record<string, unknown>[]): Promise<void> {
    for (const candidate of candidates) {
      const result = await this.suggest(sessionId, { ...candidate, kind: 'tag' });
      // The reason only says the candidate was refused; its words come from the conversation, so they stay out of the log.
      if (result.isError || result.text !== SHOWN_TEXT) this.log(`a tag candidate from the title of session ${sessionId} was not shown`);
    }
  }

  /** The user pressed one of the card's buttons. */
  answer(sessionId: string, suggestionId: string, button: string, picks?: readonly string[]): Promise<Suggestion> {
    return this.serial(sessionId, async () => {
      const { ctx, suggestion, kind } = await this.open(sessionId, suggestionId);
      if (!suggestion.buttons.some((b) => b.id === button)) throw new Refused('That suggestion has no such button.');
      // Its request was merged or closed since it was raised (and the withdrawal was missed, across a restart say): it goes, and nothing is done.
      const gone = this.deps.gone?.(suggestion) ?? null;
      if (gone !== null) return this.expire(suggestion, gone);
      if (picks && !suggestion.picks) throw new Refused('That suggestion has nothing to choose from.');
      if (picks && !suggestion.picks!.buttons.includes(button)) throw new Refused('That button does not take a choice.');
      return this.pressAndShow(ctx, kind, suggestion, button, false, undefined, picks);
    });
  }

  /** The card's small x: the kind's "not now". */
  dismiss(sessionId: string, suggestionId: string): Promise<Suggestion> {
    return this.serial(sessionId, async () => {
      const { ctx, suggestion, kind } = await this.open(sessionId, suggestionId);
      return this.pressAndShow(ctx, kind, suggestion, kind.dismiss, false, 'dismissed');
    });
  }

  /** Undo on the line an answered suggestion left. */
  undo(sessionId: string, suggestionId: string): Promise<Suggestion> {
    return this.serial(sessionId, async () => {
      const { ctx, suggestion } = await this.find(sessionId, suggestionId);
      const kind = this.deps.registry.get(suggestion.kind);
      if ('reason' in kind || !kind.undo || !suggestion.undo) throw new Refused('There is nothing to undo there.');
      const line = await kind.undo(ctx, suggestion);
      const undone: Suggestion = { ...suggestion, line, undo: undefined };
      this.host.show(sessionId, undone);
      return undone;
    });
  }

  /**
   * Open cards of a kind that something else has since settled (Kestrel added the tag itself, say): each
   * leaves `line` instead of asking. `line` may be worked out per card from its payload. How many.
   */
  settle(sessionId: string, kind: string, settled: (payload: Record<string, unknown>) => boolean, line: string | ((payload: Record<string, unknown>) => string)): Promise<number> {
    return this.expireWhere(sessionId, isRequestCard(kind), (s) => (s.kind === kind && settled(s.payload) ? (typeof line === 'string' ? line : line(s.payload)) : null));
  }

  /**
   * The open cards about this session's pull request whose request was merged or closed (`gone`): each is
   * withdrawn with a line saying so, wherever it is shown. Never an answer: nothing is pressed. How many.
   */
  withdrawGone(sessionId: string): Promise<number> {
    const gone = this.deps.gone;
    return gone ? this.expireWhere(sessionId, true, (s) => (isRequestCard(s.kind) ? gone(s) : null)) : Promise.resolve(0);
  }

  // ---- internals ---------------------------------------------------------------------------

  /** Where a card of this kind about `sessionId` is shown: a request card by the rule, any other in the session itself. */
  private async homeFor(kind: unknown, sessionId: string): Promise<string> {
    return typeof kind === 'string' && isRequestCard(kind) && this.deps.homeOf ? this.deps.homeOf(sessionId) : sessionId;
  }

  /** A new open card in `home`'s conversation; one about another session names it first. */
  private async newSuggestion(home: string, ctx: KindContext, kind: SuggestionKind, draft: Draft): Promise<Suggestion> {
    const suggestion: Suggestion = { id: this.newId(), sessionId: home, kind: kind.kind, ...draft, state: 'open', createdAt: this.now() };
    if (ctx.sessionId === home) return suggestion;
    const title = (await ctx.workspace.state()).sessions.find((s) => s.id === ctx.sessionId)?.title ?? 'another session';
    const about = `For “${title}”, a session this one started.`;
    return { ...suggestion, about: ctx.sessionId, reason: draft.reason ? `${about} ${draft.reason}` : about };
  }

  private async propose(home: string, sessionId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const kind = this.deps.registry.get(args.kind);
    if ('reason' in kind) return { isError: true, text: kind.reason };
    const ctx = await this.context(home, sessionId);
    if (!ctx) return { isError: true, text: 'This session cannot take suggestions.' };
    const payload = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'kind'));
    const proposal = await kind.propose(ctx, payload);
    if (proposal.type === 'refuse') return { isError: true, text: proposal.reason };
    if (proposal.type === 'skip') return { text: proposal.text };
    const suggestion = await this.newSuggestion(home, ctx, kind, proposal.draft);
    if (!proposal.apply) {
      this.host.show(home, suggestion);
      return { text: SHOWN_TEXT };
    }
    const done = await this.pressAndShow(ctx, kind, suggestion, proposal.apply, true);
    return { text: `Done without asking, by the user's standing rule: ${done.line}. Carry on with the work.` };
  }

  private async pressAndShow(ctx: KindContext, kind: SuggestionKind, suggestion: Suggestion, button: string, auto: boolean, force?: 'dismissed', picks?: readonly string[]): Promise<Suggestion> {
    let pressed: Pressed;
    try {
      pressed = await kind.press(ctx, suggestion, button, picks);
    } catch (error) {
      if (error instanceof Refused) throw error;
      // The kind can no longer do it (the session was archived, say): the card goes, and the user is told.
      this.host.show(suggestion.sessionId, { ...suggestion, state: 'expired', answeredAt: this.now(), line: 'Suggestion no longer applies' });
      throw new Refused(`That suggestion no longer applies: ${message(error)}`);
    }
    // A card about another session links to it from its line, unless the kind named one of its own.
    const opens = pressed.opens ?? suggestion.about;
    const settled: Suggestion = { ...suggestion, state: force ?? pressed.state, answer: button, answeredAt: this.now(), line: pressed.line, ...(pressed.undo && kind.undo ? { undo: pressed.undo } : {}), ...(opens ? { opens } : {}), ...(pressed.link ? { link: pressed.link } : {}), ...(auto ? { auto: true } : {}) };
    this.host.show(suggestion.sessionId, settled);
    return settled;
  }

  /** A card withdrawn: it leaves `line`, with a link to the session it was about when that is another. */
  private expire(suggestion: Suggestion, line: string): Suggestion {
    const expired: Suggestion = { ...suggestion, state: 'expired', answeredAt: this.now(), line, ...(suggestion.about ? { opens: suggestion.about } : {}) };
    this.host.show(suggestion.sessionId, expired);
    return expired;
  }

  /** Withdraw the open cards about `sessionId` that `why` gives a line for, in its own conversation and, for request cards, where they are shown. */
  private async expireWhere(sessionId: string, placed: boolean, why: (s: Suggestion) => string | null): Promise<number> {
    const home = placed && this.deps.homeOf ? await this.deps.homeOf(sessionId) : sessionId;
    let count = 0;
    for (const where of new Set([sessionId, home])) {
      count += await this.serial(where, async () => {
        const messages = await this.host.messages(where);
        let n = 0;
        for (const s of openSuggestions(messages ?? [])) {
          const line = cardSession(s) === sessionId ? why(s) : null;
          if (line === null) continue;
          this.expire(s, line);
          n++;
        }
        return n;
      });
    }
    return count;
  }

  private async open(sessionId: string, suggestionId: string) {
    const found = await this.find(sessionId, suggestionId);
    if (found.suggestion.state !== 'open') throw new Refused('That suggestion has already been answered.');
    const kind = this.deps.registry.get(found.suggestion.kind);
    if ('reason' in kind) throw new Refused(kind.reason);
    return { ...found, kind };
  }

  private async find(sessionId: string, suggestionId: string): Promise<{ ctx: KindContext; suggestion: Suggestion }> {
    const messages = await this.host.messages(sessionId);
    const suggestion = messages && suggestionsIn(messages).find((s) => s.id === suggestionId);
    if (!messages || !suggestion) throw new Refused('No such suggestion in this session.');
    return { ctx: this.contextOf(messages, cardSession(suggestion)), suggestion };
  }

  /** What a kind sees: the conversation the card is in (`home`), and the session it is about (`about`), which it acts on. */
  private async context(home: string, about = home): Promise<KindContext | null> {
    const messages = await this.host.messages(home);
    return messages ? this.contextOf(messages, about) : null;
  }

  /**
   * The conversation as a kind reads it for one session: the cards about other sessions shown there (a
   * child's, on its root) are left out, so "already offered" and "one open at a time" count per session.
   */
  private contextOf(messages: readonly ChatMessage[], about: string): KindContext {
    const own = messages.some((m) => m.suggestion?.about !== undefined) ? messages.filter((m) => !m.suggestion || cardSession(m.suggestion) === about) : messages;
    return { sessionId: about, messages: own, workspace: this.deps.workspace, prefs: this.deps.prefs };
  }

  /** One step at a time per session, so two suggestions never both pass "one open at a time". */
  private serial<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(sessionId) ?? Promise.resolve()).then(work);
    const tail = next.catch(() => undefined);
    this.chains.set(sessionId, tail);
    void tail.then(() => {
      if (this.chains.get(sessionId) === tail) this.chains.delete(sessionId);
    });
    return next;
  }
}
