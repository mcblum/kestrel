// The control that starts a sidebar (shared/asides.ts) from a point of the conversation, or opens the
// one there is with the same key. Every caller draws this one control: a message's foot gives the
// point alone; a finding gives its key and its subject. It shows only on the session page, where the
// pane column can hold the sidebar.
import { useState } from 'react';
import { MessagesSquare } from 'lucide-react';
import { OPEN_ASIDE, sameAside, START_ASIDE_HERE, type AsideSubject } from '@kestrel/server/asides';
import { openAside, pointKey, useAsideHost } from '../asides.ts';
import { useApp } from '../store.ts';

interface Props {
  sessionId: string;
  /** The message or card it starts from. */
  at: string;
  /** Which sidebar it is (`key` is React's own name). Default: one per point. */
  asideKey?: string;
  subject?: AsideSubject;
  /** The words of a control drawn as a link; absent: an icon button beside Copy and Fork. */
  label?: string;
}

export function AsideStart({ sessionId, at, asideKey, subject, label }: Props) {
  const host = useAsideHost();
  const which = asideKey ?? pointKey(at);
  const existing = useApp((s) => s.workspace?.sessions.find((x) => x.aside && sameAside(x.aside, { sessionId, key: which }))?.id ?? null);
  const [opening, setOpening] = useState(false);
  if (!host || host.sessionId !== sessionId) return null;
  const shown = existing !== null && host.openId === existing;
  const start = async () => {
    if (existing) return host.show(existing);
    setOpening(true);
    const made = await openAside(sessionId, { at, ...(asideKey ? { key: asideKey } : {}), ...(subject ? { subject } : {}) });
    setOpening(false);
    if (made) host.show(made.id);
  };
  const words = opening ? 'Starting…' : existing ? OPEN_ASIDE : (label ?? START_ASIDE_HERE);
  if (label === undefined)
    return (
      <button type="button" className="copy-button" aria-label={words} title={words} disabled={opening || shown} aria-pressed={shown} onClick={() => void start()}>
        <MessagesSquare aria-hidden />
      </button>
    );
  return (
    <button type="button" className="link-button finding-aside" disabled={opening || shown} aria-pressed={shown} onClick={() => void start()}>
      <MessagesSquare aria-hidden />
      {words}
    </button>
  );
}
