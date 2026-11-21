// A session's top lines, always two. One: its title (and a warning when Kestrel's tools are
// missing), the pane icons on the right. Two, quieter: its group, its project, and a short git
// summary that opens the Details pane. Tags are edited in Details; activity state is the tab's dot.
// Beside the pane icons: the branch's pull request chip, and "Create PR" when it has no open one;
// its menu also removes the worktree ("Worktree" offers that alone otherwise).
import { WorkstreamChip } from './WorkstreamChip.tsx';
import { Folder, TriangleAlert } from 'lucide-react';
import { fitsGroup } from '@kestrel/server/project-groups';
import { lookupHost, type GitStatus, type PullRequest } from '@kestrel/server/details';
import type { SessionDetail, SessionView } from '@kestrel/server/model';
import type { Sourced } from '@kestrel/server/sourced';
import type { Panes } from '../paneState.ts';
import { filingMark, projectName, UNSCOPED } from '../labels.ts';
import { FilingTag } from '../components/FilingTag.tsx';
import { actions, useApp } from '../store.ts';
import { GitSummary } from './details/GitSummary.tsx';
import { offersCreatePullRequest } from '@kestrel/server/session-documents';
import { hostTerms } from '@kestrel/server/host-terms';
import { changedFilesText, uncommittedCount } from '@kestrel/server/commit-request';
import { PullRequestSummary, type PullRequestSource } from './PullRequestView.tsx';
import { CreatePullRequestButton } from './CreatePullRequestButton.tsx';
import { useWorktreeMenu } from './WorktreeConfirmations.tsx';
import { PaneToolbar } from './PaneToolbar.tsx';

function GroupSelect({ session }: { session: SessionView }) {
  const all = useApp((s) => s.workspace?.groups) ?? [];
  // Only groups it may join: a project's group takes only that project's sessions.
  const groups = all.filter((g) => g.id === session.groupId || fitsGroup(g, session));
  return (
    <>
      <span className="bar-item">
        <Folder aria-hidden />
        <select className="work-folder" aria-label="Group" value={session.groupId ?? ''} onChange={(e) => void actions.moveSession(session.id, e.target.value || null)}>
          <option value="">No group</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </span>
      <span className="bar-sep">/</span>
    </>
  );
}

function ToolsMissing({ detail }: { detail: SessionDetail | undefined }) {
  if (detail?.kestrelTools !== 'missing') return null;
  return (
    <span className="bar-item tools-missing">
      <TriangleAlert aria-hidden />
      Kestrel tools missing{detail.kestrelMissing && detail.kestrelMissing.length > 0 ? `: ${detail.kestrelMissing.join(', ')}` : ''}
    </span>
  );
}

interface Props {
  session: SessionView;
  detail: SessionDetail | undefined;
  panes: Panes;
  browserTitle: string | null | undefined;
  git: Sourced<GitStatus>;
  pullRequests: PullRequestSource;
  onOpenPullRequest: (pr: PullRequest) => void;
}

function Where({ session }: { session: SessionView }) {
  const projects = useApp((s) => s.workspace?.projects) ?? [];
  const mark = filingMark(session.filing.status, session.filing.discarded);
  const name = projectName(session, projects);
  if (name === UNSCOPED) return <span className="bar-item bar-project bar-none">No project</span>;
  return (
    <span className="bar-item bar-project">
      {name}
      <FilingTag mark={mark} />
    </span>
  );
}

export function SessionBar({ session, detail, panes, browserTitle, git, pullRequests, onOpenPullRequest }: Props) {
  const files = detail?.files ?? [];
  const runningCommands = useApp((s) => s.live.get(session.id)?.commands.filter((c) => c.status === 'running').length ?? 0);
  const worktree = useWorktreeMenu(session);
  const offersCreate = !session.worktreeDiscarded && offersCreatePullRequest(true, pullRequests.value, git);
  return (
    <header className="session-bar session-head">
      {/* Line one: the title, and the pane icons. */}
      <div className="bar-line bar-line-title">
        <span className="bar-title" title={session.title}>
          {session.title}
        </span>
        <ToolsMissing detail={detail} />
        {session.branch && (
          <span className="bar-pr">
            <PullRequestSummary sessionId={session.id} onRefresh={pullRequests.refresh} value={pullRequests.value} onOpen={onOpenPullRequest} />
            {offersCreate && <CreatePullRequestButton sessionId={session.id} terms={hostTerms(lookupHost(pullRequests.value))} git={git} worktree={worktree} />}
          </span>
        )}
        <PaneToolbar
          open={panes.state.open}
          onToggle={panes.toggle}
          extras={{
            counts: { changes: files.length, commands: runningCommands },
            countLabels: { commands: `${runningCommands} running` },
            attention: { changes: uncommittedCount(git) > 0 },
            titles: { changes: changedFilesText(files.length, uncommittedCount(git)) ?? 'Changes', browser: browserTitle ? `Browser · ${browserTitle}` : 'Browser', context: 'Details', commands: runningCommands > 0 ? `Commands · ${runningCommands} running` : 'Commands' },
            labels: { context: 'Session details' },
          }}
        />
      </div>
      {/* Line two, quieter: where it works, the workstream it is part of, and its git state. Tags are in Details. */}
      <div className="bar-line bar-line-where">
        {session.groupId && <GroupSelect session={session} />}
        <Where session={session} />
        <WorkstreamChip sessionId={session.id} />
        {session.branch && <GitSummary branch={session.branch} files={files} git={git} onOpen={() => panes.show('context')} />}
      </div>
    </header>
  );
}
