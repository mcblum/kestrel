// A session on another computer of the account opens from the account's copy of its conversation
// (remote-conversation.ts). While that copy is behind what the session's head says, the page reads it again a few
// times, then stops; Try again asks that computer afresh and starts over (account-sessions.md, sections 9 and 19).
import { useEffect, useState } from 'react';
import { actions } from './store.ts';

/**
 * The waits (ms) between reads while the copy is behind: the account's upload catches up a second or so after a turn
 * ends, and an answer from the computer arrives on the live channel. Five tries over about a minute.
 */
export const BEHIND_RETRY_MS = [1_500, 4_000, 8_000, 15_000, 30_000] as const;

/** Reads the conversation again on `BEHIND_RETRY_MS` while `behind`; the answer asks its computer afresh now and starts over. */
export function useBehindRetry(id: string, behind: boolean): () => void {
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!behind) return;
    let at = 0;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      const wait = BEHIND_RETRY_MS[at++];
      if (wait === undefined) return;
      timer = setTimeout(() => {
        actions.loadDetail(id, true);
        next();
      }, wait);
    };
    next();
    return () => clearTimeout(timer);
  }, [id, behind, round]);
  return () => {
    actions.loadDetail(id, true, true);
    setRound((n) => n + 1);
  };
}
