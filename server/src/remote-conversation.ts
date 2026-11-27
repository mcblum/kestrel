// A session that runs on another computer, as `GET /api/sessions/:id` answers it (account-sessions.md, sections
// 9.2 and 19). The rule (Matt, 2026-11-25): the service is where a computer reads another computer's sessions
// from, and the other computer is asked only for what only it has.
//
// - Whole: this computer's kept copy (the replica, kept current from the service in the background), at once. It
//   is never slower, and never fails, because the other computer is slow or away.
// - The other computer is asked only when there is a reason: the kept copy is behind what the session's head says
//   (the upload lags a turn by a second or so), or the session is running or waiting on the person (its newest part
//   may not be uploaded yet). Then it is asked in the background; what it answers is laid over the copy where the
//   two meet, sent at once on the session's live channel, and kept here while the head says the same, so the next
//   read has it too.
// - "Did not answer" only when it is true and matters: the copy is behind and that computer was asked and did not
//   answer (or there is no account to ask through). A finished session with a whole copy never says it.
// - A page (`?last=` or `?before=&limit=`): from the kept copy; asked of the other computer only when the copy does
//   not have the message the page starts from.
import type { ChatMessage, SessionDetail, SessionSettings, SessionView } from './model.ts';
import type { RemoteRead } from './connect/link/remote-sessions.ts';
import { PAGE_MAX } from './shared/connect-ops.ts';
import type { Machine } from './shared/machines.ts';
import { messageKey, pageRefusal, transcriptPage, type PageAsk } from './shared/transcript-page.ts';
import { EMPTY_DETAIL } from './workspace-records.ts';

/** At most this many pages are read back to meet the kept copy (PAGE_MAX each). */
export const PAGES_BACK_MAX = 100;
/** The first page asked for: about one chunk, which is usually all the copy lacks. */
export const FIRST_PAGE = 50;

/** What this computer keeps of the conversation (connect/link/replica-sync.ts, `conversation`). */
export interface Kept {
  messages: ChatMessage[];
  /** The copy is all the session's head says there is. */
  current: boolean;
  readAt: number | null;
  /** The head's stamp the copy was compared with; what the other computer answered is kept while it is the same. */
  stamp?: string;
  /** Its model and mode as its head says them (issue 79): the row under the message box shows them at once. */
  settings?: SessionSettings;
}

/** Reads a page of a session from the computer that runs it; `fresh` when the person asked again. */
export type ReadRemote = (machine: string, sessionId: string, page: PageAsk, opts?: { fresh?: boolean }) => Promise<RemoteRead>;

export interface RemoteConversationDeps {
  /** Asks the session's machine for one page; null when there is no account to ask through. */
  read: ReadRemote | null;
  /** The kept copy, read locally. */
  kept(sessionId: string): Promise<Kept>;
  /** Lays newer messages over what a window shows, on the session's own live channel. */
  publish(sessionId: string, messages: ChatMessage[]): void;
}

export type RemoteAnswer = { status: 200; body: SessionDetail & { page?: { before: string | null; total: number } } } | { status: 404; body: { error: string } };

/**
 * What the other computer last said about a session: its newer part, laid over the copy of `stamp` (null when it
 * refused, so there is nothing to lay), or that it did not answer.
 */
type Asked = { reached: true; stamp: string; newer: ChatMessage[] | null } | { reached: false };

/**
 * The newer messages laid over the kept ones where they meet: the kept copy up to the first of `newer`, then
 * `newer`. Null when the first of `newer` is not in the kept copy.
 */
export function overKept(kept: readonly ChatMessage[], newer: readonly ChatMessage[]): ChatMessage[] | null {
  const first = newer[0];
  if (!first) return [...kept];
  const at = kept.findIndex((m, i) => messageKey(m, i) === first.id);
  return at < 0 ? null : [...kept.slice(0, at), ...newer];
}

/** The part of `met` that differs from `kept`, from the first message that is new or changed. */
export function newerPart(kept: readonly ChatMessage[], met: readonly ChatMessage[]): ChatMessage[] {
  let same = 0;
  while (same < kept.length && same < met.length && JSON.stringify(kept[same]) === JSON.stringify(met[same])) same++;
  // From the last shared message, so the part always meets the copy (`overKept`) even when nothing changed.
  return met.slice(Math.max(0, same - 1));
}

/** The whole conversation from the machine, met with the kept copy; or why it could not be read. */
async function wholeNow(read: ReadRemote, machine: string, sessionId: string, kept: readonly ChatMessage[], fresh: boolean): Promise<{ messages: ChatMessage[] } | { reached: boolean }> {
  let newer: ChatMessage[] = [];
  let ask: PageAsk = { last: FIRST_PAGE };
  for (let n = 0; n < PAGES_BACK_MAX; n++) {
    const answer = await read(machine, sessionId, ask, { fresh });
    if (!answer.ok) return { reached: answer.reached };
    newer = [...answer.page.messages, ...newer];
    if (answer.page.before === null) return { messages: newer };
    const met = overKept(kept, newer);
    if (met) return { messages: met };
    ask = { before: answer.page.before, limit: PAGE_MAX };
  }
  // Longer than is read back in one go: its newest part.
  return { messages: newer };
}

/** Whether the session's machine may have something the account's copy does not yet: a turn under way, or a card. */
export const mayBeAhead = (session: Pick<SessionView, 'state'>): boolean => session.state === 'running' || session.state === 'attention';

/** Remote conversations as one server reads them: one ask of each session's machine at a time, and what it last said. */
export class RemoteConversations {
  private readonly asked = new Map<string, Asked>();
  private readonly asking = new Map<string, Promise<void>>();

  constructor(private readonly deps: RemoteConversationDeps) {}

  /**
   * `GET /api/sessions/:id` for a session that runs on `machine`, whole or one page. `again`: the person pressed Try
   * again. `archived`: archived there, so its conversation is no longer held or followed.
   */
  async detail(session: SessionView, machine: Machine, ask: PageAsk | null, again = false, archived = false): Promise<RemoteAnswer> {
    const kept = await this.deps.kept(session.id);
    const base = { session, ...EMPTY_DETAIL, kestrelTools: 'unknown' as const, trail: [], ...(kept.settings ? { settings: kept.settings } : {}) };
    if (ask) return this.page(session, machine, ask, kept, base);

    const asked = this.asked.get(session.id);
    const laid = asked?.reached && asked.newer && asked.stamp === (kept.stamp ?? '') ? overKept(kept.messages, asked.newer) : null;
    // Archived there: its conversation is no longer held or followed, and what is kept here is all there is to show.
    const current = kept.current || laid !== null || archived;
    // Asked when the copy lacks something its head says, or a turn or card there may be ahead of the head.
    if (!current || mayBeAhead(session) || again) this.askInBackground(session.id, machine.id, kept, again);
    // Said only when it is true and matters: the copy is behind and that computer did not answer.
    const reachable = current || (this.deps.read !== null && asked?.reached !== false);
    return { status: 200, body: { ...base, messages: laid ?? kept.messages, remote: { machine, current, reachable, asOf: kept.readAt } } };
  }

  /** A page, from the kept copy; asked of the machine only when the copy does not have where it starts. */
  private async page(session: SessionView, machine: Machine, ask: PageAsk, kept: Kept, base: Omit<SessionDetail, 'messages'>): Promise<RemoteAnswer> {
    if (!pageRefusal(kept.messages, ask)) {
      const page = transcriptPage(kept.messages, ask);
      return { status: 200, body: { ...base, messages: page.messages, page: { before: page.before, total: page.total }, remote: { machine, current: kept.current, reachable: true, asOf: kept.readAt } } };
    }
    const answer = this.deps.read ? await this.deps.read(machine.id, session.id, ask) : null;
    if (answer?.ok) return { status: 200, body: { ...base, messages: answer.page.messages, page: { before: answer.page.before, total: answer.page.total }, remote: { machine, current: true, reachable: true, asOf: null } } };
    return { status: 404, body: { error: pageRefusal(kept.messages, ask)! } };
  }

  /** Asks the machine for what the copy lacks, once at a time per session; nothing waits for it. */
  private askInBackground(sessionId: string, machine: string, kept: Kept, fresh: boolean): void {
    const read = this.deps.read;
    if (!read) {
      this.asked.set(sessionId, { reached: false });
      return;
    }
    if (this.asking.has(sessionId)) return;
    const asking = wholeNow(read, machine, sessionId, kept.messages, fresh)
      .then((now) => {
        if (!('messages' in now)) {
          // Refused there (`reached`): it answered, so it is not "did not answer"; the copy is what there is.
          this.asked.set(sessionId, now.reached ? { reached: true, stamp: kept.stamp ?? '', newer: null } : { reached: false });
          return;
        }
        const newer = newerPart(kept.messages, now.messages);
        this.asked.set(sessionId, { reached: true, stamp: kept.stamp ?? '', newer });
        if (newer.length > 0) this.deps.publish(sessionId, newer);
      })
      .catch((error: unknown) => {
        this.asked.set(sessionId, { reached: false });
        console.error(`[kestrel] could not read a conversation from another computer: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => this.asking.delete(sessionId));
    this.asking.set(sessionId, asking);
  }

  /** Resolves when the asks under way are answered. For tests. */
  async settled(): Promise<void> {
    while (this.asking.size > 0) await Promise.all(this.asking.values());
  }
}
