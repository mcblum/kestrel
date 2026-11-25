// A session's pull or merge requests: the pill in the session bar and table rows (one pill, or the
// group pill when there are several), and the request page in its tab.
import { ExternalLink, RefreshCw } from 'lucide-react';
import { lookupHost, mergeText, primaryPullRequest, pullRequestStatus, type PullRequest, type PullRequestLookup } from '@kestrel/server/details';
import { hostTerms, requestNumber, type HostTerms } from '@kestrel/server/host-terms';
import { showsGroup } from '@kestrel/server/request-group';
import type { Sourced } from '@kestrel/server/sourced';
import { Markdown } from './Markdown.tsx';
import { requestParts, useMergeConfirmation } from './PullRequestParts.tsx';
import { PullRequestGroup } from './PullRequestGroup.tsx';
import '../styles/pull-request.css';

export interface PullRequestSource { value: Sourced<PullRequestLookup>; refresh: () => void }

export interface PullRequestSummaryProps {
  value: Sourced<PullRequestLookup>;
  /** Opens a request's tab in Kestrel. */
  onOpen: (pr: PullRequest) => void;
  /** The session, where merging is possible. */
  sessionId?: string;
  onRefresh?: () => void;
  /** The smaller size of either pill (the requests of the sessions a session brought in). */
  compact?: boolean;
  /** For a group whose requests are other sessions': the session each belongs to, named in its row. */
  sessionOf?: (pr: PullRequest) => string | undefined;
  popoverLabel?: string;
}

/** One request: one pill. More than one: the group pill with its popover (PullRequestGroup.tsx). */
export function PullRequestSummary(props: PullRequestSummaryProps) {
  const { value } = props;
  if (value.state === 'ready' && showsGroup(value.value.pullRequests)) return <PullRequestGroup {...props} terms={hostTerms(lookupHost(value))} pullRequests={value.value.pullRequests} />;
  return <SinglePullRequest {...props} />;
}

/** Separate internal navigation, external navigation, and status/action targets. */
function SinglePullRequest({ value, onOpen, sessionId, onRefresh, compact = false, sessionOf }: PullRequestSummaryProps) {
  const merge = useMergeConfirmation(sessionId, onRefresh);
  const pr = value.state === 'ready' ? primaryPullRequest(value.value.pullRequests) : undefined;
  if (!pr) return merge.confirmation;
  const parts = requestParts({ pr, terms: hostTerms(lookupHost(value)), onOpen, onMerge: merge.onMerge });
  return <>
    <span className={`pr-summary pr-tone-${pullRequestStatus(pr).tone}${compact ? ' compact' : ''}`} title={sessionOf?.(pr)}>{parts.number}{parts.external}{parts.status}</span>
    {merge.confirmation}
  </>;
}


const CHECKS = { passing: 'Passing', failing: 'Failed', running: 'Running', none: 'No checks reported' };
const REVIEWS = { approved: 'Approved', 'changes-requested': 'Changes requested', 'review-required': 'Review required', none: 'No review reported' };
const CHECK_TONES = { failing: 'red', passing: 'green', running: 'amber', none: 'muted' };

type NotShown = { state: 'loading' } | { state: 'unavailable'; reason: string } | { state: 'none' };

/** What the page says when it has no pull request to show: still asking, cannot ask, or none linked. */
function Empty({ value, terms }: { value: NotShown; terms: HostTerms }) {
  if (value.state === 'loading') return <p className="pr-empty" role="status">Checking for a linked {terms.long}…</p>;
  if (value.state === 'unavailable') return <div className="pr-empty"><h2>{terms.longTitle}s aren’t available</h2><p>{value.reason}</p></div>;
  return <div className="pr-empty"><h2>No linked {terms.long}</h2><p>When a {terms.long} is opened for this session’s branch, its status will appear here and in the session toolbar.</p></div>;
}

export function PullRequestView({ source, number }: { source: PullRequestSource; number?: number }) {
  const { value, refresh } = source;
  const terms = hostTerms(lookupHost(value));
  const shown = value.state === 'ready' ? value.value.pullRequests.filter(pr => number === undefined || pr.number === number) : [];
  return (
    <div className="pr-page">
      <div className="pr-page-inner">
        <div className="pr-page-top"><span>{terms.longTitle}</span><button className="pr-refresh" onClick={refresh} disabled={value.state === 'loading'}><RefreshCw aria-hidden />Refresh</button></div>
        {value.state !== 'ready' ? <Empty value={value} terms={terms} /> : shown.length === 0 ? <Empty value={{ state: 'none' }} terms={terms} /> : shown.map(pr => {
          const status = pullRequestStatus(pr);
          return <article className="pr-article" key={pr.number}>
            <h1>{pr.title} <span className="pr-title-number">{requestNumber(terms, pr.number)}</span></h1>
            <div className="pr-byline">{pr.author && <span>Opened by {pr.author}</span>}<span className={`pr-state pr-tone-${status.tone}`}>{status.label}</span>{pr.url && <a href={pr.url} target="_blank" rel="noreferrer">Open on {terms.service} <ExternalLink aria-hidden /></a>}</div>
            <dl className="pr-facts">
              <div><dt>Branch</dt><dd><code>{pr.headBranch ?? 'Not reported'}</code>{pr.baseBranch && <> <span className="pr-arrow">→</span> <code>{pr.baseBranch}</code></>}</dd></div>
              <div><dt>Review</dt><dd>{REVIEWS[pr.review]}</dd></div>
              <div><dt>Checks</dt><dd className={`pr-tone-${CHECK_TONES[pr.checks]}`}>{CHECKS[pr.checks]}</dd></div>
              {mergeText(pr) !== null && <div><dt>Merge</dt><dd>{mergeText(pr)}</dd></div>}
            </dl>
            <h2 className="pr-description-heading">Description</h2>
            <div className="prose">{pr.body ? <Markdown text={pr.body} /> : <p className="muted">No description provided.</p>}</div>
          </article>;
        })}
      </div>
    </div>
  );
}
