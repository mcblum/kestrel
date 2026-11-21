// Details · Location: where the session runs and works. "This computer · Worktree" on one line, then
// the folder it works in (copy, Show in Finder), then the project's main checkout, always visible when the session is in a worktree; and where its work landed when that is
// somewhere else.
import type { Project, ProjectFolder, SessionView } from '@kestrel/server/model';
import { PathLine } from './PathValue.tsx';
import { Line, Section } from './Rows.tsx';

type Checkout = 'Worktree' | 'Main checkout' | 'Plain folder' | 'Scratch folder';

export function checkoutOf(session: SessionView, folder: ProjectFolder | null): Checkout {
  if (!folder) return 'Scratch folder';
  if (!folder.isGit) return 'Plain folder';
  return session.worktreePath ? 'Worktree' : 'Main checkout';
}

interface Props {
  session: SessionView;
  started: Project | undefined;
  /** The directory of `started` it works in; null when there is none. */
  folder: ProjectFolder | null;
  filed: Project | undefined;
}

export function LocationSection({ session, started, folder: source, filed }: Props) {
  const folder = session.worktreePath ?? source?.path ?? null;
  return (
    <Section title="Location">
      <Line>
        This computer
        {session.worktreeDiscarded && <span className="details-quiet"> · discarded</span>}
      </Line>
      {folder && <PathLine path={folder} label={checkoutOf(session, source)} copyLabel="folder path" />}
      {source && session.worktreePath && <PathLine path={source.path} label="Main checkout" copyLabel="main checkout path" />}
      {filed && filed.id !== started?.id && <Line quiet>Work landed in {filed.name}</Line>}
    </Section>
  );
}
