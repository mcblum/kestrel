// What the New PR form shows while the session has uncommitted changes: a notice at its top with
// "Commit them", and, when Create is pressed, the question that takes the button row's place (never a
// dialog): "Commit them first", "Create without them", "Cancel". Committing asks the session's
// agent (commitRequest.ts); the words follow the host (@kestrel/server/commit-request).
import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { HostTerms } from '@kestrel/server/host-terms';
import { uncommittedNotice } from '@kestrel/server/commit-request';
import type { CommitRequest } from '../commitRequest.ts';

/** The notice at the top of the form, with the button that asks the agent to commit. */
export function UncommittedNotice({ terms, commit }: { terms: HostTerms; commit: CommitRequest }) {
  return (
    <div className="pr-form-notice" role="status">
      <p>{uncommittedNotice(terms)}</p>
      <CommitButton commit={commit} label="Commit them" />
    </div>
  );
}

/** Asks the agent to commit, the form refreshing when it is done; says why not while the agent works, and that it is waiting once asked. */
function CommitButton({ commit, label, focus, onSent }: { commit: CommitRequest; label: string; focus?: boolean; onSent?: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  return (
    <button ref={ref} type="button" className="secondary-button" disabled={commit.waiting || commit.blocked !== null} title={commit.blocked ?? undefined} aria-busy={commit.waiting}
      onClick={() => {
        commit.send('form');
        onSent?.();
      }}
    >
      {commit.waiting ? 'Committing…' : label}
    </button>
  );
}

interface ConfirmProps {
  terms: HostTerms;
  commit: CommitRequest;
  /** "Create without them": creates now. */
  onCreate: () => void;
  /** Back to the normal button row: Cancel, Escape, and after "Commit them first". */
  onCancel: () => void;
}

/** The button row's place while Create waits for an answer about the uncommitted changes. Escape cancels. */
export function ConfirmCreateRow({ terms, commit, onCreate, onCancel }: ConfirmProps) {
  const first = useRef<HTMLButtonElement>(null);
  // Focus goes to the first button that can take it: "Create without them" while committing cannot be asked.
  const canCommit = !commit.waiting && commit.blocked === null;
  useEffect(() => {
    if (!canCommit) first.current?.focus();
  }, [canCommit]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    onCancel();
  };
  return (
    <div className="form-actions pr-form-confirm" role="group" aria-label="Uncommitted changes" onKeyDown={onKeyDown}>
      <p className="pr-form-confirm-text">{uncommittedNotice(terms)}</p>
      <div className="pr-form-confirm-buttons">
        <CommitButton commit={commit} label="Commit them first" focus={canCommit} onSent={onCancel} />
        <button ref={first} type="button" className="primary-button" onClick={onCreate}>
          Create without them
        </button>
        <button type="button" className="quiet-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
