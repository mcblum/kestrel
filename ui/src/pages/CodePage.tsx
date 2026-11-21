// One code block of a conversation, whole, in a tab of its own (Matt, 2026-11-19): every line, in its
// colours, with nothing around it. The tab holds no code: it points at the block (the message and
// where its fence starts, @kestrel/server/code-ref) and reads it from the session's messages in the
// store, so a block the agent is still writing grows here too, and the tab survives a reload.
import { useEffect, useMemo } from 'react';
import { codeAt } from '@kestrel/server/code-ref';
import { blockLanguage } from '@kestrel/server/code-guess';
import type { View } from '../route.ts';
import { openSession, opener } from '../route.ts';
import { actions, useApp } from '../store.ts';
import { CopyButton } from '../components/CopyButton.tsx';
import { HighlightedCode } from '../highlight/HighlightedCode.tsx';
import '../styles/code-page.css';

type CodeView = Extract<View, { kind: 'code' }>;

const lineCount = (code: string): string => {
  const lines = code.split('\n').length;
  return `${lines.toLocaleString()} line${lines === 1 ? '' : 's'}`;
};

export function CodePage({ view }: { view: CodeView }) {
  const { sessionId, messageId, at } = view;
  useEffect(() => actions.watch(sessionId), [sessionId]);
  const session = useApp((s) => s.sessionsById.get(sessionId));
  const messages = useApp((s) => s.live.get(sessionId)?.messages ?? s.details.get(sessionId)?.messages);
  const text = useMemo(() => messages?.find((m) => m.id === messageId)?.text, [messages, messageId]);
  const found = useMemo(() => (text === undefined ? null : codeAt(text, at)), [text, at]);
  // Nothing is said until the session's messages are here: "gone" must not flash on the way in.
  if (!found && session && messages === undefined) return null;
  if (!found)
    return (
      <div className="page column collection">
        <div className="empty">
          <h2>This code is not in the conversation any more</h2>
          <p>{session ? 'The message it was in was removed or rewritten.' : 'The session it was in was deleted.'}</p>
        </div>
      </div>
    );
  const language = found.lang ?? blockLanguage(null, found.code);
  return (
    <div className="page column code-page">
      <header className="page-head">
        <div className="page-head-top">
          <h1>{language ?? 'Code'}</h1>
          <div className="page-head-actions">
            <CopyButton value={found.code} label="code" />
          </div>
        </div>
        <div className="page-head-line">
          <span>{lineCount(found.code)}</span>
          {session && (
            <>
              <span aria-hidden>·</span>
              <button type="button" className="code-page-from" {...opener((newTab) => openSession(sessionId, newTab))}>
                From {session.title}
              </button>
            </>
          )}
        </div>
      </header>
      <pre className="code-page-body">
        <HighlightedCode lang={found.lang} code={found.code} />
      </pre>
    </div>
  );
}
