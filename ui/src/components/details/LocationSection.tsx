// Details · Location: where the session runs and works. "This computer · Worktree" on one line, then
// the folder it works in (copy, Show in Finder), then the project's main checkout, always visible when the session is in a worktree; and where its work landed when that is
// somewhere else.
import type { Project, ProjectFolder, SessionView } from '@kestrel/server/model';
import { PathLine } from './PathValue.tsx';
import { Line, Section } from './Rows.tsx';
import { MAIN_CHECKOUT, type WorkingTreeAnswer } from '@kestrel/server/working-tree';
import { useWorkingTree } from '../../workingTree.ts';

type Checkout = 'Worktree' | 'Main checkout' | 'Plain folder' | 'Scratch folder';

export function checkoutOf(where: WorkingTreeAnswer, folder: ProjectFolder | null): Checkout {
  if (!folder) return 'Scratch folder';
  if (!folder.isGit) return 'Plain folder';
  return where.tree ? 'Worktree' : 'Main checkout';
}

interface Props {
  session: SessionView;
  started: Project | undefined;
  /** The directory of `started` it works in; null when there is none. */
  folder: ProjectFolder | null;
  filed: Project | undefined;
}

export function LocationSection({ session, started, folder: source, filed }: Props) {
  // The worktree it works in: its own, or its host's for a guest (@kestrel/server/working-tree).
  const where = useWorkingTree(session);
  const folder = where.tree?.path ?? source?.path ?? null;
  // It has (or works in) a worktree that cannot be opened: say so, and that its panes open here instead.
  const fallback = !where.tree && where.reason !== MAIN_CHECKOUT ? where.reason : null;
  return (
    <Section title="Location">
      <Line>
        This computer
        {session.worktreeDiscarded && <span className="details-quiet"> · discarded</span>}
      </Line>
      {folder && <PathLine path={folder} label={checkoutOf(where, source)} copyLabel="folder path" />}
      {fallback && <Line quiet tip={fallback}>{fallback}. Its terminal and files open in {source ? 'the main checkout' : 'the scratch folder'}.</Line>}
      {source && where.tree && <PathLine path={source.path} label="Main checkout" copyLabel="main checkout path" />}
      {filed && filed.id !== started?.id && <Line quiet>Work landed in {filed.name}</Line>}
    </Section>
  );
}
