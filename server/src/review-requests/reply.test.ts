// Replying to a review request: what `post_review` accepts (shared/review-reply.ts), the commands
// that post it (post.ts), and when a card may be posted (reply.ts). gh and glab are never called.
import { describe, expect, it } from 'vitest';
import type { ChatMessage, Session } from '../model.ts';
import type { PullRequest } from '../shared/details.ts';
import { draftReview, foldComments, type ReviewReply } from '../shared/review-reply.ts';
import type { ReviewSettings } from '../shared/review-settings.ts';
import { ready, unavailable, type Sourced } from '../shared/sourced.ts';
import { ghReviewArgs, gitlabNote, glabApproveArgs, postReview } from './post.ts';
import { ReviewReplies } from './reply.ts';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const draft = (over: Partial<ReviewReply> = {}): ReviewReply => ({ verdict: 'comment', summary: 'Looks right.', comments: [], sha: SHA, ...over });

describe('what post_review accepts', () => {
  it('takes a verdict, a summary and comments on lines', () => {
    const result = draftReview({ verdict: 'approve', summary: ' Fine. ', comments: [{ path: './src/a.ts', line: 3, body: ' typo ' }] }, SHA);
    expect(result).toEqual({ reply: { verdict: 'approve', summary: 'Fine.', comments: [{ path: 'src/a.ts', line: 3, body: 'typo' }], sha: SHA } });
  });

  it('says what is wrong with a review it cannot use', () => {
    expect(draftReview({ verdict: 'lgtm', summary: 'x' }, SHA)).toMatchObject({ problem: expect.stringContaining('verdict must be one of') });
    expect(draftReview({ verdict: 'comment', summary: '  ' }, SHA)).toMatchObject({ problem: expect.stringContaining('summary is empty') });
    expect(draftReview({ verdict: 'comment', summary: 'x', comments: [{ path: '../etc/passwd', line: 1, body: 'x' }] }, SHA)).toMatchObject({ problem: expect.stringContaining('Comment 1: path') });
    expect(draftReview({ verdict: 'comment', summary: 'x', comments: [{ path: 'a.ts', line: 0, body: 'x' }] }, SHA)).toMatchObject({ problem: expect.stringContaining('Comment 1: line') });
  });

  it('writes comments under the summary when they cannot go on lines', () => {
    expect(foldComments('Sum.', [{ path: 'a.ts', line: 4, body: 'Off by one.' }])).toBe('Sum.\n\n**a.ts:4**\nOff by one.');
    expect(foldComments('Sum.', [])).toBe('Sum.');
  });
});

describe('the commands that post a review', () => {
  it('posts a GitHub review on the commit that was reviewed, with its comments on lines', () => {
    const args = ghReviewArgs(12, draft({ verdict: 'request_changes', comments: [{ path: 'a.ts', line: 4, body: 'Off by one.' }] }));
    expect(args.slice(0, 4)).toEqual(['api', '-X', 'POST', 'repos/{owner}/{repo}/pulls/12/reviews']);
    expect(args).toContain(`commit_id=${SHA}`);
    expect(args).toContain('event=REQUEST_CHANGES');
    expect(args).toContain('comments[][path]=a.ts');
    expect(args).toContain('comments[][line]=4');
  });

  it('approves on GitLab only at the commit that was reviewed, and says a request for changes in the note', () => {
    expect(glabApproveArgs(7, SHA)).toEqual(['mr', 'approve', '7', '--sha', SHA]);
    expect(gitlabNote(draft({ verdict: 'request_changes' }))).toBe('**Changes requested.**\n\nLooks right.');
  });

  it('posts again with the comments under the summary when GitHub refuses the lines', async () => {
    const calls: string[][] = [];
    const run = async (_bin: string, args: readonly string[]) => {
      calls.push([...args]);
      if (calls.length === 1) throw Object.assign(new Error('gh failed'), { stderr: 'HTTP 422: Unprocessable Entity' });
      return { stdout: '' };
    };
    const note = await postReview(run, { host: 'github', number: 12, cwd: '/w' }, draft({ comments: [{ path: 'a.ts', line: 4, body: 'Off by one.' }] }));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('body=Looks right.\n\n**a.ts:4**\nOff by one.');
    expect(calls[1]!.some((a) => a.startsWith('comments[]'))).toBe(false);
    expect(note).toContain('under the summary');
  });

  it('says why when the host does not take it', async () => {
    const run = async () => {
      throw Object.assign(new Error('gh failed'), { stderr: 'HTTP 403: Resource not accessible' });
    };
    await expect(postReview(run, { host: 'github', number: 12, cwd: '/w' }, draft())).rejects.toThrow(/GitHub did not take the review/);
  });

  it('on GitLab approves first, then posts one note', async () => {
    const calls: string[][] = [];
    const run = async (_bin: string, args: readonly string[]) => (calls.push([...args]), { stdout: '' });
    await postReview(run, { host: 'gitlab', number: 7, cwd: '/w' }, draft({ verdict: 'approve' }));
    expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['mr approve', 'mr note']);
  });
});

describe('posting a review card', () => {
  const session = (over: Partial<Session> = {}): Session => ({ id: 's1', startedIn: 'p1', worktreePath: '/w', worktreeDiscarded: false, review: { key: 'k', host: 'github', number: 12, sha: SHA, url: 'u' }, ...over }) as Session;
  const setUp = (opts: { session?: Session; request?: Sourced<PullRequest | null>; settings?: ReviewSettings } = {}) => {
    let messages: ChatMessage[] = [];
    const calls: string[][] = [];
    const notices: string[] = [];
    const replies = new ReviewReplies({
      session: async () => opts.session ?? session(),
      messages: () => messages,
      showCard: (_id, card) => {
        const message = { id: card.id, author: 'agent', time: '', text: '', review: card.review } as ChatMessage;
        messages = [...messages.filter((m) => m.id !== card.id), message];
      },
      notice: (_id, text) => void notices.push(text),
      settings: async () => opts.settings ?? { mode: 'list', projects: 'all' },
      byNumber: () => ({ pullRequestByNumber: async () => opts.request ?? ready({ number: 12, state: 'open', headSha: SHA } as PullRequest) }),
      run: async (_bin, args) => (calls.push([...args]), { stdout: '' }),
      now: () => 1000,
    });
    const tool = (args: Record<string, unknown>) => replies.hostFor('s1').postReview(args);
    return { replies, tool, calls, notices, card: () => messages[0] };
  };

  it('shows the review and posts nothing until the user does', async () => {
    const { tool, calls, card } = setUp();
    const result = await tool({ verdict: 'approve', summary: 'Good.' });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain('Nothing has been posted');
    expect(card()?.review).toMatchObject({ verdict: 'approve', sha: SHA });
    expect(calls).toEqual([]);
  });

  it('refuses in a session that is not a review, with the reason', async () => {
    const { tool, notices } = setUp({ session: session({ review: undefined }) });
    const result = await tool({ verdict: 'comment', summary: 'x' });
    expect(result.isError).toBe(true);
    expect(notices[0]).toContain('Kestrel refused post_review');
  });

  it('posts the card with what the user changed on it, and marks it posted', async () => {
    const { replies, tool, calls, card } = setUp();
    await tool({ verdict: 'approve', summary: 'Good.' });
    const posted = await replies.post('s1', card()!.id!, { verdict: 'comment', summary: 'Good, with one note.' });
    expect(calls[0]).toContain('event=COMMENT');
    expect(calls[0]).toContain('body=Good, with one note.');
    expect(posted.posted).toEqual({ at: 1000, verdict: 'comment' });
    expect(card()?.review?.posted?.verdict).toBe('comment');
    await expect(replies.post('s1', card()!.id!)).rejects.toThrow(/already posted/);
  });

  it('never approves a request whose head has moved since the review', async () => {
    const { replies, tool, calls, card } = setUp({ request: ready({ number: 12, state: 'open', headSha: OTHER } as PullRequest) });
    await tool({ verdict: 'approve', summary: 'Good.' });
    await expect(replies.post('s1', card()!.id!)).rejects.toThrow(/new commits since this review/);
    expect(calls).toEqual([]);
    const posted = await replies.post('s1', card()!.id!, { verdict: 'comment' });
    expect(posted.posted?.note).toContain('new commits since');
  });

  it('posts nothing to a request that is merged, gone, or cannot be checked', async () => {
    for (const request of [ready({ number: 12, state: 'merged', headSha: SHA } as PullRequest), ready(null), unavailable('gh is not signed in') as Sourced<PullRequest | null>]) {
      const { replies, tool, calls, card } = setUp({ request });
      await tool({ verdict: 'comment', summary: 'x' });
      await expect(replies.post('s1', card()!.id!)).rejects.toThrow();
      expect(calls).toEqual([]);
    }
  });

  it('posts on its own only where the user chose that', async () => {
    const chosen = setUp({ settings: { mode: 'reply', projects: ['p1'] } });
    expect((await chosen.tool({ verdict: 'approve', summary: 'Good.' })).text).toContain('Posted as an approval');
    expect(chosen.card()?.review?.posted).toMatchObject({ onItsOwn: true });
    const elsewhere = setUp({ settings: { mode: 'reply', projects: ['p2'] } });
    await elsewhere.tool({ verdict: 'approve', summary: 'Good.' });
    expect(elsewhere.calls).toEqual([]);
    const startOnly = setUp({ settings: { mode: 'start', projects: 'all' } });
    await startOnly.tool({ verdict: 'approve', summary: 'Good.' });
    expect(startOnly.calls).toEqual([]);
  });

  it('leaves the card for the user when posting on its own is refused', async () => {
    const { tool, notices, card } = setUp({ settings: { mode: 'reply', projects: 'all' }, request: ready({ number: 12, state: 'open', headSha: OTHER } as PullRequest) });
    const result = await tool({ verdict: 'approve', summary: 'Good.' });
    expect(result.text).toContain('not posted');
    expect(card()?.review?.posted).toBeUndefined();
    expect(notices[0]).toContain('not posted on its own');
  });
});
