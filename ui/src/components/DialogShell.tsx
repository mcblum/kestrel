// The confirmation dialog Kestrel draws for a decision that needs more than a click: an emblem, an
// eyebrow and a title, a body, and Cancel beside the dialog's own actions. Drawn like the pull
// request merge confirmation (MergeConfirmation.tsx); used by Remove worktree and the New session
// box's "Where should this session start?".
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { createPortal } from 'react-dom';

export interface DialogShellProps {
  icon: ReactNode;
  eyebrow: string;
  title: string;
  busy: boolean;
  danger?: boolean;
  onClose: () => void;
  children: ReactNode;
  actions: ReactNode;
}

export function DialogShell({ icon, eyebrow, title, busy, danger, onClose, children, actions }: DialogShellProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    dialog.current?.showModal();
    // An action marked data-autofocus takes the focus, so Enter does it; else the dialog's own choice.
    dialog.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, []);
  return createPortal(
    <dialog ref={dialog} className={`kestrel pr-merge-dialog${danger ? ' worktree-danger' : ''}`} aria-labelledby={titleId} onClick={(e) => e.stopPropagation()} onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
      <header className="pr-merge-header">
        <span className="pr-merge-emblem">{icon}</span>
        <div>
          <span className="pr-merge-eyebrow">{eyebrow}</span>
          <h2 id={titleId}>{title}</h2>
        </div>
        <button type="button" className="pr-merge-close" aria-label="Close confirmation" disabled={busy} onClick={onClose}><X size={18} /></button>
      </header>
      <div className="pr-merge-body">{children}</div>
      <footer className="pr-merge-actions">
        <button type="button" className="pr-merge-cancel" disabled={busy} onClick={onClose}>Cancel</button>
        {actions}
      </footer>
    </dialog>,
    document.body,
  );
}
