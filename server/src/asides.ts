// Starting a sidebar (shared/asides.ts says what one is) from a point of a session's conversation.
// The agent's own SDK copies the conversation (`AgentAdapter.fork`, as Fork uses it: Claude's
// forkSession with the turn's last message, Codex's thread/fork with the turn's id) cut at the end of
// the turn the point is in, so the copy is the conversation as it was then; a point in the latest
// turn copies all of it. Kestrel stores the copy as a session marked as a sidebar, with no
// conversation of its own to show yet, working in the parent's worktree as a guest that never
// writes, in Read only. Nothing about the parent changes. One key in one parent has one sidebar:
// asking again gives back the one there is. Nothing here knows what the point is about; the caller
// says, in the subject.
import { existsSync } from 'node:fs';
import type { AgentAdapter } from './agents/types.ts';
import { AGENT_LABEL, type Agent, type ChatMessage, type Session } from './model.ts';
import type { StoredDetail } from './persistence/types.ts';
import { ASIDE_KEY_MAX, ASIDE_NAME, ASIDE_WORD, asideBrief, asideRefusal, asideTitle, pointSummary, sameAside, type AsideOf, type AsideSubject } from './shared/asides.ts';
import { forkPointOf, startersOf, turnSpans } from './shared/turns.ts';
import { isOpenWork } from './shared/workstreams.ts';
import { Refused, type Workspace } from './workspace.ts';

/** What a caller asks for: the point, which sidebar it is, and what it is about. */
export interface AsideRequest {
  /** The message or card id of the parent's conversation. */
  at: string;
  /** Which sidebar: the same key opens the same one. Default: one per point. */
  key?: string;
  subject?: AsideSubject | null;
}

export interface AsideDeps {
  workspace: Workspace;
  adapterFor(agent: Agent): AgentAdapter | undefined;
  /** A turn is running or starting in this session right now. */
  isWorking(sessionId: string): boolean;
  /** The session's conversation as it stands: the live one when it is loaded, else what is stored. */
  conversation(sessionId: string): Promise<StoredDetail | null>;
}

/**
 * Where in the agent's conversation the copy ends: at the end of the turn the point is in (`at`),
 * or at the end of the conversation when that is the latest turn (`at` undefined). When Kestrel has
 * no record of where an earlier turn ends, the whole conversation is copied and the sidebar is told
 * (`whole`). Throws the reason when it cannot be done.
 */
export function asideCut(messages: readonly ChatMessage[], pointId: string, working: boolean, title: string): { at?: string; whole?: true } {
  const index = messages.findIndex((m) => m.id === pointId);
  if (index < 0) throw new Refused('That point is no longer in this conversation.');
  const spans = turnSpans(messages);
  const n = spans.findIndex((span) => index >= span.start && index <= span.end);
  const latest = n < 0 || n === spans.length - 1;
  if (latest && working) throw new Refused(`"${title}" is still on the turn this point is in. Start the ${ASIDE_WORD} when that turn ends.`);
  if (latest) return {};
  const point = forkPointOf(startersOf(messages, spans[n]!));
  if (point) return { at: point };
  if (working) throw new Refused(`"${title}" is working, and Kestrel has no record of where that turn ends in the agent's conversation. Start the ${ASIDE_WORD} when this turn ends.`);
  return { whole: true };
}

export class Asides {
  /** Sidebars being made now, by finding, so a second click waits for the first instead of forking twice. */
  private readonly making = new Map<string, Promise<Session>>();

  constructor(private readonly deps: AsideDeps) {}

  /** The sidebar from one point of a session's conversation: the one there is with that key, or a new one. Throws `Refused` with the reason. */
  async open(sessionId: string, request: AsideRequest): Promise<Session> {
    const key = request.key || `point:${request.at}`;
    if (key.length > ASIDE_KEY_MAX) throw new Refused(`A ${ASIDE_WORD}'s key can be at most ${ASIDE_KEY_MAX} characters.`);
    const making = `${sessionId}\n${key}`;
    const pending = this.making.get(making);
    if (pending) return pending;
    const made = this.make(sessionId, { ...request, key }).finally(() => this.making.delete(making));
    this.making.set(making, made);
    return made;
  }

  /** The sidebar a session is, or null. */
  async asideOf(sessionId: string): Promise<AsideOf | null> {
    return (await this.deps.workspace.state()).sessions.find((s) => s.id === sessionId)?.aside ?? null;
  }

  private async make(sessionId: string, request: AsideRequest & { key: string }): Promise<Session> {
    const state = await this.deps.workspace.state();
    const main = state.sessions.find((s) => s.id === sessionId);
    if (!main) throw new Refused('No such session.');
    if (main.aside) throw new Refused(`A ${ASIDE_WORD} has no ${ASIDE_WORD}s of its own: ask about it here.`);
    const existing = state.sessions.find((s) => s.aside && sameAside(s.aside, { sessionId, key: request.key }));
    if (existing) return existing;
    const refusal = asideRefusal(main.agent);
    if (refusal) throw new Refused(refusal);
    const fork = this.deps.adapterFor(main.agent)?.fork;
    if (!fork) throw new Refused(`${AGENT_LABEL[main.agent]} in Kestrel cannot fork a conversation, so a ${ASIDE_WORD} cannot start from this session.`);
    const conversation = await this.deps.conversation(sessionId);
    if (!conversation?.agentSessionId) throw new Refused(`"${main.title}" never got far enough to have a conversation to copy.`);
    const point = conversation.messages.find((m) => m.id === request.at);
    if (!point) throw new Refused('That point is no longer in this conversation.');
    const directory = main.worktreePath;
    if (!directory || main.worktreeDiscarded || !existsSync(directory)) throw new Refused(`A ${ASIDE_WORD} reads the session's worktree, and "${main.title}" has none now.`);
    const cut = asideCut(conversation.messages, request.at, isOpenWork(main) || this.deps.isWorking(sessionId), main.title);
    let agentSessionId: string;
    try {
      agentSessionId = await fork(conversation.agentSessionId, { from: directory, to: directory, ...(cut.at ? { at: cut.at } : {}) });
    } catch (error) {
      throw new Refused(`The agent could not copy the conversation: ${error instanceof Error ? error.message : String(error)}`);
    }
    const subject = request.subject ?? null;
    const of: AsideOf = { sessionId, at: request.at, key: request.key, ...(subject ? { name: subject.name } : {}), summary: subject?.summary || pointSummary(point.text), ...(cut.whole ? { whole: true as const } : {}) };
    const about = subject?.context ?? `The point the user started from is this ${point.author === 'you' ? 'message of theirs' : 'part of the conversation'}:\n\n${point.text.trim().slice(0, 4_000) || '(a card with no text)'}`;
    const detail: StoredDetail = {
      messages: [],
      files: [],
      agentOutput: '',
      kestrelTools: conversation.kestrelTools,
      kestrelMissing: conversation.kestrelMissing ?? [],
      agentSessionId,
      // Read only, whatever the parent's own mode: it talks, and reads the worktree to check what it says.
      settings: { ...(conversation.settings ?? { model: '' }), permission: 'readonly' },
      inbox: [asideBrief(of, about)],
      guest: { hostId: sessionId, role: 'review', writes: false },
    };
    return this.deps.workspace.addAside(sessionId, { title: asideTitle(of), agent: main.agent, startedIn: main.startedIn, startedFolderId: main.startedFolderId, groupId: null, state: 'done', note: ASIDE_NAME, aside: of, hostId: sessionId }, detail);
  }
}
