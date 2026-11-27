// The page of a session that runs on another computer of the account (account-sessions.md, sections 9 and 19).
// Its conversation is the account's copy, read here at once; while a turn runs there its machine's live output
// arrives on the session's own live channel and is laid over it, and so does what that machine answers when the
// copy was behind (remote-conversation.ts). It has the message box a session here has (`Composer`), less what cannot
// be asked of that machine yet: no model, effort or mode (issue 52), no panes, files, terminal or pull-request
// creation. Replying, answering a card, Stop, Compact and Autopilot call the same routes a session here calls, which
// the server carries out there (remote-actions.ts); a refusal there, or that machine not being reached, shows in the
// toast stack as any refusal does, and the typed message stays in the box.
//
// It is laid out as a session here is, through the same hook (conversationFollow.ts): it opens at the end of its
// conversation, stays there while a turn streams, lets the reader scroll up, and the box floats over the foot of the
// conversation on the conversation's own background.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Monitor } from 'lucide-react';
import { notAnsweredText } from '@kestrel/server/machines';
import { AGENT_LABEL, projectName, statusText, UNSCOPED } from '../labels.ts';
import { useMachineName } from '../machines.ts';
import { useFollowEnd } from '../conversationFollow.ts';
import { actions, mergeMessages, useApp, type AttachmentRefs } from '../store.ts';
import { Composer, waitsOnCard, type Inject } from './Conversation.tsx';
import { AutopilotControl } from './controls/AutopilotControl.tsx';
import { FilesElsewhere } from './HeldElsewhere.tsx';
import { MessageList } from './MessageList.tsx';
import { ToBottom } from './ToBottom.tsx';
import '../styles/machines.css';

/**
 * While the copy is behind what the session's head says, the page reads it again after these waits (ms), then stops:
 * the account's upload catches up a second or so after a turn ends, and an answer from the machine arrives on the live
 * channel. Five tries over about a minute; Try again starts them over.
 */
export const BEHIND_RETRY_MS = [1_500, 4_000, 8_000, 15_000, 30_000] as const;

/** Under the message box: where the model and mode are changed, Autopilot, and Compact. */
function RemoteControls({ id, machine, running }: { id: string; machine: string; running: boolean }) {
  return (
    <span className="ctl-set">
      <span className="ctl-note">Model and mode are changed on {machine}</span>
      <span className="ctl-right">
        <AutopilotControl sessionId={id} />
        <span className="ctl">
          <button type="button" className="ctl-button" disabled={running} title={running ? 'The agent is working. Compact once it has finished.' : `Compact the conversation, on ${machine}`} onClick={() => void actions.compact(id)}>
            Compact
          </button>
        </span>
      </span>
    </span>
  );
}

/** Reads the conversation again on `BEHIND_RETRY_MS` while `behind`; `tryAgain` asks its machine afresh now and starts over. */
function useBehindRetry(id: string, behind: boolean): () => void {
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

export function RemoteSession({ id }: { id: string }) {
  const session = useApp((s) => s.sessionsById.get(id));
  const stored = useApp((s) => s.details.get(id));
  const liveMessages = useApp((s) => s.live.get(id)?.messages);
  const liveStatus = useApp((s) => s.live.get(id)?.status);
  const projects = useApp((s) => s.workspace?.projects) ?? [];
  const machine = useMachineName(session?.runsOn) ?? 'another computer';
  useEffect(() => {
    if (session) actions.loadDetail(id);
  }, [id, session, stored]);
  // Its machine's live output while a turn runs there, and what it answers when the copy was behind.
  useEffect(() => actions.watch(id), [id]);
  // The last copy stays on the page while a newer one is read, so the conversation never blinks.
  const last = useRef(stored);
  if (stored) last.current = stored;
  const fetched = stored ?? last.current;
  // What streamed since it was read replaces the same message, or follows it.
  const detail = useMemo(() => (fetched && liveMessages?.length ? { ...fetched, messages: mergeMessages(fetched.messages, liveMessages) } : fetched), [fetched, liveMessages]);
  const behind = detail?.remote?.current === false;
  const tryAgain = useBehindRetry(id, behind);
  const { bodyRef, setInner, setDock, composerHeight, isFollowing, away, toBottom, onScroll, initialTop } = useFollowEnd(id, detail?.messages.length ?? 0);
  const [inject, setInject] = useState<Inject | null>(null);
  // Messages are memoized, so they get callbacks that never change and call the latest handlers (as a session here's do).
  const handlers = useRef({ choose: (_: string) => {}, reply: (_: string) => {}, reuse: (_: string) => {} });
  const [stable] = useState(() => ({ choose: (text: string) => handlers.current.choose(text), reply: (text: string) => handlers.current.reply(text), reuse: (text: string) => handlers.current.reuse(text) }));
  if (!session) return <div className="muted">This session is no longer on your account.</div>;

  const running = session.state === 'running';
  const waiting = waitsOnCard(session.state, detail?.messages);
  const workingText = liveStatus || 'Working…';
  // No model or mode rides on it: those are changed on the machine it runs on.
  const send = async (text: string, files: AttachmentRefs | null = null) => {
    toBottom();
    const sent = await actions.reply(id, text, {}, files);
    requestAnimationFrame(toBottom);
    return sent;
  };
  handlers.current = {
    choose: (choice) => setInject({ id, text: `${choice}.`, n: Date.now() }),
    // A reply picked in the conversation goes now; while the agent is busy it waits in the box instead.
    reply: (text) => (running || waiting ? setInject({ id, text, n: Date.now() }) : void send(text)),
    reuse: (text) => setInject({ id, text, n: Date.now() }),
  };
  const project = projectName(session, projects);
  return (
    <section className="session-workspace focus-conversation remote-session" data-session-id={id}>
      <header className="session-bar session-head">
        <div className="bar-line bar-line-title">
          <span className="remote-title" title={session.title}>{session.title}</span>
        </div>
        <div className="bar-line bar-line-where">
          <span className="bar-item"><Monitor aria-hidden />Runs on {machine}</span>
          {project !== UNSCOPED && <span className="bar-item bar-project">{project}</span>}
          <span className="bar-item">{AGENT_LABEL[session.agent]} · {statusText(session)}</span>
        </div>
      </header>
      {/* Only when it is true and matters: the copy is behind and its machine was asked and did not answer. */}
      {detail?.remote && behind && !detail.remote.reachable && (
        <div className="remote-as-of" role="status">
          <span>{notAnsweredText(machine, detail.remote.asOf)}</span>
          <button type="button" className="secondary-button small" onClick={tryAgain}>
            Try again
          </button>
        </div>
      )}
      <FilesElsewhere.Provider value={machine}>
        <div className="conversation" role="region" aria-label="Conversation">
          <div className="conversation-body" ref={bodyRef} onScroll={onScroll}>
            <div className="conversation-inner" ref={setInner} style={{ paddingBottom: composerHeight + 96 }}>
              {!detail ? (
                <div className="muted">Loading conversation…</div>
              ) : detail.messages.length === 0 ? (
                <div className="muted">{behind ? `This computer has no copy of the conversation yet. It is read from Kestrel Connect when this computer is connected.` : 'No messages yet.'}</div>
              ) : (
                <MessageList key={id} messages={detail.messages} sessionId={id} scrollRef={bodyRef} isFollowing={isFollowing} initialTop={initialTop} head={null} onChoice={stable.choose} onReply={stable.reply} onReuse={stable.reuse} anchorAt={-1} anchored={null} working={running} workingText={workingText} />
              )}
            </div>
          </div>
          <ToBottom away={away} running={running} workingText={workingText} composerHeight={composerHeight} onClick={toBottom} />
          <div className="composer-dock" ref={setDock}>
            <Composer key={id} draftKey={id} running={running} waiting={waiting} interrupted={session.state === 'interrupted'} inject={inject} onStop={() => void actions.stop(id)} onSend={send} controls={<RemoteControls id={id} machine={machine} running={running} />} />
          </div>
        </div>
      </FilesElsewhere.Provider>
    </section>
  );
}
