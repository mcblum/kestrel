// Details · Repository: the repository's name as the first line, the session's branch beneath it,
// then its git state in short lines (its changes, which open the Changes pane; how it stands
// against its base, the base itself on its own quiet line), separate from the PR tab. A session with
// no project, no folder yet, or a plain folder says so in one line.
import { baseParts, syncState, syncText, type GitStatus } from '@kestrel/server/details';
import type { ChangedFile, Project, ProjectFolder, SessionView } from '@kestrel/server/model';
import { repositoryLabel } from '@kestrel/server/project-folders';
import type { Sourced } from '@kestrel/server/sourced';
import { AddFolderLink } from '../AddFolderLink.tsx';
import { CopyButton } from '../CopyButton.tsx';
import { useRepository } from './sources.ts';
import { ExternalLink } from 'lucide-react';
import { diffCounts } from '@kestrel/server/diff-counts';
import { BRANCH_TAIL, MiddleText } from './MiddleText.tsx';
import { Line, notReadyText, Section } from './Rows.tsx';
import { guestWhere, MAIN_CHECKOUT, type WorkingTreeAnswer } from '@kestrel/server/working-tree';
import { useRequestSide, useWorkingTree } from '../../workingTree.ts';

const filesText = (n: number) => `${n} ${n === 1 ? 'file' : 'files'} changed`;

/**
 * The session's changes: a link to the Changes pane when there are some, plain words when there are
 * none. With `git`, "clean" is said only when git answered: unavailable is shown with its reason,
 * never as a clean tree.
 */
function ChangesLine({ files, clean, git, onOpen }: { files: readonly ChangedFile[]; clean: string; git?: Sourced<GitStatus>; onOpen: () => void }) {
  if (files.length === 0 && git && git.state !== 'ready') {
    const text = notReadyText(git, GIT_STATUS_SAYS);
    return (
      <Line group quiet tip={text}>
        {text}
      </Line>
    );
  }
  if (files.length === 0) return <Line group>{clean}</Line>;
  const { added, removed } = diffCounts(files.map((f) => f.diff));
  return (
    <Line group>
      <button type="button" className="details-link" title="Open the Changes pane" onClick={onOpen}>
        {filesText(files.length)}
      </button>
      <span className="details-counts">
        <span className="ctx-added">+{added}</span> <span className="ctx-removed">−{removed}</span>
      </span>
    </Line>
  );
}

/** What the branch is compared with: "vs main at 1a2b3c4", the branch cut in the middle when long. */
function BaseLine({ label }: { label: string }) {
  const { branch, commit } = baseParts(label);
  return (
    <Line quiet actions={branch ? <CopyButton value={branch} label="base branch name" /> : undefined}>
      <span className="details-base">
        <span className="details-base-word">{branch ? 'vs' : 'vs base'}</span>
        {branch && <MiddleText text={branch} maxTail={BRANCH_TAIL} mono />}
        {commit && <span className="details-mono details-base-commit">{branch ? `at ${commit}` : commit}</span>}
      </span>
    </Line>
  );
}

const SYNC_SAYS = { loading: 'Comparing with its base…', unavailable: 'Ahead/behind unavailable' };
const GIT_STATUS_SAYS = { loading: 'Reading git status…', unavailable: 'Git status unavailable' };

function SyncLines({ git }: { git: Sourced<GitStatus> }) {
  if (git.state !== 'ready') {
    const text = notReadyText(git, SYNC_SAYS);
    return (
      <Line quiet tip={text}>
        {text}
      </Line>
    );
  }
  return (
    <>
      <Line>
        <span className={`details-sync sync-${syncState(git.value)}`}>{syncText(git.value)}</span>
      </Line>
      <BaseLine label={git.value.baseLabel} />
    </>
  );
}

/** The branch it works on; for a guest, whose worktree that is; with none, why (a discarded worktree, say). */
function BranchLines({ where, recorded }: { where: WorkingTreeAnswer; /** The branch recorded for it (`requestSideOf`), kept after its worktree is discarded. */ recorded: string | null }) {
  const branch = where.tree ? where.tree.branch : recorded;
  const host = where.tree ? where.tree.host : where.host;
  if (!branch && !where.tree && where.reason === MAIN_CHECKOUT) return <Line quiet>No branch of its own</Line>;
  return (
    <>
      {branch ? (
        <Line quiet actions={<CopyButton value={branch} label="branch name" />}>
          <MiddleText text={branch} maxTail={BRANCH_TAIL} mono />
        </Line>
      ) : (
        where.tree && <Line quiet>No branch recorded for this worktree</Line>
      )}
      {host && <Line quiet tip={guestWhere(host)}>{guestWhere(host)}</Line>}
      {!where.tree && where.reason !== MAIN_CHECKOUT && <Line quiet tip={where.reason}>{where.reason}</Line>}
    </>
  );
}

interface Props {
  session: SessionView;
  project: Project | undefined;
  /** The project's directory the session works in; null when it has none. */
  folder: ProjectFolder | null;
  files: readonly ChangedFile[];
  git: Sourced<GitStatus>;
  onOpenChanges: () => void;
}

export function RepositorySection({ session, project, folder, files, git, onOpenChanges }: Props) {
  const { value: repository } = useRepository(session.id, project?.id ?? session.id);
  const where = useWorkingTree(session);
  const recorded = useRequestSide(session).branch;
  if (!project) {
    return (
      <Section title="Repository">
        <Line quiet>No repository · a scratch session</Line>
      </Section>
    );
  }
  const name = (
    <Line>
      {repository.state === 'ready' ? (
        <a className="details-link details-repository-link" href={repository.value} target="_blank" rel="noreferrer" title={repository.value}>
          <span className="details-primary">{repositoryLabel(project, folder)}</span><ExternalLink aria-hidden />
        </a>
      ) : <span className="details-primary">{repositoryLabel(project, folder)}</span>}
    </Line>
  );
  if (!folder) {
    return (
      <Section title="Repository">
        {name}
        <Line quiet>
          No folder yet · <AddFolderLink projectId={project.id} />
        </Line>
      </Section>
    );
  }
  if (!folder.isGit) {
    return (
      <Section title="Repository">
        {name}
        <Line quiet>Plain folder · not a git repository</Line>
        <ChangesLine files={files} clean="No changes" onOpen={onOpenChanges} />
      </Section>
    );
  }
  return (
    <Section title="Repository">
      {name}
      {repository.state !== 'ready' && <Line quiet tip={notReadyText(repository)}>{repository.state === 'loading' ? 'Loading repository link…' : 'Repository link unavailable'}</Line>}
      <div className="details-field">
        <div className="details-field-label">Branch</div>
        <BranchLines where={where} recorded={recorded} />
      </div>
      <div className="details-status-group">
        <h4 className="details-field-label">Git status</h4>
      <ChangesLine files={files} clean="Working tree clean" git={git} onOpen={onOpenChanges} />
      {where.tree?.branch && git.state !== 'unavailable' && <SyncLines git={git} />}
      </div>
    </Section>
  );
}
