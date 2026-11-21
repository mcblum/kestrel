// The words a hosting service uses for the change requests Kestrel shows and opens: GitHub says
// "pull request", "PR" and "#12"; GitLab says "merge request", "MR" and "!12". One table, shared with
// the UI, so every label, tooltip and error follows the repository's host without scattered checks.

export const HOST_KINDS = ['github', 'gitlab'] as const;
export type HostKind = (typeof HOST_KINDS)[number];

export interface HostTerms {
  /** "GitHub" or "GitLab". */
  service: string;
  /** "PR" or "MR". */
  short: string;
  /** "pull request" or "merge request", lower case. */
  long: string;
  /** "Pull request" or "Merge request", for the start of a sentence. */
  longTitle: string;
  /** "pull requests" or "merge requests". */
  plural: string;
  /** "#" or "!": what goes before a request's number. */
  sigil: string;
}

const TERMS: Readonly<Record<HostKind, HostTerms>> = {
  github: { service: 'GitHub', short: 'PR', long: 'pull request', longTitle: 'Pull request', plural: 'pull requests', sigil: '#' },
  gitlab: { service: 'GitLab', short: 'MR', long: 'merge request', longTitle: 'Merge request', plural: 'merge requests', sigil: '!' },
};

/** The default wording when the host is not known (no lookup answer yet). */
export const DEFAULT_HOST: HostKind = 'github';

export const isHostKind = (value: unknown): value is HostKind => typeof value === 'string' && (HOST_KINDS as readonly string[]).includes(value);

/** The words for a host; anything unknown gets the default host's words. */
export const hostTerms = (kind: HostKind | null | undefined): HostTerms => TERMS[isHostKind(kind) ? kind : DEFAULT_HOST];

/** "#12" or "!12". */
export const requestNumber = (terms: HostTerms, number: number): string => `${terms.sigil}${number}`;

/** "PR #12" or "MR !12". */
export const requestLabel = (terms: HostTerms, number: number): string => `${terms.short} ${requestNumber(terms, number)}`;
