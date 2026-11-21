// The menu that opens above the message box while a slash command is being typed: the commands the
// session's agent offers (its own and the user's skills), filtered by what is typed. Picking one
// puts "/name " in the box, ready for what it takes; sending it is an ordinary message, which the
// agent runs as a command. The rules (what counts as typing a command, the order of matches) are
// shared/slash-commands.ts; this draws them and says which one the keys would pick.
import { useEffect, useRef } from 'react';
import type { SlashCommand } from '@kestrel/server/slash-commands';

interface Props {
  commands: readonly SlashCommand[];
  /** The one Enter or Tab would pick. */
  picked: number;
  onPick: (command: SlashCommand) => void;
  onHover: (index: number) => void;
}

export function SlashMenu({ commands, picked, onPick, onHover }: Props) {
  const list = useRef<HTMLDivElement>(null);
  // Braces matter: scrollIntoView may return a promise, and an effect may only return a clean-up.
  useEffect(() => {
    void list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [picked]);
  return (
    <div className="slash-menu" role="listbox" aria-label="Commands" ref={list}>
      {commands.map((command, i) => (
        <button
          key={command.name}
          type="button"
          role="option"
          aria-selected={i === picked}
          className={`slash-row${i === picked ? ' selected' : ''}`}
          title={command.description}
          // The box keeps the focus and the caret: a click must not take them.
          onMouseDown={(event) => event.preventDefault()}
          onMouseMove={() => onHover(i)}
          onClick={() => onPick(command)}
        >
          <code className="slash-name">/{command.name}</code>
          <span className="slash-description">{command.description}</span>
          {/* What it takes, after the description and out of its way: never between the name and what it does. */}
          {command.argumentHint && <span className="slash-hint">{command.argumentHint}</span>}
        </button>
      ))}
    </div>
  );
}
