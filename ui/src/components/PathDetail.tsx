// A path under a name in a picker, cut in the middle when it is too long: the start gives way, the
// last part and the note after it ("· default", "· plain folder") always show.
import { tildePath } from '@kestrel/server/project-search';

export function PathDetail({ path, note = '' }: { path: string; note?: string }) {
  const shown = tildePath(path);
  const cut = shown.lastIndexOf('/');
  const head = cut > 0 ? shown.slice(0, cut) : '';
  const tail = cut > 0 ? shown.slice(cut) : shown;
  return (
    <small className="path-detail" title={path}>
      {head && <span className="path-head">{head}</span>}
      <span className="path-tail">{tail}</span>
      {note && <span className="path-note">{note}</span>}
    </small>
  );
}
