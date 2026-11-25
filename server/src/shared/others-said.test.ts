// What other reviewers said (others-said.ts): the one rule and its words, and a pushed value checked.
import { describe, expect, it } from 'vitest';
import { asOthersReviews, isSatisfied, othersOnly, othersSaid, type OthersReviews } from './others-said.ts';

const said = (others: Partial<OthersReviews>) => othersSaid({ others: { approvedBy: [], changesRequestedBy: [], satisfied: false, ...others } });

describe('what others said', () => {
  it('says nothing when the host was not asked or nobody said anything', () => {
    expect(othersSaid({})).toEqual({ kind: 'none', tick: false, text: '' });
    expect(said({})).toEqual({ kind: 'none', tick: false, text: '' });
  });

  it('names one approval, counts several, with the tick', () => {
    expect(said({ approvedBy: ['dana'] })).toEqual({ kind: 'approved', tick: true, text: 'dana approved' });
    expect(said({ approvedBy: ['dana', 'lee'] })).toEqual({ kind: 'approved', tick: true, text: '2 approved' });
  });

  it('says Approved once the host is satisfied, whoever approved', () => {
    expect(said({ approvedBy: ['dana'], satisfied: true })).toEqual({ kind: 'satisfied', tick: true, text: 'Approved' });
    expect(said({ satisfied: true })).toEqual({ kind: 'satisfied', tick: true, text: 'Approved' });
  });

  it('puts a request for changes first, without the tick, over approvals and over satisfied', () => {
    expect(said({ changesRequestedBy: ['dana'] })).toEqual({ kind: 'changes', tick: false, text: 'dana requested changes' });
    expect(said({ approvedBy: ['lee', 'kim'], changesRequestedBy: ['dana'], satisfied: true })).toEqual({ kind: 'changes', tick: false, text: 'dana requested changes' });
    expect(said({ changesRequestedBy: ['dana', 'lee'] }).text).toBe('Changes requested by 2');
  });

  it('is satisfied only on the host’s word', () => {
    expect(isSatisfied({})).toBe(false);
    expect(isSatisfied({ others: { approvedBy: ['dana', 'lee'], changesRequestedBy: [], satisfied: false } })).toBe(false);
    expect(isSatisfied({ others: { approvedBy: [], changesRequestedBy: [], satisfied: true } })).toBe(true);
  });

  it('leaves out the user’s own review, and names each reviewer once', () => {
    expect(othersOnly(['Matt', 'dana', 'DANA', '', 'lee'], 'matt')).toEqual(['dana', 'lee']);
    expect(othersOnly(['dana'], '')).toEqual(['dana']);
  });

  it('reads a pushed value, and drops one that is not one', () => {
    expect(asOthersReviews({ approvedBy: ['dana'], changesRequestedBy: [], satisfied: true })).toEqual({ approvedBy: ['dana'], changesRequestedBy: [], satisfied: true });
    expect(asOthersReviews({ approvedBy: 'dana', changesRequestedBy: [], satisfied: true })).toBeUndefined();
    expect(asOthersReviews({ approvedBy: [], changesRequestedBy: [] })).toBeUndefined();
    expect(asOthersReviews(null)).toBeUndefined();
  });
});
