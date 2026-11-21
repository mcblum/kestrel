// A folder in the Details pane: one line, the path cut in the middle (its last segment kept), the
// whole path on hover, and Show in Finder (in the Mac app only: a browser cannot) and Copy at the right.
import { homePath } from '../../pages/viewTitle.ts';
import { actions } from '../../store.ts';
import { CopyButton } from '../CopyButton.tsx';
import { MiddleText, PATH_TAIL } from './MiddleText.tsx';
import { Line } from './Rows.tsx';

export function PathLine({ path, copyLabel, label }: { path: string; copyLabel: string; label: string }) {
  const text = <MiddleText text={homePath(path)} full={path} maxTail={PATH_TAIL} mono />;
  return (
    <div className="details-field">
      <div className="details-field-label">{label}</div>
      <Line actions={<CopyButton value={path} label={copyLabel} />}>
        {window.kestrelShell?.reveal ? (
          <button type="button" className="details-link details-path-link" title={`Show ${label.toLowerCase()} in Finder: ${path}`} onClick={() => void actions.reveal(path)}>{text}</button>
        ) : text}
      </Line>
    </div>
  );
}
