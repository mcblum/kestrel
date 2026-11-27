// A project page or a group page with the side panes a session has: one line at the top (where
// it is, and the same six pane icons in the same place), then the page beside its panes. A project's
// panes work in its folder; a group has none, so Files and Changes are shown but off, and its
// terminals open in the home folder.
import type { ReactNode } from 'react';
import type { PaneId } from '@kestrel/server/pane-layout';
import { scopeKey, type Scope } from '@kestrel/server/scope';
import { useBrowserTitle } from '../browserStore.ts';
import { PaneArea } from '../components/PaneArea.tsx';
import { PaneToolbar, type PaneButtonExtras } from '../components/PaneToolbar.tsx';
import { usePanes } from '../paneState.ts';

const NO_FOLDER = 'A group has no folder';
const GROUP_TERMINAL = 'A group has no folder, so its terminals open in your home folder.';
const NO_DIRECTORY_TERMINAL = 'This project has no folder yet, so its terminals open in your home folder.';

interface Props {
  scope: Scope & { kind: 'project' | 'group' };
  /** The top line's left side: where this is. */
  bar: ReactNode;
  changes?: ReactNode;
  context: ReactNode;
  children: ReactNode;
  /** A project with no directory yet: its terminals open in the home folder. */
  noDirectory?: boolean;
  /** A project only another computer has: why it has no folder here (awayProjects.ts). Files and Changes are off with it. */
  elsewhere?: string;
}

/** Why the Commands icon does nothing on a project or group page. */
const NO_COMMANDS = 'Commands belong to a session: open one to see what its agent runs';

export function ScopePage({ scope, bar, changes, context, children, noDirectory = false, elsewhere }: Props) {
  const key = scopeKey(scope);
  const panes = usePanes(key);
  const browserTitle = useBrowserTitle(key);
  const group = scope.kind === 'group';
  // No folder here at all: as for a group, Files and Changes are shown but off, saying why.
  const noFolder = group ? NO_FOLDER : (elsewhere ?? null);
  const extras: PaneButtonExtras = {
    disabled: { commands: NO_COMMANDS, ...(noFolder ? { files: noFolder, changes: noFolder } : {}) },
    titles: { browser: browserTitle ? `Browser · ${browserTitle}` : 'Browser', ...(group || noDirectory ? { terminal: 'Terminal · in your home folder' } : {}) },
    labels: { context: group ? 'Group context' : 'Project context' },
  };
  // A group's Files and Changes cannot be turned on, whatever was remembered.
  const toggle = (pane: PaneId) => pane !== 'commands' && !(noFolder && (pane === 'files' || pane === 'changes')) && panes.toggle(pane);
  return (
    <div className="scope-page">
      <header className="session-bar scope-bar">
        {bar}
        <PaneToolbar open={panes.state.open} onToggle={toggle} extras={extras} />
      </header>
      <PaneArea scopeKey={key} state={panes.state} mainLabel={group ? 'Group' : 'Project'} main={children} changes={changes} context={context} terminalNote={group ? GROUP_TERMINAL : elsewhere ? `${elsewhere}, so its terminals open in your home folder.` : noDirectory ? NO_DIRECTORY_TERMINAL : undefined} onClosePane={panes.hide} />
    </div>
  );
}
