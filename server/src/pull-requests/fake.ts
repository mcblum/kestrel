// SAMPLE DATA, for KESTREL_FAKE=1 only: made-up pull requests for some of the seeded sessions'
// branches (seed.ts), so the Details pane can be looked at without a hosting service. Every other
// branch has none until "Create pull request" adds a made-up one, kept in memory for this run only.
// "Billing migration" also has two requests from branches it was on before (`SAMPLE_EARLIER_LINKS`,
// linked by the seed), so a session with several requests in different states can be seen. The seed
// links every seeded session's sample requests in the state they are in (`sampleLinksOn`), so the
// sample's statuses show both outcomes before any Details pane is opened: "Fix partial writes in the
// search index" is Ready to review (its request is open), "Keyboard shortcuts" is Done (its newest
// request is a draft), and "Draft release notes" is Done though it changed files (it has no request).
// The New PR form's pre-fill is made up here too (never with inherited commits): no model, no gh,
// no git. Never used with a real store. Between them the sample requests give every filter of the
// Pull requests page a row: needing attention (#406), ready (#419, #421), draft (#398), merged (#377,
// #388), and #406 is linked to two sessions (`SAMPLE_SHARED_LINKS`).
import type { PullRequest } from '../shared/details.ts';
import { ready } from '../shared/sourced.ts';
import type { ByNumberProvider } from './by-number.ts';
import type { PRForm } from './create.ts';
import type { NewRequestLink } from './session-requests.ts';
import type { PipelineProvider, PullRequestProvider } from './types.ts';

const SAMPLE: Readonly<Record<string, readonly PullRequest[]>> = {
  // "Make search feel instant": one open pull request, checks still running.
  'feat/instant-search': [{ number: 412, title: 'Make search feel instant', state: 'open', checks: 'running', review: 'review-required', url: 'https://github.com/example/bellbird/pull/412' }],
  // "Keyboard shortcuts": an earlier one merged, a follow-up still a draft that conflicts with main, so
  // the finished session shows the request mark, Overview line and notification for one reason
  // (shared/request-attention.ts).
  'feat/shortcuts': [
    {
      number: 398,
      title: 'Keyboard shortcuts: follow-up for the command palette',
      state: 'draft',
      checks: 'passing',
      review: 'none',
      readiness: 'conflicts',
      url: 'https://github.com/example/bellbird/pull/398',
      checksUrl: 'https://github.com/example/bellbird/pull/398/checks',
      headSha: '5be1a0d47c2e9f13b8a6d0e4c7f2a91b3d8e6c05',
      headBranch: 'feat/shortcuts',
      baseBranch: 'main',
    },
    { number: 377, title: 'Keyboard shortcuts for switching sessions', state: 'merged', checks: 'passing', review: 'approved', url: 'https://github.com/example/bellbird/pull/377' },
  ],
  // "Fix partial writes in the search index" (done, so no dot once looked at): open and ready to
  // merge, so the sidebar's request icon can be seen, in green.
  'kestrel/index-atomic-writes': [{ number: 419, title: 'Fix partial writes in the search index', state: 'open', checks: 'passing', review: 'approved', readiness: 'ready', url: 'https://github.com/example/platform/pull/419' }],
  // "Polish the sign-in form": opened by its Design guest, which works in its worktree, so the host
  // and the guest show this one request (shared/working-tree.ts). Its checks failed and a reviewer asked
  // for changes: both rows show the mark, and only the host is listed on the Overview, with one line
  // naming both (shared/request-attention.ts). A sample session has no agent behind it, so it takes no
  // card; suggestions/request-kind.test.ts shows the cards.
  'feat/sign-in-polish': [
    {
      number: 431,
      title: 'Polish the sign-in form',
      state: 'open',
      checks: 'failing',
      review: 'changes-requested',
      url: 'https://github.com/example/bellbird/pull/431',
      checksUrl: 'https://github.com/example/bellbird/pull/431/checks',
      headSha: 'e41f09b2c7d35a8e6f1b0c94d2a7e53f8b6c1d20',
      headBranch: 'feat/sign-in-polish',
      baseBranch: 'main',
      failedChecks: [
        { name: 'lint', url: 'https://github.com/example/bellbird/actions/runs/8840/job/24410' },
        { name: 'test', url: 'https://github.com/example/bellbird/actions/runs/8840/job/24411' },
      ],
      changesRequested: {
        id: 'PRR_sample431',
        reviewers: ['sam-reviewer'],
        url: 'https://github.com/example/bellbird/pull/431#pullrequestreview-9001',
        body: 'Close, but the error state needs work before this goes in.',
        comments: [
          { body: 'The error text should sit under the field, not above the button.', path: 'src/sign-in/Form.tsx', line: 88, url: 'https://github.com/example/bellbird/pull/431#discussion_r9101' },
          { body: 'Please keep the old aria-describedby so screen readers still read the hint.', path: 'src/sign-in/Form.tsx', line: 112, url: 'https://github.com/example/bellbird/pull/431#discussion_r9102' },
        ],
      },
    },
  ],
  // "Billing migration": open and ready on its current branch; the two below came from earlier branches.
  'feat/billing-v2': [{ number: 421, title: 'Billing v2: switch reads behind the flag', state: 'open', checks: 'passing', review: 'approved', readiness: 'ready', url: 'https://github.com/example/platform/pull/421' }],
  // Shared with "Background job retries", which is working: its failed checks are held until the turn ends.
  'feat/billing-backfill': [{ number: 406, title: 'Billing v2: backfill existing accounts', state: 'open', checks: 'failing', review: 'review-required', readiness: 'blocked', url: 'https://github.com/example/platform/pull/406', headSha: '9d41c7e2a0b85f63e1d47a2c9b0e8f5d6a3c1b74', failedChecks: [{ name: 'migrate-check', url: 'https://github.com/example/platform/actions/runs/8790/job/24177' }] }],
  // The "Checkout latency" workstream: each of the three sessions its lead brought in has a request, so
  // the lead (which has none of its own) shows "3 PRs" in its header, on the workstream's row and on its
  // page (shared/brought-in-requests.ts). The pricing cache's checks failed.
  'kestrel/pricing-cache': [{ number: 433, title: 'Cache the pricing lookup per request', state: 'open', checks: 'failing', review: 'review-required', readiness: 'blocked', url: 'https://github.com/example/platform/pull/433', headSha: '7c2e91b04d5af3e8c16b9d20a4f7e85c3b0d1a69', failedChecks: [{ name: 'continuous-integration/jenkins/pr-merge', url: 'https://ci.example.com/job/platform/PR-433/2/display/redirect' }] }],
  'kestrel/cart-debounce': [{ number: 434, title: 'Debounce cart recalculation', state: 'open', checks: 'running', review: 'review-required', url: 'https://github.com/example/bellbird/pull/434' }],
  'kestrel/pricing-cache-header': [{ number: 435, title: 'Document the pricing cache header', state: 'draft', checks: 'passing', review: 'none', url: 'https://github.com/example/docs/pull/435' }],
  // Delegated by "Billing migration" inside its own project: shown under its pill as "1 PR".
  'feat/billing-reports': [{ number: 436, title: 'Billing v2: usage reports', state: 'open', checks: 'passing', review: 'approved', readiness: 'ready', url: 'https://github.com/example/platform/pull/436' }],
  // Two more parts "Billing migration" delegated, in the demo only (seed-demo.ts): three requests under its pill.
  'feat/billing-invoices': [{ number: 437, title: 'Billing v2: invoice export', state: 'open', checks: 'failing', review: 'review-required', readiness: 'blocked', url: 'https://github.com/example/platform/pull/437', headSha: '3f8a1c6e9b2d4075a1e8c3b6d9f2047e5a1c8b3d', failedChecks: [{ name: 'continuous-integration/jenkins/pr-merge', url: 'https://ci.example.com/job/platform/PR-437/1/display/redirect' }] }],
  'feat/billing-proration': [{ number: 438, title: 'Billing v2: proration', state: 'open', checks: 'running', review: 'review-required', url: 'https://github.com/example/platform/pull/438' }],
  // The "Usage-based pricing" workstream, in the demo only: the lead's own request, and two of its three
  // sessions' (one ready, one with failed checks); the third has none.
  'feat/usage-pricing': [{ number: 439, title: 'Usage-based pricing: meter usage per account', state: 'open', checks: 'passing', review: 'review-required', url: 'https://github.com/example/platform/pull/439' }],
  'feat/usage-plan-picker': [{ number: 440, title: 'Plan picker for usage-based pricing', state: 'open', checks: 'passing', review: 'approved', readiness: 'ready', url: 'https://github.com/example/bellbird/pull/440' }],
  // A five-digit number and a long title, as a busy repository has: a card or menu that lists it must
  // keep its icon at the line's start and cut the words at the edge (the hover card once did not).
  'docs/usage-pricing-page': [{ number: 14417, title: 'Pricing page for usage-based plans: rewrite the comparison table and the FAQ for metered billing', state: 'open', checks: 'failing', review: 'review-required', readiness: 'blocked', url: 'https://github.com/example/docs/pull/14417', headSha: '5b2e8d1f7a3c9e04b6d2f8a1c7e3b9d05f4a2c6e', failedChecks: [{ name: 'continuous-integration/jenkins/pr-merge', url: 'https://ci.example.com/job/docs/PR-14417/1/display/redirect' }] }],
  'feat/billing-schema': [{ number: 388, title: 'Billing v2: add the billing tables', state: 'merged', checks: 'passing', review: 'approved', url: 'https://github.com/example/platform/pull/388' }],
};

/** The sample session that has requests from branches it is no longer on, and the earlier branches. */
export const SAMPLE_LINKED_SESSION = 'billing';
const EARLIER_BRANCHES = ['feat/billing-schema', 'feat/billing-backfill'] as const;

/** The sample requests on `branch` as links, each in the state it is in, as a lookup would record them. */
export function sampleLinksOn(branch: string): NewRequestLink[] {
  return (SAMPLE[branch] ?? []).map((pr) => ({ host: 'github' as const, number: pr.number, url: pr.url, branch, state: pr.state }));
}

/** Links for the requests "Billing migration" opened on its earlier branches, as the seed stores them. */
export const SAMPLE_EARLIER_LINKS: readonly NewRequestLink[] = EARLIER_BRANCHES.flatMap(sampleLinksOn);

/**
 * "Background job retries" also works on "Billing migration"'s backfill request (#406), so one
 * request is linked to two sessions and the Pull requests page shows it once, naming both.
 */
export const SAMPLE_SHARED_SESSION = 'queue';
export const SAMPLE_SHARED_LINKS: readonly NewRequestLink[] = sampleLinksOn('feat/billing-backfill');

/** The first number a made-up pull request gets; above every number of the sample repository in SAMPLE. */
const FIRST_MADE_UP_NUMBER = 501;
const SAMPLE_REPOSITORY_URL = 'https://github.com/example/sample';
/** The default branch the sample pre-fill offers. */
export const SAMPLE_BASE = 'main';

export interface SamplePullRequests extends PullRequestProvider, ByNumberProvider, PipelineProvider {
  /** Opens a made-up pull request for `branch`, or returns the open one it already has. */
  create(branch: string, form: PRForm): PullRequest;
}

const isActive = (pr: PullRequest) => pr.state === 'open' || pr.state === 'draft';

/** A fresh in-memory sample provider: what one server run has made up is never seen by another. */
export function samplePullRequests(): SamplePullRequests {
  let made: Readonly<Record<string, readonly PullRequest[]>> = {};
  let next = FIRST_MADE_UP_NUMBER;
  const all = (branch: string): PullRequest[] => [...(made[branch] ?? []), ...(SAMPLE[branch] ?? [])];
  return {
    pullRequestsFor: async (_repoPath, branch) => ready(all(branch)),
    // The target branch's pipeline after a merge, for Autopilot's watch: it always passes.
    pipelineOn: async (_repoPath, sha) => ready({ sha, checks: 'passing' }),
    pullRequestByNumber: async (_repoPath, number) => {
      const everyBranch = [...Object.values(made), ...Object.values(SAMPLE)].flat();
      return ready(everyBranch.find((pr) => pr.number === number) ?? null);
    },
    create(branch, form) {
      const existing = all(branch).find(isActive);
      if (existing) return existing;
      const pr: PullRequest = { number: next, title: form.title, body: form.body, state: form.draft ? 'draft' : 'open', checks: 'none', review: 'review-required', url: `${SAMPLE_REPOSITORY_URL}/pull/${next}`, headBranch: branch, baseBranch: form.base, author: 'sample-user' };
      next += 1;
      made = { ...made, [branch]: [pr, ...(made[branch] ?? [])] };
      return pr;
    },
  };
}

/** The New PR form's sample pre-fill: blank for "Manually", made-up text for "Generated"; no inherited commits. Deterministic. */
export function samplePrefill(sessionTitle: string, branch: string, generated: boolean): Omit<PRForm, 'draft'> & { inherited: number } {
  if (!generated) return { title: '', body: '', base: SAMPLE_BASE, inherited: 0 };
  const body = [
    '## Summary',
    '',
    `- Sample text for \`${branch}\`: with real data this is written from the branch's commits and diff.`,
    '',
    '## Testing',
    '',
    'Not recorded.',
  ].join('\n');
  return { title: sessionTitle, body, base: SAMPLE_BASE, inherited: 0 };
}
