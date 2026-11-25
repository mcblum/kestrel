// Details · Session · Autopilot (docs/designs/pr-autopilot.md): what it is doing for this session's pull
// request, or why it stopped. Information only: it is turned on and off from the controls under the
// message box (AutopilotControl.tsx). Shown once it was ever turned on.
import { autopilotText } from '@kestrel/server/autopilot';
import type { SessionView } from '@kestrel/server/model';
import { Row } from './Rows.tsx';

export function AutopilotRow({ session }: { session: SessionView }) {
  if (!session.autopilot) return null;
  return <Row label="Autopilot" group>{autopilotText(session.autopilot)}</Row>;
}
