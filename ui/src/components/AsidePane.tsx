// A sidebar, in the tools column beside the conversation it started from (server: shared/asides.ts).
// That conversation stays in sight and carries on unchanged: nothing here answers or changes it.
// Until something is asked, the pane says what to ask, in Matt's words, with what it is about in a
// line. When the session has more than one sidebar, the head lists them to switch between. "Use in the conversation" puts the sidebar's last answer into the main message
// box, after what is there, and never sends it. Closing the pane keeps the sidebar: the finding's
// control opens it again.
import { useEffect, useMemo, useRef } from 'react';
import { CornerDownLeft, MessagesSquare, X } from 'lucide-react';
import { ASIDE_NAME, ASIDE_WORD, asideConclusion, asidePlaceholder, asideTitle } from '@kestrel/server/asides';
import type { Session } from '@kestrel/server/model';
import type { ChatMessage } from '@kestrel/server/model';
import { actions, useApp, type AttachmentRefs } from '../store.ts';
import { Composer, Message } from './Conversation.tsx';
import { ThinkingMark } from './ThinkingMark.tsx';

const NO_MESSAGES: readonly ChatMessage[] = [];
const ignore = () => {};

/** What the agent said last, when it is done saying it: what can go back to the conversation. */
function lastAnswer(messages: readonly ChatMessage[]): string {
  const last = messages.findLast((m) => m.author === 'agent' && !m.notice && m.text.trim());
  return last && !last.streaming ? last.text : '';
}

const NO_SESSIONS: readonly Session[] = [];

export function AsidePane({ asideId, onUse, onShow, onClose }: { asideId: string | null; onUse: (text: string) => void; /** Shows another sidebar of the same session. */ onShow: (id: string) => void; /** Closes the pane; the sidebar is kept. */ onClose: () => void }) {
  const aside = useApp((s) => (asideId ? s.sessionsById.get(asideId) : undefined));
  const parentId = aside?.aside?.sessionId;
  // The parent's sidebars, newest first: the same workspace list every view reads.
  const all = useApp((s) => s.workspace?.sessions ?? NO_SESSIONS);
  const siblings = useMemo(() => (parentId ? all.filter((x) => x.aside?.sessionId === parentId).sort((a, b) => b.createdAt - a.createdAt) : NO_SESSIONS), [all, parentId]);
  const stored = useApp((s) => (asideId ? s.details.get(asideId) : undefined));
  const live = useApp((s) => (asideId ? s.live.get(asideId) : undefined));
  useEffect(() => {
    if (asideId && aside) actions.loadDetail(asideId);
  }, [asideId, aside]);
  useEffect(() => (asideId ? actions.watch(asideId) : undefined), [asideId]);
  const messages = live?.messages ?? stored?.messages ?? NO_MESSAGES;
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [messages]);
  const of = aside?.aside;
  const running = aside?.state === 'running';
  const answer = useMemo(() => lastAnswer(messages), [messages]);
  const send = (text: string, files: AttachmentRefs | null) => (asideId ? actions.reply(asideId, text, {}, files) : Promise.resolve(false));

  return (
    <div className="aside-pane">
      <div className="pane-head">
        <MessagesSquare className="aside-pane-icon" aria-hidden />
        {siblings.length > 1 && asideId ? (
          <select className="aside-pane-pick" aria-label={`Which ${ASIDE_WORD}`} value={asideId} onChange={(e) => onShow(e.target.value)}>
            {siblings.map((x) => (
              <option key={x.id} value={x.id}>
                {x.aside ? asideTitle(x.aside) : x.title}
              </option>
            ))}
          </select>
        ) : (
          <span className="pane-head-name">{of ? asideTitle(of) : ASIDE_NAME}</span>
        )}
        <button type="button" className="copy-button pane-close" aria-label={`Close the ${ASIDE_WORD}`} title={`Close the ${ASIDE_WORD}`} onClick={onClose}>
          <X aria-hidden />
        </button>
      </div>
      {!aside || !of ? (
        <p className="muted aside-pane-gone">This {ASIDE_WORD} is no longer here.</p>
      ) : (
        <>
          <div className="aside-pane-body" ref={body}>
            {messages.length === 0 ? (
              <div className="aside-placeholder">
                <p className="aside-placeholder-ask">{asidePlaceholder(of)}</p>
                {of.summary && <p className="aside-placeholder-finding">{of.summary}</p>}
                <p className="aside-placeholder-note">
                  The conversation carries on without it. This {ASIDE_WORD} knows the conversation up to that point, reads the code, and changes nothing.
                  {of.whole ? ' Its copy runs to where the conversation was when it started, because Kestrel has no record of where that turn ended.' : ''}
                </p>
              </div>
            ) : (
              messages.map((m, i) => <Message key={m.id ?? i} message={m} sessionId={asideId!} onChoice={ignore} onReply={(text) => void send(text, null)} />)
            )}
            {running && (
              <div className="aside-pane-working">
                <ThinkingMark status="Thinking…" />
              </div>
            )}
          </div>
          {answer && !running && (
            <div className="aside-pane-use">
              <button type="button" className="secondary-button small" onClick={() => onUse(asideConclusion(of, answer))}>
                <CornerDownLeft aria-hidden />
                Use in the conversation
              </button>
              <span className="muted">Puts the last answer in the message box. Nothing is sent.</span>
            </div>
          )}
          <div className="aside-pane-composer">
            <Composer
              key={asideId}
              draftKey={`${asideId}`}
              running={running}
              waiting={false}
              interrupted={aside.state === 'interrupted'}
              idlePlaceholder={asidePlaceholder(of)}
              onStop={() => void actions.stop(asideId!)}
              onSend={send}
              controls={<span className="ctl-note">Read only · a copy of the conversation at that point</span>}
            />
          </div>
        </>
      )}
    </div>
  );
}
