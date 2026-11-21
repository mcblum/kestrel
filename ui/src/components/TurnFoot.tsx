import { ThinkingMark } from './ThinkingMark.tsx';
// The quiet line under a turn. While the agent works it says so (WorkingFoot); once the turn is
// finished the SAME line, in the same place and the same box, becomes: how long it took, when it finished, and a copy button that
// opens a small menu (Copy text, Copy markdown). Which turns are finished and what their response is
// comes from @kestrel/server/turns; the menu items from @kestrel/server/menu. Every finished turn
// also has Fork: the session menu's own item (`forkItem`) for that turn, so the two are enabled alike
// and the reason a turn cannot be forked from is the server's own (shared/fork.ts `forkRefusal`).
import { memo, useMemo } from 'react';
import { Check, Copy, GitFork } from 'lucide-react';
import { durationText } from '@kestrel/server/turns';
import { finishedText } from '@kestrel/server/when';
import { markdownToText } from '@kestrel/server/markdown-text';
import { copyResponseMenu, forkItem, type MenuItem } from '@kestrel/server/menu';
import type { Agent } from '@kestrel/server/model';
import type { TurnFork } from '@kestrel/server/turns';
import { runMenuAction } from '../commands.ts';
import { contextMenu } from '../menuState.ts';
import { useCopied } from '../copied.ts';

const MENU_GAP = 4;

/** What a turn foot's Fork needs of its session: one object per session while it says the same. */
export interface ForkContext {
  sessionId: string;
  agent: Agent;
  /** A turn is running or waits on the user: no turn can be forked from now. */
  busy: boolean;
}

interface Props {
  /** Names this footer's button for the copied tick. */
  copyKey: string;
  markdown: string;
  startedAt?: number;
  endedAt?: number;
  /** The session, for Fork; absent: no Fork. */
  fork?: ForkContext;
  /** This turn as Fork sees it (the footer's own, kept while it says the same). */
  turn: TurnFork;
}

export const TurnFoot = memo(function TurnFoot({ copyKey, markdown, startedAt, endedAt, fork, turn }: Props) {
  const copied = useCopied(copyKey);
  const item = useMemo(() => (fork ? forkItem(fork.sessionId, fork.agent, fork.busy, turn) : undefined), [fork, turn]);
  const timed = startedAt !== undefined && endedAt !== undefined;
  return (
    <div className="turn-foot">
      {timed && (
        <span className="turn-time" title={new Date(endedAt).toLocaleString()}>
          {durationText(endedAt - startedAt)} · {finishedText(endedAt, Date.now())}
        </span>
      )}
      {markdown && (
        <button
          type="button"
          className="copy-button"
          aria-label="Copy the response"
          title={copied ? 'Copied' : 'Copy the response'}
          aria-haspopup="menu"
          onClick={(event) => {
            contextMenu.openFrom(event.currentTarget, copyResponseMenu({ markdown, text: markdownToText(markdown) }, copyKey), { gap: MENU_GAP });
          }}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        </button>
      )}
      {item && <ForkButton item={item} latest={turn.latest} />}
    </div>
  );
});

const FORK_TIP = 'Fork: a new session that carries on from here';
const FORK_EARLIER_TIP = 'Fork: a new session whose conversation ends with this turn (the files are as they are now)';

/** Fork, as quiet as Copy. Disabled with the menu item's reason as its tooltip. */
function ForkButton({ item, latest }: { item: MenuItem; latest: boolean }) {
  const action = item.action;
  return (
    <button
      type="button"
      className="copy-button"
      aria-label={item.disabled ? `Fork (${item.hint})` : 'Fork from here'}
      title={item.disabled ? item.hint : latest ? FORK_TIP : FORK_EARLIER_TIP}
      disabled={item.disabled}
      onClick={() => action && void runMenuAction(action)}
    >
      <GitFork aria-hidden />
    </button>
  );
}

/**
 * The same line while the turn is still running. It stays for the whole turn and only its words
 * change, so nothing above or below it moves; when the turn ends TurnFoot takes its place exactly.
 */
export const WorkingFoot = memo(function WorkingFoot({ text }: { text: string }) {
  return (
    <div className="turn-foot turn-working" role="status" aria-live="polite">
      <ThinkingMark status={text} /> {text}
    </div>
  );
});
