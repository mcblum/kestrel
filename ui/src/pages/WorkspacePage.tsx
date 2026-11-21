// The content of the workspace tab. The sidebar chooses the destination; this renders it.
import type { View } from '../route.ts';
import { useApp } from '../store.ts';
import { ListPage } from './ListPage.tsx';
import { WorkstreamPage } from './WorkstreamPage.tsx';
import { ReviewRequestPage } from './ReviewRequestPage.tsx';
import { NeedsYouPage } from './NeedsYouPage.tsx';
import { PullRequestsPage } from './PullRequestsPage.tsx';
import { DEFAULT_REQUEST_FILTER } from '@kestrel/server/pull-request-list';
import { OverviewPage } from './OverviewPage.tsx';
import { OnboardingGate } from '../onboarding/OnboardingGate.tsx';
import { MovePage } from './MovePage.tsx';
import { CreateProjectPage } from './CreateProjectPage.tsx';
import { CodePage } from './CodePage.tsx';
import { SettingsPage } from './SettingsPage.tsx';
import { viewTitle } from './viewTitle.ts';

export function WorkspacePage({ view }: { view: View }) {
  const workspace = useApp((s) => s.workspace);
  if (!workspace) return null;
  if (view.kind === 'overview') return <OnboardingGate><OverviewPage workspace={workspace} /></OnboardingGate>;
  if (view.kind === 'attention') return <NeedsYouPage workspace={workspace} />;
  if (view.kind === 'pull-requests') return <PullRequestsPage workspace={workspace} filter={view.filter ?? DEFAULT_REQUEST_FILTER} />;
  if (view.kind === 'settings') return <SettingsPage section={view.section} />;
  if (view.kind === 'move') return <MovePage key={`${view.sessionId}:${view.projectId}:${view.groupId ?? ''}`} sessionId={view.sessionId} projectId={view.projectId} groupId={view.groupId} />;
  if (view.kind === 'new-project') return <CreateProjectPage from={view.from} />;
  if (view.kind === 'code') return <CodePage key={`${view.sessionId}:${view.messageId}:${view.at}`} view={view} />;
  if (view.kind === 'review-request') return <ReviewRequestPage key={view.id} id={view.id} />;
  if (view.kind === 'workstream') return <WorkstreamPage key={view.id} id={view.id} workspace={workspace} />;
  // Filters and sort belong to one destination: another destination starts fresh. A project's local
  // tabs are one destination, so its Sessions list keeps its filters and search across Settings.
  return <ListPage key={`${view.kind}:${'id' in view ? view.id : ''}:${view.kind === 'all' ? view.filter ?? '' : ''}`} view={view} workspace={workspace} />;
}

export { viewTitle };
