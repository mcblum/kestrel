// What other reviewers have already said on a request the user was asked to review (Matt,
// 2026-11-25): who approved, who asked for changes, and whether the host says it has every approval
// it needs ("satisfied"). The server reads it from the host with the rest of the list
// (review-requests/others.ts) and pushes it on each request; this file is the one place that says
// what it means and how it is worded, for the sidebar, the Code reviews page, a request's page and a
// phone alike. All of it is grey: a tick and plain words, never green, yellow or red. Pure and
// browser-safe.

/** What the host says other reviewers have done. The user's own review is never in it. */
export interface OthersReviews {
  /** Who approved, by login, as the host still counts it (an approval dismissed after a push is not here). */
  approvedBy: string[];
  /** Who asked for changes and still stands by it. */
  changesRequestedBy: string[];
  /**
   * The host says the request has all the approvals it needs: GitHub's review decision is
   * APPROVED, or GitLab has an approval rule and no approvals left. A repository that requires no
   * approval is never satisfied, however many approved.
   */
  satisfied: boolean;
}

export const NOBODY_SAID: OthersReviews = { approvedBy: [], changesRequestedBy: [], satisfied: false };

/** What a row shows of it: a tick or not, and the words. `kind` says which case it is. */
export interface OthersSaid {
  kind: 'none' | 'approved' | 'satisfied' | 'changes';
  /** Drawn before the words, in the text's own grey. Also the request row's status mark when `kind` is `satisfied`. */
  tick: boolean;
  /** "Dana approved", "2 approved", "Approved", "Dana requested changes"; empty when nobody said anything. */
  text: string;
}

const NOTHING: OthersSaid = { kind: 'none', tick: false, text: '' };

const sameUser = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The logins, each once, without the user's own. Pure. */
export const othersOnly = (logins: readonly string[], me: string): string[] => {
  const kept: string[] = [];
  for (const login of logins) if (login && !(me && sameUser(login, me)) && !kept.some((k) => sameUser(k, login))) kept.push(login);
  return kept;
};

/**
 * The one rule for what others said, and its words. A request for changes wins the line over any
 * approval, and over the host's satisfied too: somebody still objects, so the tick is not drawn.
 * Then the host's satisfied ("Approved", and the tick becomes the row's mark), then approvals that
 * do not satisfy it yet ("Dana approved", "2 approved"). Pure.
 */
export function othersSaid(request: { others?: OthersReviews }): OthersSaid {
  const others = request.others;
  if (!others) return NOTHING;
  const changes = others.changesRequestedBy;
  if (changes.length === 1) return { kind: 'changes', tick: false, text: `${changes[0]} requested changes` };
  if (changes.length > 1) return { kind: 'changes', tick: false, text: `Changes requested by ${changes.length}` };
  if (others.satisfied) return { kind: 'satisfied', tick: true, text: 'Approved' };
  const approved = others.approvedBy;
  if (approved.length === 1) return { kind: 'approved', tick: true, text: `${approved[0]} approved` };
  if (approved.length > 1) return { kind: 'approved', tick: true, text: `${approved.length} approved` };
  return NOTHING;
}

/** Whether the host says the request has every approval it needs: what holds back a review that would start on its own. Pure. */
export const isSatisfied = (request: { others?: OthersReviews }): boolean => request.others?.satisfied === true;

const isLogins = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 200 && value.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 200);

/** What a server sent, checked: anything that is not one reads as absent. */
export function asOthersReviews(raw: unknown): OthersReviews | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if (!isLogins(o.approvedBy) || !isLogins(o.changesRequestedBy) || typeof o.satisfied !== 'boolean') return undefined;
  return { approvedBy: o.approvedBy, changesRequestedBy: o.changesRequestedBy, satisfied: o.satisfied };
}
