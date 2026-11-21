// The sidebar's in-place rename box, for a session or project row.
import type { KeyboardEvent } from 'react';
import { actions } from '../store.ts';

/**
 * A name edited in place, in its own row. Enter or leaving the box keeps it; Escape puts it back.
 * It is a span, not a nested button, and keeps clicks and keys to itself so the row does not act.
 */
export function RenameInput({ label, value, onDone }: { label: string; value: string; onDone: (name: string) => void }) {
  const finish = (name: string | null) => {
    actions.startRename(null);
    const trimmed = name?.trim();
    if (trimmed) onDone(trimmed);
  };
  return (
    <input
      className="inline-input"
      defaultValue={value}
      autoFocus
      aria-label={label}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        e.stopPropagation();
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.currentTarget.value = value;
          e.currentTarget.blur();
        }
      }}
    />
  );
}
