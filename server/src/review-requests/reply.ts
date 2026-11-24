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
import { draftReview, editedFindings, isCleanApproval, postable, REVIEW_ENDS_TURN, summaryProblem, verdictFor, verdictProblem, VERDICT_POSTED, type ReviewReply, type ReviewVerdict } from '../shared/review-reply.ts';
import { repliesOnItsOwn, type ReviewAutomation } from '../shared/review-settings.ts';
import type { TranscriptAction } from '../transcript.ts';
import { Refused } from '../workspace.ts';
import { postReview } from './post.ts';
import type { DiffAnchors } from '../shared/diff-anchors.ts';

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
  /**
   * Which lines of the request's diff can take a comment, read in the review session's worktree from
   * its base to the reviewed commit (shared/diff-anchors.ts); undefined when it cannot be read.
   */
  diffAnchors?(worktreePath: string, sha: string): Promise<DiffAnchors | undefined>;
  /**
   * `post_review` from the reviewer of a session's own work (delegation.ts `handOverRound`): what to
   * tell the agent, or null when this session is not one.
   */
  roundReview?(sessionId: string, args: { verdict?: unknown; summary?: unknown; findings?: unknown; earlier?: unknown }): Promise<ToolResult | null>;
}

/** What the user changed on the card before posting it. */
export interface ReplyEdit {
  /** True: post the approval alone; the summary and any findings still kept stay in Kestrel. Only for an approval. */
  withoutComment?: unknown;
  verdict?: unknown;
  summary?: unknown;
  /** The card's findings as the user left them: reworded, re-marked or dismissed (`editedFindings`). */
  findings?: unknown;
}

export class ReviewReplies {
  /** Cards being posted now, so a second click cannot post one twice. */
  private readonly posting = new Set<string>();

  constructor(private readonly host: ReviewRepliesHost) {}

  hostFor(sessionId: string): Pick<KestrelToolHost, 'postReview'> {
    return { postReview: (args) => this.tool(sessionId, args) };
  }

  /** `post_review`: a refusal goes back to the agent and shows in the conversation, like Kestrel's other tools. */
  private async tool(sessionId: string, args: { verdict?: unknown; summary?: unknown; findings?: unknown; earlier?: unknown }): Promise<ToolResult> {
    try {
      const session = await this.host.session(sessionId);
      if (!session?.review) {
        const round = await this.host.roundReview?.(sessionId, args);
        if (round) return round;
        throw new Refused("This session is not reviewing somebody else's pull request or another session's work, so there is nothing to hand a review to. Say what you found in your reply.");
      }
      const drafted = draftReview(args, session.review.sha);
      if ('problem' in drafted) throw new Refused(drafted.problem);
      const id = `review-${randomUUID()}`;
      // The verdict follows the findings from the start: a review whose findings include a blocker asks for changes, whatever word came with it.
      // Where each finding will go on the host is decided now, from the commit that was reviewed, and shown on the card.
      const anchors = session.worktreePath ? await this.host.diffAnchors?.(session.worktreePath, session.review.sha).catch(() => undefined) : undefined;
      const review: ReviewReply = { ...drafted.reply, verdict: verdictFor(drafted.reply.verdict, drafted.reply.findings), ...(anchors ? { anchors } : {}) };
      this.host.showCard(sessionId, { type: 'card', id, review });
      if (!repliesOnItsOwn(await this.host.settings(), session.startedIn)) return { text: `Shown to the user, who decides whether to post it. Nothing has been posted. ${REVIEW_ENDS_TURN}` };
      try {
        // Posted as the card would be by default: a clean approval goes up without its summary.
        const posted = await this.post(sessionId, id, { withoutComment: isCleanApproval(review.verdict, review.findings) }, true);
        return { text: `Posted as ${VERDICT_POSTED[posted.posted!.verdict]}, as the user chose for this project. ${REVIEW_ENDS_TURN}` };
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
    const problem = (edit.verdict !== undefined ? verdictProblem(edit.verdict) : null);
    if (problem) throw new Refused(problem);
    const edited = editedFindings(draft.findings ?? [], edit.findings);
    if ('problem' in edited) throw new Refused(edited.problem);
    if (edit.summary !== undefined && typeof edit.summary !== 'string') throw new Refused('summary must be a string.');
    const reply: ReviewReply = { ...draft, findings: edited.findings, ...(edit.verdict !== undefined ? { verdict: edit.verdict as ReviewVerdict } : {}), ...(edit.summary !== undefined ? { summary: (edit.summary as string).trim() } : {}) };
    const summaryError = summaryProblem(reply.summary, edit.withoutComment === true || isCleanApproval(reply.verdict, reply.findings));
    if (summaryError) throw new Refused(summaryError);
    if (edit.withoutComment !== undefined && typeof edit.withoutComment !== 'boolean') throw new Refused('withoutComment must be a boolean.');
    const withoutComment = edit.withoutComment === true;
    if (withoutComment && reply.verdict !== 'approve') throw new Refused('Only an approval can be posted without comment.');
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
      // Kept findings go up as comments on their lines; dismissed ones stay on the card and go nowhere.
      // Each kept finding goes on its line when that line is part of the diff, else under the summary; comments are anchored to the reviewed commit.
      const how = await postReview(this.host.run, { host, number, cwd: session.worktreePath }, { verdict: reply.verdict, sha: reply.sha, ...postable(reply, withoutComment) });
      const note = [how.note, moved ? `It was made of ${reply.sha.slice(0, 12)}; the ${terms.long} has new commits since.` : null].filter(Boolean).join(' ');
      const posted: ReviewReply = { ...reply, posted: { at: this.host.now(), verdict: reply.verdict, ...(withoutComment ? { withoutComment: true } : {}), ...(onItsOwn ? { onItsOwn: true } : {}), ...(note ? { note } : {}), ...(Object.keys(how.moved).length > 0 ? { moved: how.moved } : {}) } };
      this.host.showCard(sessionId, { type: 'card', id: cardId, review: posted });
      return posted;
    } finally {
      this.posting.delete(cardId);
    }
  }
}
