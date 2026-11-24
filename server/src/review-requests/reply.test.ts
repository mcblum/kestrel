// Replying to a review request: what `post_review` accepts (shared/review-reply.ts), the commands
// that post it (post.ts), and when a card may be posted (reply.ts). gh and glab are never called.
import { describe, expect, it } from 'vitest';
import type { ChatMessage, Session } from '../model.ts';
import type { PullRequest } from '../shared/details.ts';
import { BRIEF_MAX, draftReview, postedSummary, editedFindings, findingMark, foldComments, keptFindings, orderFindings, postable, verdictFor, type OutgoingReview, type ReviewFinding, type ReviewReply } from '../shared/review-reply.ts';
import type { ReviewAutomation as ReviewSettings } from '../shared/review-settings.ts';
import { ready, unavailable, type Sourced } from '../shared/sourced.ts';
import { ghReviewArgs, gitlabNote, glabApproveArgs, postReview } from './post.ts';
import { ReviewReplies } from './reply.ts';
import { anchorsFromDiff, type DiffAnchors } from '../shared/diff-anchors.ts';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const draft = (over: Partial<ReviewReply> = {}): ReviewReply => ({ verdict: 'comment', summary: 'Looks right.', findings: [], sha: SHA, ...over });
/** A review as it goes to the host. */
const out = (over: Partial<OutgoingReview> = {}): OutgoingReview => ({ verdict: 'comment', summary: 'Looks right.', comments: [], sha: SHA, ...over });

describe('what post_review accepts', () => {
  const finding = (over: Record<string, unknown> = {}) => ({ brief: 'Off by one.', priority: 'high', blocking: true, ...over });

  it('takes a verdict, a summary and findings, and names each finding by its place', () => {
    const result = draftReview({ verdict: 'approve', summary: ' Fine. ', findings: [finding({ brief: ' typo ', detail: ' why ', fix: '', refs: [{ path: './src/a.ts', line: 3 }] }), finding({ blocking: false, priority: 'low' })] }, SHA);
    expect(result).toEqual({
      reply: {
        verdict: 'approve',
        summary: 'Fine.',
        findings: [
          { id: 'f1', brief: 'typo', detail: 'why', priority: 'high', blocking: true, refs: [{ path: 'src/a.ts', line: 3 }] },
          { id: 'f2', brief: 'Off by one.', priority: 'low', blocking: false, refs: [] },
        ],
        sha: SHA,
      },
    });
    expect(draftReview({ verdict: 'comment', summary: 'x' }, SHA)).toMatchObject({ reply: { findings: [] } });
  });

  it('requires an agent rationale even for clean approvals', () => {
    expect(draftReview({ verdict: 'approve', summary: '', findings: [] }, SHA)).toHaveProperty('problem');
    for (const verdict of ['comment', 'request_changes']) {
      expect(draftReview({ verdict, summary: '' }, SHA)).toHaveProperty('problem');
    }
    expect(draftReview({ verdict: 'approve', summary: '', findings: [finding()] }, SHA)).toHaveProperty('problem');
  });

  it('says what is wrong with a review it cannot use', () => {
    const bad = (f: Record<string, unknown>) => draftReview({ verdict: 'comment', summary: 'x', findings: [f] }, SHA);
    expect(draftReview({ verdict: 'lgtm', summary: 'x' }, SHA)).toMatchObject({ problem: expect.stringContaining('verdict must be one of') });
    expect(draftReview({ verdict: 'comment', summary: '  ' }, SHA)).toMatchObject({ problem: expect.stringContaining('summary is empty') });
    expect(bad(finding({ brief: ' ' }))).toMatchObject({ problem: expect.stringContaining('Finding 1: brief is empty') });
    expect(bad(finding({ brief: 'x'.repeat(BRIEF_MAX + 1) }))).toMatchObject({ problem: expect.stringContaining('Keep it to a sentence or two') });
    expect(bad(finding({ priority: 'urgent' }))).toMatchObject({ problem: expect.stringContaining('priority must be one of: high, medium, low') });
    expect(bad(finding({ blocking: 'yes' }))).toMatchObject({ problem: expect.stringContaining('blocking must be true or false') });
    expect(bad(finding({ refs: [{ path: '../etc/passwd', line: 1 }] }))).toMatchObject({ problem: expect.stringContaining('path must be a file relative to the repository') });
    expect(bad(finding({ refs: [{ path: 'a.ts', line: 0 }] }))).toMatchObject({ problem: expect.stringContaining('line must be a line number') });
  });

  it('writes comments under the summary when they cannot go on lines', () => {
    expect(foldComments('Sum.', [{ path: 'a.ts', line: 4, body: 'Off by one.' }])).toBe('Sum.\n\n**a.ts:4**\nOff by one.');
    expect(foldComments('Sum.', [])).toBe('Sum.');
  });
});

describe('findings, as the user leaves them and as they are posted', () => {
  const f = (id: string, over: Partial<ReviewFinding> = {}): ReviewFinding => ({ id, brief: `Problem ${id}.`, priority: 'medium', blocking: false, refs: [], ...over });

  it('the verdict follows the findings: changes while one blocks, and never on the agent’s word alone', () => {
    expect(verdictFor('comment', [f('f1', { blocking: true })])).toBe('request_changes');
    expect(verdictFor('approve', [f('f1', { blocking: true })])).toBe('request_changes');
    // The only blocker is dismissed, or no longer marked blocking.
    expect(verdictFor('request_changes', [f('f1', { blocking: true, dismissed: true })])).toBe('comment');
    expect(verdictFor('request_changes', [f('f1')])).toBe('comment');
    expect(verdictFor('approve', [f('f1')])).toBe('approve');
    expect(verdictFor('approve', [])).toBe('approve');
  });

  it('an edit rewords, re-marks or dismisses the card’s own findings, and cannot add one', () => {
    const own = [f('f1', { blocking: true }), f('f2')];
    const edited = editedFindings(own, [{ ...own[1], brief: 'Reworded.', priority: 'low' }, { ...own[0], dismissed: true }, f('f9', { brief: 'Invented.' })]);
    expect(edited).toEqual({ findings: [{ ...own[0], dismissed: true }, { ...own[1], brief: 'Reworded.', priority: 'low' }] });
    expect(editedFindings(own, undefined)).toEqual({ findings: own });
    expect(editedFindings(own, [{ ...own[0], brief: '' }])).toMatchObject({ problem: expect.stringContaining('Finding 1: brief is empty') });
  });

  it('are ordered highest priority first, then the ones that block, keeping the agent’s order among equals', () => {
    const order = orderFindings([f('a', { priority: 'low' }), f('b', { priority: 'high' }), f('c', { blocking: true, priority: 'low' }), f('d', { priority: 'high' })]).map((x) => x.id);
    expect(order).toEqual(['b', 'd', 'c', 'a']);
  });

  it('a kept finding goes up as one comment on its first line; one with no line goes under the summary; a dismissed one goes nowhere', () => {
    const out = postable({
      summary: 'Sum.',
      findings: [
        f('f1', { brief: 'Covers the first row.', detail: 'Because `top` assumes the page scrolls.', fix: 'Read it from the scroll parent.', priority: 'high', blocking: true, refs: [{ path: 'a.ts', line: 4 }, { path: 'b.ts', line: 9 }] }),
        f('f2', { brief: 'No changelog entry.', priority: 'low' }),
        f('f3', { brief: 'Dismissed.', dismissed: true, refs: [{ path: 'c.ts', line: 1 }] }),
      ],
    });
    expect(out.comments).toEqual([{ findingId: 'f1', path: 'a.ts', line: 4, body: '**High priority · Blocks.** Covers the first row.\n\nBecause `top` assumes the page scrolls.\n\n**Suggested fix:** Read it from the scroll parent.\n\nAlso: `b.ts:9`' }]);
    expect(postedSummary(out)).toBe('Sum.\n\n1 finding is a comment on the code.\n\n**Low priority.** No changelog entry.');
    expect(findingMark({ blocking: false, priority: 'medium' })).toBe('Medium priority');
    expect(keptFindings([f('f1'), f('f2', { dismissed: true })]).map((x) => x.id)).toEqual(['f1']);
  });
});

describe('the commands that post a review', () => {
  it('posts a GitHub review on the commit that was reviewed, with its comments on lines', () => {
    const args = ghReviewArgs(12, out({ verdict: 'request_changes', comments: [{ path: 'a.ts', line: 4, body: 'Off by one.' }] }));
    expect(args.slice(0, 4)).toEqual(['api', '-X', 'POST', 'repos/{owner}/{repo}/pulls/12/reviews']);
    expect(args).toContain(`commit_id=${SHA}`);
    expect(args).toContain('event=REQUEST_CHANGES');
    expect(args).toContain('comments[][path]=a.ts');
    expect(args).toContain('comments[][line]=4');
  });

  it('approves on GitLab only at the commit that was reviewed, and says a request for changes in the note', () => {
    expect(glabApproveArgs(7, SHA)).toEqual(['mr', 'approve', '7', '--sha', SHA]);
    expect(gitlabNote(out({ verdict: 'request_changes' }))).toBe('**Changes requested.**\n\nLooks right.');
  });

  it('posts again with the comments under the summary when GitHub refuses the lines', async () => {
    const calls: string[][] = [];
    const run = async (_bin: string, args: readonly string[]) => {
      calls.push([...args]);
      if (calls.length === 1) throw Object.assign(new Error('gh failed'), { stderr: 'HTTP 422: Unprocessable Entity' });
      return { stdout: '' };
    };
    const how = await postReview(run, { host: 'github', number: 12, cwd: '/w' }, out({ comments: [{ findingId: 'f1', path: 'a.ts', line: 4, body: 'Off by one.' }] }));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('body=Looks right.\n\n1 finding is a comment on the code.');
    expect(calls[1]).toContain('body=Looks right.\n\n**a.ts:4**\nOff by one.');
    expect(calls[1]!.some((a) => a.startsWith('comments[]'))).toBe(false);
    expect(how.note).toContain('under the summary');
    expect(how.moved).toEqual({ f1: 'GitHub would not take a comment on its line' });
  });

  it('says why when the host does not take it', async () => {
    const run = async () => {
      throw Object.assign(new Error('gh failed'), { stderr: 'HTTP 403: Resource not accessible' });
    };
    await expect(postReview(run, { host: 'github', number: 12, cwd: '/w' }, out())).rejects.toThrow(/GitHub did not take the review/);
  });

  it('approves without a body on GitHub and without a note on GitLab', async () => {
    const calls: string[][] = [];
    const run = async (_bin: string, args: readonly string[]) => (calls.push([...args]), { stdout: '' });
    const approval = out({ verdict: 'approve', summary: '' });
    await postReview(run, { host: 'github', number: 12, cwd: '/w' }, approval);
    expect(calls[0]).toContain('event=APPROVE');
    expect(calls[0]!.some((arg) => arg.startsWith('body='))).toBe(false);
    await postReview(run, { host: 'gitlab', number: 7, cwd: '/w' }, approval);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(glabApproveArgs(7, SHA));
  });

  it('on GitLab approves first, then posts one note', async () => {
    const calls: string[][] = [];
    const run = async (_bin: string, args: readonly string[]) => (calls.push([...args]), { stdout: '' });
    await postReview(run, { host: 'gitlab', number: 7, cwd: '/w' }, out({ verdict: 'approve' }));
    expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['mr approve', 'mr note']);
  });
});

describe('posting a review card', () => {
  const session = (over: Partial<Session> = {}): Session => ({ id: 's1', startedIn: 'p1', worktreePath: '/w', worktreeDiscarded: false, review: { key: 'k', host: 'github', number: 12, sha: SHA, url: 'u' }, ...over }) as Session;
  const setUp = (opts: { session?: Session; request?: Sourced<PullRequest | null>; settings?: ReviewSettings; anchors?: DiffAnchors; answer?: (args: readonly string[]) => string } = {}) => {
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
      run: async (_bin, args) => (calls.push([...args]), { stdout: opts.answer?.(args) ?? '' }),
      now: () => 1000,
      diffAnchors: async () => opts.anchors,
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

  it('keeps the rationale in Kestrel when approval omits the summary on the host', async () => {
    const { replies, tool, calls, card } = setUp();
    await tool({ verdict: 'approve', summary: 'The implementation covers the edge cases.' });
    const posted = await replies.post('s1', card()!.id!, { withoutComment: true });
    expect(posted.summary).toBe('The implementation covers the edge cases.');
    expect(posted.posted?.withoutComment).toBe(true);
    expect(calls[0]).toContain('event=APPROVE');
    expect(calls[0]!.some((arg) => arg.startsWith('body='))).toBe(false);
  });

  it('only an approval goes up without comment', async () => {
    const { replies, tool, calls, card } = setUp();
    await tool({ verdict: 'comment', summary: 'A note.' });
    await expect(replies.post('s1', card()!.id!, { withoutComment: true })).rejects.toThrow(/Only an approval/);
    await expect(replies.post('s1', card()!.id!, { verdict: 'request_changes', withoutComment: true })).rejects.toThrow(/Only an approval/);
    expect(calls).toEqual([]);
  });

  it('an approval without comment posts nothing else, whatever findings are kept, blocking ones too', async () => {
    const { replies, tool, calls, card } = setUp();
    await tool({ verdict: 'approve', summary: 'Mostly fine.', findings: [{ brief: 'Off by one.', priority: 'high', blocking: true, refs: [{ path: 'a.ts', line: 3 }] }, { brief: 'Typo.', priority: 'low', blocking: false }] });
    // The card proposed asking for changes; the user approves all the same.
    expect(card()?.review?.verdict).toBe('request_changes');
    const posted = await replies.post('s1', card()!.id!, { verdict: 'approve', withoutComment: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('event=APPROVE');
    expect(calls[0]!.some((arg) => arg.startsWith('body=') || arg.startsWith('comments[]'))).toBe(false);
    // The card keeps what was found.
    expect(posted).toMatchObject({ summary: 'Mostly fine.', posted: { verdict: 'approve', withoutComment: true } });
    expect(posted.findings).toHaveLength(2);
  });

  it('an approval with its summary takes its kept findings with it', async () => {
    const { replies, tool, calls, card } = setUp();
    await tool({ verdict: 'approve', summary: 'Fine.', findings: [{ brief: 'Off by one.', priority: 'high', blocking: true, refs: [{ path: 'a.ts', line: 3 }] }] });
    await replies.post('s1', card()!.id!, { verdict: 'approve' });
    expect(calls[0]).toContain('event=APPROVE');
    expect(calls[0]).toContain('body=Fine.\n\n1 finding is a comment on the code.');
    expect(calls[0]).toContain('comments[][path]=a.ts');
  });

  it('posts an approval without the draft summary and records exactly what was posted', async () => {
    const { replies, tool, calls, card } = setUp();
    await tool({ verdict: 'approve', summary: 'A long explanation of why everything is fine.' });
    const posted = await replies.post('s1', card()!.id!, { verdict: 'approve', summary: '' });
    expect(posted.summary).toBe('');
    expect(posted.posted?.verdict).toBe('approve');
    expect(calls[0]!.some((arg) => arg.startsWith('body='))).toBe(false);
  });

  it('refuses empty summaries for other verdicts and approvals retaining findings', async () => {
    const { replies, tool, calls, card } = setUp();
    await tool({ verdict: 'approve', summary: 'Fine.', findings: [{ brief: 'A typo.', blocking: false, priority: 'low' }] });
    await expect(replies.post('s1', card()!.id!, { summary: '' })).rejects.toThrow(/summary is empty/);
    await expect(replies.post('s1', card()!.id!, { verdict: 'comment', summary: '' })).rejects.toThrow(/summary is empty/);
    expect(calls).toEqual([]);
    const findings = card()!.review!.findings.map((f) => ({ ...f, dismissed: true }));
    expect((await replies.post('s1', card()!.id!, { summary: '', findings })).summary).toBe('');
  });

  it('still rejects a silent approval when new commits arrive', async () => {
    const { replies, tool, calls, card } = setUp({ request: ready({ number: 12, state: 'open', headSha: OTHER } as PullRequest) });
    await tool({ verdict: 'approve', summary: 'The implementation is sound.' });
    await expect(replies.post('s1', card()!.id!, { summary: '' })).rejects.toThrow(/new commits since/);
    expect(calls).toEqual([]);
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

  it('on its own, a clean approval goes up alone, and a review with findings goes up whole', async () => {
    const clean = setUp({ settings: { mode: 'reply', projects: 'all' } });
    await clean.tool({ verdict: 'approve', summary: 'Why it is fine.' });
    expect(clean.calls[0]).toContain('event=APPROVE');
    expect(clean.calls[0]!.some((arg) => arg.startsWith('body='))).toBe(false);
    expect(clean.card()?.review).toMatchObject({ summary: 'Why it is fine.', posted: { withoutComment: true, onItsOwn: true } });
    const noted = setUp({ settings: { mode: 'reply', projects: 'all' } });
    await noted.tool({ verdict: 'approve', summary: 'Fine, with a note.', findings: [{ brief: 'A typo.', priority: 'low', blocking: false }] });
    expect(noted.calls[0]!.some((arg) => arg.startsWith('body=Fine, with a note.'))).toBe(true);
    expect(noted.card()?.review?.posted?.withoutComment).toBeUndefined();
  });

  it('leaves the card for the user when posting on its own is refused', async () => {
    const { tool, notices, card } = setUp({ settings: { mode: 'reply', projects: 'all' }, request: ready({ number: 12, state: 'open', headSha: OTHER } as PullRequest) });
    const result = await tool({ verdict: 'approve', summary: 'Good.' });
    expect(result.text).toContain('not posted');
    expect(card()?.review?.posted).toBeUndefined();
    expect(notices[0]).toContain('not posted on its own');
  });
});

describe('findings on the lines of the code', () => {
  // A request that adds lines 3 to 5 of a.ts, with a line of context either side.
  const anchors = anchorsFromDiff(['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -2,2 +2,5 @@', ' keep();', '+one();', '+two();', '+three();', ' end();'].join('\n'));
  const session = (host: 'github' | 'gitlab'): Session => ({ id: 's1', title: 'Review', agent: 'claude', startedIn: 'p', worktreePath: '/w', review: { key: 'k', host, number: 12, sha: SHA, url: 'u' } }) as unknown as Session;
  const FINDINGS = [
    { brief: 'On a changed line.', priority: 'medium', blocking: false, refs: [{ path: 'a.ts', line: 4 }] },
    { brief: 'On a range.', priority: 'high', blocking: true, refs: [{ path: 'a.ts', line: 3, end: 5 }] },
    { brief: 'Outside the change.', priority: 'low', blocking: false, refs: [{ path: 'a.ts', line: 40 }] },
    { brief: 'Not in the request.', priority: 'low', blocking: false, refs: [{ path: 'README.md', line: 1 }] },
    { brief: 'No line at all.', priority: 'low', blocking: false },
  ];
  const setUp = (host: 'github' | 'gitlab', answer?: (args: readonly string[]) => string, refuse?: (args: readonly string[]) => boolean) => {
    let messages: ChatMessage[] = [];
    const calls: string[][] = [];
    const replies = new ReviewReplies({
      session: async () => session(host),
      messages: () => messages,
      showCard: (_id, card) => void (messages = [...messages.filter((m) => m.id !== card.id), { id: card.id, author: 'agent', time: '', text: '', review: card.review } as ChatMessage]),
      notice: () => undefined,
      settings: async () => ({ mode: 'list', projects: 'all' }),
      byNumber: () => ({ pullRequestByNumber: async () => ready({ number: 12, state: 'open', headSha: SHA } as PullRequest) }),
      run: async (_bin, args) => {
        calls.push([...args]);
        if (refuse?.(args)) throw Object.assign(new Error('failed'), { stderr: 'HTTP 400' });
        return { stdout: answer?.(args) ?? '' };
      },
      now: () => 1000,
      diffAnchors: async (_path, sha) => (sha === SHA ? anchors : undefined),
    });
    const post = async () => {
      await replies.hostFor('s1').postReview({ verdict: 'request_changes', summary: 'Two problems.', findings: FINDINGS });
      const id = messages[0]!.id!;
      return { card: messages[0]!.review!, posted: await replies.post('s1', id), calls };
    };
    return { post, calls };
  };

  it('keeps the diff it read from the reviewed commit on the card, so the card can say where each finding goes', async () => {
    const { card } = await setUp('github').post();
    expect(card.anchors).toEqual(anchors);
  });

  it('GitHub: one review with each finding that has a line in the diff on it, a range as a range, and the rest under the summary', async () => {
    const { calls } = await setUp('github').post();
    expect(calls).toHaveLength(1);
    const args = calls[0]!;
    expect(args).toContain(`commit_id=${SHA}`);
    expect(args.filter((a) => a === 'comments[][path]=a.ts')).toHaveLength(2);
    expect(args).toContain('comments[][start_line]=3');
    expect(args).toContain('comments[][line]=5');
    expect(args).toContain('comments[][line]=4');
    const body = args.find((a) => a.startsWith('body='))!;
    expect(body).toContain('Two problems.\n\n2 findings are comments on the code.');
    expect(body).toContain('**Low priority.** Outside the change.\n\nAt: `a.ts:40`');
    expect(body).toContain('**Low priority.** Not in the request.\n\nAt: `README.md:1`');
    expect(body).toContain('**Low priority.** No line at all.');
    expect(body).not.toContain('On a changed line.');
    expect(args.find((a) => a.startsWith('comments[][body]=') && a.includes('On a range.'))).toContain('**High priority · Blocks.**');
  });

  it('GitLab: a draft on each line, anchored to the reviewed commit, then the summary, published together', async () => {
    const refs = JSON.stringify({ diff_refs: { base_sha: 'base', start_sha: 'start', head_sha: SHA } });
    let n = 0;
    const { calls, posted } = await setUp('gitlab', (args) => (args[1] === 'projects/:id/merge_requests/12' ? refs : JSON.stringify({ id: ++n }))).post();
    const drafts = calls.filter((c) => c.includes('position[position_type]=text'));
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toContain(`position[head_sha]=${SHA}`);
    expect(drafts[0]).toContain('position[base_sha]=base');
    expect(drafts.find((c) => c.some((a) => a.includes('On a changed line.')))).toContain('position[new_line]=4');
    const summary = calls.find((c) => c.some((a) => a.startsWith('note=**Changes requested.**')))!;
    expect(summary.find((a) => a.startsWith('note='))).toContain('2 findings are comments on the code.');
    expect(calls.at(-1)).toEqual(['api', '-X', 'POST', 'projects/:id/merge_requests/12/draft_notes/bulk_publish']);
    expect(calls.some((c) => c[0] === 'mr' && c[1] === 'note')).toBe(false);
    expect(posted.posted?.moved).toBeUndefined();
  });

  it('GitLab: a line it refuses goes under the summary and the card says so; the rest still go on the code', async () => {
    const refs = JSON.stringify({ diff_refs: { base_sha: 'base', start_sha: 'start', head_sha: SHA } });
    const { calls, posted } = await setUp('gitlab', (args) => (args[1] === 'projects/:id/merge_requests/12' ? refs : '{"id":1}'), (args) => args.some((a) => a.includes('On a range.')) && args.includes('position[position_type]=text')).post();
    const summary = calls.find((c) => c.some((a) => a.startsWith('note=**Changes requested.**')))!.find((a) => a.startsWith('note='))!;
    expect(summary).toContain('1 finding is a comment on the code.');
    expect(summary).toContain('**a.ts:3–5**');
    expect(Object.values(posted.posted?.moved ?? {})).toEqual(['GitLab would not take a comment on its line']);
    expect(posted.posted?.note).toContain('written under the summary');
  });

  it('GitLab: when the merge request has moved on, every finding goes under the summary as one note', async () => {
    const refs = JSON.stringify({ diff_refs: { base_sha: 'base', start_sha: 'start', head_sha: OTHER } });
    const { calls, posted } = await setUp('gitlab', (args) => (args[1] === 'projects/:id/merge_requests/12' ? refs : '')).post();
    expect(calls.some((c) => c.includes('position[position_type]=text'))).toBe(false);
    expect(calls.at(-1)!.slice(0, 2)).toEqual(['mr', 'note']);
    expect(Object.keys(posted.posted?.moved ?? {})).toHaveLength(2);
  });

  it('GitLab: takes its drafts back and posts nothing when the publish fails', async () => {
    const refs = JSON.stringify({ diff_refs: { base_sha: 'base', start_sha: 'start', head_sha: SHA } });
    let n = 0;
    const { post, calls } = setUp('gitlab', (args) => (args[1] === 'projects/:id/merge_requests/12' ? refs : JSON.stringify({ id: ++n })), (args) => args.at(-1)!.endsWith('bulk_publish'));
    await expect(post()).rejects.toThrow('GitLab did not take the review');
    expect(calls.filter((c) => c[2] === 'DELETE').map((c) => c.at(-1))).toEqual(['projects/:id/merge_requests/12/draft_notes/1', 'projects/:id/merge_requests/12/draft_notes/2']);
  });
});
