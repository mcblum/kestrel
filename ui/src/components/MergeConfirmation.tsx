import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, Check, GitBranch, GitMerge, LoaderCircle, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import type { PullRequest } from '@kestrel/server/details';
import { call } from '../store.ts';

type Offer = { pr: PullRequest; methods: { id: string; label: string }[] };
export function MergeConfirmation({ sessionId, number, label, onClose, onMerged }: { sessionId: string; number: number; label: string; onClose: () => void; onMerged: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [offer, setOffer] = useState<Offer>();
  const [method, setMethod] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    dialog.current?.showModal();
    setError(''); setOffer(undefined);
    let cancelled = false;
    call<Offer>(`/api/sessions/${encodeURIComponent(sessionId)}/pr-merge-preview`, { method: 'POST', body: JSON.stringify({ number }) })
      .then(result => { if (!cancelled) { setOffer(result); setMethod(result.methods[0]?.id ?? ''); } })
      .catch(e => { if (!cancelled) setError(e.status === 404 && e.message === 'Not found' ? 'Kestrel’s server needs to restart to load merging. Your request has not been changed.' : String(e.message ?? e)); });
    return () => { cancelled = true; };
  }, [sessionId, number, attempt]);
  async function merge() {
    if (!offer || busy) return;
    setBusy(true); setError('');
    try {
      await call(`/api/sessions/${encodeURIComponent(sessionId)}/pr-merge`, { method: 'POST', body: JSON.stringify({ number, sha: offer.pr.headSha, base: offer.pr.baseBranch, method }) });
      onMerged(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); setOffer(undefined); }
  }
  return createPortal(<dialog ref={dialog} className="kestrel pr-merge-dialog" aria-labelledby={titleId} onClick={e => e.stopPropagation()} onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <header className="pr-merge-header">
      <span className="pr-merge-emblem"><GitMerge size={20} aria-hidden /></span>
      <div><span className="pr-merge-eyebrow">{label.startsWith('!') ? 'MERGE REQUEST' : 'PULL REQUEST'}</span><h2 id={titleId}>Merge {label}</h2></div>
      <button type="button" className="pr-merge-close" aria-label="Close confirmation" disabled={busy} onClick={onClose}><X size={18} /></button>
    </header>
    <div className="pr-merge-body">
      {offer ? <>
        <p className="pr-merge-title">{offer.pr.title}</p>
        <div className="pr-merge-branches"><GitBranch size={15} aria-hidden /><code title={offer.pr.headBranch}>{offer.pr.headBranch}</code><ArrowRight size={14} aria-label="into" /><code title={offer.pr.baseBranch}>{offer.pr.baseBranch}</code></div>
        <fieldset className="pr-merge-method"><legend>Merge method</legend>{offer.methods.map(m => <label key={m.id} className={`pr-merge-option${method === m.id ? ' selected' : ''}`}><input type="radio" name={titleId} value={m.id} checked={method === m.id} disabled={busy} onChange={() => setMethod(m.id)} /><span>{m.label}</span>{method === m.id && <Check size={15} aria-hidden />}</label>)}</fieldset>
        <p className="pr-merge-note">Commit <code>{offer.pr.headSha?.slice(0, 8)}</code> · We’ll check readiness again before merging.</p>
      </> : !error && <div className="pr-merge-loading" role="status"><LoaderCircle size={18} aria-hidden /><span>Checking merge readiness…</span></div>}
      {error && <div className="pr-merge-error" role="alert"><strong>Unable to merge yet</strong><p>{error}</p></div>}
    </div>
    <footer className="pr-merge-actions"><button type="button" className="pr-merge-cancel" disabled={busy} onClick={onClose}>Cancel</button>{error ? <button type="button" className="pr-merge-retry" onClick={() => setAttempt(n => n + 1)}>Try again</button> : <button type="button" className="pr-merge-confirm" disabled={!offer || busy || !method} onClick={() => void merge()}>{busy ? <LoaderCircle size={15} aria-hidden /> : <GitMerge size={15} aria-hidden />}{busy ? 'Merging…' : 'Confirm merge'}</button>}</footer>
  </dialog>, document.body);
}
