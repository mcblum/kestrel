// What a start asked by another device of the account starts with (A8; kestrel-connect.md, "Actions"):
// the choices this computer's own button would send, never Bypass. Pure.
import type { Agent } from '../model.ts';
import { remoteStartPermission, type PermissionLevel } from '../shared/permissions.ts';
import { startControls, storedRemembered } from '../shared/sticky-controls.ts';

export interface DeskChoices {
  agent: Agent;
  model?: string;
  effort?: string;
  fast?: true;
  permission: PermissionLevel;
}

/**
 * Work this ticket's choices, as the window's Start work button sends them (`ui/src/tickets.ts`): the New
 * session box's remembered agent, model, effort, fast mode and mode, read from the stored UI state.
 */
export function deskLeadChoices(uiState: string | null): DeskChoices {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = uiState ? JSON.parse(uiState) : {};
    if (typeof parsed === 'object' && parsed !== null) stored = parsed as Record<string, unknown>;
  } catch {
    // Unreadable: what a new session starts with by default.
  }
  const c = startControls(storedRemembered(stored));
  return { agent: c.agent, ...(c.model ? { model: c.model } : {}), ...(c.effort ? { effort: c.effort } : {}), ...(c.fast ? { fast: true as const } : {}), permission: remoteStartPermission(c.permission) };
}
