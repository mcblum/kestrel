// The pull request pill and page with sample data, at /pr.html: single pills in each status, the
// group pill for several requests on one branch, and the request page. No host is asked.
import { SessionDocumentTabs } from '../components/SessionDocumentTabs.tsx';
import { useSessionDocuments, openPullRequest } from '../sessionView.ts';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { PullRequest } from '@kestrel/server/details';
import { hostTerms } from '@kestrel/server/host-terms';
import { PullRequestSummary, PullRequestView } from '../components/PullRequestView.tsx';
import '../styles/prototype.css';
import '../styles/tokens.css';
import '../styles/app.css';
import './preview.css';
const base: PullRequest = { number: 307, title: 'Keep stream interruptions separate from idle timeouts', state: 'open', checks: 'passing', review: 'review-required', url: 'https://github.com/example/project/pull/307', author: 'example-author', headBranch: 'fix/stream-timeout', baseBranch: 'main', readiness: 'blocked', body: '## What changed\n\nA dropped connection now reports a **stream interruption** instead of being treated as an idle timeout.\n\n- Preserve partial output.\n- Report the original error.\n- Keep the retry path explicit.\n\n## Verification\n\n- [x] Regression coverage for disconnects\n- [x] Existing timeout tests\n\n```typescript\nif (stream.disconnected) {\n  return interrupted(stream.lastEvent);\n}\n```' };
// Several requests on one branch: the group pill, one failing (with a checks link), one ready, one merged.
const group: PullRequest[] = [{ ...base, number: 311, title: 'Follow-up: retry the stream once before reporting it', checks: 'failing', checksUrl: 'https://github.com/example/project/actions/runs/1' }, { ...base, review: 'approved', readiness: 'ready' }, { ...base, number: 296, title: 'Report idle timeouts separately', state: 'merged' }];
const examples: PullRequest[] = [base, { ...base, checks: 'failing' }, { ...base, review: 'approved', readiness: 'ready' }, { ...base, state: 'draft' }, { ...base, state: 'merged' }];
function Preview() {
  const [shown, setShown] = useState<PullRequest>(base);
  const documents = useSessionDocuments('pr-preview');
  const view = documents.activeId === 'conversation' ? 'conversation' : 'pr';
  return <div className="kestrel markdown-studio" style={{colorScheme:'dark'}}>
    <header className="specimen-toolbar"><div className="specimen-brand"><strong>Kestrel</strong><span>Pull request preview · sample data</span></div></header>
    <div style={{maxWidth:950, margin:'32px auto', padding:'0 24px'}}>
      <p style={{color:'var(--s-muted)',marginBottom:16}}>Click a status to open its PR tab. Each number is a separate source-control link.</p>
      <div style={{display:'flex',flexWrap:'wrap',gap:12,marginBottom:24}}>{examples.map((pr,i) => <PullRequestSummary key={i} value={{state:'ready',value:{host:'github',pullRequests:[pr]}}} onOpen={() => {setShown(pr);openPullRequest('pr-preview', pr);}} />)}</div>
      <p style={{color:'var(--s-muted)',marginBottom:16}}>Several requests on one branch: hover or click the group pill.</p>
      <div style={{display:'flex',gap:12,marginBottom:24}}><PullRequestSummary value={{state:'ready',value:{host:'github',pullRequests:group}}} sessionId="pr-preview" onOpen={(pr) => {setShown(pr);openPullRequest('pr-preview', pr);}} /><PullRequestSummary value={{state:'ready',value:{host:'gitlab',pullRequests:group.slice(0, 2)}}} onOpen={(pr) => {setShown(pr);openPullRequest('pr-preview', pr);}} /></div>
      <SessionDocumentTabs sessionId="pr-preview" documents={documents} terms={hostTerms('github')} />
      {view==='pr' ? <PullRequestView source={{value:{state:'ready',value:{host:'github',pullRequests:[shown]}},refresh:()=>{}}} /> : <div className="prose" style={{padding:'32px 0'}}><h2>The conversation stays here</h2><p>Pull request details have their own tab. The compact summary keeps the status visible while you work.</p></div>}
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
