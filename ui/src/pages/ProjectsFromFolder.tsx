// Create project's second way in: several projects from one parent folder (docs/designs/kestrel.md,
// "Several projects from one folder"). Choose the folder (the native chooser in the Mac app, a typed
// path in a browser: the same control as one project's folders), see the folders directly inside it,
// tick some, and add them in one request. The git repositories that are not projects yet start
// ticked. Each folder succeeds or fails on its own: when all are added the page goes to the
// Overview; otherwise it stays, says what was added, and leaves the failed ones ticked (those that
// can still be added) with their reasons. The listing is the answer to "look in this folder", held by this page (CLAUDE.md, "One
// copy of everything": an action's answer may stay with what asked); it is asked again after a batch.
import { useState } from 'react';
import { addLabel, allSelectable, canAdd, batchSummary, defaultSelection, failedPaths, PROJECT_BATCH_LIMITS, toggled, type BatchOutcome, type FolderListing } from '@kestrel/server/folder-batch';
import { tildePath } from '@kestrel/server/project-search';
import { AddFolderInput } from '../components/AddFolderInput.tsx';
import { FolderPickList } from '../components/FolderPickList.tsx';
import { createProjects, listFolder } from '../projectActions.ts';
import { leaveCreateProject, leaveToOverview } from '../projectNav.ts';

type Result = { summary: string; errors: Record<string, string> };
const NO_RESULT: Result = { summary: '', errors: {} };

/** The reasons of the folders a batch did not add, by path. */
const errorsOf = (outcomes: readonly BatchOutcome[]): Record<string, string> => Object.fromEntries(outcomes.flatMap((o) => (o.ok ? [] : [[o.path, o.error]])));

function ListingHead({ listing, onAll, onNone, busy }: { listing: FolderListing; onAll: () => void; onNone: () => void; busy: boolean }) {
  const count = listing.folders.length;
  return (
    <div className="pick-head">
      <span className="form-note pick-where">
        {count === 0 ? 'No folders in ' : `${count} folder${count === 1 ? '' : 's'} in `}
        <span title={listing.parent}>{tildePath(listing.parent)}</span>
      </span>
      {count > 0 && (
        <span className="pick-all">
          <button type="button" className="quiet-button" disabled={busy} onClick={onAll}>
            All
          </button>
          <button type="button" className="quiet-button" disabled={busy} onClick={onNone}>
            None
          </button>
        </span>
      )}
    </div>
  );
}

/** Folders the last batch could not add that are no longer in the folder (moved or deleted meanwhile): their reasons, here. */
function GoneFolders({ errors, listing }: { errors: Readonly<Record<string, string>>; listing: FolderListing }) {
  const gone = Object.entries(errors).filter(([path]) => !listing.folders.some((f) => f.path === path));
  if (gone.length === 0) return null;
  return (
    <div className="pick-gone">
      {gone.map(([path, error]) => (
        <p key={path} className="field-error" role="alert">
          {error}
        </p>
      ))}
    </div>
  );
}

export function ProjectsFromFolder({ onCreated = leaveToOverview, onCancel = leaveCreateProject, onBusyChange }: { onCreated?: () => void; onCancel?: () => void; onBusyChange?: (busy: boolean) => void } = {}) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [result, setResult] = useState<Result>(NO_RESULT);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const tooMany = selected.length > PROJECT_BATCH_LIMITS.maxPerBatch;

  const look = async (path: string): Promise<string | null> => {
    const answer = await listFolder(path);
    if (!answer.ok) return answer.error;
    setListing(answer.value);
    setSelected(defaultSelection(answer.value.folders));
    setResult(NO_RESULT);
    setFormError(null);
    return null;
  };

  const add = async () => {
    if (busy || !listing || selected.length === 0 || tooMany) return;
    setBusy(true);
    onBusyChange?.(true);
    setFormError(null);
    const answer = await createProjects(selected);
    if (!answer.ok) return (setBusy(false), onBusyChange?.(false), setFormError(answer.error));
    const failed = failedPaths(answer.value);
    if (failed.length === 0) return (setBusy(false), onBusyChange?.(false), onCreated());
    // Some were not added: show the folder again as it now is, the failed ones still listed ticked.
    const again = await listFolder(listing.parent);
    const shown = again.ok ? again.value : listing;
    setListing(shown);
    setSelected(failed.filter((path) => shown.folders.some((f) => f.path === path && canAdd(f))));
    setResult({ summary: batchSummary(answer.value), errors: errorsOf(answer.value) });
    setBusy(false);
    onBusyChange?.(false);
  };

  return (
    <>
      <div className="form-field">
        <span className="form-label">Folder of projects</span>
        <p className="form-note">Choose the folder that holds your projects, such as ~/Code. Its folders are listed; nothing deeper.</p>
        <AddFolderInput onAdd={look} busy={busy} submitLabel="Show folders" placeholder="Full path, e.g. ~/Code" />
      </div>
      {listing && (
        <div className="form-field">
          <ListingHead listing={listing} busy={busy} onAll={() => setSelected(allSelectable(listing.folders))} onNone={() => setSelected([])} />
          <FolderPickList folders={listing.folders} selected={selected} errors={result.errors} busy={busy} onToggle={(path) => setSelected((s) => toggled(listing.folders, s, path))} />
          {listing.truncated && <p className="form-note">Showing the first {listing.folders.length} of {listing.total} folders, by name.</p>}
        </div>
      )}
      {result.summary && <p className="form-note pick-summary" role="status">{result.summary}</p>}
      {listing && <GoneFolders errors={result.errors} listing={listing} />}
      {tooMany && <p className="field-error" role="alert">At most {PROJECT_BATCH_LIMITS.maxPerBatch} projects can be added at once. Untick some, add them, then add the rest.</p>}
      {formError && <p className="field-error" role="alert">{formError}</p>}
      <div className="form-actions">
        <button type="button" className="quiet-button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="primary-button" disabled={busy || selected.length === 0 || tooMany} aria-busy={busy} onClick={() => void add()}>
          {busy ? 'Adding…' : addLabel(selected.length)}
        </button>
      </div>
    </>
  );
}
