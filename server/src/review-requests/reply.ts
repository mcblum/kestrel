// The reply to a review request: the `post_review` tool, which puts the agent's finished review in
// the conversation as a card, and posting that card to the host. Nothing reaches the host from
// the tool itself: the user posts the card (and may change its verdict and summary first), unless
// they chose "Review and reply on their own" for the session's project, when it is posted as soon
// as it is handed over. An approval is never posted when the request's head is no longer the
// commit that was reviewed.
import { randomUUID } from 'node:crypto';
import type { KestrelToolHost, ToolResult } from '../agents/types.ts';
import type { ChatMessage, Session } from '../model.ts';
import type { ByNumberProvider } from '../pull-requests/by-number.ts';
import type { CommandRunner } from '../pull-requests/types.ts';
import { hostTerms, type HostKind } from '../shared/host-terms.ts';
import { draftReview, summaryProblem, verdictProblem, VERDICT_POSTED, type ReviewReply, type ReviewVerdict } from '../shared/review-reply.ts';
import { repliesOnItsOwn, type ReviewAutomation } from '../shared/review-settings.ts';
import type { TranscriptAction } from '../transcript.ts';
import { Refused } from '../workspace.ts';
import { postReview } from './post.ts';

type Card = Extract<TranscriptAction, { type: 'card' }>;

export interface ReviewRepliesHost {
  session(sessionId: string): Promise<Session | undefined>;
  /** The messages of a session's conversation, as they are now. */
  messages(sessionId: string): readonly ChatMessage[];
  showCard(sessionId: string, card: Card): void;
  notice(sessionId: string, text: string, level: 'error' | 'info'): void;
  settings(): Promise<ReviewAutomation>;
  byNumber(host: HostKind): ByNumberProvider;
  run: CommandRunner;
  now(): number;
}

/** What the user changed on the card before posting it. */
export interface ReplyEdit {
  verdict?: unknown;
  summary?: unknown;
}

export class ReviewReplies {
  /** Cards being posted now, so a second click cannot post one twice. */
  private readonly posting = new Set<string>();

  constructor(private readonly host: ReviewRepliesHost) {}

  hostFor(sessionId: string): Pick<KestrelToolHost, 'postReview'> {
    return { postReview: (args) => this.tool(sessionId, args) };
  }

  /** `post_review`: a refusal goes back to the agent and shows in the conversation, like Kestrel's other tools. */
  private async tool(sessionId: string, args: { verdict?: unknown; summary?: unknown; comments?: unknown }): Promise<ToolResult> {
    try {
      const session = await this.host.session(sessionId);
      if (!session?.review) throw new Refused("This session is not reviewing somebody else's pull request, so there is nothing to post a review to. Say what you found in your reply.");
      const drafted = draftReview(args, session.review.sha);
      if ('problem' in drafted) throw new Refused(drafted.problem);
      const id = `review-${randomUUID()}`;
      this.host.showCard(sessionId, { type: 'card', id, review: drafted.reply });
      if (!repliesOnItsOwn(await this.host.settings(), session.startedIn)) return { text: 'Shown to the user, who decides whether to post it. Nothing has been posted. End your turn.' };
      try {
        const posted = await this.post(sessionId, id, {}, true);
        return { text: `Posted as ${VERDICT_POSTED[posted.posted!.verdict]}, as the user chose for this project.` };
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        this.host.notice(sessionId, `The review was not posted on its own: ${error.message}`, 'error');
        return { text: `Shown to the user, but not posted: ${error.message}` };
      }
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      this.host.notice(sessionId, `Kestrel refused post_review: ${error.message}`, 'error');
      return { text: error.message, isError: true };
    }
  }

  /** Post a review card to the host, with what the user changed on it. Resolves with the card as posted; throws `Refused` with the reason. */
  async post(sessionId: string, cardId: string, edit: ReplyEdit = {}, onItsOwn = false): Promise<ReviewReply> {
    const session = await this.host.session(sessionId);
    const draft = this.host.messages(sessionId).find((m) => m.id === cardId)?.review;
    if (!session?.review || !draft) throw new Refused('There is no such review in this session.');
    if (draft.posted) throw new Refused('This review was already posted.');
    if (!session.worktreePath || session.worktreeDiscarded) throw new Refused("This session's worktree is gone, so the review cannot be posted from it.");
    const problem = (edit.verdict !== undefined ? verdictProblem(edit.verdict) : null) ?? (edit.summary !== undefined ? summaryProblem(edit.summary) : null);
    if (problem) throw new Refused(problem);
    const reply: ReviewReply = { ...draft, ...(edit.verdict !== undefined ? { verdict: edit.verdict as ReviewVerdict } : {}), ...(edit.summary !== undefined ? { summary: (edit.summary as string).trim() } : {}) };
    if (this.posting.has(cardId)) throw new Refused('This review is being posted.');
    this.posting.add(cardId);
    try {
      const { host, number } = session.review;
      const terms = hostTerms(host);
      const found = await this.host.byNumber(host).pullRequestByNumber(session.worktreePath, number);
      if (found.state === 'unavailable') throw new Refused(`Could not check the ${terms.long} before posting: ${found.reason}`);
      const request = found.state === 'ready' ? found.value : null;
      if (!request) throw new Refused(`${terms.service} has no ${terms.long} ${terms.sigil}${number} any more.`);
      if (request.state === 'merged' || request.state === 'closed') throw new Refused(`This ${terms.long} is ${request.state} now, so the review was not posted.`);
      const moved = Boolean(request.headSha) && request.headSha !== reply.sha;
      // An approval says "this is good to merge": it may only be said of the commit that was read.
      if (reply.verdict === 'approve' && (moved || !request.headSha)) {
        throw new Refused(
          moved
            ? `The ${terms.long} has new commits since this review (it was made of ${reply.sha.slice(0, 12)}), so an approval was not posted. Review it again, or post this as a comment.`
            : `Could not tell which commit the ${terms.long} is at, so an approval was not posted.`,
        );
      }
      const how = await postReview(this.host.run, { host, number, cwd: session.worktreePath }, reply);
      const note = [how, moved ? `It was made of ${reply.sha.slice(0, 12)}; the ${terms.long} has new commits since.` : null].filter(Boolean).join(' ');
      const posted: ReviewReply = { ...reply, posted: { at: this.host.now(), verdict: reply.verdict, ...(onItsOwn ? { onItsOwn: true } : {}), ...(note ? { note } : {}) } };
      this.host.showCard(sessionId, { type: 'card', id: cardId, review: posted });
      return posted;
    } finally {
      this.posting.delete(cardId);
    }
  }
}
