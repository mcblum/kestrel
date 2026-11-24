// The separate targets of one pull or merge request, shared by the single pill (PullRequestView.tsx)
// and each row of the group popover (PullRequestGroup.tsx): the number opens its tab in Kestrel, the
// external icon opens it on the host, and the status part merges it (Merge now opens the
// confirmation), opens its checks, or opens its tab (@kestrel/server/request-group `requestActions`).
// Failed checks open their own pages: one directly, several from a small menu naming each.
import { useState, type MouseEvent, type ReactNode } from 'react';
import { ExternalLink, GitMerge, GitPullRequest } from 'lucide-react';
import { pullRequestStatus, type PullRequest } from '@kestrel/server/details';
import { requestNumber, type HostTerms } from '@kestrel/server/host-terms';
import { failedChecksMenu, requestActions } from '@kestrel/server/request-group';
import { contextMenu } from '../menuState.ts';
import { MergeConfirmation } from './MergeConfirmation.tsx';

export interface RequestPartsProps {
  pr: PullRequest;
  terms: HostTerms;
  onOpen: (pr: PullRequest) => void;
  /** Present where merging is possible (the session is known): opens the confirmation. */
  onMerge?: (pr: PullRequest, label: string) => void;
}

export interface RequestParts {
  number: ReactNode;
  external: ReactNode;
  status: ReactNode;
}

/** Keeps a press inside the pill from reaching a row or tab behind it. */
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

/** The three targets as separate elements, for the caller to lay out. */
export function requestParts({ pr, terms, onOpen, onMerge }: RequestPartsProps): RequestParts {
  const status = pullRequestStatus(pr);
  const number = requestNumber(terms, pr.number);
  const actions = requestActions(pr, !!onMerge);
  const label = <span className="pr-status-label">{status.label}</span>;
  const open = (e: { stopPropagation: () => void }) => { stop(e); onOpen(pr); };
  return {
    number: <button type="button" className="pr-number" title={`Open ${terms.short} ${number} in Kestrel`} onClick={open}><GitPullRequest aria-hidden />{number}</button>,
    external: actions.external && <a className="pr-external" href={actions.external} target="_blank" rel="noreferrer" title={`Open ${number} on ${terms.service}`} aria-label={`Open ${number} on ${terms.service}`} onClick={stop} onAuxClick={stop}><ExternalLink aria-hidden /></a>,
    status: actions.status.kind === 'merge' ? <button type="button" className="pr-status-button pr-merge-now" onClick={e => { stop(e); onMerge?.(pr, number); }} title={`Merge ${number}`}><GitMerge aria-hidden /><span className="pr-status-label">Merge now</span></button>
      : actions.status.kind === 'checks' ? <a className="pr-status-button" href={actions.status.url} target="_blank" rel="noreferrer" title={pr.checks === 'failing' && pr.failedChecks?.length === 1 ? `Open ${pr.failedChecks[0]!.name}` : `Open checks on ${terms.service}`} onClick={stop} onAuxClick={stop}>{label}</a>
      : actions.status.kind === 'failed-checks' ? failedChecksButton(actions.status, terms, label)
      : <button type="button" className="pr-status-button" onClick={open} title={`${pr.title} · ${status.label}`}>{label}</button>,
  };
}

/** "Checks failed" when several did: a menu naming each failed check with its own page. */
function failedChecksButton(action: Extract<ReturnType<typeof requestActions>['status'], { kind: 'failed-checks' }>, terms: HostTerms, label: ReactNode) {
  const press = (e: MouseEvent<HTMLButtonElement>) => {
    stop(e);
    if (contextMenu.current()) return contextMenu.close();
    contextMenu.openFrom(e.currentTarget, failedChecksMenu(action, terms.service), { returnFocus: e.currentTarget });
  };
  return <button type="button" className="pr-status-button" aria-haspopup="menu" title={`${action.checks.length} checks failed: choose one to open`} onClick={press}>{label}</button>;
}

export interface MergeState {
  /** Opens the confirmation; absent when this place cannot merge (no session). */
  onMerge?: (pr: PullRequest, label: string) => void;
  /** The confirmation while it is open, else null. */
  confirmation: ReactNode;
  /** Whether the confirmation is open. */
  open: boolean;
}

/** The Merge now confirmation for one pill or group: which request it is for, and the element to render. */
export function useMergeConfirmation(sessionId: string | undefined, onRefresh: (() => void) | undefined): MergeState {
  const [merging, setMerging] = useState<{ number: number; label: string } | null>(null);
  const confirmation = merging && sessionId ? <MergeConfirmation sessionId={sessionId} number={merging.number} label={merging.label} onClose={() => setMerging(null)} onMerged={() => onRefresh?.()} /> : null;
  return { onMerge: sessionId ? (pr, label) => setMerging({ number: pr.number, label }) : undefined, confirmation, open: confirmation !== null };
}
