// The side-pane icons at the right of a page's top line: the same six on a session, a project page
// and a group page, in the order their columns stand (Context first, nearest the main content).
// Each turns its own pane on and off; one that is on has a filled background.
// One that cannot work here stays visible, dimmed, and says why in its tooltip.
import { Activity, FileDiff, FolderTree, Globe, Info, Smartphone, SquareTerminal, type LucideIcon } from 'lucide-react';
import type { OpenPanes, PaneId } from '@kestrel/server/pane-layout';

/** The Changes pane's icon; a sidebar row's changed-files icon is the same one (RowIcons.tsx). */
export const CHANGES_ICON: LucideIcon = FileDiff;

export const PANE_BUTTONS: readonly { id: PaneId; label: string; icon: LucideIcon }[] = [
  { id: 'context', label: 'Context', icon: Info },
  { id: 'changes', label: 'Changes', icon: CHANGES_ICON },
  { id: 'files', label: 'Files', icon: FolderTree },
  { id: 'commands', label: 'Commands', icon: Activity },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { id: 'browser', label: 'Browser', icon: Globe },
  { id: 'simulator', label: 'Simulator', icon: Smartphone },
];

export interface PaneButtonExtras {
  /** A pane that cannot work here, with the reason (its tooltip). */
  disabled?: Partial<Record<PaneId, string>>;
  /** Tooltip text in place of the label. */
  titles?: Partial<Record<PaneId, string>>;
  /** A small number beside the icon (Changes: how many files; Commands: how many are running). */
  counts?: Partial<Record<PaneId, number>>;
  /** What the number counts, for the spoken label ("2 running"). Changes says files by default. */
  countLabels?: Partial<Record<PaneId, string>>;
  /** Spoken label in place of the default (Context says whose). */
  labels?: Partial<Record<PaneId, string>>;
  /** Amber: something here wants the user (Changes: uncommitted files). */
  attention?: Partial<Record<PaneId, boolean>>;
}

/** `onBlocked`: a press on a pane that cannot work here says why (a session on another computer: "The terminal is on Mac mini."). */
export function PaneToolbar({ open, onToggle, extras = {}, onBlocked }: { open: OpenPanes; onToggle: (pane: PaneId) => void; extras?: PaneButtonExtras; onBlocked?: (reason: string) => void }) {
  return (
    <div className="pane-icons" role="toolbar" aria-label="Side panes">
      {PANE_BUTTONS.map(({ id, label: fallback, icon: Icon }) => {
        const label = extras.labels?.[id] ?? fallback;
        const blocked = extras.disabled?.[id];
        const count = extras.counts?.[id] ?? 0;
        return (
          <button
            key={id}
            type="button"
            className={`bar-button${extras.attention?.[id] && !blocked ? ' has-changes' : ''}`}
            aria-pressed={!blocked && open[id]}
            aria-disabled={blocked ? true : undefined}
            aria-label={count > 0 ? `${label}, ${extras.countLabels?.[id] ?? `${count} changed ${count === 1 ? 'file' : 'files'}`}` : label}
            title={blocked ?? extras.titles?.[id] ?? label}
            onClick={() => (blocked ? onBlocked?.(blocked) : onToggle(id))}
          >
            <Icon aria-hidden />
            {!blocked && count > 0 && <span className="bar-count">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}
