import { describe, expect, it } from 'vitest';
import { finishedProposal, MAX_SUMMARY, pullRequestProposals } from './moments.ts';

describe('the moments a ticket change is proposed', () => {
  it('proposes a comment and In review for an open or draft request, nothing for a closed one', () => {
    expect(pullRequestProposals({ url: 'u', state: 'open' }).map((p) => [p.change, p.once])).toEqual([['comment', 'pr:u'], ['in-review', 'pr:u']]);
    expect(pullRequestProposals({ url: 'u', state: 'draft' })).toHaveLength(2);
    expect(pullRequestProposals({ url: 'u', state: 'merged' })).toEqual([]);
    expect(pullRequestProposals({ url: 'u' })).toEqual([]);
  });

  it('finds the lead finished only at a pull request with nothing under it working, and cuts a long report', () => {
    const done = [{ id: 'a', state: 'done' as const }];
    expect(finishedProposal({ sessions: done, requests: 0, report: 'x' })).toBeNull();
    expect(finishedProposal({ sessions: [...done, { id: 'b', state: 'running' }], requests: 1, report: 'x' })).toBeNull();
    expect(finishedProposal({ sessions: [...done, { id: 'b', state: 'attention' }], requests: 1, report: 'x' })).toBeNull();
    expect(finishedProposal({ sessions: done, requests: 1, report: '  ' })).toBeNull();
    expect(finishedProposal({ sessions: done, requests: 1, report: 'Shipped.' })).toMatchObject({ change: 'comment', body: 'Shipped.', once: 'finished' });
    expect(finishedProposal({ sessions: done, requests: 1, report: 'y'.repeat(5000) })!.body!.length).toBe(MAX_SUMMARY);
  });
});
