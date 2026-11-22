// "Reviewing": one comment on a pull request that says a review of it is under way (0.0.23; Matt,
// 2026-11-21). When many people let reviews start on their own, a request to several of them sets
// several agents off at once, none knowing of the others. So Kestrel is opinionated about one
// convention:
//
//   - When a review begins, and the user chose it (Settings → Code reviews), Kestrel posts a short
//     comment in their name that starts "Reviewing" and carries a mark only Kestrel writes.
//   - Before a review starts ON ITS OWN, Kestrel reads the request's recent comments. If somebody
//     else has said they are reviewing it, within the last day, it does not start; the request
//     says why, and the user can still start one by hand.
//
// A person who writes "Reviewing" themselves counts the same: the convention is the word, not the
// tool. A claim is good for a day, so a review that was abandoned does not block the request for
// ever. Reading is done whichever way the option is set; only posting needs it. The command runner
// is injected: tests never call gh or glab.
import { homedir } from 'node:os';
import { execRunner, GH_TIMEOUT_MS } from '../pull-requests/github.ts';
import { GLAB_TIMEOUT_MS } from '../pull-requests/glab.ts';
import type { CommandRunner } from '../pull-requests/types.ts';
import type { HostKind } from '../shared/host-terms.ts';

/** In every comment Kestrel posts for this, unseen on the page: how another Kestrel knows it for certain. */
export const REVIEWING_MARK = '<!-- kestrel:reviewing -->';
/** How long a "Reviewing" comment holds a request. */
export const REVIEWING_FRESH_MS = 24 * 60 * 60 * 1000;

/** What Kestrel posts. Says which commit, so a later reader knows what the review is of. Pure. */
export const reviewingComment = (sha: string): string => `Reviewing this now, at commit ${sha.slice(0, 12)}. (Posted by Kestrel when the review started, so that reviews do not double up.)\n\n${REVIEWING_MARK}`;

/** Whether a comment says its author is reviewing: Kestrel's mark, or a comment that opens with the word. Pure. */
export function saysReviewing(body: string): boolean {
  if (body.includes(REVIEWING_MARK)) return true;
  const opening = body.trimStart().replace(/^(?:\p{Extended_Pictographic}|️|:[a-z0-9_+-]+:|\s)+/u, '');
  return /^reviewing\b/i.test(opening);
}

/** Somebody's word that they are reviewing: who, and when (milliseconds; 0 when the host did not say). */
export interface ReviewClaim {
  by: string;
  at: number;
}

type Fields = Record<string, unknown>;
const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const when = (value: unknown): number => {
  const at = Date.parse(text(value));
  return Number.isFinite(at) ? at : 0;
};

function claimsFrom(json: string, read: (comment: Fields) => { by: string; body: string; at: number } | null): ReviewClaim[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isFields).flatMap((comment) => {
    const found = read(comment);
    return found && found.by && saysReviewing(found.body) ? [{ by: found.by, at: found.at }] : [];
  });
}

/** The "Reviewing" comments among a GitHub pull request's comments (`gh api …/issues/N/comments`). Pure. */
export const githubClaims = (json: string): ReviewClaim[] => claimsFrom(json, (c) => ({ by: isFields(c.user) ? text(c.user.login) : '', body: text(c.body), at: when(c.created_at) }));

/** The same among a GitLab merge request's notes; system notes ("requested review from…") are not anyone's word. Pure. */
export const gitlabClaims = (json: string): ReviewClaim[] => claimsFrom(json, (n) => (n.system === true ? null : { by: isFields(n.author) ? text(n.author.username) : '', body: text(n.body), at: when(n.created_at) }));

const sameUser = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Of the claims still fresh at `now`: the most recent by somebody other than `me`, and the most
 * recent by `me`. A claim with no time is taken as fresh: better to hold back than to double up. Pure.
 */
export function standingClaims(claims: readonly ReviewClaim[], me: string, now: number): { other: ReviewClaim | null; mine: ReviewClaim | null } {
  const fresh = claims.filter((c) => c.at === 0 || now - c.at < REVIEWING_FRESH_MS).sort((a, b) => b.at - a.at);
  return { other: fresh.find((c) => !sameUser(c.by, me)) ?? null, mine: fresh.find((c) => sameUser(c.by, me)) ?? null };
}

/** "20 minutes ago", for the reason a review did not start. Pure. */
export function claimAge(claim: ReviewClaim, now: number): string {
  if (claim.at === 0) return 'recently';
  const minutes = Math.max(0, Math.round((now - claim.at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

/** Why a review did not start on its own: who is on it already, and what the user can do. Pure. */
export const alreadyReviewing = (claim: ReviewClaim, now: number): string => `${claim.by} said they are reviewing this ${claimAge(claim, now)}, so Kestrel did not start a second review on its own. Start one yourself if you want it anyway.`;

interface Where {
  host: HostKind;
  hostName: string;
  repository: string;
  number: number;
}

const gitlabProject = (repository: string): string => `projects/${encodeURIComponent(repository)}`;
/** Only comments newer than the claim's lifetime are asked for: `since` on GitHub; GitLab's newest hundred. */
export const githubCommentsArgs = (w: Where, since: number): string[] => ['api', '-X', 'GET', `repos/${w.repository}/issues/${w.number}/comments`, '-F', 'per_page=100', '-f', `since=${new Date(since).toISOString()}`];
export const gitlabCommentsArgs = (w: Where): string[] => ['api', `${gitlabProject(w.repository)}/merge_requests/${w.number}/notes?sort=desc&order_by=created_at&per_page=100`, '--hostname', w.hostName];
export const githubPostArgs = (w: Where, body: string): string[] => ['api', '-X', 'POST', `repos/${w.repository}/issues/${w.number}/comments`, '-f', `body=${body}`];
export const gitlabPostArgs = (w: Where, body: string): string[] => ['api', '-X', 'POST', `${gitlabProject(w.repository)}/merge_requests/${w.number}/notes`, '--hostname', w.hostName, '-f', `body=${body}`];
export const githubMeArgs = (): string[] => ['api', 'user', '--jq', '.login'];
export const gitlabMeArgs = (hostName: string): string[] => ['api', 'user', '--hostname', hostName];

export interface ReviewingComments {
  /** Who has said they are reviewing this request and is still held to it. Throws when the host cannot be asked. */
  standing(request: Where, now: number): Promise<{ other: ReviewClaim | null; mine: ReviewClaim | null }>;
  /** Post Kestrel's "Reviewing" comment, in the user's name. Throws with the host's reason when it is not posted. */
  announce(request: Where, sha: string): Promise<void>;
}

export function reviewingComments(run: CommandRunner = execRunner, cwd: string = homedir()): ReviewingComments {
  const names = new Map<string, Promise<string>>();
  const gh = async (args: string[]) => (await run('gh', args, { cwd, timeoutMs: GH_TIMEOUT_MS })).stdout;
  const glab = async (args: string[]) => (await run('glab', args, { cwd, timeoutMs: GLAB_TIMEOUT_MS })).stdout;
  /** Who the user is on a host, asked once per host; a failed answer is asked again next time. */
  const me = (w: Where): Promise<string> => {
    const key = `${w.host}:${w.hostName}`;
    let name = names.get(key);
    if (!name) {
      name = w.host === 'github' ? gh(githubMeArgs()).then((out) => out.trim()) : glab(gitlabMeArgs(w.hostName)).then((out) => text((JSON.parse(out) as Fields | null)?.username));
      names.set(key, name);
      name.then(
        (found) => found || names.delete(key),
        () => names.delete(key),
      );
    }
    return name;
  };
  return {
    async standing(request, now) {
      const claims = request.host === 'github' ? githubClaims(await gh(githubCommentsArgs(request, now - REVIEWING_FRESH_MS))) : gitlabClaims(await glab(gitlabCommentsArgs(request)));
      // Nobody else has a claim: no need to know who the user is.
      if (claims.length === 0) return { other: null, mine: null };
      return standingClaims(claims, await me(request), now);
    },
    async announce(request, sha) {
      const body = reviewingComment(sha);
      await (request.host === 'github' ? gh(githubPostArgs(request, body)) : glab(gitlabPostArgs(request, body)));
    },
  };
}
