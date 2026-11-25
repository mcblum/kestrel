// The open requests of the sessions a session brought in (@kestrel/server/brought-in-requests).
//   - `BroughtInPill`: the request pill itself (PullRequestView.tsx), at its compact size: with several,
//     the "3 PRs" group pill with its coloured strip and popover, each row naming its session; with one,
//     the single pill for that request. A request's number opens it in its own session; nothing merges
//     from here. On the workstream's page. (In a session's header the summary is the workstream chip:
//     FamilyChip.tsx.)
//   - `BroughtInMark`: on the workstream's top row in the sidebar, where the row is the button: the
//     request icon and how many, in a small pill (Matt, 2026-11-24: "no need to say PRs"). Its tooltip and
//     accessible name say it in full. Red with the request mark's cross when one needs the user.
import { useCallback, useMemo } from 'react';
import { GitPullRequest, X } from 'lucide-react';
import { broughtInDescription, type BroughtInRequests } from '@kestrel/server/brought-in-requests';
import type { PullRequest, PullRequestLookup } from '@kestrel/server/details';
import { hostTerms } from '@kestrel/server/host-terms';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { openSession } from '../route.ts';
import { openPullRequest } from '../sessionView.ts';
import { PullRequestSummary } from './PullRequestView.tsx';
import '../styles/brought-in.css';

export function BroughtInPill({ rollup }: { rollup: BroughtInRequests }) {
  // Each request's own session, by the request object the pill hands back.
  const owner = useMemo(() => new Map(rollup.requests.map((r) => [r.pr, r])), [rollup]);
  const value = useMemo((): Sourced<PullRequestLookup> => ready({ host: rollup.host, pullRequests: rollup.requests.map((r) => r.pr) }), [rollup]);
  const onOpen = useCallback((pr: PullRequest) => {
    const r = owner.get(pr);
    if (!r) return;
    openPullRequest(r.sessionId, pr);
    openSession(r.sessionId);
  }, [owner]);
  const sessionOf = useCallback((pr: PullRequest) => owner.get(pr)?.sessionTitle, [owner]);
  return <PullRequestSummary compact value={value} onOpen={onOpen} sessionOf={sessionOf} popoverLabel={`${hostTerms(rollup.host).longTitle}s of the sessions it brought in`} />;
}

export function BroughtInMark({ rollup, description = broughtInDescription(rollup) }: { rollup: BroughtInRequests; description?: string }) {
  const alert = rollup.needsYou > 0;
  return (
    <span className="brought-in-mark" role="img" aria-label={description} title={description}>
      <span className={`brought-in-face${alert ? ' pr-tone-red' : ''}`}>
        <span className="brought-in-icon" aria-hidden>
          <GitPullRequest />
          {alert && <X className="brought-in-alert" />}
        </span>
        {rollup.requests.length}
      </span>
    </span>
  );
}
