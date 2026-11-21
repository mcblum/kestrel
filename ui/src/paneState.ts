// Which side panes each scope (a session, a project page, a group page) has open, kept for the
// life of the page: a tab shows one scope after another, and coming back finds them as they were.
// Nothing is open until an icon is pressed.
import { useState } from 'react';
import { NO_PANES, togglePane, type OpenPanes, type PaneId } from '@kestrel/server/pane-layout';

export interface PaneState {
  open: OpenPanes;
  /** The sub-agent whose output is shown (sessions only), when `open.agent`. */
  agentId: string | null;
  /** The command the Commands pane shows (sessions only); null: the newest. */
  commandId: string | null;
}

const NOTHING: PaneState = { open: NO_PANES, agentId: null, commandId: null };
const memory = new Map<string, PaneState>();

export interface Panes {
  state: PaneState;
  toggle(pane: PaneId): void;
  /** Turn a pane on (the agent opened a page or used the simulator). */
  show(pane: PaneId): void;
  /** Turn a pane off (its X, or the floating card dismissed). */
  hide(pane: PaneId): void;
  /** Show a sub-agent's output; the same one again closes it. */
  toggleAgent(agentId: string): void;
  closeAgent(): void;
  /** Open the Commands pane on one command (a row of the background strip), or pick one in it. */
  showCommand(commandId: string): void;
}

export function usePanes(scopeKey: string): Panes {
  const [state, setState] = useState<PaneState>(() => memory.get(scopeKey) ?? NOTHING);
  const set = (next: PaneState) => {
    memory.set(scopeKey, next);
    setState(next);
  };
  return {
    state,
    toggle: (pane) => set({ ...state, open: togglePane(state.open, pane) }),
    hide: (pane) => state.open[pane] && set({ ...state, open: { ...state.open, [pane]: false } }),
    show: (pane) => !state.open[pane] && set({ ...state, open: { ...state.open, [pane]: true } }),
    toggleAgent: (agentId) => set(state.open.agent && state.agentId === agentId ? { ...state, open: { ...state.open, agent: false }, agentId: null } : { ...state, open: { ...state.open, agent: true }, agentId }),
    closeAgent: () => set({ ...state, open: { ...state.open, agent: false }, agentId: null }),
    showCommand: (commandId) => set({ ...state, open: { ...state.open, commands: true }, commandId }),
  };
}
