// The parts of a structured release on What's new (shared/whats-new-layout.ts): the spotlight, the
// rows of Also in this release, and More changes folded in a native disclosure. Every part's text goes
// through the app's one Markdown component, and every picture, the spotlight's drawing included, comes
// from the release's own notes (WhatsNewPictures.tsx). Every link into the app, the spotlight's action
// too, opens beside the notes in a tab of its own (Matt, 2026-11-25: "we still want things to open
// things in new tabs").
import { memo } from 'react';
import { GitMerge, GitPullRequest, Laptop, MessageSquareText, Server, Settings, Sparkles, type LucideIcon } from 'lucide-react';
import type { NotesAction, NotesEntry, NotesLayout, Spotlight } from '@kestrel/server/whats-new-layout';
import { Markdown } from '../components/Markdown.tsx';
import { opener } from '../route.ts';
import { tabActions } from '../tabsStore.ts';
import { notesPicture } from './WhatsNewPictures.tsx';

/** A small icon for an entry, chosen by where its link goes: it helps scanning, it says no state. */
const ICON_BY_PLACE: Readonly<Record<string, LucideIcon>> = {
  '#/settings/agent-setup': Server,
  '#/settings/git': GitMerge,
  '#/pull-requests': GitPullRequest,
  '#/code-reviews': MessageSquareText,
  '#/settings/connections/setup': Laptop,
  '#/settings/general': Settings,
};
const iconOf = (entry: NotesEntry): LucideIcon => (entry.action && ICON_BY_PLACE[entry.action.href]) || Sparkles;

/** An entry's one link, drawn through Markdown so it opens like the notes' other links. */
const ActionLink = ({ action }: { action: NotesAction }) => <Markdown text={`[${action.label}](${action.href})`} linksBeside />;

function SpotlightCard({ spotlight }: { spotlight: Spotlight }) {
  const { action, picture } = spotlight;
  return (
    <section className={picture ? 'whats-new-spotlight with-picture' : 'whats-new-spotlight'} aria-labelledby="whats-new-spotlight-title">
      <div className="whats-new-spotlight-text">
        <p className="whats-new-spotlight-label">{spotlight.label}</p>
        <h2 id="whats-new-spotlight-title">{spotlight.title}</h2>
        <div className="prose">
          <Markdown text={spotlight.body} picture={notesPicture} linksBeside />
        </div>
        {action && (
          <a className="primary-button" href={action.href} {...opener(() => tabActions.openBeside(action.href, true))} onClickCapture={(event) => event.preventDefault()}>
            {action.label}
          </a>
        )}
      </div>
      {picture && <div className="whats-new-spotlight-picture">{notesPicture(picture.src, picture.alt)}</div>}
    </section>
  );
}

const EntryRow = memo(function EntryRow({ entry, icon }: { entry: NotesEntry; icon: boolean }) {
  const Icon = iconOf(entry);
  return (
    <li className="whats-new-entry">
      {icon && <Icon className="whats-new-entry-icon" aria-hidden />}
      <div className="whats-new-entry-text">
        <h3>{entry.title}</h3>
        <div className="prose">
          <Markdown text={entry.body} picture={notesPicture} linksBeside />
        </div>
        {entry.picture && notesPicture(entry.picture.src, entry.picture.alt)}
        {entry.action && (
          <div className="prose whats-new-entry-action">
            <ActionLink action={entry.action} />
          </div>
        )}
      </div>
    </li>
  );
});

export function StructuredNotes({ layout }: { layout: Extract<NotesLayout, { kind: 'structured' }> }) {
  return (
    <div className="whats-new-structured">
      {layout.spotlight && <SpotlightCard spotlight={layout.spotlight} />}
      {layout.also.length > 0 && (
        <section className="whats-new-section" aria-labelledby="whats-new-also">
          <h2 id="whats-new-also">Also in this release</h2>
          <ul className="whats-new-entries two-up">
            {layout.also.map((entry) => (
              <EntryRow key={entry.title} entry={entry} icon />
            ))}
          </ul>
        </section>
      )}
      {layout.more.length > 0 && (
        <details className="whats-new-more">
          <summary>More changes</summary>
          <ul className="whats-new-entries">
            {layout.more.map((entry) => (
              <EntryRow key={entry.title} entry={entry} icon={false} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
