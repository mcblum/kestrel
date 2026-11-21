// Create project's two ways in, as local tabs under its heading (the look of a project page's
// Sessions and Settings): one project with the folders you give it, or several at once from one
// parent folder. Switching changes the path of the workspace tab in front, never opens another.
import { useRef, type KeyboardEvent } from 'react';
import { tabForKey } from '@kestrel/server/local-tabs';
import { showLocal } from '../route.ts';

export type CreateWay = 'one' | 'folder';

const WAYS: readonly CreateWay[] = ['one', 'folder'];
const LABEL: Record<CreateWay, string> = { one: 'One project', folder: 'Several from a folder' };
export const createTabId = (way: CreateWay) => `create-project-${way}-tab`;
export const createPanelId = (way: CreateWay) => `create-project-${way}-panel`;

export function CreateProjectTabs({ way }: { way: CreateWay }) {
  const list = useRef<HTMLDivElement>(null);
  const go = (next: CreateWay, focus = false) => {
    if (next !== way) showLocal(next === 'folder' ? { kind: 'new-project', from: 'folder' } : { kind: 'new-project' });
    if (focus) list.current?.querySelector<HTMLElement>(`#${createTabId(next)}`)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const next = tabForKey(WAYS, way, event.key);
    if (!next) return;
    event.preventDefault();
    go(next, true);
  };
  return (
    <div className="local-tabs create-tabs" role="tablist" aria-label="Create project" ref={list} onKeyDown={onKeyDown}>
      {WAYS.map((w) => (
        <button key={w} type="button" role="tab" id={createTabId(w)} aria-selected={w === way} aria-controls={createPanelId(w)} tabIndex={w === way ? 0 : -1} className={`local-tab${w === way ? ' selected' : ''}`} onClick={() => go(w)}>
          {LABEL[w]}
        </button>
      ))}
    </div>
  );
}
