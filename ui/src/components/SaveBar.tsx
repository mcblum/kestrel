// The Save bar of a settings screen: one for the whole screen, pinned to its bottom edge, saving
// or discarding every draft on it (unsaved.ts). Disabled until something changes (Matt,
// 2026-11-20). A screen whose settings save as they are changed has no drafts, and so no bar. Also
// the warning shown when the user leaves a screen with changes not saved.
import { useLayoutEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { discardDrafts, leave, saveDrafts, useDrafts } from '../unsaved.ts';
import { DialogShell } from './DialogShell.tsx';
import '../styles/save-bar.css';

/** `watch`: what decides which editors are shown (a page's section), so the bar looks again when it changes. */
export function SaveBar({ watch, sticky = false }: { watch?: string; sticky?: boolean }) {
  const { drafts } = useDrafts();
  const [saving, setSaving] = useState(false);
  // Editors in a section that is not shown stay on the page; only the ones in view count.
  const [shown, setShown] = useState(0);
  useLayoutEffect(() => setShown(drafts.filter((d) => d.anchor.current?.offsetParent != null).length), [drafts, watch]);
  if (shown === 0) return null;
  const visible = drafts.filter((d) => d.anchor.current?.offsetParent != null);
  const changed = visible.some((d) => d.changed);
  const problem = visible.find((d) => d.changed && d.problem !== null)?.problem ?? null;
  return (
    <footer className={`save-bar${sticky ? ' sticky' : ''}`} aria-label="Save changes">
      <span className={`save-bar-status${problem ? ' problem' : ''}`} role={problem ? 'alert' : 'status'}>{problem ?? (changed ? 'You have changes that are not saved.' : 'No changes to save.')}</span>
      <button type="button" className="secondary-button" disabled={!changed || saving} onClick={discardDrafts}>Discard</button>
      <button type="button" className="primary-button" disabled={!changed || problem !== null || saving} onClick={async () => {
        setSaving(true);
        try { await saveDrafts(); } finally { setSaving(false); }
      }}>{saving ? 'Saving…' : 'Save changes'}</button>
    </footer>
  );
}

/** Asked once, at the app's root, whenever the user leaves a screen with a changed draft. */
export function UnsavedDialog() {
  const { drafts, leaving } = useDrafts();
  const [busy, setBusy] = useState(false);
  if (!leaving) return null;
  const changed = drafts.filter((d) => d.changed);
  const what = [...new Set(changed.map((d) => d.what))].join(' and ');
  const problem = changed.find((d) => d.problem !== null)?.problem ?? null;
  return (
    <DialogShell icon={<Save size={18} />} eyebrow="Unsaved changes" title={`Save your changes to ${what}?`} busy={busy} onClose={leave.stay}
      actions={
        <>
          <button type="button" className="pr-merge-cancel" disabled={busy} onClick={leave.discard}>Discard</button>
          <button type="button" className="pr-merge-confirm" data-autofocus disabled={busy || problem !== null} onClick={async () => {
            setBusy(true);
            try { await leave.save(); } finally { setBusy(false); }
          }}>{busy ? 'Saving…' : 'Save'}</button>
        </>
      }>
      <p>You changed {what} and have not saved. If you leave now without saving, those changes are lost.</p>
      {problem && <p role="alert">They cannot be saved as they are: {problem}</p>}
    </DialogShell>
  );
}
