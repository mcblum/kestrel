// The stack of toasts at the bottom of the window: what Kestrel just did, each with Undo when it
// can be taken back (toasts.ts), and under them the error a refused action left, which stays until
// it is dismissed. ⌘Z (Ctrl+Z) undoes the newest undoable one, unless the cursor is in something
// that is typed into, where it is the text's own undo.
import { useEffect } from 'react';
import { X } from 'lucide-react';
import { actions, useApp } from '../store.ts';
import { toasts, useToasts } from '../toasts.ts';

const typingInto = (target: EventTarget | null): boolean => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.closest('.xterm') !== null);

export function ToastHost() {
  const list = useToasts();
  const error = useApp((s) => s.error);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'z' || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || typingInto(event.target)) return;
      if (toasts.undoLatest()) event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (list.length === 0 && !error) return null;
  return (
    <div className="toast-stack">
      {list.map((toast) => (
        <div key={toast.id} className="toast note" role="status">
          <span className="toast-text" title={toast.message}>{toast.message}</span>
          {toast.undo && (
            <button type="button" className="toast-undo" onClick={() => toasts.undo(toast.id)}>
              Undo
            </button>
          )}
          <button className="icon-button" aria-label="Dismiss" onClick={() => toasts.dismiss(toast.id)}>
            <X />
          </button>
        </div>
      ))}
      {error && (
        <div className="toast" role="alert">
          <span className="toast-text">{error}</span>
          <button className="icon-button" aria-label="Dismiss" onClick={actions.clearError}>
            <X />
          </button>
        </div>
      )}
    </div>
  );
}
