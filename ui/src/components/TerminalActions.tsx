// The Terminal pane's Actions button (server: shared/saved-actions.ts): the saved actions of the
// scope's project, each run in a terminal of its own, and a way to the project's Settings to
// change them. Drawn only where there is a project. The menu looks and closes like the app's
// other menus: Escape or a press outside closes it, arrows move.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Play, Settings2 } from 'lucide-react';
import { projectSettings } from '@kestrel/server/routes';
import type { ActionsByProject, SavedAction } from '@kestrel/server/saved-actions';
import { parseScope } from '@kestrel/server/scope';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { openView } from '../route.ts';
import { actions as appActions, useApp } from '../store.ts';
import { terminals } from '../terminalStore.ts';
import { Popup } from './Popup.tsx';

export const SAVED_ACTIONS_PATH = '/api/saved-actions';
export type SavedActionsAnswer = { actions: ActionsByProject };
export const asSavedActions = (raw: unknown): Sourced<ActionsByProject> => ready((raw as SavedActionsAnswer).actions ?? {});
const NONE: readonly SavedAction[] = [];

export function TerminalActions({ scopeKey }: { scopeKey: string }) {
  const scope = parseScope(scopeKey);
  const projectId = useApp((s) => (scope?.kind === 'project' ? scope.id : scope?.kind === 'session' ? (s.sessionsById.get(scope.id)?.startedIn ?? null) : null));
  return projectId ? <ActionsMenu scopeKey={scopeKey} projectId={projectId} /> : null;
}

function ActionsMenu({ scopeKey, projectId }: { scopeKey: string; projectId: string }) {
  const loaded = useResource(SAVED_ACTIONS_PATH, asSavedActions).value;
  const list = loaded.state === 'ready' ? (loaded.value[projectId] ?? NONE) : NONE;
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const count = list.length + 1; // every action, then Edit actions

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    rows.current[focus]?.focus();
    const away = (e: MouseEvent) => !host.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open, focus]);

  const run = (action: SavedAction) => {
    close(false);
    terminals.runAction(scopeKey, action.id, appActions.showError);
  };
  const edit = () => {
    close(false);
    openView(projectSettings(projectId, 'actions'));
  };
  const onKeys = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (step) setFocus((f) => (f + step + count) % count);
    else if (e.key === 'Escape') close(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="picker term-actions" ref={host}>
      <button ref={button} type="button" className="term-tab-new" aria-label="Project actions" title="Run a project action" aria-haspopup="menu" aria-expanded={open} onClick={() => (open ? close(true) : (setFocus(0), setOpen(true)))}>
        <Play aria-hidden />
      </button>
      {open && (
        <Popup anchor={button} side="below" align="end" className="context-menu term-menu-pop" role="menu" aria-label="Project actions" onKeyDown={onKeys}>
          {list.map((action, i) => (
            <button key={action.id} ref={(el) => void (rows.current[i] = el)} type="button" role="menuitem" className="menu-item" tabIndex={focus === i ? 0 : -1} title={action.command} onMouseEnter={() => setFocus(i)} onClick={() => run(action)}>
              <Play aria-hidden />
              <span>{action.name}</span>
            </button>
          ))}
          {list.length > 0 && <div className="menu-sep" role="separator" />}
          <button ref={(el) => void (rows.current[list.length] = el)} type="button" role="menuitem" className="menu-item" tabIndex={focus === list.length ? 0 : -1} onMouseEnter={() => setFocus(list.length)} onClick={edit}>
            <Settings2 aria-hidden />
            <span>{list.length > 0 ? 'Edit actions…' : 'Add an action…'}</span>
          </button>
        </Popup>
      )}
    </div>
  );
}
