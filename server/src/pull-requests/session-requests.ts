// A session's pull requests: the ones on its current branch, plus every request linked to it earlier
// (model.ts `RequestLink`), so requests opened before a branch change stay listed. Each lookup that
// finds requests on the current branch links the ones not linked yet; nothing unlinks them. Linked
// requests not on the current branch are fetched by number (by-number.ts). Every request a lookup
// sees is recorded with its state, so each link keeps the state it was last seen in (status.ts reads
// it). The answer is newest number first, one entry per number, the current branch's copy winning.
import type { RequestLink } from '../model.ts';
import type { PullRequest, PullRequestLookup } from '../shared/details.ts';
import type { HostKind } from '../shared/host-terms.ts';
import { ready, unavailable, type Sourced } from '../shared/sourced.ts';
import type { ByNumberProvider } from './by-number.ts';
import { resolveProvider } from './choose.ts';
import type { GlabSignInCheck } from './glab.ts';

/** A link before it is stamped with when it was made (Workspace.recordRequests does that), with the state it was seen in. */
export type NewRequestLink = Omit<RequestLink, 'linkedAt'>;

export interface SessionRequestSources {
  /** The requests whose source branch is `branch`, with which host answered. */
  pullRequestsFor(repoPath: string, branch: string): Promise<Sourced<PullRequestLookup>>;
  /** The linked requests fetched by number from the host the repository answers to. */
  linkedRequests(repoPath: string, links: readonly RequestLink[]): Promise<Sourced<PullRequestLookup>>;
}

export const NO_BRANCH = 'This session has no branch';

const sameRequest = (host: HostKind, number: number) => (link: Pick<RequestLink, 'host' | 'number'>) => link.host === host && link.number === number;

/** The requests found on `branch`, as links with the state each was seen in (one already linked keeps its own branch when recorded). Pure. */
export function seenOnBranch(found: readonly PullRequest[], host: HostKind, branch: string): NewRequestLink[] {
  return found.map((pr) => ({ host, number: pr.number, url: pr.url, branch, state: pr.state }));
}

/** The linked requests fetched by number, as their links with the state each was seen in; one not linked is left out. Pure. */
export function seenLinked(found: readonly PullRequest[], host: HostKind, links: readonly RequestLink[]): NewRequestLink[] {
  return found.flatMap((pr) => {
    const link = links.find(sameRequest(host, pr.number));
    return link ? [{ host, number: pr.number, url: link.url, branch: link.branch, state: pr.state }] : [];
  });
}

/** The links for `host` whose request is not among `found`. Pure. */
export function missingLinks(links: readonly RequestLink[], host: HostKind, found: readonly PullRequest[]): RequestLink[] {
  const numbers = new Set(found.map((pr) => pr.number));
  return links.filter((link) => link.host === host && !numbers.has(link.number));
}

/** Both lists as one: one entry per number (the first list's copy wins), newest number first. Pure. */
export function mergeRequests(current: readonly PullRequest[], linked: readonly PullRequest[]): PullRequest[] {
  const firsts = [...current, ...linked].filter((pr, i, all) => all.findIndex((other) => other.number === pr.number) === i);
  return firsts.sort((a, b) => b.number - a.number);
}

/**
 * What the lookup cache is keyed on besides repository and branch: the links made on other branches.
 * A link made on the current branch is shown by the very lookup that made it, so it does not need to
 * start a new one; a link from elsewhere changes the key, so it shows without waiting. Pure.
 */
export function linksCacheKey(links: readonly RequestLink[], branch: string | null): string {
  return links
    .filter((link) => link.branch !== branch)
    .map((link) => `${link.host}:${link.number}`)
    .sort()
    .join(',');
}

/**
 * The requests behind `links` from one by-number provider. One the host no longer has, or could not
 * be asked about, is left out of this answer; its link is kept, and the next lookup asks again. Only
 * when every one failed to be asked is the answer unavailable, with the first reason.
 */
export async function fetchLinked(provider: ByNumberProvider, host: HostKind, repoPath: string, links: readonly RequestLink[]): Promise<Sourced<PullRequestLookup>> {
  const answers = await Promise.all(links.map((link) => provider.pullRequestByNumber(repoPath, link.number)));
  const found = answers.flatMap((answer) => (answer.state === 'ready' && answer.value ? [answer.value] : []));
  const failed = answers.flatMap((answer) => (answer.state === 'unavailable' ? [answer.reason] : []));
  if (links.length > 0 && failed.length === links.length) return unavailable(failed[0]!);
  return ready({ host, pullRequests: mergeRequests(found, []) });
}

export interface LinkedSources {
  github: ByNumberProvider;
  gitlab: ByNumberProvider;
  glabSignIn: GlabSignInCheck;
  originOf(repoPath: string): Promise<string | null>;
}

/** The linked requests from whichever host the repository's remote calls for; links to another kind of host are kept but not shown. */
export async function linkedRequestsFor(sources: LinkedSources, repoPath: string, links: readonly RequestLink[]): Promise<Sourced<PullRequestLookup>> {
  const choice = await resolveProvider(await sources.originOf(repoPath), sources.glabSignIn);
  if (choice.kind === 'none') return unavailable(choice.reason);
  return fetchLinked(sources[choice.kind], choice.kind, repoPath, links.filter((link) => link.host === choice.kind));
}

/**
 * The session's answer. With no branch: its linked requests (unavailable when it has none). With a
 * branch: that branch's requests plus the linked ones not among them. Every request seen is handed
 * to `record` with its state: the branch's link themselves if not linked yet, the others update
 * their link's state. When the branch lookup fails its reason is the answer, as before links existed.
 */
export async function sessionPullRequests(
  sources: SessionRequestSources,
  repoPath: string,
  branch: string | null,
  links: readonly RequestLink[],
  record: (seen: NewRequestLink[]) => Promise<unknown>,
): Promise<Sourced<PullRequestLookup>> {
  const recordAll = (seen: NewRequestLink[]) => (seen.length > 0 ? record(seen) : undefined);
  if (!branch) {
    if (links.length === 0) return unavailable(NO_BRANCH);
    const linked = await sources.linkedRequests(repoPath, links);
    if (linked.state === 'ready') await recordAll(seenLinked(linked.value.pullRequests, linked.value.host, links));
    return linked;
  }
  const current = await sources.pullRequestsFor(repoPath, branch);
  if (current.state !== 'ready') return current;
  const { host, pullRequests } = current.value;
  const missing = missingLinks(links, host, pullRequests);
  const linked = missing.length > 0 ? await sources.linkedRequests(repoPath, missing) : null;
  // A linked request that cannot be fetched now is left out of this answer only.
  const extra = linked?.state === 'ready' && linked.value.host === host ? linked.value.pullRequests : [];
  await recordAll([...seenOnBranch(pullRequests, host, branch), ...seenLinked(extra, host, missing)]);
  return ready({ host, pullRequests: mergeRequests(pullRequests, extra) });
}
