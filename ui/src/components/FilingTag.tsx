// The small grey tag beside a project name when a session's filing is not simply "its work landed
// here" (labels.ts, filingMark), with what it means on hover. Grey: it is information, not a wait.
import type { FilingMark } from '../labels.ts';

export function FilingTag({ mark }: { mark: FilingMark | null }) {
  if (!mark) return null;
  return (
    <em className="tree-mark" title={mark.hint}>
      {mark.label}
    </em>
  );
}
