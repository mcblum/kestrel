// Details · Session: aligned facts. The agent, model and approval mode (the same values the
// composer's pickers show, handed in from the one place they are worked out), group, tags, cost,
// turns, and when it started and was last active.
import type { SessionUsage } from '@kestrel/server/details';
import { costText } from '@kestrel/server/details';
import type { Group, SessionView } from '@kestrel/server/model';
import { PERMISSION_LEVELS } from '@kestrel/server/permissions';
import type { Sourced } from '@kestrel/server/sourced';
import type { Controls } from '@kestrel/server/tabs';
import { finishedText } from '@kestrel/server/when';
import { activityAt } from '@kestrel/server/session-order';
import { AGENT_LABEL } from '../../labels.ts';
import { labelOfModel, useModels } from '../ComposerControls.tsx';
import { SessionTags } from '../SessionTags.tsx';
import { useInWorkstream, WorkstreamChip } from '../WorkstreamChip.tsx';
import { Facts, Row, Section, SourcedValue } from './Rows.tsx';

const FULL_DATE: Intl.DateTimeFormatOptions = { dateStyle: 'full', timeStyle: 'short' };

/** The server's reason when a session never recorded a cost (details-api.ts NOT_RECORDED): said as two words, not as a failure. */
const notRecorded = (usage: Sourced<SessionUsage>) => usage.state === 'unavailable' && usage.reason.startsWith('Not recorded');

/** "8:57 AM" today, "12 Nov, 8:57 AM" on an earlier day; the full date and time on hover. */
function When({ at }: { at: number }) {
  return (
    <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString(undefined, FULL_DATE)}>
      {finishedText(at, Date.now())}
    </time>
  );
}

interface Props {
  session: SessionView;
  group: Group | undefined;
  /** Model and mode as the composer shows them, a choice not yet sent included. */
  controls: Controls;
  /** The model or mode was changed and applies from the next message. */
  pending: boolean;
  usage: Sourced<SessionUsage>;
}

export function SessionSection({ session, group, controls, pending, usage }: Props) {
  const models = useModels(session.agent);
  const inWorkstream = useInWorkstream(session.id);
  const mode = PERMISSION_LEVELS.find((l) => l.id === controls.permission)?.label ?? controls.permission;
  const next = pending ? <span className="details-quiet"> · from your next message</span> : null;
  return (
    <Section title="Session">
      <Facts>
        <Row label="Provider">{AGENT_LABEL[session.agent]}</Row>
        <Row label="Model">{labelOfModel(models, controls.model)}{next}</Row>
        <Row label="Approval mode">{mode}{next}</Row>
        {group && <Row label="Group">{group.name}</Row>}
        {inWorkstream && (
          <Row label="Workstream">
            <WorkstreamChip sessionId={session.id} />
          </Row>
        )}
        <Row label="Tags">
          <SessionTags sessionId={session.id} tags={session.tags} />
        </Row>
        <Row label="Cost" group>
          {notRecorded(usage) ? <span className="details-quiet">Not recorded</span> : <SourcedValue value={usage}>{(u) => costText(u)}</SourcedValue>}
        </Row>
        {usage.state === 'ready' && <Row label="Turns">{usage.value.turns}</Row>}
        <Row label="Started" group><When at={session.createdAt} /></Row>
        <Row label="Last active"><When at={activityAt(session)} /></Row>
      </Facts>
    </Section>
  );
}
