// The pieces every Context pane is made of: one short line each (an icon, the thing, a quiet
// detail, a copy button on hover), headings and rules. Kept compact, the same for a session, a
// project page and a group page.
import type { LucideIcon } from 'lucide-react';
import { homePath } from '../pages/viewTitle.ts';
import { CopyButton } from './CopyButton.tsx';

export function Line({ icon: Icon, text, detail, copy, label }: { icon: LucideIcon; text: string; detail?: string; copy?: string; label?: string }) {
  return (
    <div className="ctx-line">
      <Icon aria-hidden />
      <span className="ctx-text">{text}</span>
      {detail && <span className="ctx-detail">· {detail}</span>}
      {copy && <CopyButton value={copy} label={label ?? 'path'} />}
    </div>
  );
}

/** The folder a path is in, with the home folder as ~. */
export const parentOf = (path: string) => homePath(path.replace(/\/[^/]+\/?$/, '')) || '/';
/** A path's last part. */
export const baseOf = (path: string) => path.replace(/\/$/, '').split('/').pop() ?? path;
