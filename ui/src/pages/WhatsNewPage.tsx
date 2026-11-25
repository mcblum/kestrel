// What's new (`#/whats-new`, `#/whats-new/<release>`): a release's notes, rendered with the app's own
// Markdown, and the earlier releases below. The notes are the repository's whats-new/<release>.md,
// shipped inside the app and asked of the server by route (server: whats-new/), so the page works
// offline and in a plain browser. A release written in the page's convention (shared/whats-new-layout.ts)
// gets its spotlight, rows and folded More changes (WhatsNewLayout.tsx); any other is drawn as Markdown.
// Every link into the app opens beside the notes, in a tab of its own (Matt, 2026-11-25: "we still want
// things to open things in new tabs"). Which releases there are, and this copy's own, come from the server's push (`whatsNew`); one release's text is asked for through useResource.
import { ready, type Sourced } from '@kestrel/server/sourced';
import type { WhatsNewNotes } from '@kestrel/server/whats-new';
import { notesLayout } from '@kestrel/server/whats-new-layout';
import { useMemo } from 'react';
import { Markdown } from '../components/Markdown.tsx';
import { useResource } from '../data/resources.ts';
import { opener, openView } from '../route.ts';
import { OLDER_SERVER, RESTART_REASON, useApp } from '../store.ts';
import { PageHeader } from './PageHeader.tsx';
import { StructuredNotes } from './WhatsNewLayout.tsx';
import { notesPicture } from './WhatsNewPictures.tsx';
import '../styles/whats-new.css';

const asNotes = (raw: unknown): Sourced<WhatsNewNotes> => ready(raw as WhatsNewNotes);

function Notes({ release }: { release: string }) {
  const loaded = useResource(`/api/whats-new/notes/${encodeURIComponent(release)}`, asNotes).value;
  const body = loaded.state === 'ready' ? loaded.value.body : null;
  const layout = useMemo(() => (body === null ? null : notesLayout(body)), [body]);
  if (loaded.state === 'loading') return <p className="quiet">Loading…</p>;
  if (loaded.state !== 'ready') return <p className="quiet">{loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>;
  if (layout?.kind === 'structured') return <StructuredNotes layout={layout} />;
  return (
    <div className="prose whats-new-notes">
      <Markdown text={loaded.value.body} picture={notesPicture} linksBeside />
    </div>
  );
}

export function WhatsNewPage({ release: asked }: { release?: string }) {
  const view = useApp((s) => s.whatsNew);
  if (!view) return <div className="page column narrow whats-new-page"><p className="quiet">Loading…</p></div>;
  const own = view.release && view.releases.some((r) => r.release === view.release) ? view.release : (view.releases[0]?.release ?? null);
  const release = asked ?? own;
  const entry = view.releases.find((r) => r.release === release);
  const earlier = view.releases.filter((r) => r.release !== release);
  if (!release || !entry)
    return (
      <div className="page column narrow whats-new-page">
        <PageHeader title="What’s new" />
        <div className="empty">
          <h2>{asked ? `No notes for Kestrel ${asked}` : 'No release notes yet'}</h2>
          <p>{asked ? 'This copy of Kestrel does not have notes for that version.' : `This copy of Kestrel${view.release ? ` (${view.release})` : ''} carries no notes for its version.`}</p>
        </div>
        {earlier.length > 0 && <Earlier releases={earlier} />}
      </div>
    );
  return (
    <div className="page column narrow whats-new-page">
      <PageHeader title="What’s new" line={release === view.release ? entry.title : `${entry.title}, an earlier release`} />
      <Notes release={release} />
      {earlier.length > 0 && <Earlier releases={earlier} />}
    </div>
  );
}

function Earlier({ releases }: { releases: readonly { release: string; title: string }[] }) {
  return (
    <section className="page-section whats-new-earlier">
      <h2>Earlier releases</h2>
      <ul>
        {releases.map((r) => (
          <li key={r.release}>
            <button type="button" className="link-button" {...opener((newTab) => openView({ kind: 'whats-new', release: r.release }, newTab))}>
              {r.title}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
