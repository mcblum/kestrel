// Raises and withdraws the cards about a pull request that needs the user (suggestions/request-kind.ts)
// from what the PR store holds (pull-requests/store.ts), the sessions' state and the user's choices in
// Settings → Git, by the one rule (shared/request-attention.ts). It runs a short while after any of them
// changes, one look at a time, and reads only the store's held answers: it never asks a host itself.
// - Raised once per session, request, reason and occurrence (the failing commit, the commit that
//   conflicts, the review that asks for changes), only while the session is idle and that reason's card
//   is offered, so a session that is working is looked at again when its turn ends. A guest never gets
//   one: its host does.
// - Withdrawn when that occurrence no longer holds (checks passed or run again, the conflicts were
//   resolved, the review no longer asks, a newer occurrence took its place, the request was merged or
//   closed, or the reason was turned off). Seen moving within this run only: a card left open across a
//   restart whose reason then went is caught when its button is pressed (it says it no longer applies).
import type { PullRequestLookup } from '../shared/details.ts';
import { occurrenceKey, requestAttention, sessionAttention, settledLine, type AttentionPrefs, type AttentionSession, type ReasonDetail, type RequestAttention } from '../shared/request-attention.ts';
import type { Sourced } from '../shared/sourced.ts';

/** A look runs this long after the change that asked for it, so a burst of writes is one look. */
export const ATTENTION_LOOK_MS = 300;

export interface AttentionWatchDeps {
  sessions(): Promise<readonly AttentionSession[]>;
  lookup(sessionId: string): Sourced<PullRequestLookup> | undefined;
  prefs(): Promise<AttentionPrefs>;
  /** Calls the listener on every change of the sessions, the store or the choices; returns how to stop. */
  onChange(listener: () => void): () => void;
  raise(sessionId: string, card: Omit<RequestAttention, 'reasons'> & ReasonDetail): Promise<unknown>;
  /** Settle the session's open cards for which `line` says why they no longer apply (null keeps one open). */
  withdraw(sessionId: string, line: (payload: Record<string, unknown>) => string | null): Promise<unknown>;
  lookMs?: number;
  log?: (line: string) => void;
}

/** One occurrence of one reason on one request. */
const keyOf = (a: Pick<RequestAttention, 'number'>, d: ReasonDetail): string => `${a.number}\n${occurrenceKey(d)}`;
const keysOf = (a: RequestAttention | null): ReadonlySet<string> => new Set(a ? a.reasons.map((d) => keyOf(a, d)) : []);

export class AttentionWatch {
  private readonly raised = new Set<string>();
  /** Per session, what its request needed at the last look (whatever the session was doing). */
  private held = new Map<string, ReadonlySet<string>>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private readonly off: () => void;

  constructor(private readonly deps: AttentionWatchDeps) {
    this.off = deps.onChange(() => this.soon());
  }

  /** Look now (tests), and wait for it. */
  look(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.lookOnce().catch((error: unknown) => (this.deps.log ?? console.error)(`[kestrel] the pull-request look failed: ${error instanceof Error ? error.message : String(error)}`));
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  stop(): void {
    this.off();
    if (this.timer) clearTimeout(this.timer);
  }

  private soon(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.look();
    }, this.deps.lookMs ?? ATTENTION_LOOK_MS);
    this.timer.unref?.();
  }

  private async lookOnce(): Promise<void> {
    const [sessions, prefs] = await Promise.all([this.deps.sessions(), this.deps.prefs()]);
    const next = new Map<string, ReadonlySet<string>>();
    for (const session of sessions) {
      if (session.hostId) continue;
      const lookup = this.deps.lookup(session.id);
      if (!lookup || lookup.state !== 'ready') {
        const kept = this.held.get(session.id);
        if (kept) next.set(session.id, kept);
        continue;
      }
      const now = keysOf(requestAttention(lookup, prefs));
      next.set(session.id, now);
      const before = this.held.get(session.id);
      if (before && [...before].some((k) => !now.has(k))) await this.deps.withdraw(session.id, (payload) => settledLine(payload as unknown as Parameters<typeof settledLine>[0], lookup, prefs));
      const fact = sessionAttention(session, lookup, prefs);
      for (const detail of fact?.reasons ?? []) {
        const key = `${session.id}\n${keyOf(fact!, detail)}`;
        if (prefs[detail.reason].card !== 'ask' || this.raised.has(key)) continue;
        this.raised.add(key);
        const { reasons: _all, ...request } = fact!;
        await this.deps.raise(session.id, { ...request, ...detail });
      }
    }
    this.held = next;
  }
}
