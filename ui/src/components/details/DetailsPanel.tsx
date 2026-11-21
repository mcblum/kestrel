// A session's Details pane (the `context` pane): Repository, Location,
// Session, and Related sessions (the handoff and delegation trail) when there is one. The sections are always there, in this order;
// each value from a source says when it is loading or unavailable. The layout rule is in Rows.tsx.
import type { GitStatus } from '@kestrel/server/details';
import type { SessionDetail } from '@kestrel/server/model';
import type { Sourced } from '@kestrel/server/sourced';
import type { Controls } from '@kestrel/server/tabs';
import { useApp } from '../../store.ts';
import { sessionFolder } from '../../sessionFolder.ts';
import { Trail } from '../SessionPane.tsx';
import { LocationSection } from './LocationSection.tsx';
import { RepositorySection } from './RepositorySection.tsx';
import { Section } from './Rows.tsx';
import { SessionSection } from './SessionSection.tsx';
import { useUsage } from './sources.ts';
import { needsRestart } from './useSourced.ts';

export const RESTART_NOTICE = 'Restart Kestrel to load Git status and usage.';

interface Props {
  detail: SessionDetail;
  controls: Controls;
  pending: boolean;
  /** The git source, shared with the top line's summary. */
  git: Sourced<GitStatus>;
  /** Changes when the session does: the sources are asked again. */
  refreshKey: string;
  onOpenChanges: () => void;
}

export function DetailsPanel({ detail, controls, pending, git, refreshKey, onOpenChanges }: Props) {
  const projects = useApp((s) => s.workspace?.projects) ?? [];
  const groups = useApp((s) => s.workspace?.groups) ?? [];
  const { session } = detail;
  const started = projects.find((p) => p.id === session.startedIn);
  const filed = projects.find((p) => p.id === session.filing.projectId);
  const folder = sessionFolder(session, started);
  const usage = useUsage(session.id, refreshKey);
  // Detected once for the pane: a server older than these routes. Each line then says only "unavailable".
  const restart = [git, usage.value].some(needsRestart);
  return (
    <div className="context-content details-content">
      {restart && (
        <p className="details-notice" role="status">
          {RESTART_NOTICE}
        </p>
      )}
      <RepositorySection session={session} project={started} folder={folder} files={detail.files} git={git} onOpenChanges={onOpenChanges} />
      <LocationSection session={session} started={started} folder={folder} filed={filed} />
      <SessionSection session={session} group={groups.find((g) => g.id === session.groupId)} controls={controls} pending={pending} usage={usage.value} />
      {detail.trail.length > 1 && (
        <Section title="Related sessions">
          <Trail trail={detail.trail} />
        </Section>
      )}
    </div>
  );
}
