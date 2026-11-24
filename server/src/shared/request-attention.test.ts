// "This session's pull request needs the user" (shared/request-attention.ts): what each host tells the
// PR store about failed checks, conflicts and requested changes; the one fact made from it, with each
// reason, several at once and each one turned off; the idle rule, the guest and its host, the
// Overview's section, the words and the messages; and the notification, once per occurrence, with its
// switch.
import { describe, expect, it } from 'vitest';
import type { PullRequest, PullRequestLookup } from './details.ts';
import { changesRequestedOf, mapGhItem, githubProvider, reviewCommentsArgs, reviewsArgs } from '../pull-requests/github.ts';
import { failedJobsOf, gitlabProvider } from '../pull-requests/gitlab.ts';
import { PullRequestStore } from '../pull-requests/store.ts';
import type { CommandRunner } from '../pull-requests/types.ts';
import { DEFAULT_NOTIFY, NOTHING_SEEN, notificationsOf, type NotifyNow } from './notifications.ts';
import { overviewSection } from './overview.ts';
import {
  attentionBySession,
  attentionLabel,
  attentionLine,
  carryConflictsSince,
  DEFAULT_ATTENTION_PREFS,
  fixMessage,
  isIdle,
  requestAttention,
  sanitizeAttentionPrefs,
  sessionAttention,
  settledLine,
  type AttentionPrefs,
  type AttentionReason,
  type AttentionSession,
  type RequestAttention,
} from './request-attention.ts';
import { ready, unavailable, type Sourced } from './sourced.ts';
import { requestIcon } from './row-slot.ts';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHA2 = 'b'.repeat(40);
const CHANGES = { id: 'PRR_1', reviewers: ['sam'], url: 'https://github.com/o/r/pull/431#pullrequestreview-9', body: 'Not yet.', comments: [{ body: 'Rename this.', path: 'src/a.ts', line: 3, url: 'https://github.com/o/r/pull/431#discussion_r1' }] };
const pr = (fields: Partial<PullRequest> = {}): PullRequest => ({ number: 431, title: 'Polish the sign-in form', state: 'open', checks: 'failing', review: 'none', url: 'https://github.com/o/r/pull/431', headSha: SHA, baseBranch: 'main', failedChecks: [{ name: 'lint', url: 'https://github.com/o/r/actions/runs/1/job/2' }, { name: 'test' }], ...fields });
/** Checks passing, so only the given reason holds. */
const conflicted = (fields: Partial<PullRequest> = {}) => pr({ checks: 'passing', failedChecks: undefined, readiness: 'conflicts', ...fields });
const asked = (fields: Partial<PullRequest> = {}) => pr({ checks: 'passing', failedChecks: undefined, review: 'changes-requested', changesRequested: CHANGES, ...fields });
const lookup = (prs: PullRequest[], host: 'github' | 'gitlab' = 'github'): Sourced<PullRequestLookup> => ready({ host, pullRequests: prs });
const idle = (id = 's1', fields: Partial<AttentionSession> = {}): AttentionSession & { title: string } => ({ id, title: `Session ${id}`, state: 'done', note: '', ...fields });
const off = (reason: AttentionReason, card = false): AttentionPrefs => ({ ...DEFAULT_ATTENTION_PREFS, [reason]: card ? { watch: true, card: 'never' } : { watch: false, card: 'ask' } });
const reasonsOf = (a: RequestAttention | null) => a?.reasons.map((d) => d.reason) ?? [];

const listed = <T extends object>(s: T) => ({ ...s, updatedAt: 0, lastActivityAt: 0 });

function runner(answers: Record<string, string>) {
  const calls: string[] = [];
  const run: CommandRunner = async (bin, args) => {
    const line = [bin, ...args].join(' ');
    calls.push(line);
    if (answers[line] === undefined) throw new Error(`unexpected command: ${line}`);
    return { stdout: answers[line]! };
  };
  return { run, calls };
}

describe('what GitHub tells the store', () => {
  it('names each failed check with its log, from the rollup gh already returns', () => {
    const item = { number: 7, title: 'x', state: 'OPEN', isDraft: false, url: 'https://github.com/o/r/pull/7', headRefOid: SHA, statusCheckRollup: [
      { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/1/job/2' },
      { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/actions/runs/1/job/3' },
      { __typename: 'StatusContext', context: 'ci/deploy-preview', state: 'ERROR', targetUrl: 'https://ci.example.com/9' },
    ] };
    expect(mapGhItem(item)).toMatchObject({ checks: 'failing', headSha: SHA, failedChecks: [{ name: 'lint', url: 'https://github.com/o/r/actions/runs/1/job/2' }, { name: 'ci/deploy-preview', url: 'https://ci.example.com/9' }] });
  });

  it('names none for passing checks or a request that is no longer open', () => {
    expect(mapGhItem({ number: 7, state: 'OPEN', url: 'https://github.com/o/r/pull/7', statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }] }).failedChecks).toBeUndefined();
    expect(mapGhItem({ number: 7, state: 'MERGED', url: 'https://github.com/o/r/pull/7', statusCheckRollup: [{ conclusion: 'FAILURE', name: 'lint' }] }).failedChecks).toBeUndefined();
  });

  it('says it conflicts, from the same list', () => {
    expect(mapGhItem({ number: 7, state: 'OPEN', url: 'https://github.com/o/r/pull/7', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }).readiness).toBe('conflicts');
  });

  it('names who asked for changes from latestReviews, the newest review of each', () => {
    const reviews = [
      { id: 'PRR_a', author: { login: 'sam' }, state: 'CHANGES_REQUESTED', body: 'Please split this.' },
      { id: 'PRR_b', author: { login: 'kim' }, state: 'APPROVED', body: 'Fine by me.' },
      { id: 'PRR_c', author: { login: 'lee' }, state: 'CHANGES_REQUESTED', body: '' },
    ];
    expect(changesRequestedOf(reviews)).toEqual({ id: 'PRR_a,PRR_c', reviewers: ['sam', 'lee'], body: 'sam: Please split this.', comments: [] });
    expect(changesRequestedOf([reviews[1]])).toBeNull();
    const item = mapGhItem({ number: 7, state: 'OPEN', url: 'https://github.com/o/r/pull/7', reviewDecision: 'CHANGES_REQUESTED', latestReviews: [reviews[0]] });
    expect(item).toMatchObject({ review: 'changes-requested', changesRequested: { id: 'PRR_a', reviewers: ['sam'], body: 'Please split this.' } });
    expect(mapGhItem({ number: 7, state: 'MERGED', url: 'https://github.com/o/r/pull/7', reviewDecision: 'CHANGES_REQUESTED', latestReviews: [reviews[0]] }).changesRequested).toBeUndefined();
  });

  it('asks once per set of reviews for each one’s link and the comments left with it', async () => {
    const LIST = 'gh pr list --head=feat/x --state all --json number,title,state,isDraft,url,reviewDecision,statusCheckRollup,body,author,headRefName,baseRefName,mergeStateStatus,mergeable,headRefOid,latestReviews';
    const item = { number: 7, title: 'x', state: 'OPEN', url: 'https://github.com/o/r/pull/7', reviewDecision: 'CHANGES_REQUESTED', latestReviews: [{ id: 'PRR_a', author: { login: 'sam' }, state: 'CHANGES_REQUESTED', body: 'Split it.' }] };
    const { run, calls } = runner({
      [LIST]: JSON.stringify([item]),
      [['gh', ...reviewsArgs(7)].join(' ')]: JSON.stringify([{ id: 11, node_id: 'PRR_a', state: 'CHANGES_REQUESTED', html_url: 'https://github.com/o/r/pull/7#pullrequestreview-11' }, { id: 12, node_id: 'PRR_old' }]),
      [['gh', ...reviewCommentsArgs(7)].join(' ')]: JSON.stringify([
        { pull_request_review_id: 11, path: 'src/a.ts', line: 4, body: 'Rename this.', html_url: 'https://github.com/o/r/pull/7#discussion_r1' },
        { pull_request_review_id: 12, path: 'src/b.ts', line: 9, body: 'An older review’s comment.' },
      ]),
    });
    const provider = githubProvider(run);
    const found = await provider.pullRequestsFor('/repo', 'feat/x');
    expect(found).toMatchObject({ state: 'ready', value: [{ changesRequested: { reviewers: ['sam'], url: 'https://github.com/o/r/pull/7#pullrequestreview-11', comments: [{ body: 'Rename this.', path: 'src/a.ts', line: 4, url: 'https://github.com/o/r/pull/7#discussion_r1' }] } }] });
    await provider.pullRequestsFor('/repo', 'feat/x');
    expect(calls.filter((c) => c.startsWith('gh api'))).toHaveLength(2); // the same reviews are not asked about again
  });

  it('keeps who asked and what they wrote when the details cannot be read', async () => {
    const LIST = 'gh pr list --head=feat/x --state all --json number,title,state,isDraft,url,reviewDecision,statusCheckRollup,body,author,headRefName,baseRefName,mergeStateStatus,mergeable,headRefOid,latestReviews';
    const item = { number: 7, title: 'x', state: 'OPEN', url: 'https://github.com/o/r/pull/7', reviewDecision: 'CHANGES_REQUESTED', latestReviews: [{ id: 'PRR_a', author: { login: 'sam' }, state: 'CHANGES_REQUESTED', body: 'Split it.' }] };
    const { run } = runner({ [LIST]: JSON.stringify([item]) });
    expect(await githubProvider(run).pullRequestsFor('/repo', 'feat/x')).toMatchObject({ state: 'ready', value: [{ changesRequested: { reviewers: ['sam'], body: 'Split it.', comments: [] } }] });
  });
});

describe('what GitLab tells the store', () => {
  const LIST = 'glab mr list --source-branch=feat/x --all --output json';
  const VIEW = 'glab mr view 12 --output json';
  const JOBS = 'glab api projects/:id/pipelines/77/jobs?scope[]=failed&per_page=100';
  const BRIDGES = 'glab api projects/:id/pipelines/77/bridges?scope[]=failed&per_page=100';
  const REVIEWERS = 'glab api projects/:id/merge_requests/12/reviewers';
  const DISCUSSIONS = 'glab api projects/:id/merge_requests/12/discussions?per_page=100';
  const MR_URL = 'https://gl.example.com/g/r/-/merge_requests/12';
  const mr = { iid: 12, title: 'Change', state: 'opened', draft: false, web_url: MR_URL, sha: SHA, source_branch: 'feat/x', target_branch: 'main', updated_at: '2026-11-24T10:00:00Z' };
  const view = (pipeline: Record<string, unknown>, fields: Record<string, unknown> = {}) => JSON.stringify({ ...mr, head_pipeline: { id: 77, web_url: 'https://gl.example.com/g/r/-/pipelines/77', updated_at: '2026-11-24T10:00:00Z', ...pipeline }, ...fields });
  const nobody = { [REVIEWERS]: '[]' };

  it('asks for a failed pipeline’s failed jobs once, leaving out those allowed to fail', async () => {
    const { run, calls } = runner({ [LIST]: JSON.stringify([mr]), [VIEW]: view({ status: 'failed' }), ...nobody, [JOBS]: JSON.stringify([{ name: 'rspec 1/2', web_url: 'https://gl.example.com/g/r/-/jobs/901' }, { name: 'danger', allow_failure: true, web_url: 'https://gl.example.com/g/r/-/jobs/902' }]) });
    const provider = gitlabProvider(run);
    const first = await provider.pullRequestsFor('/repo', 'feat/x');
    expect(first).toMatchObject({ state: 'ready', value: [{ checks: 'failing', headSha: SHA, failedChecks: [{ name: 'rspec 1/2', url: 'https://gl.example.com/g/r/-/jobs/901' }] }] });
    await provider.pullRequestsFor('/repo', 'feat/x');
    expect(calls.filter((c) => c === JOBS)).toHaveLength(1); // the same pipeline is not asked about again
  });

  it('falls back to failed trigger jobs for a child pipeline, and asks for no jobs for a passing one', async () => {
    const child = runner({ [LIST]: JSON.stringify([mr]), [VIEW]: view({ status: 'failed' }), ...nobody, [JOBS]: '[]', [BRIDGES]: JSON.stringify([{ name: 'deploy:child', downstream_pipeline: { web_url: 'https://gl.example.com/g/r/-/pipelines/78' } }]) });
    expect(await gitlabProvider(child.run).pullRequestsFor('/repo', 'feat/x')).toMatchObject({ value: [{ failedChecks: [{ name: 'deploy:child', url: 'https://gl.example.com/g/r/-/pipelines/78' }] }] });
    const passing = runner({ [LIST]: JSON.stringify([mr]), [VIEW]: view({ status: 'success' }), ...nobody });
    expect(await gitlabProvider(passing.run).pullRequestsFor('/repo', 'feat/x')).toMatchObject({ value: [{ checks: 'passing' }] });
    expect(passing.calls.some((c) => c.includes('/pipelines/'))).toBe(false);
  });

  it('keeps the request when the jobs cannot be read: no names, the pipeline’s link', async () => {
    const { run } = runner({ [LIST]: JSON.stringify([mr]), [VIEW]: view({ status: 'failed' }), ...nobody });
    const found = await gitlabProvider(run).pullRequestsFor('/repo', 'feat/x');
    expect(found).toMatchObject({ state: 'ready', value: [{ checks: 'failing', checksUrl: 'https://gl.example.com/g/r/-/pipelines/77' }] });
    expect(found.state === 'ready' && found.value[0]!.failedChecks).toBeUndefined();
    expect(() => failedJobsOf('{}')).toThrow();
  });

  it('says it conflicts, from the view', async () => {
    const { run } = runner({ [LIST]: JSON.stringify([mr]), [VIEW]: view({ status: 'success' }, { has_conflicts: true, detailed_merge_status: 'conflict' }), ...nobody });
    expect(await gitlabProvider(run).pullRequestsFor('/repo', 'feat/x')).toMatchObject({ value: [{ readiness: 'conflicts', baseBranch: 'main' }] });
  });

  it('asks the reviewers, so a request for changes hidden behind a conflict is still seen, with what they said', async () => {
    const discussions = [
      { notes: [{ id: 501, body: 'Rename this.', author: { username: 'sam' }, resolvable: true, resolved: false, position: { new_path: 'src/a.rb', new_line: 7 } }] },
      { notes: [{ id: 502, body: 'Done already.', author: { username: 'sam' }, resolvable: true, resolved: true }] },
      { notes: [{ id: 503, body: 'added 1 commit', author: { username: 'sam' }, system: true }] },
      { notes: [{ id: 504, body: 'Looks fine to me.', author: { username: 'kim' } }] },
    ];
    const { run, calls } = runner({
      [LIST]: JSON.stringify([mr]),
      [VIEW]: view({ status: 'success' }, { has_conflicts: true, detailed_merge_status: 'conflict' }),
      [REVIEWERS]: JSON.stringify([{ user: { username: 'sam' }, state: 'requested_changes' }, { user: { username: 'kim' }, state: 'approved' }]),
      [DISCUSSIONS]: JSON.stringify(discussions),
    });
    const provider = gitlabProvider(run);
    expect(await provider.pullRequestsFor('/repo', 'feat/x')).toMatchObject({ value: [{ readiness: 'conflicts', review: 'changes-requested', changesRequested: { id: 'sam@501', reviewers: ['sam'], url: `${MR_URL}#note_501`, comments: [{ body: 'Rename this.', path: 'src/a.rb', line: 7, url: `${MR_URL}#note_501` }] } }] });
    await provider.pullRequestsFor('/repo', 'feat/x');
    expect(calls.filter((c) => c === REVIEWERS || c === DISCUSSIONS)).toHaveLength(2); // asked again only when the merge request changes
  });

  it('asks for no discussions when nobody asked for changes', async () => {
    const { run, calls } = runner({ [LIST]: JSON.stringify([mr]), [VIEW]: view({ status: 'success' }), [REVIEWERS]: JSON.stringify([{ user: { username: 'kim' }, state: 'unreviewed' }]) });
    expect(await gitlabProvider(run).pullRequestsFor('/repo', 'feat/x')).toMatchObject({ value: [{ review: 'none' }] });
    expect(calls).not.toContain(DISCUSSIONS);
  });
});

describe('the fact', () => {
  it('failed checks: an open or draft request whose checks failed, never a merged or closed one, nor passing or running', () => {
    expect(requestAttention(lookup([pr()]))).toMatchObject({ number: 431, commit: SHA, reasons: [{ reason: 'checks-failed', occurrence: SHA, checks: [{ name: 'lint' }, { name: 'test' }] }] });
    expect(requestAttention(lookup([pr({ state: 'draft' })]))).not.toBeNull();
    for (const fields of [{ state: 'merged' as const }, { state: 'closed' as const }, { checks: 'passing' as const }, { checks: 'running' as const }]) expect(requestAttention(lookup([pr(fields)]))).toBeNull();
    expect(requestAttention(unavailable('gh is not signed in'))).toBeNull();
    expect(requestAttention(undefined)).toBeNull();
  });

  it('merge conflicts: with the target branch named, never for a merged or closed request', () => {
    expect(requestAttention(lookup([conflicted()]))).toMatchObject({ reasons: [{ reason: 'conflicts', occurrence: SHA, base: 'main' }] });
    expect(requestAttention(lookup([conflicted({ state: 'closed' })]))).toBeNull();
    expect(requestAttention(lookup([conflicted({ readiness: 'behind' })]))).toBeNull();
  });

  it('requested changes: who asked, the review’s link and its comments; its occurrence is the review', () => {
    expect(requestAttention(lookup([asked()]))).toMatchObject({ reasons: [{ reason: 'changes-requested', occurrence: 'PRR_1', reviewers: ['sam'], reviewUrl: CHANGES.url, body: 'Not yet.', comments: CHANGES.comments }] });
    // The host said changes were requested but not by whom: still the reason, on that commit.
    expect(requestAttention(lookup([asked({ changesRequested: undefined })]))).toMatchObject({ reasons: [{ reason: 'changes-requested', occurrence: SHA, reviewers: [], comments: [] }] });
    expect(requestAttention(lookup([asked({ review: 'approved' })]))).toBeNull();
  });

  it('several reasons at once are one fact, in one order', () => {
    const all = requestAttention(lookup([pr({ readiness: 'conflicts', review: 'changes-requested', changesRequested: CHANGES })]));
    expect(reasonsOf(all)).toEqual(['checks-failed', 'conflicts', 'changes-requested']);
  });

  it('a reason turned off in Settings → Git is not looked at; its card being off changes nothing here', () => {
    const both = lookup([pr({ readiness: 'conflicts' })]);
    expect(reasonsOf(requestAttention(both, off('checks-failed')))).toEqual(['conflicts']);
    expect(reasonsOf(requestAttention(both, off('conflicts')))).toEqual(['checks-failed']);
    expect(requestAttention(lookup([asked()]), off('changes-requested'))).toBeNull();
    expect(reasonsOf(requestAttention(both, off('conflicts', true)))).toEqual(['checks-failed', 'conflicts']);
    expect(requestIcon(lookup([conflicted()]), off('conflicts'))?.alert).toBeUndefined();
  });

  it('reads stored choices forgivingly: anything unreadable is that part’s default', () => {
    expect(sanitizeAttentionPrefs(null)).toEqual(DEFAULT_ATTENTION_PREFS);
    expect(sanitizeAttentionPrefs({ conflicts: { watch: false, card: 'always' }, 'checks-failed': 'yes' })).toEqual({ ...DEFAULT_ATTENTION_PREFS, conflicts: { watch: false, card: 'ask' } });
  });

  it('holds while the session works or waits on an answer mid-turn; a finished, failed or interrupted one is idle', () => {
    expect(isIdle({ state: 'running', note: '' })).toBe(false);
    expect(isIdle({ state: 'attention', note: 'Needs you · Approve a command' })).toBe(false);
    expect(isIdle({ state: 'attention', note: 'Failed · the agent stopped' })).toBe(true);
    expect(isIdle({ state: 'done', note: '' })).toBe(true);
    expect(isIdle({ state: 'interrupted', note: '' })).toBe(true);
    expect(sessionAttention(idle('s1', { state: 'running' }), lookup([pr()]))).toBeNull();
    expect(sessionAttention(idle(), lookup([pr()]))).not.toBeNull();
  });

  it('belongs to the worktree’s owner: the host has it, the guest never (its row still shows the mark)', () => {
    const host = idle('host');
    const guest = idle('guest', { hostId: 'host' });
    const facts = attentionBySession([host, guest], (id) => (id === 'host' ? lookup([pr()]) : undefined));
    expect([...facts.keys()]).toEqual(['host']);
    expect(sessionAttention(guest, lookup([pr()]))).toBeNull();
    expect(requestIcon(lookup([pr()]))).toMatchObject({ tone: 'red', alert: true, label: 'Pull request #431 · Checks failed (lint, test)' });
    expect(requestIcon(lookup([pr({ readiness: 'conflicts' })]))).toMatchObject({ label: 'Pull request #431 · Checks failed (lint, test) · Merge conflicts with main' });
  });

  it('lists the session under Needs you on the Overview, unless it is working', () => {
    expect(overviewSection(listed(idle()), null, true)).toBe('needs-you');
    expect(overviewSection(listed(idle()), null, false)).not.toBe('needs-you');
    expect(overviewSection(listed(idle('s1', { state: 'running' })), null, true)).toBe('working');
  });

  it('one conflict lasts until it clears, however many commits are pushed meanwhile', () => {
    const first = carryConflictsSince(undefined, lookup([conflicted()]));
    expect(requestAttention(first)?.reasons[0]?.occurrence).toBe(SHA);
    const pushed = carryConflictsSince(first, lookup([conflicted({ headSha: SHA2 })]));
    expect(requestAttention(pushed)?.reasons[0]?.occurrence).toBe(SHA);
    const cleared = carryConflictsSince(pushed, lookup([pr({ checks: 'passing', failedChecks: undefined, headSha: SHA2 })]));
    const again = carryConflictsSince(cleared, lookup([conflicted({ headSha: SHA2 })]));
    expect(requestAttention(again)?.reasons[0]?.occurrence).toBe(SHA2);
    const answer = lookup([pr()]);
    expect(carryConflictsSince(first, answer)).toBe(answer);
  });

  it('the store keeps that commit across its own refreshes', async () => {
    const store = new PullRequestStore(() => 0);
    await store.get('s1', 'k', async () => lookup([conflicted()]));
    await store.get('s1', 'k', async () => lookup([conflicted({ headSha: SHA2 })]), true);
    expect(requestAttention(store.peek('s1'))?.reasons[0]?.occurrence).toBe(SHA);
  });
});

describe('the words', () => {
  const at = (host: 'github' | 'gitlab', number: number, reasons: RequestAttention['reasons']) => ({ host, number, reasons });

  it('one reason says it in its own line, by name, with GitLab’s own number', () => {
    expect(attentionLine(at('github', 431, [{ reason: 'checks-failed', occurrence: SHA, checks: [{ name: 'lint' }, { name: 'test' }] }]))).toBe('Checks failed on #431: lint, test');
    expect(attentionLine(at('gitlab', 12, [{ reason: 'checks-failed', occurrence: SHA, checks: [] }]))).toBe('Checks failed on !12');
    expect(attentionLine(at('github', 1, [{ reason: 'checks-failed', occurrence: SHA, checks: ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name })) }]))).toBe('Checks failed on #1: a, b, c and 2 more');
    expect(attentionLine(at('github', 431, [{ reason: 'conflicts', occurrence: SHA, base: 'main' }]))).toBe('Merge conflicts on #431 with main');
    expect(attentionLine(at('gitlab', 12, [{ reason: 'changes-requested', occurrence: 'x', reviewers: ['sam', 'kim'], comments: [] }]))).toBe('Changes requested on !12 by sam, kim');
  });

  it('several reasons are one line naming them all, not one each', () => {
    const all = requestAttention(lookup([pr({ readiness: 'conflicts', review: 'changes-requested', changesRequested: CHANGES })]))!;
    expect(attentionLine(all)).toBe('#431 needs you: checks failed (lint, test), merge conflicts with main, changes requested by sam');
    expect(attentionLabel(all)).toBe('Checks failed (lint, test) · Merge conflicts with main · Changes requested by sam');
  });

  it('tells the agent which checks failed and where their logs are', () => {
    const a = requestAttention(lookup([pr({ checksUrl: 'https://github.com/o/r/pull/431/checks' })]))!;
    const text = fixMessage(a, a.reasons[0]!);
    expect(text).toContain('#431');
    expect(text).toContain('a1b2c3d4');
    expect(text).toContain('- lint: https://github.com/o/r/actions/runs/1/job/2');
    expect(text).toContain('- test');
    expect(text).toContain('gh pr checks 431');
    expect(text).toMatch(/fix what made them fail/);
  });

  it('asks the agent to merge the target in here and resolve, never to force-push without asking', () => {
    const a = requestAttention(lookup([conflicted()]))!;
    const text = fixMessage(a, a.reasons[0]!);
    expect(text).toContain('merge conflicts with `main`');
    expect(text).toContain('merge the remote\'s `main` into this branch');
    expect(text).toMatch(/Do not force-push/);
  });

  it('gives the agent the review and its comments, and tells it to reply to nobody on the host', () => {
    const a = requestAttention(lookup([asked()]))!;
    const text = fixMessage(a, a.reasons[0]!);
    expect(text).toContain(`sam asked for changes on pull request #431`);
    expect(text).toContain(CHANGES.url);
    expect(text).toContain('> Not yet.');
    expect(text).toContain('- src/a.ts:3: Rename this. (https://github.com/o/r/pull/431#discussion_r1)');
    expect(text).toMatch(/Do not reply on the pull request or resolve its threads yourself/);
  });

  it('says why a card no longer applies, per reason', () => {
    const checks = { host: 'github' as const, number: 431, reason: 'checks-failed' as const, occurrence: SHA };
    expect(settledLine(checks, lookup([pr()]))).toBeNull();
    expect(settledLine(checks, lookup([pr({ checks: 'passing' })]))).toBe('Checks passed on #431');
    expect(settledLine(checks, lookup([pr({ checks: 'running' })]))).toBe('Checks are running again on #431');
    expect(settledLine(checks, lookup([pr({ state: 'merged' })]))).toBe('#431 was merged');
    expect(settledLine(checks, lookup([pr({ state: 'closed' })]))).toBe('#431 was closed');
    expect(settledLine(checks, lookup([pr({ headSha: SHA2 })]))).toBe('Checks failed again on a newer commit of #431');
    expect(settledLine(checks, lookup([pr()]), off('checks-failed'))).toBe('No longer watched: turned off in Settings → Git');
    expect(settledLine(checks, undefined)).toBeNull();
    const conflicts = { ...checks, reason: 'conflicts' as const };
    expect(settledLine(conflicts, lookup([conflicted()]))).toBeNull();
    expect(settledLine(conflicts, lookup([pr({ checks: 'passing' })]))).toBe('The conflicts on #431 are resolved');
    const changes = { ...checks, reason: 'changes-requested' as const, occurrence: 'PRR_1' };
    expect(settledLine(changes, lookup([asked()]))).toBeNull();
    expect(settledLine(changes, lookup([asked({ review: 'approved' })]))).toBe('Changes are no longer requested on #431');
    expect(settledLine(changes, lookup([asked({ changesRequested: { ...CHANGES, id: 'PRR_2' } })]))).toBe('A newer review asks for changes on #431');
  });
});

describe('the notification', () => {
  const AWAY: { focused: boolean; openSessionId: string | null } = { focused: false, openSessionId: null };
  const now = (sessions: ReturnType<typeof idle>[], prs: Record<string, Sourced<PullRequestLookup>>, attention?: AttentionPrefs): NotifyNow => ({
    sessions,
    links: [],
    pullRequests: new Map(Object.entries(prs)),
    ...(attention ? { attention } : {}),
    reviewRequests: { requests: [], unread: [] },
    tickets: { tickets: [], unread: [], sources: [], settings: { on: false, off: [], show: 'page' } },
  });
  /** Looks in order, each seeing the last; what was told at each. */
  function looks(steps: NotifyNow[], prefs = DEFAULT_NOTIFY, looking = AWAY) {
    let seen = NOTHING_SEEN;
    return steps.map((step) => {
      const next = notificationsOf(seen, step, prefs, looking);
      seen = next.seen;
      return next.events.filter((e) => e.kind === 'pull-request').map((e) => `${e.sessionId}: ${e.body}`);
    });
  }
  const running = lookup([pr({ checks: 'running', failedChecks: undefined })]);
  const clean = lookup([pr({ checks: 'passing', failedChecks: undefined })]);

  it('once per failing commit: not on the first look, not again on a re-run that fails again, nothing when they pass', () => {
    expect(looks([
      now([idle()], { s1: running }),
      now([idle()], { s1: lookup([pr()]) }),
      now([idle()], { s1: lookup([pr()]) }),
      now([idle()], { s1: running }),
      now([idle()], { s1: lookup([pr()]) }), // the same commit, run again, failed again
      now([idle()], { s1: clean }),
      now([idle()], { s1: lookup([pr({ headSha: SHA2 })]) }),
    ])).toEqual([[], ['s1: Checks failed on #431: lint, test'], [], [], [], [], ['s1: Checks failed on #431: lint, test']]);
  });

  it('once per time it becomes conflicted, as the store carries it', () => {
    let held: Sourced<PullRequestLookup> | undefined;
    const answer = (l: Sourced<PullRequestLookup>) => (held = carryConflictsSince(held, l));
    expect(looks([
      now([idle()], { s1: answer(clean) }),
      now([idle()], { s1: answer(lookup([conflicted()])) }),
      now([idle()], { s1: answer(lookup([conflicted({ headSha: SHA2 })])) }), // a push that leaves it conflicted
      now([idle()], { s1: answer(lookup([pr({ checks: 'passing', failedChecks: undefined, headSha: SHA2 })])) }),
      now([idle()], { s1: answer(lookup([conflicted({ headSha: SHA2 })])) }),
    ])).toEqual([[], ['s1: Merge conflicts on #431 with main'], [], [], ['s1: Merge conflicts on #431 with main']]);
  });

  it('once per review that asks for changes', () => {
    expect(looks([
      now([idle()], { s1: clean }),
      now([idle()], { s1: lookup([asked()]) }),
      now([idle()], { s1: lookup([asked({ headSha: SHA2 })]) }), // a push: the same review
      now([idle()], { s1: lookup([asked({ changesRequested: { ...CHANGES, id: 'PRR_2', reviewers: ['kim'] } })]) }),
    ])).toEqual([[], ['s1: Changes requested on #431 by sam'], [], ['s1: Changes requested on #431 by kim']]);
  });

  it('two reasons at once are one notification naming both; a second reason later is news on its own', () => {
    expect(looks([
      now([idle()], { s1: clean }),
      now([idle()], { s1: lookup([pr({ readiness: 'conflicts' })]) }),
      now([idle()], { s1: lookup([pr({ readiness: 'conflicts', review: 'changes-requested', changesRequested: CHANGES })]) }),
    ])).toEqual([[], ['s1: #431 needs you: checks failed (lint, test), merge conflicts with main'], ['s1: #431 needs you: checks failed (lint, test), merge conflicts with main, changes requested by sam']]);
  });

  it('nothing for a reason turned off in Settings → Git', () => {
    const noChecks = off('checks-failed');
    expect(looks([now([idle()], { s1: running }, noChecks), now([idle()], { s1: lookup([pr()]) }, noChecks)])).toEqual([[], []]);
    expect(looks([now([idle()], { s1: running }, noChecks), now([idle()], { s1: lookup([pr({ readiness: 'conflicts' })]) }, noChecks)])).toEqual([[], ['s1: Merge conflicts on #431 with main']]);
  });

  it('not for what needed the user before the store first answered for the session (Kestrel just opened)', () => {
    expect(looks([now([idle()], {}), now([idle()], { s1: lookup([pr()]) })])).toEqual([[], []]);
  });

  it('holds while the session works, and tells when the turn ends', () => {
    expect(looks([
      now([idle('s1', { state: 'running' })], { s1: running }),
      now([idle('s1', { state: 'running' })], { s1: lookup([pr()]) }),
      now([idle()], { s1: lookup([pr()]) }),
    ])).toEqual([[], [], ['s1: Checks failed on #431: lint, test']]);
  });

  it('tells the host once, never the guest', () => {
    const sessions = [idle('host'), idle('guest', { hostId: 'host' })];
    expect(looks([now(sessions, { host: running }), now(sessions, { host: lookup([pr()]) })])).toEqual([[], ['host: Checks failed on #431: lint, test']]);
  });

  it('has its one switch, and turning it on later brings no backlog', () => {
    const quiet = { ...DEFAULT_NOTIFY, events: { ...DEFAULT_NOTIFY.events, 'pull-request': false } };
    let seen = NOTHING_SEEN;
    for (const step of [now([idle()], { s1: running }), now([idle()], { s1: lookup([pr()]) })]) {
      const next = notificationsOf(seen, step, quiet, AWAY);
      expect(next.events).toEqual([]);
      seen = next.seen;
    }
    expect(notificationsOf(seen, now([idle()], { s1: lookup([pr()]) }), DEFAULT_NOTIFY, AWAY).events).toEqual([]);
    expect(DEFAULT_NOTIFY.events['pull-request']).toBe(true);
  });

  it('not for the session in front of a focused window', () => {
    expect(looks([now([idle()], { s1: running }), now([idle()], { s1: lookup([pr()]) })], DEFAULT_NOTIFY, { focused: true, openSessionId: 's1' })).toEqual([[], []]);
  });
});
