// Optional actions end to end: the `suggest` tool, the title call's tag candidates, and the user's
// answer, dismissal or undo. The kind decides (registry.ts); this file only runs the steps in order,
// one at a time per session, and puts the result in the conversation. It never changes a session's
// state, so a suggestion never makes it need the user, never turns its dot yellow and never counts
// under Needs you, and the turn never waits on it.
import { randomUUID } from 'node:crypto';
import type { KestrelToolHost, ToolResult } from '../agents/types.ts';
import type { ChatMessage } from '../model.ts';
import { suggestionsIn, type Suggestion } from '../shared/suggestions.ts';
import { Refused } from '../workspace.ts';
import type { SuggestionPrefs } from './prefs.ts';
import type { KindContext, Pressed, SuggestionKind, SuggestionRegistry } from './registry.ts';

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
    return this.serial(sessionId, () => this.propose(sessionId, args)).catch((error) => ({ isError: true, text: `Kestrel could not take the suggestion: ${message(error)}` }));
  }

  /**
   * Something Kestrel does at once and records as a line with Undo (a kind whose proposal presses a
   * button straight away): the settled suggestion. Unlike `suggest`, a refusal is thrown as it is and
   * nothing is shown, so the caller can say why in its own words.
   */
  act(sessionId: string, args: Record<string, unknown>): Promise<Suggestion> {
    return this.serial(sessionId, async () => {
      const kind = this.deps.registry.get(args.kind);
      if ('reason' in kind) throw new Refused(kind.reason);
      const ctx = await this.context(sessionId);
      if (!ctx) throw new Refused('This session cannot take suggestions.');
      const payload = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'kind'));
      const proposal = await kind.propose(ctx, payload);
      if (proposal.type === 'refuse') throw new Refused(proposal.reason);
      if (proposal.type === 'skip') throw new Refused(proposal.text);
      if (!proposal.apply) throw new Error(`Suggestion kind "${kind.kind}" does not act at once.`);
      const suggestion: Suggestion = { id: this.newId(), sessionId, kind: kind.kind, ...proposal.draft, state: 'open', createdAt: this.now() };
      return this.pressAndShow(ctx, kind, suggestion, proposal.apply, true);
    });
  }

  /** Tag candidates the title call proposed: the same path as the tool. What is refused is only logged. */
  async fromTitle(sessionId: string, candidates: readonly Record<string, unknown>[]): Promise<void> {
    for (const candidate of candidates) {
      const result = await this.suggest(sessionId, { ...candidate, kind: 'tag' });
      if (result.isError || result.text !== SHOWN_TEXT) this.log(`title tag candidate for session ${sessionId}: ${result.text}`);
    }
  }

  /** The user pressed one of the card's buttons. */
  answer(sessionId: string, suggestionId: string, button: string): Promise<Suggestion> {
    return this.serial(sessionId, async () => {
      const { ctx, suggestion, kind } = await this.open(sessionId, suggestionId);
      if (!suggestion.buttons.some((b) => b.id === button)) throw new Refused('That suggestion has no such button.');
      return this.pressAndShow(ctx, kind, suggestion, button, false);
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
    return this.serial(sessionId, async () => {
      const ctx = await this.context(sessionId);
      const open = ctx ? suggestionsIn(ctx.messages).filter((s) => s.kind === kind && s.state === 'open' && settled(s.payload)) : [];
      for (const s of open) this.host.show(sessionId, { ...s, state: 'expired', answeredAt: this.now(), line: typeof line === 'string' ? line : line(s.payload) });
      return open.length;
    });
  }

  // ---- internals ---------------------------------------------------------------------------

  private async propose(sessionId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const kind = this.deps.registry.get(args.kind);
    if ('reason' in kind) return { isError: true, text: kind.reason };
    const ctx = await this.context(sessionId);
    if (!ctx) return { isError: true, text: 'This session cannot take suggestions.' };
    const payload = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'kind'));
    const proposal = await kind.propose(ctx, payload);
    if (proposal.type === 'refuse') return { isError: true, text: proposal.reason };
    if (proposal.type === 'skip') return { text: proposal.text };
    const suggestion: Suggestion = { id: this.newId(), sessionId, kind: kind.kind, ...proposal.draft, state: 'open', createdAt: this.now() };
    if (!proposal.apply) {
      this.host.show(sessionId, suggestion);
      return { text: SHOWN_TEXT };
    }
    const done = await this.pressAndShow(ctx, kind, suggestion, proposal.apply, true);
    return { text: `Done without asking, by the user's standing rule: ${done.line}. Carry on with the work.` };
  }

  private async pressAndShow(ctx: KindContext, kind: SuggestionKind, suggestion: Suggestion, button: string, auto: boolean, force?: 'dismissed'): Promise<Suggestion> {
    let pressed: Pressed;
    try {
      pressed = await kind.press(ctx, suggestion, button);
    } catch (error) {
      if (error instanceof Refused) throw error;
      // The kind can no longer do it (the session was archived, say): the card goes, and the user is told.
      this.host.show(ctx.sessionId, { ...suggestion, state: 'expired', answeredAt: this.now(), line: 'Suggestion no longer applies' });
      throw new Refused(`That suggestion no longer applies: ${message(error)}`);
    }
    const settled: Suggestion = { ...suggestion, state: force ?? pressed.state, answer: button, answeredAt: this.now(), line: pressed.line, ...(pressed.undo && kind.undo ? { undo: pressed.undo } : {}), ...(pressed.opens ? { opens: pressed.opens } : {}), ...(auto ? { auto: true } : {}) };
    this.host.show(ctx.sessionId, settled);
    return settled;
  }

  private async open(sessionId: string, suggestionId: string) {
    const found = await this.find(sessionId, suggestionId);
    if (found.suggestion.state !== 'open') throw new Refused('That suggestion has already been answered.');
    const kind = this.deps.registry.get(found.suggestion.kind);
    if ('reason' in kind) throw new Refused(kind.reason);
    return { ...found, kind };
  }

  private async find(sessionId: string, suggestionId: string): Promise<{ ctx: KindContext; suggestion: Suggestion }> {
    const ctx = await this.context(sessionId);
    const suggestion = ctx && suggestionsIn(ctx.messages).find((s) => s.id === suggestionId);
    if (!ctx || !suggestion) throw new Refused('No such suggestion in this session.');
    return { ctx, suggestion };
  }

  private async context(sessionId: string): Promise<KindContext | null> {
    const messages = await this.host.messages(sessionId);
    return messages ? { sessionId, messages, workspace: this.deps.workspace, prefs: this.deps.prefs } : null;
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
