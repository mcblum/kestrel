// Typing a slash command in a message box: the menu of what the agent offers, filtered by the name
// typed so far, and the keys it takes while it is open. Shared by the running session's box
// (Conversation.tsx) and the new-session box (NewSessionTab.tsx), so the two behave as one. The
// rules (what counts as typing a command, the order of matches) are shared/slash-commands.ts.
import { useMemo, useState, type ReactNode } from 'react';
import { matchSlashCommands, slashCompletion, slashQuery, type SlashCommand } from '@kestrel/server/slash-commands';
import { SlashMenu } from './SlashMenu.tsx';

const NO_COMMANDS: readonly SlashCommand[] = [];

interface SlashMenuState {
  /** The menu, or null while it is shut. Goes inside the box (`.composer-box`), above the input. */
  menu: ReactNode;
  /** Give it a key press; true when the open menu took it (the caller then does nothing else with it). */
  onKey: (event: { key: string; shiftKey: boolean }) => boolean;
  /** The text changed: the first match is the picked one again. */
  onText: () => void;
}

/**
 * `commands` absent or empty: no menu. `blocked`: the box cannot be typed in. `onPick` gets the text
 * the box should hold after a command is picked ("/name ") and puts the focus back in the box.
 * Escape closes the menu for the text as it stands; typing on opens it again.
 */
export function useSlashMenu(text: string, commands: readonly SlashCommand[] | undefined, blocked: boolean, onPick: (text: string) => void): SlashMenuState {
  const [picked, setPicked] = useState(0);
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const typed = slashQuery(text);
  const matches = useMemo(() => (typed === null || !commands?.length ? NO_COMMANDS : matchSlashCommands(commands, typed)), [typed, commands]);
  const open = matches.length > 0 && closedFor !== text && !blocked;
  const at = Math.min(picked, matches.length - 1);
  const pick = (command: SlashCommand) => {
    onPick(slashCompletion(command));
    setPicked(0);
  };
  const onKey = (event: { key: string; shiftKey: boolean }): boolean => {
    if (!open) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') setPicked((at + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
    else if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') pick(matches[at]!);
    else if (event.key === 'Escape') setClosedFor(text);
    else return false;
    return true;
  };
  return { menu: open ? <SlashMenu commands={matches} picked={at} onPick={pick} onHover={setPicked} /> : null, onKey, onText: () => setPicked(0) };
}
