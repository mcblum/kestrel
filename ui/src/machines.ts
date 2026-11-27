// Where a session runs, for a row or a page to say (account-sessions.md, section 9.1): the name of the
// computer of the account that runs it, from the workspace's one copy. Null for this computer's own.
import { whereIsMachine } from '@kestrel/server/machines';
import { useApp } from './store.ts';

/** The name of the computer a session runs on, or null when it runs here. */
export function useMachineName(runsOn: string | undefined): string | null {
  return useApp((s) => (runsOn ? whereIsMachine(runsOn, s.workspace?.machines ?? []).name : null));
}
