// The strip of documents inside one session (Conversation, pull request pages, the New PR form),
// above its content. Hidden while Conversation is the only one. Arrow keys, Home and End move along
// it; Delete or the cross closes a document (never Conversation). The state is sessionView.ts; a
// tab's name follows the host (`documentTitle`): "PR #12" or "MR !12".
import { X } from 'lucide-react';
import type { HostTerms } from '@kestrel/server/host-terms';
import { documentTitle } from '@kestrel/server/session-documents';
import { closeSessionDocument, selectSessionDocument, type SessionDocuments } from '../sessionView.ts';

export function SessionDocumentTabs({ sessionId, documents, terms }: { sessionId: string; documents: SessionDocuments; terms: HostTerms }) {
  const focus = (id: string) => (document.getElementById(`${sessionId}-${id}-tab`) ?? document.getElementById(`${sessionId}-${id}-panel`))?.focus();
  const close = (id: string) => {
    const index = documents.tabs.findIndex(t => t.id === id);
    closeSessionDocument(sessionId, id);
    requestAnimationFrame(() => focus(documents.activeId === id ? documents.tabs[Math.max(0, index - 1)]!.id : documents.activeId));
  };
  if (documents.tabs.length === 1 && documents.tabs[0]?.kind === 'conversation') return null;
  return <div className="session-view-tabs" role="tablist" aria-label="Documents in this session">
    {documents.tabs.map((tab, index) => <div className="session-document-tab" key={tab.id}>
      <button id={`${sessionId}-${tab.id}-tab`} role="tab" aria-selected={documents.activeId === tab.id} aria-controls={`${sessionId}-${tab.id}-panel`} tabIndex={documents.activeId === tab.id ? 0 : -1}
        onClick={() => selectSessionDocument(sessionId, tab.id)} onKeyDown={e => {
          if (e.key === 'Delete' && tab.kind !== 'conversation') { e.preventDefault(); close(tab.id); return; }
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
          e.preventDefault();
          const next = e.key === 'Home' ? 0 : e.key === 'End' ? documents.tabs.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + documents.tabs.length) % documents.tabs.length;
          const id = documents.tabs[next]!.id;
          selectSessionDocument(sessionId, id); focus(id);
        }}>{documentTitle(tab, terms)}</button>
      {tab.kind !== 'conversation' && <button className="session-document-close" aria-label={`Close ${documentTitle(tab, terms)}`} onClick={() => close(tab.id)}><X aria-hidden /></button>}
    </div>)}
  </div>;
}
