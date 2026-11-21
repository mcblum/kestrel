// What a session's request pill offers, as data the UI draws (ui/src/components/PullRequestParts.tsx,
// PullRequestGroup.tsx). One request: the single pill. More than one: a grey "3 PRs ▾" pill with a
// thin strip of one segment per request in its status colour, and a popover listing them in the
// same order. Each request, in either place, has the same separate targets: its number opens its
// tab in Kestrel, the external icon opens it on the host, and the status part merges it (opening
// the confirmation), opens its checks, or opens its tab, in that order of preference.
import { pullRequestStatus, type PullRequest, type PullRequestState } from './details.ts';
import { requestNumber, type HostTerms } from './host-terms.ts';
import type { RequestTone } from './row-slot.ts';

/** What the status part of a request does when pressed. */
export type StatusAction = { kind: 'merge' } | { kind: 'checks'; url: string } | { kind: 'open' };

export interface RequestActions {
  /** The host's page for the request, or null when it gave none (no external icon). */
  external: string | null;
  status: StatusAction;
}

/** Status labels whose part opens the pipeline when the host gave a checks link. */
const CHECKS_LABELS: readonly string[] = ['Checks failed', 'Checks running'];

/**
 * The targets a request offers. `canMergeHere` is whether this place can merge at all (it knows
 * the session); merging is then offered only when the status says ready (green).
 */
export function requestActions(pr: PullRequest, canMergeHere: boolean): RequestActions {
  const status = pullRequestStatus(pr);
  const external = pr.url ? pr.url : null;
  if (canMergeHere && status.tone === 'green') return { external, status: { kind: 'merge' } };
  if (CHECKS_LABELS.includes(status.label) && pr.checksUrl) return { external, status: { kind: 'checks', url: pr.checksUrl } };
  return { external, status: { kind: 'open' } };
}

/** Whether the lookup's requests are drawn as a group rather than one pill. */
export const showsGroup = (prs: readonly PullRequest[]): boolean => prs.length > 1;

/** Active first, then finished: the same rank primaryPullRequest uses to pick the single pill's request. */
const STATE_RANK: Readonly<Record<PullRequestState, number>> = { open: 0, draft: 1, merged: 2, closed: 3 };

/** The group's order, for the strip and the popover alike: by state rank, the host's order within a rank. Returns a new list. */
export function groupOrder(prs: readonly PullRequest[]): PullRequest[] {
  return prs.map((pr, index) => ({ pr, index })).sort((a, b) => STATE_RANK[a.pr.state] - STATE_RANK[b.pr.state] || a.index - b.index).map(({ pr }) => pr);
}

/** "3 PRs" or "2 MRs": the group pill's text (the chevron is drawn beside it). */
export const groupLabel = (terms: HostTerms, count: number): string => `${count} ${terms.short}s`;

export interface StripSegment {
  number: number;
  tone: RequestTone;
  /** "#12 · Checks failed", for the segment's tooltip. */
  label: string;
}

/** One equal segment per request, in group order, each in its request's status colour. */
export function stripSegments(terms: HostTerms, prs: readonly PullRequest[]): StripSegment[] {
  return groupOrder(prs).map((pr) => {
    const status = pullRequestStatus(pr);
    return { number: pr.number, tone: status.tone, label: `${requestNumber(terms, pr.number)} · ${status.label}` };
  });
}

/** "3 pull requests: #12 Checks failed, #13 Ready to merge, #9 Merged": the group pill's accessible name and tooltip. */
export function groupDescription(terms: HostTerms, prs: readonly PullRequest[]): string {
  const parts = stripSegments(terms, prs).map((s) => s.label.replace(' · ', ' '));
  return `${prs.length} ${terms.plural}: ${parts.join(', ')}`;
}
