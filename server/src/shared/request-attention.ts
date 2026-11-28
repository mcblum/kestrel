// When a session's pull request needs the user (Matt, 2026-11-24): its checks failed, it has merge
// conflicts with its target, or a reviewer asked for changes. The one rule, read by all four places
// that say so: the session's row (its request mark), the Overview (it is listed under Needs you), the
// notification (shared/notifications.ts) and the card in the conversation (suggestions/request-kind.ts).
// Pure and browser-safe; it reads only what the PR store holds (pull-requests/store.ts) and the user's
// choices in Settings → Git (`AttentionPrefs`), so nothing asks a host for it.
//
// - Only an open or draft request, the session's primary one (`primaryPullRequest`); never a merged or
//   closed one. Checks a host marks optional are not in `failedChecks` (pull-requests/gitlab.ts).
// - Only a reason the user watches (Settings → Git → Pull requests that need you): one turned off is
//   not looked at at all, so no mark, no Overview line, no notification and no card.
// - Only while the session is idle (`isIdle`): its turn is done and it does not wait on an answer. While
//   it works, or waits on an approval or a question in the middle of a turn, nothing is said; it is
//   looked at again when that ends.
// - Only the worktree's owner: a guest shows its host's request (shared/working-tree.ts), so the guest's
//   row may draw the mark, but only the host is listed, told about, or given a card.
// - Once per occurrence: each reason names its occurrence (the failing commit; the commit that
//   conflicts; the review that asked for changes), and the notification and the card are each given
//   once per owner, reason and occurrence. Several reasons at once are one row state and one line.
import type { SessionView } from '../model.ts';
import { primaryPullRequest, type FailedCheck, type PullRequest, type PullRequestLookup, type ReviewComment } from './details.ts';
import { hostTerms, requestNumber, type HostKind } from './host-terms.ts';
import type { Sourced } from './sourced.ts';
import { statusOf, type Statused } from './status.ts';

export type AttentionReason = 'checks-failed' | 'conflicts' | 'changes-requested';
export const ATTENTION_REASONS: readonly AttentionReason[] = ['checks-failed', 'conflicts', 'changes-requested'];

export const REASON_LABEL: Record<AttentionReason, string> = { 'checks-failed': 'Its checks fail', conflicts: 'It has merge conflicts', 'changes-requested': 'A reviewer asks for changes' };

// ---- the user's choices (Settings → Git) ------------------------------------------------------

/** For each reason: whether it is watched at all, and whether its card is offered ("Don't ask again" sets never). */
export interface ReasonPrefs {
  watch: boolean;
  /** Room is left for an "always" (act without asking), not built. */
  card: 'ask' | 'never';
}
export type AttentionPrefs = Record<AttentionReason, ReasonPrefs>;

export const DEFAULT_ATTENTION_PREFS: AttentionPrefs = { 'checks-failed': { watch: true, card: 'ask' }, conflicts: { watch: true, card: 'ask' }, 'changes-requested': { watch: true, card: 'ask' } };

export const isAttentionReason = (v: unknown): v is AttentionReason => (ATTENTION_REASONS as readonly unknown[]).includes(v);

/** Stored or sent choices read back: anything unreadable is the default for that part. */
export function sanitizeAttentionPrefs(raw: unknown): AttentionPrefs {
  const v = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const one = (reason: AttentionReason): ReasonPrefs => {
    const r = (typeof v[reason] === 'object' && v[reason] !== null ? v[reason] : {}) as Record<string, unknown>;
    return { watch: typeof r.watch === 'boolean' ? r.watch : true, card: r.card === 'never' ? 'never' : 'ask' };
  };
  return { 'checks-failed': one('checks-failed'), conflicts: one('conflicts'), 'changes-requested': one('changes-requested') };
}

// ---- the fact ----------------------------------------------------------------------------------

export type ReasonDetail =
  | { reason: 'checks-failed'; occurrence: string; checks: FailedCheck[]; checksUrl?: string }
  | { reason: 'conflicts'; occurrence: string; base: string | null }
  | { reason: 'changes-requested'; occurrence: string; reviewers: string[]; reviewUrl?: string; body?: string; comments: ReviewComment[] };

export interface RequestAttention {
  host: HostKind;
  number: number;
  title: string;
  url: string;
  /** The request's head commit; the number when the host gave none. */
  commit: string;
  /** What needs the user, in the order of ATTENTION_REASONS; never empty. */
  reasons: ReasonDetail[];
}

type Lookup = Sourced<PullRequestLookup> | undefined | null;

function reasonsOf(pr: PullRequest, commit: string, prefs: AttentionPrefs): ReasonDetail[] {
  const out: ReasonDetail[] = [];
  if (prefs['checks-failed'].watch && pr.checks === 'failing') out.push({ reason: 'checks-failed', occurrence: commit, checks: pr.failedChecks ?? [], ...(pr.checksUrl ? { checksUrl: pr.checksUrl } : {}) });
  if (prefs.conflicts.watch && pr.readiness === 'conflicts') out.push({ reason: 'conflicts', occurrence: pr.conflictsSince ?? commit, base: pr.baseBranch ?? null });
  if (prefs['changes-requested'].watch && pr.review === 'changes-requested') {
    const asked = pr.changesRequested;
    out.push({
      reason: 'changes-requested',
      occurrence: asked?.id ?? commit,
      reviewers: asked?.reviewers ?? [],
      ...(asked?.url ? { reviewUrl: asked.url } : {}),
      ...(asked?.body ? { body: asked.body } : {}),
      comments: asked?.comments ?? [],
    });
  }
  return out;
}

/** What a request asks of the user, whatever its session is doing; null when nothing (or nothing watched). */
export function requestAttention(lookup: Lookup, prefs: AttentionPrefs = DEFAULT_ATTENTION_PREFS): RequestAttention | null {
  if (!lookup || lookup.state !== 'ready') return null;
  const pr = primaryPullRequest(lookup.value.pullRequests);
  if (!pr || (pr.state !== 'open' && pr.state !== 'draft')) return null;
  const commit = pr.headSha ?? `#${pr.number}`;
  const reasons = reasonsOf(pr, commit, prefs);
  return reasons.length > 0 ? { host: lookup.value.host, number: pr.number, title: pr.title, url: pr.url, commit, reasons } : null;
}

/** Its turn is done and it does not wait on an answer: not working, not needing the user. A failed run is idle. */
export function isIdle(session: Statused): boolean {
  const status = statusOf(session);
  return status !== 'working' && status !== 'needs-you';
}

export type AttentionSession = Pick<SessionView, 'id' | 'state' | 'note'> & Partial<Pick<SessionView, 'request' | 'stopped' | 'hostId'>>;

/** The fact for a session: its request needs the user, it is the worktree's owner, and it is idle. */
export function sessionAttention(session: AttentionSession, lookup: Lookup, prefs: AttentionPrefs = DEFAULT_ATTENTION_PREFS): RequestAttention | null {
  if (session.hostId || !isIdle(session)) return null;
  return requestAttention(lookup, prefs);
}

/** Every session whose request needs the user, by id. `lookupOf` is the store's answer for a session (an owner's is its own). */
export function attentionBySession(sessions: readonly AttentionSession[], lookupOf: (sessionId: string) => Lookup, prefs: AttentionPrefs = DEFAULT_ATTENTION_PREFS): ReadonlyMap<string, RequestAttention> {
  const out = new Map<string, RequestAttention>();
  for (const s of sessions) {
    const found = sessionAttention(s, s.hostId ? null : lookupOf(s.id), prefs);
    if (found) out.set(s.id, found);
  }
  return out;
}

/** What identifies one occurrence of a reason, for once-only announcements. */
export const occurrenceKey = (d: Pick<ReasonDetail, 'reason' | 'occurrence'>): string => `${d.reason}\n${d.occurrence}`;

/**
 * A new answer with each conflicting request's `conflictsSince` carried over from the last answer while
 * it kept conflicting, else set to its head commit now: one conflict lasts from when it is first seen
 * until it clears, however many commits are pushed meanwhile. Returns `after` itself when nothing
 * changes. Pure.
 */
export function carryConflictsSince(before: Lookup, after: Sourced<PullRequestLookup>): Sourced<PullRequestLookup> {
  if (after.state !== 'ready' || !after.value.pullRequests.some((p) => p.readiness === 'conflicts')) return after;
  const was = before?.state === 'ready' ? before.value.pullRequests : [];
  const pullRequests = after.value.pullRequests.map((p) => {
    if (p.readiness !== 'conflicts' || (p.state !== 'open' && p.state !== 'draft')) return p;
    const earlier = was.find((w) => w.number === p.number && w.readiness === 'conflicts');
    const since = earlier ? (earlier.conflictsSince ?? earlier.headSha) : p.headSha;
    return since && since !== p.conflictsSince ? { ...p, conflictsSince: since } : p;
  });
  return { ...after, value: { ...after.value, pullRequests } };
}

// ---- words -----------------------------------------------------------------------------------

/** The most checks or reviewers named in one line; the rest are counted. */
export const NAMED_CHECKS = 3;

/** Names in a line: "lint, test and 2 more"; '' when none are known. */
export function checkNames(items: readonly { name: string }[] | readonly string[]): string {
  const names = items.map((c) => (typeof c === 'string' ? c : c.name));
  if (names.length <= NAMED_CHECKS) return names.join(', ');
  return `${names.slice(0, NAMED_CHECKS).join(', ')} and ${names.length - NAMED_CHECKS} more`;
}

type Where = Pick<RequestAttention, 'host' | 'number'>;
const whereOf = (a: Where): string => requestNumber(hostTerms(a.host), a.number);

/** One reason on its own: "Checks failed on #431: lint, test", "Merge conflicts on #431 with main", "Changes requested on #431 by sam". */
export function reasonLine(a: Where, d: ReasonDetail): string {
  const where = whereOf(a);
  if (d.reason === 'checks-failed') {
    const names = checkNames(d.checks);
    return names ? `Checks failed on ${where}: ${names}` : `Checks failed on ${where}`;
  }
  if (d.reason === 'conflicts') return d.base ? `Merge conflicts on ${where} with ${d.base}` : `Merge conflicts on ${where}`;
  const who = checkNames(d.reviewers);
  return who ? `Changes requested on ${where} by ${who}` : `Changes requested on ${where}`;
}

/** A reason as part of a longer line: "checks failed (lint, test)", "merge conflicts with main", "changes requested by sam". */
function reasonPhrase(d: ReasonDetail): string {
  if (d.reason === 'checks-failed') {
    const names = checkNames(d.checks);
    return names ? `checks failed (${names})` : 'checks failed';
  }
  if (d.reason === 'conflicts') return d.base ? `merge conflicts with ${d.base}` : 'merge conflicts';
  const who = checkNames(d.reviewers);
  return who ? `changes requested by ${who}` : 'changes requested';
}

/** The line the Overview and the notification say: one reason's own line, or all of them in one. */
export function attentionLine(a: Where & { reasons: readonly ReasonDetail[] }): string {
  if (a.reasons.length === 1) return reasonLine(a, a.reasons[0]!);
  return `${whereOf(a)} needs you: ${a.reasons.map(reasonPhrase).join(', ')}`;
}

/** What the row's mark says after the request's name: "Checks failed: lint, test · Merge conflicts with main". */
export function attentionLabel(a: { reasons: readonly ReasonDetail[] }): string {
  return a.reasons.map((d) => { const p = reasonPhrase(d); return p.charAt(0).toUpperCase() + p.slice(1); }).join(' · ');
}

// ---- the message a card's main button sends -------------------------------------------------

const shortCommit = (commit: string): string => (/^[0-9a-f]{12,}$/i.test(commit) ? commit.slice(0, 8) : commit);

const CHECKS_LOG_HINT: Record<HostKind, string> = {
  github: 'Each link is the page where that check reported its failure. For a GitHub Actions run, from a shell, `gh pr checks <number>` lists them and `gh run view <run id> --log-failed` prints a failed run\'s log (the run id is in the link).',
  gitlab: 'Each link is the page where that job or status reported its failure. For a GitLab CI job, from a shell, `glab ci trace <job id>` prints its log (the job id is the number at the end of the link).',
};

const COMMENTS_HINT: Record<HostKind, string> = {
  github: 'From a shell, `gh pr view <number> --comments` shows the whole conversation.',
  gitlab: 'From a shell, `glab mr view <number> --comments` shows the whole conversation.',
};

/** A check reported by another service (Jenkins, for one) links there, and that page may need a sign-in the agent does not have. */
export const OTHER_SERVICE_HINT = 'A link to another service (a CI server such as Jenkins) may need a sign-in you do not have: if you cannot read it, say so, and work from what you can reproduce in this worktree.';

/** At most this many review comments are put into one message; the rest are counted. */
export const COMMENTS_IN_MESSAGE = 20;

/** The request in words: 'pull request #431 (“Polish the sign-in form”, https://…)'. */
function requestIn(a: Omit<RequestAttention, 'reasons'>): string {
  const terms = hostTerms(a.host);
  return `${terms.long} ${requestNumber(terms, a.number)} (“${a.title}”${a.url ? `, ${a.url}` : ''})`;
}

/**
 * What a card's main button sends the session, as a message the user sent: the request, what is wrong
 * with links, and what to do. Names only what the PR store holds. The agent is never told to reply on
 * the host, and never to force-push.
 */
export function fixMessage(a: Omit<RequestAttention, 'reasons'>, d: ReasonDetail): string {
  const hint = (text: string) => text.replace('<number>', String(a.number));
  if (d.reason === 'checks-failed') {
    const lines = d.checks.map((c) => `- ${c.name}${c.url ? `: ${c.url}` : ''}`);
    const all = d.checksUrl ? [`- All of its checks: ${d.checksUrl}`] : [];
    return [
      `The checks failed on ${requestIn(a)} at commit ${shortCommit(d.occurrence)}.`,
      '',
      d.checks.length > 0 ? 'These failed:' : 'The host did not say which ones failed; they are here:',
      ...(lines.length > 0 ? [...lines, ...all] : all),
      '',
      hint(CHECKS_LOG_HINT[a.host]),
      OTHER_SERVICE_HINT,
      '',
      'Find out why each check failed, from its log where you can read it, fix what made them fail, and push the fix to the same branch.',
    ].join('\n');
  }
  if (d.reason === 'conflicts') {
    const base = d.base ?? 'its target branch';
    return [
      `${requestIn(a)} has merge conflicts with ${d.base ? `\`${d.base}\`` : 'its target branch'}.`,
      '',
      `In this worktree: fetch from the remote, merge the remote's \`${base}\` into this branch (a merge, not a rebase, so the branch's history stays as it is), resolve each conflict keeping what both sides meant, run the tests, commit the merge and push.`,
      'Do not force-push or rewrite the branch\'s history without asking me first.',
    ].join('\n');
  }
  const who = d.reviewers.length > 0 ? d.reviewers.join(', ') : 'A reviewer';
  const comments = d.comments.slice(0, COMMENTS_IN_MESSAGE).map((c) => `- ${c.path ? `${c.path}${c.line ? `:${c.line}` : ''}: ` : ''}${c.body.replace(/\s+/g, ' ').trim()}${c.url ? ` (${c.url})` : ''}`);
  const more = d.comments.length > COMMENTS_IN_MESSAGE ? [`- …and ${d.comments.length - COMMENTS_IN_MESSAGE} more comments on the request.`] : [];
  return [
    `${who} asked for changes on ${requestIn(a)}${d.reviewUrl ? ` (the review: ${d.reviewUrl})` : ''}.`,
    ...(d.body ? ['', 'Their review says:', ...d.body.trim().split('\n').map((l) => `> ${l}`)] : []),
    ...(comments.length > 0 ? ['', 'Their comments:', ...comments, ...more] : ['', 'The host gave no comments with it.']),
    '',
    hint(COMMENTS_HINT[a.host]),
    '',
    'Address each of them in this worktree, run the tests, commit and push. Do not reply on the pull request or resolve its threads yourself: tell me here what you changed for each comment, and I will answer the reviewer.',
  ].join('\n');
}

/**
 * What Autopilot sends when the host will not merge the request until its branch has its base's newest
 * commits (`mustCatchUp`). No card sends this: a branch behind is not something that needs the user.
 */
export function catchUpMessage(a: Omit<RequestAttention, 'reasons'>, base: string | null): string {
  const target = base ?? 'its target branch';
  return [
    `${requestIn(a)} is behind ${base ? `\`${base}\`` : 'its target branch'}, and the host will not merge it until it is up to date.`,
    '',
    `In this worktree: fetch from the remote, merge the remote's \`${target}\` into this branch (a merge, not a rebase, so the branch's history stays as it is), resolve any conflict keeping what both sides meant, run the tests, commit the merge and push.`,
    'Do not force-push or rewrite the branch\'s history without asking me first.',
  ].join('\n');
}

// ---- when a card no longer applies -------------------------------------------------------------

/**
 * Why a card about `before` no longer applies, from the store's answer now and the user's choices;
 * null while it still does (the same reason and occurrence still hold, or the store has no answer).
 */
export function settledLine(before: Where & Pick<ReasonDetail, 'reason' | 'occurrence'>, lookup: Lookup, prefs: AttentionPrefs = DEFAULT_ATTENTION_PREFS): string | null {
  if (!lookup || lookup.state !== 'ready') return null;
  if (!prefs[before.reason].watch) return 'No longer watched: turned off in Settings → Git';
  const now = requestAttention(lookup, prefs);
  const same = now && now.number === before.number ? now.reasons.find((d) => d.reason === before.reason) : undefined;
  if (same && same.occurrence === before.occurrence) return null;
  const where = whereOf(before);
  const pr = lookup.value.pullRequests.find((p) => p.number === before.number);
  if (!pr) return `${where} is no longer linked to this session`;
  if (pr.state === 'merged') return `${where} was merged`;
  if (pr.state === 'closed') return `${where} was closed`;
  if (before.reason === 'checks-failed') {
    if (same) return `Checks failed again on a newer commit of ${where}`;
    if (pr.checks === 'running') return `Checks are running again on ${where}`;
    if (pr.checks === 'passing') return `Checks passed on ${where}`;
    return `Checks are no longer failing on ${where}`;
  }
  if (before.reason === 'conflicts') return same ? `${where} conflicts again on a newer commit` : `The conflicts on ${where} are resolved`;
  return same ? `A newer review asks for changes on ${where}` : `Changes are no longer requested on ${where}`;
}
