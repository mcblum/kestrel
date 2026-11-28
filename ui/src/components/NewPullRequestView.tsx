// The New PR tab: a form in the session's main canvas (never a modal or a side panel) for the pull
// request this session's branch would open. Its text lives in the session's document store
// (sessionView.ts), so it survives going to Conversation and to other sessions and back. Cmd+Enter
// sends it. What it asks the server is in newPullRequest.ts. Its words follow the host (`terms`). A
// note says when the request also carries earlier commits from the branch the session started on.
// With uncommitted changes a notice at the top offers to have the agent commit them, and Create
// asks first in the button row's place (UncommittedChanges.tsx).
import { AGENT_LABEL } from '@kestrel/server/model';
import { useApp } from '../store.ts';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { offersReview } from '@kestrel/server/who-does-what';
import { usePresetText } from './controls/usePresetText.ts';
import { REVIEW_CHOICE_LABEL, REVIEW_CHOICES, reviewEndNotice, reviewForRequest, sameAgentNote, type Review, type ReviewChoice } from '@kestrel/server/worktree-guests';
import { reviewSkippedFor, skipReviewFor, startReview, useReview } from '../review.ts';
import { saveWhoDoesWhat, useWhoDoesWhat } from '../whoDoesWhat.ts';
import type { HostTerms } from '@kestrel/server/host-terms';
import { canCreate, inheritedNote, pressCreate, type NewPullRequestDocument } from '@kestrel/server/session-documents';
import { closeSessionDocument, confirmCreateIn, editNewPullRequestIn, leaveConfirmCreateIn } from '../sessionView.ts';
import { createNewPullRequest, takeFocusRequest } from '../newPullRequest.ts';
import { useCommitRequest } from '../commitRequest.ts';
import { ConfirmCreateRow, UncommittedNotice } from './UncommittedChanges.tsx';
import { formAutopilot, useAutopilotSetting } from '../autopilotPrefs.ts';
import { DEFAULT_AUTOPILOT_PREFS, watchLabel } from '@kestrel/server/autopilot';
import type { PullRequestDraft } from '@kestrel/server/session-documents';
import '../styles/pull-request.css';

interface Props {
  sessionId: string;
  doc: NewPullRequestDocument;
  /** The host's words: pull request or merge request. */
  terms: HostTerms;
  /** The branch the pull request is opened from. */
  branch: string;
  /** True only when the worktree certainly has changes that are not committed. */
  uncommitted: boolean;
  /** Asks the pull request lookup again, once it is created. */
  onCreated: () => void;
}

/** What Create does about a review, and what the form says while one runs or once it is over. */
function ReviewRow({ sessionId, review, reviewer, sameAgent, choice, onChoice, onAdd, disabled, problem }: { sessionId: string; review: Review | null; reviewer: string; /** Said when the reviewer runs on the session's own agent. */ sameAgent: string | null; choice: ReviewChoice; onChoice: (next: ReviewChoice) => void; onAdd: () => void; disabled: boolean; problem: string | null }) {
  const id = `${sessionId}-new-pr-review`;
  if (review && review.status !== 'done') {
    return (
      <p className="pr-form-status" role="status">
        <span className="working-pulse" aria-hidden /> {review.reviewer} is {review.status === 'reviewing' ? 'reviewing this work' : 'waiting while the session acts on its findings'} (round {review.round} of {review.rounds}). You will be told in the conversation when it ends; you can still create the pull
        request now.
      </p>
    );
  }
  if (review) {
    return (
      <div className="pr-form-review">
        <p className="form-note">{reviewEndNotice(review)}</p>
        <button type="button" className="quiet-button" disabled={disabled} onClick={onAdd}>Add the review to the description</button>
      </div>
    );
  }
  return (
    <div className="form-field pr-form-review">
      <label htmlFor={id}>Review</label>
      <select id={id} className="form-control" value={choice} disabled={disabled} onChange={(e) => onChoice(e.target.value as ReviewChoice)}>
        {REVIEW_CHOICES.map((c) => <option key={c} value={c}>{REVIEW_CHOICE_LABEL[c]}</option>)}
      </select>
      <p className="form-note">{reviewer} reads this work in this session's worktree, without changing it, and reports what it would fix. Its findings warn; they never stop the pull request.{choice === 'after' ? ' How it ends is posted to the pull request as a comment.' : ''}</p>
      {sameAgent && <p className="form-note">{sameAgent}</p>}
      {problem && <p className="pr-form-error" role="alert">{problem}</p>}
    </div>
  );
}

export function NewPullRequestView({ sessionId, doc, terms, branch, uncommitted, onCreated }: Props) {
  const who = useWhoDoesWhat();
  const describe = usePresetText();
  const { review, reviewer: picked, reason: noReviewer } = useReview(sessionId);
  const agent = useApp((s) => s.sessionsById.get(sessionId)?.agent);
  // The reviewer the server would use: the first one set that did not write this work.
  const reviewPreset = picked;
  // Offered when someone is set to review and the user has not said "Don't ask again", here or everywhere.
  const offered = offersReview(who) && (review !== null || !reviewSkippedFor(sessionId));
  const [choice, setChoice] = useState<ReviewChoice>('before');
  const [reviewProblem, setReviewProblem] = useState<string | null>(null);
  const [startingReview, setStartingReview] = useState(false);
  const asking = offered && review === null && reviewPreset !== null;
  const reviewFirst = asking && choice === 'before';
  const titleField = useRef<HTMLInputElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const commit = useCommitRequest(sessionId);
  const confirming = doc.confirming === true && uncommitted;
  const { form, phase, mode, error } = doc;
  const carried = inheritedNote(doc.inherited);
  const writing = phase === 'preparing' && mode === 'generated';
  const locked = writing || phase === 'creating';
  const ids = (name: string) => `${sessionId}-new-pr-${name}`;
  // Chosen from the menu just now: the title is where typing starts, once the form can be typed in.
  useEffect(() => {
    if (!locked && takeFocusRequest(sessionId)) titleField.current?.focus();
  }, [locked, sessionId, doc.request]);
  const begin = async (comment = false) => {
    setReviewProblem(null);
    setStartingReview(true);
    try {
      await startReview(sessionId, comment);
    } catch (error) {
      setReviewProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setStartingReview(false);
    }
  };
  const create = () => {
    // "Review before opening PR": the review starts and the pull request waits for the user to come back.
    if (reviewFirst) return void begin();
    if (asking && choice === 'skip-session') skipReviewFor(sessionId);
    if (asking && choice === 'never') void saveWhoDoesWhat({ ...who, reviewOffer: false });
    void createNewPullRequest(sessionId, onCreated).then(() => (asking && choice === 'after' ? begin(true) : undefined));
  };
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    // A review first needs no title yet: the pull request is written when the user comes back to it.
    if (reviewFirst) return void begin();
    const press = pressCreate(doc, uncommitted);
    if (press === 'create') create();
    else if (press === 'confirm') confirmCreateIn(sessionId);
  };
  // Back to the normal row: focus returns to Create, where the question was asked from.
  const leaveConfirm = () => {
    leaveConfirmCreateIn(sessionId);
    requestAnimationFrame(() => createButton.current?.focus());
  };
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
    else if (e.key === 'Escape' && confirming) {
      e.preventDefault();
      leaveConfirm();
    }
  };
  return (
    <div className="pr-page">
      <form className="pr-page-inner form-page pr-form" aria-labelledby={ids('heading')} onSubmit={submit} onKeyDown={onKeyDown} noValidate>
        <div className="form-head">
          <h1 id={ids('heading')}>New {terms.long}</h1>
          <p className="form-lede">
            From <code>{branch}</code> into <code>{form.base.trim() || 'the base branch'}</code>.
          </p>
        </div>
        {uncommitted && <UncommittedNotice terms={terms} commit={commit} />}
        {writing && (
          <p className="pr-form-status" role="status">
            <span className="working-pulse" aria-hidden /> Writing a title and description…
          </p>
        )}
        {error && <p className="pr-form-error" role="alert">{error}</p>}
        <fieldset className="pr-form-fields" disabled={locked}>
          <div className="form-field">
            <label htmlFor={ids('title')}>Title</label>
            <input id={ids('title')} ref={titleField} className="form-control" value={form.title} autoComplete="off" onChange={(e) => editNewPullRequestIn(sessionId, { title: e.target.value })} />
          </div>
          <div className="form-field">
            <label htmlFor={ids('body')}>Description</label>
            <textarea id={ids('body')} className="form-control pr-form-body" value={form.body} aria-describedby={ids('body-note')} onChange={(e) => editNewPullRequestIn(sessionId, { body: e.target.value })} />
            <p id={ids('body-note')} className="form-note">Markdown.</p>
          </div>
          <div className="pr-form-branches">
            <div className="form-field">
              <label htmlFor={ids('base')}>Base branch</label>
              <input id={ids('base')} className="form-control" value={form.base} autoComplete="off" spellCheck={false} placeholder={phase === 'preparing' ? 'Looking up the default branch…' : 'main'} onChange={(e) => editNewPullRequestIn(sessionId, { base: e.target.value })} />
            </div>
            <div className="form-field">
              <label htmlFor={ids('head')}>Head branch</label>
              <input id={ids('head')} className="form-control" value={branch} readOnly />
            </div>
          </div>
          <label className="pr-form-check">
            <input type="checkbox" checked={form.draft} onChange={(e) => editNewPullRequestIn(sessionId, { draft: e.target.checked })} />
            Create as draft
          </label>
          <AutopilotChoice sessionId={sessionId} form={form} />
        </fieldset>
        {offered && !reviewPreset && !review && noReviewer && <p className="form-note">No review is offered: {noReviewer}</p>}
        {offered && (reviewPreset || review) && (
          <ReviewRow sessionId={sessionId} review={review} reviewer={reviewPreset ? `${reviewPreset.name} (${describe(reviewPreset)})` : ''} sameAgent={reviewPreset && agent === reviewPreset.agent ? sameAgentNote(`${reviewPreset.name}`, AGENT_LABEL[reviewPreset.agent]) : null} choice={choice} onChoice={setChoice} disabled={locked || startingReview} problem={reviewProblem} onAdd={() => review && editNewPullRequestIn(sessionId, { body: [form.body.trimEnd(), reviewForRequest(review)].filter(Boolean).join('\n\n') })} />
        )}
        <div className="pr-form-notes">
          <p className="form-note">
            Creating pushes <code>{branch}</code> to origin.
          </p>
          {carried && <p className="form-note">{carried}</p>}
        </div>
        {confirming ? (
          <ConfirmCreateRow terms={terms} commit={commit} onCreate={create} onCancel={leaveConfirm} />
        ) : (
          <div className="form-actions">
            <button type="button" className="quiet-button" disabled={phase === 'creating'} onClick={() => closeSessionDocument(sessionId, doc.id)}>
              Cancel
            </button>
            <button ref={createButton} type="submit" className="primary-button" disabled={(!reviewFirst && !canCreate(doc)) || startingReview || phase === 'creating'} aria-busy={phase === 'creating' || startingReview}>
              {phase === 'creating' ? 'Creating…' : startingReview ? 'Starting the review…' : reviewFirst ? 'Start review' : `Create ${terms.long}`}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

/** Autopilot for the new request (pr-autopilot.md): asked here, so no card asks again once it is made. */
function AutopilotChoice({ sessionId, form }: { sessionId: string; form: PullRequestDraft }) {
  const loaded = useAutopilotSetting().value;
  const record = useApp((s) => s.sessionsById.get(sessionId)?.autopilot);
  const choice = formAutopilot(form, loaded.state === 'ready' ? loaded.value : DEFAULT_AUTOPILOT_PREFS, record);
  return (
    <>
      <label className="pr-form-check">
        <input type="checkbox" checked={choice.on} onChange={(e) => editNewPullRequestIn(sessionId, { autopilotOn: e.target.checked })} />
        Autopilot: fix failed checks, conflicts and requested changes on its own
      </label>
      {choice.on && (
        <label className="pr-form-check pr-form-check-under">
          <input type="checkbox" checked={choice.merge} onChange={(e) => editNewPullRequestIn(sessionId, { autopilotMerge: e.target.checked })} />
          Merge it when it is green
        </label>
      )}
      {choice.on && (
        <label className="pr-form-check pr-form-check-under">
          <input type="checkbox" checked={choice.watch} onChange={(e) => editNewPullRequestIn(sessionId, { autopilotWatch: e.target.checked })} />
          {watchLabel(form.base.trim() || null)}
        </label>
      )}
    </>
  );
}
